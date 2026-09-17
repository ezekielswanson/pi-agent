import { loadClientProfile } from "../config/loadClientProfile.ts";
import type { LoadedClient } from "../types/index.ts";
import { createAsanaConnector } from "./asana/index.ts";
import { createExternalConnector } from "./external/index.ts";
import { createNotionConnector } from "./notion/index.ts";

export function createConnectorsForActiveClient(slug?: string) {
  const loaded: LoadedClient = loadClientProfile(slug);
  return {
    loaded,
    notion: () => createNotionConnector(),
    asana: () => createAsanaConnector(process.env.ASANA_ACCESS_TOKEN, loaded.profile.asana.workspaceGid),
    external: () => createExternalConnector(loaded.profile),
  };
}
