import { describe, expect, it } from 'vitest';

import {
  CLEAR_RANGE_LABELS,
  CLEAR_RANGE_ORDER,
  clearedText,
  groupByOrigin,
  hintsText,
  originText,
  PERMISSION_LABELS,
} from './privacy-display';

describe('clearedText', () => {
  it.each([
    [{ pages: 1, visits: 1, tabs: 0 }, 'Removed 1 page and 1 visit.'],
    [
      { pages: 12, visits: 40, tabs: 3 },
      'Removed 12 pages, 40 visits and 3 archived or closed tabs.',
    ],
    [{ pages: 0, visits: 5, tabs: 0 }, 'Removed 5 visits.'],
    [{ pages: 0, visits: 0, tabs: 1 }, 'Removed 1 archived or closed tab.'],
    [{ pages: 2000, visits: 0, tabs: 0 }, 'Removed 2,000 pages.'],
    [{ pages: 0, visits: 0, tabs: 0 }, 'Done. Nothing in the memory matched.'],
  ])('says %j as "%s"', (result, text) => {
    expect(clearedText(result)).toBe(text);
  });
});

describe('the ranges and permissions', () => {
  it('names every range, in order', () => {
    expect(CLEAR_RANGE_ORDER.map((range) => CLEAR_RANGE_LABELS[range])).toEqual([
      'The last hour',
      'The last 24 hours',
      'The last 7 days',
      'Everything',
    ]);
  });

  it('names every permission in plain words', () => {
    expect(Object.values(PERMISSION_LABELS)).toEqual([
      'Camera',
      'Microphone',
      'Location',
      'Notifications',
      'See what you copied',
    ]);
  });
});

describe('originText', () => {
  it.each([
    ['https://meet.example.com', 'meet.example.com'],
    ['https://example.com:8443', 'example.com:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['not an origin', 'not an origin'],
  ])('shows %s as %s', (origin, text) => {
    expect(originText(origin)).toBe(text);
  });
});

describe('groupByOrigin', () => {
  it("puts each origin's answers together, origins in order", () => {
    expect(
      groupByOrigin({
        decisions: [
          { origin: 'https://zoom.example', permission: 'camera', decision: 'allow' },
          { origin: 'https://a.example', permission: 'notifications', decision: 'block' },
          { origin: 'https://zoom.example', permission: 'microphone', decision: 'allow' },
        ],
        protocols: [{ origin: 'https://zoom.example', scheme: 'zoommtg' }],
        clientHints: [{ origin: 'https://b.example', hints: ['sec-ch-ua-arch'] }],
      }),
    ).toEqual([
      {
        origin: 'https://a.example',
        decisions: [{ permission: 'notifications', decision: 'block' }],
        protocols: [],
        hints: [],
      },
      { origin: 'https://b.example', decisions: [], protocols: [], hints: ['sec-ch-ua-arch'] },
      {
        origin: 'https://zoom.example',
        decisions: [
          { permission: 'camera', decision: 'allow' },
          { permission: 'microphone', decision: 'allow' },
        ],
        protocols: ['zoommtg'],
        hints: [],
      },
    ]);
  });

  it('is empty for no answers', () => {
    expect(groupByOrigin({ decisions: [], protocols: [], clientHints: [] })).toEqual([]);
  });
});

describe('hintsText', () => {
  it('names what the site asked for', () => {
    expect(hintsText(['sec-ch-ua-arch', 'sec-ch-ua-model'])).toBe(
      'Sends more about your browser and device (sec-ch-ua-arch, sec-ch-ua-model)',
    );
  });
});
