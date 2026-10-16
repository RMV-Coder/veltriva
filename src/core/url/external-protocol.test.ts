import { describe, expect, it } from 'vitest';

import {
  BLOCKED_EXTERNAL_SCHEMES,
  MAX_EXTERNAL_URL_LENGTH,
  classifyExternalUrl,
} from './external-protocol';

describe('classifyExternalUrl', () => {
  it.each([
    ['mailto:someone@example.invalid', 'mailto', 'mailto:someone@example.invalid'],
    ['tel:+15551234567', 'tel', 'tel:+15551234567'],
    [
      'zoommtg://zoom.us/join?confno=123&pwd=abc',
      'zoommtg',
      'zoommtg://zoom.us/join?confno=123&pwd=abc',
    ],
    ['MSTeams:/l/meetup-join/19%3a', 'msteams', 'msteams:/l/meetup-join/19%3a'],
    ['ms-settings:display', 'ms-settings', 'ms-settings:display'],
    ['steam://run/440', 'steam', 'steam://run/440'],
  ])('lets %s through for a prompt', (raw, scheme, url) => {
    expect(classifyExternalUrl(raw)).toEqual({ kind: 'external', scheme, url });
  });

  it('blocks every always-blocked scheme, in any case', () => {
    for (const scheme of BLOCKED_EXTERNAL_SCHEMES) {
      const verdict = classifyExternalUrl(`${scheme.toUpperCase()}:anything`);
      // Schemes the URL parser treats specially still come back as the same scheme.
      expect(verdict).toEqual({ kind: 'blocked', scheme });
    }
  });

  it.each([
    ['ms-msdt:/id PCWDiagnostic /skip force /param "IT_RebrowseForFile=?"', 'ms-msdt'],
    ['search-ms:query=calc&crumb=location:\\\\evil.example\\share', 'search-ms'],
    ['ms-officecmd:{"id":3}', 'ms-officecmd'],
    ['vbscript:msgbox(1)', 'vbscript'],
    ['javascript:alert(1)', 'javascript'],
    ['file:///C:/Windows/System32/calc.exe', 'file'],
    ['shell:startup', 'shell'],
    ['hcp://system/sysinfo', 'hcp'],
    ['  ms-appinstaller:?source=https://evil.example/x.appx', 'ms-appinstaller'],
  ])('blocks %s', (raw, scheme) => {
    expect(classifyExternalUrl(raw)).toEqual({ kind: 'blocked', scheme });
  });

  it.each([
    ['https://example.com/', 'https'],
    ['http://127.0.0.1:8080/', 'http'],
    ['about:blank', 'about'],
    ['blob:https://example.com/0f8c', 'blob'],
    ['veltriva://settings', 'veltriva'],
    ['app://shell/index.html', 'app'],
    ['chrome-extension://abc/index.html', 'chrome-extension'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
  ])("leaves the browser's own %s alone", (raw, scheme) => {
    expect(classifyExternalUrl(raw)).toEqual({ kind: 'browser', scheme });
  });

  it.each([
    ['', 'empty'],
    ['not a url', 'no scheme'],
    ['://missing', 'no scheme name'],
    ['1abc:x', 'a scheme starting with a digit'],
  ])('refuses %j (%s)', (raw) => {
    expect(classifyExternalUrl(raw)).toEqual({ kind: 'invalid' });
  });

  it('escapes what could split the launch into more arguments', () => {
    const verdict = classifyExternalUrl('myapp:open "C:\\evil.exe" & calc');
    expect(verdict).toEqual({
      kind: 'external',
      scheme: 'myapp',
      url: 'myapp:open%20%22C:%5Cevil.exe%22%20&%20calc',
    });
  });

  it('escapes controls, angle brackets, pipes and non-ASCII', () => {
    const verdict = classifyExternalUrl('myapp:a<b>|c^d`e{f}g\u0007h\u00e9i\u202ej');
    expect(verdict.kind).toBe('external');
    const url = verdict.kind === 'external' ? verdict.url : '';
    expect(url).toBe('myapp:a%3Cb%3E%7Cc%5Ed%60e%7Bf%7Dg%07h%C3%A9i%E2%80%AEj');
    expect(url).toMatch(/^[\x21-\x7e]+$/);
  });

  it('keeps escapes the URL already has', () => {
    expect(classifyExternalUrl('mailto:a@b.example?subject=Hi%20there')).toEqual({
      kind: 'external',
      scheme: 'mailto',
      url: 'mailto:a@b.example?subject=Hi%20there',
    });
  });

  it('refuses a URL that is too long to launch once escaped', () => {
    const fits = `myapp:${'a'.repeat(MAX_EXTERNAL_URL_LENGTH - 'myapp:'.length)}`;
    expect(classifyExternalUrl(fits).kind).toBe('external');
    expect(classifyExternalUrl(`${fits}a`)).toEqual({ kind: 'invalid' });
    // Short as typed, too long once spaces are escaped.
    expect(classifyExternalUrl(`myapp:${' x'.repeat(800)}`)).toEqual({ kind: 'invalid' });
    expect(classifyExternalUrl(`myapp:${'a'.repeat(100_000)}`)).toEqual({ kind: 'invalid' });
  });
});
