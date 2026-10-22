'use strict';
// M3.2 measurement (not app code): what Electron's process.getSystemMemoryInfo() reports on this
// Windows laptop next to Windows' own counters, sampled every 2 s for DURATION_S seconds.
// Writes samples.json beside this file. No window, no network.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const DURATION_S = Number(process.env.MEMSAMPLE_SECONDS || 600);
const INTERVAL_S = 2;
const out = path.join(__dirname, 'samples.json');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => undefined);

app.whenReady().then(() => {
  const electronSamples = [];
  const counterLines = [];
  const counters = spawn(
    'typeperf',
    [
      '\\Memory\\Available MBytes',
      '\\Memory\\Committed Bytes',
      '\\Memory\\Commit Limit',
      '\\Memory\\Pages/sec',
      '-si',
      String(INTERVAL_S),
      '-sc',
      String(Math.ceil(DURATION_S / INTERVAL_S)),
    ],
    { windowsHide: true },
  );
  counters.stdout.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('"')) counterLines.push(line);
    }
  });
  const started = Date.now();
  const timer = setInterval(() => {
    const info = process.getSystemMemoryInfo();
    electronSamples.push({ t: Date.now() - started, ...info, osFreeKB: Math.round(os.freemem() / 1024) });
  }, INTERVAL_S * 1000);
  setTimeout(() => {
    clearInterval(timer);
    counters.kill();
    fs.writeFileSync(out, JSON.stringify({ electronSamples, counterLines }, null, 1));
    app.exit(0);
  }, DURATION_S * 1000 + 3000);
});
