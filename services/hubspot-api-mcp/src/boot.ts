const TEST_SIGNING_SECRETS = new Set(["test-secret", "approval", "approval-secret", "auth-secret"]);

export function assertProductionSecrets(input: {
  authSecret: string;
  approvalSecret: string;
  issuer?: string;
  revocationFile?: string;
}): void {
  if (process.env.NODE_ENV !== "production") return;
  for (const secret of [input.authSecret, input.approvalSecret]) {
    if (TEST_SIGNING_SECRETS.has(secret)) throw new Error("Production boot refuses the local test signer.");
    if (secret.length < 32 || new Set(secret).size < 10) throw new Error("Production secret is too weak.");
  }
  if (input.issuer !== undefined && !input.issuer.startsWith("https://")) {
    throw new Error("Production issuer must use HTTPS.");
  }
  if (input.revocationFile !== undefined && input.revocationFile.length === 0) {
    throw new Error("Production boot requires a revocation file.");
  }
  if (input.issuer !== undefined && input.revocationFile === undefined) {
    throw new Error("Production boot requires a revocation file.");
  }
}
