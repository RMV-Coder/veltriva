// Command implementations. Each one receives input that already passed its strict schema; tab ids
// are checked here, and an unknown one answers `not_found`.
import { app } from 'electron';

import { PRODUCT_NAME } from '../../shared/constants/app-identity';
import { submitAddress } from '../navigation/submit';
import type { TabId, TabManager } from '../tabs/tab-manager';
import type { WorkspaceProjector } from '../tabs/workspace-projector';
import type { LayoutManager } from '../windows/layout-manager';
import { CommandError } from './command-error';
import type { CommandHandlers } from './router';

export interface CommandContext {
  readonly tabs: TabManager;
  readonly layout: LayoutManager;
  readonly projector: WorkspaceProjector;
  readonly searchTemplate: () => string;
}

export function createCommandHandlers({
  tabs,
  layout,
  projector,
  searchTemplate,
}: CommandContext): CommandHandlers {
  /** Runs `action` on an existing tab, or answers `not_found`. */
  const onTab = <T>(tabId: TabId, action: () => T): T => {
    if (!tabs.has(tabId)) {
      throw new CommandError('not_found');
    }
    return action();
  };
  const done = {} as const;

  return {
    'app.getInfo': () => ({
      productName: PRODUCT_NAME,
      version: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
    'workspace.getSnapshot': () => projector.snapshot(),

    'tabs.create': () => ({ tabId: tabs.create() }),
    'tabs.close': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.close(tabId);
        return done;
      }),
    'tabs.select': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.select(tabId);
        return done;
      }),
    'tabs.move': ({ tabId, toIndex }) =>
      onTab(tabId, () => {
        tabs.move(tabId, toIndex);
        return done;
      }),
    'tabs.setPinned': ({ tabId, pinned }) =>
      onTab(tabId, () => {
        tabs.setPinned(tabId, pinned);
        return done;
      }),
    'tabs.duplicate': ({ tabId }) => onTab(tabId, () => ({ tabId: tabs.duplicate(tabId) })),

    'navigation.submit': ({ tabId, text }) =>
      onTab(tabId, () => ({ action: submitAddress(tabs, tabId, text, searchTemplate()) })),
    'navigation.back': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.goBack(tabId);
        return done;
      }),
    'navigation.forward': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.goForward(tabId);
        return done;
      }),
    'navigation.reload': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.reload(tabId);
        return done;
      }),
    'navigation.stop': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.stop(tabId);
        return done;
      }),

    'layout.setInsets': (insets) => {
      layout.setInsets(insets);
      return done;
    },
  };
}
