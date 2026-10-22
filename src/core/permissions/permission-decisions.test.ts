import { describe, expect, it, vi } from 'vitest';

import { DISMISSALS_BEFORE_EMBARGO, PermissionDecisions } from './permission-decisions';
import type { StoredDecision } from './permission-decisions';
import { PROMPTED_PERMISSIONS } from './permission-policy';
import type { Decision, PromptedPermission } from './permission-policy';

const SITE = 'https://meet.example';
const OTHER = 'https://other.example';

const stored = (
  origin: string,
  permission: string,
  decision: Decision = 'allow',
): StoredDecision => ({ origin, permission, decision });

describe('PermissionDecisions: stored decisions', () => {
  it('starts from the decisions it is given, allow and block', () => {
    const decisions = new PermissionDecisions({
      stored: [
        stored(SITE, 'camera', 'allow'),
        stored(SITE, 'microphone', 'block'),
        stored(OTHER, 'geolocation', 'allow'),
      ],
    });

    expect(decisions.get(SITE, 'camera')).toBe('allow');
    expect(decisions.get(SITE, 'microphone')).toBe('block');
    expect(decisions.get(OTHER, 'geolocation')).toBe('allow');
  });

  it.each(PROMPTED_PERMISSIONS)('loads a stored decision for %s', (permission) => {
    const decisions = new PermissionDecisions({ stored: [stored(SITE, permission, 'block')] });

    expect(decisions.get(SITE, permission)).toBe('block');
  });

  it('keeps each decision to its own origin and permission', () => {
    const decisions = new PermissionDecisions({ stored: [stored(SITE, 'camera', 'allow')] });

    expect(decisions.get(SITE, 'microphone')).toBeUndefined();
    expect(decisions.get(OTHER, 'camera')).toBeUndefined();
    expect(decisions.get('http://meet.example', 'camera')).toBeUndefined();
    expect(decisions.get('https://meet.example:8443', 'camera')).toBeUndefined();
  });

  it.each([
    ['a permission it does not prompt for', 'midi'],
    ['an external protocol row', 'protocol:zoommtg'],
    ['the media request, which is camera and microphone', 'media'],
    ['openExternal', 'openExternal'],
    ['fullscreen', 'fullscreen'],
    ['an empty name', ''],
    ['a name in other letters', 'Camera'],
    ['a name with a space', 'camera '],
    ['an object property name', 'constructor'],
    ['a prototype key', '__proto__'],
  ])('skips %s', (_what, permission) => {
    const decisions = new PermissionDecisions({ stored: [stored(SITE, permission, 'allow')] });

    for (const known of PROMPTED_PERMISSIONS) {
      expect(decisions.get(SITE, known), known).toBeUndefined();
    }
  });

  it('skips the unknown ones and keeps the known ones among them', () => {
    const decisions = new PermissionDecisions({
      stored: [
        stored(SITE, 'midi', 'allow'),
        stored(SITE, 'camera', 'allow'),
        stored(SITE, 'protocol:zoommtg', 'allow'),
        stored(SITE, 'notifications', 'block'),
      ],
    });

    expect(decisions.get(SITE, 'camera')).toBe('allow');
    expect(decisions.get(SITE, 'notifications')).toBe('block');
  });

  it('lets a later row for the same origin and permission win', () => {
    const decisions = new PermissionDecisions({
      stored: [stored(SITE, 'camera', 'allow'), stored(SITE, 'camera', 'block')],
    });

    expect(decisions.get(SITE, 'camera')).toBe('block');
  });

  it('takes any iterable of rows', () => {
    const rows = new Set([stored(SITE, 'camera', 'allow')]);
    function* generated(): Generator<StoredDecision> {
      yield stored(OTHER, 'microphone', 'block');
    }

    expect(new PermissionDecisions({ stored: rows }).get(SITE, 'camera')).toBe('allow');
    expect(new PermissionDecisions({ stored: generated() }).get(OTHER, 'microphone')).toBe('block');
  });

  it('is empty with no options, and with no rows', () => {
    for (const decisions of [
      new PermissionDecisions(),
      new PermissionDecisions({}),
      new PermissionDecisions({ stored: [] }),
    ]) {
      for (const permission of PROMPTED_PERMISSIONS) {
        expect(decisions.get(SITE, permission)).toBeUndefined();
      }
    }
  });

  it('does not report what it loaded to onDecided: a stored decision is already stored', () => {
    const onDecided = vi.fn();

    new PermissionDecisions({
      stored: [stored(SITE, 'camera', 'allow'), stored(OTHER, 'microphone', 'block')],
      onDecided,
    });

    expect(onDecided).not.toHaveBeenCalled();
  });

  it('can be changed after it loaded: a new decision replaces the stored one', () => {
    const decisions = new PermissionDecisions({ stored: [stored(SITE, 'camera', 'allow')] });

    decisions.set(SITE, ['camera'], 'block');

    expect(decisions.get(SITE, 'camera')).toBe('block');
  });

  it('keeps an object’s own property names as plain origins', () => {
    const decisions = new PermissionDecisions({ stored: [stored('__proto__', 'camera', 'allow')] });

    expect(decisions.get('__proto__', 'camera')).toBe('allow');
    expect(decisions.get('constructor', 'camera')).toBeUndefined();
    expect(({} as Record<string, unknown>).camera).toBeUndefined();
  });
});

