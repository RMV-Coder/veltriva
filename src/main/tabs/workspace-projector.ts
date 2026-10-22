// WorkspaceProjector (ADR-0005 §2): turns TabManager state into the versioned snapshot the shell
// renders. Changes are coalesced: however many arrive, at most one snapshot goes out per frame.
import { displayUrl } from '../../core/url/display';
import type {
  NoticeSnapshot,
  TabSnapshot,
  WorkspaceSnapshot,
} from '../../shared/contracts/schemas';
import type { AppNotice } from '../notices/app-notices';
import type { BlockedPopupsState } from '../popups/blocked-popups';
import type { Prompt } from '../prompts/prompt-manager';
import type { TabId, TabState } from './tab-manager';

/** About one animation frame. */
export const SNAPSHOT_INTERVAL_MS = 16;

const NO_ADDRESS = { text: '', security: 'neutral', hadCredentials: false } as const;

/** What other parts of main add to a tab's snapshot: the toolbar's question, blocked popups. */
export interface TabExtras {
  readonly prompt?: Prompt | null;
  readonly blockedPopups?: BlockedPopupsState | null;
}

export function projectTab(tab: TabState, extras: TabExtras = {}): TabSnapshot {
  const page =
    tab.page.kind === 'web'
      ? { kind: 'web' as const }
      : tab.page.error === undefined
        ? { kind: 'internal' as const, name: tab.page.name }
        : { kind: 'internal' as const, name: tab.page.name, error: tab.page.error };
  // A new-tab page shows an empty address bar (the shell shows a placeholder).
  const address = tab.url === '' ? NO_ADDRESS : displayUrl(tab.url);
  return {
    id: tab.id,
    pinned: tab.pinned,
    title: tab.title,
    // Credentials are removed either from the committed URL (displayUrl) or, for a typed address,
    // before loading it (TabState.credentialsRemoved). Both warn.
    address: tab.credentialsRemoved ? { ...address, hadCredentials: true } : address,
    favicon: tab.favicon,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    runtime: tab.runtime,
    page,
    zoomPercent: Math.min(Math.max(tab.zoomPercent, 25), 500),
    find: tab.find,
    prompt: projectPrompt(extras.prompt ?? null),
    blockedPopups:
      extras.blockedPopups === undefined || extras.blockedPopups === null
        ? null
        : {
            count: extras.blockedPopups.count,
            latest: displayUrl(extras.blockedPopups.latestUrl).text,
          },
  };
}

function projectPrompt(prompt: Prompt | null): TabSnapshot['prompt'] {
  if (prompt === null) {
    return null;
  }
  if (prompt.kind === 'http-auth') {
    return {
      id: prompt.id,
      kind: prompt.kind,
      site: prompt.site,
      realm: prompt.realm,
      secure: prompt.secure,
    };
  }
  if (prompt.kind === 'leave-page') {
    return { id: prompt.id, kind: prompt.kind, site: prompt.site };
  }
  return prompt.kind === 'permission'
    ? { id: prompt.id, kind: prompt.kind, site: prompt.site, permissions: [...prompt.permissions] }
    : {
        id: prompt.id,
        kind: prompt.kind,
        site: prompt.site,
        scheme: prompt.scheme,
        appName: prompt.appName,
        canRemember: prompt.canRemember,
      };
}

/** What can't be in a file name the shell shows: separators, what Windows forbids, and what hides. */
const NOT_IN_A_FILE_NAME = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_FILE_NAME_LENGTH = 260;
/** Shown when nothing of a name is left. Every real name has more: it ends in a time stamp. */
const UNNAMED_FILE = '(unnamed)';

/**
 * A file name that is safe for the shell to show as text: only what follows the last separator,
 * with every character that has no place in a name (controls, bidi overrides and other invisible
 * formatting, and what Windows forbids) replaced by `_`, as Chromium does for a download's name.
 * The snapshot's schema refuses anything else, and an emit that throws would take main down with
 * it, so a name that arrives in a shape nobody expected is made safe here instead.
 */
export function noticeFileName(name: string): string {
  const last = name.split(/[\\/]/u).at(-1) ?? '';
  let cleaned = '';
  for (const char of last.replace(NOT_IN_A_FILE_NAME, '_')) {
    // Whole characters only: a surrogate pair is never cut in two.
    if (cleaned.length + char.length > MAX_FILE_NAME_LENGTH) {
      break;
    }
    cleaned += char;
  }
  return cleaned === '' ? UNNAMED_FILE : cleaned;
}

/** A moment in Unix milliseconds that the contract accepts. */
function timestamp(ms: number): number {
  return Number.isFinite(ms) ? Math.min(Math.max(Math.trunc(ms), 0), Number.MAX_SAFE_INTEGER) : 0;
}

export function projectNotice(notice: AppNotice): NoticeSnapshot {
  switch (notice.kind) {
    case 'database-restored':
      return {
        id: notice.id,
        kind: notice.kind,
        backupAt: timestamp(notice.backupAt),
        corruptFile: noticeFileName(notice.corruptFile),
      };
    case 'database-reset':
      return { id: notice.id, kind: notice.kind, corruptFile: noticeFileName(notice.corruptFile) };
    case 'session-recovered':
    case 'safe-mode':
      return { id: notice.id, kind: notice.kind };
  }
}

/**
 * What the projector needs of Veltriva's own notices (src/main/notices/app-notices.ts): the list,
 * oldest first, and a way to hear that it changed.
 */
export interface NoticeSource {
  list(): readonly AppNotice[];
  onChange(listener: () => void): () => void;
}

/** Which tab is in HTML fullscreen, and whether the shell should draw the notice (T6). */
export type FullscreenSnapshot = WorkspaceSnapshot['fullscreen'];

export interface WorkspaceProjector {
  /** Something changed: schedule a snapshot (at most one per interval). */
  markDirty(): void;
  /** The current snapshot, with a new version. */
  snapshot(): WorkspaceSnapshot;
  dispose(): void;
}

export function createWorkspaceProjector(options: {
  readonly tabs: () => readonly TabState[];
  readonly selectedTabId: () => string | null;
  readonly fullscreen?: () => FullscreenSnapshot;
  readonly extrasFor?: (tabId: TabId) => TabExtras;
  readonly downloads?: () => WorkspaceSnapshot['downloads'];
  /** Veltriva's own notices. A change to them schedules a snapshot, like any other change. */
  readonly notices?: NoticeSource;
  readonly publish: (snapshot: WorkspaceSnapshot) => void;
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}): WorkspaceProjector {
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    options.cancel ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  let version = 0;
  let pending: unknown;

  const snapshot = (): WorkspaceSnapshot => {
    version += 1;
    return {
      version,
      selectedTabId: options.selectedTabId(),
      tabs: options.tabs().map((tab) => projectTab(tab, options.extrasFor?.(tab.id) ?? {})),
      fullscreen: options.fullscreen?.() ?? null,
      downloads: options.downloads?.() ?? [],
      notices: (options.notices?.list() ?? []).map(projectNotice),
    };
  };

  let disposed = false;

  const markDirty = (): void => {
    // Closing the window disposes the projector, then closes every tab, which marks it dirty.
    if (disposed || pending !== undefined) {
      return;
    }
    pending = schedule(() => {
      pending = undefined;
      options.publish(snapshot());
    }, SNAPSHOT_INTERVAL_MS);
  };
  const stopWatchingNotices = options.notices?.onChange(markDirty);

  return {
    markDirty,
    snapshot,
    dispose() {
      disposed = true;
      stopWatchingNotices?.();
      if (pending !== undefined) {
        cancel(pending);
        pending = undefined;
      }
    },
  };
}
