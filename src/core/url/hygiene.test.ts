import { describe, expect, it } from 'vitest';

import { MAX_STORED_URL } from '../../shared/contracts/data-rpc';
import { historyUrl, isOAuthCallback, withoutSecrets } from './hygiene';

/** The tracking parameters hygiene.ts removes from a page's identity (the spec, spelled out). */
const TRACKING_NAMES = [
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'rb_clickid',
  's_cid',
  'ref_src',
];

/** The parameters that carry a credential, which the memory never shows. */
const SECRET_NAMES = [
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'auth_token',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'key',
  'session',
  'sessionid',
  'sid',
  'sig',
  'signature',
  'otp',
  'ticket',
  'jwt',
];

/**
 * The secret names a page can carry and still be recorded: an `access_token` or `id_token` in the
 * query makes the address an OAuth callback, which is refused outright (see below).
 */
const SECRET_NAMES_OF_RECORDED_PAGES = SECRET_NAMES.filter(
  (name) => name !== 'access_token' && name !== 'id_token',
);

const MAX = MAX_STORED_URL;

/** `historyUrl`, failing the test (rather than the types) when the address is refused. */
function recorded(raw: string): NonNullable<ReturnType<typeof historyUrl>> {
  const page = historyUrl(raw);
  if (page === null) {
    throw new Error(`expected ${raw} to be recorded`);
  }
  return page;
}

describe('historyUrl: what is recorded', () => {
  it('gives the key, the address shown, the host and the site of an ordinary page', () => {
    expect(historyUrl('https://www.example.com/a/b?x=1#top')).toEqual({
      urlKey: 'https://www.example.com/a/b?x=1',
      url: 'https://www.example.com/a/b?x=1#top',
      host: 'www.example.com',
      site: 'example.com',
    });
  });

  it('takes http as well as https, in any letter case of the scheme', () => {
    expect(recorded('http://example.com/').urlKey).toBe('http://example.com/');
    expect(recorded('HTTPS://Example.COM').urlKey).toBe('https://example.com/');
    expect(recorded('HtTp://example.com/x').url).toBe('http://example.com/x');
  });

  it.each([
    ['ftp', 'ftp://example.com/file'],
    ['ws', 'ws://example.com/socket'],
    ['wss', 'wss://example.com/socket'],
    ['file', 'file:///C:/Users/me/page.html'],
    ['data', 'data:text/html,<title>x</title>'],
    ['blob', 'blob:https://example.com/0b8a-77aa'],
    ['javascript', 'javascript:alert(1)'],
    ['chrome', 'chrome://settings'],
    ['about', 'about:blank'],
    ['view-source', 'view-source:https://example.com/'],
    ['veltriva', 'veltriva://newtab'],
    ['mailto', 'mailto:a@example.com'],
  ])('refuses a %s: address', (_scheme, raw) => {
    expect(historyUrl(raw)).toBeNull();
  });

  it.each([
    ['a username', 'https://user@example.com/'],
    ['a username and password', 'https://user:secret@example.com/'],
    ['a password with no username', 'https://:secret@example.com/'],
    ['credentials on http', 'http://user:secret@example.com:8080/x'],
  ])('refuses an address with %s in it', (_what, raw) => {
    expect(historyUrl(raw)).toBeNull();
  });

  it('does not take an empty userinfo for credentials', () => {
    expect(historyUrl('http://@example.com/')).toMatchObject({ urlKey: 'http://example.com/' });
  });

  it.each([
    ['nothing', ''],
    ['text that is not an address', 'not a url'],
    ['a scheme with no host', 'https://'],
    ['a relative path', '/just/a/path'],
    ['a host with no scheme', 'example.com/page'],
    ['whitespace', '   '],
  ])('refuses %s', (_what, raw) => {
    expect(historyUrl(raw)).toBeNull();
  });

  it('records an address of exactly the length limit, and refuses one a character longer', () => {
    const prefix = 'https://example.com/';
    const atLimit = prefix + 'a'.repeat(MAX - prefix.length);
    expect(atLimit).toHaveLength(MAX);

    expect(historyUrl(atLimit)).not.toBeNull();
    expect(historyUrl(`${atLimit}a`)).toBeNull();
  });

  it('refuses a huge address without parsing trouble', () => {
    expect(historyUrl(`https://example.com/${'a'.repeat(1_000_000)}`)).toBeNull();
  });

  // Regression: the length was checked on the raw address only, but the parser percent-encodes
  // non-ASCII characters (2 bytes become 6 characters), so 20,020 characters became 120,020 in
  // the `url` and `urlKey`, which the data contract refuses.
  it('never returns an address or key longer than the limit, whatever the raw length', () => {
    const page = historyUrl(`https://example.com/${'é'.repeat(20_000)}`);

    expect(page === null || (page.url.length <= MAX && page.urlKey.length <= MAX)).toBe(true);
  });
});

