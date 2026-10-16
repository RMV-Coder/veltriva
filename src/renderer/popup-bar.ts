// The read-only address bar of a popup window (src/main/windows/popup-windows.ts, ADR-0002 §4).
// It has no preload and no IPC. Main calls `veltrivaPopupBar.show(state)` with a JSON literal of
// the committed URL's display text (main's `displayUrl`: no credentials, punycode host), and the
// text only ever goes into text nodes.
import './popup-bar.css';

type SecurityState = 'secure' | 'not-secure' | 'local' | 'internal' | 'neutral';

const SECURITY_LABELS: Readonly<Record<SecurityState, string>> = {
  secure: 'Secure connection',
  'not-secure': 'Not secure',
  local: 'Local file',
  internal: 'Veltriva page',
  neutral: 'Page',
};

/** As in the main address bar's contract: longer text is cut by main already. */
const MAX_TEXT_LENGTH = 4096;

const address = document.getElementById('address');
const security = document.getElementById('security');

function isSecurityState(value: unknown): value is SecurityState {
  return typeof value === 'string' && Object.hasOwn(SECURITY_LABELS, value);
}

/** The site part (scheme and host) stands out from the rest, as in Chrome. */
function render(text: string): void {
  if (address === null) {
    return;
  }
  let host = '';
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const origin = `${url.protocol}//${url.host}`;
      host = text.startsWith(origin) ? origin : '';
    }
  } catch {
    host = '';
  }
  const site = document.createElement('span');
  site.className = 'site';
  site.textContent = host === '' ? text : host;
  const rest = document.createElement('span');
  rest.className = 'rest';
  rest.textContent = host === '' ? '' : text.slice(host.length);
  address.replaceChildren(site, rest);
  address.title = text;
}

function show(state: unknown): void {
  if (typeof state !== 'object' || state === null) {
    return;
  }
  const { text, security: level } = state as { text?: unknown; security?: unknown };
  if (typeof text !== 'string') {
    return;
  }
  render(text.slice(0, MAX_TEXT_LENGTH));
  const known = isSecurityState(level) ? level : 'neutral';
  if (security !== null) {
    security.dataset.state = known;
    security.setAttribute('aria-label', SECURITY_LABELS[known]);
  }
}

declare global {
  var veltrivaPopupBar: { readonly show: (state: unknown) => void } | undefined;
}

globalThis.veltrivaPopupBar = Object.freeze({ show });
