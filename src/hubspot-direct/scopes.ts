import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMANENT_EXCLUSIONS } from "./constants.ts";

export interface DirectAppConfig {
  uid: string;
  distribution: "private";
  authType: "static";
  requiredScopes: string[];
}

const appFile = join(dirname(fileURLToPath(import.meta.url)), "../../hubspot/src/app/app-hsmeta.json");

export function loadDirectApp(file = appFile): DirectAppConfig {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    uid?: unknown;
    config?: {
      distribution?: unknown;
      auth?: {
        type?: unknown;
        requiredScopes?: unknown;
        redirectUrls?: unknown;
        optionalScopes?: unknown;
      };
    };
  };
  const auth = parsed.config?.auth;
  const required = auth?.requiredScopes;
  if (parsed.config?.distribution !== "private" || auth?.type !== "static") {
    throw new Error("Direct API app must use private distribution and static auth.");
  }
  if (!Array.isArray(required) || required.some((scope) => typeof scope !== "string" || !scope)) {
    throw new Error("Direct API app requiredScopes must be a list of scope names.");
  }
  if (auth.redirectUrls !== undefined) {
    throw new Error("Direct API app must not register an OAuth redirect.");
  }
  const optional = auth.optionalScopes;
  if (Array.isArray(optional) && optional.length > 0) {
    throw new Error("Static auth cannot request optional scopes.");
  }
  for (const excluded of PERMANENT_EXCLUSIONS) {
    if (required.includes(excluded)) throw new Error(`Excluded scope was requested: ${excluded}`);
  }
  return {
    uid: String(parsed.uid),
    distribution: "private",
    authType: "static",
    requiredScopes: required,
  };
}
