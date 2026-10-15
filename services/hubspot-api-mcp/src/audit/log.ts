import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "../policy/redact.ts";

export interface AuditEvent {
  actor: string;
  clientId: string;
  portalId: string;
  operation: string;
  targetIds: string[];
  timestamp: string;
  approvalId?: string;
  outcome: string;
  correlationId?: string | null;
}

const events: AuditEvent[] = [];

export function audit(event: AuditEvent, filePath?: string): void {
  const safe = redact(event) as AuditEvent;
  events.push(safe);
  if (filePath) {
    void mkdir(dirname(filePath), { recursive: true }).then(() => appendFile(filePath, `${JSON.stringify(safe)}\n`));
  }
}

export function auditEvents(): AuditEvent[] {
  return events;
}

export function resetAudit(): void {
  events.length = 0;
}
