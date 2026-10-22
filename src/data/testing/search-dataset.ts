// Test support for the search benchmark (assessment §5.4, M4.1) and the search tests: a seeded,
// synthetic browsing memory of any size, and a way to write it into a real database file.
//
// A port of spike S5's generator (spikes/s5-data-stack/lib/datagen.js) to typed objects. It keeps
// S5's vocabulary, sites, title and path shapes, visit counts and times, transition mix and default
// seed, so its data is comparable with S5's. It is not the same rows: S5 drew its hex ids from the
// same random stream before the pages, and this port draws its UUIDv7 bytes after them. Other
// changes: no strip tabs (the benchmark app must not load real websites at startup), keys and
// frecency come from the app (core/url/hygiene, core/search/frecency), and ids are UUIDv7.
//
// Test-only: the data worker and main never import this file.
import { dirname, join } from 'node:path';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { uuidv7 } from '../../core/id/uuidv7';
import { frecencyAfterVisit, type VisitTransition } from '../../core/search/frecency';
import { historyUrl } from '../../core/url/hygiene';
import { openDatabase } from '../database';

const DAY = 86_400_000;
/** The fixed "now" every memory is made at, so one seed always gives the same data (S5's NOW). */
export const DATASET_NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
/** S5's seed, the default: the default data is S5's data. */
const DEFAULT_SEED = 20261016;
/** S5's tab count, when the caller doesn't ask for one. */
const DEFAULT_TABS = 300;
/** Rows per transaction when seeding, so a large memory is not one long write. */
const CHUNK_ROWS = 5000;
/** The random bytes a UUIDv7 takes after its timestamp. */
const UUID_RANDOM_BYTES = 10;

export interface DatasetVisit {
  readonly visitedAt: number;
  readonly transition: VisitTransition;
}

export interface DatasetPage {
  readonly urlKey: string;
  readonly url: string;
  readonly host: string;
  readonly site: string;
  readonly title: string;
  readonly firstVisitAt: number;
  readonly lastVisitAt: number;
  readonly visitCount: number;
  readonly typedCount: number;
  readonly frecency: number;
  readonly frecencyAt: number;
  /** In time order. */
  readonly visits: readonly DatasetVisit[];
}

export interface DatasetTab {
  /** A UUIDv7 whose timestamp is the tab's creation time. */
  readonly id: string;
  readonly placement: 'shelf' | 'archive' | 'closed';
  /** Counts from 0 within its placement. */
  readonly position: number;
  /** Index into the dataset's pages. */
  readonly page: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly placementChangedAt: number;
  readonly archivedAt: number | null;
  readonly archiveReason: 'auto' | 'manual' | null;
  readonly closedAt: number | null;
}

export interface SearchDataset {
  /** A UUIDv7 whose timestamp is the workspace's creation time. */
  readonly workspaceId: string;
  readonly pages: readonly DatasetPage[];
  readonly tabs: readonly DatasetTab[];
}

export interface SearchDatasetOptions {
  readonly pages: number;
  readonly seed?: number;
  readonly tabs?: number;
  readonly now?: number;
}

type Rng = () => number;

interface SiteSpec {
  readonly host: string;
  readonly site: string;
  readonly cat: 'video' | 'dev' | 'docs' | 'wiki' | 'forum' | 'news';
  readonly style:
    | 'yt'
    | 'gh'
    | 'so'
    | 'wiki'
    | 'docs'
    | 'reddit'
    | 'hn'
    | 'npm'
    | 'blog'
    | 'news'
    | 'vimeo'
    | 'twitch'
    | 'ted';
  readonly suffix: string;
}

interface Pickers {
  readonly tech: () => string;
  readonly concept: () => string;
}

// ---------------------------------------------------------------- vocabulary

