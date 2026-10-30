import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AREAS,
  areaOf,
  areaOfPath,
  commitsIn,
  defaultRange,
  fillReleasePage,
  formatNotes,
  releaseNotes,
  releaseSection,
} from './release-notes.mjs';

describe('areaOfPath', () => {
  it.each([
    ['src/core/url/omnibox.ts', 'browsing'],
    ['src/main/tabs/tab-manager.ts', 'browsing'],
    ['src/core/lifecycle/policy.ts', 'lifecycle'],
    ['src/main/session/session-store.ts', 'lifecycle'],
    ['src/renderer/features/sidebar/SleepingSection.tsx', 'lifecycle'],
    ['src/data/repos/search.ts', 'memory'],
    ['src/renderer/features/palette/Palette.tsx', 'memory'],
    ['src/main/privacy/clear-data.ts', 'privacy'],
    ['src/main/platform/log-redaction.ts', 'privacy'],
    ['src/main/web/session-baseline.ts', 'security'],
    ['src/preload/shell.ts', 'security'],
    ['.veyra/intents/sandbox.toml', 'security'],
    ['tests/e2e/accessibility.spec.ts', 'accessibility'],
    ['build/installer.nsh', 'release'],
    ['src/main/updates/feed-request.ts', 'release'],
    ['package.json', 'platform'],
  ] as const)('puts %s in %s', (path, area) => {
    expect(areaOfPath(path)).toBe(area);
  });

  it('lets a file named in the rules override the folder around it', () => {
    expect(areaOfPath('src/core/url/hygiene.ts')).toBe('memory');
    expect(areaOfPath('src/core/url/local-network.ts')).toBe('security');
    expect(areaOfPath('src/core/url/display.ts')).toBe('browsing');
  });

  it.each([
    'src/core/url/omnibox.test.ts',
    'tests/e2e/tabs.spec.ts',
    'docs/adr/0003-tab-model-and-lifecycle.md',
    'README.md',
    'src/main/index.ts',
  ])('puts %s in no area', (path) => {
    expect(areaOfPath(path)).toBeUndefined();
  });

  it('matches a folder only at a separator', () => {
    expect(areaOfPath('src/datastore/x.ts')).toBeUndefined();
  });
});

describe('areaOf', () => {
  it('calls a commit that changes no shipped code development, whatever its subject', () => {
    expect(
      areaOf({
        subject: 'Document the secure shell in the ADRs',
        paths: ['docs/adr/0002-trust-zones-and-web-policy.md', 'tests/e2e/hostile.spec.ts'],
      }),
    ).toBe('development');
  });

  it('lets the subject name the area when the paths disagree', () => {
    expect(
      areaOf({
        subject: 'Session restore: persist the tabs and bring them back at startup',
        paths: [
          'src/main/tabs/tab-manager.ts',
          'src/renderer/app/App.tsx',
          'src/core/session/x.ts',
        ],
      }),
    ).toBe('lifecycle');
  });

  it('counts each different word, so two words of one area beat one of another', () => {
    expect(
      areaOf({
        subject: 'favicon requests check every redirect hop (T5)',
        paths: ['src/main/tabs/favicons.ts'],
      }),
    ).toBe('security');
  });

  it('lets the paths decide when the subject names no area', () => {
    expect(
      areaOf({ subject: 'Rank 200 candidates quickly', paths: ['src/core/search/rank.ts'] }),
    ).toBe('memory');
  });

  it('weighs a development word less than a feature: a fix the tests found is a fix', () => {
    expect(
      areaOf({
        subject: 'Fix two bugs the E2E suites found',
        paths: ['src/main/menus/context-menu.ts', 'src/main/windows/fullscreen.ts'],
      }),
    ).toBe('browsing');
  });

  it('breaks a tie by the order of the areas', () => {
    expect(
      areaOf({
        subject: 'Change things',
        paths: ['src/main/privacy/clear-data.ts', 'src/main/web/guard.ts'],
      }),
    ).toBe('privacy');
  });

  it('puts an Electron upgrade with platform, though it changes code to fit', () => {
    expect(
      areaOf({
        subject: 'Upgrade Electron to 44.9.0; a popup window needs pre-created contents',
        paths: ['src/main/popups/popup-policy.ts', 'package.json'],
      }),
    ).toBe('platform');
  });

  it('puts the release commits with the release', () => {
    expect(areaOf({ subject: 'Release v1.2.3: the version', paths: ['package.json'] })).toBe(
      'release',
    );
  });

  it('puts an accessibility fix with accessibility, though it changes the shell', () => {
    expect(
      areaOf({
        subject: 'Screen readers hear the palette filter',
        paths: ['src/renderer/features/palette/Palette.tsx'],
      }),
    ).toBe('accessibility');
  });

  it('obeys an Area: trailer above everything else', () => {
    expect(
      areaOf({
        subject: 'Release v1.2.3: the version',
        body: 'Some text.\n\nArea: privacy\nCo-Authored-By: someone',
        paths: ['package.json'],
      }),
    ).toBe('privacy');
  });

  it('ignores an Area: trailer that names no area', () => {
    expect(
      areaOf({ subject: 'x', body: 'Area: marketing', paths: ['src/core/search/rank.ts'] }),
    ).toBe('memory');
  });
});

