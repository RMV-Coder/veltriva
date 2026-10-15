'use strict';
// Deterministic local fixture server for the Phase 0 spikes.
// Binds to 127.0.0.1 only. Static files come from ./fixtures; a few routes are generated.
// Cross-site tests use hostnames such as a.test and b.test, which the Electron harness maps
// to 127.0.0.1 (see harness.configureCommandLine), so pages and iframes land on different sites.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** A 1-page PDF with correct xref offsets. */
function minimalPdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A short mono 16-bit sine tone. `amplitude` is 0..1; keep it low, spikes run on a real desk. */
function toneWav({ seconds = 2, freq = 440, rate = 22050, amplitude = 0.05 } = {}) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Long article with stable paragraph ids, for scroll-restoration tests. */
function articleHtml(title, paragraphs) {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<p id="p${i}">Paragraph ${i}. Veltriva spike filler text that wraps across the line so the page becomes tall enough to scroll in a meaningful way.</p>`,
  ).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>\n${body}`;
}

/**
 * Generic page with controllable cost, for memory measurements.
 * heapMB: JS heap ballast (a filled Float64Array-backed Array); domKB: approximate text payload.
 */
function costPageHtml(title, heapMB, domKB) {
  const filler = 'x'.repeat(1024);
  const blocks = Array.from({ length: domKB }, (_, i) => `<div class="b" id="b${i}">${filler}</div>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<h1>${escapeHtml(title)}</h1>
<script>
  window.__ballast = new Array(${Math.max(0, Math.floor(heapMB * 131072))}).fill(1.5);
</script>
<div style="font-size:2px;color:#ddd">${blocks}</div>`;
}

/**
 * Starts the server on an ephemeral port.
 * @returns {Promise<{port:number, url:(p?:string, host?:string)=>string, beacons:Array<object>, requests:Array<object>, close:()=>Promise<void>}>}
 */
function startFixtureServer() {
  const beacons = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ at: Date.now(), method: req.method, host: req.headers.host, path: url.pathname + url.search });

    const send = (status, type, body, extraHeaders = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extraHeaders });
      res.end(body);
    };

    switch (url.pathname) {
      case '/beacon': {
        // Pages report events here (navigator.sendBeacon or fetch); main reads fixture.beacons.
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          beacons.push({ at: Date.now(), host: req.headers.host, query: Object.fromEntries(url.searchParams), body });
          send(204, 'text/plain', '');
        });
        return;
      }
      case '/article':
        return send(200, CONTENT_TYPES['.html'], articleHtml(url.searchParams.get('title') ?? 'Article', Number(url.searchParams.get('n') ?? 200)));
      case '/page':
        return send(
          200,
          CONTENT_TYPES['.html'],
          costPageHtml(url.searchParams.get('title') ?? 'Page', Number(url.searchParams.get('heapMB') ?? 0), Number(url.searchParams.get('domKB') ?? 0)),
        );
      case '/slow': {
        const ms = Number(url.searchParams.get('ms') ?? 2000);
        setTimeout(() => send(200, CONTENT_TYPES['.html'], `<!doctype html><title>slow ${ms}ms</title><p>Loaded after ${ms} ms</p>`), ms);
        return;
      }
      case '/fixture.pdf':
        return send(200, 'application/pdf', minimalPdf('Veltriva spike PDF'));
      case '/tone.wav':
        return send(200, 'audio/wav', toneWav());
      case '/download/sample.txt':
        return send(200, 'text/plain; charset=utf-8', 'Veltriva spike download\n', { 'Content-Disposition': 'attachment; filename="sample.txt"' });
      case '/download/fake-installer.exe':
        // Not a real executable: the bytes only start with "MZ" so the file looks like one.
        return send(200, 'application/octet-stream', Buffer.from('MZ-veltriva-spike-not-a-real-binary'), {
          'Content-Disposition': 'attachment; filename="fake-installer.exe"',
        });
      default:
        break;
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(FIXTURES_DIR, relative);
    if (!file.startsWith(FIXTURES_DIR + path.sep)) return send(403, 'text/plain', 'forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'text/plain', 'not found');
      send(200, CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', data);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: (p = '/', host = '127.0.0.1') => `http://${host}:${port}${p}`,
        beacons,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startFixtureServer, minimalPdf, toneWav };
