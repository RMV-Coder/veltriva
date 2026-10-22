// Shell-only UI state that components in different places need to share. Nothing here is about
// tabs or navigation; main owns those.
import { create } from 'zustand';

interface UiStore {
  /**
   * A request to focus the address bar once this tab is the selected one, or null. The "New tab"
   * button asks before the new tab is selected, so the address bar acts when the snapshot arrives.
   */
  readonly omniboxFocusRequest: string | null;
  readonly requestOmniboxFocus: (tabId: string) => void;
  readonly clearOmniboxFocusRequest: () => void;
  /**
   * A request to focus the find field, when it was made (`performance.now()`), or null. Main sends
   * `ui.focusFind` right after it opens the find state, usually before the snapshot that draws the
   * bar. The request waits in the store until the field exists, and goes stale if it never does.
   */
  readonly findFocusRequest: number | null;
  readonly requestFindFocus: () => void;
  readonly clearFindFocusRequest: () => void;
  /**
   * Whether the user has the downloads panel open. Which downloads exist is main's; whether the
   * shell shows the list is the shell's. The panel draws only while the list isn't empty.
   */
  readonly downloadsPanelOpen: boolean;
  readonly setDownloadsPanelOpen: (open: boolean) => void;
  /**
   * Whether the sidebar's Sleeping section is open, or null while the user hasn't chosen: it is
   * then open exactly while something sleeps (placement-display.ts). Which tabs sleep is main's;
   * whether the shell lists them is the viewer's, so this is not kept anywhere else.
   */
  readonly sleepingExpanded: boolean | null;
  readonly setSleepingExpanded: (expanded: boolean) => void;
  /** The Archive section: null (not chosen) means closed. */
  readonly archiveExpanded: boolean | null;
  readonly setArchiveExpanded: (expanded: boolean) => void;
  /** The sidebar shows the activity log in place of its sections. */
  readonly activityOpen: boolean;
  readonly setActivityOpen: (open: boolean) => void;
  /**
   * Whether the memory palette is open (M4.2). Main opens it with `ui.openPalette` (Ctrl+Shift+K),
   * the sidebar's "Search memory…" entry point opens it with a click. `paletteOpenCount` counts
   * the requests, so one that arrives while the palette is open can bring its field back into focus.
   */
  readonly paletteOpen: boolean;
  readonly paletteOpenCount: number;
  readonly openPalette: () => void;
  readonly closePalette: () => void;
}

export const useUiStore = create<UiStore>()((set) => ({
  omniboxFocusRequest: null,
  requestOmniboxFocus: (tabId) => {
    set({ omniboxFocusRequest: tabId });
  },
  clearOmniboxFocusRequest: () => {
    set({ omniboxFocusRequest: null });
  },
  findFocusRequest: null,
  requestFindFocus: () => {
    set({ findFocusRequest: performance.now() });
  },
  clearFindFocusRequest: () => {
    set({ findFocusRequest: null });
  },
  downloadsPanelOpen: false,
  setDownloadsPanelOpen: (open) => {
    set({ downloadsPanelOpen: open });
  },
  sleepingExpanded: null,
  setSleepingExpanded: (expanded) => {
    set({ sleepingExpanded: expanded });
  },
  archiveExpanded: null,
  setArchiveExpanded: (expanded) => {
    set({ archiveExpanded: expanded });
  },
  activityOpen: false,
  setActivityOpen: (open) => {
    set({ activityOpen: open });
  },
  paletteOpen: false,
  paletteOpenCount: 0,
  openPalette: () => {
    set((state) => ({ paletteOpen: true, paletteOpenCount: state.paletteOpenCount + 1 }));
  },
  closePalette: () => {
    set({ paletteOpen: false });
  },
}));
