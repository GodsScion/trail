/**
 * The wire protocol. Every shared type in the system lives here.
 * The driver boundary is defined as request/response messages, not merely a
 * TypeScript interface, so a v2 Chrome extension can become "another thing
 * that speaks the protocol" rather than a refactor.
 */

/** Snapshot verbosity. `raw` is scope-only — see RawHtmlRequest. */
export type Level = 'outline' | 'full' | 'raw';

/** How the agent names an element. `intent` is always required. */
export interface Target {
  /** Human-readable, used on the miss path. */
  intent: string;
  /** Durable ARIA (or `css=`) locator from the workflow file. */
  hint?: string;
  /** Ephemeral handle from the current snapshot generation. */
  ref?: string;
  /** The agent's correction; the server persists it to the workflow file. */
  learned_hint?: string;
}

/** The four shapes. Never widen this union. */
export type ActionResult =
  | { ok: true; diff?: string }
  | { ok: false; hint_miss: true; snapshot: string; scope: string }
  | { ok: false; needs_confirm: true; description: string; screenshot: string }
  | { ok: false; blocked: true; reason: string; screenshot: string };

export type ScrollDir = 'up' | 'down' | 'left' | 'right';

/** One node of the serialized accessibility tree. */
export interface AriaNode {
  /** `e12` for interactive nodes, `null` for structural ones. Valid only within `generation`. */
  ref: string | null;
  role: string;
  /** Computed accessible name; empty string when the element has none. */
  name: string;
  /** Own visible text, for text-bearing non-interactive nodes. */
  text?: string;
  value?: string;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  required?: boolean;
  selected?: boolean;
  placeholder?: string;
  /** CSS fallback selector. Emitted only when `name` is empty. */
  css?: string;
  children: AriaNode[];
}

/** What `query` returns: enough to run the submit guard without a second round trip. */
export interface RefInfo {
  ref: string;
  role: string;
  name: string;
}

export type WaitSpec =
  | { kind: 'load' }
  | { kind: 'idle' }
  | { kind: 'ms'; ms: number }
  | { kind: 'text'; text: string }
  | { kind: 'locator'; locator: string };

export type ParsedLocator =
  | { kind: 'aria'; role: string; name?: string; exact: boolean; attrs: Record<string, string> }
  | { kind: 'css'; selector: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Options `getByRole` actually supports. Anything else is a typo, not a feature. */
export const ARIA_ATTR_OPTIONS = [
  'level', 'checked', 'selected', 'expanded', 'pressed', 'disabled', 'includeHidden',
] as const;

const LOCATOR_RE = /^role=([a-z][a-z-]*)((?:\[[^\]]*\])*)$/;
const ATTR_RE = /\[([a-zA-Z]+)(?:=(?:"((?:[^"\\]|\\.)*)"|([^\]"]*)))?\]/g;

export function parseLocator(input: string): ParsedLocator {
  const raw = input.trim();
  if (raw.length === 0) throw new ProtocolError('locator is empty');
  if (raw.startsWith('css=')) {
    const selector = raw.slice(4).trim();
    if (selector.length === 0) throw new ProtocolError('css locator has an empty selector');
    return { kind: 'css', selector };
  }
  const m = LOCATOR_RE.exec(raw);
  if (!m) {
    throw new ProtocolError(
      `hints must be ARIA locators like role=button[name="Apply"]; ` +
        `prefix a CSS fallback with css= (got ${JSON.stringify(raw)})`,
    );
  }
  const role = m[1]!;
  const attrBlock = m[2] ?? '';
  const loc: ParsedLocator = { kind: 'aria', role, exact: false, attrs: {} };
  ATTR_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ATTR_RE.exec(attrBlock)) !== null) {
    const key = a[1]!;
    const value = a[2] !== undefined ? a[2].replace(/\\(.)/g, '$1') : a[3];
    if (key === 'exact') {
      loc.exact = value === undefined || value === 'true';
      continue;
    }
    if (key === 'name') {
      if (value === undefined) throw new ProtocolError('[name] requires a value');
      loc.name = value;
      continue;
    }
    if (!(ARIA_ATTR_OPTIONS as readonly string[]).includes(key)) {
      throw new ProtocolError(
        `unsupported aria option [${key}]; allowed: name, exact, ${ARIA_ATTR_OPTIONS.join(', ')}`,
      );
    }
    loc.attrs[key] = value ?? 'true';
  }
  return loc;
}

export function formatLocator(loc: ParsedLocator): string {
  if (loc.kind === 'css') return `css=${loc.selector}`;
  let out = `role=${loc.role}`;
  if (loc.name !== undefined) out += `[name="${loc.name.replace(/(["\\])/g, '\\$1')}"]`;
  if (loc.exact) out += '[exact]';
  for (const key of ARIA_ATTR_OPTIONS) {
    const v = loc.attrs[key];
    if (v !== undefined) out += `[${key}=${v}]`;
  }
  return out;
}

