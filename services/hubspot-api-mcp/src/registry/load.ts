import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationRecord } from "./types.ts";

const registers = join(dirname(fileURLToPath(import.meta.url)), "../../registers");

export interface DiscoveryMeta {
  retrievedAt: string;
  apiVersion: string;
  catalogCount: number;
  operationCount: number;
  implementedOperationCount: number;
  baselineCount: number;
  baselineMatrixCount: number;
  scopeRegisterCount: number;
  completeness: string;
  accountLogin: string;
  granted: string;
}

export interface ScopeManifest {
  required: string[];
  optional: string[];
  omitted: { scope: string; reason: string }[];
}

export function loadOperations(): OperationRecord[] {
  return JSON.parse(readFileSync(join(registers, "operations.json"), "utf8")) as OperationRecord[];
}

export function loadManifest(): ScopeManifest {
  return JSON.parse(readFileSync(join(registers, "scope-manifest.json"), "utf8")) as ScopeManifest;
}

export function loadMeta(): DiscoveryMeta {
  return JSON.parse(readFileSync(join(registers, "discovery-meta.json"), "utf8")) as DiscoveryMeta;
}

export function loadBaseline(): string[] {
  return readFileSync(join(registers, "baseline-scopes.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function loadMatrix(): { baselineScope: string }[] {
  return JSON.parse(readFileSync(join(registers, "baseline-matrix.json"), "utf8")) as { baselineScope: string }[];
}

export function operationMap(operations: OperationRecord[]): Map<string, OperationRecord> {
  return new Map(operations.map((operation) => [operation.id, operation]));
}