// Ordered roughly by how often a developer's history mentions them (Zipf head first).
const TECH: readonly string[] = [
  'PostgreSQL',
  'React',
  'Docker',
  'Kubernetes',
  'Rust',
  'Python',
  'TypeScript',
  'Tailwind',
  'Git',
  'Next.js',
  'JavaScript',
  'Postgres',
  'Node.js',
  'Go',
  'Linux',
  'GitHub',
  'Redis',
  'Vue',
  'SQLite',
  'Electron',
  'Java',
  'MySQL',
  'MongoDB',
  'Kafka',
  'Terraform',
  'Ansible',
  'Nginx',
  'Angular',
  'Svelte',
  'Kotlin',
  'Swift',
  'Ruby',
  'Rails',
  'Django',
  'Flask',
  'FastAPI',
  'Express',
  'GraphQL',
  'Webpack',
  'Vite',
  'ESLint',
  'Prettier',
  'Jest',
  'Vitest',
  'Playwright',
  'Cypress',
  'Bash',
  'PowerShell',
  'Windows',
  'Deno',
  'Bun',
  'WebAssembly',
  'LLVM',
  'OpenSSL',
  'Redux',
  'Prisma',
  'Supabase',
  'Vercel',
  'Cloudflare',
  'AWS',
  'Azure',
  'Grafana',
  'Prometheus',
  'Elasticsearch',
  'RabbitMQ',
  'Celery',
  'PyTorch',
  'TensorFlow',
  'Pandas',
  'NumPy',
  'OpenCV',
  'Unity',
  'Godot',
  'Flutter',
  'Android',
  'Firebase',
];
const CONCEPTS: readonly string[] = [
  'index',
  'performance',
  'hooks',
  'compose',
  'ownership',
  'server components',
  'ingress',
  'TLS certificates',
  'async await',
  'asyncio',
  'rebase',
  'CSS grid',
  'volumes',
  'migrations',
  'caching',
  'authentication',
  'indexing strategy',
  'query planner',
  'transactions',
  'schema design',
  'replication',
  'authorization',
  'OAuth flow',
  'JWT tokens',
  'middleware',
  'routing',
  'components',
  'state management',
  'props',
  'context',
  'memory leaks',
  'concurrency',
  'promises',
  'streams',
  'generics',
  'lifetimes',
  'traits',
  'interfaces',
  'decorators',
  'unit testing',
  'mocking',
  'debugging',
  'profiling',
  'logging',
  'monitoring',
  'deployment',
  'networking',
  'containers',
  'CI pipeline',
  'workflows',
  'secrets',
  'environment variables',
  'configuration',
  'suspense',
  'error handling',
  'pagination',
  'full text search',
  'rate limiting',
  'websockets',
  'CORS',
  'CSP headers',
  'dark mode',
  'responsive layout',
  'flexbox',
  'animations',
  'accessibility',
  'bundle size',
  'tree shaking',
  'hot reload',
  'monorepo',
  'linting',
  'formatting',
  'type inference',
  'regular expressions',
  'date handling',
  'file uploads',
  'background jobs',
  'queues',
  'cron jobs',
  'backup and restore',
  'connection pooling',
  'vacuum',
  'locking',
  'deadlocks',
  'window functions',
  'JSON columns',
  'foreign keys',
  'triggers',
  'views',
  'stored procedures',
  'merge conflicts',
  'branching',
];
const QUALIFIERS: readonly string[] = [
  'performance tips',
  'best practices',
  'explained',
  'cheat sheet',
  'for beginners',
  'in production',
  'troubleshooting guide',
  'tutorial',
  'reference',
  'examples',
  'common mistakes',
  'internals',
  'release notes',
];
const VERBS: readonly string[] = [
  'install',
  'configure',
  'debug',
  'optimize',
  'migrate',
  'deploy',
  'test',
  'build',
  'fix',
  'secure',
  'monitor',
  'set up',
  'speed up',
  'handle',
  'write',
];
const ORGS: readonly string[] = [
  'acme',
  'nova',
  'lumen',
  'kestrel',
  'orbit',
  'quill',
  'helix',
  'ember',
  'tundra',
  'zephyr',
  'atlas',
  'mosaic',
];
const REPOS: readonly string[] = [
  'core',
  'cli',
  'server',
  'toolkit',
  'engine',
  'sdk',
  'dashboard',
  'gateway',
  'runtime',
  'kit',
  'studio',
  'cloud',
];

const NEWS_SUBJECTS: readonly string[] = [
  'Markets',
  'Government',
  'City council',
  'Researchers',
  'Scientists',
  'Officials',
  'The central bank',
  'Lawmakers',
  'Voters',
  'Airlines',
  'Farmers',
  'Teachers',
  'Police',
  'Hospitals',
  'Tech giants',
  'Startups',
  'Unions',
  'Regulators',
  'Residents',
  'Investors',
];
const NEWS_VERBS: readonly string[] = [
  'announce',
  'warn of',
  'approve',
  'reject',
  'launch',
  'delay',
  'investigate',
  'brace for',
  'respond to',
  'prepare for',
  'challenge',
  'welcome',
  'question',
  'review',
];
const NEWS_OBJECTS: readonly string[] = [
  'new budget',
  'election results',
  'climate plan',
  'tariffs',
  'interest rates',
  'typhoon damage',
  'transport strike',
  'housing policy',
  'vaccine rollout',
  'data privacy law',
  'power outage',
  'minimum wage',
  'tax reform',
  'trade deal',
  'water shortage',
  'school reopening',
  'flood response',
  'merger deal',
  'energy prices',
  'border rules',
];
const NEWS_TAILS: readonly string[] = [
  'what we know',
  'live updates',
  'analysis',
  'explained',
  'reaction',
  'what happens next',
  'in pictures',
  'opinion',
  'timeline',
];

