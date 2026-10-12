import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface HubSpotGrant {
  portalId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  userId: string;
}

interface StoredFile {
  [installationKey: string]: { iv: string; tag: string; data: string };
}

export class TokenStore {
  private memory = new Map<string, HubSpotGrant>();
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly filePath?: string,
  ) {
    const raw = Buffer.from(secret, "base64");
    if (raw.length !== 32) throw new Error("HUBSPOT_TOKEN_KEY must be 32 bytes of base64.");
    this.key = raw;
  }

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as StoredFile;
      for (const [id, row] of Object.entries(parsed)) this.memory.set(id, this.decrypt(row));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(installationKey: string): HubSpotGrant | undefined {
    return this.memory.get(installationKey);
  }

  async put(installationKey: string, grant: HubSpotGrant): Promise<void> {
    this.memory.set(installationKey, grant);
    await this.persist();
  }

  async delete(installationKey: string): Promise<void> {
    this.memory.delete(installationKey);
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const output: StoredFile = {};
    for (const [id, grant] of this.memory) output[id] = this.encrypt(grant);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(output));
  }

  private encrypt(grant: HubSpotGrant): { iv: string; tag: string; data: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
  }

  private decrypt(row: { iv: string; tag: string; data: string }): HubSpotGrant {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64url"));
    const json = Buffer.concat([decipher.update(Buffer.from(row.data, "base64url")), decipher.final()]).toString("utf8");
    return JSON.parse(json) as HubSpotGrant;
  }
}
