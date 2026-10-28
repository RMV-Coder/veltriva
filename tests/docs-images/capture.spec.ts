// The README's screenshots and GIFs (M6.4). `npm run docs:images` builds the test variant and
// runs this one spec: it opens the demo web (./demo-site.ts) in the app, puts tabs where the
// pictures need them through the same commands the shell sends, and captures the whole window
// with PrintWindow (./capture-window.ps1), so the page under the shell is in the picture too.
// The GIFs are assembled from captured frames with ffmpeg when it is on the PATH; without it
// they are skipped, and the spec says so. Everything is written to docs/images/.
//
// It is not part of the E2E suite (its own config, playwright.docs-images.config.ts): it checks
// only that each state it pictures was reached.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ElectronApplication, Page } from '@playwright/test';

import { createServerIdentity } from '../fixtures/certificate';
import { expect } from '../e2e/expect';
import { test } from '../e2e/fixtures';
import type { TabId } from '../e2e/hooks';
import { tabState } from '../e2e/hooks';
import { archiveTab, shelveTab } from '../e2e/placement-ui';
import {
  SLOW_TIMEOUT_MS,
  closeWithButton,
  internalPage,
  loadInNewTab,
  palette,
  paletteInput,
  paletteOptions,
  searchMemoryButton,
  sidebarIds,
  tabElement,
  togglePinWithButton,
} from '../e2e/shell-ui';
import { DEMO_PAGES, startDemoSite } from './demo-site';

const run = promisify(execFile);
const OUT_DIR = resolve(__dirname, '..', '..', 'docs', 'images');
const CAPTURE = resolve(__dirname, 'capture-window.ps1');
/** The window's size in DIPs: 1600 × 1000 pixels at 125% scaling. */
const WINDOW = { width: 1280, height: 800 } as const;

const identity = createServerIdentity();

test.use({
  appSwitches: [
    `--ignore-certificate-errors-spki-list=${identity.spkiSha256}`,
    '--host-resolver-rules=MAP *.example 127.0.0.1',
  ],
});

test.setTimeout(20 * 60_000);

test('the README images', async ({ electronApp, shell, setThemeSource }) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const site = await startDemoSite(identity);
  try {
    await placeWindow(electronApp);
    const [startTab] = await sidebarIds(shell);
    const tabs = new Map<string, TabId>();
    for (const page of DEMO_PAGES) {
      tabs.set(page.host, await loadInNewTab(electronApp, shell, site.url(page.host)));
    }
    const tab = (host: string): TabId => {
      const id = tabs.get(host);
      if (id === undefined) {
        throw new Error(`No tab for ${host}`);
      }
      return id;
    };
    if (startTab !== undefined) {
      await closeWithButton(shell, startTab);
    }

    // Two pinned tabs, two archived, two in Sleeping, two unloaded, the rest live.
    await togglePinWithButton(shell, tab('budget.example'));
    await togglePinWithButton(shell, tab('rustnotes.example'));
    expect(await archiveTab(shell, tab('filmphoto.example'))).toBe(true);
    expect(await archiveTab(shell, tab('garden.example'))).toBe(true);
    await select(shell, tab('kyoto.example'));
    expect(await shelveTab(shell, tab('meteors.example'))).toBe(true);
    expect(await shelveTab(shell, tab('ramen.example'))).toBe(true);
    for (const host of ['trailrun.example', 'fts.example']) {
      await electronApp.evaluate(async (_electron, id) => {
        await globalThis.__veltrivaTest?.discardTab(id);
      }, tab(host));
      await expect
        .poll(async () => (await tabState(electronApp, tab(host)))?.runtime, {
          timeout: SLOW_TIMEOUT_MS,
        })
        .toBe('unloaded');
    }
    // A new profile's first 3 days show automation's preview card; the pictures show the
    // sidebar as it is after that.
    const startNow = shell.getByRole('button', { name: 'Start now' });
    if ((await startNow.count()) > 0) {
      await startNow.click();
      await expect(startNow).toHaveCount(0);
    }
    await expandSections(shell);
    await dismissUndo(shell);
    await settle(shell);

    // 1. The window, light and dark.
    await shot(electronApp, 'main-window.png');
    // Playwright emulates the light scheme on every page it attaches to, tabs included, so the
    // dark picture switches each of them as well as Windows' theme.
    await setThemeSource('dark');
    await colorScheme(electronApp, 'dark');
    await expect(shell.locator('html')).toHaveClass(/\bdark\b/u);
    await settle(shell);
    await shot(electronApp, 'main-window-dark.png');
    await setThemeSource('light');
    await colorScheme(electronApp, 'light');
    await expect(shell.locator('html')).not.toHaveClass(/\bdark\b/u);

    // 2. Moving a tab to Sleeping, with the Undo toast; then Undo.
    expect(await shelveTab(shell, tab('sourdough.example'))).toBe(true);
    await expect(shell.locator('[data-undo-toast]')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await settle(shell);
    await shot(electronApp, 'sleeping-archive.png');
    await shell.locator('[data-undo-action="undo"]').click();
    await expect(shell.locator('[data-undo-toast]')).toHaveCount(0, { timeout: SLOW_TIMEOUT_MS });

    // 3. The memory palette: a few letters find open, sleeping and archived pages alike.
    await searchMemoryButton(shell).click();
    await expect(palette(shell)).toBeVisible();
    await paletteInput(shell).fill('not');
    await expect.poll(() => paletteOptions(shell).count()).toBeGreaterThanOrEqual(4);
    await settle(shell);
    await shot(electronApp, 'memory-palette.png');
    await shell.keyboard.press('Escape');
    await expect(palette(shell)).toHaveCount(0);

    // 4. Settings.
    await shell.locator('[data-settings-button]').click();
    await expect(internalPage(shell, 'settings')).toHaveAttribute('data-settings-state', 'ready', {
      timeout: SLOW_TIMEOUT_MS,
    });
    await settle(shell);
    await shot(electronApp, 'settings.png');

    // 5. GIF: an archived page found by a few letters and brought back.
    await select(shell, tab('kyoto.example'));
    await settle(shell);
    await record(electronApp, 'memory-palette.gif', async () => {
      await pause(700);
      await searchMemoryButton(shell).click();
      await expect(palette(shell)).toBeVisible();
      await pause(400);
      await paletteInput(shell).pressSequentially('film', { delay: 180 });
      await expect.poll(() => paletteOptions(shell).count()).toBeGreaterThanOrEqual(1);
      await pause(1200);
      await shell.keyboard.press('Enter');
      await expect(palette(shell)).toHaveCount(0);
      await pause(1800);
    });

    // 6. GIF: a tab moved to Sleeping, and Undo.
    await select(shell, tab('kyoto.example'));
    await settle(shell);
    await record(electronApp, 'sleeping-undo.gif', async () => {
      await pause(700);
      expect(await shelveTab(shell, tab('trailrun.example'))).toBe(true);
      await expect(shell.locator('[data-undo-toast]')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
      await pause(1600);
      await shell.locator('[data-undo-action="undo"]').click();
      await expect(shell.locator('[data-undo-toast]')).toHaveCount(0, {
        timeout: SLOW_TIMEOUT_MS,
      });
      await pause(1400);
    });
  } finally {
    await site.close();
  }
});

/** Puts the main window on the primary display at the pictures' size. */
async function placeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BaseWindow, screen }, size) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) {
      throw new Error('No window');
    }
    window.unmaximize();
    const area = screen.getPrimaryDisplay().workArea;
    window.setBounds({ x: area.x + 24, y: area.y + 16, ...size });
  }, WINDOW);
}

