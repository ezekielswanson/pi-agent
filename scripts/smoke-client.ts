import { getActiveClientSlug, listClientSlugs } from "../src/config/activeClient.ts";
import { formatClientPromptBlock, loadClientProfile } from "../src/config/loadClientProfile.ts";

process.env.PI_CLIENT ||= "apartment-life";

const available = listClientSlugs();
console.log("Available clients:", available.join(", ") || "(none)");
console.log("PI_CLIENT / active file:", getActiveClientSlug() ?? "(none)");

try {
  const loaded = loadClientProfile();
  console.log("Loaded:", loaded.slug);
  console.log("Client dir:", loaded.clientDir);
  console.log(formatClientPromptBlock(loaded.profile));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
