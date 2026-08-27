import type { ActionResult, DriverRequest, Level, ScrollDir, Target } from '../protocol.js';
import { parseWaitSpec } from '../protocol.js';
import type { Driver } from '../driver/types.js';
import type { HintResolver, Resolution } from '../hints/resolve.js';
import { serializeAria, isWholePageScope } from '../snapshot/aria.js';
import { diffSnapshots } from '../snapshot/diff.js';

export interface ActionDeps {
  driver: Driver;
  resolver: HintResolver;
  confirmSubmit: boolean;
  pace?: (kind: string) => Promise<void>;
}

export const SUBMIT_ROLES: ReadonlySet<string> = new Set(['button', 'link']);
export const SUBMIT_NAME_RE =
  /\b(submit|apply|send|confirm|finish|complete|place order|sign up)\b/i;

export function isSubmitLike(role: string, name: string): boolean {
  return SUBMIT_ROLES.has(role) && SUBMIT_NAME_RE.test(name);
}

export class Actions {
  #d: ActionDeps;
  constructor(deps: ActionDeps) { this.#d = deps; }

  /**
   * Per-workflow opt-out, set by workflow_load from `confirm_submit`.
   * Default stays ON: a workflow must explicitly ask to disable the gate,
   * and an absent frontmatter key parses to true.
   */
  setConfirmSubmit(on: boolean): void { this.#d.confirmSubmit = on; }

  async #tree(scope?: string): Promise<string> {
    const res = await this.#d.driver.send({ kind: 'aria_tree', scope });
    if (res.kind !== 'aria_tree') return '';
    this.#d.resolver.indexRefs(res.root);
    return serializeAria(res.root, 'full');
  }

  /**
   * The single path every mutating action takes: resolve -> confirm gate ->
   * pace -> send -> diff. Written once on purpose.
   */
  async #act(
    t: Target,
    build: (ref: string) => DriverRequest,
    opts: { confirm?: boolean; kind: string },
  ): Promise<ActionResult> {
    const r: Resolution = await this.#d.resolver.resolve(t);
    if (r.kind === 'miss') {
      return { ok: false, hint_miss: true, snapshot: r.snapshot, scope: r.scope };
    }
    if (r.kind === 'error') return this.#blocked(r.message);

    if (this.#d.confirmSubmit && opts.confirm !== true && isSubmitLike(r.role, r.name)) {
      const shot = await this.#d.driver.send({ kind: 'screenshot' });
      return {
        ok: false,
        needs_confirm: true,
        description: `${r.role} "${r.name}" looks like a submit action. Re-call with confirm: true to proceed.`,
        screenshot: shot.kind === 'screenshot' ? shot.path : '',
      };
    }

    const before = await this.#tree();
    if (this.#d.pace) await this.#d.pace(opts.kind);

    const res = await this.#d.driver.send(build(r.ref));
    if (res.kind === 'error') return this.#blocked(res.message);

    const diff = diffSnapshots(before, await this.#tree());
    return diff ? { ok: true, diff } : { ok: true };
  }

  #blocked(reason: string): ActionResult {
    return { ok: false, blocked: true, reason, screenshot: '' };
  }

  async navigate(url: string): Promise<ActionResult> {
    const res = await this.#d.driver.send({ kind: 'navigate', url });
    if (res.kind === 'error') return this.#blocked(res.message);
    this.#d.resolver.invalidate();
    return { ok: true };
  }

  async wait(spec: string): Promise<ActionResult> {
    const res = await this.#d.driver.send({ kind: 'wait', spec: parseWaitSpec(spec) });
    return res.kind === 'error' ? this.#blocked(res.message) : { ok: true };
  }

  /** `raw` is scope-only. A whole-page scope is refused at this layer too. */
  async snapshot(level: Level, scope?: string): Promise<string> {
    if (level === 'raw') {
      if (!scope || isWholePageScope(scope)) {
        throw new Error('raw snapshots require a narrow scope; whole-page source is not available');
      }
      const res = await this.#d.driver.send({ kind: 'raw_html', scope });
      return res.kind === 'raw_html' ? res.html : '';
    }
    const res = await this.#d.driver.send({ kind: 'aria_tree', scope });
    if (res.kind !== 'aria_tree') return '';
    this.#d.resolver.indexRefs(res.root);
    return serializeAria(res.root, level);
  }

  async screenshot(scope?: string, fullPage?: boolean): Promise<string> {
    const res = await this.#d.driver.send({ kind: 'screenshot', scope, full_page: fullPage });
    return res.kind === 'screenshot' ? res.path : '';
  }

  click(t: Target, confirm?: boolean): Promise<ActionResult> {
    return this.#act(t, (ref) => ({ kind: 'click', ref }), { confirm, kind: 'click' });
  }

  type(t: Target, text: string): Promise<ActionResult> {
    return this.#act(t, (ref) => ({ kind: 'type', ref, text, clear: true }), { kind: 'type' });
  }

  select(t: Target, values: string[]): Promise<ActionResult> {
    return this.#act(t, (ref) => ({ kind: 'select', ref, values }), { kind: 'select' });
  }

  upload(t: Target, paths: string[]): Promise<ActionResult> {
    return this.#act(t, (ref) => ({ kind: 'upload', ref, paths }), { kind: 'upload' });
  }

  async press(keys: string): Promise<ActionResult> {
    if (this.#d.pace) await this.#d.pace('press');
    const res = await this.#d.driver.send({ kind: 'press', keys });
    return res.kind === 'error' ? this.#blocked(res.message) : { ok: true };
  }

  async scroll(dir: ScrollDir, amount: number, t?: Target): Promise<ActionResult> {
    if (!t) {
      const res = await this.#d.driver.send({ kind: 'scroll', dir, amount });
      return res.kind === 'error' ? this.#blocked(res.message) : { ok: true };
    }
    return this.#act(t, (ref) => ({ kind: 'scroll', ref, dir, amount }), { kind: 'scroll' });
  }

  async drag(from: Target, to: Target): Promise<ActionResult> {
    const a = await this.#d.resolver.resolve(from);
    if (a.kind === 'miss') return { ok: false, hint_miss: true, snapshot: a.snapshot, scope: a.scope };
    if (a.kind === 'error') return this.#blocked(a.message);
    const b = await this.#d.resolver.resolve(to);
    if (b.kind === 'miss') return { ok: false, hint_miss: true, snapshot: b.snapshot, scope: b.scope };
    if (b.kind === 'error') return this.#blocked(b.message);

    if (this.#d.pace) await this.#d.pace('drag');
    const res = await this.#d.driver.send({ kind: 'drag', from_ref: a.ref, to_ref: b.ref });
    return res.kind === 'error' ? this.#blocked(res.message) : { ok: true };
  }
}