describe('PermissionDecisions: onDecided', () => {
  const setup = () => {
    const onDecided =
      vi.fn<(origin: string, permission: PromptedPermission, decision: Decision) => void>();
    return { onDecided, decisions: new PermissionDecisions({ onDecided }) };
  };

  it('is called with the origin, the permission and the decision', () => {
    const { decisions, onDecided } = setup();

    decisions.set(SITE, ['geolocation'], 'allow');

    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(onDecided).toHaveBeenCalledWith(SITE, 'geolocation', 'allow');
  });

  it('is called once for each permission of a decision, in order', () => {
    const { decisions, onDecided } = setup();

    decisions.set(SITE, ['camera', 'microphone'], 'block');

    expect(onDecided.mock.calls).toEqual([
      [SITE, 'camera', 'block'],
      [SITE, 'microphone', 'block'],
    ]);
  });

  it('is called for every decision, a repeat of the same one included', () => {
    const { decisions, onDecided } = setup();

    decisions.set(SITE, ['camera'], 'allow');
    decisions.set(SITE, ['camera'], 'allow');
    decisions.set(SITE, ['camera'], 'block');

    expect(onDecided.mock.calls).toEqual([
      [SITE, 'camera', 'allow'],
      [SITE, 'camera', 'allow'],
      [SITE, 'camera', 'block'],
    ]);
  });

  it('is not called for a decision with no permission in it', () => {
    const { decisions, onDecided } = setup();

    decisions.set(SITE, [], 'allow');

    expect(onDecided).not.toHaveBeenCalled();
  });

  it('is called after the decision holds, so a read from inside it sees it', () => {
    const seen: (Decision | undefined)[] = [];
    const decisions: PermissionDecisions = new PermissionDecisions({
      onDecided: (origin, permission) => {
        seen.push(decisions.get(origin, permission));
      },
    });

    decisions.set(SITE, ['camera'], 'allow');

    expect(seen).toEqual(['allow']);
  });

  it('is not called when the user dismisses a prompt', () => {
    const { decisions, onDecided } = setup();

    decisions.dismissed(SITE, ['camera', 'microphone']);

    expect(onDecided).not.toHaveBeenCalled();
  });

  it('never reports an embargo, however many dismissals bring it about', () => {
    const { decisions, onDecided } = setup();

    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO + 2; time += 1) {
      decisions.dismissed(SITE, ['notifications']);
    }

    expect(decisions.get(SITE, 'notifications')).toBe('block');
    expect(onDecided).not.toHaveBeenCalled();
  });

  it('works without it', () => {
    const decisions = new PermissionDecisions({ stored: [stored(SITE, 'camera')] });

    expect(() => {
      decisions.set(SITE, ['camera', 'microphone'], 'block');
    }).not.toThrow();
    expect(decisions.get(SITE, 'microphone')).toBe('block');
  });
});

