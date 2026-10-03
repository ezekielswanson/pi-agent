import { secretValues } from "../../config/loadEnv.ts";
import type { ClientScopedConnector, ConnectorResult, LoadedClient } from "../../types/index.ts";
import { ScopeError } from "../../utils/errors.ts";
import { runOperation } from "../../utils/result.ts";

export class ExternalConnector implements ClientScopedConnector {
  constructor(private loaded: LoadedClient) {}

  private meta(operation: string) {
    return { client: this.loaded.slug, system: "external", operation };
  }

  async health(): Promise<ConnectorResult<{ status: string; system: string }>> {
    return runOperation(this.meta("health"), secretValues(this.loaded.secrets), async () => ({
      status: this.loaded.profile.external.enabled ? "configured-stub" : "disabled-stub",
      system: this.loaded.profile.external.system,
    }));
  }

  async read(query: string): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("read"), secretValues(this.loaded.secrets), async () => ({
      stub: true,
      action: "read",
      query,
      system: this.loaded.profile.external.system,
      message: "External system is a stub in v1. No remote call was made.",
    }));
  }

  async write(_payload: unknown): Promise<ConnectorResult<Record<string, unknown>>> {
    return runOperation(this.meta("write"), secretValues(this.loaded.secrets), async () => {
      throw new ScopeError("External system is a stub. No remote call was made.");
    });
  }
}

export function createExternalConnector(loaded: LoadedClient): ExternalConnector {
  return new ExternalConnector(loaded);
}
