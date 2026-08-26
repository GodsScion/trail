import { describe, it, expect } from 'vitest';
import { pacingDelay, makePacer, PACE_BASE_MS } from '../../src/safety/pacing.js';

describe('pacing', () => {
  it('never returns an instant delay', () => {
    for (const kind of ['click', 'type', 'press', 'drag', 'unknown']) {
      expect(pacingDelay(kind, { rng: () => 0 })).toBeGreaterThan(0);
    }
  });

  it('spreads delay across the jitter window', () => {
    const lo = pacingDelay('click', { rng: () => 0 });
    const hi = pacingDelay('click', { rng: () => 0.999 });
    expect(hi).toBeGreaterThan(lo);
    expect(hi - lo).toBeLessThanOrEqual(PACE_BASE_MS.click!);
  });

  it('actually sleeps for the computed delay', async () => {
    const slept: number[] = [];
    const pace = makePacer({ rng: () => 0.5, sleep: async (ms) => { slept.push(ms); } });
    await pace('type');
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(0);
  });
});
