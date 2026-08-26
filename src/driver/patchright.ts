import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { BrowserContext, ElementHandle, Locator, Page } from 'patchright';
import {
  parseLocator,
  ProtocolError,
  type AriaNode,
  type DriverErrorCode,
  type DriverRequest,
  type DriverResponse,
  type ParsedLocator,
  type RefInfo,
  type ScrollDir,
  type WaitSpec,
} from '../protocol.js';
import type { Driver, DriverLaunchOptions } from './types.js';

interface WalkResult {
  root: AriaNode;
  count: number;
}

/**
 * Serialized into the page. Must be entirely self-contained — it cannot close
 * over anything in module scope.
 */
function ariaWalker(args: { key: string; root: Node | null }): WalkResult {
  const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox',
    'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'tab', 'treeitem',
  ]);
  const NO_RECURSE = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
    'textbox', 'searchbox', 'option', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'tab', 'treeitem', 'heading', 'img',
  ]);
  const INPUT_ROLES: Record<string, string> = {
    '': 'textbox', text: 'textbox', email: 'textbox', tel: 'textbox',
    url: 'textbox', password: 'textbox', search: 'searchbox',
    number: 'spinbutton', range: 'slider', checkbox: 'checkbox',
    radio: 'radio', submit: 'button', button: 'button', reset: 'button',
    image: 'button', file: 'button',
  };

  // The store SURVIVES repeated walks within a page load and is wiped by
  // navigation. Within a page load it is an IDENTITY MAP: an element already in
  // the store keeps the index it was first given, so walking an unchanged page
  // twice yields identical refs and a post-action diff shows only what really
  // changed. An element not yet seen always gets a fresh index — indices are
  // allocated monotonically and never recycled — so a stale ref still fails
  // loudly with `detached` instead of silently hitting a different element.
  const w = window as unknown as Record<string, unknown>;
  const store: Element[] = (w[args.key] as Element[] | undefined) ?? [];
  w[args.key] = store;
  const indexOfEl: Map<Element, number> =
    (w[`${args.key}_ix`] as Map<Element, number> | undefined) ?? new Map<Element, number>();
  w[`${args.key}_ix`] = indexOfEl;

  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit && explicit.trim()) return norm(explicit).split(' ')[0]!;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type.toLowerCase();
      return INPUT_ROLES[type] ?? 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': return 'button';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return 'form';
      case 'search': return 'search';
      case 'dialog': return 'dialog';
      case 'iframe': return 'iframe';
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'select':
        return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1
          ? 'listbox' : 'combobox';
      case 'img': return el.getAttribute('alt') === '' ? '' : 'img';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      // Escape-hatch targets: no accessible name, so `css` is always emitted and
      // the agent reaches them with a `css=` hint or a scoped `raw` snapshot.
      case 'canvas': case 'svg': case 'video': case 'audio':
      case 'embed': case 'object': return 'graphic';
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      default: return '';
    }
  }

  function accName(el: Element): string {
    const label = el.getAttribute('aria-label');
    if (label && norm(label)) return clip(norm(label));
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const joined = by.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (norm(joined)) return clip(norm(joined));
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const control = el as HTMLInputElement;
      const labels = control.labels;
      if (labels && labels.length > 0) {
        const t = norm(Array.from(labels).map((l) => l.textContent ?? '').join(' '));
        if (t) return clip(t);
      }
      const ph = el.getAttribute('placeholder');
      if (ph && norm(ph)) return clip(norm(ph));
      const title = el.getAttribute('title');
      if (title && norm(title)) return clip(norm(title));
      const type = tag === 'input' ? control.type.toLowerCase() : '';
      if (type === 'submit' || type === 'button' || type === 'reset') return clip(norm(control.value ?? ''));
      return '';
    }
    if (tag === 'img') return clip(norm(el.getAttribute('alt') ?? ''));
    if (tag === 'iframe') return clip(norm(el.getAttribute('title') ?? ''));
    // textContent would drag hidden and aria-hidden descendants into the name
    // of every ancestor, so name-from-contents must skip hidden subtrees.
    return clip(norm(visibleText(el)));
  }

  function visibleText(el: Element): string {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.textContent ?? '';
      else if (child.nodeType === 1 && !isHidden(child as Element)) out += visibleText(child as Element);
    }
    return out;
  }

  function isHidden(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if ((el as HTMLElement).hasAttribute('hidden')) return true;
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return true;
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  }

  function cssPath(el: Element): string {
    const safeId = (e: Element): string | null => {
      const id = e.getAttribute('id');
      return id && /^[A-Za-z][\w-]*$/.test(id) ? id : null;
    };
    const own = safeId(el);
    if (own) return `${el.tagName.toLowerCase()}#${own}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < 4; depth += 1) {
      const id = safeId(cur);
      if (id) { parts.unshift(`${cur.tagName.toLowerCase()}#${id}`); break; }
      let part = cur.tagName.toLowerCase();
      const nameAttr = cur.getAttribute('name');
      if (nameAttr) {
        parts.unshift(`${part}[name="${nameAttr.replace(/"/g, '\\"')}"]`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function ownText(el: Element): string {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.textContent ?? '';
    }
    return clip(norm(out));
  }

  function build(el: Element): AriaNode | null {
    if (isHidden(el)) return null;
    let role = roleOf(el);
    const name = accName(el);
    const text = ownText(el);
    const interactive = INTERACTIVE.has(role);
    const emit = role !== '' || text !== '';
    if (role === '' && text !== '') role = 'text';

    const children: AriaNode[] = [];
    if (!NO_RECURSE.has(role)) {
      for (const child of Array.from(el.children)) {
        const built = build(child);
        if (built) children.push(built);
      }
    }
    if (!emit) {
      if (children.length === 0) return null;
      if (children.length === 1) return children[0]!;
      return { ref: null, role: 'group', name: '', children };
    }

    const node: AriaNode = { ref: null, role, name, children };
    if (interactive) {
      let index = indexOfEl.get(el);
      if (index === undefined) {
        index = store.push(el) - 1;
        indexOfEl.set(el, index);
      }
      node.ref = `e${index}`;
    }
    if (role === 'text' || (text !== '' && text !== name)) node.text = text;
    if (role === 'heading') node.level = Number(/^h([1-6])$/.exec(el.tagName.toLowerCase())?.[1] ?? el.getAttribute('aria-level') ?? 2);
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (input.value) node.value = clip(input.value);
      if (input.required) node.required = true;
      if (input.disabled) node.disabled = true;
      const ph = el.getAttribute('placeholder');
      if (ph) node.placeholder = clip(ph);
      if (input.type === 'checkbox' || input.type === 'radio') node.checked = input.checked;
    }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true' || expanded === 'false') node.expanded = expanded === 'true';
    const selected = el.getAttribute('aria-selected');
    if (selected === 'true') node.selected = true;
    if (name === '' || (tag === 'input' && input.type === 'file')) node.css = cssPath(el);
    return node;
  }

  // `root` is an ElementHandle on the way in; Patchright's Unboxed<> widens it
  // to Node, so narrow it back here.
  const start = (args.root as Element | null) ?? document.body;
  const built = build(start);
  const root: AriaNode = built ?? { ref: null, role: 'document', name: '', children: [] };
  return { root: { ...root, role: args.root ? root.role : 'document' }, count: store.length };
}

