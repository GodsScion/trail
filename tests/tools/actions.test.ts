import { describe, it, expect } from 'vitest';
import { Actions } from '../../src/tools/actions.js';
import { HintResolver } from '../../src/hints/resolve.js';
import { FakeDriver, ariaNode, type FakeHandlers } from '../helpers/fake-driver.js';

/** Resolves any hint to a single textbox — the boring, ungated element. */
const textbox: FakeHandlers = {
  query: () => ({
    kind: 'query',
    matches: [{ ref: 'q1', role: 'textbox', name: 'First Name' }],
    generation: 1,
  }),
};

function mk(
  handlers: FakeHandlers = {},
  confirmSubmit = true,
  pace?: (kind: string) => Promise<void>,
) {
  const driver = new FakeDriver({
    aria_tree: () => ({
      kind: 'aria_tree',
      root: { ref: 'e1', role: 'button', name: 'Apply', children: [] },
      generation: 1,
      url: 'https://x.test/',
    }),
    query: () => ({ kind: 'query', matches: [], generation: 1 }),
    click: () => ({ kind: 'ok' }),
    ...handlers,
  });
  const resolver = new HintResolver({ driver, persist: async () => true });
  return { driver, resolver, actions: new Actions({ driver, resolver, confirmSubmit, pace }) };
}

const name = { intent: 'name', hint: 'role=textbox[name="First Name"]' };

