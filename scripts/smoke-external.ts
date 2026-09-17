import { createConnectorsForActiveClient } from "../src/connectors/createConnectors.ts";

process.env.PI_CLIENT ||= "apartment-life";
const write = process.argv.includes("--write");

try {
  const { external } = createConnectorsForActiveClient();
  const client = external();
  const health = await client.health();
  console.log("health", health);
  if (!health.ok) process.exitCode = 1;

  const read = await client.read("smoke");
  console.log("read", read);
  if (!read.ok) process.exitCode = 1;

  if (!write) {
    console.log("write skipped (pass --write to echo a stub write)");
  } else {
    const written = await client.write({ source: "smoke-external", at: new Date().toISOString() });
    console.log("write", written);
    if (!written.ok) process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
