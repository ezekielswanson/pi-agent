export type ConnectorResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface ClientScopedConnector {
  health(signal?: AbortSignal): Promise<ConnectorResult<{ status: string }>>;
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
  };
  asana: {
    workspaceGid: string | null;
    projectGids: Record<string, string>;
  };
  external: {
    enabled: boolean;
    system: string;
  };
}

export interface LoadedClient {
  profile: ClientProfile;
  slug: string;
  clientDir: string;
}
