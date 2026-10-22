import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FRECENCY_HALF_LIFE_MS } from './frecency';
import { titleRanges } from './highlight';
import {
  RANKING_WEIGHTS,
  rankCandidates,
  SEARCH_PLACEMENTS,
  siteLabel,
  STATE_BOOST,
} from './ranking';
import type { RankedResult, SearchCandidate, SearchPlacement } from './ranking';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** Words that match no title and no site below, so a term can be tested alone. */
const OTHER = ['zzz'];

/** A page with nothing to score: every term is 0. */
function candidate(overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  return {
    pageId: 1,
    url: 'https://example.com/',
    title: 'Untitled',
    site: 'example.com',
    faviconId: null,
    lastVisitAt: NOW - DAY,
    visitCount: 1,
    frecency: 0,
    frecencyAt: NOW,
    tabId: null,
    placement: null,
    textRank: null,
    ...overrides,
  };
}

function only(results: readonly RankedResult[]): RankedResult {
  const [result] = results;
  if (results.length !== 1 || result === undefined) {
    throw new Error(`expected one result, got ${String(results.length)}`);
  }
  return result;
}

/** The one result for one candidate. */
function scored(
  overrides: Partial<SearchCandidate> = {},
  words: readonly string[] = OTHER,
  now: number = NOW,
): RankedResult {
  return only(rankCandidates([candidate(overrides)], words, now));
}

function byPage(results: readonly RankedResult[], pageId: number): RankedResult {
  return only(results.filter((result) => result.pageId === pageId));
}

/** The text term of each rank, in the order given, among candidates with those ranks. */
function textTerms(ranks: readonly (number | null)[]): number[] {
  const results = rankCandidates(
    ranks.map((textRank, index) => candidate({ pageId: index + 1, textRank })),
    OTHER,
    NOW,
  );
  return ranks.map((_rank, index) => byPage(results, index + 1).breakdown.text);
}

function expectAllClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 12);
  });
}

/** `pageId` alone, or `pageId/tabId` when the page is in a tab: one key for each result. */
function keys(results: readonly Pick<SearchCandidate, 'pageId' | 'tabId'>[]): string[] {
  return results.map((result) =>
    result.tabId === null ? String(result.pageId) : `${String(result.pageId)}/${result.tabId}`,
  );
}

describe('the constants', () => {
  it('weighs the terms 1, 0.6, 0.4 and 0.3', () => {
    expect(RANKING_WEIGHTS).toEqual({ text: 1, frecency: 0.6, titleExact: 0.4, siteMatch: 0.3 });
  });

  it('boosts the strip by 0.5, the shelf by 0.3 and the archive by 0.2', () => {
    expect(STATE_BOOST).toEqual({ strip: 0.5, shelf: 0.3, archive: 0.2 });
  });

  it('knows the strip, the shelf and the archive, in that order', () => {
    expect([...SEARCH_PLACEMENTS]).toEqual(['strip', 'shelf', 'archive']);
  });

  it('boosts an open tab more than a sleeping one, and a sleeping one more than an archived one', () => {
    expect(STATE_BOOST.strip).toBeGreaterThan(STATE_BOOST.shelf);
    expect(STATE_BOOST.shelf).toBeGreaterThan(STATE_BOOST.archive);
    expect(STATE_BOOST.archive).toBeGreaterThan(0);
  });
});

describe('siteLabel', () => {
  it.each([
    ['github.com', 'github'],
    ['bbc.co.uk', 'bbc'],
    ['localhost', 'localhost'],
    ['a.b.c', 'a'],
    ['GitHub.com', 'GitHub'],
    ['', ''],
    ['.hidden', ''],
  ])('takes the label of %j to be %j', (site, label) => {
    expect(siteLabel(site)).toBe(label);
  });
});

describe('a candidate with nothing to score', () => {
  it('scores 0 in every term', () => {
    const result = scored();

    expect(result.score).toBe(0);
    expect(result.breakdown).toEqual({
      text: 0,
      frecency: 0,
      titleExact: 0,
      siteMatch: 0,
      state: 0,
      bm25: null,
      frecencyNow: 0,
    });
    expect(result.titleRanges).toEqual([]);
  });
});

