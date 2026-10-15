export interface ScopeGroup {
  mode: "any" | "all";
  scopes: string[];
  description?: string;
}

export interface OperationRecord {
  id: string;
  title: string;
  summary: string;
  domain: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  spec: string;
  version: string;
  scopeGroups: ScopeGroup[];
  effect: "read" | "mutate";
  destructive: string;
  paginated: boolean;
  batch: boolean;
  excluded: boolean;
  exclusionReason: string | null;
  tool: string | null;
  sourceUrl: string;
  retrievedAt: string;
  implemented: boolean;
  tested: string;
  scopeConflict?: boolean;
}

export interface CallParams {
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

export const EXCLUDED_SCOPES = [
  "files.delete",
  "commerce.payment_links.delete",
  "business_units_view.read",
] as const;

export const ELEVATED = new Set([
  "archive",
  "permanent_delete",
  "association_remove",
  "unenroll",
  "unpublish",
  "send",
  "publish",
  "merge",
  "user_remove",
  "billing",
  "schema_delete",
  "pipeline_delete",
  "import",
]);
