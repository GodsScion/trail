import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedWorkflow, Workflow } from '../protocol.js';
import { parseWorkflow, WorkflowParseError } from './parse.js';

export function defaultWorkflowsDir(): string {
  return process.env['TRAIL_WORKFLOWS_DIR'] ?? join(process.cwd(), 'workflows');
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split(/[?#]/)[0]!.replace(/\/+$/, '').toLowerCase();
  }
}

/** A single star matches one path segment; a double star matches across segments. */
export function urlMatchesPattern(pattern: string, url: string): boolean {
  const p = pattern.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**')
    .map((segment) => segment.replace(/\*/g, '[^/]+'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i').test(normalizeUrl(url));
}

export async function loadWorkflowsWithErrors(
  dir: string,
): Promise<{ workflows: Workflow[]; errors: Array<{ path: string; message: string }> }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { workflows: [], errors: [] };
  }
  const workflows: Workflow[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const path = join(dir, name);
    try {
      workflows.push(parseWorkflow(await readFile(path, 'utf8'), path));
    } catch (e) {
      errors.push({
        path,
        message: e instanceof WorkflowParseError ? e.message : String(e),
      });
    }
  }
  return { workflows, errors };
}

export async function loadWorkflows(dir: string): Promise<Workflow[]> {
  return (await loadWorkflowsWithErrors(dir)).workflows;
}

/** Most specific pattern wins; ties break on the longer pattern. */
export function matchWorkflow(workflows: Workflow[], url: string): Workflow | null {
  const hits = workflows
    .filter((w) => urlMatchesPattern(w.frontmatter.match, url))
    .sort((a, b) => b.frontmatter.match.length - a.frontmatter.match.length);
  return hits[0] ?? null;
}

export function findWorkflowByName(workflows: Workflow[], name: string): Workflow | null {
  return workflows.find((w) => w.frontmatter.name === name) ?? null;
}

const normalizeText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function pickStep(workflow: Workflow, intent: string, oldHint?: string | null): number {
  if (oldHint) {
    const byHint = workflow.steps.findIndex((s) => s.hint === oldHint);
    if (byHint >= 0) return byHint;
  }
  const want = normalizeText(intent);
  const exact = workflow.steps.findIndex((s) => normalizeText(s.text) === want);
  if (exact >= 0) return exact;
  const wantWords = want.split(' ').filter((w) => w.length > 2);
  let best = -1;
  let bestScore = 0;
  workflow.steps.forEach((step, i) => {
    const text = normalizeText(step.text);
    const score = wantWords.filter((w) => text.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= Math.max(1, Math.ceil(wantWords.length / 2)) ? best : -1;
}

/**
 * Drift is self-repairing: every hint miss writes the agent's correction back,
 * so a workflow that breaks on a site redeploy heals on its next run instead of
 * rotting. Rewrites are surgical - only the hint comment line changes.
 */
export async function recordHint(
  workflow: Workflow,
  req: { intent: string; oldHint?: string | null; newHint: string },
): Promise<{ persisted: boolean; workflow: Workflow }> {
  const idx = pickStep(workflow, req.intent, req.oldHint);
  if (idx < 0) return { persisted: false, workflow };
  const step = workflow.steps[idx]!;
  const lines = workflow.source.split('\n');
  const comment = `<!-- hint: ${req.newHint} -->`;

  if (step.hintLine !== null) {
    lines[step.hintLine] = lines[step.hintLine]!.replace(/<!--\s*hint:[\s\S]*?-->/, comment);
  } else {
    const indent = /^(\s*)/.exec(lines[step.line] ?? '')?.[1] ?? '';
    lines.splice(step.line + 1, 0, `${indent}   ${comment}`);
  }

  const next = lines.join('\n');
  const tmp = `${workflow.path}.tmp`;
  await writeFile(tmp, next, 'utf8');
  await rename(tmp, workflow.path);
  return { persisted: true, workflow: parseWorkflow(next, workflow.path) };
}

export function toLoadedWorkflow(workflow: Workflow): LoadedWorkflow {
  return {
    name: workflow.frontmatter.name,
    path: workflow.path,
    match: workflow.frontmatter.match,
    intent: workflow.intent,
    requires: workflow.frontmatter.requires,
    confirm_submit: workflow.frontmatter.confirm_submit,
    rate_limit: workflow.frontmatter.rate_limit,
    steps: workflow.steps.map((s) => ({ index: s.index, text: s.text, hint: s.hint })),
  };
}
