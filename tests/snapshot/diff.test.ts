import { describe, expect, it } from 'vitest';
import { DIFF_MAX_LINES, diffSnapshots } from '../../src/snapshot/diff.js';

describe('diffSnapshots', () => {
  it('returns an empty string when nothing changed', () => {
    const s = '- main\n  - button "Apply" [e1]';
    expect(diffSnapshots(s, s)).toBe('');
  });

  it('reports only the changed lines, not the whole snapshot', () => {
    const before = ['- main', '  - textbox "First Name" [e1]', '  - button "Submit" [e2]'].join('\n');
    const after = ['- main', '  - textbox "First Name" value="Ada" [e1]', '  - button "Submit" [e2]'].join('\n');
    expect(diffSnapshots(before, after)).toBe(
      ['-   - textbox "First Name" [e1]', '+   - textbox "First Name" value="Ada" [e1]'].join('\n'),
    );
  });

  it('reports pure additions and pure removals', () => {
    expect(diffSnapshots('- a', '- a\n- b')).toBe('+ - b');
    expect(diffSnapshots('- a\n- b', '- a')).toBe('- - b');
  });

  it('caps the output and says how much it withheld', () => {
    const before = '';
    const after = Array.from({ length: 60 }, (_, i) => `- button "B${i}" [e${i}]`).join('\n');
    const out = diffSnapshots(before, after);
    expect(out.split('\n')).toHaveLength(DIFF_MAX_LINES + 1);
    expect(out).toContain('… 20 more changes (call snapshot for detail)');
  });

  it('honours an explicit maxLines', () => {
    const after = ['- a', '- b', '- c'].join('\n');
    expect(diffSnapshots('', after, 2).split('\n')).toEqual([
      '+ - a', '+ - b', '… 1 more changes (call snapshot for detail)',
    ]);
  });

  it('falls back to a coarse set difference on very large inputs', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `- row ${i}`).join('\n');
    const bigger = `${big}\n- row 2000`;
    expect(diffSnapshots(big, bigger)).toBe('+ - row 2000');
  });
});
