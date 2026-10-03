import { loadClientProfile } from "../src/config/loadClientProfile.ts";
import { checkExpectedPortal, extractPortalId } from "../src/connectors/hubspot/index.ts";

process.env.PI_CLIENT ||= "apartment-life";

try {
  const loaded = loadClientProfile();
  const clientId = process.env.HUBSPOT_MCP_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_MCP_CLIENT_SECRET;

  console.log("preflight", "hubspot config only");
  console.log("client", loaded.profile.name);
  console.log("expectedPortalId", loaded.profile.hubspot.expectedPortalId);
  console.log("HUBSPOT_MCP_CLIENT_ID", clientId ? "set" : "missing");
  console.log("HUBSPOT_MCP_CLIENT_SECRET", clientSecret ? "set" : "missing");

  const sample = { portalId: loaded.profile.hubspot.expectedPortalId ?? "123" };
  const extracted = extractPortalId(sample);
  const check = checkExpectedPortal(extracted, loaded.profile.hubspot.expectedPortalId);
  if (!loaded.profile.hubspot.expectedPortalId && check.ok) {
    throw new Error("Missing expected portal must not count as a match.");
  }
  console.log("portal helper", check.ok ? "matched" : "blocked");

  const mismatch = checkExpectedPortal("999", "123");
  if (mismatch.ok) {
    throw new Error("Expected portal mismatch to fail.");
  }
  console.log("mismatch helper", "blocked");

  if (!clientId || !clientSecret) {
    console.log("OAuth is not configured. Create a HubSpot MCP connector and fill .env.");
    console.log("Then run: pi");
    console.log("Then run: /mcp-auth hubspot");
  } else {
    console.log("Credentials present. Authenticate in Pi with /mcp-auth hubspot.");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
