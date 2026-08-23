import { NextResponse } from "next/server";
import { CACHE_OWNER_COOKIE, userResponseSchema } from "@/domain/api-contracts";
import {
  authenticateUser,
  createSession,
  SESSION_COOKIE,
} from "@/server/auth/repository";
import {
  authenticationRateLimitResponse,
  consumeAuthenticationIdentityAttempt,
  consumeAuthenticationIpAttempt,
} from "@/server/auth/rate-limit";
import { database } from "@/server/database";
import {
  crossSiteWriteResponse,
  errorResponse,
  parseJsonRequest,
  PRIVATE_API_CACHE_CONTROL,
} from "@/server/http";
import { credentialsSchema } from "@/server/request-contracts";

export async function POST(request: Request): Promise<Response> {
  const crossSite = crossSiteWriteResponse(request);
  if (crossSite) return crossSite;
  try {
    const ipRateLimit = await consumeAuthenticationIpAttempt(
      database(),
      request,
      "login",
    );
    if (!ipRateLimit.allowed)
      return authenticationRateLimitResponse(ipRateLimit);
  } catch {
    return errorResponse(500, "Sign in could not be completed.");
  }
  const parsed = await parseJsonRequest(request, credentialsSchema);
  if (!parsed.success) return parsed.response;
  try {
    const identityRateLimit = await consumeAuthenticationIdentityAttempt(
      database(),
      "login",
      parsed.data.email,
    );
    if (!identityRateLimit.allowed)
      return authenticationRateLimitResponse(identityRateLimit);
    const user = await authenticateUser(
      database(),
      parsed.data.email,
      parsed.data.password,
    );
    if (!user) return errorResponse(401, "Email or password is incorrect.");
    const session = await createSession(database(), user);
    const body = userResponseSchema.safeParse({
      user: { ...user, sessionId: session.id },
    });
    if (!body.success)
      return errorResponse(500, "The server produced an invalid response.");
    const response = NextResponse.json(body.data, {
      headers: { "Cache-Control": PRIVATE_API_CACHE_CONTROL },
    });
    response.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: "/",
      expires: session.expiresAt,
    });
    response.cookies.set(CACHE_OWNER_COOKIE, session.id, {
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: "/",
      expires: session.expiresAt,
    });
    return response;
  } catch {
    return errorResponse(500, "Sign in could not be completed.");
  }
}
