import { describe, expect, it } from 'vitest';

import { DEFAULT_POPUP_SIZE, popupSize, routeWindowOpen } from './window-open-route';
import type { WindowOpenRequest } from './window-open-route';

const open = (overrides: Partial<WindowOpenRequest> = {}): WindowOpenRequest => ({
  url: 'https://accounts.example/oauth',
  disposition: 'new-window',
  features: 'width=500,height=600',
  hasPostBody: false,
  fromPopupWindow: false,
  ...overrides,
});

describe('routeWindowOpen', () => {
  it('hosts a sized window.open in a popup window, which keeps the opener', () => {
    expect(routeWindowOpen(open())).toEqual({
      kind: 'popup-window',
      url: 'https://accounts.example/oauth',
      size: { width: 500, height: 600 },
    });
    expect(routeWindowOpen(open({ features: 'popup' }))).toMatchObject({
      kind: 'popup-window',
      size: DEFAULT_POPUP_SIZE,
    });
  });

  it('opens target=_blank and plain window.open in a foreground tab, Ctrl/middle clicks behind', () => {
    expect(routeWindowOpen(open({ disposition: 'foreground-tab', features: '' }))).toEqual({
      kind: 'tab',
      url: 'https://accounts.example/oauth',
      background: false,
    });
    expect(routeWindowOpen(open({ disposition: 'background-tab', features: '' }))).toEqual({
      kind: 'tab',
      url: 'https://accounts.example/oauth',
      background: true,
    });
    for (const disposition of ['default', 'other', 'new-popup-of-some-kind']) {
      expect(routeWindowOpen(open({ disposition, features: '' }))).toMatchObject({
        kind: 'tab',
        background: false,
      });
    }
  });

  it('opens Shift+click (a new window without features) as a tab: Veltriva has one window', () => {
    expect(routeWindowOpen(open({ features: '' }))).toMatchObject({
      kind: 'tab',
      background: false,
    });
    expect(routeWindowOpen(open({ features: 'noopener,noreferrer' }))).toMatchObject({
      kind: 'tab',
    });
  });

  it('never opens a popup window from a popup window: those become tabs', () => {
    expect(routeWindowOpen(open({ fromPopupWindow: true }))).toMatchObject({
      kind: 'tab',
      background: false,
    });
    expect(
      routeWindowOpen(
        open({ fromPopupWindow: true, disposition: 'foreground-tab', hasPostBody: true }),
      ),
    ).toMatchObject({ kind: 'tab' });
  });

  it('keeps a form post to a new tab in a popup window, where Chromium has its body', () => {
    expect(
      routeWindowOpen(open({ disposition: 'foreground-tab', features: '', hasPostBody: true })),
    ).toEqual({
      kind: 'popup-window',
      url: 'https://accounts.example/oauth',
      size: DEFAULT_POPUP_SIZE,
    });
  });

  it('opens about:blank popups, which sign-in libraries navigate afterwards', () => {
    expect(routeWindowOpen(open({ url: '' }))).toMatchObject({
      kind: 'popup-window',
      url: 'about:blank',
    });
    expect(
      routeWindowOpen(open({ url: 'about:blank', disposition: 'foreground-tab', features: '' })),
    ).toMatchObject({
      kind: 'tab',
      url: 'about:blank',
    });
  });

  it('allows a web-origin blob: document but not an opaque one', () => {
    expect(
      routeWindowOpen(open({ url: 'blob:https://accounts.example/0f8c', features: '' })),
    ).toMatchObject({ kind: 'tab' });
    expect(routeWindowOpen(open({ url: 'blob:null/0f8c' }))).toEqual({
      kind: 'deny',
      reason: 'refused-scheme',
    });
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/win.ini',
    'veltriva://settings',
    'app://shell/index.html',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
    'about:srcdoc',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
  ])('refuses %s', (url) => {
    for (const disposition of ['new-window', 'foreground-tab', 'background-tab']) {
      expect(routeWindowOpen(open({ url, disposition }))).toEqual({
        kind: 'deny',
        reason: 'refused-scheme',
      });
    }
  });

  it('hands other apps\u2019 schemes to the protocol guard, as typed', () => {
    for (const url of [
      'mailto:someone@example.invalid',
      'zoommtg://zoom.us/join?confno=1',
      'tel:+1555',
    ]) {
      expect(routeWindowOpen(open({ url, disposition: 'foreground-tab' }))).toEqual({
        kind: 'external',
        url,
      });
    }
  });

  it('denies what does not parse, and Alt+click downloads until M1.4b', () => {
    expect(routeWindowOpen(open({ url: 'http://[bad' }))).toEqual({
      kind: 'deny',
      reason: 'invalid-url',
    });
    expect(routeWindowOpen(open({ disposition: 'save-to-disk', features: '' }))).toEqual({
      kind: 'deny',
      reason: 'download',
    });
  });
});

describe('popupSize', () => {
  it.each([
    ['width=500,height=600', { width: 500, height: 600 }],
    [' WIDTH = 640 , height=480 ', { width: 640, height: 480 }],
    ['width=500px,height=600px', { width: 500, height: 600 }],
    ['width=10,height=10', { width: 240, height: 180 }],
    ['width=99999,height=99999', { width: 1200, height: 900 }],
    ['width=abc', DEFAULT_POPUP_SIZE],
    ['', DEFAULT_POPUP_SIZE],
    ['left=-5000,top=-5000', DEFAULT_POPUP_SIZE],
    ['width=-300,height=-1', { width: 240, height: 180 }],
  ])('%j → %j', (features, size) => {
    expect(popupSize(features)).toEqual(size);
  });
});