describe('PermissionDecisions: the embargo', () => {
  it('counts as blocked after three dismissals of the same prompt', () => {
    const decisions = new PermissionDecisions();

    for (let time = 1; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      decisions.dismissed(SITE, ['camera']);
      expect(decisions.get(SITE, 'camera')).toBeUndefined();
    }
    decisions.dismissed(SITE, ['camera']);

    expect(decisions.get(SITE, 'camera')).toBe('block');
  });

  it('is three dismissals, as Chrome’s is', () => {
    expect(DISMISSALS_BEFORE_EMBARGO).toBe(3);
  });

  it('is per origin and per permission', () => {
    const decisions = new PermissionDecisions();

    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      decisions.dismissed(SITE, ['camera']);
    }

    expect(decisions.get(SITE, 'microphone')).toBeUndefined();
    expect(decisions.get(OTHER, 'camera')).toBeUndefined();
  });

  it('counts the permissions of one prompt each', () => {
    const decisions = new PermissionDecisions();

    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      decisions.dismissed(SITE, ['camera', 'microphone']);
    }

    expect(decisions.get(SITE, 'camera')).toBe('block');
    expect(decisions.get(SITE, 'microphone')).toBe('block');
  });

  it('never overrides what the user decided: an allow stays an allow', () => {
    const decisions = new PermissionDecisions({ stored: [stored(SITE, 'camera', 'allow')] });

    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO + 1; time += 1) {
      decisions.dismissed(SITE, ['camera']);
    }

    expect(decisions.get(SITE, 'camera')).toBe('allow');
  });

  it('is replaced by a decision the user makes afterwards', () => {
    const decisions = new PermissionDecisions();
    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      decisions.dismissed(SITE, ['camera']);
    }

    decisions.set(SITE, ['camera'], 'allow');

    expect(decisions.get(SITE, 'camera')).toBe('allow');
  });

  it('is not stored: a new PermissionDecisions loaded from what was reported has none', () => {
    const reported: StoredDecision[] = [];
    const first = new PermissionDecisions({
      onDecided: (origin, permission, decision) => reported.push({ origin, permission, decision }),
    });
    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      first.dismissed(SITE, ['camera']);
    }

    const second = new PermissionDecisions({ stored: reported });

    expect(first.get(SITE, 'camera')).toBe('block');
    expect(reported).toEqual([]);
    expect(second.get(SITE, 'camera')).toBeUndefined();
  });

  it('is not reported when a user decision follows it either: only the decision is', () => {
    const onDecided = vi.fn();
    const decisions = new PermissionDecisions({ onDecided });
    for (let time = 0; time < DISMISSALS_BEFORE_EMBARGO; time += 1) {
      decisions.dismissed(SITE, ['camera']);
    }

    decisions.set(SITE, ['camera'], 'block');

    expect(onDecided.mock.calls).toEqual([[SITE, 'camera', 'block']]);
  });
});

describe('managing the stored decisions (M5.2)', () => {
  it('lists every decision, by origin, then permission', () => {
    const decisions = new PermissionDecisions({
      stored: [
        { origin: OTHER, permission: 'notifications', decision: 'block' },
        { origin: SITE, permission: 'microphone', decision: 'allow' },
        { origin: SITE, permission: 'camera', decision: 'allow' },
      ],
    });

    expect(decisions.list()).toEqual([
      { origin: SITE, permission: 'camera', decision: 'allow' },
      { origin: SITE, permission: 'microphone', decision: 'allow' },
      { origin: OTHER, permission: 'notifications', decision: 'block' },
    ]);
  });

  it('forgets one decision: the page asks again, and the others stay', () => {
    const decisions = new PermissionDecisions({
      stored: [
        { origin: SITE, permission: 'camera', decision: 'allow' },
        { origin: SITE, permission: 'microphone', decision: 'allow' },
      ],
    });

    expect(decisions.forget(SITE, 'camera')).toBe(true);
    expect(decisions.forget(SITE, 'camera')).toBe(false);

    expect(decisions.get(SITE, 'camera')).toBeUndefined();
    expect(decisions.get(SITE, 'microphone')).toBe('allow');
  });

  it("forgets an origin's every decision, and its dismissal embargo", () => {
    const decisions = new PermissionDecisions({
      stored: [{ origin: SITE, permission: 'camera', decision: 'allow' }],
    });
    for (let n = 0; n < DISMISSALS_BEFORE_EMBARGO; n += 1) {
      decisions.dismissed(SITE, ['geolocation']);
    }
    expect(decisions.get(SITE, 'geolocation')).toBe('block');

    expect(decisions.forget(SITE)).toBe(true);

    expect(decisions.list()).toEqual([]);
    expect(decisions.get(SITE, 'geolocation')).toBeUndefined();
    expect(decisions.forget(SITE)).toBe(false);
  });
});
