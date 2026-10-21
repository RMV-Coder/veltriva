// The WHATWG URL class. Every runtime Veltriva's core code runs in (Chromium, Node, workers, a
// future browser extension) provides it, but src/core deliberately has no DOM or Node types, so
// it declares only the part it uses. Other targets get the full type from their own libs.

declare class URL {
  constructor(url: string, base?: string);
  static canParse(url: string, base?: string): boolean;
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
}

/** The WHATWG query-string class, as far as core/url/hygiene.ts uses it. */
declare class URLSearchParams {
  constructor(init?: string);
  has(name: string): boolean;
  get(name: string): string | null;
  delete(name: string): void;
  keys(): IterableIterator<string>;
  toString(): string;
}