const VIDEO_TOPICS: readonly string[] = [
  'guitar',
  'sourdough bread',
  'home server',
  'mechanical keyboards',
  'chess openings',
  'photography',
  'travel vlog',
  'podcast',
  'documentary',
  'speedrun',
  'woodworking',
  'budget setup',
  'game review',
  'lofi mix',
  'cooking pasta',
];
const VIDEO_FORMS: readonly string[] = [
  'full course',
  'crash course',
  'explained in {n} minutes',
  'for beginners',
  'live stream',
  'in {n} hours',
  'complete guide',
  'tier list',
  'review',
  'what I learned',
  'vs',
];

const WIKI_TOPICS: readonly string[] = [
  'Relational model',
  'Inverted index',
  'B-tree',
  'Write-ahead logging',
  'Event loop',
  'Garbage collection',
  'TCP',
  'Unicode',
  'Mutex',
  'Hash table',
  'Bloom filter',
  'Public-key cryptography',
  'Finite-state machine',
  'Concurrency',
  'Memory management',
];
const FORUM_TAILS: readonly string[] = [
  'Ask HN',
  'Show HN',
  'discussion thread',
  'megathread',
  'what are you using',
  'help needed',
  'weekly thread',
];

const SYLLABLES: readonly string[] = [
  'ba',
  'ko',
  'ri',
  'lu',
  'ta',
  'mi',
  'ne',
  'so',
  'ven',
  'dor',
  'lex',
  'pix',
  'mon',
  'tri',
  'cal',
  'zen',
  'bit',
  'nov',
  'fur',
  'gri',
  'sol',
  'har',
  'kel',
  'dun',
  'ply',
];
const TAIL_PREFIX: readonly string[] = [
  'byte',
  'daily',
  'open',
  'quick',
  'pixel',
  'cloud',
  'dev',
  'tech',
  'north',
  'bright',
  'blue',
  'iron',
  'paper',
  'signal',
  'stack',
  'vector',
  'maple',
  'harbor',
  'lantern',
  'cobalt',
];
const TAIL_SUFFIX: readonly string[] = [
  'lab',
  'hub',
  'notes',
  'press',
  'works',
  'ledger',
  'times',
  'forge',
  'journal',
  'desk',
  'weekly',
  'base',
  'wire',
  'craft',
  'daily',
  'post',
];
const TAIL_CATEGORIES: readonly SiteSpec['cat'][] = [
  'dev',
  'dev',
  'docs',
  'news',
  'news',
  'video',
  'forum',
  'wiki',
];
const TLDS: readonly string[] = [
  'com',
  'io',
  'dev',
  'net',
  'org',
  'co',
  'app',
  'blog',
  'news',
  'tv',
  'ph',
];

