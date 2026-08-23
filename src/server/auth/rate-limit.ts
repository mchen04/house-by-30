import "server-only";

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { errorResponse } from "@/server/http";

export type AuthenticationAction = "login" | "signup";

interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

interface AuthenticationPolicy {
  identity: RateLimitPolicy;
  ip: RateLimitPolicy;
}

const AUTHENTICATION_POLICIES: Record<
  AuthenticationAction,
  AuthenticationPolicy
> = {
  login: {
    ip: { limit: 30, windowSeconds: 15 * 60 },
    identity: { limit: 10, windowSeconds: 15 * 60 },
  },
  signup: {
    ip: { limit: 10, windowSeconds: 60 * 60 },
    identity: { limit: 10, windowSeconds: 60 * 60 },
  },
};

export const AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE = 100;
const AUTH_RATE_LIMIT_RETENTION_SECONDS = 65 * 60;

interface ConsumedBucket {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthenticationRateLimit {
  allowed: boolean;
  retryAfterSeconds: number;
}

async function cleanupExpiredBuckets(sql: Sql, now: Date): Promise<void> {
  const cutoff = new Date(
    now.getTime() - AUTH_RATE_LIMIT_RETENTION_SECONDS * 1_000,
  );
  await sql`
    WITH expired AS (
      SELECT ctid
      FROM auth_rate_limits
      WHERE window_started_at < ${cutoff}
      ORDER BY window_started_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE}
    )
    DELETE FROM auth_rate_limits AS bucket
    WHERE bucket.ctid IN (SELECT ctid FROM expired)
  `;
}

function hashRateLimitKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function consumeBucket(
  sql: Sql,
  scope: string,
  value: string,
  policy: RateLimitPolicy,
  now: Date,
): Promise<ConsumedBucket> {
  const rows = await sql<{ attemptCount: number; windowStartedAt: Date }[]>`
    INSERT INTO auth_rate_limits (
      scope,
      key_hash,
      window_started_at,
      attempt_count
    )
    VALUES (${scope}, ${hashRateLimitKey(value)}, ${now}, 1)
    ON CONFLICT (scope, key_hash) DO UPDATE SET
      window_started_at = CASE
        WHEN auth_rate_limits.window_started_at
          + make_interval(secs => ${policy.windowSeconds}) <= ${now}
        THEN ${now}
        ELSE auth_rate_limits.window_started_at
      END,
      attempt_count = CASE
        WHEN auth_rate_limits.window_started_at
          + make_interval(secs => ${policy.windowSeconds}) <= ${now}
        THEN 1
        ELSE LEAST(auth_rate_limits.attempt_count + 1, ${policy.limit + 1})
      END
    RETURNING
      attempt_count AS "attemptCount",
      window_started_at AS "windowStartedAt"
  `;
  const bucket = rows[0];
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(
      (bucket.windowStartedAt.getTime() +
        policy.windowSeconds * 1_000 -
        now.getTime()) /
        1_000,
    ),
  );
  return {
    allowed: bucket.attemptCount <= policy.limit,
    retryAfterSeconds,
  };
}

/**
 * The address the outermost trusted proxy actually observed.
 *
 * `x-forwarded-for` and `x-real-ip` are both writable by the caller, so reading
 * either from the left lets anyone mint a fresh bucket per request and walk
 * straight through the limit. Each proxy appends the peer it saw, so counting
 * back from the right by the number of proxies in front of this app yields the
 * first value the caller could not choose.
 *
 * Undefined when no such value exists. Pooling those callers into one shared
 * bucket looks like failing closed, but it hands any one of them the ability to
 * spend that bucket and lock everyone else out of signing in.
 */
export function clientAddress(request: Request): string | undefined {
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10);
  if (!Number.isInteger(hops) || hops < 1) return undefined;
  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return forwarded.at(-hops);
}

export async function consumeAuthenticationIpAttempt(
  sql: Sql,
  request: Request,
  action: AuthenticationAction,
  now = new Date(),
): Promise<AuthenticationRateLimit> {
  await cleanupExpiredBuckets(sql, now);
  const policy = AUTHENTICATION_POLICIES[action];
  const address = clientAddress(request);
  // With no trustworthy address, every caller would otherwise share one bucket,
  // and a single client could spend it and lock *everyone* out of signing in.
  // Skip the address dimension instead; the per-identity limit still bounds an
  // attack on any one account, and it cannot be turned against other people.
  if (address === undefined) return { allowed: true, retryAfterSeconds: 0 };
  return consumeBucket(sql, `${action}:ip`, address, policy.ip, now);
}

export function consumeAuthenticationIdentityAttempt(
  sql: Sql,
  action: AuthenticationAction,
  normalizedEmail: string,
  now = new Date(),
): Promise<AuthenticationRateLimit> {
  return consumeBucket(
    sql,
    `${action}:identity`,
    normalizedEmail,
    AUTHENTICATION_POLICIES[action].identity,
    now,
  );
}

export function authenticationRateLimitResponse(
  limit: AuthenticationRateLimit,
): Response {
  const response = errorResponse(
    429,
    "Too many attempts. Wait before trying again.",
  );
  response.headers.set("Retry-After", String(limit.retryAfterSeconds));
  return response;
}
