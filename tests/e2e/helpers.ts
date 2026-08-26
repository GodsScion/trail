/**
 * Session harness for the real-Chrome criteria suite. One temp root per test:
 * its own fixture copy, its own workflows dir, its own Chrome profile, so a
 * self-healing rewrite in one test cannot leak into another.
 */
import { mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenLedger } from '../../src/protocol.js';
import { launchPatchrightDriver } from '../../src/driver/patchright.js';
import { HintResolver } from '../../src/hints/resolve.js';
import { Actions } from '../../src/tools/actions.js';
import { startFixtureServer } from '../helpers/fixture-server.js';
import { loadWorkflows, matchWorkflow, recordHint } from '../../src/workflow/store.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface Session {
  url: string;
  actions: Actions;
  resolver: HintResolver;
  ledger: TokenLedger;
  workflowsDir: string;
  close(): Promise<void>;
}

export async function withSession(fn: (s: Session) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'trail-e2e-'));
  const workflowsDir = join(root, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  cpSync(join(here, '..', 'fixtures'), join(root, 'fixtures'), { recursive: true });

  const server = await startFixtureServer(join(root, 'fixtures'));
  const driver = await launchPatchrightDriver({
    userDataDir: join(root, 'profile'),
    screenshotDir: join(root, 'shots'),
    channel: 'chrome',
    headless: false,
  });

  const ledger = new TokenLedger();
  const resolver = new HintResolver({
    driver,
    persist: async (req) => {
      const all = await loadWorkflows(workflowsDir);
      const wf = matchWorkflow(all, `${server.url}/greenhouse.html`);
      if (!wf) return false;
      return (await recordHint(wf, req)).persisted;
    },
  });
  const actions = new Actions({ driver, resolver, confirmSubmit: true });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await driver.close();
    await server.close();
  };

  try {
    await fn({ url: server.url, actions, resolver, ledger, workflowsDir, close });
  } finally {
    await close();
  }
}
