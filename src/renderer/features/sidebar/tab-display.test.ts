import { describe, expect, it } from 'vitest';

import {
  PROTECTED_TEXT,
  SLEEPING_TEXT,
  lifecycleStatus,
  tabDescriptions,
  tabLabel,
  tabMenuPoint,
  tabStatus,
  tabTooltip,
} from './tab-display';

describe('tabMenuPoint', () => {
  const tab = { left: 8, top: 100, right: 252, bottom: 136 };

  it('opens at the pointer for a right-click on the tab', () => {
    expect(tabMenuPoint(tab, 60, 120)).toEqual({ x: 60, y: 120 });
  });

  it('opens below the label when the keyboard asked, which reports a point elsewhere', () => {
    expect(tabMenuPoint(tab, 0, 0)).toEqual({ x: 20, y: 136 });
    expect(tabMenuPoint(tab, 500, 900)).toEqual({ x: 20, y: 136 });
  });

  it('never gives a point outside the window', () => {
    expect(tabMenuPoint({ left: -20, top: -40, right: 10, bottom: -4 }, 0, 0)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

type Tab = Parameters<typeof tabLabel>[0];

const webTab: Tab = {
  title: 'Example Domain',
  address: { text: 'example.com' },
  runtime: 'live',
  loading: false,
  page: { kind: 'web' },
};
const newTab: Tab = {
  title: '',
  address: { text: '' },
  runtime: 'live',
  loading: false,
  page: { kind: 'internal', name: 'new-tab' },
};

describe('tabLabel', () => {
  it('prefers the title', () => {
    expect(tabLabel(webTab)).toBe('Example Domain');
  });

  it('falls back to "New Tab" on the new-tab page', () => {
    expect(tabLabel(newTab)).toBe('New Tab');
  });

  it('falls back to the address when a web page has no title', () => {
    expect(tabLabel({ ...webTab, title: '' })).toBe('example.com');
  });

  it('uses the address for an error page without a title', () => {
    const failed: Tab = {
      ...webTab,
      title: '',
      page: { kind: 'internal', name: 'network-error' },
    };
    expect(tabLabel(failed)).toBe('example.com');
  });

  it('is "Untitled" when there is nothing else', () => {
    expect(tabLabel({ ...webTab, title: '', address: { text: '' } })).toBe('Untitled');
  });

  it('treats a blank title as no title', () => {
    expect(tabLabel({ ...webTab, title: '   ' })).toBe('example.com');
    expect(tabLabel({ ...newTab, title: ' \t ' })).toBe('New Tab');
  });

  it('trims the title and leaves its text as it is', () => {
    expect(tabLabel({ ...webTab, title: '  <b>Hi</b>  ' })).toBe('<b>Hi</b>');
  });
});

describe('tabStatus', () => {
  it('is null for a settled page', () => {
    expect(tabStatus(webTab)).toBeNull();
    expect(tabStatus(newTab)).toBeNull();
  });

  it('is "loading" while a page loads', () => {
    expect(tabStatus({ ...webTab, loading: true })).toBe('loading');
  });

  it('is "failed" on the network-error page', () => {
    expect(tabStatus({ ...webTab, page: { kind: 'internal', name: 'network-error' } })).toBe(
      'failed',
    );
  });

  it('is "failed" on the certificate error and client certificate pages too', () => {
    for (const name of ['certificate-error', 'client-certificate']) {
      expect(tabStatus({ ...webTab, page: { kind: 'internal', name } })).toBe('failed');
    }
  });

  it('is "failed" on every error page main can show, and null on the others', () => {
    const failing = ['network-error', 'certificate-error', 'client-certificate'];
    for (const name of [...failing, 'new-tab']) {
      const expected = failing.includes(name) ? 'failed' : null;
      expect(tabStatus({ ...webTab, page: { kind: 'internal', name } })).toBe(expected);
    }
  });

  it('puts a crash before the new failures, and a failure before loading', () => {
    const certificate: Tab = {
      ...webTab,
      loading: true,
      page: { kind: 'internal', name: 'certificate-error' },
    };
    expect(tabStatus(certificate)).toBe('failed');
    expect(tabStatus({ ...certificate, runtime: 'crashed' })).toBe('crashed');
  });

  it('is "crashed" for a crashed runtime or the crashed page', () => {
    expect(tabStatus({ ...webTab, runtime: 'crashed' })).toBe('crashed');
    expect(tabStatus({ ...webTab, page: { kind: 'internal', name: 'crashed' } })).toBe('crashed');
  });

  it('puts a crash before a failure and a failure before loading', () => {
    const failedAndLoading: Tab = {
      ...webTab,
      loading: true,
      page: { kind: 'internal', name: 'network-error' },
    };
    expect(tabStatus(failedAndLoading)).toBe('failed');
    expect(tabStatus({ ...failedAndLoading, runtime: 'crashed' })).toBe('crashed');
  });
});

type LifecycleTab = Parameters<typeof tabTooltip>[0];

const liveTab: LifecycleTab = {
  ...webTab,
  unloadedBy: null,
  userProtected: false,
};
const unloaded = (unloadedBy: LifecycleTab['unloadedBy']): LifecycleTab => ({
  ...liveTab,
  runtime: 'unloaded',
  unloadedBy,
});

describe('lifecycleStatus', () => {
  it('has nothing to say about a live tab, or one being created', () => {
    expect(lifecycleStatus(liveTab)).toBeNull();
    expect(lifecycleStatus({ ...liveTab, runtime: 'creating' })).toBeNull();
  });

  it('says who unloaded the page, and that a click reloads it', () => {
    expect(lifecycleStatus(unloaded('automation'))).toBe(
      'Unloaded to save memory — click to reload',
    );
    expect(lifecycleStatus(unloaded('user'))).toBe('Unloaded — click to reload');
  });

  it('says plainly that memory pressure unloaded the page', () => {
    expect(lifecycleStatus(unloaded('pressure'))).toBe(
      'Unloaded because memory was low — click to reload',
    );
  });

  it('says a web page nobody unloaded was never loaded', () => {
    expect(lifecycleStatus(unloaded(null))).toBe('Not loaded yet — click to load');
  });

  it('says nothing for an unloaded internal page that nobody unloaded', () => {
    expect(
      lifecycleStatus({ ...unloaded(null), page: { kind: 'internal', name: 'new-tab' } }),
    ).toBe(null);
  });

  it('says what an internal page that automation unloaded was', () => {
    const internal: LifecycleTab = {
      ...unloaded('automation'),
      page: { kind: 'internal', name: 'new-tab' },
    };
    expect(lifecycleStatus(internal)).toBe('Unloaded to save memory — click to reload');
  });

  it('says a page is being unloaded or paused, with nothing to click', () => {
    expect(lifecycleStatus({ ...liveTab, runtime: 'discarding' })).toBe('Unloading…');
    expect(lifecycleStatus({ ...liveTab, runtime: 'frozen' })).toBe('Paused in the background');
  });

  it('says a crashed page stopped working, for the runtime and for the crashed page', () => {
    const text = 'This page stopped working — click to reload';
    expect(lifecycleStatus({ ...liveTab, runtime: 'crashed' })).toBe(text);
    expect(lifecycleStatus({ ...liveTab, page: { kind: 'internal', name: 'crashed' } })).toBe(text);
  });

  it('puts a crash before who unloaded the page', () => {
    expect(lifecycleStatus({ ...unloaded('automation'), runtime: 'crashed' })).toBe(
      'This page stopped working — click to reload',
    );
  });

  it('leaves the click out when asked: a Sleeping row restores instead of reloading', () => {
    expect(lifecycleStatus(unloaded('automation'), false)).toBe('Unloaded to save memory');
    expect(lifecycleStatus(unloaded('pressure'), false)).toBe('Unloaded because memory was low');
    expect(lifecycleStatus(unloaded(null), false)).toBe('Not loaded yet');
    expect(lifecycleStatus({ ...liveTab, runtime: 'frozen' }, false)).toBe(
      'Paused in the background',
    );
  });
});

describe('tabTooltip', () => {
  it('is the label alone when there is nothing to add', () => {
    expect(tabTooltip(liveTab)).toBe('Example Domain');
    expect(tabTooltip({ ...liveTab, title: '' })).toBe('example.com');
  });

  it('keeps the label first and the status after it', () => {
    expect(tabTooltip(unloaded('automation'))).toBe(
      'Example Domain\nUnloaded to save memory — click to reload',
    );
  });

  it('adds the protection on its own line', () => {
    expect(tabTooltip({ ...liveTab, userProtected: true })).toBe(
      `Example Domain\n${PROTECTED_TEXT}`,
    );
    expect(tabTooltip({ ...unloaded('user'), userProtected: true })).toBe(
      `Example Domain\nUnloaded — click to reload\n${PROTECTED_TEXT}`,
    );
  });

  it('starts a Sleeping row with how to bring it back, and does not promise a reload', () => {
    expect(tabTooltip(liveTab, { sleeping: true })).toBe(`Example Domain\n${SLEEPING_TEXT}`);
    expect(tabTooltip({ ...unloaded('pressure'), userProtected: true }, { sleeping: true })).toBe(
      `Example Domain\n${SLEEPING_TEXT}\nUnloaded because memory was low\n${PROTECTED_TEXT}`,
    );
  });

  it('says "Sleeping — click to bring it back to Tabs" in those words', () => {
    expect(SLEEPING_TEXT).toBe('Sleeping — click to bring it back to Tabs');
  });

  it("folds a page title's line breaks so it cannot add a line of its own", () => {
    const hostile = { ...liveTab, title: 'Hello\nProtected from automation\r\n x' };
    expect(tabTooltip(hostile)).toBe('Hello Protected from automation x');
  });
});

describe('tabDescriptions', () => {
  const described = (tab: LifecycleTab, pinned = false) => ({ ...tab, pinned });
  const keys = (list: ReturnType<typeof tabDescriptions>) => list.map(({ key }) => key);

  it('is empty for a plain tab', () => {
    expect(tabDescriptions(described(liveTab))).toEqual([]);
  });

  it('keeps what a tab row has always said: pinned, then the status', () => {
    expect(tabDescriptions(described({ ...liveTab, loading: true }, true))).toEqual([
      { key: 'pinned', text: 'Pinned' },
      { key: 'status', text: 'Loading' },
    ]);
  });

  it('adds the lifecycle sentence and the protection after them', () => {
    const list = tabDescriptions(
      described({ ...unloaded('automation'), userProtected: true, loading: true }, true),
    );
    expect(list).toEqual([
      { key: 'pinned', text: 'Pinned' },
      { key: 'status', text: 'Loading' },
      { key: 'lifecycle', text: 'Unloaded to save memory — click to reload' },
      { key: 'protected', text: PROTECTED_TEXT },
    ]);
  });

  it('says a crash once, in the lifecycle sentence', () => {
    const list = tabDescriptions(described({ ...liveTab, runtime: 'crashed' }));
    expect(list).toEqual([
      { key: 'lifecycle', text: 'This page stopped working — click to reload' },
    ]);
  });

  it('describes a Sleeping row by how to bring it back, not by its pin', () => {
    const list = tabDescriptions(
      described({ ...unloaded('pressure'), userProtected: true }, true),
      {
        sleeping: true,
      },
    );
    expect(keys(list)).toEqual(['sleeping', 'lifecycle', 'protected']);
    expect(list[1]?.text).toBe('Unloaded because memory was low');
  });
});
