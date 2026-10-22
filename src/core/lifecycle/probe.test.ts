import { describe, expect, it } from 'vitest';

import { PROBE_TIMEOUT_MS, judgeProbe, parseProbeReading } from './probe';
import type { CloseMode, ProbeReading } from './probe';
import { protectionFor } from './protections';
import type { ProtectionReason } from './protections';

/** An untouched, clean page, unless `overrides` say otherwise. */
const reading = (overrides: Partial<ProbeReading> = {}): ProbeReading => ({
  changedFields: 0,
  editedFields: 0,
  focusedEditable: false,
  sensitive: false,
  hasBeenActive: false,
  flushed: true,
  ...overrides,
});

const FIELDS = [
  'changedFields',
  'editedFields',
  'focusedEditable',
  'sensitive',
  'hasBeenActive',
  'flushed',
] as const;
const COUNT_FIELDS = ['changedFields', 'editedFields'] as const;
const FLAG_FIELDS = ['focusedEditable', 'sensitive', 'hasBeenActive', 'flushed'] as const;

/** `reading()` with `field` left out. */
const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(reading()).filter(([key]) => key !== field));

describe('PROBE_TIMEOUT_MS', () => {
  it('is 100 ms, the budget of assessment §4.9 step 3', () => {
    expect(PROBE_TIMEOUT_MS).toBe(100);
  });
});

