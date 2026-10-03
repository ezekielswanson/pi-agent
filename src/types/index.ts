export type ErrorCategory =
  | "auth"
  | "permission"
  | "validation"
  | "not_found"
  | "rate_limit"
  | "cancelled"
  | "timeout"
  | "unknown";

export type Completeness = "complete" | "partial";

export interface ResultMeta {
  client: string;
  system: string;
  operation: string;
}

export type ConnectorResult<T> = ResultMeta & {
  links?: string[];
  completeness?: Completeness;
} & (
    | { ok: true; data: T }
    | { ok: false; error: string; errorCategory: ErrorCategory; uncertain?: boolean }
  );

export interface ClientScopedConnector {
  health(signal?: AbortSignal): Promise<ConnectorResult<{ status: string }>>;
}

export type AsanaMode = "mcp" | "rest" | "disabled";

export interface NotionOutputParent {
  type: "page" | "data_source";
  id: string;
}

export interface ClientAllowlist {
  notionPageIds: string[];
  notionDatabaseIds: string[];
  notionDataSourceIds: string[];
  asanaProjectGids: string[];
  asanaTaskGids: string[];
  hubspotPortalIds: string[];
  localRoots: string[];
}

export interface ClientProfile {
  name: string;
  slug: string;
  hubspot: {
    expectedPortalId: string | number | null;
    notes?: string;
  };
  notion: {
    databaseIds: Record<string, string>;
    pageIds: Record<string, string>;
    testPageId: string | null;
    outputParent: NotionOutputParent | null;
  };
  asana: {
    mode: AsanaMode;
    workspaceGid: string | null;
    projectGids: Record<string, string>;
    testProjectGid: string | null;
  };
  researchRoots: string[];
  allowlist: ClientAllowlist;
  external: {
    enabled: boolean;
    system: string;
  };
}

export interface ClientSecrets {
  readonly notionToken: string | null;
  readonly asanaToken: string | null;
  readonly externalBaseUrl: string | null;
  readonly externalApiKey: string | null;
}

export interface LoadedClient {
  profile: ClientProfile;
  slug: string;
  clientDir: string;
  secrets: ClientSecrets;
  operatingRules: string;
}
