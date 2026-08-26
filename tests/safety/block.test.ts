import { describe, it, expect } from 'vitest';
import { detectBlock, blockedResult } from '../../src/safety/block.js';

describe('detectBlock', () => {
  it('flags a Cloudflare interstitial', () => {
    expect(detectBlock('- heading "Checking your browser before accessing"', 'https://x.test/'))
      .toMatch(/challenge|checking/i);
  });

  it('flags an access-denied page', () => {
    expect(detectBlock('- heading "Access Denied" [level=1]', 'https://x.test/')).toBeTruthy();
  });

  it('flags a captcha', () => {
    expect(detectBlock('- text: Please complete the CAPTCHA to continue', 'https://x.test/')).toBeTruthy();
  });

  it('does NOT flag an ordinary application form', () => {
    const ok = `- heading "Senior Engineer" [level=1]
- textbox "First Name"
- button "Submit application"`;
    expect(detectBlock(ok, 'https://boards.greenhouse.io/acme/jobs/1')).toBeNull();
  });

  it('builds the blocked ActionResult shape', () => {
    const r = blockedResult('captcha', '/tmp/b.png');
    expect(r.ok).toBe(false);
    expect((r as any).blocked).toBe(true);
    expect((r as any).reason).toBe('captcha');
    expect((r as any).screenshot).toBe('/tmp/b.png');
  });
});
