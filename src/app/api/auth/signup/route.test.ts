import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticationRateLimitResponse,
  consumeAuthenticationIdentityAttempt,
  consumeAuthenticationIpAttempt,
  registerPublicUser,
} = vi.hoisted(() => ({
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
  registerPublicUser: vi.fn(),
}));

vi.mock("@/server/auth/repository", () => ({
  registerPublicUser,
}));
vi.mock("@/server/auth/rate-limit", () => ({
  authenticationRateLimitResponse,
  consumeAuthenticationIdentityAttempt,
  consumeAuthenticationIpAttempt,
}));
vi.mock("@/server/database", () => ({ database: () => ({}) }));

import { POST } from "./route";

function signupRequest(password = "correct horse battery staple"): Request {
  return new Request("https://example.test/api/auth/signup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": "203.0.113.21",
    },
    body: JSON.stringify({
      email: "New@Example.com",
      password,
    }),
  });
}

describe("signup throttling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeAuthenticationIpAttempt.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 3600,
    });
    consumeAuthenticationIdentityAttempt.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 3600,
    });
  });

  it("returns 429 before password hashing or account creation", async () => {
    consumeAuthenticationIpAttempt.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 611,
    });

    const response = await POST(signupRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("611");
    expect(consumeAuthenticationIpAttempt).toHaveBeenCalledWith(
      {},
      expect.any(Request),
      "signup",
    );
    expect(consumeAuthenticationIdentityAttempt).not.toHaveBeenCalled();
    expect(registerPublicUser).not.toHaveBeenCalled();
  });

  it("counts schema-invalid bodies against the IP bucket before validation", async () => {
    consumeAuthenticationIpAttempt
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 3600 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 51 });
    const invalidRequest = () =>
      new Request("https://example.test/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", password: "short" }),
      });

    expect((await POST(invalidRequest())).status).toBe(400);
    const limited = await POST(invalidRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("51");
    expect(consumeAuthenticationIpAttempt).toHaveBeenCalledTimes(2);
    expect(consumeAuthenticationIdentityAttempt).not.toHaveBeenCalled();
    expect(registerPublicUser).not.toHaveBeenCalled();
  });

  it("returns a generic accepted result after allowed account creation", async () => {
    const response = await POST(signupRequest());

    expect(response.status).toBe(202);
    expect(consumeAuthenticationIdentityAttempt).toHaveBeenCalledWith(
      {},
      "signup",
      "new@example.com",
    );
    expect(registerPublicUser).toHaveBeenCalledWith(
      {},
      "new@example.com",
      "correct horse battery staple",
    );
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each(
    ["x", " ", "short", "x".repeat(200), "x".repeat(201), "x".repeat(513)].map(
      (password) => ({ password, length: password.length }),
    ),
  )(
    "accepts an entered password of length $length without changing it",
    async ({ password }) => {
      const response = await POST(signupRequest(password));

      expect(response.status).toBe(202);
      expect(registerPublicUser).toHaveBeenCalledWith(
        {},
        "new@example.com",
        password,
      );
    },
  );

  it.each(["", null, 42, undefined])(
    "rejects an absent or invalid password: %s",
    async (password) => {
      const request = signupRequest();
      const response = await POST(
        new Request(request, {
          body: JSON.stringify({ email: "new@example.com", password }),
        }),
      );

      expect(response.status).toBe(400);
      expect(registerPublicUser).not.toHaveBeenCalled();
      expect(consumeAuthenticationIdentityAttempt).not.toHaveBeenCalled();
    },
  );

  it("returns the same generic result when registration declines the identity", async () => {
    registerPublicUser.mockResolvedValue(undefined);

    const response = await POST(signupRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not hide an unexpected persistence failure", async () => {
    registerPublicUser.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(signupRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "The account could not be created.",
    });
  });
});
