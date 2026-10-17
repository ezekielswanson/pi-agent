import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyError } from "../../services/hubspot-api-mcp/src/policy/errors.ts";
import type { CallParams } from "../../services/hubspot-api-mcp/src/registry/types.ts";
import { loadToken } from "./credentials.ts";
import { writeModeFromEnv } from "./policy.ts";
import { DirectRunner } from "./runner.ts";

const approvalFile = join(dirname(fileURLToPath(import.meta.url)), "../../.pi/hubspot-direct/approvals.json");

async function main(): Promise<void> {
  const [command, operationOrId, ...rest] = process.argv.slice(2);
  const flags = readFlags(rest);
  if (!command || command === "help") {
    process.stdout.write(help());
    return;
  }
  const token = command === "list" ? "" : await loadToken();
  const runner = new DirectRunner({
    token,
    writes: writeModeFromEnv(),
    approvalFile,
  });
  if (command === "list") {
    write(runner.list(flags.match ?? ""));
    return;
  }
  if (command === "read") {
    write(await runner.read(required(operationOrId, "operation id"), paramsFrom(flags)));
    return;
  }
  if (command === "prepare") {
    write(await runner.prepare(required(operationOrId, "operation id"), paramsFrom(flags)));
    return;
  }
  if (command === "approve") {
    write(runner.approve(required(operationOrId, "proposal id")));
    return;
  }
  if (command === "execute") {
    write(await runner.execute(required(operationOrId, "proposal id")));
    return;
  }
  throw new Error(`Unknown command ${command}.`);
}

function paramsFrom(flags: Record<string, string>): CallParams {
  return {
    pathParams: flags.path ? jsonObject(flags.path, "path") : undefined,
    query: flags.query ? jsonQuery(flags.query) : undefined,
    body: flags.body ? JSON.parse(flags.body) as unknown : undefined,
  };
}

function jsonObject(value: string, label: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} JSON must be an object.`);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string") throw new Error(`${label} values must be strings.`);
    output[key] = item;
  }
  return output;
}

function jsonQuery(value: string): Record<string, string | number | boolean> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("query JSON must be an object.");
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error("query values must be strings, numbers, or booleans.");
    }
    output[key] = item;
  }
  return output;
}

function readFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}.`);
    const key = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): string {
  return `Usage:
  npm run hubspot:direct -- list [--match contacts]
  npm run hubspot:direct -- read <operationId> [--path '{}'] [--query '{}']
  npm run hubspot:direct -- prepare <operationId> [--path '{}'] [--query '{}'] [--body '{}']
  npm run hubspot:direct -- approve <proposalId>
  npm run hubspot:direct -- execute <proposalId>

Reads are allowed. Writes stay off until HUBSPOT_DIRECT_WRITES=approval.
Delete, archive, purge, export, send, publish, and merge stay denied.
\n`;
}

main().catch((error: unknown) => {
  const message = error instanceof PolicyError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Command failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
