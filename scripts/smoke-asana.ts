import { createConnectorsForActiveClient } from "../src/connectors/createConnectors.ts";

process.env.PI_CLIENT ||= "apartment-life";
const write = process.argv.includes("--write");

try {
  const { loaded, asana } = createConnectorsForActiveClient();
  const client = asana();
  const health = await client.health();
  console.log("health", health);
  if (!health.ok) process.exitCode = 1;

  const query = process.argv.find((arg) => arg.startsWith("--query="))?.slice(8) ?? "test";
  if (loaded.profile.asana.workspaceGid) {
    const found = await client.find({ query, resourceType: "task" });
    console.log("find", found);
    if (!found.ok) process.exitCode = 1;
  } else {
    console.log("find skipped: asana.workspaceGid is not set");
  }

  if (!write) {
    console.log("write skipped (pass --write to create a task)");
  } else {
    const projectGid =
      process.env.ASANA_SMOKE_PROJECT_GID ?? Object.values(loaded.profile.asana.projectGids)[0];
    const created = await client.createTask({
      name: `pi-agent smoke ${new Date().toISOString()}`,
      notes: "Created by scripts/smoke-asana.ts",
      projectGid,
      workspaceGid: loaded.profile.asana.workspaceGid ?? undefined,
    });
    console.log("create", created);
    if (!created.ok) process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