async function colorScheme(app: ElectronApplication, scheme: 'light' | 'dark'): Promise<void> {
  for (const page of app.windows()) {
    await page.emulateMedia({ colorScheme: scheme });
  }
}

async function windowHandle(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BaseWindow }) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) {
      throw new Error('No window');
    }
    return window.getNativeWindowHandle().readBigUInt64LE().toString();
  });
}

async function select(shell: Page, tabId: TabId): Promise<void> {
  await tabElement(shell, tabId).click();
  await expect(tabElement(shell, tabId)).toHaveAttribute('aria-selected', 'true');
}

async function expandSections(shell: Page): Promise<void> {
  for (const kind of ['sleeping', 'archive']) {
    const toggle = shell.locator(`[data-section-toggle="${kind}"]`);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}

async function dismissUndo(shell: Page): Promise<void> {
  const dismiss = shell.locator('[data-undo-action="dismiss"]');
  if ((await dismiss.count()) > 0) {
    await dismiss.click();
  }
  await expect(shell.locator('[data-undo-toast]')).toHaveCount(0, { timeout: SLOW_TIMEOUT_MS });
}

/** Moves the pointer off the shell's controls and lets icons and transitions finish. */
async function settle(shell: Page): Promise<void> {
  await shell.mouse.move(1, 1);
  await pause(1200);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolveLater) => setTimeout(resolveLater, ms));
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const hwnd = await windowHandle(app);
  await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CAPTURE,
    '-Hwnd',
    hwnd,
    '-Out',
    join(OUT_DIR, name),
  ]);
}

/** Records the window while `act` runs, then turns the frames into a GIF with ffmpeg. */
async function record(
  app: ElectronApplication,
  name: string,
  act: () => Promise<void>,
): Promise<void> {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!ffmpeg) {
    console.warn(`ffmpeg isn't on the PATH: ${name} skipped.`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'veltriva-frames-'));
  const stop = join(dir, 'stop');
  try {
    const hwnd = await windowHandle(app);
    const capture = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        CAPTURE,
        '-Hwnd',
        hwnd,
        '-Out',
        dir,
        '-FramesUntil',
        stop,
        '-IntervalMs',
        '100',
      ],
      { stdio: 'inherit' },
    );
    const exited = new Promise<number | null>((resolveExit) => {
      capture.on('exit', resolveExit);
    });
    await expect
      .poll(() => existsSync(join(dir, 'frame-00000.png')), { timeout: SLOW_TIMEOUT_MS })
      .toBe(true);
    await act();
    writeFileSync(stop, '');
    expect(await exited).toBe(0);
    const { frames, seconds } = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) as {
      frames: number;
      seconds: number;
    };
    const fps = Math.max(1, frames / seconds);
    const assembled = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        fps.toFixed(3),
        '-i',
        join(dir, 'frame-%05d.png'),
        '-vf',
        'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        '-loop',
        '0',
        join(OUT_DIR, name),
      ],
      { stdio: 'inherit' },
    );
    expect(assembled.status, `ffmpeg should assemble ${name}`).toBe(0);
    console.log(`${name}: ${String(frames)} frames over ${seconds.toFixed(1)} s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