describe('historyUrl: OAuth callbacks are never recorded', () => {
  it.each([
    ['a code with a state', 'https://app.example/cb?code=abc&state=xyz'],
    ['a state with a code, in the other order', 'https://app.example/cb?state=xyz&code=abc'],
    ['a code and state among other parameters', 'https://app.example/cb?a=1&code=c&b=2&state=s'],
    ['an id_token in the query', 'https://app.example/cb?id_token=a.b.c'],
    ['an access_token in the query', 'https://app.example/cb?access_token=abc'],
    [
      'an access_token in the fragment',
      'https://app.example/cb#access_token=abc&token_type=bearer',
    ],
    ['an id_token in the fragment', 'https://app.example/cb#id_token=a.b.c&state=s'],
    ['a code and state in the fragment', 'https://app.example/cb#code=abc&state=xyz'],
    ['a code and state after a hash route', 'https://app.example/#/cb?code=abc&state=xyz'],
    ['an access_token after a hash route', 'https://app.example/#/cb?access_token=abc'],
    ['an id_token after a hash route', 'https://app.example/#/auth/callback?id_token=a.b.c'],
    ['parameters in any letter case of the value', 'https://app.example/cb?code=ABC&state=XYZ'],
    ['an empty code and state', 'https://app.example/cb?code=&state='],
  ])('refuses %s', (_what, raw) => {
    expect(historyUrl(raw)).toBeNull();
  });

  it.each([
    ['a code with no state', 'https://shop.example/p?code=SAVE10'],
    ['a state with no code', 'https://shop.example/p?state=open'],
    ['a code in the fragment with no state', 'https://app.example/#code=abc'],
    ['a code in the query and a state only in the fragment', 'https://app.example/?code=a#state=b'],
    ['a refresh_token in the query', 'https://app.example/cb?refresh_token=abc'],
    ['a token (not an access_token) in the fragment', 'https://app.example/cb#token=abc'],
    ['a plain hash route', 'https://app.example/#/inbox?folder=sent'],
    ['a similar name', 'https://app.example/cb?encode=1&statement=2&access_token_x=3'],
  ])('records %s, since it is not a callback', (_what, raw) => {
    expect(historyUrl(raw)).not.toBeNull();
  });

  it('is decided on the parameter names, whatever their order or the fragment that follows', () => {
    expect(historyUrl('https://app.example/cb?code=abc&state=xyz#frag')).toBeNull();
    expect(historyUrl('https://app.example/cb?utm_source=x&code=abc&state=xyz')).toBeNull();
  });
});

describe('isOAuthCallback', () => {
  const callback = (raw: string): boolean => isOAuthCallback(new URL(raw));

  it('is true for each way a callback carries its credential', () => {
    expect(callback('https://a.example/?code=1&state=2')).toBe(true);
    expect(callback('https://a.example/?id_token=1')).toBe(true);
    expect(callback('https://a.example/?access_token=1')).toBe(true);
    expect(callback('https://a.example/#access_token=1')).toBe(true);
    expect(callback('https://a.example/#id_token=1')).toBe(true);
    expect(callback('https://a.example/#code=1&state=2')).toBe(true);
    expect(callback('https://a.example/#/cb?code=1&state=2')).toBe(true);
    expect(callback('https://a.example/#/cb?access_token=1&x=2')).toBe(true);
  });

  it('is false for an address with none of them', () => {
    expect(callback('https://a.example/')).toBe(false);
    expect(callback('https://a.example/?code=1')).toBe(false);
    expect(callback('https://a.example/?state=1')).toBe(false);
    expect(callback('https://a.example/#code=1')).toBe(false);
    expect(callback('https://a.example/#state=1')).toBe(false);
    expect(callback('https://a.example/#section-2')).toBe(false);
    expect(callback('https://a.example/#')).toBe(false);
    expect(callback('https://a.example/?')).toBe(false);
  });

  it('reads only what follows the question mark of a hash route', () => {
    // `code=1` here is part of the route's name, not a parameter of it.
    expect(callback('https://a.example/#/code=1/state=2')).toBe(false);
    expect(callback('https://a.example/#/route?code=1&state=2')).toBe(true);
  });

  it('is false for a fragment with an access_token only as a value', () => {
    expect(callback('https://a.example/#section=access_token')).toBe(false);
    expect(callback('https://a.example/?q=access_token')).toBe(false);
  });
});

