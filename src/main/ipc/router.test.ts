import { describe, expect, it, vi } from 'vitest';

import { COMMAND_NAMES } from '../../shared/contracts/ipc';
import type { Logger } from '../platform/logger';
import { CommandError } from './command-error';
import { createIpcRouter } from './router';
import type { CommandHandlers } from './router';
import type { SenderVerdict } from './sender';

interface FakeEvent {
  readonly verdict: SenderVerdict;
}

const TRUSTED: FakeEvent = { verdict: { trusted: true } };
const FROM_TAB: FakeEvent = { verdict: { trusted: false, reason: 'not-shell' } };

const INFO = {
  productName: 'Veltriva Browser',
  version: '0.0.0',
  versions: { electron: '44.7.2', chrome: '152.0.7977.149', node: '24.21.0' },
};

/** Every other command throws: these tests only exercise `app.getInfo`. */
function withOnly(getInfo: CommandHandlers['app.getInfo']): CommandHandlers {
  const unused = (): never => {
    throw new Error('not used in this test');
  };
  return {
    ...Object.fromEntries(COMMAND_NAMES.map((name) => [name, unused])),
    'app.getInfo': getInfo,
  } as CommandHandlers;
}

function setup(getInfo: CommandHandlers['app.getInfo'] = () => INFO) {
  const warn = vi.fn<Logger['warn']>();
  const error = vi.fn<Logger['error']>();
  const logger: Logger = { warn, error };
  const handler = vi.fn(getInfo);
  const route = createIpcRouter<FakeEvent>({
    handlers: withOnly(handler),
    verifySender: (event) => event.verdict,
    logger,
  });
  return { route, handler, logger, warn, error };
}

describe('IpcRouter', () => {
  it('runs a valid command from the shell', async () => {
    const { route, handler } = setup();
    await expect(route(TRUSTED, 'app.getInfo', {})).resolves.toEqual({ ok: true, value: INFO });
    expect(handler).toHaveBeenCalledWith({});
  });

  it('drops a message from an untrusted sender before looking at it', async () => {
    const { route, handler, warn } = setup();
    await expect(route(FROM_TAB, 'app.getInfo', {})).resolves.toEqual({
      ok: false,
      code: 'forbidden',
    });
    // Even an unknown command name reads as "forbidden": an untrusted sender learns nothing.
    await expect(route(FROM_TAB, 'tabs.closeAll', { evil: true })).resolves.toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('ipc.forbidden', { reason: 'not-shell' });
  });

  it('fails closed if the sender check itself throws', async () => {
    const { handler, logger } = setup();
    const route = createIpcRouter<FakeEvent>({
      handlers: withOnly(handler),
      verifySender: () => {
        throw new Error('frame disposed');
      },
      logger,
    });
    await expect(route(TRUSTED, 'app.getInfo', {})).resolves.toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['a name outside the contract', 'app.quit'],
    ['a prototype key', '__proto__'],
    ['a non-string', 42],
    ['nothing', undefined],
  ])('rejects %s as an unknown command', async (_label, command) => {
    const { route, handler } = setup();
    await expect(route(TRUSTED, command, {})).resolves.toEqual({
      ok: false,
      code: 'unknown_command',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown key', { extra: 1 }],
    ['a prototype-pollution key', JSON.parse('{"__proto__": {"polluted": true}}') as unknown],
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'app.getInfo'],
    ['a number', 7],
  ])('rejects %s as invalid input without calling the handler', async (_label, input) => {
    const { route, handler } = setup();
    await expect(route(TRUSTED, 'app.getInfo', input)).resolves.toEqual({
      ok: false,
      code: 'invalid_input',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a failing handler as internal, without its message', async () => {
    const { route, error } = setup(() => {
      throw new Error('C:\\Users\\someone\\secret.txt');
    });
    const result = await route(TRUSTED, 'app.getInfo', {});
    expect(result).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(error).toHaveBeenCalledWith('ipc.handlerFailed', {
      command: 'app.getInfo',
      error: 'Error',
    });
  });

  it('reports an output that breaks the contract as internal', async () => {
    const { route } = setup(() => ({ ...INFO, debugPath: 'C:\\x' }));
    await expect(route(TRUSTED, 'app.getInfo', {})).resolves.toEqual({
      ok: false,
      code: 'internal',
    });
  });

  it('awaits asynchronous handlers', async () => {
    const { route } = setup(() => Promise.resolve(INFO));
    await expect(route(TRUSTED, 'app.getInfo', {})).resolves.toEqual({ ok: true, value: INFO });
  });
});

describe('IpcRouter with CommandError', () => {
  it('answers a CommandError with its code and logs nothing', async () => {
    const { route, error } = setup(() => {
      throw new CommandError('not_found');
    });
    await expect(route(TRUSTED, 'app.getInfo', {})).resolves.toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(error).not.toHaveBeenCalled();
  });
});
