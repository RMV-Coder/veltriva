'use strict';
// S7 check 3b: does Mark-of-the-Web carry the real HostUrl/ReferrerUrl when the download comes over HTTPS?
// (check 3 showed HostUrl=about:internet for plain-HTTP downloads, even from a public-looking host name.)
// A throwaway self-signed certificate for dl.example.com is generated with openssl into the scenario's
// profile folder; the name is mapped to loopback and the tab session accepts only that one certificate
// error. Nothing leaves the machine.

const { app, session } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const h = require('../shared/harness');
const lib = require('./lib');

const HOST = 'dl.example.com';
const dir = lib.setup('downloads-https', { failSafeMs: 90_000, extraHostMaps: [HOST], noProxy: true });

function makeCertificate() {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function readMotw(file) {
  try {
    return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return { absent: true, code: err.code };
  }
}

app.whenReady().then(async () => {
  const rows = [];
  const tls = makeCertificate();
  const server = https.createServer(tls, (req, res) => {
    if (req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>https links</title><a id="txt" href="/download/sample.txt">sample.txt</a><a id="exe" href="/download/fake-installer.exe">exe</a>');
    } else if (req.url.startsWith('/download/')) {
      const name = req.url.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
      res.end(name.endsWith('.exe') ? 'MZ-veltriva-spike-not-a-real-binary' : 'Veltriva spike download\n');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const ses = session.fromPartition(h.TAB_PREFS.partition);
  // Accept the throwaway certificate for our one test host only.
  ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === HOST ? 0 : -3));

  fs.mkdirSync(lib.DOWNLOADS_DIR, { recursive: true });
  const saved = [];
  ses.on('will-download', (event, item) => {
    const file = path.join(lib.DOWNLOADS_DIR, `https-${item.getFilename()}`);
    item.setSavePath(file);
    item.once('done', (e, state) => saved.push({ file, state }));
  });

  const win = h.createWindow({ width: 800, height: 500, title: 'S7 downloads https' });
  const view = h.createTabView(win);
  const wc = view.webContents;
  await wc.loadURL(`https://${HOST}:${port}/index.html`);
  for (const id of ['txt', 'exe']) {
    const before = saved.length;
    await wc.executeJavaScript(`document.getElementById('${id}').click()`, true);
    await h.pollUntil(() => saved.length > before, { timeoutMs: 10000 });
    await h.sleep(300);
    const entry = saved.at(-1);
    h.record(rows, `https download link ${id}`, { file: path.basename(entry.file), state: entry.state, zoneIdentifier: readMotw(entry.file) }, null);
  }

  h.writeResults(__dirname, 'downloads-https', { rows });
  win.close();
  server.close();
  app.exit(0);
});
