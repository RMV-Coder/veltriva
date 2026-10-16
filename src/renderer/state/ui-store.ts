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
}));
