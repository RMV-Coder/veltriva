// Milestone 0.1's profiling criterion (assessment §8.2, ADR-0004 item 1): no database work on the
// main thread. Main never imports src/data (ESLint, check-production-build); this checks it at run
// time. While the app records visits, titles and icons, a CPU profile of main, taken through
// node:inspector inside main, must hold no frame from the data worker's bundle or better-sqlite3,
// and main must not have loaded either. The profile must hold main's own code, or it proves
// nothing.
import type { ElectronApplication } from '@playwright/test';

import { expectVisits, test, expect, waitForFavicon } from './memory-ui';
import { loadInNewTab, typeAddress, waitForPage } from './shell-ui';

test.describe.configure({ timeout: 180_000 });

interface ProfileSummary {
  readonly samples: number;
  readonly urls: readonly string[];
  readonly loadedModules: readonly string[];
}

/** Starts a CPU profile of main's thread, sampling every 100 µs. */
async function startProfile(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule('node:inspector/promises');
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 100 });
    await session.post('Profiler.start');
    (globalThis as { veltrivaProfile?: unknown }).veltrivaProfile = session;
  });
}

/** Stops it: the scripts its frames ran in, and the modules main has loaded. */
async function stopProfile(app: ElectronApplication): Promise<ProfileSummary> {
  return app.evaluate(async () => {
    const holder = globalThis as {
      veltrivaProfile?: import('node:inspector/promises').Session;
    };
    const session = holder.veltrivaProfile;
    if (session === undefined) {
      throw new Error('no profile running');
    }
    const { profile } = await session.post('Profiler.stop');
    session.disconnect();
    delete holder.veltrivaProfile;
    const urls = new Set(profile.nodes.map((node) => node.callFrame.url).filter(Boolean));
    // Main is CommonJS: the require cache, one per thread, names every file it loaded.
    const { createRequire } = process.getBuiltinModule('node:module');
    const { cache } = createRequire(process.execPath);
    return {
      samples: profile.samples?.length ?? 0,
      urls: [...urls],
      loadedModules: Object.keys(cache),
    };
  });
}

const DATABASE_CODE = /data-worker|better[-_]sqlite3|\.node$/i;

test('profiling: while the memory records pages, no database code runs or is loaded on the main thread', async ({
  launcher,
  fixtureServer,
}) => {
  const { app, shell } = await launcher.launch();
  // The worker is up before the profile starts: its opening is not main's either way.
  await startProfile(app);

  const icon = '/memory/icon.png?w=32&h=32&c=200,40,40';
  const pages = Array.from({ length: 6 }, (_, n) =>
    fixtureServer.url(
      `/memory/page?title=${encodeURIComponent(`Profiled ${String(n)}`)}&icon=${encodeURIComponent(icon)}&n=${String(n)}`,
    ),
  );
  const [first, ...rest] = pages;
  if (first === undefined) {
    throw new Error('no pages');
  }
  const tab = await loadInNewTab(app, shell, first);
  for (const [index, url] of rest.entries()) {
    await typeAddress(shell, url);
    await waitForPage(app, tab, { url, title: `Profiled ${String(index + 1)}` });
  }
  // Visits, settled titles and an icon all went through the data worker while profiling.
  await expectVisits(
    app,
    pages.map((url) => [url, 'typed'] as const),
  );
  await waitForFavicon(app, pages.at(-1) ?? first);

  const profile = await stopProfile(app);

  // The profile saw main's own code, so its silence about the database means something.
  expect(profile.samples).toBeGreaterThan(0);
  expect(
    profile.urls.some(
      (url) => /[\\/]out[\\/]main[\\/]index\.js$/.test(url) || url.endsWith('/out/main/index.js'),
    ),
  ).toBe(true);
  expect(profile.loadedModules.length).toBeGreaterThan(0);

  expect(profile.urls.filter((url) => DATABASE_CODE.test(url))).toEqual([]);
  expect(profile.loadedModules.filter((path) => DATABASE_CODE.test(path))).toEqual([]);
});
