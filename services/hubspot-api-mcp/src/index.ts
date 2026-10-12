import { createServer } from "node:http";
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
  hubspot: {
    clientId: process.env.HUBSPOT_API_CLIENT_ID ?? "",
    clientSecret: process.env.HUBSPOT_API_CLIENT_SECRET ?? "",
    redirectUri: process.env.HUBSPOT_API_REDIRECT_URI ?? `${issuer}/hubspot/oauth/callback`,
  },
};

const app = await createApp(config);
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
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

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`hubspot-api-mcp listening on ${issuer}\n`);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
