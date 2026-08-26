import { describe, it, expect } from 'vitest';
import { RateLimiter, RateLimitError, domainOf } from '../../src/safety/ratelimit.js';

describe('RateLimiter', () => {
  it('extracts the domain from a url', () => {
    expect(domainOf('https://boards.greenhouse.io/acme/jobs/1')).toBe('boards.greenhouse.io');
  });

  it('permits up to the limit then refuses', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.configure('boards.greenhouse.io', { count: 2, per: 'hour' });
    const u = 'https://boards.greenhouse.io/acme/jobs/1';

    rl.check(u); rl.record(u);
    rl.check(u); rl.record(u);
    expect(() => rl.check(u)).toThrow(RateLimitError);
  });

  it('lets the window expire', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.configure('x.test', { count: 1, per: 'hour' });
    rl.check('https://x.test/a'); rl.record('https://x.test/a');
    expect(() => rl.check('https://x.test/a')).toThrow(RateLimitError);
    t += 60 * 60 * 1000 + 1;
    expect(() => rl.check('https://x.test/a')).not.toThrow();
  });

  it('is unlimited for domains with no configured limit', () => {
    const rl = new RateLimiter(() => 0);
    for (let i = 0; i < 50; i++) { rl.check('https://free.test/'); rl.record('https://free.test/'); }
    expect(() => rl.check('https://free.test/')).not.toThrow();
  });

  it('reports how long to wait', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.configure('x.test', { count: 1, per: 'hour' });
    rl.check('https://x.test/'); rl.record('https://x.test/');
    try { rl.check('https://x.test/'); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfterMs).toBeGreaterThan(0);
      expect((e as RateLimitError).domain).toBe('x.test');
    }
  });
});
