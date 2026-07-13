import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const style = readFileSync(new URL('../src/dashboard/public/style.css', import.meta.url), 'utf8');
const documentSource = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/dashboard/server.ts', import.meta.url), 'utf8');

describe('dashboard release styling contract', () => {
  it('defines the release viewport matrix and a single reflowing workspace', () => {
    expect(style).toMatch(/@media \(min-width:\s*1440px\)/);
    expect(style).toMatch(/@media \(max-width:\s*1024px\)/);
    expect(style).toMatch(/@media \(max-width:\s*768px\)/);
    expect(style).toMatch(/@media \(max-width:\s*390px\)/);
    expect(style).toMatch(/@media \(max-width:\s*320px\)/);
    expect(style).toMatch(/\.workspace-main\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s);
    expect(style).toMatch(/@media \(max-width:\s*900px\)[\s\S]*?\.workspace-main\s*\{[^}]*display:\s*block/);
    expect(style).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('keeps every interactive control touch-sized and keyboard focus visible', () => {
    expect(style).toMatch(/--control-size:\s*44px/);
    expect(style).toMatch(/min-height:\s*var\(--control-size\)/);
    expect(style).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px/s);
    expect(style).toMatch(/:focus-within\s*\{[^}]*border-color:\s*var\(--focus\)/s);
    expect(style).toMatch(/\.skip-link:focus\s*\{[^}]*transform:\s*translateY\(0\)/s);
  });

  it('styles modal isolation, lifecycle controls, and non-color status cues', () => {
    expect(style).toMatch(/\.control-dialog-backdrop\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*900/s);
    expect(style).toMatch(/\.control-dialog\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*40px\)[^}]*overflow-y:\s*auto/s);
    expect(style).toMatch(/\.control-danger\s*\{/);
    expect(style).toMatch(/\.control-status-success::before\s*\{\s*content:\s*"✓"/);
    expect(style).toMatch(/\.control-status-error::before[^}]*content:\s*"!"/s);
    expect(style).toMatch(/\.message\.escalation/);
  });

  it('covers async, stale, disabled, pending, conflict, live, and audit presentation', () => {
    for (const selector of [
      '.async-state-spinner', '.async-state-loading', '.async-state-empty', '.async-state-error', '.async-state-stale', 'button:disabled',
      '.control-status-pending', '.control-status-conflict', '.activity-return-live',
      '.msg-revision', '.msg-status-cue',
    ]) expect(style).toContain(selector);
  });

  it('respects reduced motion, forced colors, local assets, and dashboard CSP', () => {
    expect(style).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    expect(style).toMatch(/@media \(forced-colors:\s*active\)/);
    expect(style).toContain('[inert]');
    expect(style).toMatch(/forced-color-adjust:\s*auto/);
    expect(style).not.toMatch(/(?:url|@import)\s*\(\s*['"]?https?:/i);
    expect(documentSource).not.toMatch(/(?:src|href)=["']https?:/i);
    expect(documentSource).toContain('name="viewport"');
    expect(serverSource).toContain("default-src 'self'");
    expect(serverSource).toContain("script-src 'self'");
    expect(serverSource).toContain("style-src 'self'");
    expect(serverSource).toContain("connect-src 'self'");
  });
});
