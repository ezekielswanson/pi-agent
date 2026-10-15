import { PolicyError } from "../policy/errors.ts";

export function assertSameOrigin(request: Request, issuer: string): void {
  const expected = new URL(issuer).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") throw new PolicyError("Cross-site request rejected.", "auth");
  if (origin && origin !== expected) throw new PolicyError("Origin rejected.", "auth");
  if (expected.startsWith("https://") && origin !== expected) throw new PolicyError("Origin is required.", "auth");
}