// Curated head sites, in rough popularity order (Zipf weights follow list position).
// style = URL path shape, suffix = how the site brands its <title>.
const HEAD_SITES: readonly SiteSpec[] = [
  { host: 'www.youtube.com', site: 'youtube.com', cat: 'video', style: 'yt', suffix: ' - YouTube' },
  { host: 'github.com', site: 'github.com', cat: 'dev', style: 'gh', suffix: ' · GitHub' },
  {
    host: 'stackoverflow.com',
    site: 'stackoverflow.com',
    cat: 'dev',
    style: 'so',
    suffix: ' - Stack Overflow',
  },
  {
    host: 'en.wikipedia.org',
    site: 'wikipedia.org',
    cat: 'wiki',
    style: 'wiki',
    suffix: ' - Wikipedia',
  },
  {
    host: 'developer.mozilla.org',
    site: 'mozilla.org',
    cat: 'docs',
    style: 'docs',
    suffix: ' | MDN',
  },
  {
    host: 'www.reddit.com',
    site: 'reddit.com',
    cat: 'forum',
    style: 'reddit',
    suffix: ' : r/programming',
  },
  {
    host: 'news.ycombinator.com',
    site: 'ycombinator.com',
    cat: 'forum',
    style: 'hn',
    suffix: ' | Hacker News',
  },
  {
    host: 'docs.python.org',
    site: 'python.org',
    cat: 'docs',
    style: 'docs',
    suffix: ' — Python documentation',
  },
  {
    host: 'www.postgresql.org',
    site: 'postgresql.org',
    cat: 'docs',
    style: 'docs',
    suffix: ': PostgreSQL Documentation',
  },
  { host: 'nodejs.org', site: 'nodejs.org', cat: 'docs', style: 'docs', suffix: ' | Node.js' },
  { host: 'react.dev', site: 'react.dev', cat: 'docs', style: 'docs', suffix: ' – React' },
  { host: 'nextjs.org', site: 'nextjs.org', cat: 'docs', style: 'docs', suffix: ' | Next.js' },
  {
    host: 'docs.docker.com',
    site: 'docker.com',
    cat: 'docs',
    style: 'docs',
    suffix: ' | Docker Docs',
  },
  {
    host: 'kubernetes.io',
    site: 'kubernetes.io',
    cat: 'docs',
    style: 'docs',
    suffix: ' | Kubernetes',
  },
  {
    host: 'doc.rust-lang.org',
    site: 'rust-lang.org',
    cat: 'docs',
    style: 'docs',
    suffix: ' - The Rust Programming Language',
  },
  {
    host: 'www.typescriptlang.org',
    site: 'typescriptlang.org',
    cat: 'docs',
    style: 'docs',
    suffix: ': Documentation - TypeScript',
  },
  {
    host: 'tailwindcss.com',
    site: 'tailwindcss.com',
    cat: 'docs',
    style: 'docs',
    suffix: ' - Tailwind CSS',
  },
  {
    host: 'www.electronjs.org',
    site: 'electronjs.org',
    cat: 'docs',
    style: 'docs',
    suffix: ' | Electron',
  },
  { host: 'www.sqlite.org', site: 'sqlite.org', cat: 'docs', style: 'docs', suffix: ' - SQLite' },
  {
    host: 'learn.microsoft.com',
    site: 'microsoft.com',
    cat: 'docs',
    style: 'docs',
    suffix: ' | Microsoft Learn',
  },
  { host: 'www.npmjs.com', site: 'npmjs.com', cat: 'dev', style: 'npm', suffix: ' - npm' },
  { host: 'dev.to', site: 'dev.to', cat: 'dev', style: 'blog', suffix: ' - DEV Community' },
  { host: 'medium.com', site: 'medium.com', cat: 'dev', style: 'blog', suffix: ' | Medium' },
  { host: 'www.bbc.com', site: 'bbc.com', cat: 'news', style: 'news', suffix: ' - BBC News' },
  {
    host: 'www.reuters.com',
    site: 'reuters.com',
    cat: 'news',
    style: 'news',
    suffix: ' | Reuters',
  },
  {
    host: 'www.theguardian.com',
    site: 'theguardian.com',
    cat: 'news',
    style: 'news',
    suffix: ' | The Guardian',
  },
  {
    host: 'www.nytimes.com',
    site: 'nytimes.com',
    cat: 'news',
    style: 'news',
    suffix: ' - The New York Times',
  },
  {
    host: 'www.rappler.com',
    site: 'rappler.com',
    cat: 'news',
    style: 'news',
    suffix: ' - Rappler',
  },
  {
    host: 'newsinfo.inquirer.net',
    site: 'inquirer.net',
    cat: 'news',
    style: 'news',
    suffix: ' | Inquirer.net',
  },
  {
    host: 'www.gmanetwork.com',
    site: 'gmanetwork.com',
    cat: 'news',
    style: 'news',
    suffix: ' | GMA News Online',
  },
  {
    host: 'www.philstar.com',
    site: 'philstar.com',
    cat: 'news',
    style: 'news',
    suffix: ' | Philstar.com',
  },
  {
    host: 'techcrunch.com',
    site: 'techcrunch.com',
    cat: 'news',
    style: 'news',
    suffix: ' | TechCrunch',
  },
  {
    host: 'www.theverge.com',
    site: 'theverge.com',
    cat: 'news',
    style: 'news',
    suffix: ' | The Verge',
  },
  {
    host: 'arstechnica.com',
    site: 'arstechnica.com',
    cat: 'news',
    style: 'news',
    suffix: ' | Ars Technica',
  },
  { host: 'www.cnbc.com', site: 'cnbc.com', cat: 'news', style: 'news', suffix: ' | CNBC' },
  { host: 'vimeo.com', site: 'vimeo.com', cat: 'video', style: 'vimeo', suffix: ' on Vimeo' },
  { host: 'www.twitch.tv', site: 'twitch.tv', cat: 'video', style: 'twitch', suffix: ' - Twitch' },
  { host: 'www.ted.com', site: 'ted.com', cat: 'video', style: 'ted', suffix: ' | TED Talk' },
  { host: 'web.dev', site: 'web.dev', cat: 'docs', style: 'docs', suffix: ' | web.dev' },
  {
    host: 'css-tricks.com',
    site: 'css-tricks.com',
    cat: 'dev',
    style: 'blog',
    suffix: ' | CSS-Tricks',
  },
  {
    host: 'www.digitalocean.com',
    site: 'digitalocean.com',
    cat: 'dev',
    style: 'docs',
    suffix: ' | DigitalOcean',
  },
  {
    host: 'developers.cloudflare.com',
    site: 'cloudflare.com',
    cat: 'docs',
    style: 'docs',
    suffix: ' · Cloudflare docs',
  },
  {
    host: 'supabase.com',
    site: 'supabase.com',
    cat: 'docs',
    style: 'docs',
    suffix: ' | Supabase Docs',
  },
  { host: 'vercel.com', site: 'vercel.com', cat: 'docs', style: 'docs', suffix: ' – Vercel' },
  {
    host: 'www.baeldung.com',
    site: 'baeldung.com',
    cat: 'dev',
    style: 'blog',
    suffix: ' | Baeldung',
  },
  {
    host: 'www.geeksforgeeks.org',
    site: 'geeksforgeeks.org',
    cat: 'dev',
    style: 'blog',
    suffix: ' - GeeksforGeeks',
  },
  { host: 'www.freecodecamp.org', site: 'freecodecamp.org', cat: 'dev', style: 'blog', suffix: '' },
];

