import { execFile } from "node:child_process";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "./constants.ts";

export function loadToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env.HUBSPOT_DIRECT_TOKEN;
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 5000 },
      (error, stdout) => {
        const token = stdout.trim();
        if (error || !token) {
          reject(new Error("HubSpot direct token is not configured in the macOS keychain."));
          return;
        }
        resolve(token);
      },
    );
  });
}
