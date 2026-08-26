/**
 * The whole tool surface: twelve tools, no more. Tool definitions cost context
 * on every agent turn, so the ceiling is a product feature, not an oversight.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ActionResult, Level, Target, TokenLedger } from '../protocol.js';
import type { Actions } from './actions.js';
import { RateLimiter, RateLimitError, domainOf } from '../safety/ratelimit.js';
import {
  loadWorkflows, matchWorkflow, findWorkflowByName, toLoadedWorkflow,
} from '../workflow/store.js';

export interface ToolContext {
  actions: Actions;
  limiter: RateLimiter;
  ledger: TokenLedger;
  workflowsDir: string;
}

export const TOOL_NAMES: readonly string[] = Object.freeze([
  'browser_snapshot', 'browser_screenshot', 'browser_navigate', 'browser_wait',
  'browser_click', 'browser_type', 'browser_select', 'browser_upload',
  'browser_press', 'browser_scroll', 'browser_drag', 'workflow_load',
]);

/** Zod shape for Target, shared by every action tool. */
const target = {
  intent: z.string().describe('Human-readable description of the element. Always required.'),
  hint: z.string().optional().describe('Durable ARIA locator, e.g. role=button[name="Apply"]'),
  ref: z.string().optional().describe('Ephemeral ref from the current snapshot, e.g. e12'),
  learned_hint: z.string().optional()
    .describe('Corrected locator after a hint_miss; persisted to the workflow file'),
};

const asTarget = (a: Record<string, unknown>): Target => ({
  intent: a['intent'] as string,
  hint: a['hint'] as string | undefined,
  ref: a['ref'] as string | undefined,
  learned_hint: a['learned_hint'] as string | undefined,
});

/** A bare success stays one token: terseness is what makes a warm run cheap. */
export function renderResult(r: ActionResult): string {
  if (r.ok) return r.diff ? `ok\nchanged:\n${r.diff}` : 'ok';
  if ('hint_miss' in r) return `hint_miss (scope: ${r.scope})\n${r.snapshot}`;
  if ('needs_confirm' in r) return `needs_confirm: ${r.description}\nscreenshot: ${r.screenshot}`;
  return `blocked: ${r.reason}\nscreenshot: ${r.screenshot}`;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Host a `match` pattern is anchored to, so a by-name load still gets its limit. */
const matchDomain = (match: string): string =>
  match.trim().replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? '';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const emit = (tool: string, s: string) => {
    ctx.ledger.record(tool, s);
    return text(s);
  };
  const act = (tool: string, p: Promise<ActionResult>) =>
    p.then((r) => emit(tool, renderResult(r)));

  server.registerTool('browser_snapshot', {
    description:
      'Read the page as an ARIA tree. level=outline for orientation, full for recovery after a hint_miss. ' +
      'level=raw returns HTML and REQUIRES a narrow scope — whole-page source is unavailable by design.',
    inputSchema: {
      level: z.enum(['outline', 'full', 'raw']).default('outline'),
      scope: z.string().optional()
        .describe('Locator narrowing the snapshot, e.g. role=main or css=#application. Strongly preferred.'),
    },
  }, async ({ level, scope }) =>
    emit('browser_snapshot', await ctx.actions.snapshot(level as Level, scope)));

  server.registerTool('browser_screenshot', {
    description: 'Capture a PNG. Returns a filesystem path, never image bytes.',
    inputSchema: {
      scope: z.string().optional().describe('Locator, e.g. css=#application'),
      full_page: z.boolean().optional(),
    },
  }, async ({ scope, full_page }) =>
    emit('browser_screenshot', await ctx.actions.screenshot(scope, full_page)));

  server.registerTool('browser_navigate', {
    description: 'Navigate to a URL. Invalidates all refs.',
    inputSchema: { url: z.string().url() },
  }, async ({ url }) => {
    try {
      ctx.limiter.check(url);
    } catch (e) {
      if (e instanceof RateLimitError) return emit('browser_navigate', `blocked: ${e.message}`);
      throw e;
    }
    ctx.limiter.record(url);
    return act('browser_navigate', ctx.actions.navigate(url));
  });

  server.registerTool('browser_wait', {
    description: 'Wait for load, idle, a duration in ms, text, or a locator.',
    inputSchema: {
      for: z.string().describe('load | idle | 500ms | text:Applied | role=button[name="Next"]'),
    },
  }, async (a) => act('browser_wait', ctx.actions.wait(a.for)));

  server.registerTool('browser_click', {
    description:
      'Click an element. Submit-like elements are refused unless confirm:true — this is default-on and deliberate.',
    inputSchema: { ...target, confirm: z.boolean().optional() },
  }, async (a) => act('browser_click', ctx.actions.click(asTarget(a), a.confirm)));

  server.registerTool('browser_type', {
    description: 'Clear a field and type into it, at human pace.',
    inputSchema: { ...target, text: z.string() },
  }, async (a) => act('browser_type', ctx.actions.type(asTarget(a), a.text)));

  server.registerTool('browser_select', {
    description: 'Choose one or more options in a select element.',
    inputSchema: { ...target, values: z.array(z.string()).min(1) },
  }, async (a) => act('browser_select', ctx.actions.select(asTarget(a), a.values)));

  server.registerTool('browser_upload', {
    description: 'Attach local files to a file input. Fires a trusted change event.',
    inputSchema: { ...target, paths: z.array(z.string()).min(1).describe('Absolute filesystem paths') },
  }, async (a) => act('browser_upload', ctx.actions.upload(asTarget(a), a.paths)));

  server.registerTool('browser_press', {
    description: 'Press a key or chord, e.g. Enter or Control+A.',
    inputSchema: { keys: z.string() },
  }, async ({ keys }) => act('browser_press', ctx.actions.press(keys)));

  server.registerTool('browser_scroll', {
    description: 'Scroll the page, or a specific element when a target is given.',
    inputSchema: {
      dir: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().positive().default(600),
      intent: z.string().optional(), hint: z.string().optional(), ref: z.string().optional(),
    },
  }, async (a) =>
    act('browser_scroll', ctx.actions.scroll(a.dir, a.amount, a.intent ? asTarget(a) : undefined)));

  server.registerTool('browser_drag', {
    description: 'Drag one element onto another.',
    inputSchema: {
      from_intent: z.string(), from_hint: z.string().optional(), from_ref: z.string().optional(),
      to_intent: z.string(), to_hint: z.string().optional(), to_ref: z.string().optional(),
    },
  }, async (a) => act('browser_drag', ctx.actions.drag(
    { intent: a.from_intent, hint: a.from_hint, ref: a.from_ref },
    { intent: a.to_intent, hint: a.to_hint, ref: a.to_ref },
  )));

  server.registerTool('workflow_load', {
    description:
      'Load the workflow matching a URL, or one by name. Returns intent, steps and cached hints. ' +
      'Call this BEFORE acting on a known site — it is what makes a warm run cheap.',
    inputSchema: { url: z.string().optional(), name: z.string().optional() },
  }, async ({ url, name }) => {
    const all = await loadWorkflows(ctx.workflowsDir);
    const wf = name ? findWorkflowByName(all, name) : url ? matchWorkflow(all, url) : null;
    if (!wf) return emit('workflow_load', 'no matching workflow');
    ctx.limiter.configure(
      url ? domainOf(url) : matchDomain(wf.frontmatter.match),
      wf.frontmatter.rate_limit,
    );
    return emit('workflow_load', JSON.stringify(toLoadedWorkflow(wf), null, 2));
  });
}
