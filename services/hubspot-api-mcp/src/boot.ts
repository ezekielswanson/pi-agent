const TEST_SIGNING_SECRETS = new Set(["test-secret", "approval", "approval-secret", "auth-secret"]);

export function assertProductionSecrets(input: { authSecret: string; approvalSecret: string }): void {
  if (process.env.NODE_ENV !== "production") return;
  if (TEST_SIGNING_SECRETS.has(input.authSecret) || TEST_SIGNING_SECRETS.has(input.approvalSecret)) {
    throw new Error("Production boot refuses the local test signer.");
  }
}