describe('historyUrl: the key', () => {
  it('lowercases the scheme and host but not the path or query', () => {
    expect(recorded('HTTPS://WWW.Example.COM/Path/To?Q=Mixed').urlKey).toBe(
      'https://www.example.com/Path/To?Q=Mixed',
    );
  });

  it('drops a default port, and keeps any other', () => {
    expect(recorded('http://example.com:80/a').urlKey).toBe('http://example.com/a');
    expect(recorded('https://example.com:443/a').urlKey).toBe('https://example.com/a');
    expect(recorded('https://example.com:8443/a').urlKey).toBe('https://example.com:8443/a');
    // 80 is not the default of https, nor 443 of http.
    expect(recorded('https://example.com:80/a').urlKey).toBe('https://example.com:80/a');
    expect(recorded('http://example.com:443/a').urlKey).toBe('http://example.com:443/a');
  });

  it('always has a path, as the parser makes one', () => {
    expect(recorded('https://example.com').urlKey).toBe('https://example.com/');
  });

  it('drops the fragment, so one page is one row however it was linked', () => {
    expect(recorded('https://example.com/a#one').urlKey).toBe('https://example.com/a');
    expect(recorded('https://example.com/a#').urlKey).toBe('https://example.com/a');
    expect(recorded('https://example.com/a?x=1#/route?y=2').urlKey).toBe(
      'https://example.com/a?x=1',
    );
    expect(recorded('https://example.com/a#one').urlKey).toBe(
      recorded('https://example.com/a#two').urlKey,
    );
  });

  it.each(TRACKING_NAMES)('drops the tracking parameter %s', (name) => {
    expect(recorded(`https://example.com/p?id=7&${name}=abc`).urlKey).toBe(
      'https://example.com/p?id=7',
    );
    expect(recorded(`https://example.com/p?${name}=abc&id=7`).urlKey).toBe(
      'https://example.com/p?id=7',
    );
  });

  it.each(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_anything'])(
    'drops %s, as every utm_ parameter',
    (name) => {
      expect(recorded(`https://example.com/p?id=7&${name}=x`).urlKey).toBe(
        'https://example.com/p?id=7',
      );
    },
  );

  it.each(['pk_campaign', 'pk_kwd', 'hsa_acc', 'hsa_cam', 'hsa_anything'])(
    'drops %s, as every pk_ and hsa_ parameter',
    (name) => {
      expect(recorded(`https://example.com/p?id=7&${name}=x`).urlKey).toBe(
        'https://example.com/p?id=7',
      );
    },
  );

  it.each([
    ['FBCLID', 'fbclid'],
    ['GCLID', 'gclid'],
    ['Utm_Source', 'utm_source'],
    ['UTM_MEDIUM', 'utm_medium'],
    ['PK_Campaign', 'pk_campaign'],
    ['_GA', '_ga'],
  ])('drops %s whatever its letter case', (written) => {
    expect(recorded(`https://example.com/p?id=7&${written}=x`).urlKey).toBe(
      'https://example.com/p?id=7',
    );
  });

  it('keeps parameters that only resemble tracking ones', () => {
    for (const name of [
      'utm',
      'xutm_source',
      'fb_clid',
      'gclid2',
      'pk',
      'hsa',
      'ref',
      'ga',
      'id',
    ]) {
      expect(recorded(`https://example.com/p?${name}=1`).urlKey, name).toBe(
        `https://example.com/p?${name}=1`,
      );
    }
  });

  it('drops every occurrence of a repeated tracking parameter, and keeps repeats of the others', () => {
    expect(recorded('https://example.com/p?a=1&utm_x=3&a=2&utm_x=4&a=5').urlKey).toBe(
      'https://example.com/p?a=1&a=2&a=5',
    );
    expect(recorded('https://example.com/p?fbclid=1&fbclid=2').urlKey).toBe(
      'https://example.com/p',
    );
  });

  it('keeps the other parameters in the order they came', () => {
    expect(recorded('https://example.com/p?z=1&utm_source=s&a=2&m=3&gclid=g&b=4').urlKey).toBe(
      'https://example.com/p?z=1&a=2&m=3&b=4',
    );
  });

  it('leaves no question mark behind when every parameter went', () => {
    expect(recorded('https://example.com/p?utm_source=a&fbclid=b').urlKey).toBe(
      'https://example.com/p',
    );
    expect(recorded('https://example.com/p?gclid=x#frag').urlKey).toBe('https://example.com/p');
  });

  it('leaves a question mark alone when there was nothing to remove', () => {
    expect(recorded('https://example.com/p?').urlKey).toBe('https://example.com/p?');
    expect(recorded('https://example.com/p').urlKey).toBe('https://example.com/p');
  });

  it('is the same key for a page however it was linked', () => {
    const plain = recorded('https://example.com/article?id=42').urlKey;

    for (const linked of [
      'https://example.com/article?id=42&utm_source=news&utm_medium=email',
      'https://example.com/article?fbclid=IwAR1&id=42',
      'https://EXAMPLE.com:443/article?id=42#comments',
      'https://example.com/article?id=42&_ga=2.1&msclkid=ab',
    ]) {
      expect(recorded(linked).urlKey, linked).toBe(plain);
    }
  });

  it('does not run a page into another: different paths, queries or hosts are different keys', () => {
    const keys = new Set(
      [
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/a?x=1',
        'https://example.com/a?x=2',
        'https://other.example/a',
        'http://example.com/a',
        'https://example.com:8443/a',
        'https://example.com/A',
      ].map((raw) => recorded(raw).urlKey),
    );

    expect(keys.size).toBe(8);
  });

  // A parameter's name is decoded as URLSearchParams decodes it: `+` is a space, `%xx` a byte.
  it.each([
    ['a + for the space', 'https://example.com/?utm+source=x&id=1'],
    ['%20 for the space', 'https://example.com/?utm%20source=x&id=1'],
  ])('reads a name written with %s as URLSearchParams does', (_what, raw) => {
    const name = new URL(raw).searchParams.keys().next().value;

    expect(name).toBe('utm source');
    // Not a tracking name (that has an underscore), so it stays, as written.
    expect(recorded(raw).urlKey).toBe(raw);
  });

  it('decodes an encoded name before matching it', () => {
    expect(recorded('https://example.com/?utm%5Fsource=x&id=1').urlKey).toBe(
      'https://example.com/?id=1',
    );
    expect(recorded('https://example.com/p?id=7&%74oken=hunter2').url).toBe(
      'https://example.com/p?id=7',
    );
  });

  it('compares a name with a stray % as written, without throwing', () => {
    expect(recorded('https://example.com/?a%zz=1&fbclid=2').urlKey).toBe(
      'https://example.com/?a%zz=1',
    );
  });

  // Regression: removing a parameter used to re-serialize the whole query in form-encoding (`,`
  // became `%2C`, `%20` became `+`), so one page got two keys depending on whether the link
  // carried a tracking parameter. The rest of the query now stays as it was written.
  it('keys a page the same with and without a tracking parameter when its query has a comma', () => {
    expect(recorded('https://example.com/search?q=hello,world&utm_source=x').urlKey).toBe(
      recorded('https://example.com/search?q=hello,world').urlKey,
    );
  });

  it('keys a page the same with and without a tracking parameter when its query has %20', () => {
    expect(recorded('https://example.com/?q=a%20b&fbclid=1').urlKey).toBe(
      recorded('https://example.com/?q=a%20b').urlKey,
    );
  });

  it('keeps the rest of the query byte for byte when a parameter goes', () => {
    expect(
      recorded('https://example.com/s?q=a%20b+c,d~e*f(g)&utm_source=x&r=%E2%9C%93').urlKey,
    ).toBe('https://example.com/s?q=a%20b+c,d~e*f(g)&r=%E2%9C%93');
    expect(recorded('https://example.com/s?a=1&&b=2&fbclid=z&&c=3').urlKey).toBe(
      'https://example.com/s?a=1&b=2&c=3',
    );
  });

  it('keeps a parameter with no value, or an empty name, that is not tracking', () => {
    expect(recorded('https://example.com/s?flag&utm_source=x&=v&k=').urlKey).toBe(
      'https://example.com/s?flag&=v&k=',
    );
  });

  it('knows a tracking parameter by its decoded name, as the parser reads it', () => {
    expect(recorded('https://example.com/s?id=1&%75tm_source=x').urlKey).toBe(
      'https://example.com/s?id=1',
    );
    expect(recorded('https://example.com/s?id=1&utm%5Fmedium=x').urlKey).toBe(
      'https://example.com/s?id=1',
    );
    expect(recorded('https://example.com/s?id=1&FB%43LID=x').urlKey).toBe(
      'https://example.com/s?id=1',
    );
  });

  it('compares a name with a stray percent sign as it was written', () => {
    expect(recorded('https://example.com/s?id=1&100%=x&fbclid=2').urlKey).toBe(
      'https://example.com/s?id=1&100%=x',
    );
  });

  it('takes the name before the first equals sign only', () => {
    expect(recorded('https://example.com/s?id=1&q=utm_source=2').urlKey).toBe(
      'https://example.com/s?id=1&q=utm_source=2',
    );
    expect(recorded('https://example.com/s?utm_source=a=b&id=1').urlKey).toBe(
      'https://example.com/s?id=1',
    );
  });

  it.each(SECRET_NAMES_OF_RECORDED_PAGES)('never contains the secret parameter %s', (name) => {
    const page = recorded(`https://example.com/p?id=7&${name}=hunter2`);

    expect(page.urlKey).not.toContain('hunter2');
    expect(page.urlKey).not.toContain(name);
    expect(page.urlKey).toBe('https://example.com/p?id=7');
  });

  it('never contains a secret in any letter case, or a signature prefix', () => {
    const page = recorded(
      'https://bucket.example/o?Token=a1&X-Amz-Signature=b2&x-goog-credential=c3&API_KEY=d4&id=7',
    );

    expect(page.urlKey).toBe('https://bucket.example/o?id=7');
  });
});