describe('parseProbeReading', () => {
  describe('accepts a well-formed reading', () => {
    it('and returns the same six fields', () => {
      const raw = {
        changedFields: 3,
        editedFields: 2,
        focusedEditable: true,
        sensitive: true,
        hasBeenActive: true,
        flushed: false,
      };

      expect(parseProbeReading(raw)).toStrictEqual(raw);
    });

    it('for a quiet page', () => {
      expect(parseProbeReading(reading())).toStrictEqual(reading());
    });

    it('after a round trip through JSON, which is how a renderer answers', () => {
      const raw = reading({ changedFields: 1, hasBeenActive: true });

      expect(parseProbeReading(JSON.parse(JSON.stringify(raw)))).toStrictEqual(raw);
    });

    it('as a new object, not the one it was given', () => {
      const raw = reading();

      expect(parseProbeReading(raw)).not.toBe(raw);
    });

    it('with every boolean combination', () => {
      for (const focusedEditable of [false, true]) {
        for (const sensitive of [false, true]) {
          for (const hasBeenActive of [false, true]) {
            for (const flushed of [false, true]) {
              const raw = reading({ focusedEditable, sensitive, hasBeenActive, flushed });

              expect(parseProbeReading(raw)).toStrictEqual(raw);
            }
          }
        }
      }
    });

    it('from an object with no prototype', () => {
      const raw = Object.assign(Object.create(null) as object, reading({ editedFields: 4 }));

      expect(parseProbeReading(raw)).toStrictEqual(reading({ editedFields: 4 }));
    });

    it('with a count of zero, which is the absence of the thing counted', () => {
      expect(parseProbeReading(reading({ changedFields: 0, editedFields: 0 }))).toMatchObject({
        changedFields: 0,
        editedFields: 0,
      });
    });
  });

  describe('ignores extra fields, and does not copy them into the reading', () => {
    it('whatever they hold', () => {
      const parsed = parseProbeReading({
        ...reading({ changedFields: 1 }),
        extra: 'x',
        nested: { deep: [1, 2, 3] },
        flushedAt: 12,
      });

      expect(parsed).toStrictEqual(reading({ changedFields: 1 }));
      expect(Object.keys(parsed ?? {}).sort()).toEqual([...FIELDS].sort());
    });
  });

  describe('refuses what is not an object', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'ok'],
      ['a JSON string of a good reading', JSON.stringify(reading())],
      ['a number', 1],
      ['NaN', Number.NaN],
      ['true', true],
      ['false', false],
      ['a bigint', 1n],
      ['a symbol', Symbol('reading')],
      ['a function', () => reading()],
    ])('%s', (_name, raw) => {
      expect(parseProbeReading(raw)).toBeNull();
    });

    it.each([
      ['an empty array', []],
      ['an array of readings', [reading()]],
      ['an array of the six values', [0, 0, false, false, false, true]],
    ])('%s', (_name, raw) => {
      expect(parseProbeReading(raw)).toBeNull();
    });

    it('an array even when it carries all six fields as properties', () => {
      const raw = Object.assign([], reading());

      expect(Array.isArray(raw)).toBe(true);
      expect(parseProbeReading(raw)).toBeNull();
    });

    it('an empty object, a Date and a Map, which have none of the fields', () => {
      expect(parseProbeReading({})).toBeNull();
      expect(parseProbeReading(new Date())).toBeNull();
      expect(parseProbeReading(new Map(Object.entries(reading())))).toBeNull();
    });
  });

  describe('refuses a reading with a field missing', () => {
    it.each(FIELDS)('without %s', (field) => {
      expect(parseProbeReading(without(field))).toBeNull();
    });

    it.each(FIELDS)('with %s set to undefined', (field) => {
      expect(parseProbeReading({ ...reading(), [field]: undefined })).toBeNull();
    });

    it.each(FIELDS)('with %s set to null', (field) => {
      expect(parseProbeReading({ ...reading(), [field]: null })).toBeNull();
    });

    it('with only one field present', () => {
      for (const field of FIELDS) {
        expect(parseProbeReading({ [field]: reading()[field] })).toBeNull();
      }
    });
  });

  describe('refuses a count that is not a count', () => {
    describe.each(COUNT_FIELDS)('in %s', (field) => {
      it.each([
        ['a negative number', -1],
        ['a negative number far below zero', -1_000_000],
        ['a fraction', 0.5],
        ['a fraction above one', 2.5],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['-Infinity', Number.NEGATIVE_INFINITY],
        ['one more than a million', 1_000_001],
        ['the largest safe integer', Number.MAX_SAFE_INTEGER],
        ['a number past what a double can count exactly', 1e21],
        ['the largest double', Number.MAX_VALUE],
        ['a numeric string', '3'],
        ['an empty string', ''],
        ['a boolean', true],
        ['a boolean false', false],
        ['a bigint', 3n],
        ['an object', { n: 3 }],
        ['an array', [3]],
        ['a Number object', Object(3) as unknown],
      ])('%s', (_name, value) => {
        expect(parseProbeReading({ ...reading(), [field]: value })).toBeNull();
      });

      it.each([0, 1, 2, 17, 999_999, 1_000_000])('accepts %i', (value) => {
        expect(parseProbeReading({ ...reading(), [field]: value })).toMatchObject({
          [field]: value,
        });
      });
    });

    it('puts the limit between one million and one million and one', () => {
      expect(parseProbeReading(reading({ changedFields: 1_000_000 }))).not.toBeNull();
      expect(parseProbeReading(reading({ changedFields: 1_000_001 }))).toBeNull();
      expect(parseProbeReading(reading({ editedFields: 1_000_000 }))).not.toBeNull();
      expect(parseProbeReading(reading({ editedFields: 1_000_001 }))).toBeNull();
    });

    it('also when the other count is fine', () => {
      expect(parseProbeReading(reading({ changedFields: 2, editedFields: -1 }))).toBeNull();
      expect(parseProbeReading(reading({ changedFields: -1, editedFields: 2 }))).toBeNull();
    });
  });

  describe('refuses a flag that is not a boolean', () => {
    describe.each(FLAG_FIELDS)('in %s', (field) => {
      it.each([
        ['the string "true"', 'true'],
        ['the string "false"', 'false'],
        ['the number 1', 1],
        ['the number 0', 0],
        ['an empty string', ''],
        ['an object', {}],
        ['an array', []],
        ['a Boolean object', Object(true) as unknown],
        ['a bigint', 1n],
      ])('%s', (_name, value) => {
        expect(parseProbeReading({ ...reading(), [field]: value })).toBeNull();
      });
    });
  });

  it('does not change what it was given', () => {
    const raw = Object.freeze({ ...reading({ editedFields: 1 }), extra: 1 });

    expect(parseProbeReading(raw)).toStrictEqual(reading({ editedFields: 1 }));
    expect(raw).toStrictEqual({ ...reading({ editedFields: 1 }), extra: 1 });
  });
});

