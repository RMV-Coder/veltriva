import { describe, expect, it } from 'vitest';

import { createLatestRequest } from './latest-request';

describe('createLatestRequest', () => {
  it('counts the only request as the latest', () => {
    const requests = createLatestRequest();
    const ticket = requests.begin();
    expect(requests.isLatest(ticket)).toBe(true);
  });

  it('makes an earlier request stale as soon as a newer one starts', () => {
    const requests = createLatestRequest();
    const first = requests.begin();
    const second = requests.begin();
    expect(requests.isLatest(first)).toBe(false);
    expect(requests.isLatest(second)).toBe(true);
  });

  it('lets a slow answer to an old question be ignored, whatever order the answers arrive in', async () => {
    const requests = createLatestRequest();
    let shown = '';
    const ask = (query: string, delayMs: number): Promise<void> => {
      const ticket = requests.begin();
      return new Promise((resolve) => {
        setTimeout(() => {
          if (requests.isLatest(ticket)) {
            shown = query;
          }
          resolve();
        }, delayMs);
      });
    };
    // "po" is asked first and answers last; "pos" must stay on screen.
    await Promise.all([ask('po', 30), ask('pos', 5)]);
    expect(shown).toBe('pos');
  });

  it('makes everything stale on cancel, and a request after the cancel is current again', () => {
    const requests = createLatestRequest();
    const first = requests.begin();
    requests.cancel();
    expect(requests.isLatest(first)).toBe(false);
    const second = requests.begin();
    expect(requests.isLatest(second)).toBe(true);
    expect(requests.isLatest(first)).toBe(false);
  });

  it('keeps separate trackers apart', () => {
    const a = createLatestRequest();
    const b = createLatestRequest();
    const ticketA = a.begin();
    b.begin();
    b.begin();
    expect(a.isLatest(ticketA)).toBe(true);
  });
});
