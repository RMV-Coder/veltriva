import { useEffect, useState } from 'react';

import { searchMemory } from '../../state/commands';
import type { MemoryScope, MemorySearch } from '../../state/commands';
import { createLatestRequest } from './latest-request';

interface MemorySearchOptions {
  readonly query: string;
  readonly scope: MemoryScope;
  readonly limit: number;
  /** Search while true. Turning it off drops the answer; turning it on starts afresh. */
  readonly enabled: boolean;
  /** Changing it searches again for the same words (after an open that failed). */
  readonly refresh?: number;
}

/**
 * Searches the memory at every change of the words or the filter: no debounce, each change asks
 * at once (a search is a local database read, a few milliseconds). An answer counts only if it is
 * the answer to the latest question, so a slow reply to "po" never replaces the one for "pos".
 * While a newer question is out, the previous answer stays (no flicker). Null before the first
 * answer, and while disabled.
 */
export function useMemorySearch({
  query,
  scope,
  limit,
  enabled,
  refresh = 0,
}: MemorySearchOptions): MemorySearch | null {
  const [requests] = useState(createLatestRequest);
  const [answer, setAnswer] = useState<MemorySearch | null>(null);
  const [wasEnabled, setWasEnabled] = useState(enabled);

  // A new session starts empty, not with the answer to what was asked last time.
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (enabled) {
      setAnswer(null);
    }
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const ticket = requests.begin();
    void searchMemory(query, scope, limit).then((found) => {
      if (found !== undefined && requests.isLatest(ticket)) {
        setAnswer(found);
      }
    });
    return () => {
      requests.cancel();
    };
  }, [requests, query, scope, limit, enabled, refresh]);

  return enabled ? answer : null;
}
