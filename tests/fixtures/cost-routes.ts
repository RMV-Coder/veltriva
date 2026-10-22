// The controlled-cost page of the fixture server (assessment §9.3's synthetic corpus, the same
// page as spike S8's): its JavaScript heap and DOM size come from the query, so a memory
// measurement knows what each tab holds.
//   /cost/page?heapMB=&domKB=&title=   `heapMB` MB of JS heap ballast (an array of doubles),
//                                      about `domKB` KB of text in the DOM, and `title`
import type { ServerResponse } from 'node:http';

const MAX_HEAP_MB = 256;
const MAX_DOM_KB = 4096;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

function bounded(params: URLSearchParams, name: string, max: number): number {
  const value = Number(params.get(name) ?? 0);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), max) : 0;
}

export function costPageHtml(title: string, heapMB: number, domKB: number): string {
  const filler = 'x'.repeat(1024);
  const blocks = Array.from(
    { length: domKB },
    (_, index) => `<div class="b" id="b${String(index)}">${filler}</div>`,
  ).join('');
  // 131,072 doubles of 8 bytes are 1 MB.
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<h1>${escapeHtml(title)}</h1>
<script>
  window.__ballast = new Array(${String(heapMB * 131072)}).fill(1.5);
</script>
<div style="font-size:2px;color:#ddd">${blocks}</div>`;
}

/** Handles `/cost/…`. Returns false for a path it doesn't know. */
export function handleCostRoute(
  pathname: string,
  params: URLSearchParams,
  response: ServerResponse,
): boolean {
  if (pathname !== '/cost/page') {
    return false;
  }
  const html = costPageHtml(
    params.get('title') ?? 'Page',
    bounded(params, 'heapMB', MAX_HEAP_MB),
    bounded(params, 'domKB', MAX_DOM_KB),
  );
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
  return true;
}