describe('Actions', () => {
  it('returns the hint_miss shape unchanged when the hint does not resolve', async () => {
    const { actions } = mk();
    const r = await actions.click({ intent: 'Apply', hint: 'role=button[name="Nope"]' });
    expect(r.ok).toBe(false);
    expect((r as any).hint_miss).toBe(true);
    expect(typeof (r as any).snapshot).toBe('string');
    expect(typeof (r as any).scope).toBe('string');
  });

  it('refuses a submit-like click until confirm:true is passed', async () => {
    const { actions } = mk({
      query: () => ({
        kind: 'query',
        matches: [{ ref: 'q1', role: 'button', name: 'Submit application' }],
        generation: 1,
      }),
      screenshot: () => ({ kind: 'screenshot', path: '/tmp/s.png' }),
    });
    const t = { intent: 'Submit', hint: 'role=button[name="Submit application"]' };

    const gated = await actions.click(t);
    expect((gated as any).needs_confirm).toBe(true);
    expect((gated as any).screenshot).toBe('/tmp/s.png');

    const done = await actions.click(t, true);
    expect(done.ok).toBe(true);
  });

  it('does not gate a non-submit click', async () => {
    const { actions } = mk({
      query: () => ({
        kind: 'query',
        matches: [{ ref: 'q1', role: 'textbox', name: 'First Name' }],
        generation: 1,
      }),
    });
    const r = await actions.click({ intent: 'name', hint: 'role=textbox[name="First Name"]' });
    expect(r.ok).toBe(true);
  });

  it('does not gate a submit-like click when confirmSubmit is off', async () => {
    const { actions } = mk({
      query: () => ({
        kind: 'query',
        matches: [{ ref: 'q1', role: 'button', name: 'Submit application' }],
        generation: 1,
      }),
    }, false);
    const r = await actions.click({ intent: 'Submit', hint: 'role=button[name="Submit application"]' });
    expect(r.ok).toBe(true);
  });

  it('refuses a raw snapshot without a narrow scope', async () => {
    const { driver, actions } = mk();
    await expect(actions.snapshot('raw')).rejects.toThrow(/narrow scope/);
    await expect(actions.snapshot('raw', 'css=body')).rejects.toThrow(/narrow scope/);
    await expect(actions.snapshot('raw', 'css=html')).rejects.toThrow(/narrow scope/);
    // A scope that is not a locator at all is refused too, never silently widened.
    await expect(actions.snapshot('raw', 'body')).rejects.toThrow();
    expect(driver.kinds()).not.toContain('raw_html');
  });

  it('allows a raw snapshot of a narrow scope', async () => {
    const { actions } = mk({ raw_html: () => ({ kind: 'raw_html', html: '<form></form>' }) });
    await expect(actions.snapshot('raw', 'css=#application')).resolves.toBe('<form></form>');
  });

  it('invalidates the ref index on navigate', async () => {
    const { resolver, actions } = mk();
    await actions.snapshot('full');
    expect(resolver.describeRef('e1')).not.toBeNull();

    const r = await actions.navigate('https://x.test/jobs');
    expect(r.ok).toBe(true);
    expect(resolver.describeRef('e1')).toBeNull();
  });

  it('maps a driver error to the blocked shape', async () => {
    const { actions } = mk({
      navigate: () => ({ kind: 'error', code: 'navigation_failed', message: 'dns failed' }),
    });
    const r = await actions.navigate('https://nope.test/');
    expect(r).toEqual({ ok: false, blocked: true, reason: 'dns failed', screenshot: '' });
  });

  it('parses the wait spec before it reaches the driver', async () => {
    const { driver, actions } = mk();
    const r = await actions.wait('500ms');
    expect(r.ok).toBe(true);
    expect(driver.sent).toContainEqual({ kind: 'wait', spec: { kind: 'ms', ms: 500 } });
  });

  it('returns the screenshot path, never the bytes', async () => {
    const { actions } = mk({ screenshot: () => ({ kind: 'screenshot', path: '/tmp/a.png' }) });
    await expect(actions.screenshot('role=form', true)).resolves.toBe('/tmp/a.png');
  });

  it('types into the resolved ref, clearing it first', async () => {
    const { driver, actions } = mk(textbox);
    const r = await actions.type(name, 'Ada');
    expect(r.ok).toBe(true);
    expect(driver.sent).toContainEqual({ kind: 'type', ref: 'q1', text: 'Ada', clear: true });
  });

  it('selects the given values on the resolved ref', async () => {
    const { driver, actions } = mk(textbox);
    const r = await actions.select(name, ['US']);
    expect(r.ok).toBe(true);
    expect(driver.sent).toContainEqual({ kind: 'select', ref: 'q1', values: ['US'] });
  });

  it('uploads the given paths to the resolved ref', async () => {
    const { driver, actions } = mk(textbox);
    const r = await actions.upload(name, ['/tmp/cv.pdf']);
    expect(r.ok).toBe(true);
    expect(driver.sent).toContainEqual({ kind: 'upload', ref: 'q1', paths: ['/tmp/cv.pdf'] });
  });

  it('presses keys without resolving a target', async () => {
    const { driver, actions } = mk();
    const r = await actions.press('Enter');
    expect(r.ok).toBe(true);
    expect(driver.kinds()).toEqual(['press']);
  });

  it('scrolls the page when no target is given', async () => {
    const { driver, actions } = mk();
    const r = await actions.scroll('down', 3);
    expect(r.ok).toBe(true);
    expect(driver.kinds()).toEqual(['scroll']);
    expect(driver.sent).toContainEqual({ kind: 'scroll', dir: 'down', amount: 3 });
  });

  it('scrolls the resolved element when a target is given', async () => {
    const { driver, actions } = mk(textbox);
    const r = await actions.scroll('down', 1, name);
    expect(r.ok).toBe(true);
    expect(driver.sent).toContainEqual({ kind: 'scroll', ref: 'q1', dir: 'down', amount: 1 });
  });

  it('drags between two resolved refs', async () => {
    const { driver, actions } = mk({
      query: (req) => ({
        kind: 'query',
        matches: [{ ref: req.locator.includes('Handle') ? 'q1' : 'q2', role: 'listitem', name: 'x' }],
        generation: 1,
      }),
    });
    const r = await actions.drag(
      { intent: 'handle', hint: 'role=listitem[name="Handle"]' },
      { intent: 'slot', hint: 'role=listitem[name="Slot"]' },
    );
    expect(r.ok).toBe(true);
    expect(driver.sent).toContainEqual({ kind: 'drag', from_ref: 'q1', to_ref: 'q2' });
  });

  it('propagates a hint_miss from the second end of a drag', async () => {
    const { driver, actions } = mk({
      query: (req) => (req.locator.includes('Handle')
        ? { kind: 'query', matches: [{ ref: 'q1', role: 'listitem', name: 'x' }], generation: 1 }
        : { kind: 'query', matches: [], generation: 1 }),
    });
    const r = await actions.drag(
      { intent: 'handle', hint: 'role=listitem[name="Handle"]' },
      { intent: 'slot', hint: 'role=listitem[name="Slot"]' },
    );
    expect((r as any).hint_miss).toBe(true);
    expect(driver.kinds()).not.toContain('drag');
  });

  it('paces a mutating action before it reaches the driver', async () => {
    const order: string[] = [];
    const { actions } = mk(
      { ...textbox, click: () => { order.push('click'); return { kind: 'ok' }; } },
      true,
      async (kind) => { order.push(`pace:${kind}`); },
    );
    await actions.click(name);
    expect(order).toEqual(['pace:click', 'click']);
  });

  it('returns a diff of what the action changed', async () => {
    let calls = 0;
    const { actions } = mk({
      ...textbox,
      aria_tree: () => {
        calls += 1;
        return {
          kind: 'aria_tree',
          root: ariaNode({
            role: 'form',
            children: [
              ariaNode({
                ref: 'e1',
                role: 'textbox',
                name: 'First Name',
                value: calls > 1 ? 'Ada' : '',
              }),
            ],
          }),
          generation: 1,
          url: 'https://x.test/',
        };
      },
    });
    const r = await actions.type(name, 'Ada');
    expect(r.ok).toBe(true);
    expect((r as any).diff).toContain('value="Ada"');
  });
});

describe('setConfirmSubmit — per-workflow opt-out', () => {
  /** Resolves any hint to a submit-like button, i.e. the gated element. */
  const submitBtn: FakeHandlers = {
    query: () => ({
      kind: 'query',
      matches: [{ ref: 'q1', role: 'button', name: 'Submit application' }],
      generation: 1,
    }),
    screenshot: () => ({ kind: 'screenshot', path: '/tmp/s.png' }),
  };
  const submit = { intent: 'Submit', hint: 'role=button[name="Submit application"]' };

  it('gates by default, and a workflow can turn the gate off', async () => {
    const { actions } = mk(submitBtn);

    const gated = await actions.click(submit);
    expect((gated as { needs_confirm?: true }).needs_confirm).toBe(true);

    // What workflow_load does when frontmatter says `confirm_submit: false`.
    actions.setConfirmSubmit(false);
    const ungated = await actions.click(submit);
    expect(ungated.ok).toBe(true);
  });

  it('can turn the gate back on, so one workflow cannot disarm the next', async () => {
    const { actions } = mk(submitBtn, false);
    expect((await actions.click(submit)).ok).toBe(true);

    actions.setConfirmSubmit(true);
    const gated = await actions.click(submit);
    expect((gated as { needs_confirm?: true }).needs_confirm).toBe(true);
  });
});