describe('the text term', () => {
  it('gives the best match 1', () => {
    expect(textTerms([-10, -5])[0]).toBeCloseTo(1, 12);
    expect(textTerms([-5, -10])[1]).toBeCloseTo(1, 12);
  });

  it('gives a match half as good as the best 0.5, and one a quarter as good 0.25', () => {
    expectAllClose(textTerms([-10, -5]), [1, 0.5]);
    expectAllClose(textTerms([-8, -2]), [1, 0.25]);
  });

  it('keeps the proportions of several candidates', () => {
    expectAllClose(textTerms([-4, -3, -2, -1]), [1, 0.75, 0.5, 0.25]);
  });

  it('keeps near-equal matches near-equal', () => {
    expectAllClose(textTerms([-10, -9.99]), [1, 0.999]);
  });

  it('does not turn the worst match into 0', () => {
    expectAllClose(textTerms([-100, -1]), [1, 0.01]);
    expectAllClose(textTerms([-20, -19, -18]), [1, 0.95, 0.9]);
  });

  it('is the same when every rank is scaled', () => {
    expectAllClose(textTerms([-30, -15, -6]), textTerms([-10, -5, -2]));
    expectAllClose(textTerms([-0.3, -0.15, -0.06]), textTerms([-10, -5, -2]));
  });

  it('does not depend on the order of the candidates', () => {
    expectAllClose(textTerms([-2, -10, -5]), [0.2, 1, 0.5]);
    expectAllClose(textTerms([-5, -2, -10]), [0.5, 0.2, 1]);
  });

  it('gives one candidate 1, whatever its rank', () => {
    expectAllClose(textTerms([-7]), [1]);
    expectAllClose(textTerms([-0.001]), [1]);
    expectAllClose(textTerms([-1e9]), [1]);
  });

  it('gives candidates with equal ranks 1 each', () => {
    expectAllClose(textTerms([-3, -3, -3]), [1, 1, 1]);
  });

  it('gives a candidate without a rank 0, and does not count it in the others', () => {
    expectAllClose(textTerms([-4, null, -2]), [1, 0, 0.5]);
    expectAllClose(textTerms([null, -2]), [0, 1]);
  });

  it('gives 0 to everyone when nobody has a rank', () => {
    expectAllClose(textTerms([null]), [0]);
    expectAllClose(textTerms([null, null, null]), [0, 0, 0]);
  });

  it('gives NaN 0, and does not count it in the others', () => {
    expectAllClose(textTerms([Number.NaN, -10, -5]), [0, 1, 0.5]);
    expectAllClose(textTerms([Number.NaN]), [0]);
  });

  it('gives infinity 0, and does not count it in the others', () => {
    expectAllClose(textTerms([Number.NEGATIVE_INFINITY, -10, -5]), [0, 1, 0.5]);
    expectAllClose(textTerms([Number.POSITIVE_INFINITY, -10, -5]), [0, 1, 0.5]);
    expectAllClose(textTerms([Number.NEGATIVE_INFINITY]), [0]);
    expectAllClose(textTerms([Number.NaN, Number.POSITIVE_INFINITY, null]), [0, 0, 0]);
  });

  it('gives every rank of 0 the full term, since none is worse than another', () => {
    expectAllClose(textTerms([0]), [1]);
    expectAllClose(textTerms([0, 0]), [1, 1]);
  });

  it('gives a rank of 0 nothing next to a negative one', () => {
    expectAllClose(textTerms([-10, 0]), [1, 0]);
  });

  it('clamps a positive rank, which bm25 never gives, to 0', () => {
    expectAllClose(textTerms([-10, 4]), [1, 0]);
    expectAllClose(textTerms([3, 5]), [0, 0]);
    expectAllClose(textTerms([0, 5]), [1, 0]);
  });

  it('is never above the weight, whatever the ranks', () => {
    for (const text of textTerms([-1, -1000, -0.5, null, Number.NaN])) {
      expect(text).toBeLessThanOrEqual(RANKING_WEIGHTS.text);
      expect(text).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports the rank it was given, whatever it did with it', () => {
    const ranks = [-10, null, Number.NaN, Number.NEGATIVE_INFINITY, 0, 4];
    const results = rankCandidates(
      ranks.map((textRank, index) => candidate({ pageId: index + 1, textRank })),
      OTHER,
      NOW,
    );

    ranks.forEach((rank, index) => {
      expect(byPage(results, index + 1).breakdown.bm25).toBe(rank);
    });
  });

  it('gives the better rank the larger term for any negative ranks', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1000, max: -1e-6, noNaN: true }), {
          minLength: 1,
          maxLength: 12,
        }),
        (ranks) => {
          const terms = textTerms(ranks);
          const best = Math.min(...ranks);

          expect(Math.max(...terms)).toBeCloseTo(1, 12);
          ranks.forEach((rank, index) => {
            expect(terms[index]).toBeCloseTo(rank / best, 9);
            ranks.forEach((other, otherIndex) => {
              if (rank < other) {
                expect(terms[index]).toBeGreaterThanOrEqual(terms[otherIndex] ?? Number.NaN);
              }
            });
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the frecency term', () => {
  it('is 0 for a page never visited', () => {
    const result = scored({ frecency: 0 });

    expect(result.breakdown.frecency).toBe(0);
    expect(result.breakdown.frecencyNow).toBe(0);
  });

  it('is 0.6 times log(1 + the score) for a score as of now', () => {
    expect(scored({ frecency: 1 }).breakdown.frecency).toBeCloseTo(0.4158883083359672, 12);
    expect(scored({ frecency: 3 }).breakdown.frecency).toBeCloseTo(0.8317766166719343, 12);
    expect(scored({ frecency: 99 }).breakdown.frecency).toBeCloseTo(2.7631021115928553, 12);
    expect(scored({ frecency: Math.E - 1 }).breakdown.frecency).toBeCloseTo(0.6, 12);
  });

  it('halves the score of 4 after 30 days to 2', () => {
    const result = scored({ frecency: 4, frecencyAt: NOW - 30 * DAY });

    expect(result.breakdown.frecencyNow).toBe(2);
    expect(result.breakdown.frecency).toBeCloseTo(0.6591673732008659, 12);
  });

  it('quarters the score after 60 days', () => {
    expect(scored({ frecency: 8, frecencyAt: NOW - 60 * DAY }).breakdown.frecencyNow).toBe(2);
  });

  it('decays by the half-life of 30 days, in between', () => {
    const result = scored({ frecency: 10, frecencyAt: NOW - 10 * DAY });

    expect(result.breakdown.frecencyNow).toBeCloseTo(10 * 2 ** (-1 / 3), 12);
    expect(FRECENCY_HALF_LIFE_MS).toBe(30 * DAY);
  });

  it('decays to the time of the query, not to the time of the last visit', () => {
    const recorded = { frecency: 4, frecencyAt: NOW - 30 * DAY };

    expect(scored(recorded, OTHER, NOW).breakdown.frecencyNow).toBe(2);
    expect(scored(recorded, OTHER, NOW - 30 * DAY).breakdown.frecencyNow).toBe(4);
    expect(scored(recorded, OTHER, NOW + 30 * DAY).breakdown.frecencyNow).toBe(1);
  });

  it('does not grow for a visit that is after the query', () => {
    const result = scored({ frecency: 6, frecencyAt: NOW + 10 * DAY });

    expect(result.breakdown.frecencyNow).toBe(6);
  });

  it('grows more slowly than the score: a page visited three times is not three times ahead', () => {
    const one = scored({ frecency: 1 }).breakdown.frecency;
    const three = scored({ frecency: 3 }).breakdown.frecency;

    expect(three).toBeGreaterThan(one);
    expect(three).toBeLessThan(3 * one);
  });
});

describe('the title term', () => {
  it('is 0.4 when every word starts a word of the title', () => {
    const result = scored({ title: 'Postgres Indexes' }, ['postgres', 'index']);

    expect(result.breakdown.titleExact).toBe(0.4);
    expect(result.breakdown.titleExact).toBe(RANKING_WEIGHTS.titleExact);
    expect(result.score).toBeCloseTo(0.4, 12);
  });

  it('is 0.4 for one word that starts a word of the title', () => {
    expect(scored({ title: 'Postgres Indexes' }, ['index']).breakdown.titleExact).toBe(0.4);
  });

  it('is 0 when one word is missing from the title', () => {
    expect(scored({ title: 'Postgres Indexes' }, ['postgres', 'mysql']).breakdown.titleExact).toBe(
      0,
    );
  });

  it('is 0 when a word is only in the middle of a title word', () => {
    expect(scored({ title: 'Postgres Indexes' }, ['dex']).breakdown.titleExact).toBe(0);
  });

  it('ignores case and diacritics', () => {
    expect(scored({ title: 'CAFÉ Crème' }, ['cafe', 'creme']).breakdown.titleExact).toBe(0.4);
  });

  it('is 0 when there are no words', () => {
    expect(scored({ title: 'Postgres Indexes' }, []).breakdown.titleExact).toBe(0);
  });

  it('is 0 for an empty title', () => {
    expect(scored({ title: '' }, ['index']).breakdown.titleExact).toBe(0);
  });

  it('does not depend on the url, the site or the text rank', () => {
    const result = scored(
      { title: 'Index', url: 'https://nothing.test/', site: 'nothing.test', textRank: -3 },
      ['index'],
    );

    expect(result.breakdown.titleExact).toBe(0.4);
  });
});

describe('the site term', () => {
  it('is 0.3 when a word is the first label of the site', () => {
    const result = scored({ site: 'github.com' }, ['github']);

    expect(result.breakdown.siteMatch).toBe(0.3);
    expect(result.breakdown.siteMatch).toBe(RANKING_WEIGHTS.siteMatch);
    expect(result.score).toBeCloseTo(0.3, 12);
  });

  it('is 0.3 when any one of the words is the label', () => {
    expect(scored({ site: 'github.com' }, ['pull', 'github', 'requests']).breakdown.siteMatch).toBe(
      0.3,
    );
  });

  it('is 0 when a word is only the start of the label', () => {
    expect(scored({ site: 'github.com' }, ['git']).breakdown.siteMatch).toBe(0);
    expect(scored({ site: 'github.com' }, ['gith']).breakdown.siteMatch).toBe(0);
  });

  it('is 0 when a word is longer than the label', () => {
    expect(scored({ site: 'github.com' }, ['githubs']).breakdown.siteMatch).toBe(0);
  });

  it('is 0 when a word is another label of the site', () => {
    expect(scored({ site: 'github.com' }, ['com']).breakdown.siteMatch).toBe(0);
    expect(scored({ site: 'bbc.co.uk' }, ['co']).breakdown.siteMatch).toBe(0);
    expect(scored({ site: 'bbc.co.uk' }, ['uk']).breakdown.siteMatch).toBe(0);
  });

  it('is 0 for the whole site, which no word can be', () => {
    expect(scored({ site: 'github.com' }, ['github.com']).breakdown.siteMatch).toBe(0);
  });

  it('takes the first label of a site with several', () => {
    expect(scored({ site: 'bbc.co.uk' }, ['bbc']).breakdown.siteMatch).toBe(0.3);
  });

  it('takes a site without a dot to be its own label', () => {
    expect(scored({ site: 'localhost' }, ['localhost']).breakdown.siteMatch).toBe(0.3);
  });

  it('ignores the case of the site', () => {
    expect(scored({ site: 'GitHub.com' }, ['github']).breakdown.siteMatch).toBe(0.3);
  });

  it('is 0 for an empty site, even for an empty word', () => {
    expect(scored({ site: '' }, ['']).breakdown.siteMatch).toBe(0);
    expect(scored({ site: '' }, ['github']).breakdown.siteMatch).toBe(0);
    expect(scored({ site: '.com' }, ['', 'com']).breakdown.siteMatch).toBe(0);
  });

  it('is 0 when there are no words', () => {
    expect(scored({ site: 'github.com' }, []).breakdown.siteMatch).toBe(0);
  });

  it('does not depend on the title', () => {
    expect(scored({ site: 'github.com', title: 'Home' }, ['github']).breakdown.siteMatch).toBe(0.3);
  });
});

describe('the state term', () => {
  it.each<[SearchPlacement | null, number]>([
    ['strip', 0.5],
    ['shelf', 0.3],
    ['archive', 0.2],
    [null, 0],
  ])('adds the boost of a placement of %s: %f', (placement, boost) => {
    const result = scored({ placement });

    expect(result.breakdown.state).toBe(boost);
    expect(result.score).toBe(boost);
  });

  it('is the table in STATE_BOOST', () => {
    for (const placement of SEARCH_PLACEMENTS) {
      expect(scored({ placement }).breakdown.state).toBe(STATE_BOOST[placement]);
    }
  });
});

describe('the score', () => {
  const words = ['github', 'actions'];
  const full = candidate({
    pageId: 1,
    title: 'GitHub Actions',
    site: 'github.com',
    textRank: -8,
    frecency: 4,
    frecencyAt: NOW - 30 * DAY,
    placement: 'strip',
    tabId: 'tab-1',
  });
  const filler = candidate({ pageId: 2, textRank: -4 });

  it('adds the five terms', () => {
    const result = byPage(rankCandidates([full, filler], words, NOW), 1);

    expect(result.breakdown.text).toBeCloseTo(1, 12);
    expect(result.breakdown.frecency).toBeCloseTo(0.6591673732008659, 12);
    expect(result.breakdown.titleExact).toBe(0.4);
    expect(result.breakdown.siteMatch).toBe(0.3);
    expect(result.breakdown.state).toBe(0.5);
    expect(result.score).toBeCloseTo(2.859167373200866, 12);
  });

  it('explains the raw inputs: the bm25 rank and the decayed frecency', () => {
    const result = byPage(rankCandidates([full, filler], words, NOW), 1);

    expect(result.breakdown.bm25).toBe(-8);
    expect(result.breakdown.frecencyNow).toBe(2);
  });

  it('marks the title words, in the original title', () => {
    const result = byPage(rankCandidates([full, filler], words, NOW), 1);

    expect(result.titleRanges).toEqual([
      [0, 6],
      [7, 14],
    ]);
    expect(result.titleRanges).toEqual(titleRanges(full.title, words));
  });

  it('keeps every field of the candidate', () => {
    const result = byPage(rankCandidates([full, filler], words, NOW), 1);

    expect(result).toMatchObject(full);
  });

  it('gives a candidate without a match an empty list of marks', () => {
    const result = byPage(rankCandidates([full, filler], words, NOW), 2);

    expect(result.titleRanges).toEqual([]);
  });

  it('has the terms of its breakdown add up to it', () => {
    for (const result of rankCandidates([full, filler], words, NOW)) {
      const { text, frecency, titleExact, siteMatch, state } = result.breakdown;

      expect(text + frecency + titleExact + siteMatch + state).toBeCloseTo(result.score, 12);
    }
  });
});

describe('the order', () => {
  it('is by score, the highest first', () => {
    const results = rankCandidates(
      [
        candidate({ pageId: 1, frecency: 1 }),
        candidate({ pageId: 2, frecency: 9 }),
        candidate({ pageId: 3, frecency: 3 }),
      ],
      OTHER,
      NOW,
    );

    expect(keys(results)).toEqual(['2', '3', '1']);
    expect(results.map((result) => result.score)).toEqual(
      [...results.map((result) => result.score)].sort((a, b) => b - a),
    );
  });

  it('is empty for no candidates', () => {
    expect(rankCandidates([], ['index'], NOW)).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const input = [candidate({ pageId: 1, frecency: 1 }), candidate({ pageId: 2, frecency: 9 })];
    const frozen = Object.freeze(input.map((entry) => Object.freeze({ ...entry })));

    const results = rankCandidates(frozen, OTHER, NOW);

    expect(results).not.toBe(frozen);
    expect(frozen.map((entry) => entry.pageId)).toEqual([1, 2]);
    expect(keys(results)).toEqual(['2', '1']);
  });
});

describe('the tie-breaks', () => {
  it('prefers the page visited more recently', () => {
    const older = candidate({ pageId: 1, lastVisitAt: NOW - 2 * DAY });
    const newer = candidate({ pageId: 2, lastVisitAt: NOW - DAY });

    expect(keys(rankCandidates([older, newer], OTHER, NOW))).toEqual(['2', '1']);
    expect(keys(rankCandidates([newer, older], OTHER, NOW))).toEqual(['2', '1']);
  });

  it('prefers the lower page id when the visits are as recent', () => {
    const high = candidate({ pageId: 5 });
    const low = candidate({ pageId: 3 });

    expect(keys(rankCandidates([high, low], OTHER, NOW))).toEqual(['3', '5']);
    expect(keys(rankCandidates([low, high], OTHER, NOW))).toEqual(['3', '5']);
  });

  /**
   * Candidates whose scores are exactly equal although their placements differ: the text term makes
   * up for the state boost. A third candidate with rank -10 sets the scale, so a rank of -r has the
   * term r/10 (3/10 is exactly 0.3, and 0.2 + 0.3 is exactly 0.5).
   */
  describe('by placement, strip then shelf then archive then none, for one page', () => {
    type Side = readonly [placement: SearchPlacement | null, textRank: number | null];

    it.each<[string, Side, Side]>([
      ['strip before shelf', ['strip', null], ['shelf', -2]],
      ['strip before archive', ['strip', null], ['archive', -3]],
      ['shelf before archive', ['shelf', -2], ['archive', -3]],
      ['strip before none', ['strip', null], [null, -5]],
      ['shelf before none', ['shelf', null], [null, -3]],
      ['archive before none', ['archive', null], [null, -2]],
    ])('puts %s', (_name, [firstPlacement, firstRank], [secondPlacement, secondRank]) => {
      const scale = candidate({ pageId: 100, textRank: -10 });
      const first = candidate({
        pageId: 7,
        tabId: 'x',
        placement: firstPlacement,
        textRank: firstRank,
      });
      const second = candidate({
        pageId: 7,
        tabId: 'a',
        placement: secondPlacement,
        textRank: secondRank,
      });

      for (const input of [
        [scale, first, second],
        [second, first, scale],
        [second, scale, first],
      ]) {
        const results = rankCandidates(input, OTHER, NOW);
        const a = results.find((result) => result.tabId === 'x');
        const b = results.find((result) => result.tabId === 'a');

        // The precondition: an exact tie, which only the placement can settle (the tab ids
        // would put them the other way round).
        expect(a?.score).toBe(b?.score);
        expect(keys(results)).toEqual(['100', '7/x', '7/a']);
      }
    });
  });

  it('prefers the tab id that sorts first, for one page in one place', () => {
    const b = candidate({ pageId: 7, tabId: 'tab-b', placement: 'strip' });
    const a = candidate({ pageId: 7, tabId: 'tab-a', placement: 'strip' });

    expect(keys(rankCandidates([b, a], OTHER, NOW))).toEqual(['7/tab-a', '7/tab-b']);
    expect(keys(rankCandidates([a, b], OTHER, NOW))).toEqual(['7/tab-a', '7/tab-b']);
  });

  it('puts a page without a tab before the same page in a tab, when nothing else tells them apart', () => {
    const tab = candidate({ pageId: 7, tabId: 'a' });
    const none = candidate({ pageId: 7, tabId: null });

    expect(keys(rankCandidates([tab, none], OTHER, NOW))).toEqual(['7', '7/a']);
  });

  it('compares tab ids as text by code unit, not as numbers and not by locale', () => {
    const results = rankCandidates(
      [
        candidate({ pageId: 7, tabId: 'a' }),
        candidate({ pageId: 7, tabId: '9' }),
        candidate({ pageId: 7, tabId: '10' }),
        candidate({ pageId: 7, tabId: 'B' }),
      ],
      OTHER,
      NOW,
    );

    expect(keys(results)).toEqual(['7/10', '7/9', '7/B', '7/a']);
  });

  it('settles on the score first, whatever the visit, the page id and the tab', () => {
    const better = candidate({ pageId: 9, lastVisitAt: NOW - 90 * DAY, tabId: 'z', frecency: 2 });
    const worse = candidate({ pageId: 1, lastVisitAt: NOW, tabId: 'a', frecency: 1 });

    expect(keys(rankCandidates([worse, better], OTHER, NOW))).toEqual(['9/z', '1/a']);
  });

  it('settles on the visit before the page id', () => {
    const recent = candidate({ pageId: 9, lastVisitAt: NOW });
    const old = candidate({ pageId: 1, lastVisitAt: NOW - DAY });

    expect(keys(rankCandidates([old, recent], OTHER, NOW))).toEqual(['9', '1']);
  });

  it('settles on the page id before the placement', () => {
    const scale = candidate({ pageId: 100, textRank: -10 });
    const lowPage = candidate({ pageId: 1, placement: null, textRank: -5, tabId: null });
    const highPage = candidate({ pageId: 2, placement: 'strip', textRank: null, tabId: 't' });
    const results = rankCandidates([highPage, lowPage, scale], OTHER, NOW);

    expect(byPage(results, 1).score).toBe(byPage(results, 2).score);
    expect(keys(results)).toEqual(['100', '1', '2/t']);
  });

  it('settles on the placement before the tab id', () => {
    const scale = candidate({ pageId: 100, textRank: -10 });
    const strip = candidate({ pageId: 7, placement: 'strip', textRank: null, tabId: 'z' });
    const shelf = candidate({ pageId: 7, placement: 'shelf', textRank: -2, tabId: 'a' });
    const results = rankCandidates([shelf, strip, scale], OTHER, NOW);

    const [tabScore, otherScore] = results
      .filter((result) => result.pageId === 7)
      .map((result) => result.score);
    expect(tabScore).toBe(otherScore);
    expect(keys(results)).toEqual(['100', '7/z', '7/a']);
  });

  it('keeps the order it was given for candidates that tie on everything', () => {
    const first = candidate({ pageId: 7, url: 'https://example.com/first' });
    const second = candidate({ pageId: 7, url: 'https://example.com/second' });

    expect(rankCandidates([first, second], OTHER, NOW).map((result) => result.url)).toEqual([
      'https://example.com/first',
      'https://example.com/second',
    ]);
    expect(rankCandidates([second, first], OTHER, NOW).map((result) => result.url)).toEqual([
      'https://example.com/second',
      'https://example.com/first',
    ]);
  });
});

describe('for any candidates', () => {
  const PLACEMENTS: (SearchPlacement | null)[] = [null, 'strip', 'shelf', 'archive'];
  const RANKS = [null, -10, -5, -2, 0, Number.NaN, Number.NEGATIVE_INFINITY];

  function placementIndex(placement: SearchPlacement | null): number {
    return placement === null ? SEARCH_PLACEMENTS.length : SEARCH_PLACEMENTS.indexOf(placement);
  }

  function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Few values for every field, so that ties are the rule and the tie-breaks all matter. */
  const candidateArbitrary: fc.Arbitrary<SearchCandidate> = fc.record({
    pageId: fc.integer({ min: 1, max: 4 }),
    url: fc.constantFrom('https://example.com/', 'https://github.com/x'),
    title: fc.constantFrom('Untitled', 'GitHub Actions', 'Postgres Indexes', 'Index'),
    site: fc.constantFrom('example.com', 'github.com', 'postgresql.org'),
    faviconId: fc.constantFrom(null, 1),
    lastVisitAt: fc.constantFrom(NOW - 3 * DAY, NOW - DAY, NOW),
    visitCount: fc.integer({ min: 1, max: 4 }),
    frecency: fc.constantFrom(0, 1, 2, 4),
    frecencyAt: fc.constantFrom(NOW - 30 * DAY, NOW),
    tabId: fc.constantFrom<string | null>(null, 'a', 'b', 'c'),
    placement: fc.constantFrom(...PLACEMENTS),
    textRank: fc.constantFrom<number | null>(...RANKS),
  });

  /** A page appears once for each of its tabs, so the page and the tab make a candidate unique. */
  const candidates = fc.uniqueArray(candidateArbitrary, {
    selector: (entry) => `${String(entry.pageId)}/${entry.tabId ?? ''}`,
    minLength: 0,
    maxLength: 10,
  });
  const wordLists = fc.constantFrom<string[]>(
    [],
    ['github'],
    ['index'],
    ['postgres', 'index'],
    OTHER,
  );

  it('gives the same order whatever the order they came in', () => {
    fc.assert(
      fc.property(
        candidates.chain((list) =>
          fc.record({
            list: fc.constant(list),
            shuffled: fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
            words: wordLists,
          }),
        ),
        ({ list, shuffled, words }) => {
          const expected = rankCandidates(list, words, NOW);
          const actual = rankCandidates(shuffled, words, NOW);

          expect(keys(actual)).toEqual(keys(expected));
          expect(actual.map((result) => result.score)).toEqual(
            expected.map((result) => result.score),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('puts the highest score first and settles ties by visit, page, placement and tab', () => {
    fc.assert(
      fc.property(candidates, wordLists, (list, words) => {
        const results = rankCandidates(list, words, NOW);

        for (let index = 1; index < results.length; index += 1) {
          const before = results[index - 1];
          const after = results[index];
          if (before === undefined || after === undefined) {
            throw new Error('missing result');
          }
          const order = [
            after.score - before.score,
            after.lastVisitAt - before.lastVisitAt,
            before.pageId - after.pageId,
            placementIndex(before.placement) - placementIndex(after.placement),
            compareText(before.tabId ?? '', after.tabId ?? ''),
          ].find((difference) => difference !== 0);

          expect(order === undefined || order < 0).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps every candidate once, and has each breakdown add up to its score', () => {
    fc.assert(
      fc.property(candidates, wordLists, (list, words) => {
        const results = rankCandidates(list, words, NOW);

        expect(results).toHaveLength(list.length);
        expect(new Set(keys(results))).toEqual(new Set(keys(list)));
        for (const result of results) {
          const { text, frecency, titleExact, siteMatch, state } = result.breakdown;

          expect(Number.isFinite(result.score)).toBe(true);
          expect(text + frecency + titleExact + siteMatch + state).toBeCloseTo(result.score, 9);
          expect(text).toBeGreaterThanOrEqual(0);
          expect(text).toBeLessThanOrEqual(RANKING_WEIGHTS.text);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('some searches', () => {
  it('puts an open tab above an archived one with the same text, frecency and visit', () => {
    const archived = candidate({ pageId: 1, placement: 'archive', textRank: -5, tabId: 'a' });
    const sleeping = candidate({ pageId: 2, placement: 'shelf', textRank: -5, tabId: 'b' });
    const open = candidate({ pageId: 3, placement: 'strip', textRank: -5, tabId: 'c' });
    const closed = candidate({ pageId: 4, placement: null, textRank: -5 });

    const results = rankCandidates([closed, archived, open, sleeping], OTHER, NOW);

    expect(keys(results)).toEqual(['3/c', '2/b', '1/a', '4']);
    expectAllClose(
      results.map((result) => result.score),
      [1.5, 1.3, 1.2, 1],
    );
  });

  it('puts a much better text match above a state boost', () => {
    const good = candidate({ pageId: 1, textRank: -10, placement: null });
    const open = candidate({ pageId: 2, textRank: -2, placement: 'strip', tabId: 't' });

    const results = rankCandidates([open, good], OTHER, NOW);

    // 1.0 against 0.2 + 0.5.
    expect(keys(results)).toEqual(['1', '2/t']);
  });

  it('puts a nearly as good match in an open tab above a slightly better one that is not open', () => {
    const better = candidate({ pageId: 1, textRank: -10, placement: null });
    const open = candidate({ pageId: 2, textRank: -8, placement: 'strip', tabId: 't' });

    // 1.0 against 0.8 + 0.5.
    expect(keys(rankCandidates([better, open], OTHER, NOW))).toEqual(['2/t', '1']);
  });

  it('puts a page visited lately above one visited often long ago', () => {
    const lately = candidate({ pageId: 2, frecency: 3, frecencyAt: NOW });
    const longAgo = candidate({ pageId: 1, frecency: 64, frecencyAt: NOW - 180 * DAY });

    const results = rankCandidates([longAgo, lately], OTHER, NOW);

    // 64 after six half-lives is 1: 0.6 * ln 2, against 0.6 * ln 4.
    expect(byPage(results, 1).breakdown.frecencyNow).toBe(1);
    expect(byPage(results, 1).breakdown.frecency).toBeCloseTo(0.4158883083359672, 12);
    expect(keys(results)).toEqual(['2', '1']);
  });

  it('puts a title with every word above one with some, at the same text rank', () => {
    const words = ['postgres', 'index'];
    const some = candidate({ pageId: 1, title: 'Postgres Tuning', textRank: -5 });
    const every = candidate({ pageId: 2, title: 'Postgres Indexes', textRank: -5 });

    const results = rankCandidates([some, every], words, NOW);

    expect(keys(results)).toEqual(['2', '1']);
    expect(byPage(results, 2).score - byPage(results, 1).score).toBeCloseTo(0.4, 12);
  });

  it('puts the site a word names above a page that only mentions it', () => {
    const mention = candidate({ pageId: 1, title: 'Notes', site: 'example.org', textRank: -5 });
    const site = candidate({ pageId: 2, title: 'Home', site: 'github.com', textRank: -5 });

    const results = rankCandidates([mention, site], ['github'], NOW);

    expect(keys(results)).toEqual(['2', '1']);
    expect(byPage(results, 2).score - byPage(results, 1).score).toBeCloseTo(0.3, 12);
  });

  it('puts the site whose label is the word above one whose label only begins with it', () => {
    const named = candidate({ pageId: 2, site: 'git.example', textRank: -5 });
    const longer = candidate({ pageId: 1, site: 'github.com', textRank: -5 });

    const results = rankCandidates([longer, named], ['git'], NOW);

    expect(keys(results)).toEqual(['2', '1']);
  });

  it('lists the recent pages by frecency and then by where they are, without any words', () => {
    const rare = candidate({ pageId: 1, frecency: 1 });
    const often = candidate({ pageId: 2, frecency: 5 });
    const open = candidate({ pageId: 3, frecency: 1, placement: 'strip', tabId: 't' });

    const results = rankCandidates([rare, often, open], [], NOW);

    expect(keys(results)).toEqual(['2', '3/t', '1']);
    for (const result of results) {
      expect(result.breakdown.text).toBe(0);
      expect(result.breakdown.titleExact).toBe(0);
      expect(result.breakdown.siteMatch).toBe(0);
      expect(result.titleRanges).toEqual([]);
    }
  });

  it('ranks a typed search the way a person would expect', () => {
    const words = ['postgres', 'index'];
    const guide = candidate({
      pageId: 1,
      title: 'PostgreSQL: Index Types',
      site: 'postgresql.org',
      textRank: -9,
      frecency: 2,
    });
    const blog = candidate({
      pageId: 2,
      title: 'Use the Index, Luke',
      site: 'use-the-index-luke.com',
      textRank: -6,
      frecency: 1,
    });
    const openNotes = candidate({
      pageId: 3,
      title: 'Postgres index notes',
      site: 'notes.example',
      textRank: -4,
      frecency: 0.5,
      placement: 'strip',
      tabId: 'tab-1',
    });
    const stale = candidate({
      pageId: 4,
      title: 'Postgres',
      site: 'example.net',
      textRank: -2,
      frecency: 0,
    });

    const results = rankCandidates([stale, blog, openNotes, guide], words, NOW);

    // guide: 1 + 0.6 ln 3 + 0.4 = 2.059; open notes: 4/9 + 0.6 ln 1.5 + 0.4 + 0.5 = 1.587;
    // blog: 6/9 + 0.6 ln 2 = 1.082; stale: 2/9.
    expect(keys(results)).toEqual(['1', '3/tab-1', '2', '4']);
    expect(byPage(results, 1).score).toBeCloseTo(2.059167373200866, 10);
    expect(byPage(results, 3).score).toBeCloseTo(4 / 9 + 0.6 * Math.log(1.5) + 0.9, 10);
    expect(byPage(results, 2).score).toBeCloseTo(6 / 9 + 0.6 * Math.log(2), 10);
    expect(byPage(results, 4).score).toBeCloseTo(2 / 9, 10);
  });
});
