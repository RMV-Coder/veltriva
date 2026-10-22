import { useEffect, useState } from 'react';

/**
 * The time now (Unix milliseconds), read again every `intervalMs` while the component is mounted:
 * for text such as "2 h ago" that must not stay frozen while the window stays open. The first
 * reading is taken when the component first renders.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
