'use strict';
// Deterministic synthetic browsing-memory generator for spike S5.
// Same (pages, seed, tabs) always yields byte-identical rows. Pure JS, no I/O, usable in a worker.
//
// Output shape matches assessment §5.3:
//   pages  rows: [id, url_key, url, host, site, title, first_visit_at, last_visit_at,
//                 visit_count, typed_count, frecency, frecency_at]
//   visits rows: [page_id, tab_id|null, visited_at, transition]   (sorted by page_id, then time)
//   tabs   rows: [id, workspace_id, placement, position, pinned, user_protected, page_id, url, title,
//                 restore_state, opener_tab_id, created_at, last_used_at, last_used_engaged,
//                 last_used_active_day, placement_changed_at, archived_at, archive_reason, closed_at]

const DAY = 86_400_000;
const HALF_LIFE_MS = 30 * DAY; // frecency half-life, §5.4
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0); // fixed "now" so data is reproducible

/** mulberry32: tiny, fast, good-enough seeded PRNG returning floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- vocabulary

// Ordered roughly by how often a developer's history mentions them (Zipf head first).
const TECH = [
  'PostgreSQL', 'React', 'Docker', 'Kubernetes', 'Rust', 'Python', 'TypeScript', 'Tailwind', 'Git', 'Next.js',
  'JavaScript', 'Postgres', 'Node.js', 'Go', 'Linux', 'GitHub', 'Redis', 'Vue', 'SQLite', 'Electron', 'Java',
  'MySQL', 'MongoDB', 'Kafka', 'Terraform', 'Ansible', 'Nginx', 'Angular', 'Svelte', 'Kotlin', 'Swift', 'Ruby',
  'Rails', 'Django', 'Flask', 'FastAPI', 'Express', 'GraphQL', 'Webpack', 'Vite', 'ESLint', 'Prettier', 'Jest',
  'Vitest', 'Playwright', 'Cypress', 'Bash', 'PowerShell', 'Windows', 'Deno', 'Bun', 'WebAssembly', 'LLVM',
  'OpenSSL', 'Redux', 'Prisma', 'Supabase', 'Vercel', 'Cloudflare', 'AWS', 'Azure', 'Grafana', 'Prometheus',
  'Elasticsearch', 'RabbitMQ', 'Celery', 'PyTorch', 'TensorFlow', 'Pandas', 'NumPy', 'OpenCV', 'Unity', 'Godot',
  'Flutter', 'Android', 'Firebase',
];
const CONCEPTS = [
  'index', 'performance', 'hooks', 'compose', 'ownership', 'server components', 'ingress', 'TLS certificates',
  'async await', 'asyncio', 'rebase', 'CSS grid', 'volumes', 'migrations', 'caching', 'authentication',
  'indexing strategy', 'query planner', 'transactions', 'schema design', 'replication', 'authorization',
  'OAuth flow', 'JWT tokens', 'middleware', 'routing', 'components', 'state management', 'props', 'context',
  'memory leaks', 'concurrency', 'promises', 'streams', 'generics', 'lifetimes', 'traits', 'interfaces',
  'decorators', 'unit testing', 'mocking', 'debugging', 'profiling', 'logging', 'monitoring', 'deployment',
  'networking', 'containers', 'CI pipeline', 'workflows', 'secrets', 'environment variables', 'configuration',
  'suspense', 'error handling', 'pagination', 'full text search', 'rate limiting', 'websockets', 'CORS',
  'CSP headers', 'dark mode', 'responsive layout', 'flexbox', 'animations', 'accessibility', 'bundle size',
  'tree shaking', 'hot reload', 'monorepo', 'linting', 'formatting', 'type inference', 'regular expressions',
  'date handling', 'file uploads', 'background jobs', 'queues', 'cron jobs', 'backup and restore',
  'connection pooling', 'vacuum', 'locking', 'deadlocks', 'window functions', 'JSON columns', 'foreign keys',
  'triggers', 'views', 'stored procedures', 'merge conflicts', 'branching',
];
const QUALIFIERS = [
  'performance tips', 'best practices', 'explained', 'cheat sheet', 'for beginners', 'in production',
  'troubleshooting guide', 'tutorial', 'reference', 'examples', 'common mistakes', 'internals', 'release notes',
];
const VERBS = ['install', 'configure', 'debug', 'optimize', 'migrate', 'deploy', 'test', 'build', 'fix', 'secure', 'monitor', 'set up', 'speed up', 'handle', 'write'];
const ORGS = ['acme', 'nova', 'lumen', 'kestrel', 'orbit', 'quill', 'helix', 'ember', 'tundra', 'zephyr', 'atlas', 'mosaic'];
const REPOS = ['core', 'cli', 'server', 'toolkit', 'engine', 'sdk', 'dashboard', 'gateway', 'runtime', 'kit', 'studio', 'cloud'];

const NEWS_SUBJECTS = ['Markets', 'Government', 'City council', 'Researchers', 'Scientists', 'Officials', 'The central bank', 'Lawmakers', 'Voters', 'Airlines', 'Farmers', 'Teachers', 'Police', 'Hospitals', 'Tech giants', 'Startups', 'Unions', 'Regulators', 'Residents', 'Investors'];
const NEWS_VERBS = ['announce', 'warn of', 'approve', 'reject', 'launch', 'delay', 'investigate', 'brace for', 'respond to', 'prepare for', 'challenge', 'welcome', 'question', 'review'];
const NEWS_OBJECTS = ['new budget', 'election results', 'climate plan', 'tariffs', 'interest rates', 'typhoon damage', 'transport strike', 'housing policy', 'vaccine rollout', 'data privacy law', 'power outage', 'minimum wage', 'tax reform', 'trade deal', 'water shortage', 'school reopening', 'flood response', 'merger deal', 'energy prices', 'border rules'];
const NEWS_TAILS = ['what we know', 'live updates', 'analysis', 'explained', 'reaction', 'what happens next', 'in pictures', 'opinion', 'timeline'];

const VIDEO_TOPICS = ['guitar', 'sourdough bread', 'home server', 'mechanical keyboards', 'chess openings', 'photography', 'travel vlog', 'podcast', 'documentary', 'speedrun', 'woodworking', 'budget setup', 'game review', 'lofi mix', 'cooking pasta'];
const VIDEO_FORMS = ['full course', 'crash course', 'explained in {n} minutes', 'for beginners', 'live stream', 'in {n} hours', 'complete guide', 'tier list', 'review', 'what I learned', 'vs'];

const WIKI_TOPICS = ['Relational model', 'Inverted index', 'B-tree', 'Write-ahead logging', 'Event loop', 'Garbage collection', 'TCP', 'Unicode', 'Mutex', 'Hash table', 'Bloom filter', 'Public-key cryptography', 'Finite-state machine', 'Concurrency', 'Memory management'];
const FORUM_TAILS = ['Ask HN', 'Show HN', 'discussion thread', 'megathread', 'what are you using', 'help needed', 'weekly thread'];

const SYLLABLES = ['ba', 'ko', 'ri', 'lu', 'ta', 'mi', 'ne', 'so', 'ven', 'dor', 'lex', 'pix', 'mon', 'tri', 'cal', 'zen', 'bit', 'nov', 'fur', 'gri', 'sol', 'har', 'kel', 'dun', 'ply'];
const TAIL_PREFIX = ['byte', 'daily', 'open', 'quick', 'pixel', 'cloud', 'dev', 'tech', 'north', 'bright', 'blue', 'iron', 'paper', 'signal', 'stack', 'vector', 'maple', 'harbor', 'lantern', 'cobalt'];
const TAIL_SUFFIX = ['lab', 'hub', 'notes', 'press', 'works', 'ledger', 'times', 'forge', 'journal', 'desk', 'weekly', 'base', 'wire', 'craft', 'daily', 'post'];
const TLDS = ['com', 'io', 'dev', 'net', 'org', 'co', 'app', 'blog', 'news', 'tv', 'ph'];

// Curated head sites, in rough popularity order (Zipf weights follow list position).
// style = URL path shape, suffix = how the site brands its <title>.
const HEAD_SITES = [
  { host: 'www.youtube.com', site: 'youtube.com', cat: 'video', style: 'yt', suffix: ' - YouTube' },
  { host: 'github.com', site: 'github.com', cat: 'dev', style: 'gh', suffix: ' · GitHub' },
  { host: 'stackoverflow.com', site: 'stackoverflow.com', cat: 'dev', style: 'so', suffix: ' - Stack Overflow' },
  { host: 'en.wikipedia.org', site: 'wikipedia.org', cat: 'wiki', style: 'wiki', suffix: ' - Wikipedia' },
  { host: 'developer.mozilla.org', site: 'mozilla.org', cat: 'docs', style: 'docs', suffix: ' | MDN' },
  { host: 'www.reddit.com', site: 'reddit.com', cat: 'forum', style: 'reddit', suffix: ' : r/programming' },
  { host: 'news.ycombinator.com', site: 'ycombinator.com', cat: 'forum', style: 'hn', suffix: ' | Hacker News' },
  { host: 'docs.python.org', site: 'python.org', cat: 'docs', style: 'docs', suffix: ' — Python documentation' },
  { host: 'www.postgresql.org', site: 'postgresql.org', cat: 'docs', style: 'docs', suffix: ': PostgreSQL Documentation' },
  { host: 'nodejs.org', site: 'nodejs.org', cat: 'docs', style: 'docs', suffix: ' | Node.js' },
  { host: 'react.dev', site: 'react.dev', cat: 'docs', style: 'docs', suffix: ' – React' },
  { host: 'nextjs.org', site: 'nextjs.org', cat: 'docs', style: 'docs', suffix: ' | Next.js' },
  { host: 'docs.docker.com', site: 'docker.com', cat: 'docs', style: 'docs', suffix: ' | Docker Docs' },
  { host: 'kubernetes.io', site: 'kubernetes.io', cat: 'docs', style: 'docs', suffix: ' | Kubernetes' },
  { host: 'doc.rust-lang.org', site: 'rust-lang.org', cat: 'docs', style: 'docs', suffix: ' - The Rust Programming Language' },
  { host: 'www.typescriptlang.org', site: 'typescriptlang.org', cat: 'docs', style: 'docs', suffix: ': Documentation - TypeScript' },
  { host: 'tailwindcss.com', site: 'tailwindcss.com', cat: 'docs', style: 'docs', suffix: ' - Tailwind CSS' },
  { host: 'www.electronjs.org', site: 'electronjs.org', cat: 'docs', style: 'docs', suffix: ' | Electron' },
  { host: 'www.sqlite.org', site: 'sqlite.org', cat: 'docs', style: 'docs', suffix: ' - SQLite' },
  { host: 'learn.microsoft.com', site: 'microsoft.com', cat: 'docs', style: 'docs', suffix: ' | Microsoft Learn' },
  { host: 'www.npmjs.com', site: 'npmjs.com', cat: 'dev', style: 'npm', suffix: ' - npm' },
  { host: 'dev.to', site: 'dev.to', cat: 'dev', style: 'blog', suffix: ' - DEV Community' },
  { host: 'medium.com', site: 'medium.com', cat: 'dev', style: 'blog', suffix: ' | Medium' },
  { host: 'www.bbc.com', site: 'bbc.com', cat: 'news', style: 'news', suffix: ' - BBC News' },
  { host: 'www.reuters.com', site: 'reuters.com', cat: 'news', style: 'news', suffix: ' | Reuters' },
  { host: 'www.theguardian.com', site: 'theguardian.com', cat: 'news', style: 'news', suffix: ' | The Guardian' },
  { host: 'www.nytimes.com', site: 'nytimes.com', cat: 'news', style: 'news', suffix: ' - The New York Times' },
  { host: 'www.rappler.com', site: 'rappler.com', cat: 'news', style: 'news', suffix: ' - Rappler' },
  { host: 'newsinfo.inquirer.net', site: 'inquirer.net', cat: 'news', style: 'news', suffix: ' | Inquirer.net' },
  { host: 'www.gmanetwork.com', site: 'gmanetwork.com', cat: 'news', style: 'news', suffix: ' | GMA News Online' },
  { host: 'www.philstar.com', site: 'philstar.com', cat: 'news', style: 'news', suffix: ' | Philstar.com' },
  { host: 'techcrunch.com', site: 'techcrunch.com', cat: 'news', style: 'news', suffix: ' | TechCrunch' },
  { host: 'www.theverge.com', site: 'theverge.com', cat: 'news', style: 'news', suffix: ' | The Verge' },
  { host: 'arstechnica.com', site: 'arstechnica.com', cat: 'news', style: 'news', suffix: ' | Ars Technica' },
  { host: 'www.cnbc.com', site: 'cnbc.com', cat: 'news', style: 'news', suffix: ' | CNBC' },
  { host: 'vimeo.com', site: 'vimeo.com', cat: 'video', style: 'vimeo', suffix: ' on Vimeo' },
  { host: 'www.twitch.tv', site: 'twitch.tv', cat: 'video', style: 'twitch', suffix: ' - Twitch' },
  { host: 'www.ted.com', site: 'ted.com', cat: 'video', style: 'ted', suffix: ' | TED Talk' },
  { host: 'web.dev', site: 'web.dev', cat: 'docs', style: 'docs', suffix: ' | web.dev' },
  { host: 'css-tricks.com', site: 'css-tricks.com', cat: 'dev', style: 'blog', suffix: ' | CSS-Tricks' },
  { host: 'www.digitalocean.com', site: 'digitalocean.com', cat: 'dev', style: 'docs', suffix: ' | DigitalOcean' },
  { host: 'developers.cloudflare.com', site: 'cloudflare.com', cat: 'docs', style: 'docs', suffix: ' · Cloudflare docs' },
  { host: 'supabase.com', site: 'supabase.com', cat: 'docs', style: 'docs', suffix: ' | Supabase Docs' },
  { host: 'vercel.com', site: 'vercel.com', cat: 'docs', style: 'docs', suffix: ' – Vercel' },
  { host: 'www.baeldung.com', site: 'baeldung.com', cat: 'dev', style: 'blog', suffix: ' | Baeldung' },
  { host: 'www.geeksforgeeks.org', site: 'geeksforgeeks.org', cat: 'dev', style: 'blog', suffix: ' - GeeksforGeeks' },
  { host: 'www.freecodecamp.org', site: 'freecodecamp.org', cat: 'dev', style: 'blog', suffix: '' },
];

// ---------------------------------------------------------------- helpers

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hex = (rng, n) => {
  let out = '';
  while (out.length < n) out += Math.floor(rng() * 0x10000).toString(16).padStart(4, '0');
  return out.slice(0, n);
};
const uuid = (rng) => `${hex(rng, 8)}-${hex(rng, 4)}-7${hex(rng, 3)}-a${hex(rng, 3)}-${hex(rng, 12)}`;
const ytId = (rng) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let s = '';
  for (let i = 0; i < 11; i += 1) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
};

function makeSites(rng, pageCount) {
  const sites = HEAD_SITES.map((s) => ({ ...s }));
  const seen = new Set(sites.map((s) => s.host));
  const tailCount = Math.max(20, Math.ceil(pageCount / 20));
  const cats = ['dev', 'dev', 'docs', 'news', 'news', 'video', 'forum', 'wiki'];
  for (let i = 0; i < tailCount; i += 1) {
    const pick = (a) => a[Math.floor(rng() * a.length)];
    let name = `${pick(TAIL_PREFIX)}${pick(TAIL_SUFFIX)}`;
    if (rng() < 0.35) name += `${pick(SYLLABLES)}${pick(SYLLABLES)}`;
    const site = `${name}.${pick(TLDS)}`;
    if (seen.has(site)) continue;
    seen.add(site);
    const cat = pick(cats);
    const www = rng() < 0.5;
    sites.push({
      host: www ? `www.${site}` : site,
      site,
      cat,
      style: cat === 'news' ? 'news' : cat === 'video' ? 'vimeo' : 'blog',
      suffix: ` | ${name[0].toUpperCase()}${name.slice(1)}`,
    });
  }
  return sites;
}

function zipfSampler(count, exponent, rng) {
  const cumulative = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += 1 / (i + 1) ** exponent;
    cumulative[i] = total;
  }
  return () => {
    const x = rng() * total;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

function makeTitle(rng, site, pickers) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const c = {
    tech: pickers.tech(), tech2: pickers.tech(), concept: pickers.concept(), qual: pick(QUALIFIERS), verb: pick(VERBS),
    version: `${1 + Math.floor(rng() * 20)}.${Math.floor(rng() * 10)}`, n: 2 + Math.floor(rng() * 58),
  };
  while (c.tech2 === c.tech) c.tech2 = pickers.tech();
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  let core;
  switch (site.cat) {
    case 'news': {
      const t = Math.floor(rng() * 3);
      core = t === 0
        ? `${pick(NEWS_SUBJECTS)} ${pick(NEWS_VERBS)} ${pick(NEWS_OBJECTS)}`
        : t === 1
          ? `${pick(NEWS_OBJECTS)}: ${pick(NEWS_TAILS)}`
          : `${pick(NEWS_SUBJECTS)} ${pick(NEWS_VERBS)} ${pick(NEWS_OBJECTS)} amid ${pick(NEWS_OBJECTS)}`;
      core = cap(core);
      break;
    }
    case 'video': {
      const form = pick(VIDEO_FORMS).replace('{n}', String(c.n));
      core = rng() < 0.5
        ? `${cap(rng() < 0.5 ? pick(VIDEO_TOPICS) : c.tech)} ${form}`
        : `I tried ${c.tech} for ${c.n} days (${pick(VIDEO_TOPICS)})`;
      break;
    }
    case 'wiki':
      core = pick(WIKI_TOPICS);
      break;
    case 'forum':
      core = rng() < 0.5 ? `${c.tech} ${pick(FORUM_TAILS)}: ${c.concept}` : `${cap(c.verb)} ${c.concept} in ${c.tech}?`;
      break;
    default: {
      const t = Math.floor(rng() * 10);
      core = [
        `How to ${c.verb} ${c.concept} in ${c.tech}`,
        `${c.tech}: ${c.concept} ${c.qual}`,
        `${cap(c.concept)} - ${c.tech} Documentation`,
        `${cap(c.verb)} ${c.concept} with ${c.tech} and ${c.tech2}`,
        `${c.tech} ${c.version}: ${c.concept} changes`,
        `${c.tech} vs ${c.tech2}: ${c.concept} compared`,
        `Why is my ${c.tech} ${c.concept} so slow?`,
        `Understanding ${c.concept} in ${c.tech}`,
        `${pick(ORGS)}/${pick(REPOS)}: ${c.tech} ${c.concept} library`,
        `${c.concept} ${c.qual} (${c.tech})`,
      ][t];
    }
  }
  return { title: `${core}${site.suffix}`, core };
}

function makePath(rng, site, core, i) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const slug = slugify(core).split('-').slice(0, 9).join('-');
  switch (site.style) {
    case 'yt': return `/watch?v=${ytId(rng)}`;
    case 'gh': return `/${pick(ORGS)}/${pick(REPOS)}/${rng() < 0.5 ? `issues/${1 + Math.floor(rng() * 9000)}` : `blob/main/${pick(['src', 'docs', 'lib'])}/${slug.slice(0, 20)}.md`}`;
    case 'so': return `/questions/${10_000_000 + Math.floor(rng() * 70_000_000)}/${slug}`;
    case 'wiki': return `/wiki/${slugify(core).replace(/-/g, '_')}`;
    case 'reddit': return `/r/programming/comments/${hex(rng, 7)}/${slug}/`;
    case 'hn': return `/item?id=${30_000_000 + Math.floor(rng() * 9_000_000)}`;
    case 'npm': return `/package/${slug.split('-').slice(0, 2).join('-')}-${i}`;
    case 'news': {
      const month = 1 + Math.floor(rng() * 12);
      const day = 1 + Math.floor(rng() * 28);
      return `/${rng() < 0.5 ? `${2025 + Math.floor(rng() * 2)}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}` : 'news'}/${slug}-${hex(rng, 6)}`;
    }
    case 'vimeo': return `/${100_000_000 + Math.floor(rng() * 800_000_000)}`;
    case 'twitch': return `/videos/${1_800_000_000 + Math.floor(rng() * 400_000_000)}`;
    case 'ted': return `/talks/${slug.split('-').slice(0, 5).join('_')}`;
    case 'docs': return `/docs/${slugify(core.split(' ').slice(0, 2).join(' '))}/${slug}`;
    default: return `/${slug}-${hex(rng, 5)}`;
  }
}

const TRANSITIONS = [
  ['link', 0.60], ['typed', 0.08], ['reload', 0.08], ['back_forward', 0.08], ['restore', 0.04],
  ['redirect', 0.03], ['generated', 0.04], ['other', 0.05],
];
const VISIT_WEIGHT = { typed: 2, link: 1, restore: 0.5, back_forward: 0.5, reload: 0, redirect: 0, generated: 1, other: 1 };

function pickTransition(rng) {
  let x = rng();
  for (const [name, p] of TRANSITIONS) {
    x -= p;
    if (x < 0) return name;
  }
  return 'link';
}

// ---------------------------------------------------------------- main generator

/**
 * @param {{pages:number, seed?:number, tabs?:number, now?:number}} opts
 */
