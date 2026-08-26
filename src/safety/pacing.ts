export interface PacingOptions {
  baseMs?: number;
  jitterMs?: number;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Per-action floors, in ms. Typing is slowest because it is most watched. */
export const PACE_BASE_MS: Readonly<Record<string, number>> = Object.freeze({
  click: 120,
  type: 180,
  press: 90,
  select: 120,
  upload: 200,
  scroll: 80,
  drag: 150,
  default: 120,
});

export function pacingDelay(kind: string, opts: PacingOptions = {}): number {
  const base = opts.baseMs ?? PACE_BASE_MS[kind] ?? PACE_BASE_MS.default!;
  const jitter = opts.jitterMs ?? base;
  const rng = opts.rng ?? Math.random;
  return Math.round(base + rng() * jitter);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makePacer(opts: PacingOptions = {}): (kind: string) => Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  return (kind: string) => sleep(pacingDelay(kind, opts));
}
