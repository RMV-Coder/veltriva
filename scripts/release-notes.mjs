// Release notes grouped by feature area. Most of the project's commit subjects aren't Conventional
// Commits, so `veyra release notes`, which groups by type, put nearly everything under "Other
// changes" (docs/releases/v0.1.0.md as first drafted). This groups each commit by the feature it
// changed instead:
//   - a commit that changes no shipped code (only tests, docs, plans or tooling) is development;
//   - otherwise its subject's words name the area, and the paths it changed break a tie or decide
//     when the words name none;
//   - an `Area: <key>` trailer in the commit message overrides all of it.
//
//   node scripts/release-notes.mjs [<range>]      e.g. v0.1.0..HEAD (default: since the last tag)
//
// scripts/release.mjs uses it for the "All changes" section of a draft release page, and
// fillReleasePage() to write that section into a page drafted by hand without touching the rest.
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The areas, in the order the notes list them. */
export const AREAS = [
  { key: 'browsing', title: 'Browsing' },
  { key: 'lifecycle', title: 'Tab lifecycle and session restore' },
  { key: 'memory', title: 'Memory and search' },
  { key: 'privacy', title: 'Privacy' },
  { key: 'security', title: 'Security' },
  { key: 'accessibility', title: 'Accessibility' },
  { key: 'release', title: 'Install, updates and release' },
  { key: 'platform', title: 'Electron and dependencies' },
  { key: 'development', title: 'Tests, tooling and documentation' },
];
const AREA_KEYS = new Set(AREAS.map((area) => area.key));

// Paths that belong to an area; the longest matching prefix wins, so a file or folder named here
// overrides the folder around it. Tests, docs and tooling not named here belong to none.
const PATH_RULES = Object.entries({
  // Browsing: tabs, navigation, the address bar, find, zoom, downloads, menus and the shell's UI.
  'src/core/downloads/': 'browsing',
  'src/core/input/': 'browsing',
  'src/core/layout/': 'browsing',
  'src/core/net/': 'browsing',
  'src/core/url/': 'browsing',
  'src/main/auth/': 'browsing',
  'src/main/downloads/': 'browsing',
  'src/main/focus/': 'browsing',
  'src/main/input/': 'browsing',
  'src/main/menus/': 'browsing',
  'src/main/navigation/': 'browsing',
  'src/main/notices/': 'browsing',
  'src/main/prompts/': 'browsing',
  'src/main/tabs/': 'browsing',
  'src/main/windows/': 'browsing',
  'src/renderer/': 'browsing',
  'src/shared/': 'browsing',

  // Tab lifecycle: unloading, Sleeping and the Archive, protection, and session restore.
  'src/core/lifecycle/': 'lifecycle',
  'src/core/session/': 'lifecycle',
  'src/main/lifecycle/': 'lifecycle',
  'src/main/session/': 'lifecycle',
  'src/renderer/features/activity/': 'lifecycle',
  'src/renderer/features/sidebar/ArchiveList.tsx': 'lifecycle',
  'src/renderer/features/sidebar/ArchiveSection.tsx': 'lifecycle',
  'src/renderer/features/sidebar/AutomationStatus.tsx': 'lifecycle',
  'src/renderer/features/sidebar/PlacementRows.tsx': 'lifecycle',
  'src/renderer/features/sidebar/PreviewMarker.tsx': 'lifecycle',
  'src/renderer/features/sidebar/SleepingSection.tsx': 'lifecycle',
  'src/renderer/features/sidebar/UndoToast.tsx': 'lifecycle',
  'src/renderer/features/sidebar/automation-display.ts': 'lifecycle',
  'src/renderer/features/sidebar/placement-display.ts': 'lifecycle',
  'src/renderer/features/sidebar/undo-display.ts': 'lifecycle',
  'src/shared/contracts/activity.ts': 'lifecycle',
  'docs/benchmarks/memory.md': 'lifecycle',

  // Memory and search: history, the data worker that stores it, search and the palette.
  'src/core/search/': 'memory',
  'src/core/url/hygiene.ts': 'memory',
  'src/data/': 'memory',
  'src/main/history/': 'memory',
  'src/main/memory/': 'memory',
  'src/main/persistence/': 'memory',
  'src/renderer/features/palette/': 'memory',
  'src/shared/contracts/data-rpc.ts': 'memory',
  'docs/benchmarks/search.md': 'memory',

  // Privacy: settings, clearing data, diagnostics that stay local, the log's scrubbing.
  'src/main/diagnostics/': 'privacy',
  'src/main/platform/log-redaction.ts': 'privacy',
  'src/main/privacy/': 'privacy',
  'src/main/settings/': 'privacy',
  'src/renderer/features/pages/PrivacySections.tsx': 'privacy',
  'src/renderer/features/pages/SettingsPage.tsx': 'privacy',
  'src/renderer/features/pages/privacy-display.ts': 'privacy',
  'src/renderer/features/pages/settings-display.ts': 'privacy',
  'src/shared/contracts/settings.ts': 'privacy',

  // Security: trust zones, the shell's protocol and CSP, IPC, permissions, popups, certificates.
  'src/core/permissions/': 'security',
  'src/core/url/external-protocol.ts': 'security',
  'src/core/url/local-network.ts': 'security',
  'src/main/external/': 'security',
  'src/main/ipc/': 'security',
  'src/main/permissions/': 'security',
  'src/main/popups/': 'security',
  'src/main/shell/': 'security',
  'src/main/web/': 'security',
  'src/preload/': 'security',
  'src/shared/contracts/ipc.ts': 'security',
  '.veyra/': 'security',
  'docs/security/': 'security',

  // Accessibility.
  'docs/testing/accessibility.md': 'accessibility',
  'tests/e2e/accessibility.spec.ts': 'accessibility',

  // Install, updates and release: the installer, About, the update notice, the release tooling.
  '.github/workflows/release.yml': 'release',
  'build/': 'release',
  'docs/distribution/': 'release',
  'docs/releases/': 'release',
  'electron-builder.yml': 'release',
  'scripts/installer-test.ps1': 'release',
  'scripts/release-notes.mjs': 'release',
  'scripts/release.mjs': 'release',
  'src/core/updates/': 'release',
  'src/main/updates/': 'release',
  'src/renderer/features/pages/AboutPage.tsx': 'release',
  'src/renderer/features/pages/update-display.ts': 'release',

  // Electron and the dependencies.
  'THIRD_PARTY_NOTICES.txt': 'platform',
  'package-lock.json': 'platform',
  'package.json': 'platform',
}).sort(([a], [b]) => b.length - a.length);

