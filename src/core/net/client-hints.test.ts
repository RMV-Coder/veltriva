import { describe, expect, it, vi } from 'vitest';

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

describe('opt-ins: the stored document', () => {
  const GOOGLE = 'https://accounts.google.com';
  const stored = (origins: Record<string, unknown>, v: unknown = 1) => ({ v, origins });
  const loaded = (document: unknown): ClientHintOptIns =>
    new ClientHintOptIns({ stored: document });
  const origins = (optIns: ClientHintOptIns): string[] => Object.keys(optIns.toDocument().origins);

  it('loads what an origin asked for, for any URL of that origin', () => {
    const optIns = loaded(stored({ [GOOGLE]: ['sec-ch-ua-full-version-list', 'sec-ch-ua-arch'] }));

    expect(optIns.for(`${GOOGLE}/v3/signin?x=1`)).toEqual(
      new Set(['sec-ch-ua-full-version-list', 'sec-ch-ua-arch']),
    );
    expect(optIns.for('https://other.example/')).toEqual(new Set());
    expect(optIns.for('https://accounts.google.com:8443/')).toEqual(new Set());
  });

  it('loads several origins, in the order the document lists them', () => {
    const optIns = loaded(
      stored({
        'https://a.example': ['sec-ch-ua-arch'],
        'https://b.example': ['sec-ch-ua-model'],
        'https://c.example': ['sec-ch-ua-bitness', 'sec-ch-ua-wow64'],
      }),
    );

    expect(origins(optIns)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    expect(optIns.for('https://c.example/')).toEqual(
      new Set(['sec-ch-ua-bitness', 'sec-ch-ua-wow64']),
    );
  });

  it.each(OPT_IN_HINTS)('loads the hint %s', (hint) => {
    expect(loaded(stored({ [GOOGLE]: [hint] })).for(GOOGLE)).toEqual(new Set([hint]));
  });

  it('has nothing stored by default, with no document, or with an empty one', () => {
    for (const optIns of [
      new ClientHintOptIns(),
      new ClientHintOptIns({}),
      loaded(undefined),
      loaded(stored({})),
    ]) {
      expect(optIns.toDocument()).toEqual({ v: 1, origins: {} });
    }
  });

  describe('a document that is not one it can read', () => {
    it.each([
      ['a version 2 document', stored({ [GOOGLE]: ['sec-ch-ua-arch'] }, 2)],
      ['a version 0 document', stored({ [GOOGLE]: ['sec-ch-ua-arch'] }, 0)],
      ['a version that is text', stored({ [GOOGLE]: ['sec-ch-ua-arch'] }, '1')],
      ['a version that is true', stored({ [GOOGLE]: ['sec-ch-ua-arch'] }, true)],
      ['a document with no version', { origins: { [GOOGLE]: ['sec-ch-ua-arch'] } }],
      ['a document with no origins', { v: 1 }],
      ['null', null],
      ['a string', 'client hints'],
      ['a number', 1],
      ['an array', [stored({ [GOOGLE]: ['sec-ch-ua-arch'] })]],
      ['origins that are an array', stored([GOOGLE] as unknown as Record<string, unknown>)],
      ['origins that are null', { v: 1, origins: null }],
      ['origins that are text', { v: 1, origins: GOOGLE }],
    ])('loads nothing from %s', (_what, document) => {
      const optIns = loaded(document);

      expect(optIns.toDocument()).toEqual({ v: 1, origins: {} });
      expect(optIns.for(GOOGLE)).toEqual(new Set());
    });
  });

  describe('an origin it skips', () => {
    it.each([
      ['an insecure origin', 'http://example.com'],
      ['an insecure origin with a port', 'http://example.com:8080'],
      ['an origin with its default port written', 'https://example.com:443'],
      ['an origin with capitals in its host', 'https://Example.com'],
      ['an origin with a trailing slash', 'https://example.com/'],
      ['an address with a path', 'https://example.com/path'],
      ['an address with a query', 'https://example.com/?a=1'],
      ['an address with credentials', 'https://user:pw@example.com'],
      ['a host with no scheme', 'example.com'],
      ['an empty name', ''],
      ['about:blank', 'about:blank'],
      ['a data: address', 'data:text/html,x'],
      ['a file: address', 'file:///C:/x'],
      ['text that is not an address', 'not an origin'],
      ['a prototype key', '__proto__'],
    ])('skips %s', (_what, origin) => {
      const optIns = loaded(
        stored({ [origin]: ['sec-ch-ua-arch'], 'https://kept.example': ['sec-ch-ua-model'] }),
      );

      expect(origins(optIns)).toEqual(['https://kept.example']);
    });

    it('keeps http on this machine, as a page there is trustworthy', () => {
      const optIns = loaded(stored({ 'http://localhost:8080': ['sec-ch-ua-arch'] }));

      expect(optIns.for('http://localhost:8080/page')).toEqual(new Set(['sec-ch-ua-arch']));
    });

    it('skips an origin whose hints are not a list, or are all unknown, or none', () => {
      const optIns = loaded(
        stored({
          'https://text.example': 'sec-ch-ua-arch',
          'https://object.example': { 'sec-ch-ua-arch': true },
          'https://null.example': null,
          'https://empty.example': [],
          'https://unknown.example': ['sec-ch-ua-bogus', 'x-custom'],
          'https://default.example': ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'],
          'https://kept.example': ['sec-ch-ua-arch'],
        }),
      );

      expect(origins(optIns)).toEqual(['https://kept.example']);
    });
  });

  describe('a hint it skips', () => {
    it('skips an unknown name, and keeps the known ones beside it', () => {
      const optIns = loaded(stored({ [GOOGLE]: ['sec-ch-ua-bogus', 'sec-ch-ua-arch', 'x-other'] }));

      expect(optIns.for(GOOGLE)).toEqual(new Set(['sec-ch-ua-arch']));
    });

    it('skips a name in other letters, as the names are stored in lower case', () => {
      const optIns = loaded(
        stored({ [GOOGLE]: ['Sec-CH-UA-Arch', 'SEC-CH-UA-MODEL', 'sec-ch-ua-bitness'] }),
      );

      expect(optIns.for(GOOGLE)).toEqual(new Set(['sec-ch-ua-bitness']));
    });

    it('skips what is not text', () => {
      const optIns = loaded(
        stored({ [GOOGLE]: [5, null, { a: 1 }, ['sec-ch-ua-arch'], 'sec-ch-ua-model'] }),
      );

      expect(optIns.for(GOOGLE)).toEqual(new Set(['sec-ch-ua-model']));
    });

    it('takes a hint named twice once', () => {
      const optIns = loaded(stored({ [GOOGLE]: ['sec-ch-ua-arch', 'sec-ch-ua-arch'] }));

      expect(optIns.toDocument().origins[GOOGLE]).toEqual(['sec-ch-ua-arch']);
    });

    it('skips a default hint: those go to every request, and are not opt-ins', () => {
      const optIns = loaded(
        stored({ [GOOGLE]: ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-arch'] }),
      );

      expect(optIns.for(GOOGLE)).toEqual(new Set(['sec-ch-ua-arch']));
    });
  });

  describe('the limit on origins', () => {
    const many = (count: number): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, n) => [
          `https://site${String(n)}.example`,
          ['sec-ch-ua-arch'],
        ]),
      );

    it('loads at most MAX_OPT_IN_ORIGINS origins from a document that holds more: the newest', () => {
      const optIns = loaded(stored(many(MAX_OPT_IN_ORIGINS + 25)));

      expect(origins(optIns)).toHaveLength(MAX_OPT_IN_ORIGINS);
      // The document is oldest first: the first 25 are the ones left out.
      expect(optIns.for('https://site24.example/')).toEqual(new Set());
      expect(optIns.for('https://site25.example/')).toEqual(new Set(['sec-ch-ua-arch']));
      expect(optIns.for(`https://site${String(MAX_OPT_IN_ORIGINS + 24)}.example/`)).toEqual(
        new Set(['sec-ch-ua-arch']),
      );
    });

    it('keeps an origin in its place when it asks again for the same, with no write', () => {
      const changes: number[] = [];
      const optIns = new ClientHintOptIns({
        stored: stored(many(MAX_OPT_IN_ORIGINS)),
        onChange: () => changes.push(1),
      });

      // site0 is the oldest. Asking again for the same must not make it the newest...
      optIns.remember('https://site0.example/', 'Sec-CH-UA-Arch');
      expect(changes).toEqual([]);
      expect(optIns.toDocument().origins).toEqual(stored(many(MAX_OPT_IN_ORIGINS)).origins);

      // ...so it is still the one forgotten first.
      optIns.remember('https://newcomer.example/', 'Sec-CH-UA-Model');
      expect(optIns.for('https://site0.example/')).toEqual(new Set());
      expect(changes).toEqual([1]);
    });

    it('loads every origin of a document at the limit', () => {
      const optIns = loaded(stored(many(MAX_OPT_IN_ORIGINS)));

      expect(origins(optIns)).toHaveLength(MAX_OPT_IN_ORIGINS);
      expect(optIns.for(`https://site${String(MAX_OPT_IN_ORIGINS - 1)}.example/`)).toEqual(
        new Set(['sec-ch-ua-arch']),
      );
    });

    it('does not count what it skipped against the limit', () => {
      const document = stored({
        ...Object.fromEntries(
          Array.from({ length: 50 }, (_, n) => [
            `http://insecure${String(n)}.example`,
            ['sec-ch-ua-arch'],
          ]),
        ),
        ...many(MAX_OPT_IN_ORIGINS),
      });

      expect(origins(loaded(document))).toHaveLength(MAX_OPT_IN_ORIGINS);
    });

    it('forgets the oldest loaded origin first when a new one arrives at the limit', () => {
      const optIns = loaded(stored(many(MAX_OPT_IN_ORIGINS)));

      optIns.remember('https://newcomer.example/', 'Sec-CH-UA-Model');

      expect(origins(optIns)).toHaveLength(MAX_OPT_IN_ORIGINS);
      expect(optIns.for('https://site0.example/')).toEqual(new Set());
      expect(optIns.for('https://newcomer.example/')).toEqual(new Set(['sec-ch-ua-model']));
      expect(optIns.for('https://site1.example/')).toEqual(new Set(['sec-ch-ua-arch']));
    });
  });

  describe('toDocument', () => {
    it('is version 1, with each origin’s hints', () => {
      const optIns = new ClientHintOptIns();
      optIns.remember('https://example.com/p', 'Sec-CH-UA-Arch, Sec-CH-UA-Model');

      expect(optIns.toDocument()).toEqual({
        v: 1,
        origins: { 'https://example.com': ['sec-ch-ua-arch', 'sec-ch-ua-model'] },
      });
    });

    it('lists the origins oldest first, and an origin that asked again as the newest', () => {
      const optIns = new ClientHintOptIns();
      optIns.remember('https://a.example/', 'Sec-CH-UA-Arch');
      optIns.remember('https://b.example/', 'Sec-CH-UA-Arch');
      optIns.remember('https://c.example/', 'Sec-CH-UA-Arch');

      optIns.remember('https://a.example/', 'Sec-CH-UA-Model');

      expect(origins(optIns)).toEqual([
        'https://b.example',
        'https://c.example',
        'https://a.example',
      ]);
    });

    it('survives being written as JSON and read again, as the app_state document is', () => {
      const optIns = new ClientHintOptIns();
      optIns.remember('https://a.example/', 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness');
      optIns.remember('http://localhost:3000/', 'Sec-CH-UA-Full-Version-List');

      const stored = JSON.parse(JSON.stringify(optIns.toDocument())) as unknown;
      const again = new ClientHintOptIns({ stored });

      expect(again.toDocument()).toEqual(optIns.toDocument());
      expect(again.for('https://a.example/x')).toEqual(optIns.for('https://a.example/x'));
      expect(again.for('http://localhost:3000/')).toEqual(optIns.for('http://localhost:3000/'));
    });

    it('is a copy: changing it changes nothing in the opt-ins', () => {
      const optIns = new ClientHintOptIns();
      optIns.remember('https://a.example/', 'Sec-CH-UA-Arch');

      const document = optIns.toDocument();
      document.origins['https://a.example']?.push('sec-ch-ua-model');
      delete document.origins['https://a.example'];

      expect(optIns.for('https://a.example/')).toEqual(new Set(['sec-ch-ua-arch']));
      expect(optIns.toDocument().origins['https://a.example']).toEqual(['sec-ch-ua-arch']);
    });

    it('is exactly what was loaded, once the skipped entries are gone', () => {
      const optIns = loaded(
        stored({
          'https://a.example': ['sec-ch-ua-arch', 'bogus'],
          'http://insecure.example': ['sec-ch-ua-arch'],
          'https://b.example': ['sec-ch-ua-model'],
        }),
      );

      expect(optIns.toDocument()).toEqual({
        v: 1,
        origins: {
          'https://a.example': ['sec-ch-ua-arch'],
          'https://b.example': ['sec-ch-ua-model'],
        },
      });
    });
  });
});

describe('opt-ins: onChange', () => {
  const setup = (stored?: unknown) => {
    const onChange = vi.fn();
    return { onChange, optIns: new ClientHintOptIns({ onChange, stored }) };
  };

  it('is called when an origin asks for hints it did not have', () => {
    const { optIns, onChange } = setup();

    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is called when an origin asks for a different set', () => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
    onChange.mockClear();

    optIns.remember('https://example.com/', 'Sec-CH-UA-Model');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['one more hint', 'Sec-CH-UA-Arch, Sec-CH-UA-Model, Sec-CH-UA-Bitness'],
    ['one hint fewer', 'Sec-CH-UA-Arch'],
    ['one hint swapped for another', 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness'],
  ])('is called for %s', (_what, value) => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch, Sec-CH-UA-Model');
    onChange.mockClear();

    optIns.remember('https://example.com/', value);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is not called when an origin asks for the same set again', () => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch, Sec-CH-UA-Model');
    onChange.mockClear();

    optIns.remember('https://example.com/other', 'Sec-CH-UA-Arch, Sec-CH-UA-Model');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not called for the same set in another order, in other letters, or with unknown names added', () => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch, Sec-CH-UA-Model');
    onChange.mockClear();

    optIns.remember('https://example.com/', 'sec-ch-ua-model,sec-ch-ua-arch');
    optIns.remember('https://example.com/', 'SEC-CH-UA-ARCH, SEC-CH-UA-MODEL, Sec-CH-UA-Bogus');
    optIns.remember('https://example.com/', ' Sec-CH-UA-Model ,Sec-CH-UA-Arch, Sec-CH-UA-Arch');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not called for the same set that was loaded from the stored document', () => {
    const { optIns, onChange } = setup({
      v: 1,
      origins: { 'https://example.com': ['sec-ch-ua-arch'] },
    });

    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is called when a loaded origin asks for something else', () => {
    const { optIns, onChange } = setup({
      v: 1,
      origins: { 'https://example.com': ['sec-ch-ua-arch'] },
    });

    optIns.remember('https://example.com/', 'Sec-CH-UA-Model');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is called when an origin that had hints asks for none: that clears them', () => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
    onChange.mockClear();

    optIns.remember('https://example.com/', '');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(optIns.for('https://example.com/')).toEqual(new Set());
  });

  it('is called when an origin that had hints asks only for names it does not know', () => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
    onChange.mockClear();

    optIns.remember('https://example.com/', 'Sec-CH-UA-Bogus, X-Other');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(optIns.for('https://example.com/')).toEqual(new Set());
  });

  it('is not called when an origin that had none asks for none', () => {
    const { optIns, onChange } = setup();

    optIns.remember('https://unknown.example/', '');
    optIns.remember('https://unknown.example/', 'Sec-CH-UA-Bogus');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not called twice for clearing what is already clear', () => {
    const { optIns, onChange } = setup();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
    optIns.remember('https://example.com/', '');
    onChange.mockClear();

    optIns.remember('https://example.com/', '');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not called for an insecure origin, or an address that is not an origin', () => {
    const { optIns, onChange } = setup();

    optIns.remember('http://example.com/', 'Sec-CH-UA-Arch');
    optIns.remember('data:text/html,x', 'Sec-CH-UA-Arch');
    optIns.remember('nonsense', 'Sec-CH-UA-Arch');
    optIns.remember('about:blank', '');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is not called by loading the stored document', () => {
    const { onChange } = setup({
      v: 1,
      origins: {
        'https://a.example': ['sec-ch-ua-arch'],
        'https://b.example': ['sec-ch-ua-model'],
      },
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is called once for each origin that changes, and tells nothing about which', () => {
    const { optIns, onChange } = setup();

    optIns.remember('https://a.example/', 'Sec-CH-UA-Arch');
    optIns.remember('https://b.example/', 'Sec-CH-UA-Arch');
    optIns.remember('https://a.example/', 'Sec-CH-UA-Arch');

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls).toEqual([[], []]);
  });

  it('is called after the change holds, so the document it is asked for has it', () => {
    const documents: unknown[] = [];
    const optIns: ClientHintOptIns = new ClientHintOptIns({
      onChange: () => documents.push(optIns.toDocument()),
    });

    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
    optIns.remember('https://example.com/', '');

    expect(documents).toEqual([
      { v: 1, origins: { 'https://example.com': ['sec-ch-ua-arch'] } },
      { v: 1, origins: {} },
    ]);
  });

  it('is called for a new origin at the limit, which pushes the oldest one out', () => {
    const { optIns, onChange } = setup();
    for (let index = 0; index < MAX_OPT_IN_ORIGINS; index += 1) {
      optIns.remember(`https://site${String(index)}.example/`, 'Sec-CH-UA-Arch');
    }
    onChange.mockClear();

    optIns.remember('https://newcomer.example/', 'Sec-CH-UA-Arch');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(optIns.for('https://site0.example/')).toEqual(new Set());
  });

  it('is optional', () => {
    const optIns = new ClientHintOptIns();

    expect(() => {
      optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');
      optIns.remember('https://example.com/', '');
    }).not.toThrow();
  });
});
