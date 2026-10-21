// User-agent client hints (assessment §3.7, the Google sign-in row). Chromium sends `Sec-CH-UA*`
// headers that describe the browser, but in Electron it does so only for subresources: a page's
// own navigation, top-level or in a frame, goes out with none, and `Accept-CH` is ignored
// (measured on Electron 44.9.0; spike S7 saw the same on 44.7.2). Chrome sends the default hints
// on every navigation, so a "Chromium 152" that never does looks like an embedded browser, and
// Google's sign-in refuses it (manual check M1).
//
// Main fills that gap with Chromium's own values, read from `navigator.userAgentData`. The hints
// stay honest: the brands are what the page itself sees ("Chromium", never "Google Chrome").
//   - A document request (top-level or frame) gets each default hint it lacks: `Sec-CH-UA`,
//     `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`. Chromium adds them to subresources itself.
//   - An origin that asked for more with `Accept-CH` on its top-level page gets those hints on its
//     later requests, as in Chrome. The opt-in is kept on disk, as Chrome keeps it (the app_state
//     document `client_hints`, M2.2b), and is never delegated to other origins.
//   - Only to potentially trustworthy URLs (https, or http on loopback), as in Chrome.
//   - Never replaces a header Chromium set.
// Pure, so the rules and the exact header format are unit-tested.
import { isPromptableOrigin, originOf } from '../permissions/permission-policy';

export interface BrandVersion {
  readonly brand: string;
  readonly version: string;
}

/** `navigator.userAgentData` and its high-entropy values, as Chromium reports them. */
export interface UserAgentData {
  readonly brands: readonly BrandVersion[];
  readonly mobile: boolean;
  readonly platform: string;
  readonly architecture: string;
  readonly bitness: string;
  readonly formFactors: readonly string[];
  readonly fullVersionList: readonly BrandVersion[];
  readonly uaFullVersion: string;
  readonly model: string;
  readonly platformVersion: string;
  readonly wow64: boolean;
}

/** Sent on every document request. */
export const DEFAULT_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'] as const;

/** Sent only to an origin that asked for them with `Accept-CH`. */
export const OPT_IN_HINTS = [
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-form-factors',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-model',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-wow64',
] as const;

export type DefaultHint = (typeof DEFAULT_HINTS)[number];
export type OptInHint = (typeof OPT_IN_HINTS)[number];
export type ClientHint = DefaultHint | OptInHint;

const OPT_IN_SET: ReadonlySet<string> = new Set(OPT_IN_HINTS);

/** Origins whose `Accept-CH` is remembered at most; the oldest is forgotten first. */
export const MAX_OPT_IN_ORIGINS = 500;

/** A structured-field string (RFC 8941): printable ASCII only, quoted, `\` and `"` escaped. */
function sfString(value: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    return null;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sfBoolean(value: boolean): string {
  return value ? '?1' : '?0';
}

/** `"Not?A_Brand";v="24", "Chromium";v="152"`, Chromium's own format. */
function brandList(brands: readonly BrandVersion[]): string | null {
  const items: string[] = [];
  for (const { brand, version } of brands) {
    const name = sfString(brand);
    const value = sfString(version);
    if (name === null || value === null) {
      return null;
    }
    items.push(`${name};v=${value}`);
  }
  return items.join(', ');
}

function stringList(values: readonly string[]): string | null {
  const items = values.map(sfString);
  return items.includes(null) ? null : items.join(', ');
}

/** The header value Chromium would send for `hint`, or null if the data can't be encoded. */
export function hintValue(hint: ClientHint, data: UserAgentData): string | null {
  switch (hint) {
    case 'sec-ch-ua':
      return brandList(data.brands);
    case 'sec-ch-ua-mobile':
      return sfBoolean(data.mobile);
    case 'sec-ch-ua-platform':
      return sfString(data.platform);
    case 'sec-ch-ua-arch':
      return sfString(data.architecture);
    case 'sec-ch-ua-bitness':
      return sfString(data.bitness);
    case 'sec-ch-ua-form-factors':
      return stringList(data.formFactors);
    case 'sec-ch-ua-full-version':
      return sfString(data.uaFullVersion);
    case 'sec-ch-ua-full-version-list':
      return brandList(data.fullVersionList);
    case 'sec-ch-ua-model':
      return sfString(data.model);
    case 'sec-ch-ua-platform-version':
      return sfString(data.platformVersion);
    case 'sec-ch-ua-wow64':
      return sfBoolean(data.wow64);
  }
}

/** Whether a request to `url` may carry client hints at all: https, or http on loopback. */
export function sendsClientHints(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && isPromptableOrigin(origin);
}

/**
 * The opt-in hints an `Accept-CH` value asks for. Names are case-insensitive; the default hints
 * (always sent), unknown names and anything malformed are ignored.
 */
export function parseAcceptCh(value: string): Set<OptInHint> {
  const hints = new Set<OptInHint>();
  for (const part of value.split(',')) {
    const name = part.trim().toLowerCase();
    if (OPT_IN_SET.has(name)) {
      hints.add(name as OptInHint);
    }
  }
  return hints;
}

/** The opt-ins as stored: origins oldest first, each with the hints it asked for. */
// A type, not an interface: it must be assignable to a JSON document, which needs an index signature.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ClientHintsDocument = {
  v: 1;
  origins: Record<string, OptInHint[]>;
};