describe('historyUrl: the address shown and searched', () => {
  it.each(SECRET_NAMES_OF_RECORDED_PAGES)('removes the secret parameter %s', (name) => {
    const page = recorded(`https://example.com/p?id=7&${name}=hunter2`);

    expect(page.url).toBe('https://example.com/p?id=7');
  });

  // Parameter names are case-insensitive for secrets, though a callback's `access_token` is not:
  // the capitals are no way to get a credential into the memory.
  it.each(SECRET_NAMES)('removes %s in capital letters too', (name) => {
    expect(recorded(`https://example.com/p?id=7&${name.toUpperCase()}=hunter2`).url).toBe(
      'https://example.com/p?id=7',
    );
  });

  it.each([
    'X-Amz-Signature',
    'X-Amz-Credential',
    'x-amz-date',
    'X-Goog-Signature',
    'x-goog-algorithm',
  ])('removes the signed-URL parameter %s, by its x-amz- or x-goog- prefix', (name) => {
    expect(recorded(`https://bucket.example/o?id=7&${name}=v`).url).toBe(
      'https://bucket.example/o?id=7',
    );
  });

  it('removes every occurrence of a repeated secret', () => {
    expect(recorded('https://example.com/p?a=1&token=x&b=2&token=y').url).toBe(
      'https://example.com/p?a=1&b=2',
    );
  });

  it('keeps the rest of the query as it was written when a secret goes', () => {
    expect(recorded('https://example.com/p?token=t&q=a%20b,c&id=7').url).toBe(
      'https://example.com/p?q=a%20b,c&id=7',
    );
  });

  it('keeps the tracking parameters: they are only left out of the key', () => {
    expect(recorded('https://example.com/p?id=7&utm_source=news&fbclid=abc').url).toBe(
      'https://example.com/p?id=7&utm_source=news&fbclid=abc',
    );
  });

  it('keeps a code that has no state beside it, which is often a product code', () => {
    expect(recorded('https://shop.example/p?code=SAVE10&item=3').url).toBe(
      'https://shop.example/p?code=SAVE10&item=3',
    );
  });

  it('keeps the other parameters in their order, and leaves no question mark behind', () => {
    expect(recorded('https://example.com/p?z=1&token=t&a=2').url).toBe(
      'https://example.com/p?z=1&a=2',
    );
    expect(recorded('https://example.com/p?token=t&password=p#top').url).toBe(
      'https://example.com/p#top',
    );
  });

  it('keeps a fragment that carries nothing secret', () => {
    expect(recorded('https://example.com/docs#section-2').url).toBe(
      'https://example.com/docs#section-2',
    );
    expect(recorded('https://example.com/#/inbox?folder=sent').url).toBe(
      'https://example.com/#/inbox?folder=sent',
    );
  });

  it.each([
    ['a token', 'https://example.com/p#token=abc'],
    ['a code with no state', 'https://example.com/p#code=abc'],
    ['an api key', 'https://example.com/p#api_key=abc'],
    ['a session', 'https://example.com/p#session=abc&x=1'],
    ['a signature', 'https://example.com/p#signature=abc'],
    ['a key in an escaped fragment', 'https://example.com/p#%6Bey=abc'],
  ])('strips a fragment that carries %s', (_what, raw) => {
    expect(recorded(raw).url).toBe('https://example.com/p');
  });

  it('strips a token fragment but keeps the query', () => {
    expect(recorded('https://example.com/p?a=1#token=abc').url).toBe('https://example.com/p?a=1');
  });

  it('does not show credentials of any kind, in the query or the fragment', () => {
    const page = recorded('https://example.com/p?token=t1&sid=s2&q=ok&sig=s3#session=s4');

    expect(page.url).toBe('https://example.com/p?q=ok');
    for (const secret of ['t1', 's2', 's3', 's4']) {
      expect(page.url).not.toContain(secret);
      expect(page.urlKey).not.toContain(secret);
    }
  });

  it('is the address as the parser writes it: host lowercased, default port dropped', () => {
    expect(recorded('HTTPS://Example.COM:443/Path?Q=1').url).toBe('https://example.com/Path?Q=1');
  });
});

