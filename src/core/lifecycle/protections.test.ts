import { describe, expect, it } from 'vitest';

import { LIFECYCLE_ACTIONS, blockingProtection, protectionFor } from './protections';
import type { LifecycleActionKind, Protection, ProtectionReason } from './protections';

/**
 * What assessment §4.10 says about the reasons M3.1 knows, as implemented. A `Record` over the
 * `ProtectionReason` union: a new reason makes `tsc -b` fail here until it is described.
 */
const TABLE: Readonly<
  Record<ProtectionReason, { hard: boolean; blocks: readonly LifecycleActionKind[] }>
> = {
  'unsaved-input': { hard: true, blocks: ['discard', 'archive'] },
  'page-unsaved-changes': { hard: true, blocks: ['discard', 'archive'] },
  editing: { hard: false, blocks: ['discard', 'archive'] },
  'sensitive-page': { hard: false, blocks: ['discard'] },
  // M3.2: the signals automation must respect from its start (§4.10's rows).
  audio: { hard: true, blocks: ['freeze', 'discard', 'shelve'] },
  capture: { hard: true, blocks: ['freeze', 'discard', 'shelve', 'archive'] },
  devtools: { hard: true, blocks: ['discard'] },
  'open-popup': { hard: true, blocks: ['discard', 'archive'] },
  'recent-interaction': { hard: false, blocks: ['discard', 'shelve', 'archive'] },
  // M3.3: the user's own protection.
  'user-protected': { hard: true, blocks: ['freeze', 'discard', 'shelve', 'archive'] },
};
const REASONS = Object.keys(TABLE) as ProtectionReason[];
/** Every real protection, in the order of TABLE. */
const ALL = REASONS.map((reason) => protectionFor(reason));

/** A protection of our own, so the ordering rules are tested apart from the table. */
const custom = (
  reason: ProtectionReason,
  hard: boolean,
  blocks: readonly LifecycleActionKind[] = ['discard'],
): Protection => ({ reason, hard, blocks });

describe('LIFECYCLE_ACTIONS', () => {
  it('lists the four actions of the protection table, in order', () => {
    expect([...LIFECYCLE_ACTIONS]).toEqual(['freeze', 'discard', 'shelve', 'archive']);
  });
});

describe('protectionFor', () => {
  it.each(REASONS)('describes %s', (reason) => {
    const protection = protectionFor(reason);

    expect(protection.reason).toBe(reason);
    expect(protection.hard).toBe(TABLE[reason].hard);
    expect([...protection.blocks]).toEqual(TABLE[reason].blocks);
  });

  it.each([
    ['unsaved-input', 'hard'],
    ['page-unsaved-changes', 'hard'],
    ['editing', 'soft'],
    ['sensitive-page', 'soft'],
    ['audio', 'hard'],
    ['capture', 'hard'],
    ['devtools', 'hard'],
    ['open-popup', 'hard'],
    ['recent-interaction', 'soft'],
    ['user-protected', 'hard'],
  ] as const)('makes %s %s (assessment §4.10)', (reason, strength) => {
    expect(protectionFor(reason).hard).toBe(strength === 'hard');
  });

  it('is hard for what is certain and soft for each guess', () => {
    // §4.10: unsaved input, `beforeunload`, audio, capture, DevTools and an open popup are hard; a
    // focused contenteditable, a sensitive page and a recent interaction are soft.
    const hard = REASONS.filter((reason) => protectionFor(reason).hard);

    expect(hard.sort()).toEqual([
      'audio',
      'capture',
      'devtools',
      'open-popup',
      'page-unsaved-changes',
      'unsaved-input',
      'user-protected',
    ]);
  });

  it('blocks discard for every reason', () => {
    for (const reason of REASONS) {
      expect(protectionFor(reason).blocks).toContain('discard');
    }
  });

  it('blocks archive for the reasons that would lose work or a live page, not for audio or DevTools', () => {
    expect(
      REASONS.filter((reason) => protectionFor(reason).blocks.includes('archive')).sort(),
    ).toEqual([
      'capture',
      'editing',
      'open-popup',
      'page-unsaved-changes',
      'recent-interaction',
      'unsaved-input',
      'user-protected',
    ]);
    expect(protectionFor('sensitive-page').blocks).toEqual(['discard']);
  });

  it('blocks freeze only for audio and capture, and shelve for those and a recent interaction', () => {
    expect(
      REASONS.filter((reason) => protectionFor(reason).blocks.includes('freeze')).sort(),
    ).toEqual(['audio', 'capture', 'user-protected']);
    expect(
      REASONS.filter((reason) => protectionFor(reason).blocks.includes('shelve')).sort(),
    ).toEqual(['audio', 'capture', 'recent-interaction', 'user-protected']);
  });

  it('blocks only actions that exist, each once', () => {
    for (const reason of REASONS) {
      const { blocks } = protectionFor(reason);

      expect(new Set(blocks).size).toBe(blocks.length);
      for (const action of blocks) {
        expect(LIFECYCLE_ACTIONS).toContain(action);
      }
    }
  });

  it('gives the same answer every time', () => {
    for (const reason of REASONS) {
      expect(protectionFor(reason)).toEqual(protectionFor(reason));
    }
  });
});

