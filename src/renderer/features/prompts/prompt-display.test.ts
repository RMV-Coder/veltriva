import { describe, expect, it } from 'vitest';

import {
  INSECURE_SIGN_IN_WARNING,
  MAX_POPUP_ADDRESS_CHARS,
  MAX_REALM_CHARS,
  MAX_SITE_CHARS,
  activeStrip,
  blockedPopupsDisplay,
  cleanText,
  insecureSignInWarning,
  partsText,
  permissionPhrase,
  promptActionLabels,
  promptSentence,
  realmLine,
  rememberFor,
  rememberLabel,
  stripLabel,
  truncateEnd,
  truncateStart,
} from './prompt-display';
import type {
  ExternalProtocolPrompt,
  HttpAuthPrompt,
  LeavePagePrompt,
  PermissionPrompt,
  Prompt,
} from './prompt-display';

function permissionPrompt(
  permissions: PermissionPrompt['permissions'],
  site = 'example.test',
): PermissionPrompt {
  return { id: 'prompt-1', kind: 'permission', site, permissions };
}

function externalPrompt(overrides: Partial<ExternalProtocolPrompt> = {}): ExternalProtocolPrompt {
  return {
    id: 'prompt-2',
    kind: 'external-protocol',
    site: 'example.test',
    scheme: 'zoommtg',
    appName: 'Zoom',
    canRemember: true,
    ...overrides,
  };
}

function httpAuthPrompt(overrides: Partial<HttpAuthPrompt> = {}): HttpAuthPrompt {
  return {
    id: 'prompt-3',
    kind: 'http-auth',
    site: 'intranet.example.test',
    realm: 'Staff area',
    secure: true,
    ...overrides,
  };
}

