import { describe, expect, it } from 'vitest';

import {
  KEPT_AWAKE_PREFIX,
  PROTECTED_TEXT,
  SITE_PROTECTED_TEXT,
  SLEEPING_TEXT,
  TOOLTIP_REASONS,
  keptAwakeAttribute,
  keptAwakeLine,
  lifecycleStatus,
  movedByLine,
  previewLine,
  siteProtectedLine,
  tabDescriptions,
  tabLabel,
  tabMenuPoint,
  tabStatus,
  tabTooltip,
} from './tab-display';
import type { KeptAwakeReason } from './tab-display';

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
  unloadPressure: null,
  userProtected: false,
  keptAwake: [],
  previewMove: null,
  movedBy: null,
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

  it('says how low memory was when it was critical, and "low" for moderate or unknown', () => {
    const pressure = (level: LifecycleTab['unloadPressure']): LifecycleTab => ({
      ...unloaded('pressure'),
      unloadPressure: level,
    });
    expect(lifecycleStatus(pressure('critical'))).toBe(
      'Unloaded because memory was very low — click to reload',
    );
    expect(lifecycleStatus(pressure('critical'), false)).toBe(
      'Unloaded because memory was very low',
    );
    expect(lifecycleStatus(pressure('moderate'))).toBe(
      'Unloaded because memory was low — click to reload',
    );
    expect(lifecycleStatus(pressure(null))).toBe(
      'Unloaded because memory was low — click to reload',
    );
  });

  it('keeps the pressure level out of the other ways a page is unloaded', () => {
    const stale: LifecycleTab = { ...unloaded('automation'), unloadPressure: 'critical' };
    expect(lifecycleStatus(stale)).toBe('Unloaded to save memory — click to reload');
    expect(lifecycleStatus({ ...stale, unloadedBy: 'user' })).toBe('Unloaded — click to reload');
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

  it('adds who moved a Sleeping tab there, after how to bring it back', () => {
    const list = tabDescriptions(described({ ...liveTab, movedBy: 'automation' }, true), {
      sleeping: true,
    });
    expect(list).toEqual([
      { key: 'sleeping', text: SLEEPING_TEXT },
      { key: 'moved', text: 'Moved here by automation' },
    ]);
  });

  it('does not say who moved a tab that is not on a Sleeping row', () => {
    expect(tabDescriptions(described({ ...liveTab, movedBy: 'user' }))).toEqual([]);
  });

  it('names every reason a tab is kept awake, and the site protection and preview, after the rest', () => {
    const list = tabDescriptions(
      described({
        ...liveTab,
        userProtected: true,
        keptAwake: [
          'user-protected',
          'protected-site',
          'audio',
          'fullscreen',
          'capture',
          'video',
          'devtools',
        ],
        previewMove: 'shelve',
      }),
    );
    expect(list).toEqual([
      { key: 'protected', text: PROTECTED_TEXT },
      { key: 'site-protected', text: SITE_PROTECTED_TEXT },
      {
        key: 'kept-awake',
        text: 'Kept awake: playing audio, in full screen, using the camera or microphone, playing media, developer tools are open',
      },
      { key: 'preview', text: 'Preview: would move to Sleeping' },
    ]);
  });

  it('says nothing about the user protection twice', () => {
    const list = tabDescriptions(
      described({ ...liveTab, userProtected: true, keptAwake: ['user-protected'] }),
    );
    expect(list).toEqual([{ key: 'protected', text: PROTECTED_TEXT }]);
  });
});

const reasons = (...list: KeptAwakeReason[]): readonly KeptAwakeReason[] => list;

