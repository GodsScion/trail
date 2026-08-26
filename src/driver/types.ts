import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DriverRequest, DriverResponse } from '../protocol.js';

/**
 * The driver boundary. Everything above it speaks request/response messages,
 * so a v2 Chrome extension becomes another thing that speaks the protocol
 * rather than a refactor.
 */
export interface Driver {
  send(req: DriverRequest): Promise<DriverResponse>;
  close(): Promise<void>;
}

export interface DriverLaunchOptions {
  /** Persistent Chrome profile directory. The user logs in here once. */
  userDataDir: string;
  /** Where screenshots are written. Never inlined as base64. */
  screenshotDir: string;
  /** Chrome channel. Must stay a real installed Chrome — never bundled Chromium. */
  channel?: string;
  /** Must remain false in production: headless is a detection tell. */
  headless?: boolean;
  defaultTimeoutMs?: number;
}

export function defaultDriverLaunchOptions(
  stateDir: string = process.env.TRAIL_STATE_DIR ?? join(homedir(), '.trail'),
): DriverLaunchOptions {
  return {
    userDataDir: join(stateDir, 'chrome-profile'),
    screenshotDir: join(stateDir, 'screenshots'),
    channel: 'chrome',
    headless: false,
    defaultTimeoutMs: 15_000,
  };
}
