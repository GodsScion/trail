/**
 * The four success criteria, measured against real Chrome. Criterion 2 is the
 * falsification test for the whole workflow layer: if a warm run does not come
 * in under 10% of a cold run, the design is not paying for its complexity and
 * the number stays where it is.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withSession } from './helpers.js';
import { renderResult } from '../../src/tools/index.js';

const WORKFLOW = `---
name: apply-greenhouse
match: "*/greenhouse.html"
requires: [profile, resume]
confirm_submit: true
---

## Intent
Apply to a Greenhouse job. Never submit without confirmation.

## Steps
1. Fill first name
   <!-- hint: role=textbox[name="First Name"] -->
2. Fill last name
   <!-- hint: role=textbox[name="Last Name"] -->
3. Submit
   <!-- hint: role=button[name="Submit application"] -->
`;

describe('criterion 1: fills the application and stops before submit', () => {
  it('fills fields, then refuses the submit until confirmed', { timeout: 180_000 }, async () => {
    await withSession(async (s) => {
      await s.actions.navigate(`${s.url}/greenhouse.html`);

      const fn = await s.actions.type(
        { intent: 'First name', hint: 'role=textbox[name="First Name"]' }, 'Ada');
      expect(fn.ok).toBe(true);

      const ln = await s.actions.type(
        { intent: 'Last name', hint: 'role=textbox[name="Last Name"]' }, 'Lovelace');
      expect(ln.ok).toBe(true);

      const cv = join(mkdtempSync(join(tmpdir(), 'cv-')), 'resume.pdf');
      writeFileSync(cv, '%PDF-1.4 test');
      const up = await s.actions.upload(
        { intent: 'Resume', hint: 'role=button[name="Resume"]' }, [cv]);
      expect(up.ok === true || (up as { hint_miss?: true }).hint_miss === true).toBe(true);

      // The gate: submit must NOT go through unconfirmed.
      const submit = await s.actions.click(
        { intent: 'Submit', hint: 'role=button[name="Submit application"]' });
      expect(submit.ok).toBe(false);
      expect((submit as { needs_confirm?: true }).needs_confirm).toBe(true);
    });
  });
});

describe('criterion 2: a warm run costs under 10% of a cold run', () => {
  it('measures cold vs warm token cost through the ledger', { timeout: 180_000 }, async () => {
    await withSession(async (s) => {
      writeFileSync(join(s.workflowsDir, 'apply-greenhouse.md'), WORKFLOW);
      await s.actions.navigate(`${s.url}/greenhouse.html`);

      // COLD: no hints. The agent must snapshot to find anything.
      s.ledger.record('browser_snapshot', await s.actions.snapshot('full'));

      // WARM: hints hit, so no snapshot is fetched at all.
      for (const hint of [
        'role=textbox[name="First Name"]',
        'role=textbox[name="Last Name"]',
      ]) {
        const r = await s.actions.type({ intent: 'field', hint }, 'x');
        expect(r.ok).toBe(true);
        s.ledger.record('browser_type', renderResult(r));
      }

      const byTool = s.ledger.byTool();
      const cold = byTool['browser_snapshot'] ?? 0;
      const warm = byTool['browser_type'] ?? 0;
      // eslint-disable-next-line no-console
      console.log(
        `criterion 2 — cold: ${cold} tokens, warm: ${warm} tokens, ratio: ${(warm / cold).toFixed(3)}`,
      );

      // This is the thesis. If it fails, the workflow layer is not earning
      // its complexity and the design needs rethinking — not a bigger number.
      expect(cold).toBeGreaterThan(0);
      expect(warm).toBeLessThan(cold * 0.1);
    });
  });
});

describe('criterion 3: a stale hint self-heals and rewrites the file', () => {
  it('misses, recovers from the snapshot, and persists the corrected hint',
    { timeout: 180_000 }, async () => {
    await withSession(async (s) => {
      const path = join(s.workflowsDir, 'apply-greenhouse.md');
      // A hint that no longer matches the page — simulating a site redeploy.
      writeFileSync(path, WORKFLOW.replace(
        'role=textbox[name="First Name"]', 'role=textbox[name="Given Name"]'));

      await s.actions.navigate(`${s.url}/greenhouse.html`);

      const miss = await s.actions.type(
        { intent: 'Fill first name', hint: 'role=textbox[name="Given Name"]' }, 'Ada');
      expect(miss.ok).toBe(false);
      expect((miss as { hint_miss?: true }).hint_miss).toBe(true);
      expect((miss as { snapshot?: string }).snapshot).toMatch(/First Name/);

      // The agent supplies the correction; the server persists it.
      const healed = await s.actions.type({
        intent: 'Fill first name',
        hint: 'role=textbox[name="Given Name"]',
        learned_hint: 'role=textbox[name="First Name"]',
      }, 'Ada');
      expect(healed.ok).toBe(true);

      const after = readFileSync(path, 'utf8');
      expect(after).toMatch(/role=textbox\[name="First Name"\]/);
      expect(after).not.toMatch(/Given Name/);
    });
  });
});

describe('criterion 4: degrades cleanly on a block instead of half-failing', () => {
  it('detects the interstitial and reports blocked', { timeout: 180_000 }, async () => {
    const { detectBlock } = await import('../../src/safety/block.js');
    await withSession(async (s) => {
      await s.actions.navigate(`${s.url}/blocked.html`);
      const snap = await s.actions.snapshot('full');

      const reason = detectBlock(snap, `${s.url}/blocked.html`);
      expect(reason).toBeTruthy();

      // And an ordinary page must NOT trip it.
      await s.actions.navigate(`${s.url}/greenhouse.html`);
      const ok = await s.actions.snapshot('full');
      expect(detectBlock(ok, `${s.url}/greenhouse.html`)).toBeNull();
    });
  });
});
