import { describe, expect, it } from 'vitest';
import { formatLocator, parseLocator, ProtocolError } from '../src/protocol.js';

describe('parseLocator', () => {
  it('parses a bare role', () => {
    expect(parseLocator('role=button')).toEqual({
      kind: 'aria', role: 'button', exact: false, attrs: {},
    });
  });

  it('parses role with a quoted accessible name', () => {
    expect(parseLocator('role=button[name="Apply for this job"]')).toEqual({
      kind: 'aria', role: 'button', name: 'Apply for this job', exact: false, attrs: {},
    });
  });

  it('parses the bare exact flag and extra aria options', () => {
    expect(parseLocator('role=heading[name="Jobs"][exact][level=2]')).toEqual({
      kind: 'aria', role: 'heading', name: 'Jobs', exact: true, attrs: { level: '2' },
    });
  });

  it('unescapes quotes inside a name', () => {
    expect(parseLocator('role=link[name="say \\"hi\\""]')).toMatchObject({ name: 'say "hi"' });
  });

  it('parses an explicit css fallback', () => {
    expect(parseLocator('css=canvas#board')).toEqual({ kind: 'css', selector: 'canvas#board' });
  });

  it('rejects an unprefixed CSS selector — hints are ARIA-first', () => {
    expect(() => parseLocator('.btn-primary')).toThrow(ProtocolError);
    expect(() => parseLocator('#submit')).toThrow(ProtocolError);
  });

  it('rejects an unsupported aria option', () => {
    expect(() => parseLocator('role=button[colour="red"]')).toThrow(ProtocolError);
  });

  it('round-trips through formatLocator', () => {
    const src = 'role=textbox[name="First Name"][exact]';
    expect(formatLocator(parseLocator(src))).toBe(src);
    expect(formatLocator(parseLocator('css=canvas#board'))).toBe('css=canvas#board');
  });
});

import { estimateTokens, parseWaitSpec, TokenLedger } from '../src/protocol.js';

describe('parseWaitSpec', () => {
  it('parses load and idle', () => {
    expect(parseWaitSpec('load')).toEqual({ kind: 'load' });
    expect(parseWaitSpec('idle')).toEqual({ kind: 'idle' });
  });

  it('parses durations in ms and s', () => {
    expect(parseWaitSpec('750ms')).toEqual({ kind: 'ms', ms: 750 });
    expect(parseWaitSpec('2s')).toEqual({ kind: 'ms', ms: 2000 });
  });

  it('parses a text wait', () => {
    expect(parseWaitSpec('text:Thanks for applying')).toEqual({
      kind: 'text', text: 'Thanks for applying',
    });
  });

  it('parses a locator wait and validates the locator', () => {
    expect(parseWaitSpec('role=button[name="Submit"]')).toEqual({
      kind: 'locator', locator: 'role=button[name="Submit"]',
    });
    expect(() => parseWaitSpec('.spinner')).toThrow(ProtocolError);
  });

  it('rejects a non-positive duration', () => {
    expect(() => parseWaitSpec('0ms')).toThrow(ProtocolError);
  });
});

describe('TokenLedger', () => {
  it('estimates four characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('accumulates per-tool totals from serialized payloads', () => {
    const ledger = new TokenLedger();
    ledger.record('click', { ok: true });
    ledger.record('click', { ok: true });
    ledger.record('snapshot', 'x'.repeat(400));
    expect(ledger.byTool()).toEqual({ click: 6, snapshot: 100 });
    expect(ledger.total()).toBe(106);
    expect(ledger.count()).toBe(3);
    ledger.reset();
    expect(ledger.total()).toBe(0);
  });
});
