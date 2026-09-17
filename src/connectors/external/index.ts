import type { ClientProfile, ClientScopedConnector, ConnectorResult } from "../../types/index.ts";
import { logCall } from "../../utils/index.ts";

export class ExternalConnector implements ClientScopedConnector {
  constructor(
    private options: {
      system: string;
      enabled: boolean;
      baseUrl?: string;
    },
  ) {}

  async health(): Promise<ConnectorResult<{ status: string; system: string; baseUrl: string | null }>> {
    const data = {
      status: this.options.enabled ? "configured-stub" : "disabled-stub",
      system: this.options.system,
      baseUrl: this.options.baseUrl ?? null,
    };
    logCall("external", "health", data);
    return { ok: true, data };
  }

  async read(query: string): Promise<ConnectorResult<Record<string, unknown>>> {
    const data = {
      stub: true,
      action: "read",
      query,
      system: this.options.system,
      message: "External system is a stub in v1. No remote call was made.",
    };
    logCall("external", "read", { query, system: this.options.system });
    return { ok: true, data };
  }

  async write(payload: unknown): Promise<ConnectorResult<Record<string, unknown>>> {
    const data = {
      stub: true,
      action: "write",
      echoed: payload,
      system: this.options.system,
      message: "External system is a stub in v1. No remote call was made.",
    };
    logCall("external", "write", { system: this.options.system });
    return { ok: true, data };
  }
}

export function createExternalConnector(
  profile: ClientProfile,
  env: NodeJS.ProcessEnv = process.env,
): ExternalConnector {
  return new ExternalConnector({
    system: profile.external.system,
    enabled: profile.external.enabled,
    baseUrl: env.EXTERNAL_BASE_URL,
  });
}
