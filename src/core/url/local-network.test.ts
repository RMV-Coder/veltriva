import { describe, expect, it } from 'vitest';

import { classifyHost, isFaviconUrlAllowed } from './local-network';
import type { HostClass } from './local-network';

describe('classifyHost', () => {
  it.each<[string, HostClass]>([
    // Loopback, in every spelling the URL parser accepts.
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['127.1', 'loopback'],
    ['0x7f.0.0.1', 'loopback'],
    ['2130706433', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['localhost', 'loopback'],
    ['LOCALHOST', 'loopback'],
    ['localhost.', 'loopback'],
    ['app.localhost', 'loopback'],
    ['[::1]', 'loopback'],
    ['::1', 'loopback'],
    ['[0:0:0:0:0:0:0:1]', 'loopback'],
    ['[::]', 'loopback'],
    // IPv4-mapped, -compatible and NAT64 IPv6: the IPv4 address decides.
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['[::FFFF:7f00:1]', 'loopback'],
    ['[::ffff:192.168.1.1]', 'private'],
    ['[::ffff:c0a8:101]', 'private'],
    ['[::ffff:a9fe:1]', 'link-local'],
    ['[::ffff:8.8.8.8]', 'public'],
    ['[::127.0.0.1]', 'loopback'],
    ['[64:ff9b::10.0.0.1]', 'private'],
    ['[64:ff9b::8.8.8.8]', 'public'],
    // Private networks.
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['100.64.0.1', 'private'],
    ['[fc00::1]', 'private'],
    ['[fd12:3456::1]', 'private'],
    ['[fec0::1]', 'private'],
    // Link-local.
    ['169.254.169.254', 'link-local'],
    ['[fe80::1]', 'link-local'],
    ['[febf::1]', 'link-local'],
    // Names only a local resolver knows.
    ['intranet', 'local-name'],
    ['router', 'local-name'],
    ['printer.local', 'local-name'],
    ['nas.LOCAL', 'local-name'],
    ['build.corp.internal', 'local-name'],
    ['tv.home.arpa', 'local-name'],
    ['box.lan', 'local-name'],
    // Public.
    ['example.com', 'public'],
    ['example.com.', 'public'],
    ['8.8.8.8', 'public'],
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['169.253.0.1', 'public'],
    ['[2001:db8::1]', 'public'],
    ['[fe7f::1]', 'public'],
    ['localhost.example.com', 'public'],
    ['local.example.com', 'public'],
    ['xn--bcher-kva.de', 'public'],
    // Not a host at all: never public.
    ['', 'local-name'],
    ['[::1', 'local-name'],
    ['exa mple.com', 'local-name'],
  ])('%s is %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe('isFaviconUrlAllowed', () => {
  const publicPage = 'https://example.com/article';

  it.each([
    // Public favicons and inline ones are always fine.
    ['https://cdn.example.net/favicon.ico', publicPage, true],
    ['http://example.org/icon.png', publicPage, true],
    ['data:image/png;base64,iVBORw0KGgo=', publicPage, true],
    // A public page can't use a favicon to reach this machine or the local network.
    ['http://127.0.0.1:8080/favicon.ico', publicPage, false],
    ['http://localhost/favicon.ico', publicPage, false],
    ['http://[::1]/favicon.ico', publicPage, false],
    ['http://[::ffff:127.0.0.1]/favicon.ico', publicPage, false],
    ['http://[::ffff:c0a8:101]/favicon.ico', publicPage, false],
    ['http://192.168.1.1/favicon.ico', publicPage, false],
    ['http://10.0.0.1/favicon.ico', publicPage, false],
    ['http://169.254.169.254/latest/meta-data', publicPage, false],
    ['http://[fe80::1]/favicon.ico', publicPage, false],
    ['http://[fd00::1]/favicon.ico', publicPage, false],
    ['http://router/favicon.ico', publicPage, false],
    ['http://printer.local/favicon.ico', publicPage, false],
    ['http://0x7f.1/favicon.ico', publicPage, false],
    ['http://2130706433/favicon.ico', publicPage, false],
    // A page in the same class may use its own kind of host.
    ['http://localhost:3000/favicon.ico', 'http://127.0.0.1:3000/', true],
    ['http://127.0.0.1/favicon.ico', 'http://localhost:5173/app', true],
    ['http://192.168.1.1/favicon.ico', 'http://192.168.1.1/admin', true],
    ['http://10.0.0.5/favicon.ico', 'http://192.168.0.10/', true],
    ['http://printer.local/icon.png', 'http://router/', true],
    ['http://[fe80::1]/favicon.ico', 'http://169.254.10.10/', true],
    ['http://localhost/favicon.ico', 'blob:http://127.0.0.1:3000/0b8a7c5e', true],
    // ...but not another class.
    ['http://127.0.0.1/favicon.ico', 'http://192.168.1.1/', false],
    ['http://192.168.1.1/favicon.ico', 'http://localhost/', false],
    ['http://router/favicon.ico', 'http://10.0.0.1/', false],
    // Pages that are not on an http(s) host get no exception.
    ['http://localhost/favicon.ico', 'file:///C:/page.html', false],
    ['http://localhost/favicon.ico', 'about:blank', false],
    ['http://localhost/favicon.ico', 'not a url', false],
    // Only http(s) and data: are ever fetched.
    ['file:///C:/icon.png', publicPage, false],
    ['ftp://example.com/favicon.ico', publicPage, false],
    ['javascript:alert(1)', publicPage, false],
    ['not a url', publicPage, false],
  ])('%s on %s: %s', (favicon, page, expected) => {
    expect(isFaviconUrlAllowed(favicon, page)).toBe(expected);
  });
});