describe('formatNotes', () => {
  const commits = [
    { sha: 'a'.repeat(40), subject: 'Search by prefix', paths: ['src/core/search/q.ts'] },
    { sha: 'b'.repeat(40), subject: 'A new omnibox', paths: ['src/core/url/omnibox.ts'] },
    { sha: 'c'.repeat(40), subject: 'Rank by frecency', paths: ['src/data/repos/history.ts'] },
  ];

  it('lists the areas in order, each commit once, oldest first, with a short id', () => {
    expect(formatNotes(commits, { title: 'v1.0.0' })).toBe(
      [
        '## v1.0.0',
        '',
        '### Browsing',
        '',
        `- A new omnibox (bbbbbbb)`,
        '',
        '### Memory and search',
        '',
        `- Search by prefix (aaaaaaa)`,
        `- Rank by frecency (ccccccc)`,
        '',
      ].join('\n'),
    );
  });

  it('leaves the title out when there is none, and lists nothing for no commits', () => {
    expect(formatNotes(commits.slice(1, 2))).toBe('### Browsing\n\n- A new omnibox (bbbbbbb)\n');
    expect(formatNotes([])).toBe('\n');
  });

  it('has a title for every area', () => {
    expect(new Set(AREAS.map((area) => area.key)).size).toBe(AREAS.length);
  });
});

describe('fillReleasePage', () => {
  const page = [
    '# v1.0.0',
    '',
    releaseSection('status', 'Draft.'),
    '',
    'Highlights written by hand.',
    '',
    releaseSection('changes', 'old list'),
    '',
  ].join('\n');

  it('replaces only the named sections, keeping the text around them', () => {
    const filled = fillReleasePage(page, { status: 'Prepared.', changes: '- new ($1)' });
    expect(filled).toContain('Highlights written by hand.');
    expect(filled).toContain(releaseSection('status', 'Prepared.'));
    expect(filled).toContain(releaseSection('changes', '- new ($1)'));
    expect(filled).not.toContain('old list');
    expect(filled).not.toContain('Draft.');
  });

  it('fills a page again the same way', () => {
    const once = fillReleasePage(page, { status: 'Prepared.' });
    expect(fillReleasePage(once, { status: 'Prepared.' })).toBe(once);
  });

  it('refuses a page without a section it has to write', () => {
    expect(() => fillReleasePage(page, { download: 'sha' })).toThrow(/release:download/);
  });
});

describe('reading a repository', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Each git command a second later than the last, so the log's order never rests on a tie.
  let seconds = 0;
  function git(cwd: string, ...args: string[]): void {
    seconds += 1;
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
    const result = spawnSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    );
    expect(result.status, result.stderr).toBe(0);
  }

  function commit(cwd: string, files: readonly string[], message: string): void {
    for (const file of files) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), `${message}\n`, { flag: 'a' });
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  }

  function repository(): string {
    const dir = mkdtempSync(join(tmpdir(), 'veltriva-notes-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, ['README.md'], 'The first commit');
    return dir;
  }

  it('reads every commit but merges, oldest first, with its paths and its message', () => {
    const dir = repository();
    git(dir, 'switch', '-q', '-c', 'feature');
    commit(dir, ['src/core/search/q.ts'], 'Search by prefix\n\nWhy, at length.\n\nArea: privacy');
    git(dir, 'switch', '-q', 'main');
    commit(dir, ['src/core/url/omnibox.ts'], 'A new omnibox');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge the feature', 'feature');

    const commits = commitsIn('HEAD', { cwd: dir });
    expect(commits.map((c) => c.subject)).toEqual([
      'The first commit',
      'Search by prefix',
      'A new omnibox',
    ]);
    expect(commits[0]?.paths).toEqual(['README.md']);
    expect(commits[1]?.paths).toEqual(['src/core/search/q.ts']);
    expect(commits[1]?.body).toContain('Area: privacy');
    expect(commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
  });

  it('starts at the last tag by default, or at the first commit without one', () => {
    const dir = repository();
    expect(defaultRange({ cwd: dir })).toBe('HEAD');
    git(dir, 'tag', 'v0.1.0');
    commit(dir, ['src/main/web/guard.ts'], 'Guard the pages');
    expect(defaultRange({ cwd: dir })).toBe('v0.1.0..HEAD');
    expect(releaseNotes({ cwd: dir, title: 'v0.2.0' })).toMatch(
      /^## v0\.2\.0\n\n### Security\n\n- Guard the pages \([0-9a-f]{7}\)\n$/,
    );
  });

  it('fails on a range git does not know', () => {
    const dir = repository();
    expect(() => commitsIn('nope..HEAD', { cwd: dir })).toThrow(/git log/);
  });
});
