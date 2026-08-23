import type { ZodType } from "zod";

export const PRIVATE_API_CACHE_CONTROL = "private, no-store";

function privateResponseInit(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", PRIVATE_API_CACHE_CONTROL);
  return { ...init, headers };
}

export function errorResponse(
  status: number,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    { error: message, ...(details ? { details } : {}) },
    privateResponseInit({ status }),
  );
}

/**
 * Rejects a write a browser made on another site's behalf.
 *
 * Authenticated routes are already safe: they require a custom header, which
 * forces a preflight no cross-origin form can satisfy. Sign-in and sign-up take
 * no such header, and `SameSite=Lax` governs whether a cookie is *sent*, not
 * whether one may be *set* — so a plain cross-site form post can silently sign
 * a visitor into an account the attacker controls, and everything they type
 * afterwards is written where the attacker can read it.
 */
export function crossSiteWriteResponse(request: Request): Response | undefined {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    return errorResponse(403, "This request did not come from House by 30.");
  // The `Origin` header is deliberately not compared against this request's
  // own URL: behind a proxy that URL is the internal one, so the comparison
  // rejects legitimate sign-ins rather than attacks.
  //
  // Requiring JSON is what closes the hole for browsers too old to send
  // `Sec-Fetch-Site`, because a cross-origin request that avoids a preflight
  // can only carry a form content type — and `application/json` is not one.
  //
  // This allowlists rather than denylisting: media types are case-insensitive
  // and the header is optional, so naming the three form types missed both
  // `TEXT/PLAIN` and a body sent with no content type at all, each of which is
  // a CORS-safelisted cross-origin post.
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json")
    return errorResponse(415, "Send this request as application/json.");
  return undefined;
}

export async function parseJsonRequest<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<
  { success: true; data: T } | { success: false; response: Response }
> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return {
      success: false,
      response: errorResponse(400, "The request body is not valid JSON."),
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      response: errorResponse(
        400,
        "Check the highlighted information and try again.",
        parsed.error.flatten(),
      ),
    };
  }
  return { success: true, data: parsed.data };
}

export function validatedJsonResponse<T>(
  schema: ZodType<T>,
  value: unknown,
  init?: ResponseInit,
): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    return errorResponse(500, "The server produced an invalid response.");
  return Response.json(parsed.data, privateResponseInit(init));
}