describe('judgeProbe', () => {
  const keep = (reason: ProtectionReason | 'probe-unanswered') => ({ kind: 'keep', reason });
  const close = (mode: CloseMode) => ({ kind: 'close', mode });

  describe('when the probe did not answer', () => {
    it('keeps the tab with probe-unanswered', () => {
      expect(judgeProbe(null)).toEqual(keep('probe-unanswered'));
    });

    it('keeps it even under critical memory pressure: unknown is not a soft protection', () => {
      expect(judgeProbe(null, { overrideSoft: true })).toEqual(keep('probe-unanswered'));
      expect(judgeProbe(null, { overrideSoft: false })).toEqual(keep('probe-unanswered'));
    });
  });

  describe('a quiet page', () => {
    it('closes with a plain close() when the user never activated it', () => {
      expect(judgeProbe(reading())).toEqual(close('plain'));
    });

    it('closes with the beforeunload check when the user activated it', () => {
      expect(judgeProbe(reading({ hasBeenActive: true }))).toEqual(close('beforeunload'));
    });

    it('does so with or without overrideSoft', () => {
      expect(judgeProbe(reading(), { overrideSoft: true })).toEqual(close('plain'));
      expect(judgeProbe(reading(), { overrideSoft: false })).toEqual(close('plain'));
      expect(judgeProbe(reading({ hasBeenActive: true }), { overrideSoft: true })).toEqual(
        close('beforeunload'),
      );
    });

    it('does not mind that the flush failed: flushed is not a reason to keep the tab', () => {
      expect(judgeProbe(reading({ flushed: false }))).toEqual(close('plain'));
      expect(judgeProbe(reading({ flushed: false, hasBeenActive: true }))).toEqual(
        close('beforeunload'),
      );
    });

    it('returns a verdict with only the fields of its kind', () => {
      expect(Object.keys(judgeProbe(reading())).sort()).toEqual(['kind', 'mode']);
      expect(Object.keys(judgeProbe(null)).sort()).toEqual(['kind', 'reason']);
    });
  });

  describe('typed input the tracker saw (editedFields)', () => {
    it.each([false, true])('is unsaved input when hasBeenActive is %s', (hasBeenActive) => {
      expect(judgeProbe(reading({ editedFields: 1, hasBeenActive }))).toEqual(
        keep('unsaved-input'),
      );
    });

    it('counts however many fields there are', () => {
      expect(judgeProbe(reading({ editedFields: 1_000_000 }))).toEqual(keep('unsaved-input'));
    });

    it('is hard: overrideSoft does not release it', () => {
      expect(judgeProbe(reading({ editedFields: 1 }), { overrideSoft: true })).toEqual(
        keep('unsaved-input'),
      );
      expect(
        judgeProbe(reading({ editedFields: 1, hasBeenActive: true }), { overrideSoft: true }),
      ).toEqual(keep('unsaved-input'));
    });

    it('is unsaved input on an untouched page whatever its changed fields are', () => {
      expect(judgeProbe(reading({ changedFields: 3, editedFields: 1 }))).toEqual(
        keep('unsaved-input'),
      );
    });
  });

  describe('changed form fields (changedFields)', () => {
    it('are unsaved input on a page the user activated', () => {
      expect(judgeProbe(reading({ changedFields: 1, hasBeenActive: true }))).toEqual(
        keep('unsaved-input'),
      );
      expect(judgeProbe(reading({ changedFields: 5, hasBeenActive: true }))).toEqual(
        keep('unsaved-input'),
      );
    });

    it('are not, on an untouched page: its own script (a prefilled search box) set them', () => {
      expect(judgeProbe(reading({ changedFields: 1, hasBeenActive: false }))).toEqual(
        close('plain'),
      );
      expect(judgeProbe(reading({ changedFields: 99, hasBeenActive: false }))).toEqual(
        close('plain'),
      );
    });

    it('are hard on an activated page: overrideSoft does not release them', () => {
      expect(
        judgeProbe(reading({ changedFields: 1, hasBeenActive: true }), { overrideSoft: true }),
      ).toEqual(keep('unsaved-input'));
    });

    it('do not count when there are none, even on an activated page', () => {
      expect(judgeProbe(reading({ changedFields: 0, hasBeenActive: true }))).toEqual(
        close('beforeunload'),
      );
    });

    it('on an untouched page still leave the soft checks to decide', () => {
      expect(judgeProbe(reading({ changedFields: 3, focusedEditable: true }))).toEqual(
        keep('editing'),
      );
      expect(judgeProbe(reading({ changedFields: 3, sensitive: true }))).toEqual(
        keep('sensitive-page'),
      );
      expect(
        judgeProbe(reading({ changedFields: 3, sensitive: true }), { overrideSoft: true }),
      ).toEqual(close('plain'));
    });
  });

  describe('a focused contenteditable (focusedEditable)', () => {
    it('is editing, a soft reason, on an untouched page', () => {
      expect(judgeProbe(reading({ focusedEditable: true }))).toEqual(keep('editing'));
    });

    it('is editing on an activated page as well', () => {
      expect(judgeProbe(reading({ focusedEditable: true, hasBeenActive: true }))).toEqual(
        keep('editing'),
      );
    });

    it('lets the discard go ahead under overrideSoft, by the activation of the page', () => {
      expect(judgeProbe(reading({ focusedEditable: true }), { overrideSoft: true })).toEqual(
        close('plain'),
      );
      expect(
        judgeProbe(reading({ focusedEditable: true, hasBeenActive: true }), {
          overrideSoft: true,
        }),
      ).toEqual(close('beforeunload'));
    });

    it('still blocks when overrideSoft is explicitly false', () => {
      expect(judgeProbe(reading({ focusedEditable: true }), { overrideSoft: false })).toEqual(
        keep('editing'),
      );
    });
  });

  describe('a sensitive page (password or payment fields)', () => {
    it('is sensitive-page, a soft reason, on an untouched page', () => {
      expect(judgeProbe(reading({ sensitive: true }))).toEqual(keep('sensitive-page'));
    });

    it('is sensitive-page on an activated page as well', () => {
      expect(judgeProbe(reading({ sensitive: true, hasBeenActive: true }))).toEqual(
        keep('sensitive-page'),
      );
    });

    it('lets the discard go ahead under overrideSoft, by the activation of the page', () => {
      expect(judgeProbe(reading({ sensitive: true }), { overrideSoft: true })).toEqual(
        close('plain'),
      );
      expect(
        judgeProbe(reading({ sensitive: true, hasBeenActive: true }), { overrideSoft: true }),
      ).toEqual(close('beforeunload'));
    });

    it('still blocks when overrideSoft is explicitly false', () => {
      expect(judgeProbe(reading({ sensitive: true }), { overrideSoft: false })).toEqual(
        keep('sensitive-page'),
      );
    });
  });

  describe('the order of the reasons', () => {
    it('puts typed input before an activated changed field, a focused editor and a sensitive page', () => {
      expect(
        judgeProbe(
          reading({
            editedFields: 1,
            changedFields: 1,
            hasBeenActive: true,
            focusedEditable: true,
            sensitive: true,
          }),
        ),
      ).toEqual(keep('unsaved-input'));
    });

    it('puts an activated changed field before a focused editor and a sensitive page', () => {
      expect(
        judgeProbe(
          reading({
            changedFields: 1,
            hasBeenActive: true,
            focusedEditable: true,
            sensitive: true,
          }),
        ),
      ).toEqual(keep('unsaved-input'));
    });

    it('puts a focused editor before a sensitive page', () => {
      expect(judgeProbe(reading({ focusedEditable: true, sensitive: true }))).toEqual(
        keep('editing'),
      );
      expect(
        judgeProbe(reading({ focusedEditable: true, sensitive: true, hasBeenActive: true })),
      ).toEqual(keep('editing'));
    });

    it('lets a hard reason win over every soft one, with or without overrideSoft', () => {
      const all = reading({
        editedFields: 1,
        focusedEditable: true,
        sensitive: true,
        hasBeenActive: true,
      });

      expect(judgeProbe(all)).toEqual(keep('unsaved-input'));
      expect(judgeProbe(all, { overrideSoft: true })).toEqual(keep('unsaved-input'));
    });

    it('closes once overrideSoft has removed both soft reasons together', () => {
      expect(
        judgeProbe(reading({ focusedEditable: true, sensitive: true }), { overrideSoft: true }),
      ).toEqual(close('plain'));
    });
  });

  describe('over every possible reading', () => {
    const booleans = [false, true] as const;
    const counts = [0, 1, 7] as const;
    const readings: ProbeReading[] = [];
    for (const changedFields of counts) {
      for (const editedFields of counts) {
        for (const focusedEditable of booleans) {
          for (const sensitive of booleans) {
            for (const hasBeenActive of booleans) {
              for (const flushed of booleans) {
                readings.push({
                  changedFields,
                  editedFields,
                  focusedEditable,
                  sensitive,
                  hasBeenActive,
                  flushed,
                });
              }
            }
          }
        }
      }
    }

    it('covers every combination', () => {
      expect(readings).toHaveLength(3 * 3 * 2 * 2 * 2 * 2);
    });

    it('closes only when nothing hard is found, and by the activation of the page', () => {
      for (const r of readings) {
        for (const overrideSoft of booleans) {
          const verdict = judgeProbe(r, { overrideSoft });
          const hard = r.editedFields > 0 || (r.hasBeenActive && r.changedFields > 0);

          if (verdict.kind === 'close') {
            expect(hard).toBe(false);
            expect(verdict.mode).toBe(r.hasBeenActive ? 'beforeunload' : 'plain');
          } else {
            expect(verdict.reason).not.toBe('probe-unanswered');
          }
        }
      }
    });

    it('keeps for a soft reason without overrideSoft, and only for a hard one with it', () => {
      for (const r of readings) {
        const hard = r.editedFields > 0 || (r.hasBeenActive && r.changedFields > 0);
        const soft = r.focusedEditable || r.sensitive;

        const normal = judgeProbe(r);
        const pressured = judgeProbe(r, { overrideSoft: true });

        expect(normal.kind).toBe(hard || soft ? 'keep' : 'close');
        expect(pressured.kind).toBe(hard ? 'keep' : 'close');
        if (pressured.kind === 'keep') {
          expect(pressured.reason).toBe('unsaved-input');
        }
      }
    });

    it('does not depend on flushed', () => {
      for (const r of readings) {
        expect(judgeProbe({ ...r, flushed: !r.flushed })).toEqual(judgeProbe(r));
        expect(judgeProbe({ ...r, flushed: !r.flushed }, { overrideSoft: true })).toEqual(
          judgeProbe(r, { overrideSoft: true }),
        );
      }
    });

    it('only keeps for reasons that block a discard, and overrideSoft releases exactly the soft ones', () => {
      for (const r of readings) {
        const normal = judgeProbe(r);
        if (normal.kind === 'keep' && normal.reason !== 'probe-unanswered') {
          const protection = protectionFor(normal.reason);
          const pressured = judgeProbe(r, { overrideSoft: true });

          expect(protection.blocks).toContain('discard');
          expect(pressured.kind === 'keep').toBe(protection.hard);
        }
      }
    });
  });

  it('does not change the reading it was given', () => {
    const r = Object.freeze(reading({ editedFields: 2, focusedEditable: true }));

    expect(judgeProbe(r)).toEqual(keep('unsaved-input'));
    expect(r).toStrictEqual(reading({ editedFields: 2, focusedEditable: true }));
  });
});