describe('historyUrl: host and site', () => {
  it.each([
    ['https://example.com/', 'example.com', 'example.com'],
    ['https://www.example.com/', 'www.example.com', 'example.com'],
    ['https://a.b.c.example.com/', 'a.b.c.example.com', 'example.com'],
    ['https://www.bbc.co.uk/news', 'www.bbc.co.uk', 'bbc.co.uk'],
    ['https://shop.example.com.au/', 'shop.example.com.au', 'example.com.au'],
    ['https://Example.COM:8443/', 'example.com', 'example.com'],
  ])('%s is host %s, site %s', (raw, host, site) => {
    expect(recorded(raw)).toMatchObject({ host, site });
  });

  it.each([
    ['https://user.github.io/repo', 'user.github.io'],
    ['https://a.b.github.io/', 'b.github.io'],
    ['https://project.pages.dev/', 'project.pages.dev'],
    ['https://app.herokuapp.com/', 'app.herokuapp.com'],
    ['https://www.user.github.io/', 'user.github.io'],
  ])('counts a private suffix as a suffix: %s is site %s', (raw, site) => {
    expect(recorded(raw).site).toBe(site);
  });

  it('keeps two github.io users as two sites', () => {
    expect(recorded('https://alice.github.io/').site).not.toBe(
      recorded('https://bob.github.io/').site,
    );
  });

  it.each([
    ['https://192.168.1.2/', '192.168.1.2'],
    ['http://10.0.0.1:8080/x', '10.0.0.1'],
    ['http://[::1]:8080/x', '[::1]'],
    ['http://[2001:db8::1]/', '[2001:db8::1]'],
    ['http://localhost:3000/x', 'localhost'],
    ['http://intranet/', 'intranet'],
  ])('gives the host itself as the site of %s', (raw, host) => {
    expect(recorded(raw)).toMatchObject({ host, site: host });
  });

  it('gives a punycode host, as the parser writes it', () => {
    expect(recorded('https://bücher.de/')).toMatchObject({
      host: 'xn--bcher-kva.de',
      site: 'xn--bcher-kva.de',
    });
  });

  it('never gives an empty host or site', () => {
    for (const raw of ['http://localhost/', 'https://a.example/', 'http://1.2.3.4/']) {
      const { host, site } = recorded(raw);
      expect(host).not.toBe('');
      expect(site).not.toBe('');
    }
  });
});

