import type { ActionResult, DriverRequest, Target } from '../protocol.js';
import type { Driver } from '../driver/types.js';
import type { HintResolver, Resolution } from '../hints/resolve.js';
import { serializeAria } from '../snapshot/aria.js';
import { diffSnapshots } from '../snapshot/diff.js';

export interface ActionDeps {
  driver: Driver;
  resolver: HintResolver;
  confirmSubmit: boolean;
  pace?: (kind: string) => Promise<void>;
}

export class Actions {
  #d: ActionDeps;
  constructor(deps: ActionDeps) { this.#d = deps; }

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

  click(t: Target, confirm?: boolean): Promise<ActionResult> {
    return this.#act(t, (ref) => ({ kind: 'click', ref }), { confirm, kind: 'click' });
  }
}
