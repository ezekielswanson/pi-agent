export const PORTAL_ID = "5627913";
export const ACCOUNT_OPERATION_ID = "get-account-info-2026-09-details";
export const KEYCHAIN_SERVICE = "pi-agent.apartment-life.hubspot-direct";
export const KEYCHAIN_ACCOUNT = PORTAL_ID;
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export const PERMANENT_EXCLUSIONS = [
  "files.delete",
  "commerce.payment_links.delete",
  "business_units_view.read",
] as const;