describe('withoutSecrets', () => {
  it('leaves an address with nothing secret as it is', () => {
    expect(withoutSecrets('https://example.com/files/report.pdf?v=2#page=3')).toBe(
      'https://example.com/files/report.pdf?v=2#page=3',
    );
  });

  it('removes credentials in the address', () => {
    expect(withoutSecrets('https://user:secret@example.com/a')).toBe('https://example.com/a');
    expect(withoutSecrets('http://user@example.com/a')).toBe('http://example.com/a');
  });

  it.each(SECRET_NAMES)('removes the secret parameter %s', (name) => {
    expect(withoutSecrets(`https://example.com/f?v=2&${name}=hunter2`)).toBe(
      'https://example.com/f?v=2',
    );
  });

  it('removes signed-URL parameters by prefix', () => {
    expect(
      withoutSecrets('https://bucket.s3.example/f.zip?X-Amz-Signature=a&x-goog-signature=b&v=1'),
    ).toBe('https://bucket.s3.example/f.zip?v=1');
  });

  it('removes a code only beside a state, and keeps the state', () => {
    expect(withoutSecrets('https://example.com/cb?code=abc&state=xyz')).toBe(
      'https://example.com/cb?state=xyz',
    );
    expect(withoutSecrets('https://example.com/cb?state=xyz&CODE=abc')).toBe(
      'https://example.com/cb?state=xyz',
    );
    expect(withoutSecrets('https://example.com/p?code=SAVE10')).toBe(
      'https://example.com/p?code=SAVE10',
    );
    expect(withoutSecrets('https://example.com/p?state=open')).toBe(
      'https://example.com/p?state=open',
    );
  });

  it('removes a fragment that carries a token, and keeps another', () => {
    expect(withoutSecrets('https://example.com/f#access_token=abc')).toBe('https://example.com/f');
    expect(withoutSecrets('https://example.com/f#code=abc&state=s')).toBe('https://example.com/f');
    expect(withoutSecrets('https://example.com/f#page=3')).toBe('https://example.com/f#page=3');
  });

  it('keeps tracking parameters, which are not secret', () => {
    expect(withoutSecrets('https://example.com/f?utm_source=x&fbclid=y')).toBe(
      'https://example.com/f?utm_source=x&fbclid=y',
    );
  });

  it('keeps a blob: address as it is', () => {
    expect(withoutSecrets('blob:https://example.com/0b8a-77aa')).toBe(
      'blob:https://example.com/0b8a-77aa',
    );
  });

  it.each([
    ['data:text/plain;base64,QUJD', 'data:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['javascript:alert(document.cookie)', 'javascript:'],
    ['file:///C:/Users/me/secret.txt', 'file:'],
    ['ftp://user:pw@example.com/f', 'ftp:'],
    ['mailto:a@example.com', 'mailto:'],
    ['about:blank', 'about:'],
  ])('gives only the scheme of %s', (raw, scheme) => {
    expect(withoutSecrets(raw)).toBe(scheme);
  });

  it('gives nothing for text that is not an address, and for one over the limit', () => {
    expect(withoutSecrets('')).toBe('');
    expect(withoutSecrets('not a url')).toBe('');
    expect(withoutSecrets('/relative/path')).toBe('');
    expect(withoutSecrets(`https://example.com/${'a'.repeat(MAX)}`)).toBe('');
  });

  it('keeps the rest of the query as it was written when a secret goes', () => {
    expect(withoutSecrets('https://example.com/f?token=t&q=a%20b+c,d&sig=s&v=%E2%9C%93')).toBe(
      'https://example.com/f?q=a%20b+c,d&v=%E2%9C%93',
    );
  });

  it('gives nothing when the address, once normalized, is over the limit', () => {
    expect(withoutSecrets(`https://example.com/${'é'.repeat(20_000)}`)).toBe('');
  });

  it('is happy with an address of exactly the length limit', () => {
    const prefix = 'https://example.com/';
    const atLimit = prefix + 'a'.repeat(MAX - prefix.length);

    expect(withoutSecrets(atLimit)).toBe(atLimit);
  });
});
