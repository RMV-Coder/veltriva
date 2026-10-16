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
}

export const useUiStore = create<UiStore>()((set) => ({
  omniboxFocusRequest: null,
  requestOmniboxFocus: (tabId) => {
    set({ omniboxFocusRequest: tabId });
  },
  clearOmniboxFocusRequest: () => {
    set({ omniboxFocusRequest: null });
  },
}));
