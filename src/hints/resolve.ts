import type { Driver } from '../driver/types.js';
import {
  parseLocator,
  type AriaNode,
  type DriverErrorCode,
  type RefInfo,
  type Target,
} from '../protocol.js';
import { serializeAria } from '../snapshot/aria.js';

export type Resolution =
  | { kind: 'resolved'; ref: string; role: string; name: string; persisted: boolean }
  | { kind: 'miss'; snapshot: string; scope: string }
  | { kind: 'error'; code: DriverErrorCode; message: string };

export interface HintResolverDeps {
  driver: Driver;
  /** Writes the agent's correction back to the workflow file. Returns whether it stuck. */
  persist: (req: { intent: string; oldHint: string | null; newHint: string }) => Promise<boolean>;
  /** Level used for the miss snapshot. `full` is the default recovery level. */
  missLevel?: 'outline' | 'full';
}

/**
 * Scope matters more than the level does — snapshotting one form beats any
 * verbosity tier on the full page. Tried in order until one resolves.
 */
export const MISS_SCOPE_ORDER: readonly string[] = ['role=main', 'role=form', 'css=body'];

export class HintResolver {
  private refInfo = new Map<string, RefInfo>();

  constructor(private readonly deps: HintResolverDeps) {}

  describeRef(ref: string): RefInfo | null {
    return this.refInfo.get(ref) ?? null;
  }

  indexRefs(root: AriaNode): void {
    const walk = (node: AriaNode): void => {
      if (node.ref) this.refInfo.set(node.ref, { ref: node.ref, role: node.role, name: node.name });
      for (const child of node.children) walk(child);
    };
    walk(root);
  }

  invalidate(): void {
    this.refInfo.clear();
  }

  /**
   * The hot path. A hit costs exactly one `query` and never touches the page:
   * that single property is what makes a warm run cheap.
   */
  async resolve(target: Target, scope?: string): Promise<Resolution> {
    let persisted = false;
    if (target.learned_hint) {
      persisted = await this.deps.persist({
        intent: target.intent,
        oldHint: target.hint ?? null,
        newHint: target.learned_hint,
      });
    }

    if (target.ref) {
      const info = this.refInfo.get(target.ref);
      return {
        kind: 'resolved',
        ref: target.ref,
        role: info?.role ?? '',
        name: info?.name ?? target.intent,
        persisted,
      };
    }

    const locator = target.learned_hint ?? target.hint;
    if (locator && this.isParseable(locator)) {
      const res = await this.deps.driver.send({ kind: 'query', locator });
      if (res.kind === 'query' && res.matches.length > 0) {
        const match = res.matches[0]!;
        this.refInfo.set(match.ref, match);
        return { kind: 'resolved', ref: match.ref, role: match.role, name: match.name, persisted };
      }
      if (res.kind === 'error' && res.code !== 'not_found') {
        return { kind: 'error', code: res.code, message: res.message };
      }
    }

    return this.missSnapshot(scope);
  }

  /**
   * A malformed hint is drift, not a crash. An unparseable locator falls through
   * to the miss path so the agent can look at the page and write a correct one.
   */
  private isParseable(locator: string): boolean {
    try {
      parseLocator(locator);
      return true;
    } catch {
      return false;
    }
  }

  private async missSnapshot(explicitScope?: string): Promise<Resolution> {
    const scopes = explicitScope ? [explicitScope] : MISS_SCOPE_ORDER;
    let lastError: { code: DriverErrorCode; message: string } | null = null;
    for (const scope of scopes) {
      const res = await this.deps.driver.send({ kind: 'aria_tree', scope });
      if (res.kind === 'aria_tree') {
        this.indexRefs(res.root);
        return {
          kind: 'miss',
          snapshot: serializeAria(res.root, this.deps.missLevel ?? 'full'),
          scope,
        };
      }
      if (res.kind === 'error') lastError = { code: res.code, message: res.message };
    }
    return lastError
      ? { kind: 'error', ...lastError }
      : { kind: 'error', code: 'internal', message: 'no scope produced a snapshot' };
  }
}
