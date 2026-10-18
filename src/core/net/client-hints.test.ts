import { describe, expect, it } from 'vitest';

import {
  ClientHintOptIns,
  DEFAULT_HINTS,
  MAX_OPT_IN_ORIGINS,
  OPT_IN_HINTS,
  hintValue,
  hintsToAdd,
  parseAcceptCh,
  sendsClientHints,
} from './client-hints';
import type { OptInHint, UserAgentData } from './client-hints';

/** `navigator.userAgentData` on Electron 44.9.0, Windows x64 (measured). */
const DATA: UserAgentData = {
  brands: [
    { brand: 'Not?A_Brand', version: '24' },
    { brand: 'Chromium', version: '152' },
  ],
  mobile: false,
  platform: 'Windows',
  architecture: 'x86',
  bitness: '64',
  formFactors: ['Desktop'],
  fullVersionList: [
    { brand: 'Not?A_Brand', version: '24.0.0.0' },
    { brand: 'Chromium', version: '152.0.7977.167' },
  ],
  uaFullVersion: '152.0.7977.167',
  model: '',
  platformVersion: '19.0.0',
  wow64: false,
};

/** What Chromium itself sent on a subresource request from the same app (measured). */
const CHROMIUM_DEFAULT_HEADERS = {
  'sec-ch-ua': '"Not?A_Brand";v="24", "Chromium";v="152"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

const NO_OPT_INS: ReadonlySet<OptInHint> = new Set();

describe('client hint values', () => {
  it('writes the default hints exactly as Chromium does', () => {
    for (const hint of DEFAULT_HINTS) {
      expect(hintValue(hint, DATA)).toBe(CHROMIUM_DEFAULT_HEADERS[hint]);
    }
  });

  it('writes every opt-in hint as a structured-field value', () => {
    expect(Object.fromEntries(OPT_IN_HINTS.map((hint) => [hint, hintValue(hint, DATA)]))).toEqual({
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-form-factors': '"Desktop"',
      'sec-ch-ua-full-version': '"152.0.7977.167"',
      'sec-ch-ua-full-version-list': '"Not?A_Brand";v="24.0.0.0", "Chromium";v="152.0.7977.167"',
      'sec-ch-ua-model': '""',
      'sec-ch-ua-platform-version': '"19.0.0"',
      'sec-ch-ua-wow64': '?0',
    });
  });

  it('says "Chromium", never "Google Chrome": the brands are the page’s own', () => {
    expect(hintValue('sec-ch-ua', DATA)).not.toContain('Google Chrome');
  });

  it('writes true booleans and several form factors', () => {
    const data = { ...DATA, mobile: true, wow64: true, formFactors: ['Desktop', 'Tablet'] };
    expect(hintValue('sec-ch-ua-mobile', data)).toBe('?1');
    expect(hintValue('sec-ch-ua-wow64', data)).toBe('?1');
    expect(hintValue('sec-ch-ua-form-factors', data)).toBe('"Desktop", "Tablet"');
  });

  it('escapes quotes and backslashes, and refuses what a header can’t carry', () => {
    expect(hintValue('sec-ch-ua-model', { ...DATA, model: 'a"b\\c' })).toBe('"a\\"b\\\\c"');
    expect(hintValue('sec-ch-ua-model', { ...DATA, model: 'line\nbreak' })).toBeNull();
    expect(hintValue('sec-ch-ua-platform', { ...DATA, platform: 'Wíndows' })).toBeNull();
    expect(
      hintValue('sec-ch-ua', {
        ...DATA,
        brands: [{ brand: 'Bad\u0000', version: '1' }],
      }),
    ).toBeNull();
    expect(hintValue('sec-ch-ua-form-factors', { ...DATA, formFactors: ['ok', '\t'] })).toBeNull();
  });

  it('writes an empty brand list as an empty value', () => {
    expect(hintValue('sec-ch-ua', { ...DATA, brands: [] })).toBe('');
  });
});

describe('which URLs get client hints', () => {
  it.each([
    'https://accounts.google.com/v3/signin',
    'https://example.com:8443/',
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://127.0.0.1:5173/page',
    'http://[::1]/',
  ])('%s does', (url) => {
    expect(sendsClientHints(url)).toBe(true);
  });

  it.each([
    'http://example.com/',
    'http://192.168.1.10/',
    'ws://example.com/',
    'file:///C:/page.html',
    'data:text/html,hi',
    'about:blank',
    'veltriva://newtab/',
    'not a url',
    '',
  ])('%s does not', (url) => {
    expect(sendsClientHints(url)).toBe(false);
  });
});

describe('Accept-CH', () => {
  it('reads the opt-in hints, in any case and spacing', () => {
    expect(
      parseAcceptCh('Sec-CH-UA-Full-Version-List,  sec-ch-ua-platform-version ,SEC-CH-UA-ARCH'),
    ).toEqual(
      new Set(['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch']),
    );
  });

  it('ignores the default hints, unknown names and empty parts', () => {
    expect(
      parseAcceptCh('Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform, DPR, Viewport-Width, , ,'),
    ).toEqual(new Set());
    expect(parseAcceptCh('')).toEqual(new Set());
  });

  it('knows every opt-in hint', () => {
    expect(parseAcceptCh(OPT_IN_HINTS.join(', '))).toEqual(new Set(OPT_IN_HINTS));
  });
});

describe('opt-ins per origin', () => {
  it('remembers what an origin asked for, for any URL of that origin', () => {
    const optIns = new ClientHintOptIns();
    optIns.remember('https://accounts.google.com/v3/signin', 'Sec-CH-UA-Full-Version-List');
    expect(optIns.for('https://accounts.google.com/other?x=1')).toEqual(
      new Set(['sec-ch-ua-full-version-list']),
    );
  });

  it('never extends an opt-in to another origin, scheme or port', () => {
    const optIns = new ClientHintOptIns();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
    expect(optIns.for('https://other.example.com/')).toEqual(new Set());
    expect(optIns.for('https://example.com:8443/')).toEqual(new Set());
    expect(optIns.for('http://example.com/')).toEqual(new Set());
    expect(optIns.for('about:blank')).toEqual(new Set());
  });

  it('replaces an origin’s opt-in with its latest Accept-CH, and an empty one clears it', () => {
    const optIns = new ClientHintOptIns();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness');
    optIns.remember('https://example.com/next', 'Sec-CH-UA-Model');
    expect(optIns.for('https://example.com/')).toEqual(new Set(['sec-ch-ua-model']));
    optIns.remember('https://example.com/', '');
    expect(optIns.for('https://example.com/')).toEqual(new Set());
  });

  it('ignores an insecure origin’s Accept-CH, and URLs with no origin', () => {
    const optIns = new ClientHintOptIns();
    optIns.remember('http://example.com/', 'Sec-CH-UA-Arch');
    optIns.remember('data:text/html,x', 'Sec-CH-UA-Arch');
    optIns.remember('nonsense', 'Sec-CH-UA-Arch');
    expect(optIns.for('http://example.com/')).toEqual(new Set());
    optIns.remember('http://localhost:8080/', 'Sec-CH-UA-Arch');
    expect(optIns.for('http://localhost:8080/x')).toEqual(new Set(['sec-ch-ua-arch']));
  });

  it(`remembers at most ${String(MAX_OPT_IN_ORIGINS)} origins, forgetting the oldest first`, () => {
    const optIns = new ClientHintOptIns();
    for (let index = 0; index <= MAX_OPT_IN_ORIGINS; index += 1) {
      optIns.remember(`https://site${String(index)}.example/`, 'Sec-CH-UA-Arch');
    }
    expect(optIns.for('https://site0.example/')).toEqual(new Set());
    expect(optIns.for('https://site1.example/')).toEqual(new Set(['sec-ch-ua-arch']));
    expect(optIns.for(`https://site${String(MAX_OPT_IN_ORIGINS)}.example/`)).toEqual(
      new Set(['sec-ch-ua-arch']),
    );
  });

  it('counts a refreshed origin as new, so it is not the next one forgotten', () => {
    const optIns = new ClientHintOptIns();
    for (let index = 0; index < MAX_OPT_IN_ORIGINS; index += 1) {
      optIns.remember(`https://site${String(index)}.example/`, 'Sec-CH-UA-Arch');
    }
    optIns.remember('https://site0.example/', 'Sec-CH-UA-Model');
    optIns.remember('https://newcomer.example/', 'Sec-CH-UA-Arch');
    expect(optIns.for('https://site0.example/')).toEqual(new Set(['sec-ch-ua-model']));
    expect(optIns.for('https://site1.example/')).toEqual(new Set());
  });
});

describe('the headers a request gets', () => {
  const navigation = (url: string, headers: Record<string, string> = {}) => ({
    url,
    isDocument: true,
    headers,
  });

  it('gives a page’s navigation the default hints Chromium leaves out', () => {
    expect(hintsToAdd(navigation('https://accounts.google.com/'), DATA, NO_OPT_INS)).toEqual(
      CHROMIUM_DEFAULT_HEADERS,
    );
  });

  it('adds nothing to a subresource that asked for nothing: Chromium sends those itself', () => {
    expect(
      hintsToAdd(
        { url: 'https://example.com/app.js', isDocument: false, headers: {} },
        DATA,
        NO_OPT_INS,
      ),
    ).toEqual({});
  });

  it('never replaces a header that is already there, whatever its case', () => {
    expect(
      hintsToAdd(
        navigation('https://example.com/', {
          'Sec-CH-UA': '"Custom";v="1"',
          'sec-ch-ua-mobile': '?1',
        }),
        DATA,
        NO_OPT_INS,
      ),
    ).toEqual({ 'sec-ch-ua-platform': '"Windows"' });
  });

  it('adds the opt-in hints to any request of an origin that asked, beside the defaults', () => {
    const optIns = new Set<OptInHint>(['sec-ch-ua-full-version-list', 'sec-ch-ua-arch']);
    expect(hintsToAdd(navigation('https://example.com/'), DATA, optIns)).toEqual({
      ...CHROMIUM_DEFAULT_HEADERS,
      'sec-ch-ua-full-version-list': '"Not?A_Brand";v="24.0.0.0", "Chromium";v="152.0.7977.167"',
      'sec-ch-ua-arch': '"x86"',
    });
    expect(
      hintsToAdd(
        { url: 'https://example.com/api', isDocument: false, headers: CHROMIUM_DEFAULT_HEADERS },
        DATA,
        optIns,
      ),
    ).toEqual({
      'sec-ch-ua-full-version-list': '"Not?A_Brand";v="24.0.0.0", "Chromium";v="152.0.7977.167"',
      'sec-ch-ua-arch': '"x86"',
    });
  });

  it('sends nothing over insecure http, or to URLs with no origin', () => {
    const optIns = new Set<OptInHint>(['sec-ch-ua-arch']);
    expect(hintsToAdd(navigation('http://example.com/'), DATA, optIns)).toEqual({});
    expect(hintsToAdd(navigation('data:text/html,x'), DATA, optIns)).toEqual({});
  });

  it('sends nothing until Chromium’s values are known', () => {
    expect(hintsToAdd(navigation('https://example.com/'), null, NO_OPT_INS)).toEqual({});
  });

  it('skips a hint whose value can’t be encoded, and keeps the rest', () => {
    expect(
      hintsToAdd(
        navigation('https://example.com/'),
        { ...DATA, platform: 'Win\ndows' },
        NO_OPT_INS,
      ),
    ).toEqual({
      'sec-ch-ua': CHROMIUM_DEFAULT_HEADERS['sec-ch-ua'],
      'sec-ch-ua-mobile': '?0',
    });
  });
});
