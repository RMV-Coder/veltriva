// Development builds load the shell from the Vite dev server instead of app://shell. The URL
// comes from an environment variable, so it's checked: plain http on loopback only. Production
// builds never reach this code (`import.meta.env.DEV` is false there).

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface DevServer {
  /** The page to load, e.g. `http://localhost:5173/`. */
  readonly url: string;
  /** Allowed as an IPC sender origin in development, e.g. `http://localhost:5173`. */
  readonly origin: string;
}

export function parseDevServerUrl(raw: string): DevServer {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to load the shell from a non-local dev server: ${url.origin}`);
  }
  return { url: url.href, origin: url.origin };
}