/** What each origin asked for with `Accept-CH` on a top-level page. */
export class ClientHintOptIns {
  readonly #byOrigin = new Map<string, ReadonlySet<OptInHint>>();
  readonly #onChange: (() => void) | undefined;

  constructor(
    options: {
      /** The stored document, unchecked: whatever isn't a secure origin and known hints is skipped. */
      readonly stored?: unknown;
      /** Called when what an origin asked for changed, to store the document. */
      readonly onChange?: () => void;
    } = {},
  ) {
    // Oldest first, so the newest MAX_OPT_IN_ORIGINS are the ones kept (more means a damaged file).
    for (const [origin, hints] of storedOptIns(options.stored).slice(-MAX_OPT_IN_ORIGINS)) {
      this.#byOrigin.set(origin, hints);
    }
    this.#onChange = options.onChange;
  }

  toDocument(): ClientHintsDocument {
    const origins: Record<string, OptInHint[]> = {};
    for (const [origin, hints] of this.#byOrigin) {
      origins[origin] = [...hints];
    }
    return { v: 1, origins };
  }

  /**
   * A top-level page's response from `url` carried `Accept-CH: value`. It replaces what that
   * origin asked for before (an empty value clears it). Ignored for insecure origins.
   */
  remember(url: string, value: string): void {
    const origin = originOf(url);
    if (origin === null || !isPromptableOrigin(origin)) {
      return;
    }
    const before = this.#byOrigin.get(origin);
    const hints = parseAcceptCh(value);
    const same = before?.size === hints.size && [...hints].every((hint) => before.has(hint));
    if (same) {
      // Asked again for the same: it keeps its place, so what is stored stays in step with this
      // (oldest first) and an origin's every page load costs no write.
      return;
    }
    this.#byOrigin.delete(origin);
    if (hints.size === 0) {
      if (before !== undefined) {
        this.#onChange?.();
      }
      return;
    }
    this.#byOrigin.set(origin, hints);
    this.#onChange?.();
    if (this.#byOrigin.size > MAX_OPT_IN_ORIGINS) {
      const oldest = this.#byOrigin.keys().next().value;
      if (oldest !== undefined) {
        this.#byOrigin.delete(oldest);
      }
    }
  }

  /** The opt-in hints a request to `url` gets. */
  for(url: string): ReadonlySet<OptInHint> {
    const origin = originOf(url);
    return (origin === null ? undefined : this.#byOrigin.get(origin)) ?? new Set();
  }
}

/** The usable entries of a stored document: secure origins as `originOf` writes them, known hints. */
function storedOptIns(stored: unknown): [string, ReadonlySet<OptInHint>][] {
  if (typeof stored !== 'object' || stored === null || !('v' in stored) || stored.v !== 1) {
    return [];
  }
  const origins = 'origins' in stored ? stored.origins : undefined;
  if (typeof origins !== 'object' || origins === null || Array.isArray(origins)) {
    return [];
  }
  const entries: [string, ReadonlySet<OptInHint>][] = [];
  for (const [origin, hints] of Object.entries(origins)) {
    if (originOf(origin) !== origin || !isPromptableOrigin(origin) || !Array.isArray(hints)) {
      continue;
    }
    const known = new Set(
      hints.filter((hint): hint is OptInHint => typeof hint === 'string' && OPT_IN_SET.has(hint)),
    );
    if (known.size > 0) {
      entries.push([origin, known]);
    }
  }
  return entries;
}

export interface HintRequest {
  readonly url: string;
  /** A document load, top-level or in a frame (Electron's `mainFrame` / `subFrame`). */
  readonly isDocument: boolean;
  /** The headers Chromium is about to send. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The client-hint headers to add to a request (lower-case names); never one already there. */
export function hintsToAdd(
  request: HintRequest,
  data: UserAgentData | null,
  optIns: ReadonlySet<OptInHint>,
): Record<string, string> {
  if (data === null || !sendsClientHints(request.url)) {
    return {};
  }
  const present = new Set(Object.keys(request.headers).map((name) => name.toLowerCase()));
  const wanted: ClientHint[] = [...(request.isDocument ? DEFAULT_HINTS : []), ...optIns];
  const added: Record<string, string> = {};
  for (const hint of wanted) {
    if (present.has(hint)) {
      continue;
    }
    const value = hintValue(hint, data);
    if (value !== null) {
      added[hint] = value;
    }
  }
  return added;
}
