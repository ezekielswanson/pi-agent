export class RateLimiter {
  private buckets = new Map<string, number[]>();

  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
    if (hits.length >= limit) {
      this.buckets.set(key, hits);
      return false;
    }
    hits.push(now);
    this.buckets.set(key, hits);
    return true;
  }
}
