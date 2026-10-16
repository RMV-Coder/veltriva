// Sender verification (ADR-0005 §5.1): IpcRouter answers only the shell's main frame on app://shell.
// A tab is given a test-only preload that can send on the shell's IPC channel, which no real tab
// ever has, so the spec proves the *router* refuses it and not merely that tabs lack a channel.
import { join } from 'node:path';

import { expect, test } from './fixtures';
import { webContentsRoles } from './hooks';
import { observeFor } from './launch';
import type { PageGlobal } from './page-globals';

const PROBE_PRELOAD = join(__dirname, 'fixtures', 'ipc-probe-preload.cjs');

/** What the probe preload exposes on the tab's `window`. */
interface IpcProbe {
  invoke(command: unknown, input: unknown): Promise<unknown>;
  events(): { name: unknown; payload: unknown }[];
}
type ProbeGlobal = typeof globalThis & { __ipcProbe: IpcProbe };
type ShellEventsGlobal = PageGlobal & { __shellEvents?: { dark: boolean }[] };

const FORBIDDEN = { ok: false, code: 'forbidden' };

test.describe('IPC sender verification', () => {
  test('answers a tab with forbidden, whatever it sends', async ({
    electronApp,
    fixtureServer,
    openTab,
  }) => {
    const tab = await openTab(fixtureServer.url('/blank.html'), { preload: PROBE_PRELOAD });

    // The tab is a tab, not something the guard treated as the shell.
    const roles = await webContentsRoles(electronApp);
    expect(roles.find((entry) => entry.webContentsId === tab.webContentsId)?.role).toBe('tab');

    const replies = await tab.page.evaluate(async () => {
      const { __ipcProbe: probe } = globalThis as ProbeGlobal;
      return {
        // A real command with valid input: the shell would get its answer.
        getInfo: await probe.invoke('app.getInfo', {}),
        // Not even the command name is checked for an untrusted sender.
        unknownCommand: await probe.invoke('nope.nothing', {}),
        // Nor the input: a valid command with a bad payload is `forbidden`, not `invalid_input`.
        badInput: await probe.invoke('app.getInfo', { extra: 1 }),
        noArguments: await probe.invoke(undefined, undefined),
        objectCommand: await probe.invoke({ toString: 'app.getInfo' }, {}),
      };
    });

    expect(replies).toEqual({
      getInfo: FORBIDDEN,
      unknownCommand: FORBIDDEN,
      badInput: FORBIDDEN,
      noArguments: FORBIDDEN,
      objectCommand: FORBIDDEN,
    });
  });

  test('sends events to the shell and never to a tab', async ({
    electronApp,
    fixtureServer,
    openTab,
    setThemeSource,
    shell,
  }) => {
    const tab = await openTab(fixtureServer.url('/blank.html'), { preload: PROBE_PRELOAD });

    // The shell listens, so its page tells us when main has sent the event.
    await shell.evaluate(() => {
      const page = globalThis as ShellEventsGlobal;
      const seen: { dark: boolean }[] = [];
      page.__shellEvents = seen;
      page.veltriva.on('app.themeChanged', (payload) => {
        seen.push(payload);
      });
    });
    const shellEvents = () =>
      shell.evaluate(() => (globalThis as ShellEventsGlobal).__shellEvents ?? []);

    await setThemeSource('light');
    await setThemeSource('dark');
    await expect.poll(async () => (await shellEvents()).at(-1)).toEqual({ dark: true });

    // The shell has it. Give an event that was wrongly sent to the tab time to arrive, too.
    const tabEventCounts = await observeFor(1_000, () =>
      tab.page.evaluate(() => (globalThis as ProbeGlobal).__ipcProbe.events().length),
    );
    expect(tabEventCounts).toEqual([0]);

    // Control: the probe does listen on the event channel. Without this, "no events" could be
    // true only because the preload's channel name is wrong.
    await electronApp.evaluate(({ webContents }, id) => {
      webContents.fromId(id)?.send('veltriva:event', 'probe.ping', { n: 1 });
    }, tab.webContentsId);
    await expect
      .poll(() => tab.page.evaluate(() => (globalThis as ProbeGlobal).__ipcProbe.events()))
      .toEqual([{ name: 'probe.ping', payload: { n: 1 } }]);
  });
});
