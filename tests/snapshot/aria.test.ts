import { describe, expect, it } from 'vitest';
import type { AriaNode } from '../../src/protocol.js';
import { ProtocolError } from '../../src/protocol.js';
import { isWholePageScope, serializeAria } from '../../src/snapshot/aria.js';

function node(partial: Partial<AriaNode> & { role: string }): AriaNode {
  return { ref: null, name: '', children: [], ...partial };
}

const page: AriaNode = node({
  role: 'document',
  children: [
    node({ role: 'banner', children: [node({ role: 'link', name: 'Fixture Boards', ref: 'e0' })] }),
    node({
      role: 'main',
      children: [
        node({ role: 'heading', name: 'Senior Engineer', level: 1 }),
        node({ role: 'text', text: 'We are hiring a senior engineer.' }),
        node({
          role: 'form',
          name: 'Application',
          children: [
            node({ role: 'group', children: [node({ role: 'textbox', name: 'First Name', ref: 'e1', required: true })] }),
            node({ role: 'combobox', name: 'Source', ref: 'e2', children: [node({ role: 'option', name: 'A friend', ref: 'e3' })] }),
            node({ role: 'button', name: 'Submit Application', ref: 'e4' }),
          ],
        }),
        node({ role: 'graphic', css: 'canvas#board' }),
      ],
    }),
  ],
});

describe('serializeAria', () => {
  it('renders the outline: interactive nodes, landmarks and headings only', () => {
    expect(serializeAria(page, 'outline')).toBe(
      [
        '- banner',
        '  - link "Fixture Boards" [e0]',
        '- main',
        '  - heading "Senior Engineer" level=1',
        '  - form "Application"',
        '    - textbox "First Name" required [e1]',
        '    - combobox "Source" [e2]',
        '      - option "A friend" [e3]',
        '    - button "Submit Application" [e4]',
      ].join('\n'),
    );
  });

  it('flattens non-kept wrappers instead of indenting past them', () => {
    const outline = serializeAria(page, 'outline');
    expect(outline).not.toContain('group');
    expect(outline).toContain('    - textbox "First Name" required [e1]');
  });

  it('renders full: adds text nodes and unnamed escape-hatch nodes', () => {
    const full = serializeAria(page, 'full');
    expect(full).toContain('  - text: We are hiring a senior engineer.');
    expect(full).toContain('  - graphic css=canvas#board');
    expect(full).toContain('    - group');
  });

  it('never emits the root node itself', () => {
    expect(serializeAria(page, 'full')).not.toContain('- document');
  });

  it('emits attributes in a fixed order so diffs are stable', () => {
    const n = node({
      role: 'textbox', name: 'Email', ref: 'e9', required: true, disabled: true, value: 'a@b.c',
    });
    expect(serializeAria(node({ role: 'document', children: [n] }), 'full'))
      .toBe('- textbox "Email" required disabled value="a@b.c" [e9]');
  });

  it('emits a css fallback only when the node has no accessible name', () => {
    const named = node({ role: 'button', name: 'Attach', ref: 'e5', css: 'input#resume' });
    const anon = node({ role: 'button', name: '', ref: 'e6', css: 'input#resume' });
    const out = serializeAria(node({ role: 'document', children: [named, anon] }), 'full');
    expect(out).toBe('- button "Attach" [e5]\n- button css=input#resume [e6]');
  });
});

describe('isWholePageScope', () => {
  it('rejects whole-page CSS scopes', () => {
    for (const s of ['css=body', 'css=HTML', 'css=:root', 'css=*']) {
      expect(isWholePageScope(s)).toBe(true);
    }
  });

  it('accepts a genuinely scoped selector', () => {
    expect(isWholePageScope('css=#application')).toBe(false);
    expect(isWholePageScope('role=form[name="Application"]')).toBe(false);
  });

  it('rejects the document role', () => {
    expect(isWholePageScope('role=document')).toBe(true);
  });

  it('propagates a locator parse error', () => {
    expect(() => isWholePageScope('.spinner')).toThrow(ProtocolError);
  });
});
