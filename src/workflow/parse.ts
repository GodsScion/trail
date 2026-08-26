import matter from 'gray-matter';
import type { RateLimit, Workflow, WorkflowFrontmatter, WorkflowStep } from '../protocol.js';

export class WorkflowParseError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'WorkflowParseError';
  }
}

const STEP_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const HINT_RE = /<!--\s*hint:\s*([\s\S]*?)\s*-->/;
const HEADING_RE = /^##\s+(.*)$/;
const RATE_RE = /^\s*(\d+)\s*\/\s*(hour|day)\s*$/i;

/** Line index where the body starts, so step line numbers index the FULL source. */
function bodyStartLine(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') return i + 1;
  }
  return 0;
}

function parseRateLimit(value: unknown, path: string): RateLimit | null {
  if (value === undefined || value === null) return null;
  const m = RATE_RE.exec(String(value));
  if (!m) throw new WorkflowParseError(path, `rate_limit must look like "10/hour" (got ${String(value)})`);
  return { count: Number(m[1]), per: m[2]!.toLowerCase() as 'hour' | 'day' };
}

function parseFrontmatter(data: Record<string, unknown>, path: string): WorkflowFrontmatter {
  const name = data['name'];
  const match = data['match'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw new WorkflowParseError(path, 'frontmatter is missing a non-empty `name`');
  }
  if (typeof match !== 'string' || match.trim() === '') {
    throw new WorkflowParseError(path, 'frontmatter is missing a non-empty `match` URL pattern');
  }
  const requiresRaw = data['requires'];
  if (requiresRaw !== undefined && !Array.isArray(requiresRaw)) {
    throw new WorkflowParseError(path, '`requires` must be a list');
  }
  const confirm = data['confirm_submit'];
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    throw new WorkflowParseError(path, '`confirm_submit` must be true or false');
  }
  return {
    name: name.trim(),
    match: match.trim(),
    requires: (requiresRaw ?? []).map((r: unknown) => String(r)),
    // Default-on. Absence means true.
    confirm_submit: confirm ?? true,
    rate_limit: parseRateLimit(data['rate_limit'], path),
  };
}

export function parseWorkflow(source: string, path: string): Workflow {
  let data: Record<string, unknown>;
  try {
    data = matter(source).data as Record<string, unknown>;
  } catch (e) {
    throw new WorkflowParseError(path, `unreadable frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  const frontmatter = parseFrontmatter(data, path);
  const lines = source.split('\n');
  const start = bodyStartLine(lines);

  let section = '';
  const intentLines: string[] = [];
  const steps: WorkflowStep[] = [];

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      section = heading[1]!.trim().toLowerCase();
      continue;
    }
    if (section === 'intent') {
      if (line.trim() !== '') intentLines.push(line.trim());
      continue;
    }
    if (section !== 'steps') continue;

    const step = STEP_RE.exec(line);
    if (step) {
      const inline = HINT_RE.exec(step[3]!);
      steps.push({
        index: Number(step[2]),
        text: step[3]!.replace(HINT_RE, '').trim(),
        hint: inline ? inline[1]!.trim() : null,
        line: i,
        hintLine: inline ? i : null,
      });
      continue;
    }
    const last = steps[steps.length - 1];
    if (last && last.hint === null) {
      const cont = HINT_RE.exec(line);
      if (cont) {
        last.hint = cont[1]!.trim();
        last.hintLine = i;
      }
    }
  }

  return { path, source, frontmatter, intent: intentLines.join(' '), steps };
}