describe('keptAwakeLine', () => {
  it('is null when nothing keeps the tab awake', () => {
    expect(keptAwakeLine([])).toBeNull();
  });

  it('says what Veltriva observed, in plain words, for every reason', () => {
    const expected: Readonly<Record<KeptAwakeReason, string | null>> = {
      'user-protected': null,
      'protected-site': null,
      fullscreen: 'Kept awake: in full screen',
      capture: 'Kept awake: using the camera or microphone',
      audio: 'Kept awake: playing audio',
      video: 'Kept awake: playing media',
      'page-unsaved-changes': 'Kept awake: page reported unsaved changes',
      'unsaved-input': 'Kept awake: unsaved text in a form',
      'open-popup': 'Kept awake: a sign-in or payment window is open',
      devtools: 'Kept awake: developer tools are open',
      editing: "Kept awake: you're editing",
      'sensitive-page': 'Kept awake: a password or payment page',
      notifications: 'Kept awake: the site can send you notifications',
      'background-activity': 'Kept awake: active in the background',
      'recent-interaction': 'Kept awake: you used it a moment ago',
      // M5.1: it only keeps the tab out of the Archive, and has its own line.
      'excluded-site': null,
    };
    for (const [reason, line] of Object.entries(expected) as [KeptAwakeReason, string | null][]) {
      expect(keptAwakeLine([reason])).toBe(line);
    }
  });

  it('starts every line with the same words', () => {
    expect(keptAwakeLine(reasons('audio'))?.startsWith(KEPT_AWAKE_PREFIX)).toBe(true);
    expect(KEPT_AWAKE_PREFIX).toBe('Kept awake: ');
  });

  it('puts several reasons on one line, in the order main gave them', () => {
    expect(keptAwakeLine(reasons('capture', 'audio'))).toBe(
      'Kept awake: using the camera or microphone, playing audio',
    );
    expect(keptAwakeLine(reasons('audio', 'capture'))).toBe(
      'Kept awake: playing audio, using the camera or microphone',
    );
  });

  it('leaves out the reasons that are said elsewhere: the user protection and the site', () => {
    expect(keptAwakeLine(reasons('user-protected'))).toBeNull();
    expect(keptAwakeLine(reasons('protected-site'))).toBeNull();
    expect(keptAwakeLine(reasons('user-protected', 'protected-site', 'audio'))).toBe(
      'Kept awake: playing audio',
    );
  });

  it('names a reason once', () => {
    expect(keptAwakeLine(reasons('audio', 'audio'))).toBe('Kept awake: playing audio');
  });

  it('names the first few and counts the rest when asked for a short line', () => {
    const many = reasons('fullscreen', 'capture', 'audio', 'video', 'devtools', 'editing');
    expect(keptAwakeLine(many, 3)).toBe(
      'Kept awake: in full screen, using the camera or microphone, playing audio, and 3 more',
    );
    expect(keptAwakeLine(many)).toBe(
      "Kept awake: in full screen, using the camera or microphone, playing audio, playing media, developer tools are open, you're editing",
    );
  });

  it('never says "and 1 more": it names that one instead', () => {
    const four = reasons('fullscreen', 'capture', 'audio', 'video');
    expect(keptAwakeLine(four, 3)).toBe(
      'Kept awake: in full screen, using the camera or microphone, playing audio, playing media',
    );
    expect(keptAwakeLine(reasons('fullscreen', 'capture', 'audio'), 3)).not.toMatch(/more/);
  });

  it('counts only the reasons that make the line when it counts the rest', () => {
    const list = reasons(
      'user-protected',
      'protected-site',
      'audio',
      'video',
      'devtools',
      'editing',
    );
    expect(keptAwakeLine(list, 1)).toBe('Kept awake: playing audio, and 3 more');
  });

  it('always names at least one reason', () => {
    expect(keptAwakeLine(reasons('audio', 'video', 'devtools'), 0)).toBe(
      'Kept awake: playing audio, and 2 more',
    );
    expect(keptAwakeLine(reasons('audio'), -4)).toBe('Kept awake: playing audio');
  });

  it('is a tooltip of three reasons at most', () => {
    expect(TOOLTIP_REASONS).toBe(3);
  });
});

describe('keptAwakeAttribute', () => {
  it('lists every reason main gave, space-separated, or leaves the attribute off', () => {
    expect(keptAwakeAttribute([])).toBeUndefined();
    expect(keptAwakeAttribute(reasons('user-protected', 'audio'))).toBe('user-protected audio');
  });
});

