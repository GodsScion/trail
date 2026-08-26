import type { RateLimit } from '../protocol.js';

const WINDOW_MS: Record<RateLimit['per'], number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

export class RateLimitError extends Error {
  readonly domain: string;
  readonly retryAfterMs: number;
  constructor(domain: string, retryAfterMs: number) {
    super(`rate limit reached for ${domain}; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
    this.domain = domain;
    this.retryAfterMs = retryAfterMs;
  }
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export class RateLimiter {
  #now: () => number;
  #limits = new Map<string, RateLimit>();
  #hits = new Map<string, number[]>();

  constructor(now: () => number = Date.now) { this.#now = now; }

  configure(domain: string, limit: RateLimit | null): void {
    if (limit) this.#limits.set(domain, limit);
    else this.#limits.delete(domain);
  }

  #recent(domain: string, windowMs: number): number[] {
    const cutoff = this.#now() - windowMs;
    const kept = (this.#hits.get(domain) ?? []).filter((t) => t > cutoff);
    this.#hits.set(domain, kept);
    return kept;
  }

  check(url: string): void {
    const domain = domainOf(url);
    const limit = this.#limits.get(domain);
    if (!limit) return;
    const windowMs = WINDOW_MS[limit.per];
    const recent = this.#recent(domain, windowMs);
    if (recent.length < limit.count) return;
    const oldest = recent[0]!;
    throw new RateLimitError(domain, oldest + windowMs - this.#now());
  }

  record(url: string): void {
    const domain = domainOf(url);
    const hits = this.#hits.get(domain) ?? [];
    hits.push(this.#now());
    this.#hits.set(domain, hits);
  }
}
