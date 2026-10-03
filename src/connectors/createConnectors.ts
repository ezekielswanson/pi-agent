import { loadClientProfile } from "../config/loadClientProfile.ts";
import type { LoadedClient } from "../types/index.ts";
import { createAsanaConnector } from "./asana/index.ts";
import { createExternalConnector } from "./external/index.ts";
import { createNotionConnector } from "./notion/index.ts";

export function createConnectorsForActiveClient(slug?: string, repoRoot?: string) {
  const loaded: LoadedClient = loadClientProfile(slug, repoRoot);
  return {
    loaded,
    notion: () => createNotionConnector(loaded),
    asana: () => createAsanaConnector(loaded),
    external: () => createExternalConnector(loaded),
  };
}
