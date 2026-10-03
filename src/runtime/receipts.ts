import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScopeError } from "../utils/errors.ts";

export type ReceiptStatus = "succeeded" | "failed" | "skipped" | "uncertain";

export interface ReceiptTarget {
  system: string;
  operation: string;
  id?: string;
  url?: string;
  status: ReceiptStatus;
}

export interface RunReceipt {
  client: string;
  sourceSystem: string;
  sourceId: string;
  targets: ReceiptTarget[];
  createdAt: string;
  updatedAt: string;
  uncertainty?: string;
}

export interface PlannedWrite {
  system: string;
  operation: string;
  action: "create" | "skip";
  reason?: string;
}

function safeKey(value: string): string {
  const key = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!key) throw new ScopeError("Receipt source id is empty.");
  return key;
}

export function receiptPath(repoRoot: string, client: string, sourceSystem: string, sourceId: string): string {
  return join(repoRoot, ".pi", "receipts", safeKey(client), `${safeKey(sourceSystem)}-${safeKey(sourceId)}.json`);
}

export function readReceipt(
  repoRoot: string,
  client: string,
  sourceSystem: string,
  sourceId: string,
): RunReceipt | null {
  try {
    const parsed = JSON.parse(readFileSync(receiptPath(repoRoot, client, sourceSystem, sourceId), "utf8")) as RunReceipt;
    if (parsed.client !== client || parsed.sourceId !== sourceId || parsed.sourceSystem !== sourceSystem) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseReceiptTargets(value: unknown): ReceiptTarget[] {
  if (!Array.isArray(value)) throw new ScopeError("Receipt targets must be an array.");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new ScopeError("Receipt target must be an object.");
    const record = item as Record<string, unknown>;
    const status = record.status;
    if (typeof record.system !== "string" || typeof record.operation !== "string") {
      throw new ScopeError("Receipt target needs a system and operation.");
    }
    if (status !== "succeeded" && status !== "failed" && status !== "skipped" && status !== "uncertain") {
      throw new ScopeError("Receipt target status is invalid.");
    }
    return {
      system: record.system,
      operation: record.operation,
      status,
      id: typeof record.id === "string" ? record.id : undefined,
      url: typeof record.url === "string" ? record.url : undefined,
    };
  });
}

export function writeReceipt(repoRoot: string, receipt: RunReceipt): RunReceipt {
  const path = receiptPath(repoRoot, receipt.client, receipt.sourceSystem, receipt.sourceId);
  mkdirSync(join(path, ".."), { recursive: true });
  const existing = readReceipt(repoRoot, receipt.client, receipt.sourceSystem, receipt.sourceId);
  const stored: RunReceipt = {
    ...receipt,
    createdAt: existing?.createdAt ?? receipt.createdAt,
    targets: mergeTargets(existing?.targets ?? [], receipt.targets),
  };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  return stored;
}

function mergeTargets(existing: ReceiptTarget[], incoming: ReceiptTarget[]): ReceiptTarget[] {
  const merged = [...existing];
  for (const target of incoming) {
    const index = merged.findIndex((item) => item.system === target.system && item.operation === target.operation);
    if (index >= 0) merged[index] = target;
    else merged.push(target);
  }
  return merged;
}

export function planWrites(receipt: RunReceipt | null, wanted: Array<{ system: string; operation: string }>): PlannedWrite[] {
  return wanted.map((item) => {
    const recorded = receipt?.targets.find((target) => target.system === item.system && target.operation === item.operation);
    if (!recorded) return { ...item, action: "create" };
    if (recorded.status === "succeeded") {
      return { ...item, action: "skip", reason: `Already recorded as ${recorded.id ?? "succeeded"}.` };
    }
    if (recorded.status === "uncertain") {
      return { ...item, action: "skip", reason: "Recorded outcome is uncertain. Reconcile that target before creating another." };
    }
    return { ...item, action: "create", reason: "The recorded target did not succeed." };
  });
}
