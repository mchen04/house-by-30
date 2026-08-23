/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { User } from "@/domain/api-contracts";
import {
  browserCacheOwner,
  cacheOwnerStatus,
  forgetBrowserCacheOwner,
  rememberBrowserCacheOwner,
} from "./cache-owner";

const user: User = {
  id: "user-a",
  email: "a@example.com",
  sessionId: "00000000-0000-4000-8000-000000000001",
};

afterEach(() => {
  document.cookie = "kyle_cache_owner=; Max-Age=0; Path=/";
});

describe("private cache ownership hint", () => {
  it("matches only the session that wrote the browser hint", () => {
    rememberBrowserCacheOwner(user);

    expect(browserCacheOwner()).toBe(user.sessionId);
    expect(cacheOwnerStatus(user)).toBe("match");
    expect(
      cacheOwnerStatus({
        ...user,
        sessionId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toBe("mismatch");
  });

  it("treats a legacy browser with no hint as migratable, not matched", () => {
    expect(browserCacheOwner()).toBeNull();
    expect(cacheOwnerStatus(user)).toBe("missing");
  });

  it("clears only the session that still owns the hint", () => {
    rememberBrowserCacheOwner(user);

    expect(forgetBrowserCacheOwner("newer-session")).toBe(false);
    expect(browserCacheOwner()).toBe(user.sessionId);
    expect(forgetBrowserCacheOwner(user.sessionId!)).toBe(true);
    expect(browserCacheOwner()).toBeNull();
  });
});
