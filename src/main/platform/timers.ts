// The process's own timers behind core's Timers port (core/lifecycle/discard.ts), so code that
// keeps deadlines takes them injected and tests decide when they pass.
import type { Timers } from '../../core/lifecycle/discard';

export const SYSTEM_TIMERS: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
