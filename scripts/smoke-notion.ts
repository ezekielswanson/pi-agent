import { createConnectorsForActiveClient } from "../src/connectors/createConnectors.ts";

process.env.PI_CLIENT ||= "apartment-life";
const write = process.argv.includes("--write");

try {
  const { loaded, notion } = createConnectorsForActiveClient();
  const client = notion();
  const health = await client.health();
  console.log("health", health);
  if (!health.ok) process.exitCode = 1;

  const query = process.argv.find((arg) => arg.startsWith("--query="))?.slice(8) ?? "test";
  const found = await client.find(query);
  console.log("find", found);
  if (!found.ok) process.exitCode = 1;

  const mappedPageId = Object.values(loaded.profile.notion.pageIds)[0];
  if (mappedPageId) {
    const read = await client.read(mappedPageId);
    console.log("read", read);
    if (!read.ok) process.exitCode = 1;
  } else {
    console.log("read skipped: no mapped Notion page id");
  }

  if (!write) {
    console.log("write skipped (pass --write to create a page)");
  } else {
    const parentPageId =
      process.env.NOTION_SMOKE_PARENT_PAGE_ID ?? Object.values(loaded.profile.notion.pageIds)[0];
    if (!parentPageId) {
      console.error("write skipped: set NOTION_SMOKE_PARENT_PAGE_ID or a mapped page id");
      process.exitCode = 1;
    } else {
      const created = await client.create({
        title: `pi-agent smoke ${new Date().toISOString()}`,
        parentPageId,
      });
      console.log("create", created);
      if (!created.ok) process.exitCode = 1;
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
