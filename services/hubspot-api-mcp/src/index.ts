import { createServer } from "node:http";
import { actionPolicyFromEnv } from "./policy/actionPolicy.ts";
import { assertProductionSecrets } from "./boot.ts";
import type { UserCredential } from "./auth/provider.ts";
import { createApp, type AppConfig } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const issuer = process.env.MCP_ISSUER ?? `http://127.0.0.1:${port}`;
const config: AppConfig = {
  issuer,
  resource: process.env.MCP_RESOURCE_URL ?? `${issuer}/mcp`,
  authSecret: required("MCP_AUTH_SECRET"),
  approvalSecret: required("MCP_APPROVAL_SECRET"),
  portalId: process.env.HUBSPOT_PORTAL_ID ?? "5627913",
  allowedUsers: (process.env.HUBSPOT_API_MCP_USERS ?? "").split(",").map((user) => user.trim()).filter(Boolean),
  clients: JSON.parse(process.env.MCP_CLIENTS_JSON ?? "[]"),
  tokenKey: required("HUBSPOT_TOKEN_KEY"),
  tokenFile: process.env.HUBSPOT_TOKEN_FILE,
  revocationFile: process.env.MCP_REVOCATION_FILE,
  users: loadUsers(),
  actionPolicy: actionPolicyFromEnv({
    action: process.env.HUBSPOT_ACTION_POLICY,
    exports: process.env.HUBSPOT_EXPORT_CREATION,
  }),
  hubspot: {
    clientId: process.env.HUBSPOT_API_CLIENT_ID ?? "",
    clientSecret: process.env.HUBSPOT_API_CLIENT_SECRET ?? "",
    redirectUri: process.env.HUBSPOT_API_REDIRECT_URI ?? `${issuer}/hubspot/oauth/callback`,
  },
};

assertProductionSecrets({
  authSecret: config.authSecret,
  approvalSecret: config.approvalSecret,
  issuer: config.issuer,
  revocationFile: config.revocationFile,
});
const app = await createApp(config);
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    if (chunks.reduce((total, chunk) => total + chunk.length, 0) > 1_000_000) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "Request is too large." }));
      return;
    }
  }
  const body = Buffer.concat(chunks);
  const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await app.handle(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`hubspot-api-mcp listening on ${issuer}\n`);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function loadUsers(): UserCredential[] {
  const raw = process.env.HUBSPOT_API_MCP_USERS_JSON;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("HUBSPOT_API_MCP_USERS_JSON must be an array.");
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; passwordHash?: unknown };
    if (typeof record.id !== "string" || typeof record.passwordHash !== "string") return [];
    return [{ id: record.id, passwordHash: record.passwordHash }];
  });
}
