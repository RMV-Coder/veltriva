import { describe, expect, it } from 'vitest';

import { DISMISSALS_BEFORE_EMBARGO, PermissionDecisions } from './permission-decisions';
import {
  classifyRequest,
  isPermissionGranted,
  isPromptableOrigin,
  originOf,
} from './permission-policy';
import type { PermissionCheck, PermissionRequest, PromptedPermission } from './permission-policy';

const SITE = 'https://meet.example';

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    permission: 'geolocation',
    requestingOrigin: SITE,
    topOrigin: SITE,
    role: 'tab',
    ...overrides,
  };
}

describe('classifyRequest', () => {
  it('grants a copy button and, in tabs only, fullscreen', () => {
    expect(classifyRequest(request({ permission: 'clipboard-sanitized-write' }))).toEqual({
      kind: 'grant',
    });
    expect(classifyRequest(request({ permission: 'fullscreen' }))).toEqual({ kind: 'grant' });
    expect(classifyRequest(request({ permission: 'fullscreen', role: 'popup' }))).toEqual({
      kind: 'deny',
      reason: 'no-fullscreen-notice',
    });
    expect(
      classifyRequest(request({ permission: 'clipboard-sanitized-write', role: 'popup' })),
    ).toEqual({ kind: 'grant' });
  });

  it.each<[string, readonly string[] | undefined, readonly PromptedPermission[]]>([
    ['media', ['video'], ['camera']],
    ['media', ['audio'], ['microphone']],
    ['media', ['audio', 'video'], ['camera', 'microphone']],
    ['geolocation', undefined, ['geolocation']],
    ['notifications', undefined, ['notifications']],
    ['clipboard-read', undefined, ['clipboard-read']],
  ])('prompts for %s %j', (permission, mediaTypes, permissions) => {
    const asked =
      mediaTypes === undefined ? request({ permission }) : request({ permission, mediaTypes });
    expect(classifyRequest(asked)).toEqual({ kind: 'prompt', origin: SITE, permissions });
  });

  it('hands openExternal to the protocol guard', () => {
    expect(classifyRequest(request({ permission: 'openExternal' }))).toEqual({
      kind: 'external',
    });
    expect(classifyRequest(request({ permission: 'openExternal', role: 'other' }))).toEqual({
      kind: 'external',
    });
  });

  it.each([
    'pointerLock',
    'keyboardLock',
    'display-capture',
    'midiSysex',
    'midi',
    'hid',
    'serial',
    'usb',
    'idle-detection',
    'window-management',
    'local-network-access',
    'storage-access',
    'top-level-storage-access',
    'mediaKeySystem',
    'fileSystem',
    'speaker-selection',
    'deprecated-sync-clipboard-read',
    'unknown',
    '',
  ])('denies %j: not on the allow-list', (permission) => {
    expect(classifyRequest(request({ permission }))).toEqual({
      kind: 'deny',
      reason: 'not-on-allow-list',
    });
  });

  it('denies media with no device type', () => {
    expect(classifyRequest(request({ permission: 'media', mediaTypes: [] }))).toEqual({
      kind: 'deny',
      reason: 'not-on-allow-list',
    });
  });

  it('never prompts in popup windows or for anything that is not a page', () => {
    expect(classifyRequest(request({ role: 'popup' }))).toEqual({
      kind: 'deny',
      reason: 'popup-window',
    });
    expect(classifyRequest(request({ role: 'other' }))).toEqual({
      kind: 'deny',
      reason: 'not-a-page',
    });
    expect(
      classifyRequest(request({ permission: 'clipboard-sanitized-write', role: 'other' })),
    ).toEqual({ kind: 'deny', reason: 'not-a-page' });
  });

  it('denies an embedded page from another site, whatever it asks for', () => {
    for (const permission of ['geolocation', 'notifications', 'clipboard-read']) {
      expect(
        classifyRequest(request({ permission, requestingOrigin: 'https://ads.example' })),
      ).toEqual({ kind: 'deny', reason: 'cross-origin-frame' });
    }
    expect(
      classifyRequest(
        request({
          permission: 'media',
          mediaTypes: ['video'],
          requestingOrigin: 'https://widget.example',
        }),
      ),
    ).toEqual({ kind: 'deny', reason: 'cross-origin-frame' });
  });

  it('only prompts for secure origins it can name', () => {
    for (const origin of ['http://example.com', 'null', 'file://', 'about:blank', '']) {
      expect(classifyRequest(request({ requestingOrigin: origin, topOrigin: origin }))).toEqual({
        kind: 'deny',
        reason: 'insecure-origin',
      });
    }
    expect(
      classifyRequest(
        request({ requestingOrigin: 'http://127.0.0.1:8080', topOrigin: 'http://127.0.0.1:8080' }),
      ),
    ).toMatchObject({ kind: 'prompt', origin: 'http://127.0.0.1:8080' });
  });
});