function generateDataset({ pages: pageCount, seed = 20261016, tabs: tabCount = 300, now = NOW }) {
  const rng = mulberry32(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const sites = makeSites(rng, pageCount);
  const nextSite = zipfSampler(sites.length, 1.0, rng);
  const nextTech = zipfSampler(TECH.length, 0.9, rng);
  const nextConcept = zipfSampler(CONCEPTS.length, 0.8, rng);
  const pickers = { tech: () => TECH[nextTech()], concept: () => CONCEPTS[nextConcept()] };

  const pages = [];
  const visits = [];
  const seenKeys = new Set();
  const workspaceId = uuid(rng);
  const tabIds = Array.from({ length: tabCount }, () => uuid(rng));

  for (let i = 1; i <= pageCount; i += 1) {
    const site = sites[nextSite()];
    const { title, core } = makeTitle(rng, site, pickers);
    let path = makePath(rng, site, core, i);
    let urlKey = `https://${site.host}${path}`.toLowerCase();
    if (seenKeys.has(urlKey)) {
      path += `${path.includes('?') ? '&' : '?'}p=${i}`;
      urlKey = `https://${site.host}${path}`.toLowerCase();
    }
    seenKeys.add(urlKey);
    const url = `https://${site.host}${path}`;

    // Visit count: 1 + floor(Exp(mean 2.466)) has mean 3.0; heavy-ish tail, capped.
    const visitCount = Math.min(60, 1 + Math.floor(-Math.log(1 - rng()) * 2.466));
    const lastAt = Math.floor(now - 365 * DAY * rng() ** 2);
    const spanMs = visitCount > 1 ? Math.floor(Math.min(lastAt, 300 * DAY * rng() ** 2)) : 0;
    const times = [lastAt];
    for (let v = 1; v < visitCount; v += 1) times.push(lastAt - Math.floor(spanMs * rng()));
    times.sort((a, b) => a - b);

    let frecency = 0;
    let frecencyAt = times[0];
    let typed = 0;
    for (let v = 0; v < times.length; v += 1) {
      const transition = pickTransition(rng);
      if (transition === 'typed') typed += 1;
      frecency = frecency * 2 ** (-(times[v] - frecencyAt) / HALF_LIFE_MS) + VISIT_WEIGHT[transition];
      frecencyAt = times[v];
      visits.push([i, rng() < 0.3 ? tabIds[Math.floor(rng() * tabCount)] : null, times[v], transition]);
    }
    pages.push([i, urlKey, url, site.host, site.site, title, times[0], times[times.length - 1], visitCount, typed, frecency, frecencyAt]);
  }

  // Tabs: distinct pages, mixed placement. Proportions loosely modelled on a heavy tab user.
  const tabs = [];
  const pageIdx = Array.from({ length: pageCount }, (_, k) => k);
  for (let k = 0; k < Math.min(tabCount, pageCount); k += 1) {
    const j = k + Math.floor(rng() * (pageCount - k));
    [pageIdx[k], pageIdx[j]] = [pageIdx[j], pageIdx[k]];
  }
  const counters = { strip: 0, shelf: 0, archive: 0, closed: 0 };
  for (let k = 0; k < Math.min(tabCount, pageCount); k += 1) {
    const page = pages[pageIdx[k]];
    const x = rng();
    const placement = x < 0.15 ? 'strip' : x < 0.45 ? 'shelf' : x < 0.85 ? 'archive' : 'closed';
    const pinned = placement === 'strip' && rng() < 0.15 ? 1 : 0;
    const created = Math.floor(now - 120 * DAY * rng());
    const lastUsed = Math.min(now, created + Math.floor(rng() * (now - created)));
    const changedAt = Math.min(now, lastUsed + Math.floor(rng() * DAY));
    const entryCount = 1 + Math.floor(rng() * 12);
    const entries = [];
    for (let e = 0; e < entryCount; e += 1) {
      const ep = e === entryCount - 1 ? page : pages[Math.floor(rng() * pageCount)];
      entries.push({ url: ep[2], title: ep[5] });
    }
    tabs.push([
      tabIds[k], workspaceId, placement, counters[placement]++, pinned, rng() < 0.05 ? 1 : 0, page[0], page[2], page[5],
      JSON.stringify({ v: 1, index: entryCount - 1, entries }), rng() < 0.3 ? tabIds[Math.floor(rng() * tabCount)] : null,
      created, lastUsed, Math.floor(lastUsed / 1000), Math.floor(lastUsed / DAY), changedAt,
      placement === 'archive' ? changedAt : null, placement === 'archive' ? (rng() < 0.8 ? 'auto' : 'manual') : null,
      placement === 'closed' ? changedAt : null,
    ]);
  }

  return {
    workspace: [workspaceId, 'Default', now - 200 * DAY, now],
    pages,
    visits,
    tabs,
    sitesDistinct: new Set(pages.map((p) => p[4])).size,
    stats: { pages: pages.length, visits: visits.length, tabs: tabs.length, visitsPerPage: visits.length / pages.length },
  };
}

module.exports = { generateDataset, mulberry32, NOW, DAY, HALF_LIFE_MS };
