import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorResponse, validatedJsonResponse } from "./http";

describe("private API responses", () => {
  it("marks errors as private and not reusable", () => {
    const response = errorResponse(401, "Expired");

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("preserves response options and rejects a public cache override", () => {
    const response = validatedJsonResponse(
      z.object({ ok: z.literal(true) }),
      { ok: true },
      {
        status: 202,
        headers: {
          "Cache-Control": "public, max-age=3600",
          "X-Test": "kept",
        },
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("X-Test")).toBe("kept");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
