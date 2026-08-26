#!/usr/bin/env node
/** Stdio entry point: wire the driver, resolver and actions into one MCP server. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TokenLedger } from './protocol.js';
import { launchPatchrightDriver } from './driver/patchright.js';
import { defaultDriverLaunchOptions } from './driver/types.js';
import { HintResolver } from './hints/resolve.js';
import { Actions } from './tools/actions.js';
import { registerTools } from './tools/index.js';
import { RateLimiter } from './safety/ratelimit.js';
import { makePacer } from './safety/pacing.js';
import { defaultWorkflowsDir, loadWorkflows, recordHint } from './workflow/store.js';

export async function main(): Promise<void> {
  const workflowsDir = defaultWorkflowsDir();
  const driver = await launchPatchrightDriver(defaultDriverLaunchOptions());

  const resolver = new HintResolver({
    driver,
    persist: async (req) => {
      const all = await loadWorkflows(workflowsDir);
      const wf = all.find((w) => w.steps.some((s) => s.text.includes(req.intent)));
      if (!wf) return false;
      const { persisted } = await recordHint(wf, req);
      return persisted;
    },
  });

  const actions = new Actions({ driver, resolver, confirmSubmit: true, pace: makePacer() });

  const server = new McpServer({ name: 'trail', version: '0.1.0' });
  registerTools(server, {
    actions, limiter: new RateLimiter(), ledger: new TokenLedger(), workflowsDir,
  });

  const shutdown = async () => {
    await driver.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[trail] fatal:', err);
  process.exit(1);
});
