import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/server.ts";

test("metadata is public and the MCP endpoint challenges anonymous calls", async () => {
  const app = await createApp({
    issuer: "http://127.0.0.1:8787",
    resource: "http://127.0.0.1:8787/mcp",
    authSecret: "auth-secret",
    approvalSecret: "approval-secret",
    portalId: "5627913",
    allowedUsers: ["ada"],
    clients: [{ clientId: "pi", redirectUris: ["http://127.0.0.1:8788/callback"], publicClient: true }],
    tokenKey: randomBytes(32).toString("base64"),
    hubspot: { clientId: "hubspot-app", clientSecret: "not-used", redirectUri: "http://127.0.0.1:8787/hubspot/oauth/callback" },
    fetchImpl: async () => new Response("{}", { status: 500 }),
  });
  const metadata = await app.handle(new Request("http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp"));
  assert.equal(metadata.status, 200);
  const body = (await metadata.json()) as { resource: string };
  assert.equal(body.resource, "http://127.0.0.1:8787/mcp");
  const server = await app.handle(new Request("http://127.0.0.1:8787/.well-known/oauth-authorization-server"));
  const document = (await server.json()) as { code_challenge_methods_supported: string[]; authorization_response_iss_parameter_supported: boolean };
  assert.deepEqual(document.code_challenge_methods_supported, ["S256"]);
  assert.equal(document.authorization_response_iss_parameter_supported, true);
  const denied = await app.handle(new Request("http://127.0.0.1:8787/mcp", { method: "POST" }));
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate") ?? "", /Bearer/i);
});