describe('truncateStart', () => {
  it('leaves a text that fits', () => {
    expect(truncateStart('google.com', 60)).toBe('google.com');
    expect(truncateStart('a'.repeat(60), 60)).toBe('a'.repeat(60));
  });

  it('cuts at the start, so the end of the host stays', () => {
    const host = `${'accounts.'.repeat(10)}google.com.evil.example`;
    const shown = truncateStart(host, MAX_SITE_CHARS);
    expect(shown.startsWith('…')).toBe(true);
    expect(shown.endsWith('google.com.evil.example')).toBe(true);
    expect(Array.from(shown)).toHaveLength(MAX_SITE_CHARS);
  });

  it('never lets a long look-alike prefix push the real domain out of sight', () => {
    const host = `${'x'.repeat(100)}.accounts.google.com.evil.example`;
    const shown = truncateStart(host, MAX_SITE_CHARS);
    expect(shown.endsWith('.evil.example')).toBe(true);
    expect(shown).not.toMatch(/^accounts\.google\.com/);
  });

  it('counts characters, not UTF-16 units, so a surrogate pair is never split', () => {
    const shown = truncateStart('😀'.repeat(70), 10);
    expect(Array.from(shown)).toEqual(['…', ...Array<string>(9).fill('😀')]);
    expect(shown).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('copes with a limit too small to show anything', () => {
    expect(truncateStart('abcdef', 1)).toBe('…');
    expect(truncateStart('abcdef', 0)).toBe('');
  });
});

describe('truncateEnd', () => {
  it('leaves a text that fits', () => {
    expect(truncateEnd('https://a.example/', 80)).toBe('https://a.example/');
  });

  it('cuts at the end, so the host stays', () => {
    const shown = truncateEnd(`https://a.example/${'p'.repeat(200)}`, MAX_POPUP_ADDRESS_CHARS);
    expect(shown.startsWith('https://a.example/')).toBe(true);
    expect(shown.endsWith('…')).toBe(true);
    expect(Array.from(shown)).toHaveLength(MAX_POPUP_ADDRESS_CHARS);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(Array.from(truncateEnd('😀'.repeat(20), 5))).toEqual([
      ...Array<string>(4).fill('😀'),
      '…',
    ]);
  });
});

describe('cleanText', () => {
  it('removes bidi overrides, isolates and zero-width marks', () => {
    expect(cleanText('good‮moc.elgoog')).toBe('good moc.elgoog');
    expect(cleanText('a⁦b⁩c​d')).toBe('a b c d');
  });

  it('removes control characters and line breaks', () => {
    expect(cleanText('a\u0000b\nc\u0085d e')).toBe('a b c d e');
  });

  it('collapses runs of spaces and trims', () => {
    expect(cleanText('  one   two  ')).toBe('one two');
  });

  it('leaves an ordinary host alone', () => {
    expect(cleanText('xn--bcher-kva.example:8080')).toBe('xn--bcher-kva.example:8080');
  });
});

describe('permissionPhrase', () => {
  it('says each permission in its own words', () => {
    expect(permissionPhrase(['camera'])).toBe('use your camera');
    expect(permissionPhrase(['microphone'])).toBe('use your microphone');
    expect(permissionPhrase(['geolocation'])).toBe('know your location');
    expect(permissionPhrase(['notifications'])).toBe('show notifications');
    expect(permissionPhrase(['clipboard-read'])).toBe('see text and images you copied');
  });

  it('puts the camera and the microphone in one phrase, in either order', () => {
    expect(permissionPhrase(['camera', 'microphone'])).toBe('use your camera and microphone');
    expect(permissionPhrase(['microphone', 'camera'])).toBe('use your camera and microphone');
  });

  it('joins two phrases with "and"', () => {
    expect(permissionPhrase(['geolocation', 'notifications'])).toBe(
      'know your location and show notifications',
    );
  });

  it('joins three or more with commas', () => {
    expect(permissionPhrase(['geolocation', 'notifications', 'clipboard-read'])).toBe(
      'know your location, show notifications, and see text and images you copied',
    );
  });

  it('keeps the camera-and-microphone phrase unambiguous next to another', () => {
    expect(permissionPhrase(['camera', 'microphone', 'geolocation'])).toBe(
      'use your camera and microphone, and know your location',
    );
    expect(permissionPhrase(['notifications', 'camera', 'microphone'])).toBe(
      'use your camera and microphone, and show notifications',
    );
  });

  it('is in a fixed order whatever order the page asked in', () => {
    expect(permissionPhrase(['notifications', 'geolocation'])).toBe(
      'know your location and show notifications',
    );
  });

  it('says a permission once if it is listed twice', () => {
    expect(permissionPhrase(['camera', 'camera'])).toBe('use your camera');
  });

  it('still says something for an empty list', () => {
    expect(permissionPhrase([])).toBe('use a feature that needs your permission');
  });
});

describe('promptSentence: permission', () => {
  it('names the site and what it wants', () => {
    const parts = promptSentence(permissionPrompt(['camera', 'microphone']));
    expect(partsText(parts)).toBe('example.test wants to use your camera and microphone');
  });

  it('marks the site as untrusted and bold, and the words around it as ours', () => {
    const [site, rest] = promptSentence(permissionPrompt(['geolocation']));
    expect(site).toEqual({ text: 'example.test', untrusted: true, strong: true });
    expect(rest).toEqual({ text: ' wants to know your location', untrusted: false, strong: false });
  });

  it('keeps a port in the site', () => {
    expect(partsText(promptSentence(permissionPrompt(['camera'], '127.0.0.1:8080')))).toBe(
      '127.0.0.1:8080 wants to use your camera',
    );
  });

  it('cuts a long site at the start and keeps the whole of it for the tooltip', () => {
    const site = `${'sub.'.repeat(40)}google.com.evil.example`;
    const [part] = promptSentence(permissionPrompt(['camera'], site));
    expect(part?.text.startsWith('…')).toBe(true);
    expect(part?.text.endsWith('google.com.evil.example')).toBe(true);
    expect(Array.from(part?.text ?? '')).toHaveLength(MAX_SITE_CHARS);
    expect(part?.full).toBe(site);
  });

  it('handles the longest site the contract allows', () => {
    const site = 'a'.repeat(300 - 'evil.example'.length) + 'evil.example';
    expect(site).toHaveLength(300);
    const [part] = promptSentence(permissionPrompt(['camera'], site));
    expect(Array.from(part?.text ?? '')).toHaveLength(MAX_SITE_CHARS);
    expect(part?.text.endsWith('evil.example')).toBe(true);
    expect(part?.full).toBe(site);
  });

  it('gives no tooltip text when nothing was cut', () => {
    const [part] = promptSentence(permissionPrompt(['camera'], 'a'.repeat(MAX_SITE_CHARS)));
    expect(part).not.toHaveProperty('full');
    expect(part?.text).toHaveLength(MAX_SITE_CHARS);
  });

  it('removes bidi controls from the site', () => {
    const [part] = promptSentence(permissionPrompt(['camera'], 'good.example‮moc.live'));
    expect(part?.text).toBe('good.example moc.live');
  });

  it('falls back to a plain label when the site has no text left', () => {
    expect(partsText(promptSentence(permissionPrompt(['camera'], '‮​')))).toBe(
      'This page wants to use your camera',
    );
  });
});

describe('promptSentence: external protocol', () => {
  it('names the site and the app', () => {
    const parts = promptSentence(externalPrompt());
    expect(partsText(parts)).toBe('example.test wants to open Zoom');
    expect(parts[0]).toMatchObject({ text: 'example.test', untrusted: true, strong: true });
    expect(parts[2]).toEqual({ text: 'Zoom', untrusted: true, strong: true });
  });

  it('names the scheme when the app is unknown', () => {
    const parts = promptSentence(externalPrompt({ appName: '' }));
    expect(partsText(parts)).toBe('example.test wants to open a “zoommtg:” link in another app');
    const scheme = parts.find((part) => part.text === 'zoommtg');
    expect(scheme).toMatchObject({ untrusted: true, strong: false });
  });

  it('asks about the app for a typed address, with no site', () => {
    const parts = promptSentence(externalPrompt({ site: null, canRemember: false }));
    expect(partsText(parts)).toBe('Open Zoom?');
    expect(parts[1]).toEqual({ text: 'Zoom', untrusted: true, strong: true });
  });

  it('asks about the scheme for a typed address with an unknown app', () => {
    const parts = promptSentence(externalPrompt({ site: null, appName: '', canRemember: false }));
    expect(partsText(parts)).toBe('Open this “zoommtg:” link in another app?');
  });

  it('treats an app name made only of invisible characters as unknown', () => {
    const parts = promptSentence(externalPrompt({ appName: '‮​' }));
    expect(partsText(parts)).toBe('example.test wants to open a “zoommtg:” link in another app');
  });

  it('cuts a long site at the start', () => {
    const site = `${'a'.repeat(120)}.evil.example`;
    const [part] = promptSentence(externalPrompt({ site }));
    expect(part?.text.startsWith('…')).toBe(true);
    expect(part?.text.endsWith('.evil.example')).toBe(true);
    expect(part?.full).toBe(site);
  });

  it('removes bidi controls from the app name', () => {
    const parts = promptSentence(externalPrompt({ appName: 'Zo‮om' }));
    expect(partsText(parts)).toBe('example.test wants to open Zo om');
  });
});

describe('rememberLabel', () => {
  it('offers "always allow" with the site and the scheme', () => {
    const parts = rememberLabel(externalPrompt());
    expect(parts === null ? null : partsText(parts)).toBe(
      'Always allow example.test to open zoommtg: links',
    );
  });

  it('marks the site and the scheme as untrusted', () => {
    const parts = rememberLabel(externalPrompt()) ?? [];
    expect(parts.filter((part) => part.untrusted).map((part) => part.text)).toEqual([
      'example.test',
      'zoommtg',
    ]);
  });

  it('cuts a long site at the start here too', () => {
    const parts = rememberLabel(externalPrompt({ site: `${'a'.repeat(120)}.evil.example` })) ?? [];
    const site = parts.find((part) => part.untrusted);
    expect(site?.text.startsWith('…')).toBe(true);
    expect(site?.text.endsWith('.evil.example')).toBe(true);
  });

  it('is not offered when main says it can not be remembered', () => {
    expect(rememberLabel(externalPrompt({ canRemember: false }))).toBeNull();
  });

  it('is not offered without a site, even if canRemember says so', () => {
    expect(rememberLabel(externalPrompt({ site: null }))).toBeNull();
  });
});

describe('rememberFor', () => {
  it('passes the checkbox on only for Open', () => {
    expect(rememberFor('allow', true)).toBe(true);
    expect(rememberFor('allow', false)).toBe(false);
  });

  it('never remembers a Cancel or a dismissal', () => {
    expect(rememberFor('block', true)).toBe(false);
    expect(rememberFor('dismiss', true)).toBe(false);
  });
});

describe('promptSentence: http auth', () => {
  it('names the site that wants a sign-in', () => {
    const parts = promptSentence(httpAuthPrompt());
    expect(partsText(parts)).toBe('intranet.example.test wants you to sign in');
    expect(parts[0]).toEqual({ text: 'intranet.example.test', untrusted: true, strong: true });
    expect(parts[1]).toEqual({ text: ' wants you to sign in', untrusted: false, strong: false });
  });

  it('keeps a port in the site', () => {
    expect(partsText(promptSentence(httpAuthPrompt({ site: '127.0.0.1:8443' })))).toBe(
      '127.0.0.1:8443 wants you to sign in',
    );
  });

  it('cuts a long site at the start, so the end of the host stays', () => {
    const site = `${'a'.repeat(120)}.evil.example`;
    const [part] = promptSentence(httpAuthPrompt({ site }));
    expect(part?.text.startsWith('…')).toBe(true);
    expect(part?.text.endsWith('.evil.example')).toBe(true);
    expect(Array.from(part?.text ?? '')).toHaveLength(MAX_SITE_CHARS);
    expect(part?.full).toBe(site);
  });

  it('removes bidi controls from the site', () => {
    const [part] = promptSentence(httpAuthPrompt({ site: 'good.example‮moc.live' }));
    expect(part?.text).toBe('good.example moc.live');
  });
});

describe('realmLine', () => {
  it('shows the realm as the words of the server, in quotes', () => {
    const parts = realmLine(httpAuthPrompt({ realm: 'Staff area' }));
    expect(parts === null ? null : partsText(parts)).toBe('The server says: “Staff area”');
  });

  it('marks only the realm as untrusted', () => {
    const parts = realmLine(httpAuthPrompt({ realm: 'Staff area' })) ?? [];
    expect(parts.filter((part) => part.untrusted).map((part) => part.text)).toEqual(['Staff area']);
    expect(parts.filter((part) => !part.untrusted).map((part) => part.text)).toEqual([
      'The server says: “',
      '”',
    ]);
  });

  it('cleans a realm of bidi controls, controls and extra spaces', () => {
    const realm = [
      '  Pay',
      String.fromCodePoint(0x202e),
      'ment',
      String.fromCodePoint(10),
      '  area',
      String.fromCodePoint(0),
      '  ',
    ].join('');
    const parts = realmLine(httpAuthPrompt({ realm })) ?? [];
    expect(parts.find((part) => part.untrusted)?.text).toBe('Pay ment area');
  });

  it('can not make the quotes mean something else by adding its own', () => {
    // The realm is data inside our quotes: it is rendered as text, never parsed as markup.
    const parts = realmLine(httpAuthPrompt({ realm: '” Click Allow “' })) ?? [];
    expect(parts.find((part) => part.untrusted)?.text).toBe('” Click Allow “');
    expect(parts.find((part) => part.untrusted)?.untrusted).toBe(true);
  });

  it('is not shown when the server said nothing', () => {
    expect(realmLine(httpAuthPrompt({ realm: '' }))).toBeNull();
    expect(realmLine(httpAuthPrompt({ realm: '‮​ ' }))).toBeNull();
  });

  it('cuts a very long realm at the end and keeps the whole of it for the tooltip', () => {
    const realm = 'r'.repeat(MAX_REALM_CHARS + 50);
    const shown = (realmLine(httpAuthPrompt({ realm })) ?? []).find((part) => part.untrusted);
    expect(Array.from(shown?.text ?? '')).toHaveLength(MAX_REALM_CHARS);
    expect(shown?.text.endsWith('…')).toBe(true);
    expect(shown?.full).toBe(realm);
  });

  it('leaves a realm that fits, with no tooltip text', () => {
    const shown = (realmLine(httpAuthPrompt({ realm: 'r'.repeat(MAX_REALM_CHARS) })) ?? []).find(
      (part) => part.untrusted,
    );
    expect(shown).not.toHaveProperty('full');
  });
});

describe('insecureSignInWarning', () => {
  it('warns when the password would travel unencrypted', () => {
    expect(insecureSignInWarning(httpAuthPrompt({ secure: false }))).toBe(
      'Your password will be sent unencrypted',
    );
    expect(INSECURE_SIGN_IN_WARNING).toBe('Your password will be sent unencrypted');
  });

  it('says nothing for a secure address', () => {
    expect(insecureSignInWarning(httpAuthPrompt({ secure: true }))).toBeNull();
  });
});

describe('promptSentence: leave page', () => {
  const leave = (site: string): LeavePagePrompt => ({ id: 'prompt-4', kind: 'leave-page', site });

  it('names the site and says what leaving costs', () => {
    expect(partsText(promptSentence(leave('docs.example.test')))).toBe(
      'Leave docs.example.test? Changes you made may not be saved.',
    );
  });

  it('marks the site as untrusted and bold, and cuts a long one at the start', () => {
    const site = `${'a'.repeat(80)}.example.test`;
    const parts = promptSentence(leave(site));
    expect(parts[1]).toMatchObject({ untrusted: true, strong: true, full: site });
    expect(Array.from(parts[1]?.text ?? '')).toHaveLength(MAX_SITE_CHARS);
    expect(parts[1]?.text.endsWith('.example.test')).toBe(true);
  });

  it('removes bidi controls from the site', () => {
    expect(partsText(promptSentence(leave('evil\u202e.test')))).toBe(
      'Leave evil .test? Changes you made may not be saved.',
    );
  });
});

describe('promptActionLabels and stripLabel', () => {
  it('names the buttons of a permission prompt', () => {
    expect(promptActionLabels('permission')).toEqual({ allow: 'Allow', block: 'Block' });
  });

  it('names the buttons of an external-protocol prompt', () => {
    expect(promptActionLabels('external-protocol')).toEqual({ allow: 'Open', block: 'Cancel' });
  });

  it('names the buttons of a sign-in prompt', () => {
    expect(promptActionLabels('http-auth')).toEqual({ allow: 'Sign in', block: 'Cancel' });
  });

  it('names the buttons of "Leave page?"', () => {
    expect(promptActionLabels('leave-page')).toEqual({ allow: 'Leave', block: 'Stay' });
  });

  it('names each region', () => {
    expect(stripLabel('permission')).toBe('Permission request');
    expect(stripLabel('external-protocol')).toBe('Open another app');
    expect(stripLabel('http-auth')).toBe('Sign in');
    expect(stripLabel('leave-page')).toBe('Leave page');
    expect(stripLabel('blocked-popups')).toBe('Pop-up blocked');
  });
});

describe('blockedPopupsDisplay', () => {
  it('says one pop-up was blocked, with its address', () => {
    const display = blockedPopupsDisplay({ count: 1, latest: 'https://a.example/x' });
    expect(display.headline).toBe('Pop-up blocked');
    expect(display.addressLead).toBe(': ');
    expect(display.address).toEqual({
      text: 'https://a.example/x',
      untrusted: true,
      strong: false,
    });
  });

  it('counts several, and says the address is the latest', () => {
    const display = blockedPopupsDisplay({ count: 3, latest: 'https://a.example/' });
    expect(display.headline).toBe('3 pop-ups blocked');
    expect(display.addressLead).toBe('. Latest: ');
  });

  it('cuts a long address at the end and keeps the whole of it for the tooltip', () => {
    const latest = `https://a.example/${'p'.repeat(500)}`;
    const { address } = blockedPopupsDisplay({ count: 1, latest });
    expect(address.text.startsWith('https://a.example/')).toBe(true);
    expect(address.text.endsWith('…')).toBe(true);
    expect(Array.from(address.text)).toHaveLength(MAX_POPUP_ADDRESS_CHARS);
    expect(address.full).toBe(latest);
  });

  it('handles the longest address the contract allows', () => {
    const latest = `https://a.example/${'p'.repeat(4096 - 'https://a.example/'.length)}`;
    const { address } = blockedPopupsDisplay({ count: 2, latest });
    expect(Array.from(address.text)).toHaveLength(MAX_POPUP_ADDRESS_CHARS);
  });

  it('removes bidi controls from the address', () => {
    const { address } = blockedPopupsDisplay({ count: 1, latest: 'https://a.example/‮evil' });
    expect(address.text).toBe('https://a.example/ evil');
  });
});

describe('activeStrip', () => {
  const prompt: Prompt = permissionPrompt(['camera']);
  const blocked = { count: 2, latest: 'https://a.example/' };

  it('shows nothing without a prompt or blocked popups, or without a tab', () => {
    expect(activeStrip({ prompt: null, blockedPopups: null })).toBeNull();
    expect(activeStrip(undefined)).toBeNull();
  });

  it('shows the prompt', () => {
    expect(activeStrip({ prompt, blockedPopups: null })).toEqual({ kind: 'prompt', prompt });
  });

  it('shows the blocked popups', () => {
    expect(activeStrip({ prompt: null, blockedPopups: blocked })).toEqual({
      kind: 'blocked-popups',
      blocked,
    });
  });

  it('lets the prompt win, and the blocked popups wait', () => {
    expect(activeStrip({ prompt, blockedPopups: blocked })).toEqual({ kind: 'prompt', prompt });
  });
});
