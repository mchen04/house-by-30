import { CACHE_OWNER_COOKIE, type User } from "@/domain/api-contracts";

const OWNER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type CacheOwnerStatus = "match" | "missing" | "mismatch";

export function browserCacheOwner(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${CACHE_OWNER_COOKIE}=`;
  const part = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(prefix));
  if (!part) return null;
  try {
    return decodeURIComponent(part.slice(prefix.length)) || null;
  } catch {
    return null;
  }
}

export function cacheOwnerStatus(user: User): CacheOwnerStatus {
  const owner = browserCacheOwner();
  if (!owner) return "missing";
  return user.sessionId === owner ? "match" : "mismatch";
}

export function rememberBrowserCacheOwner(user: User): void {
  if (typeof document === "undefined" || !user.sessionId) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CACHE_OWNER_COOKIE}=${encodeURIComponent(user.sessionId)}; Max-Age=${OWNER_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

export function forgetBrowserCacheOwner(expectedSessionId: string): boolean {
  if (browserCacheOwner() !== expectedSessionId) return false;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CACHE_OWNER_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  return true;
}