const WHOLE_PAGE_SELECTORS = new Set(['body', 'html', ':root', '*', 'document']);
const RAW_HTML_MAX = 20_000;

function err(code: DriverErrorCode, message: string): DriverResponse {
  return { kind: 'error', code, message };
}

class PatchrightDriver implements Driver {
  private queryHandles = new Map<string, ElementHandle<Node>>();
  private queryCounter = 0;
  private generation = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly refKey: string,
    private readonly screenshotDir: string,
    private readonly timeout: number,
  ) {
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) {
        this.generation += 1;
        this.queryHandles.clear();
      }
    });
  }

  private locator(spec: string, scope?: string): Locator {
    const parsed: ParsedLocator = parseLocator(spec);
    const base: Page | Locator = scope ? this.locator(scope).first() : this.page;
    if (parsed.kind === 'css') return base.locator(parsed.selector);
    const options: Record<string, unknown> = {};
    if (parsed.name !== undefined) {
      options['name'] = parsed.name;
      options['exact'] = parsed.exact;
    }
    for (const [k, v] of Object.entries(parsed.attrs)) {
      options[k] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (base as any).getByRole(parsed.role, options) as Locator;
  }

  private async resolveRef(ref: string): Promise<ElementHandle<Node> | null> {
    if (ref.startsWith('q')) return this.queryHandles.get(ref) ?? null;
    const m = /^e(\d+)$/.exec(ref);
    if (!m) return null;
    const index = Number(m[1]);
    const handle = await this.page.evaluateHandle(
      (a: { key: string; index: number }) =>
        ((window as unknown as Record<string, unknown>)[a.key] as Element[] | undefined)?.[a.index] ?? null,
      { key: this.refKey, index },
    );
    return handle.asElement();
  }

  private shotPath(): string {
    return join(this.screenshotDir, `shot-${Date.now()}-${randomBytes(3).toString('hex')}.png`);
  }

  private async waitFor(spec: WaitSpec, timeout: number): Promise<void> {
    switch (spec.kind) {
      case 'load': await this.page.waitForLoadState('load', { timeout }); return;
      case 'idle': await this.page.waitForLoadState('networkidle', { timeout }); return;
      case 'ms': await this.page.waitForTimeout(spec.ms); return;
      case 'text': await this.page.getByText(spec.text).first().waitFor({ state: 'visible', timeout }); return;
      case 'locator': await this.locator(spec.locator).first().waitFor({ state: 'visible', timeout }); return;
    }
  }

  private static delta(dir: ScrollDir, amount: number): [number, number] {
    switch (dir) {
      case 'up': return [0, -amount];
      case 'down': return [0, amount];
      case 'left': return [-amount, 0];
      case 'right': return [amount, 0];
    }
  }

  async send(req: DriverRequest): Promise<DriverResponse> {
    try {
      return await this.dispatch(req);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof ProtocolError) return err('invalid_scope', message);
      if (/Timeout .* exceeded|waiting for/i.test(message)) return err('timeout', message);
      if (/detached|not attached|Element is not attached/i.test(message)) return err('detached', message);
      return err('internal', message);
    }
  }

  private async dispatch(req: DriverRequest): Promise<DriverResponse> {
    switch (req.kind) {
      case 'navigate': {
        try {
          await this.page.goto(req.url, {
            waitUntil: 'domcontentloaded',
            timeout: req.timeout_ms ?? this.timeout,
          });
        } catch (e) {
          return err('navigation_failed', e instanceof Error ? e.message : String(e));
        }
        return { kind: 'ok' };
      }

      case 'current_url':
        return { kind: 'current_url', url: this.page.url() };

      case 'aria_tree': {
        let rootHandle: ElementHandle<Node> | null = null;
        if (req.scope) {
          rootHandle = await this.locator(req.scope).first().elementHandle({ timeout: this.timeout });
          if (!rootHandle) return err('not_found', `scope did not match: ${req.scope}`);
        }
        const result = await this.page.evaluate(ariaWalker, { key: this.refKey, root: rootHandle });
        return { kind: 'aria_tree', root: result.root, generation: this.generation, url: this.page.url() };
      }

      case 'raw_html': {
        const parsed = parseLocator(req.scope);
        if (parsed.kind === 'css' && WHOLE_PAGE_SELECTORS.has(parsed.selector.trim().toLowerCase())) {
          return err('invalid_scope', 'raw is scope-only: whole-page source cannot be requested');
        }
        const handle = await this.locator(req.scope).first().elementHandle({ timeout: this.timeout });
        if (!handle) return err('not_found', `scope did not match: ${req.scope}`);
        const tag = await handle.evaluate((el) => (el as Element).tagName);
        if (tag === 'HTML' || tag === 'BODY') {
          return err('invalid_scope', 'raw is scope-only: whole-page source cannot be requested');
        }
        const html = await handle.evaluate((el) => (el as Element).outerHTML);
        return {
          kind: 'raw_html',
          html: html.length > RAW_HTML_MAX
            ? `${html.slice(0, RAW_HTML_MAX)}\n<!-- truncated at ${RAW_HTML_MAX} chars: narrow the scope -->`
            : html,
        };
      }

      case 'query': {
        const handles = await this.locator(req.locator, req.scope).elementHandles();
        const matches: RefInfo[] = [];
        for (const handle of handles) {
          const probe = await this.page.evaluate(ariaWalker, { key: '__trail_probe', root: handle });
          const ref = `q${this.queryCounter++}`;
          this.queryHandles.set(ref, handle);
          matches.push({ ref, role: probe.root.role, name: probe.root.name });
        }
        return { kind: 'query', matches, generation: this.generation };
      }

      case 'screenshot': {
        await mkdir(this.screenshotDir, { recursive: true });
        const path = this.shotPath();
        if (req.scope) {
          const handle = await this.locator(req.scope).first().elementHandle({ timeout: this.timeout });
          if (!handle) return err('not_found', `scope did not match: ${req.scope}`);
          await handle.screenshot({ path });
        } else {
          await this.page.screenshot({ path, fullPage: req.full_page === true });
        }
        return { kind: 'screenshot', path };
      }

      case 'click': {
        const el = await this.resolveRef(req.ref);
        if (!el) return err('not_found', `unknown ref ${req.ref}`);
        await el.scrollIntoViewIfNeeded({ timeout: this.timeout });
        await el.click({ delay: req.delay_ms ?? 45, timeout: this.timeout });
        return { kind: 'ok' };
      }

      case 'type': {
        const el = await this.resolveRef(req.ref);
        if (!el) return err('not_found', `unknown ref ${req.ref}`);
        await el.scrollIntoViewIfNeeded({ timeout: this.timeout });
        if (req.clear !== false) await el.fill('', { timeout: this.timeout });
        await el.focus();
        await this.page.keyboard.type(req.text, { delay: req.delay_ms ?? 60 });
        return { kind: 'ok' };
      }

      case 'press':
        await this.page.keyboard.press(req.keys, { delay: req.delay_ms ?? 45 });
        return { kind: 'ok' };

      case 'select': {
        const el = await this.resolveRef(req.ref);
        if (!el) return err('not_found', `unknown ref ${req.ref}`);
        await el.selectOption(req.values, { timeout: this.timeout });
        return { kind: 'ok' };
      }

      case 'upload': {
        const el = await this.resolveRef(req.ref);
        if (!el) return err('not_found', `unknown ref ${req.ref}`);
        const isFileInput = await el.evaluate(
          (node) => node instanceof HTMLInputElement && node.type === 'file',
        );
        if (isFileInput) {
          await el.setInputFiles(req.paths, { timeout: this.timeout });
          return { kind: 'ok' };
        }
        // ATS boards usually hide the input behind a styled "Attach" button.
        const [chooser] = await Promise.all([
          this.page.waitForEvent('filechooser', { timeout: this.timeout }),
          el.click({ timeout: this.timeout }),
        ]);
        await chooser.setFiles(req.paths);
        return { kind: 'ok' };
      }

      case 'scroll': {
        const [dx, dy] = PatchrightDriver.delta(req.dir, req.amount);
        if (req.ref) {
          const el = await this.resolveRef(req.ref);
          if (!el) return err('not_found', `unknown ref ${req.ref}`);
          await el.scrollIntoViewIfNeeded({ timeout: this.timeout });
          await el.hover({ timeout: this.timeout });
        }
        await this.page.mouse.wheel(dx, dy);
        return { kind: 'ok' };
      }

      case 'drag': {
        const from = await this.resolveRef(req.from_ref);
        const to = await this.resolveRef(req.to_ref);
        if (!from) return err('not_found', `unknown ref ${req.from_ref}`);
        if (!to) return err('not_found', `unknown ref ${req.to_ref}`);
        const a = await from.boundingBox();
        const b = await to.boundingBox();
        if (!a || !b) return err('not_found', 'drag endpoints have no bounding box');
        const steps = req.steps ?? 12;
        await this.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await this.page.mouse.down();
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          await this.page.mouse.move(
            a.x + a.width / 2 + (b.x + b.width / 2 - (a.x + a.width / 2)) * t,
            a.y + a.height / 2 + (b.y + b.height / 2 - (a.y + a.height / 2)) * t,
          );
        }
        await this.page.mouse.up();
        return { kind: 'ok' };
      }

      case 'wait':
        await this.waitFor(req.spec, req.timeout_ms ?? this.timeout);
        return { kind: 'ok' };
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export async function launchPatchrightDriver(opts: DriverLaunchOptions): Promise<Driver> {
  if (opts.headless === true) {
    throw new ProtocolError('headless is a detection tell; the driver must run headful');
  }
  await mkdir(opts.userDataDir, { recursive: true });
  await mkdir(opts.screenshotDir, { recursive: true });
  const context = await chromium.launchPersistentContext(opts.userDataDir, {
    channel: opts.channel ?? 'chrome', // real installed Chrome, never bundled Chromium
    headless: false,
    viewport: null,
    // No stealth args: Patchright already patches navigator.webdriver and avoids
    // the Runtime.enable CDP leak. Extra args are their own fingerprint.
  });
  const timeout = opts.defaultTimeoutMs ?? 15_000;
  context.setDefaultTimeout(timeout);
  const page = context.pages()[0] ?? (await context.newPage());
  const refKey = `__trail_${randomBytes(6).toString('hex')}`;
  return new PatchrightDriver(context, page, refKey, opts.screenshotDir, timeout);
}