export function parseWaitSpec(input: string): WaitSpec {
  const raw = input.trim();
  if (raw === 'load') return { kind: 'load' };
  if (raw === 'idle') return { kind: 'idle' };
  if (raw.startsWith('text:')) {
    const text = raw.slice(5).trim();
    if (text.length === 0) throw new ProtocolError('text: wait has empty text');
    return { kind: 'text', text };
  }
  const dur = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(raw);
  if (dur) {
    const ms = Math.round(Number(dur[1]) * (dur[2] === 's' ? 1000 : 1));
    if (ms <= 0) throw new ProtocolError('wait duration must be positive');
    return { kind: 'ms', ms };
  }
  parseLocator(raw); // throws ProtocolError if it is not a valid locator
  return { kind: 'locator', locator: raw };
}

// ---------------------------------------------------------------------------
// Driver wire protocol
// ---------------------------------------------------------------------------

export type DriverRequest =
  | { kind: 'navigate'; url: string; timeout_ms?: number }
  | { kind: 'current_url' }
  | { kind: 'aria_tree'; scope?: string }
  /** `scope` is REQUIRED: whole-page source must be unrequestable. */
  | { kind: 'raw_html'; scope: string }
  | { kind: 'query'; locator: string; scope?: string }
  | { kind: 'screenshot'; scope?: string; full_page?: boolean }
  | { kind: 'click'; ref: string; delay_ms?: number }
  | { kind: 'type'; ref: string; text: string; delay_ms?: number; clear?: boolean }
  | { kind: 'press'; keys: string; delay_ms?: number }
  | { kind: 'select'; ref: string; values: string[] }
  | { kind: 'upload'; ref: string; paths: string[] }
  | { kind: 'scroll'; ref?: string; dir: ScrollDir; amount: number }
  | { kind: 'drag'; from_ref: string; to_ref: string; steps?: number }
  | { kind: 'wait'; spec: WaitSpec; timeout_ms?: number };

export type DriverErrorCode =
  | 'not_found'
  | 'timeout'
  | 'invalid_scope'
  | 'detached'
  | 'navigation_failed'
  | 'internal';

export type DriverResponse =
  | { kind: 'ok' }
  | { kind: 'aria_tree'; root: AriaNode; generation: number; url: string }
  | { kind: 'raw_html'; html: string }
  | { kind: 'query'; matches: RefInfo[]; generation: number }
  /** Filesystem path to a written PNG — never base64. See Global Constraints. */
  | { kind: 'screenshot'; path: string }
  | { kind: 'current_url'; url: string }
  | { kind: 'error'; code: DriverErrorCode; message: string };

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

export interface RateLimit {
  count: number;
  per: 'hour' | 'day';
}

export interface WorkflowFrontmatter {
  name: string;
  match: string;
  requires: string[];
  /** Default-on. Absent from frontmatter means true. */
  confirm_submit: boolean;
  rate_limit: RateLimit | null;
}

export interface WorkflowStep {
  /** 1-based, as numbered in the markdown. */
  index: number;
  text: string;
  hint: string | null;
  /** 0-based index of the step's own line in `source`. */
  line: number;
  /** 0-based index of the line holding the `<!-- hint: --> ` comment, or null. */
  hintLine: number | null;
}

/** In-memory workflow, including the verbatim source needed for surgical rewrites. */
export interface Workflow {
  path: string;
  source: string;
  frontmatter: WorkflowFrontmatter;
  intent: string;
  steps: WorkflowStep[];
}

/** The wire shape returned by the `workflow_load` tool. */
export interface LoadedWorkflow {
  name: string;
  path: string;
  match: string;
  intent: string;
  requires: string[];
  confirm_submit: boolean;
  rate_limit: RateLimit | null;
  steps: Array<{ index: number; text: string; hint: string | null }>;
}

// ---------------------------------------------------------------------------
// Token accounting — success criterion 2 is measured with this
// ---------------------------------------------------------------------------

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export interface LedgerEntry {
  tool: string;
  tokens: number;
}

export class TokenLedger {
  private entries: LedgerEntry[] = [];

  record(tool: string, payload: unknown): number {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const tokens = estimateTokens(s ?? '');
    this.entries.push({ tool, tokens });
    return tokens;
  }

  total(): number {
    return this.entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  byTool(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) out[e.tool] = (out[e.tool] ?? 0) + e.tokens;
    return out;
  }

  count(): number {
    return this.entries.length;
  }

  snapshot(): readonly LedgerEntry[] {
    return [...this.entries];
  }

  reset(): void {
    this.entries = [];
  }
}
