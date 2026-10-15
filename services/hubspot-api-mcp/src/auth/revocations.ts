import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class RevocationLog {
  private hashes = new Set<string>();

  constructor(private readonly filePath?: string) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { hashes?: string[] };
      for (const hash of parsed.hashes ?? []) this.hashes.add(hash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  has(token: string): boolean {
    return this.hashes.has(digest(token));
  }

  async add(token: string): Promise<void> {
    this.hashes.add(digest(token));
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ hashes: [...this.hashes] }));
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
