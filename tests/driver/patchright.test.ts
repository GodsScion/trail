import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPatchrightDriver } from '../../src/driver/patchright.js';
import type { Driver } from '../../src/driver/types.js';
import type { AriaNode } from '../../src/protocol.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

const RUN = process.env.TRAIL_E2E === '1';
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

function flatten(node: AriaNode): AriaNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

describe.skipIf(!RUN)('patchright driver', () => {
  let driver: Driver;
  let server: { url: string; close: () => Promise<void> };
  let shotDir: string;

  beforeAll(async () => {
    server = await startFixtureServer(FIXTURES);
    const base = await mkdtemp(join(tmpdir(), 'trail-e2e-'));
    shotDir = join(base, 'shots');
    driver = await launchPatchrightDriver({
      userDataDir: join(base, 'profile'),
      screenshotDir: shotDir,
    });
    const nav = await driver.send({ kind: 'navigate', url: `${server.url}/form.html` });
    expect(nav).toEqual({ kind: 'ok' });
  });

  afterAll(async () => {
    await driver?.close();
    await server?.close();
  });

  it('builds an ARIA tree with refs on interactive nodes only', async () => {
    const res = await driver.send({ kind: 'aria_tree' });
    if (res.kind !== 'aria_tree') throw new Error(`expected aria_tree, got ${res.kind}`);
    const nodes = flatten(res.root);
    const button = nodes.find((n) => n.role === 'button' && n.name === 'Submit Application');
    expect(button?.ref).toMatch(/^e\d+$/);
    const heading = nodes.find((n) => n.role === 'heading' && n.name === 'Senior Engineer');
    expect(heading?.ref).toBeNull();
    expect(heading?.level).toBe(1);
    const first = nodes.find((n) => n.role === 'textbox' && n.name === 'First Name');
    expect(first?.ref).toMatch(/^e\d+$/);
    expect(res.url).toBe(`${server.url}/form.html`);
  });

  // Ref churn regression: the store persists across walks so indices are never
  // recycled, but it must also be an identity map — the same element has to keep
  // the same ref, or every post-action diff reproduces the whole page.
  it('keeps refs stable across two consecutive aria_tree calls on an unchanged page', async () => {
    const refsOf = async (): Promise<Array<[string, string]>> => {
      const res = await driver.send({ kind: 'aria_tree' });
      if (res.kind !== 'aria_tree') throw new Error(`expected aria_tree, got ${res.kind}`);
      return flatten(res.root)
        .filter((n) => n.ref !== null)
        .map((n) => [`${n.role}:${n.name}`, n.ref!] as [string, string]);
    };

    const first = await refsOf();
    expect(first.length).toBeGreaterThan(0);
    expect(await refsOf()).toEqual(first);
  });

  it('omits hidden and aria-hidden content', async () => {
    const res = await driver.send({ kind: 'aria_tree' });
    if (res.kind !== 'aria_tree') throw new Error('expected aria_tree');
    const text = flatten(res.root).map((n) => `${n.name} ${n.text ?? ''}`).join(' ');
    expect(text).not.toContain('Hidden paragraph');
    expect(text).not.toContain('Decorative');
  });

  it('emits a css fallback for a node with no accessible name', async () => {
    const res = await driver.send({ kind: 'aria_tree' });
    if (res.kind !== 'aria_tree') throw new Error('expected aria_tree');
    const canvas = flatten(res.root).find((n) => n.css?.includes('#board'));
    expect(canvas).toBeDefined();
    expect(canvas?.name).toBe('');
  });

  it('queries by ARIA locator and returns role and name with each ref', async () => {
    const res = await driver.send({ kind: 'query', locator: 'role=button[name="Submit Application"]' });
    if (res.kind !== 'query') throw new Error(`expected query, got ${res.kind}`);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.ref).toMatch(/^q\d+$/);
    expect(res.matches[0]!.role).toBe('button');
    expect(res.matches[0]!.name).toBe('Submit Application');
  });

  it('returns zero matches for a locator that does not exist', async () => {
    const res = await driver.send({ kind: 'query', locator: 'role=button[name="Nope"]' });
    if (res.kind !== 'query') throw new Error('expected query');
    expect(res.matches).toEqual([]);
  });

  it('types into a ref with a per-character delay and clicks', async () => {
    const q = await driver.send({ kind: 'query', locator: 'role=textbox[name="First Name"]' });
    if (q.kind !== 'query') throw new Error('expected query');
    expect(await driver.send({ kind: 'type', ref: q.matches[0]!.ref, text: 'Ada', delay_ms: 10 })).toEqual({ kind: 'ok' });

    const b = await driver.send({ kind: 'query', locator: 'role=button[name="Submit Application"]' });
    if (b.kind !== 'query') throw new Error('expected query');
    expect(await driver.send({ kind: 'click', ref: b.matches[0]!.ref })).toEqual({ kind: 'ok' });

    const after = await driver.send({ kind: 'aria_tree' });
    if (after.kind !== 'aria_tree') throw new Error('expected aria_tree');
    const text = flatten(after.root).map((n) => n.text ?? '').join(' ');
    expect(text).toContain('Application received');
  });

  it('selects an option by value', async () => {
    const q = await driver.send({ kind: 'query', locator: 'role=combobox[name="How did you hear about us?"]' });
    if (q.kind !== 'query') throw new Error('expected query');
    expect(await driver.send({ kind: 'select', ref: q.matches[0]!.ref, values: ['friend'] })).toEqual({ kind: 'ok' });
  });

  it('uploads a file through a native file input', async () => {
    const q = await driver.send({ kind: 'query', locator: 'css=#resume' });
    if (q.kind !== 'query') throw new Error('expected query');
    const path = join(FIXTURES, 'form.html');
    expect(await driver.send({ kind: 'upload', ref: q.matches[0]!.ref, paths: [path] })).toEqual({ kind: 'ok' });
  });

  it('scopes raw html and refuses a whole-page scope', async () => {
    const ok = await driver.send({ kind: 'raw_html', scope: 'css=#application' });
    if (ok.kind !== 'raw_html') throw new Error(`expected raw_html, got ${ok.kind}`);
    expect(ok.html).toContain('id="application"');
    expect(ok.html).not.toContain('<title>');

    const bad = await driver.send({ kind: 'raw_html', scope: 'css=body' });
    expect(bad).toMatchObject({ kind: 'error', code: 'invalid_scope' });
  });

  it('writes a screenshot to disk and returns its path', async () => {
    const res = await driver.send({ kind: 'screenshot', scope: 'css=#application' });
    if (res.kind !== 'screenshot') throw new Error(`expected screenshot, got ${res.kind}`);
    expect(res.path.startsWith(shotDir)).toBe(true);
    const bytes = await readFile(res.path);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('reports current url and honours wait specs', async () => {
    expect(await driver.send({ kind: 'wait', spec: { kind: 'ms', ms: 20 } })).toEqual({ kind: 'ok' });
    expect(await driver.send({ kind: 'wait', spec: { kind: 'text', text: 'Senior Engineer' } })).toEqual({ kind: 'ok' });
    const url = await driver.send({ kind: 'current_url' });
    expect(url).toEqual({ kind: 'current_url', url: `${server.url}/form.html` });
  });

  it('returns a structured error for an unknown ref', async () => {
    const res = await driver.send({ kind: 'click', ref: 'e9999' });
    expect(res).toMatchObject({ kind: 'error', code: 'not_found' });
  });

  // Stealth regression: vanilla Playwright reports navigator.webdriver === true.
  // The fixture stamps the live value into a hidden node so it is readable
  // through the protocol without an eval escape hatch on Driver.
  it('keeps patchright stealth active: navigator.webdriver is false', async () => {
    const res = await driver.send({ kind: 'raw_html', scope: 'css=#webdriver' });
    if (res.kind !== 'raw_html') throw new Error(`expected raw_html, got ${res.kind}`);
    expect(res.html).toContain('>false<');
  });
});
