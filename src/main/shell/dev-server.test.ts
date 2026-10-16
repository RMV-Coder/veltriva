import { describe, expect, it } from 'vitest';

import { parseDevServerUrl } from './dev-server';

describe('parseDevServerUrl', () => {
  it.each([
    ['http://localhost:5173', 'http://localhost:5173/', 'http://localhost:5173'],
    ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/', 'http://127.0.0.1:5173'],
    ['http://[::1]:5173', 'http://[::1]:5173/', 'http://[::1]:5173'],
  ])('accepts %s', (raw, url, origin) => {
    expect(parseDevServerUrl(raw)).toEqual({ url, origin });
  });

  it.each([
    'https://localhost:5173',
    'http://example.com:5173',
    'http://localhost.example.com:5173',
    'http://192.168.1.10:5173',
    'file:///C:/out/renderer/index.html',
    'app://shell/index.html',
  ])('refuses %s', (raw) => {
    expect(() => parseDevServerUrl(raw)).toThrow(/non-local dev server/);
  });

  it('refuses something that is not a URL', () => {
    expect(() => parseDevServerUrl('localhost:5173 ')).toThrow();
  });
});
