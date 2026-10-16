import { describe, expect, it } from 'vitest';

import { MAX_QUEUED_PROMPTS, MIN_VISIBLE_BEFORE_ALLOW_MS, PromptManager } from './prompt-manager';
import type { PromptRequest } from './prompt-manager';

const camera: PromptRequest = { kind: 'permission', site: 'meet.example', permissions: ['camera'] };
const mail: PromptRequest = {
  kind: 'external-protocol',
  site: 'mail.example',
  scheme: 'mailto',
  appName: 'Mail',
  canRemember: true,
};

/** Each reading of the clock is a second later, so every answer comes long after its question. */
function setup(now?: () => number) {
  let changes = 0;
  let clock = 0;
  const manager = new PromptManager({
    onChange: () => {
      changes += 1;
    },
    now:
      now ??
      (() => {
        clock += 1_000;
        return clock;
      }),
  });
  return { manager, changes: () => changes };
}

describe('PromptManager', () => {
  it('shows one question per tab at a time and resolves it with the answer', async () => {
    const { manager, changes } = setup();
    const first = manager.ask('tab-1', camera);
    const second = manager.ask('tab-1', mail);
    expect(changes()).toBe(1);
    const shown = manager.current('tab-1');
    expect(shown).toMatchObject(camera);

    expect(manager.respond('tab-1', shown?.id ?? '', { decision: 'allow', remember: false })).toBe(
      true,
    );
    await expect(first).resolves.toEqual({ decision: 'allow', remember: false });
    expect(manager.current('tab-1')).toMatchObject(mail);

    const next = manager.current('tab-1')?.id ?? '';
    manager.respond('tab-1', next, { decision: 'block', remember: true });
    await expect(second).resolves.toEqual({ decision: 'block', remember: true });
    expect(manager.current('tab-1')).toBeNull();
    expect(changes()).toBe(3);
  });

  it('keeps tabs apart', () => {
    const { manager } = setup();
    void manager.ask('tab-1', camera);
    expect(manager.current('tab-2')).toBeNull();
    expect(
      manager.respond('tab-2', manager.current('tab-1')?.id ?? '', {
        decision: 'allow',
        remember: false,
      }),
    ).toBe(false);
    expect(manager.current('tab-1')).toMatchObject(camera);
  });

  it('ignores an answer to a question that is not the one shown', async () => {
    const { manager } = setup();
    const first = manager.ask('tab-1', camera);
    void manager.ask('tab-1', mail);
    const firstId = manager.current('tab-1')?.id ?? '';
    expect(manager.respond('tab-1', 'prompt-999', { decision: 'allow', remember: false })).toBe(
      false,
    );
    manager.respond('tab-1', firstId, { decision: 'block', remember: false });
    await first;
    // A second click on the old question can't answer the next one.
    expect(manager.respond('tab-1', firstId, { decision: 'allow', remember: false })).toBe(false);
    expect(manager.current('tab-1')).toMatchObject(mail);
  });

  it('dismisses every question of a tab whose page went away', async () => {
    const { manager } = setup();
    const first = manager.ask('tab-1', camera);
    const second = manager.ask('tab-1', mail);
    manager.dismissAll('tab-1');
    await expect(first).resolves.toEqual({ decision: 'gone', remember: false });
    await expect(second).resolves.toEqual({ decision: 'gone', remember: false });
    expect(manager.current('tab-1')).toBeNull();
    manager.dismissAll('tab-1');
  });

  it('refuses at once what a spamming page asks beyond the queue limit', async () => {
    const { manager } = setup();
    for (let index = 0; index < MAX_QUEUED_PROMPTS; index += 1) {
      void manager.ask('tab-1', camera);
    }
    await expect(manager.ask('tab-1', mail)).resolves.toEqual({
      decision: 'gone',
      remember: false,
    });
  });

  it('gives each question its own id', () => {
    const { manager } = setup();
    void manager.ask('tab-1', camera);
    void manager.ask('tab-2', camera);
    expect(manager.current('tab-1')?.id).not.toBe(manager.current('tab-2')?.id);
  });

  it('ignores a yes that comes too soon after the question appeared, but never a no', async () => {
    let clock = 0;
    const { manager } = setup(() => clock);
    const first = manager.ask('tab-1', camera);
    void manager.ask('tab-1', mail);
    const firstId = manager.current('tab-1')?.id ?? '';
    clock = MIN_VISIBLE_BEFORE_ALLOW_MS - 1;
    expect(manager.respond('tab-1', firstId, { decision: 'allow', remember: false })).toBe(false);
    expect(manager.current('tab-1')?.id).toBe(firstId);
    clock = MIN_VISIBLE_BEFORE_ALLOW_MS;
    expect(manager.respond('tab-1', firstId, { decision: 'allow', remember: false })).toBe(true);
    await expect(first).resolves.toEqual({ decision: 'allow', remember: false });

    // The next question starts its own wait when it appears: a double click can't approve it.
    const secondId = manager.current('tab-1')?.id ?? '';
    clock += 100;
    expect(manager.respond('tab-1', secondId, { decision: 'allow', remember: true })).toBe(false);
    expect(manager.respond('tab-1', secondId, { decision: 'block', remember: false })).toBe(true);
    expect(manager.current('tab-1')).toBeNull();
  });

  it('takes a dismissal at once', () => {
    const clock = 0;
    const { manager } = setup(() => clock);
    void manager.ask('tab-1', camera);
    const id = manager.current('tab-1')?.id ?? '';
    expect(manager.respond('tab-1', id, { decision: 'dismiss', remember: false })).toBe(true);
  });

  it('dismisses everything on dispose', async () => {
    const { manager } = setup();
    const pending = [manager.ask('tab-1', camera), manager.ask('tab-2', mail)];
    manager.dispose();
    for (const answer of await Promise.all(pending)) {
      expect(answer.decision).toBe('gone');
    }
  });
});
