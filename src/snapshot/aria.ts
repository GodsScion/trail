import { parseLocator, type AriaNode } from '../protocol.js';

export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  'banner', 'main', 'navigation', 'complementary', 'contentinfo',
  'form', 'search', 'region', 'dialog',
]);

/** See the duplicate in src/driver/patchright.ts — defence in depth, on purpose. */
export const WHOLE_PAGE_SELECTORS: ReadonlySet<string> = new Set(['body', 'html', ':root', '*', 'document']);

/**
 * A node earns a line in the outline if it is actionable (it has a ref), or it
 * gives the agent orientation (landmark or heading). No separate interactive
 * role list is needed: the driver assigns refs to exactly the interactive nodes.
 */
export function isOutlineWorthy(node: AriaNode): boolean {
  return node.ref !== null || LANDMARK_ROLES.has(node.role) || node.role === 'heading';
}

export function describeNode(node: AriaNode): string {
  if (node.role === 'text') return `text: ${node.text ?? ''}`;
  let out = node.role;
  if (node.name) out += ` "${node.name}"`;
  if (node.level !== undefined) out += ` level=${node.level}`;
  if (node.checked !== undefined) out += ` checked=${node.checked}`;
  if (node.selected) out += ' selected';
  if (node.expanded !== undefined) out += ` expanded=${node.expanded}`;
  if (node.required) out += ' required';
  if (node.disabled) out += ' disabled';
  if (node.value) out += ` value="${node.value}"`;
  if (node.placeholder && !node.name) out += ` placeholder="${node.placeholder}"`;
  if (node.css && !node.name) out += ` css=${node.css}`;
  if (node.ref) out += ` [${node.ref}]`;
  if (node.text && node.text !== node.name) out += ` — ${node.text}`;
  return out;
}

/**
 * Serializes the tree. The root node itself is never emitted; its children start
 * at depth 0. Nodes filtered out of the outline do not consume an indent level,
 * so wrappers collapse instead of pushing content to the right.
 */
export function serializeAria(root: AriaNode, level: 'outline' | 'full'): string {
  const lines: string[] = [];
  const walk = (node: AriaNode, depth: number): void => {
    const keep = level === 'full' || isOutlineWorthy(node);
    if (keep) lines.push(`${'  '.repeat(depth)}- ${describeNode(node)}`);
    for (const child of node.children) walk(child, keep ? depth + 1 : depth);
  };
  for (const child of root.children) walk(child, 0);
  return lines.join('\n');
}

/**
 * Guard for the `raw` level. `raw` is an escape hatch for canvas and custom
 * widgets; whole-page source must be unrequestable.
 */
export function isWholePageScope(scope: string): boolean {
  const loc = parseLocator(scope);
  if (loc.kind === 'css') return WHOLE_PAGE_SELECTORS.has(loc.selector.trim().toLowerCase());
  return loc.role === 'document';
}