describe('blockingProtection', () => {
  const unsaved = protectionFor('unsaved-input');
  const pageUnsaved = protectionFor('page-unsaved-changes');
  const editing = protectionFor('editing');
  const sensitive = protectionFor('sensitive-page');

  describe('with nothing to look at', () => {
    it.each(LIFECYCLE_ACTIONS)('returns null for an empty list and the action %s', (action) => {
      expect(blockingProtection([], action)).toBeNull();
      expect(blockingProtection([], action, { overrideSoft: true })).toBeNull();
    });

    it('returns null for an empty Set, an empty Map of values and an empty generator', () => {
      function* nothing(): Generator<Protection> {
        yield* [];
      }

      expect(blockingProtection(new Set<Protection>(), 'discard')).toBeNull();
      expect(blockingProtection(new Map<string, Protection>().values(), 'discard')).toBeNull();
      expect(blockingProtection(nothing(), 'discard')).toBeNull();
    });
  });

  describe('with one protection', () => {
    it('returns a hard one that blocks the action', () => {
      expect(blockingProtection([unsaved], 'discard')).toBe(unsaved);
      expect(blockingProtection([unsaved], 'archive')).toBe(unsaved);
    });

    it('returns a soft one that blocks the action', () => {
      expect(blockingProtection([editing], 'discard')).toBe(editing);
      expect(blockingProtection([sensitive], 'discard')).toBe(sensitive);
    });

    it('returns null when the protection does not block that action', () => {
      expect(blockingProtection([unsaved], 'freeze')).toBeNull();
      expect(blockingProtection([unsaved], 'shelve')).toBeNull();
      expect(blockingProtection([sensitive], 'archive')).toBeNull();
      expect(blockingProtection([sensitive], 'freeze')).toBeNull();
    });

    it('returns null for a protection that blocks nothing', () => {
      for (const action of LIFECYCLE_ACTIONS) {
        expect(blockingProtection([custom('editing', true, [])], action)).toBeNull();
        expect(blockingProtection([custom('editing', false, [])], action)).toBeNull();
      }
    });

    it('returns exactly the object it was given, not a copy', () => {
      const mine = custom('unsaved-input', true, ['shelve']);

      expect(blockingProtection([mine], 'shelve')).toBe(mine);
    });
  });

  describe('a hard protection before a soft one', () => {
    it('wins when the soft one comes first', () => {
      expect(blockingProtection([editing, unsaved], 'discard')).toBe(unsaved);
    });

    it('wins when the hard one comes first', () => {
      expect(blockingProtection([unsaved, editing], 'discard')).toBe(unsaved);
    });

    it('wins from the middle of a longer list', () => {
      expect(blockingProtection([editing, sensitive, pageUnsaved, editing], 'discard')).toBe(
        pageUnsaved,
      );
    });

    it('wins from the end of a longer list', () => {
      expect(blockingProtection([editing, sensitive, editing, unsaved], 'discard')).toBe(unsaved);
    });

    it('wins with overrideSoft as well', () => {
      expect(blockingProtection([editing, unsaved], 'discard', { overrideSoft: true })).toBe(
        unsaved,
      );
      expect(blockingProtection([unsaved, editing], 'discard', { overrideSoft: true })).toBe(
        unsaved,
      );
    });
  });

  describe('the first hard protection that blocks the action', () => {
    it('is the one returned when there are several', () => {
      expect(blockingProtection([pageUnsaved, unsaved], 'discard')).toBe(pageUnsaved);
      expect(blockingProtection([unsaved, pageUnsaved], 'discard')).toBe(unsaved);
    });

    it('is the one returned even with soft ones before and between', () => {
      expect(blockingProtection([editing, unsaved, sensitive, pageUnsaved], 'discard')).toBe(
        unsaved,
      );
    });

    it('skips a hard one that does not block this action in favour of one that does', () => {
      const hardShelveOnly = custom('unsaved-input', true, ['shelve']);

      expect(blockingProtection([hardShelveOnly, pageUnsaved], 'discard')).toBe(pageUnsaved);
      expect(blockingProtection([hardShelveOnly, pageUnsaved], 'shelve')).toBe(hardShelveOnly);
    });
  });

  describe('soft protections alone', () => {
    it('return the first one that blocks, in the order given', () => {
      expect(blockingProtection([editing, sensitive], 'discard')).toBe(editing);
      expect(blockingProtection([sensitive, editing], 'discard')).toBe(sensitive);
    });

    it('skip one that does not block this action', () => {
      // sensitive-page does not block archive, editing does.
      expect(blockingProtection([sensitive, editing], 'archive')).toBe(editing);
    });

    it('do not block at all under overrideSoft', () => {
      expect(blockingProtection([editing], 'discard', { overrideSoft: true })).toBeNull();
      expect(blockingProtection([sensitive], 'discard', { overrideSoft: true })).toBeNull();
      expect(
        blockingProtection([editing, sensitive], 'archive', { overrideSoft: true }),
      ).toBeNull();
    });

    it('still block when overrideSoft is false', () => {
      expect(blockingProtection([editing], 'discard', { overrideSoft: false })).toBe(editing);
    });

    it('still block when the options are empty', () => {
      expect(blockingProtection([editing], 'discard', {})).toBe(editing);
    });
  });

  describe('hard protections under overrideSoft', () => {
    it('still block', () => {
      expect(blockingProtection([unsaved], 'discard', { overrideSoft: true })).toBe(unsaved);
      expect(blockingProtection([pageUnsaved], 'archive', { overrideSoft: true })).toBe(
        pageUnsaved,
      );
    });

    it('are never ignored, for any hard protection that blocks any action', () => {
      for (const action of LIFECYCLE_ACTIONS) {
        const hard = custom('unsaved-input', true, [action]);

        expect(blockingProtection([hard], action, { overrideSoft: true })).toBe(hard);
        expect(blockingProtection([editing, hard, sensitive], action, { overrideSoft: true })).toBe(
          hard,
        );
      }
    });

    it('do not block an action they do not list, overrideSoft or not', () => {
      expect(blockingProtection([unsaved], 'freeze', { overrideSoft: true })).toBeNull();
    });
  });

  describe('protections that do not block the action', () => {
    it('are skipped, hard or soft', () => {
      const hardFreeze = custom('unsaved-input', true, ['freeze']);
      const softFreeze = custom('editing', false, ['freeze']);

      expect(blockingProtection([hardFreeze, softFreeze], 'discard')).toBeNull();
      expect(blockingProtection([hardFreeze, softFreeze, editing], 'discard')).toBe(editing);
      expect(blockingProtection([hardFreeze, softFreeze, unsaved], 'discard')).toBe(unsaved);
    });

    it('do not make a later soft protection count as hard', () => {
      const hardFreeze = custom('unsaved-input', true, ['freeze']);

      expect(
        blockingProtection([hardFreeze, editing], 'discard', { overrideSoft: true }),
      ).toBeNull();
    });

    it('return null when none of several blocks it', () => {
      expect(blockingProtection([unsaved, pageUnsaved, editing, sensitive], 'freeze')).toBeNull();
      expect(blockingProtection([unsaved, pageUnsaved, editing, sensitive], 'shelve')).toBeNull();
    });
  });

  describe('with the real reasons', () => {
    it('is blocked from discarding by the first hard reason, wherever it sits', () => {
      expect(blockingProtection(ALL, 'discard')?.reason).toBe('unsaved-input');
      // Reversed, the first hard reason is the table's last hard one.
      expect(blockingProtection([...ALL].reverse(), 'discard')?.reason).toBe('user-protected');
    });

    it('is blocked from archiving by the same reasons, and sensitive-page is no part of it', () => {
      expect(blockingProtection(ALL, 'archive')?.reason).toBe('unsaved-input');
      expect(blockingProtection([sensitive], 'archive')).toBeNull();
    });

    it('is blocked from freezing and shelving by audio first, in table order', () => {
      expect(blockingProtection(ALL, 'freeze')?.reason).toBe('audio');
      expect(blockingProtection(ALL, 'shelve')?.reason).toBe('audio');
    });

    it('is blocked by only the soft reasons for a discard, until critical pressure lifts them', () => {
      const soft = ALL.filter((protection) => !protection.hard);

      expect(blockingProtection(soft, 'discard')?.reason).toBe('editing');
      expect(blockingProtection(soft, 'discard', { overrideSoft: true })).toBeNull();
    });
  });

  describe('with an iterable that is not an array', () => {
    it('reads a Set in insertion order', () => {
      expect(blockingProtection(new Set([sensitive, editing]), 'discard')).toBe(sensitive);
      expect(blockingProtection(new Set([editing, unsaved]), 'discard')).toBe(unsaved);
    });

    it('reads the values of a Map', () => {
      const byReason = new Map(ALL.map((protection) => [protection.reason, protection]));

      expect(blockingProtection(byReason.values(), 'discard')?.reason).toBe('unsaved-input');
    });

    it('reads a generator, which can be read only once', () => {
      function* source(): Generator<Protection> {
        yield editing;
        yield pageUnsaved;
        yield sensitive;
      }

      expect(blockingProtection(source(), 'discard')).toBe(pageUnsaved);
    });

    it('stops reading a generator at the first hard protection that blocks', () => {
      const read: ProtectionReason[] = [];
      function* source(): Generator<Protection> {
        for (const protection of [editing, unsaved, pageUnsaved, sensitive]) {
          read.push(protection.reason);
          yield protection;
        }
      }

      expect(blockingProtection(source(), 'discard')).toBe(unsaved);
      expect(read).toEqual(['editing', 'unsaved-input']);
    });

    it('reads a generator to the end when only soft protections block', () => {
      const read: ProtectionReason[] = [];
      function* source(): Generator<Protection> {
        for (const protection of [editing, sensitive]) {
          read.push(protection.reason);
          yield protection;
        }
      }

      expect(blockingProtection(source(), 'discard')).toBe(editing);
      expect(read).toEqual(['editing', 'sensitive-page']);
    });

    it('reads a generator to the end when nothing blocks', () => {
      const read: ProtectionReason[] = [];
      function* source(): Generator<Protection> {
        for (const protection of [sensitive, editing]) {
          read.push(protection.reason);
          yield protection;
        }
      }

      expect(blockingProtection(source(), 'freeze')).toBeNull();
      expect(read).toEqual(['sensitive-page', 'editing']);
    });
  });

  it('does not change the list it was given', () => {
    const list = [editing, unsaved, sensitive];
    const before = [...list];

    blockingProtection(list, 'discard');
    blockingProtection(list, 'discard', { overrideSoft: true });

    expect(list).toEqual(before);
  });
});