describe('isPermissionGranted', () => {
  const check = (overrides: Partial<PermissionCheck> = {}): PermissionCheck => ({
    permission: 'geolocation',
    requestingOrigin: SITE,
    topOrigin: SITE,
    role: 'tab',
    ...overrides,
  });

  it('agrees with what a request would get', () => {
    const decisions = new PermissionDecisions();
    const decisionOf = decisions.get.bind(decisions);
    expect(isPermissionGranted(check(), decisionOf)).toBe(false);
    decisions.set(SITE, ['geolocation'], 'allow');
    expect(isPermissionGranted(check(), decisionOf)).toBe(true);
    decisions.set(SITE, ['geolocation'], 'block');
    expect(isPermissionGranted(check(), decisionOf)).toBe(false);
    // Another site's decision never counts.
    expect(
      isPermissionGranted(
        check({ requestingOrigin: 'https://other.example', topOrigin: 'https://other.example' }),
        decisionOf,
      ),
    ).toBe(false);
  });

  it('maps media checks by device type', () => {
    const decisions = new PermissionDecisions();
    decisions.set(SITE, ['camera'], 'allow');
    const decisionOf = decisions.get.bind(decisions);
    expect(
      isPermissionGranted(check({ permission: 'media', mediaType: 'video' }), decisionOf),
    ).toBe(true);
    expect(
      isPermissionGranted(check({ permission: 'media', mediaType: 'audio' }), decisionOf),
    ).toBe(false);
    expect(
      isPermissionGranted(check({ permission: 'media', mediaType: 'unknown' }), decisionOf),
    ).toBe(false);
  });

  it('is true without a prompt only where a request is granted without one', () => {
    const none = (): undefined => undefined;
    expect(isPermissionGranted(check({ permission: 'clipboard-sanitized-write' }), none)).toBe(
      true,
    );
    expect(isPermissionGranted(check({ permission: 'fullscreen' }), none)).toBe(true);
    expect(isPermissionGranted(check({ permission: 'fullscreen', role: 'popup' }), none)).toBe(
      false,
    );
    expect(isPermissionGranted(check({ permission: 'pointerLock' }), none)).toBe(false);
    expect(isPermissionGranted(check({ permission: 'openExternal' }), none)).toBe(false);
  });

  it('is false for embedded pages from other sites and for popup windows, even if allowed', () => {
    const decisions = new PermissionDecisions();
    decisions.set(SITE, ['geolocation'], 'allow');
    decisions.set('https://ads.example', ['geolocation'], 'allow');
    const decisionOf = decisions.get.bind(decisions);
    expect(
      isPermissionGranted(check({ requestingOrigin: 'https://ads.example' }), decisionOf),
    ).toBe(false);
    expect(isPermissionGranted(check({ role: 'popup' }), decisionOf)).toBe(false);
    expect(isPermissionGranted(check({ role: 'other' }), decisionOf)).toBe(false);
  });
});

describe('PermissionDecisions', () => {
  it('remembers per origin and per permission', () => {
    const decisions = new PermissionDecisions();
    decisions.set(SITE, ['camera', 'microphone'], 'allow');
    expect(decisions.get(SITE, 'camera')).toBe('allow');
    expect(decisions.get(SITE, 'microphone')).toBe('allow');
    expect(decisions.get(SITE, 'geolocation')).toBeUndefined();
    expect(decisions.get('https://other.example', 'camera')).toBeUndefined();
  });

  it('treats repeated dismissals as a block, so a page cannot keep asking', () => {
    const decisions = new PermissionDecisions();
    for (let time = 1; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      decisions.dismissed(SITE, ['notifications']);
      expect(decisions.get(SITE, 'notifications')).toBeUndefined();
    }
    decisions.dismissed(SITE, ['notifications']);
    expect(decisions.get(SITE, 'notifications')).toBe('block');
    expect(decisions.get(SITE, 'geolocation')).toBeUndefined();
    // An explicit answer wins over the embargo.
    decisions.set(SITE, ['notifications'], 'allow');
    expect(decisions.get(SITE, 'notifications')).toBe('allow');
  });
});

describe('isPromptableOrigin and originOf', () => {
  it.each([
    ['https://example.com', true],
    ['https://xn--80ak6aa92e.com', true],
    ['http://127.0.0.1:5173', true],
    ['http://localhost:3000', true],
    ['http://[::1]:8080', true],
    ['http://example.com', false],
    ['http://192.168.1.10', false],
    ['https://example.com/', false],
    ['null', false],
    ['file://', false],
    ['', false],
  ])('%s → %s', (origin, expected) => {
    expect(isPromptableOrigin(origin)).toBe(expected);
  });

  it.each([
    ['https://a.example/path?q#h', 'https://a.example'],
    ['http://127.0.0.1:8080/x', 'http://127.0.0.1:8080'],
    ['blob:https://a.example/0f8c', 'https://a.example'],
    ['about:blank', null],
    ['data:text/html,x', null],
    ['file:///C:/x.html', null],
    ['not a url', null],
  ])('originOf(%s) → %s', (url, origin) => {
    expect(originOf(url)).toBe(origin);
  });
});
