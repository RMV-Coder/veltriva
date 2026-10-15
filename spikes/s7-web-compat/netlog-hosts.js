'use strict';
// Parses a Chromium NetLog JSON file and lists the hosts it mentions, minus the local test hosts.
// Usable as a module (summarizeNetLog) or from Node:  node s7-web-compat/netlog-hosts.js <netlog.json>

const fs = require('node:fs');

const LOCAL = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host) || /\.test$/.test(host);

/** "host:port", "[v6]:port", "http://host:port/path" or plain "host" -> bare host (lower case). */
function hostOf(value) {
  if (typeof value !== 'string' || !value) return null;
  let v = value.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(v);
  if (url) v = url[1];
  else if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[^:]+:\d+$/.test(v)) return null; // data:, blob:, about: ...
  v = v.replace(/^[^@]*@/, '');
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (v6) return v6[1].toLowerCase();
  return v.replace(/:\d+$/, '').toLowerCase() || null;
}

const FIELDS = ['url', 'original_url', 'host', 'hostname', 'origin', 'address', 'proxy_server', 'new_url', 'location'];

function summarizeNetLog(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const typeNames = Object.fromEntries(Object.entries(log.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]));
  const hosts = new Map();
  let eventCount = 0;
  for (const event of log.events ?? []) {
    eventCount += 1;
    const params = event.params;
    if (!params || typeof params !== 'object') continue;
    for (const field of FIELDS) {
      const host = hostOf(params[field]);
      if (!host) continue;
      const entry = hosts.get(host) ?? { host, events: new Set(), sampleUrl: null, count: 0 };
      entry.count += 1;
      entry.events.add(typeNames[event.type] ?? String(event.type));
      if (!entry.sampleUrl && field === 'url' && /^https?:/i.test(params.url)) entry.sampleUrl = params.url.slice(0, 160);
      hosts.set(host, entry);
    }
  }
  const all = [...hosts.values()].map((e) => ({ host: e.host, count: e.count, events: [...e.events].sort().slice(0, 6), sampleUrl: e.sampleUrl }));
  return {
    file: file.split(/[\\/]/).pop(),
    eventCount,
    localHosts: all.filter((e) => LOCAL(e.host)).map((e) => e.host),
    externalHosts: all.filter((e) => !LOCAL(e.host)).sort((a, b) => b.count - a.count),
  };
}

module.exports = { summarizeNetLog, hostOf };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node s7-web-compat/netlog-hosts.js <netlog.json>');
    process.exit(2);
  }
  console.log(JSON.stringify(summarizeNetLog(file), null, 2));
}