describe('siteProtectedLine', () => {
  it('is said when the tab is kept as it is for its site', () => {
    expect(siteProtectedLine(reasons('audio', 'protected-site'))).toBe(
      'Its site is protected from automation',
    );
  });

  it('is null otherwise', () => {
    expect(siteProtectedLine(reasons('audio', 'user-protected'))).toBeNull();
    expect(siteProtectedLine([])).toBeNull();
  });
});

describe('previewLine', () => {
  it('says what automation would do to the tab', () => {
    expect(previewLine('shelve')).toBe('Preview: would move to Sleeping');
    expect(previewLine('archive')).toBe('Preview: would be archived');
  });

  it('is null when it would do nothing', () => {
    expect(previewLine(null)).toBeNull();
  });
});

describe('movedByLine', () => {
  it('says who put a Sleeping tab there', () => {
    expect(movedByLine('automation')).toBe('Moved here by automation');
    expect(movedByLine('user')).toBe('You moved it here');
  });

  it('says nothing when it is not known', () => {
    expect(movedByLine(null)).toBeNull();
  });
});

describe('the "why" in a tab tooltip', () => {
  it('is still the label alone for a tab nothing is observed about', () => {
    expect(tabTooltip(liveTab)).toBe('Example Domain');
    expect(tabTooltip(liveTab, { sleeping: true })).toBe(`Example Domain\n${SLEEPING_TEXT}`);
  });

  it('says what keeps a tab awake on the line after its label', () => {
    expect(tabTooltip({ ...liveTab, keptAwake: ['audio'] })).toBe(
      'Example Domain\nKept awake: playing audio',
    );
  });

  it('combines several reasons on one line and cuts a long list', () => {
    const tab: LifecycleTab = {
      ...liveTab,
      keptAwake: ['fullscreen', 'capture', 'audio', 'video', 'devtools', 'editing'],
    };
    expect(tabTooltip(tab)).toBe(
      'Example Domain\nKept awake: in full screen, using the camera or microphone, playing audio, and 3 more',
    );
  });

  it('puts the protections before what is observed, then the preview last', () => {
    const tab: LifecycleTab = {
      ...liveTab,
      userProtected: true,
      keptAwake: ['user-protected', 'protected-site', 'audio'],
      previewMove: 'archive',
    };
    expect(tabTooltip(tab)).toBe(
      [
        'Example Domain',
        PROTECTED_TEXT,
        SITE_PROTECTED_TEXT,
        'Kept awake: playing audio',
        'Preview: would be archived',
      ].join('\n'),
    );
  });

  it('says a protected site on its own line, not as "Kept awake"', () => {
    expect(tabTooltip({ ...liveTab, keptAwake: ['protected-site'] })).toBe(
      `Example Domain\n${SITE_PROTECTED_TEXT}`,
    );
  });

  it('says the preview move', () => {
    expect(tabTooltip({ ...liveTab, previewMove: 'shelve' })).toBe(
      'Example Domain\nPreview: would move to Sleeping',
    );
  });

  it('says who moved a Sleeping tab there, right after how to bring it back', () => {
    expect(tabTooltip({ ...liveTab, movedBy: 'automation' }, { sleeping: true })).toBe(
      `Example Domain\n${SLEEPING_TEXT}\nMoved here by automation`,
    );
    expect(tabTooltip({ ...unloaded('pressure'), movedBy: 'user' }, { sleeping: true })).toBe(
      `Example Domain\n${SLEEPING_TEXT}\nYou moved it here\nUnloaded because memory was low`,
    );
  });

  it('does not say who moved a tab that is not on a Sleeping row', () => {
    expect(tabTooltip({ ...liveTab, movedBy: 'automation' })).toBe('Example Domain');
  });

  it('says how low memory was in the tooltip of a tab that pressure unloaded', () => {
    expect(tabTooltip({ ...unloaded('pressure'), unloadPressure: 'critical' })).toBe(
      'Example Domain\nUnloaded because memory was very low — click to reload',
    );
  });
});
