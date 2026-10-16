// The shell's IPC surface, from the page's side (ADR-0005): what `window.veltriva` exposes, what it
// does with hostile input, and how main's events reach it. The sender checks are in
// ipc-sender.spec.ts.
import { PRODUCT_NAME } from '../../src/shared/constants/app-identity';
import { expect, test } from './fixtures';
import type { PageGlobal } from './page-globals';

/** A shell page that records the theme events it receives. Kept on `globalThis` between calls. */
interface ThemeProbe {
  /** Events seen by a listener that is later unsubscribed. */
  readonly unsubscribed: { dark: boolean }[];
  /** Events seen by a listener that stays subscribed, to tell when an event has been delivered. */
  readonly witness: { dark: boolean }[];
  unsubscribe(): void;
}
type ProbedGlobal = PageGlobal & { __themeProbe?: ThemeProbe };

test.describe('window.veltriva', () => {
  test('exposes exactly app and on, frozen, and nothing that reaches IPC directly', async ({
    shell,
  }) => {
    const names = ['ipcRenderer', 'send', 'invoke', 'require', 'process', 'module'];
    const surface = await shell.evaluate((forbidden) => {
      const page = globalThis as PageGlobal;
      const api = page.veltriva;
      const loose = page as unknown as Record<string, unknown>;
      return {
        keys: Object.keys(api),
        ownNames: Object.getOwnPropertyNames(api),
        ownSymbols: Object.getOwnPropertySymbols(api).length,
        appKeys: Object.keys(api.app),
        apiFrozen: Object.isFrozen(api),
        appFrozen: Object.isFrozen(api.app),
        // Writes must fail, not just look frozen. `Reflect` reports failure instead of throwing.
        mutations: [
          Reflect.set(api, 'injected', 1),
          Reflect.set(api, 'app', {}),
          Reflect.deleteProperty(api, 'on'),
          Reflect.set(api.app, 'getInfo', () => 1),
          Reflect.set(api.app, 'send', () => 1),
        ],
        forbiddenOnApi: forbidden.filter((name) => name in api),
        forbiddenOnApp: forbidden.filter((name) => name in api.app),
        forbiddenOnWindow: forbidden.filter((name) => typeof loose[name] !== 'undefined'),
        typeofGetInfo: typeof api.app.getInfo,
        typeofOn: typeof api.on,
      };
    }, names);

    expect(surface.keys).toEqual(['app', 'on']);
    expect(surface.ownNames).toEqual(['app', 'on']);
    expect(surface.ownSymbols).toBe(0);
    expect(surface.appKeys).toEqual(['getInfo']);
    expect(surface.apiFrozen).toBe(true);
    expect(surface.appFrozen).toBe(true);
    expect(surface.mutations).toEqual([false, false, false, false, false]);
    expect(surface.forbiddenOnApi).toEqual([]);
    expect(surface.forbiddenOnApp).toEqual([]);
    expect(surface.forbiddenOnWindow).toEqual([]);
    expect(surface.typeofGetInfo).toBe('function');
    expect(surface.typeofOn).toBe('function');
  });

  test('app.getInfo returns what main runs on', async ({ electronApp, shell }) => {
    const { withoutInput, withEmptyInput } = await shell.evaluate(async () => {
      const { veltriva } = globalThis as PageGlobal;
      return {
        withoutInput: await veltriva.app.getInfo(),
        withEmptyInput: await veltriva.app.getInfo({}),
      };
    });
    const main = await electronApp.evaluate(({ app }) => ({
      version: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }));

    expect(withoutInput).toEqual({
      ok: true,
      value: { productName: PRODUCT_NAME, version: main.version, versions: main.versions },
    });
    // Omitting the input is the same as sending an empty object.
    expect(withEmptyInput).toEqual(withoutInput);
  });

  test('rejects malformed payloads with invalid_input', async ({ electronApp, shell }) => {
    // Each payload is built in the page from JSON, so `__proto__` is an own property, as it would
    // be in a real attack. (An object literal would set the prototype instead.)
    const payloads: Record<string, string> = {
      'an unknown key': '{"extra":1}',
      null: 'null',
      'an array': '[]',
      'a string': '"x"',
      'a number': '42',
      'a boolean': 'true',
      'an own __proto__ key': '{"__proto__":{"polluted":true}}',
      'an own constructor key': '{"constructor":{"prototype":{"polluted":true}}}',
      'a nested object': '{"nested":{}}',
    };

    const results = await shell.evaluate(async (jsonByLabel) => {
      const { veltriva } = globalThis as PageGlobal;
      const outcomes: Record<string, unknown> = {};
      for (const [label, json] of Object.entries(jsonByLabel)) {
        const payload = JSON.parse(json) as Record<string, never>;
        outcomes[label] = await veltriva.app.getInfo(payload);
      }
      return {
        outcomes,
        pagePolluted: 'polluted' in {},
      };
    }, payloads);

    const invalid = { ok: false, code: 'invalid_input' };
    expect(results.outcomes).toEqual(
      Object.fromEntries(Object.keys(payloads).map((label) => [label, invalid])),
    );
    // Nothing leaked into either process's Object.prototype.
    expect(results.pagePolluted).toBe(false);
    expect(await electronApp.evaluate(() => 'polluted' in {})).toBe(false);
  });

  test('rejects unknown events and bad listeners', async ({ shell }) => {
    const outcomes = await shell.evaluate(() => {
      const { veltriva } = globalThis as PageGlobal;
      const on = veltriva.on as unknown as (...args: unknown[]) => unknown;
      const listener = (): void => undefined;
      const attempt = (call: () => unknown): string => {
        try {
          call();
          return 'did not throw';
        } catch (error) {
          return error instanceof Error ? error.name : 'threw a non-error';
        }
      };
      return {
        unknownEvent: attempt(() => on('nope', listener)),
        notAFunction: attempt(() => on('app.themeChanged', 'not a function')),
        missingListener: attempt(() => on('app.themeChanged')),
        missingEvent: attempt(() => on(undefined, listener)),
        inheritedName: attempt(() => on('toString', listener)),
        protoName: attempt(() => on('__proto__', listener)),
        objectName: attempt(() => on({}, listener)),
        arrayName: attempt(() => on(['app.themeChanged'], listener)),
      };
    });

    for (const [label, outcome] of Object.entries(outcomes)) {
      expect(outcome, label).not.toBe('did not throw');
    }
  });

  test('delivers app.themeChanged to the shell until the listener unsubscribes', async ({
    shell,
    setThemeSource,
  }) => {
    await shell.evaluate(() => {
      const page = globalThis as ProbedGlobal;
      const unsubscribed: { dark: boolean }[] = [];
      const witness: { dark: boolean }[] = [];
      const unsubscribe = page.veltriva.on('app.themeChanged', (payload) => {
        unsubscribed.push(payload);
      });
      page.veltriva.on('app.themeChanged', (payload) => {
        witness.push(payload);
      });
      page.__themeProbe = { unsubscribed, witness, unsubscribe };
    });
    const read = () =>
      shell.evaluate(() => {
        const probe = (globalThis as ProbedGlobal).__themeProbe;
        if (probe === undefined) {
          throw new Error('The theme probe is missing');
        }
        return { unsubscribed: [...probe.unsubscribed], witness: [...probe.witness] };
      });

    // The source goes 'light' then 'dark'. Whichever the system had, the last change is to dark.
    await setThemeSource('light');
    await setThemeSource('dark');
    await expect.poll(async () => (await read()).unsubscribed.at(-1)).toEqual({ dark: true });

    const whileSubscribed = await read();
    expect(whileSubscribed.unsubscribed.length).toBeGreaterThan(0);
    for (const payload of whileSubscribed.unsubscribed) {
      expect(payload).toEqual({ dark: expect.any(Boolean) as unknown });
    }
    expect(whileSubscribed.witness).toEqual(whileSubscribed.unsubscribed);

    // After unsubscribing, a change still reaches the witness (so it was delivered), but not the
    // listener that unsubscribed.
    await shell.evaluate(() => {
      (globalThis as ProbedGlobal).__themeProbe?.unsubscribe();
    });
    await setThemeSource('light');
    await expect
      .poll(async () => (await read()).witness.length)
      .toBeGreaterThan(whileSubscribed.witness.length);

    const afterUnsubscribe = await read();
    expect(afterUnsubscribe.witness.at(-1)).toEqual({ dark: false });
    expect(afterUnsubscribe.unsubscribed).toEqual(whileSubscribed.unsubscribed);
  });
});
