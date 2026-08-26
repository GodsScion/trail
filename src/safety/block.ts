import type { ActionResult } from '../protocol.js';

/**
 * Deliberately narrow. A false positive halts a real application mid-flow,
 * which is worse than missing one block — the agent will hit the wall on the
 * next action anyway and surface a real error.
 */
export const BLOCK_SIGNALS: readonly RegExp[] = Object.freeze([
  /checking your browser/i,
  /just a moment/i,
  /verify (?:you are|you're) (?:a )?human/i,
  /complete the captcha/i,
  /\bcaptcha\b/i,
  /access denied/i,
  /you have been blocked/i,
  /unusual traffic/i,
  /rate.?limited/i,
  /are you a robot/i,
]);

export function detectBlock(snapshot: string, _url: string): string | null {
  for (const re of BLOCK_SIGNALS) {
    const m = re.exec(snapshot);
    if (m) return m[0];
  }
  return null;
}

export function blockedResult(reason: string, screenshot: string): ActionResult {
  return { ok: false, blocked: true, reason, screenshot };
}