/** The area a path belongs to, or undefined (tests, docs and tooling no rule names). */
export function areaOfPath(path) {
  if (path.endsWith('.test.ts')) {
    return undefined;
  }
  return PATH_RULES.find(([prefix]) => path === prefix || path.startsWith(prefix))?.[1];
}

// Words in a subject that name an area; each different word found counts. Words for where things
// sit ("tabs", "sidebar", "address bar") name no area: nearly every feature lives there.
const SUBJECT_WORDS = {
  browsing:
    /\b(?:navigation|omnibox|find|zoom|fullscreen|context menus?|tab menu|DevTools|shortcuts?|downloads?|PDFs?|clipboard|client hints|user agent|favicons?|notices?|Ctrl\+\w)\b/gi,
  lifecycle:
    /\b(?:session restore|restarts?|crash(?:es|ed)?|Sleeping|Archive|discard|unload(?:ed|ing)?|freeze|protect(?:ion|s)?|engage(?:d|ment)|scheduler|placement|Undo|activity log|lifecycle|regret|previews?|memory pressure|Leave page)\b/gi,
  memory:
    /\b(?:search(?:es)?|palette|history|frecency|visits?|data worker|database|schema|migrations?|backups?|durability|ranking|golden|URL hygiene|address bar's memory)\b/gi,
  privacy:
    /\b(?:settings|clear data|forget|privacy|Pause memory|telemetry|log file|log scrubber|diagnostics?|site rules|retention|redact\w*)\b/gi,
  security:
    /\b(?:secure|security|CSP|IPC|permissions?|popups?|external[- ]protocols?|certificates?|sign-in|sandbox\w*|intents?|T\d{1,2}|local hosts|redirect hop|guard|quadratic regex|fuses?)\b/gi,
  accessibility: /\b(?:focus rings?|F6|keyboard)\b/gi,
  release:
    /\b(?:installer|uninstall\w*|packaging|CI|release (?:script|page|workflow)|update notice|veltriva:\/\/about|CodeQL|Dependabot|signing)\b/gi,
  platform: /\b(?:better-sqlite3 \d|dependenc(?:y|ies)|THIRD_PARTY_NOTICES)\b/gi,
  development:
    /\b(?:ADRs?|README|docs?|documentation|plans?|checklists?|wrap-up|overview|E2E|unit tests|tests|specs?)\b/gi,
};

// Subjects that settle the area alone: an Electron upgrade changes code to fit the new version,
// but it is the upgrade that the notes should list; an accessibility fix changes the shell's UI.
const SUBJECT_OVERRIDES = [
  [/\b(?:pin|upgrade|move)\b.*\bElectron\b.*\d+\.\d+/i, 'platform'],
  [/^Step 0: .*\bElectron \d+/i, 'platform'],
  [/^Release v\d+\.\d+\.\d+\b/i, 'release'],
  [/\b(?:accessibility|screen readers?|WCAG|axe-core)\b/i, 'accessibility'],
];

/** How many different words of each area a subject holds. */
function subjectWords(subject) {
  const counts = new Map();
  for (const [area, words] of Object.entries(SUBJECT_WORDS)) {
    const found = new Set(Array.from(subject.matchAll(words), (match) => match[0].toLowerCase()));
    if (found.size > 0) {
      counts.set(area, found.size);
    }
  }
  return counts;
}

/** A commit's area: its `Area:` trailer, else what it changed and what its subject says. */
export function areaOf({ subject, body = '', paths }) {
  const trailer = /^Area:[ \t]*([a-z]+)[ \t]*$/im.exec(body)?.[1]?.toLowerCase();
  if (trailer !== undefined && AREA_KEYS.has(trailer)) {
    return trailer;
  }
  const override = SUBJECT_OVERRIDES.find(([pattern]) => pattern.test(subject));
  if (override !== undefined) {
    return override[1];
  }
  const areas = paths.map(areaOfPath).filter((area) => area !== undefined);
  if (areas.length === 0) {
    return 'development';
  }
  // Each word of the subject counts 5 for its area, or 3 for development: a fix the tests found
  // is still a fix. The paths share 4 points by how many of them each area holds, so they decide
  // when the words don't.
  const scores = new Map();
  for (const [area, count] of subjectWords(subject)) {
    scores.set(area, (area === 'development' ? 3 : 5) * count);
  }
  for (const area of areas) {
    scores.set(area, (scores.get(area) ?? 0) + 4 / areas.length);
  }
  // The highest score wins; AREAS' order breaks a tie, so every run groups the same way.
  let best = 'development';
  let bestScore = 0;
  for (const { key } of AREAS) {
    const score = scores.get(key) ?? 0;
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

/** The notes as Markdown: a heading per area that has commits, its commits oldest first. */
export function formatNotes(commits, { title } = {}) {
  const lines = title === undefined ? [] : [`## ${title}`, ''];
  for (const { key, title: heading } of AREAS) {
    const inArea = commits.filter((commit) => areaOf(commit) === key);
    if (inArea.length === 0) {
      continue;
    }
    lines.push(`### ${heading}`, '');
    for (const commit of inArea) {
      lines.push(`- ${commit.subject} (${commit.sha.slice(0, 7)})`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || String(result.error)}`);
  }
  return result.stdout;
}

/** The default range: since the newest tag HEAD contains, or the whole history without one. */
export function defaultRange({ cwd } = {}) {
  const result = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? `${result.stdout.trim()}..HEAD` : 'HEAD';
}

/** The commits in a range, oldest first and without merges, each with the paths it changed. */
export function commitsIn(range, { cwd } = {}) {
  // NUL between fields and the record separator between commits: a message holds neither.
  const log = git(['log', '--no-merges', '--reverse', '--format=%H%x00%s%x00%b%x1e', range], cwd);
  return log
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha, subject, body] = record.split('\x00');
      const paths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], cwd)
        .split('\n')
        .filter((path) => path !== '');
      return { sha, subject, body, paths };
    });
}

/** The notes for a range (default: since the last tag), under an optional title. */
export function releaseNotes({ range, title, cwd } = {}) {
  return formatNotes(commitsIn(range ?? defaultRange({ cwd }), { cwd }), { title });
}

/** A section of a release page the release script writes, between its two markers. */
export function releaseSection(name, text) {
  return `<!-- release:${name} -->\n\n${text.trim()}\n\n<!-- /release:${name} -->`;
}

/**
 * A release page with each named section's text replaced, and everything outside the markers
 * kept: a page drafted by hand keeps its highlights and limitations. Throws when a section's
 * markers are missing, rather than leave an old checksum or change list in place.
 */
export function fillReleasePage(page, sections) {
  let filled = page;
  for (const [name, text] of Object.entries(sections)) {
    const pattern = new RegExp(`<!-- release:${name} -->[\\s\\S]*?<!-- /release:${name} -->`);
    if (!pattern.test(filled)) {
      throw new Error(`the page has no <!-- release:${name} --> section`);
    }
    // A function, so `$` in the text (a version, a price) is never read as a replacement pattern.
    filled = filled.replace(pattern, () => releaseSection(name, text));
  }
  return filled;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(releaseNotes({ range: process.argv[2] }).trimEnd());
}