// ---------------------------------------------------------------- helpers

/** mulberry32: tiny, fast, good-enough seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** items[index], for an index the generator computed itself: out of range would be a bug here. */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`index ${String(index)} is outside ${String(items.length)} items`);
  }
  return item;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return itemAt(items, Math.floor(rng() * items.length));
}

function swap(items: number[], a: number, b: number): void {
  const first = itemAt(items, a);
  items[a] = itemAt(items, b);
  items[b] = first;
}

function hex(rng: Rng, digits: number): string {
  let out = '';
  while (out.length < digits)
    out += Math.floor(rng() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return out.slice(0, digits);
}

const YT_ID_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function ytId(rng: Rng): string {
  return Array.from({ length: 11 }, () =>
    YT_ID_CHARACTERS.charAt(Math.floor(rng() * YT_ID_CHARACTERS.length)),
  ).join('');
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const cap = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The random part of a UUIDv7, drawn from the seeded stream so the ids repeat too. */
function randomBytes(rng: Rng): Uint8Array {
  return Uint8Array.from({ length: UUID_RANDOM_BYTES }, () => Math.floor(rng() * 256));
}

/** The creation time a UUIDv7 carries: its first 48 bits, in Unix milliseconds. */
function uuidv7Millis(id: string): number {
  return Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
}

function makeSites(rng: Rng, pageCount: number): SiteSpec[] {
  const sites: SiteSpec[] = HEAD_SITES.map((site) => ({ ...site }));
  const seen = new Set(sites.map((site) => site.host));
  const tailCount = Math.max(20, Math.ceil(pageCount / 20));
  for (let i = 0; i < tailCount; i += 1) {
    let name = `${pick(rng, TAIL_PREFIX)}${pick(rng, TAIL_SUFFIX)}`;
    if (rng() < 0.35) name += `${pick(rng, SYLLABLES)}${pick(rng, SYLLABLES)}`;
    const site = `${name}.${pick(rng, TLDS)}`;
    if (seen.has(site)) continue;
    seen.add(site);
    const cat = pick(rng, TAIL_CATEGORIES);
    const www = rng() < 0.5;
    sites.push({
      host: www ? `www.${site}` : site,
      site,
      cat,
      style: cat === 'news' ? 'news' : cat === 'video' ? 'vimeo' : 'blog',
      suffix: ` | ${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    });
  }
  return sites;
}

/** A sampler over 0..count-1 where index i has weight 1 / (i + 1)^exponent (Zipf). */
function zipfSampler(count: number, exponent: number, rng: Rng): () => number {
  const cumulative: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += 1 / (i + 1) ** exponent;
    cumulative.push(total);
  }
  return () => {
    const x = rng() * total;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (itemAt(cumulative, mid) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

function makeTitle(rng: Rng, site: SiteSpec, pickers: Pickers): { title: string; core: string } {
  // The draws below happen in S5's order, and every default-case option is built (see there).
  const tech = pickers.tech();
  let tech2 = pickers.tech();
  const concept = pickers.concept();
  const qual = pick(rng, QUALIFIERS);
  const verb = pick(rng, VERBS);
  const version = `${String(1 + Math.floor(rng() * 20))}.${String(Math.floor(rng() * 10))}`;
  const n = 2 + Math.floor(rng() * 58);
  while (tech2 === tech) tech2 = pickers.tech();

  let core: string;
  switch (site.cat) {
    case 'news': {
      const t = Math.floor(rng() * 3);
      const headline =
        t === 0
          ? `${pick(rng, NEWS_SUBJECTS)} ${pick(rng, NEWS_VERBS)} ${pick(rng, NEWS_OBJECTS)}`
          : t === 1
            ? `${pick(rng, NEWS_OBJECTS)}: ${pick(rng, NEWS_TAILS)}`
            : `${pick(rng, NEWS_SUBJECTS)} ${pick(rng, NEWS_VERBS)} ${pick(rng, NEWS_OBJECTS)} amid ${pick(rng, NEWS_OBJECTS)}`;
      core = cap(headline);
      break;
    }
    case 'video': {
      const form = pick(rng, VIDEO_FORMS).replace('{n}', String(n));
      core =
        rng() < 0.5
          ? `${cap(rng() < 0.5 ? pick(rng, VIDEO_TOPICS) : tech)} ${form}`
          : `I tried ${tech} for ${String(n)} days (${pick(rng, VIDEO_TOPICS)})`;
      break;
    }
    case 'wiki':
      core = pick(rng, WIKI_TOPICS);
      break;
    case 'forum':
      core =
        rng() < 0.5
          ? `${tech} ${pick(rng, FORUM_TAILS)}: ${concept}`
          : `${cap(verb)} ${concept} in ${tech}?`;
      break;
    default: {
      const t = Math.floor(rng() * 10);
      // Every option is built, as in S5: the picks inside the list are drawn for each title.
      const options = [
        `How to ${verb} ${concept} in ${tech}`,
        `${tech}: ${concept} ${qual}`,
        `${cap(concept)} - ${tech} Documentation`,
        `${cap(verb)} ${concept} with ${tech} and ${tech2}`,
        `${tech} ${version}: ${concept} changes`,
        `${tech} vs ${tech2}: ${concept} compared`,
        `Why is my ${tech} ${concept} so slow?`,
        `Understanding ${concept} in ${tech}`,
        `${pick(rng, ORGS)}/${pick(rng, REPOS)}: ${tech} ${concept} library`,
        `${concept} ${qual} (${tech})`,
      ];
      core = itemAt(options, t);
    }
  }
  return { title: `${core}${site.suffix}`, core };
}

function makePath(rng: Rng, site: SiteSpec, core: string, i: number): string {
  const slug = slugify(core).split('-').slice(0, 9).join('-');
  switch (site.style) {
    case 'yt':
      return `/watch?v=${ytId(rng)}`;
    case 'gh': {
      const repo = `/${pick(rng, ORGS)}/${pick(rng, REPOS)}/`;
      return rng() < 0.5
        ? `${repo}issues/${String(1 + Math.floor(rng() * 9000))}`
        : `${repo}blob/main/${pick(rng, ['src', 'docs', 'lib'])}/${slug.slice(0, 20)}.md`;
    }
    case 'so':
      return `/questions/${String(10_000_000 + Math.floor(rng() * 70_000_000))}/${slug}`;
    case 'wiki':
      return `/wiki/${slugify(core).replace(/-/g, '_')}`;
    case 'reddit':
      return `/r/programming/comments/${hex(rng, 7)}/${slug}/`;
    case 'hn':
      return `/item?id=${String(30_000_000 + Math.floor(rng() * 9_000_000))}`;
    case 'npm':
      return `/package/${slug.split('-').slice(0, 2).join('-')}-${String(i)}`;
    case 'news': {
      const month = 1 + Math.floor(rng() * 12);
      const day = 1 + Math.floor(rng() * 28);
      const dated =
        rng() < 0.5
          ? `${String(2025 + Math.floor(rng() * 2))}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`
          : 'news';
      return `/${dated}/${slug}-${hex(rng, 6)}`;
    }
    case 'vimeo':
      return `/${String(100_000_000 + Math.floor(rng() * 800_000_000))}`;
    case 'twitch':
      return `/videos/${String(1_800_000_000 + Math.floor(rng() * 400_000_000))}`;
    case 'ted':
      return `/talks/${slug.split('-').slice(0, 5).join('_')}`;
    case 'docs':
      return `/docs/${slugify(core.split(' ').slice(0, 2).join(' '))}/${slug}`;
    case 'blog':
      return `/${slug}-${hex(rng, 5)}`;
  }
}

/** The transition mix (S5): a visit's transition is drawn from these weights. */
const TRANSITIONS: readonly (readonly [VisitTransition, number])[] = [
  ['link', 0.6],
  ['typed', 0.08],
  ['reload', 0.08],
  ['back_forward', 0.08],
  ['restore', 0.04],
  ['redirect', 0.03],
  ['generated', 0.04],
  ['other', 0.05],
];

function pickTransition(rng: Rng): VisitTransition {
  let x = rng();
  for (const [name, p] of TRANSITIONS) {
    x -= p;
    if (x < 0) return name;
  }
  return 'link';
}

// ---------------------------------------------------------------- generator

/**
 * The dataset for these options: the same options always give the same dataset. The pages are
 * drawn first and the workspace and tabs after, so how the ids are made never changes a page.
 */
export function generateSearchDataset(options: SearchDatasetOptions): SearchDataset {
  const pageCount = options.pages;
  const tabCount = options.tabs ?? DEFAULT_TABS;
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new RangeError('pages must be a whole number, zero or more');
  }
  if (!Number.isSafeInteger(tabCount) || tabCount < 0) {
    throw new RangeError('tabs must be a whole number, zero or more');
  }
  const now = Math.floor(options.now ?? DATASET_NOW);
  const rng = mulberry32(options.seed ?? DEFAULT_SEED);

  const sites = makeSites(rng, pageCount);
  const nextSite = zipfSampler(sites.length, 1, rng);
  const nextTech = zipfSampler(TECH.length, 0.9, rng);
  const nextConcept = zipfSampler(CONCEPTS.length, 0.8, rng);
  const pickers: Pickers = {
    tech: () => itemAt(TECH, nextTech()),
    concept: () => itemAt(CONCEPTS, nextConcept()),
  };

  const pages: DatasetPage[] = [];
  const seenKeys = new Set<string>();
  // A page the app would not record is skipped and the next one is made, so the count is exact.
  for (let i = 1; pages.length < pageCount; i += 1) {
    const site = itemAt(sites, nextSite());
    const { title, core } = makeTitle(rng, site, pickers);
    let path = makePath(rng, site, core, i);
    let address = historyUrl(`https://${site.host}${path}`);
    if (address !== null && seenKeys.has(address.urlKey)) {
      // As in S5: a repeated address gets its page number as a query parameter.
      path += `${path.includes('?') ? '&' : '?'}p=${String(i)}`;
      address = historyUrl(`https://${site.host}${path}`);
    }
    if (address === null || seenKeys.has(address.urlKey)) continue;
    seenKeys.add(address.urlKey);

    // Visit count: 1 + floor(Exp(mean 2.466)) has mean 3.0; heavy-ish tail, capped.
    const visitCount = Math.min(60, 1 + Math.floor(-Math.log(1 - rng()) * 2.466));
    const lastAt = Math.floor(now - 365 * DAY * rng() ** 2);
    const spanMs = visitCount > 1 ? Math.floor(Math.min(lastAt, 300 * DAY * rng() ** 2)) : 0;
    const times = [lastAt];
    for (let v = 1; v < visitCount; v += 1) times.push(lastAt - Math.floor(spanMs * rng()));
    times.sort((a, b) => a - b);

    const firstVisitAt = itemAt(times, 0);
    const lastVisitAt = itemAt(times, times.length - 1);
    const visits: DatasetVisit[] = [];
    let frecency = 0;
    let frecencyAt = firstVisitAt;
    let typedCount = 0;
    for (const visitedAt of times) {
      const transition = pickTransition(rng);
      if (transition === 'typed') typedCount += 1;
      frecency = frecencyAfterVisit(frecency, frecencyAt, visitedAt, transition);
      frecencyAt = visitedAt;
      visits.push({ visitedAt, transition });
    }

    pages.push({
      urlKey: address.urlKey,
      url: address.url,
      host: new URL(address.url).hostname,
      site: site.site,
      title,
      firstVisitAt,
      lastVisitAt,
      visitCount: visits.length,
      typedCount,
      frecency,
      frecencyAt,
      visits,
    });
  }

  const workspaceId = uuidv7(now - 200 * DAY, randomBytes(rng));

  // Tabs: distinct pages, shuffled (a partial Fisher-Yates shuffle, as in S5). The placement
  // proportions are S5's: shelf 45%, archive 40%, closed 15% (S5's strip share joins the shelf).
  const tabTotal = Math.min(tabCount, pageCount);
  const order = Array.from({ length: pageCount }, (_, index) => index);
  for (let k = 0; k < tabTotal; k += 1) {
    swap(order, k, k + Math.floor(rng() * (pageCount - k)));
  }

  const positions: Record<DatasetTab['placement'], number> = { shelf: 0, archive: 0, closed: 0 };
  const tabs: DatasetTab[] = [];
  for (let k = 0; k < tabTotal; k += 1) {
    const x = rng();
    const placement = x < 0.45 ? 'shelf' : x < 0.85 ? 'archive' : 'closed';
    const createdAt = Math.floor(now - 120 * DAY * rng());
    const lastUsedAt = Math.min(now, createdAt + Math.floor(rng() * (now - createdAt)));
    const placementChangedAt = Math.min(now, lastUsedAt + Math.floor(rng() * DAY));
    const archiveReason = placement === 'archive' ? (rng() < 0.8 ? 'auto' : 'manual') : null;
    const position = positions[placement];
    positions[placement] += 1;
    tabs.push({
      id: uuidv7(createdAt, randomBytes(rng)),
      placement,
      position,
      page: itemAt(order, k),
      createdAt,
      lastUsedAt,
      placementChangedAt,
      archivedAt: placement === 'archive' ? placementChangedAt : null,
      archiveReason,
      closedAt: placement === 'closed' ? placementChangedAt : null,
    });
  }

  return { workspaceId, pages, tabs };
}

// ---------------------------------------------------------------- seeding

/**
 * Writes the dataset into the database file at `file`, creating and migrating it the way the data
 * worker does. Pages get ids 1 to N in order; a tab's page_id is its page's id.
 */
export async function seedSearchDatabase(file: string, dataset: SearchDataset): Promise<void> {
  const { db } = await openDatabase({ file, backupDir: join(dirname(file), 'backups') });
  try {
    writeDataset(db, dataset);
  } finally {
    db.close();
  }
}

type VisitRow = readonly [pageId: number, visitedAt: number, transition: VisitTransition];

function* visitRows(pages: readonly DatasetPage[]): Generator<VisitRow> {
  for (const [index, page] of pages.entries()) {
    for (const visit of page.visits) {
      yield [index + 1, visit.visitedAt, visit.transition];
    }
  }
}

/**
 * Hands `rows` to `write` in chunks of at most CHUNK_ROWS, each chunk in its own transaction: a
 * failure rolls back one chunk, and no transaction holds a long run of rows.
 */
function inTransactions<T>(
  db: DatabaseConnection,
  rows: Iterable<T>,
  write: (chunk: readonly T[]) => void,
): void {
  const commit = db.transaction((chunk: readonly T[]) => {
    write(chunk);
  });
  let chunk: T[] = [];
  for (const row of rows) {
    chunk.push(row);
    if (chunk.length === CHUNK_ROWS) {
      commit(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) commit(chunk);
}

function writeDataset(db: DatabaseConnection, dataset: SearchDataset): void {
  // A seeded workspace is never edited, so both of its times are its creation time.
  const createdAt = uuidv7Millis(dataset.workspaceId);
  db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run([
    dataset.workspaceId,
    'Default',
    createdAt,
    createdAt,
  ]);

  // The table is empty, so ids are assigned in insertion order: page i gets id i + 1.
  const insertPage = db.prepare(
    'INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at, visit_count, typed_count, frecency, frecency_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  inTransactions(db, dataset.pages, (chunk) => {
    for (const page of chunk) {
      insertPage.run([
        page.urlKey,
        page.url,
        page.host,
        page.site,
        page.title,
        page.firstVisitAt,
        page.lastVisitAt,
        page.visitCount,
        page.typedCount,
        page.frecency,
        page.frecencyAt,
      ]);
    }
  });

  const insertVisit = db.prepare(
    'INSERT INTO visits (page_id, tab_id, visited_at, transition) VALUES (?, NULL, ?, ?)',
  );
  inTransactions(db, visitRows(dataset.pages), (chunk) => {
    for (const row of chunk) insertVisit.run(row);
  });

  const insertTab = db.prepare(
    'INSERT INTO tabs (id, workspace_id, placement, position, page_id, url, title, created_at, last_used_at, last_used_engaged, last_used_active_day, placement_changed_at, archived_at, archive_reason, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  inTransactions(db, dataset.tabs, (chunk) => {
    for (const tab of chunk) {
      const page = itemAt(dataset.pages, tab.page);
      insertTab.run([
        tab.id,
        dataset.workspaceId,
        tab.placement,
        tab.position,
        tab.page + 1,
        page.url,
        page.title,
        tab.createdAt,
        tab.lastUsedAt,
        // S5's values, kept. They are not in the app's units (engaged milliseconds from zero, and a
        // count of active days), so the lifecycle thresholds that compare them never fire here.
        Math.floor(tab.lastUsedAt / 1000),
        Math.floor(tab.lastUsedAt / DAY),
        tab.placementChangedAt,
        tab.archivedAt,
        tab.archiveReason,
        tab.closedAt,
      ]);
    }
  });
}
