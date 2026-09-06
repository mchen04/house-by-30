import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateUser,
  authenticationRateLimitResponse,
  consumeAuthenticationIdentityAttempt,
  consumeAuthenticationIpAttempt,
  createSession,
} = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  authenticationRateLimitResponse: vi.fn(
    ({ retryAfterSeconds }: { retryAfterSeconds: number }) =>
      Response.json(
        { error: "Too many attempts. Wait before trying again." },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      ),
  ),
  consumeAuthenticationIdentityAttempt: vi.fn(),
  consumeAuthenticationIpAttempt: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/server/auth/repository", () => ({
  authenticateUser,
  createSession,
  SESSION_COOKIE: "kyle_session",
}));
vi.mock("@/server/auth/rate-limit", () => ({
  authenticationRateLimitResponse,
  consumeAuthenticationIdentityAttempt,
  consumeAuthenticationIpAttempt,
}));
vi.mock("@/server/database", () => ({ database: () => ({}) }));

import { POST } from "./route";

function loginRequest(password = "correct horse battery staple"): Request {
  return new Request("https://example.test/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": "203.0.113.20",
    },
    body: JSON.stringify({
      email: "Person@Example.com",
      password,
    }),
  });
}

describe("login throttling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeAuthenticationIpAttempt.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 900,
    });
    consumeAuthenticationIdentityAttempt.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 900,
    });
  });

  it("returns 429 before password hashing when the durable limit is reached", async () => {
    consumeAuthenticationIpAttempt.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 73,
    });

    const response = await POST(loginRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("73");
    expect(consumeAuthenticationIpAttempt).toHaveBeenCalledWith(
      {},
      expect.any(Request),
      "login",
    );
    expect(consumeAuthenticationIdentityAttempt).not.toHaveBeenCalled();
    expect(authenticateUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("counts malformed bodies against the IP bucket before parsing", async () => {
    consumeAuthenticationIpAttempt
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 900 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });
    const malformedRequest = () =>
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });

    expect((await POST(malformedRequest())).status).toBe(400);
    const limited = await POST(malformedRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("42");
    expect(consumeAuthenticationIpAttempt).toHaveBeenCalledTimes(2);
    expect(consumeAuthenticationIdentityAttempt).not.toHaveBeenCalled();
  });

  it("returns the server session identity after an allowed login", async () => {
    authenticateUser.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000010",
      email: "person@example.com",
    });
    createSession.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000011",
      token: "opaque-token",
      expiresAt: new Date("2026-08-12T18:00:00.000Z"),
    });

    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    expect(consumeAuthenticationIdentityAttempt).toHaveBeenCalledWith(
      {},
      "login",
      "person@example.com",
    );
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "00000000-0000-4000-8000-000000000010",
        email: "person@example.com",
        sessionId: "00000000-0000-4000-8000-000000000011",
      },
    });
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toContain("kyle_session=opaque-token");
    expect(cookies).toContain(
      "kyle_cache_owner=00000000-0000-4000-8000-000000000011",
    );
    expect(
      response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("kyle_cache_owner=")),
    ).not.toContain("HttpOnly");
  });

  it.each(
    ["x", " ", "short", "x".repeat(200), "x".repeat(201), "x".repeat(513)].map(
      (password) => ({ password, length: password.length }),
    ),
  )(
    "checks an entered password of length $length without changing it",
    async ({ password }) => {
      authenticateUser.mockResolvedValue(null);

      const response = await POST(loginRequest(password));

      expect(response.status).toBe(401);
      expect(authenticateUser).toHaveBeenCalledWith(
        {},
        "person@example.com",
        password,
      );
    },
  );

  it.each(["", null, 42, undefined])(
    "rejects an absent or invalid password: %s",
    async (password) => {
      const request = loginRequest();
      const response = await POST(
        new Request(request, {
          body: JSON.stringify({ email: "person@example.com", password }),
        }),
      );

      expect(response.status).toBe(400);
      expect(authenticateUser).not.toHaveBeenCalled();
      expect(consumeAuthenticationIdentityAttempt).not.toHaveBeenCalled();
    },
  );
});
