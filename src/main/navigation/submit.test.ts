import { describe, expect, it } from 'vitest';

import { TabManager } from '../tabs/tab-manager';
import type { TabRuntime, TabRuntimeEvents } from '../tabs/tab-manager';
import { submitAddress } from './submit';

const TEMPLATE = 'http://127.0.0.1:4000/search?q={searchTerms}';

function setup() {
  const loads: string[] = [];
  let events: TabRuntimeEvents | undefined;
  const runtime: TabRuntime = {
    load: (url) => loads.push(url),
    goBack: () => undefined,
    goForward: () => undefined,
    reload: () => undefined,
    stop: () => undefined,
    find: () => 0,
    stopFind: () => undefined,
    zoomFactor: () => 1,
    setZoomFactor: () => undefined,
    toggleDevTools: () => undefined,
    exitFullscreen: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    focus: () => undefined,
    destroy: () => undefined,
  };
  let next = 0;
  const tabs = new TabManager({
    createRuntime: (_tabId, tabEvents) => {
      events = tabEvents;
      return runtime;
    },
    newId: () => `tab-${String((next += 1))}`,
    onChange: () => undefined,
  });
  /** The load commits, as Electron would report it. */
  const commit = (url: string): void => {
    events?.committed({ url, sameDocument: false, canGoBack: false, canGoForward: false });
  };
  return { tabs, loads, commit, id: tabs.create() };
}

describe('submitAddress', () => {
  it('navigates to an address', () => {
    const { tabs, loads, id } = setup();
    expect(submitAddress(tabs, id, 'example.com', TEMPLATE)).toBe('navigate');
    expect(loads).toEqual(['https://example.com/']);
  });

  it('loads a typed address without its credentials, and warns once it commits', () => {
    const { tabs, loads, commit, id } = setup();
    expect(submitAddress(tabs, id, 'https://paypal.com@evil.example/login', TEMPLATE)).toBe(
      'navigate',
    );
    expect(loads).toEqual(['https://evil.example/login']);
    commit('https://evil.example/login');
    expect(tabs.get(id)).toMatchObject({
      url: 'https://evil.example/login',
      credentialsRemoved: true,
    });
  });

  it('searches for words, with the query encoded into the template', () => {
    const { tabs, loads, id } = setup();
    expect(submitAddress(tabs, id, 'what is a & b', TEMPLATE)).toBe('search');
    expect(loads).toEqual(['http://127.0.0.1:4000/search?q=what%20is%20a%20%26%20b']);
  });

  it('never navigates to javascript:, it searches for the text', () => {
    const { tabs, loads, id } = setup();
    expect(submitAddress(tabs, id, 'javascript:alert(1)', TEMPLATE)).toBe('search');
    expect(loads).toEqual(['http://127.0.0.1:4000/search?q=javascript%3Aalert(1)']);
  });

  it.each([
    ['ms-msdt:/id', 'ms-msdt:/id'],
    ['zoommtg:join?confno=1', 'zoommtg:join?confno=1'],
    ['user:pass@example.com', 'user:pass@example.com'],
  ])(
    'hands another app’s scheme to the external-protocol guard, never to a search: %s',
    (text, url) => {
      const { tabs, loads, id } = setup();
      const external: string[] = [];
      expect(
        submitAddress(tabs, id, text, TEMPLATE, (asked) => {
          external.push(asked);
        }),
      ).toBe('external');
      // The guard decides (an always-blocked scheme never launches); nothing is loaded or
      // searched for, since the text may hold a password.
      expect(external).toEqual([url]);
      expect(loads).toEqual([]);
    },
  );

  it('opens internal pages without a web contents', () => {
    const { tabs, loads, id } = setup();
    tabs.navigate(id, 'https://a.example/');
    expect(submitAddress(tabs, id, 'veltriva://newtab', TEMPLATE)).toBe('internal');
    expect(tabs.get(id).page).toEqual({ kind: 'internal', name: 'new-tab' });
    expect(loads).toEqual(['https://a.example/']);
  });

  it('does nothing for empty input', () => {
    const { tabs, loads, id } = setup();
    expect(submitAddress(tabs, id, '   ', TEMPLATE)).toBe('none');
    expect(loads).toEqual([]);
  });
});
