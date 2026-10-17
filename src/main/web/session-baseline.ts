// The baseline every session gets (ADR-0002 §4, assessment §3.7). Electron's defaults grant
// every permission, pick the first client certificate and show a save dialog for downloads, so
// each of those is overridden, and everything is denied. The browsing session's permission
// handlers are then replaced by the permission broker (src/main/permissions/permission-broker.ts);
// downloads, client certificates and HTTP auth get real policy in M1.4b.
import { app } from 'electron';
import type { AuthenticationResponseDetails, AuthInfo, Session, WebContents } from 'electron';

/**
 * Hunspell dictionaries for languages Windows can't spellcheck would come from Google's CDN
 * (spike S7). Until we host them, point downloads at the discard port on loopback, so the
 * request fails at once and never leaves the machine. Windows' own spellchecker still works.
 */
export const SPELLCHECK_DICTIONARY_PLACEHOLDER = 'http://127.0.0.1:9/spellcheck-dictionaries/';

const hardened = new WeakSet<Session>();
/** Sessions whose downloads the download manager handles (src/main/downloads). */
const managedDownloads = new WeakSet<Session>();

/** Lets a session's downloads through to the download manager, which always sets a save path. */
export function allowManagedDownloads(session: Session): void {
  managedDownloads.add(session);
}

/**
 * HTTP authentication (`login`): main's sign-in prompt, once it exists. Returns false to cancel.
 * It must call `callback` itself when it returns true.
 */
export type LoginHandler = (
  contents: WebContents | null,
  details: AuthenticationResponseDetails,
  authInfo: AuthInfo,
  callback: (username?: string, password?: string) => void,
) => boolean;

let onLogin: LoginHandler | undefined;

export function setLoginHandler(handler: LoginHandler): void {
  onLogin = handler;
}

/** Idempotent. Applied to every session as Electron creates it, and again explicitly at startup. */
export function hardenSession(session: Session): void {
  if (hardened.has(session)) {
    return;
  }
  hardened.add(session);

  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => {
    callback(null);
  });
  session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false });
  });
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  session.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  // No downloads unless the download manager handles this session; cancelling also prevents
  // Electron's save dialog.
  session.on('will-download', (event) => {
    if (!managedDownloads.has(session)) {
      event.preventDefault();
    }
  });
  session.setSpellCheckerDictionaryDownloadURL(SPELLCHECK_DICTIONARY_PLACEHOLDER);
}

/** Install before `ready`, so no session or request is created without the baseline. */
export function installSessionBaseline(): void {
  app.on('session-created', hardenSession);

  // Electron auto-selects the first client certificate unless the app intervenes. Decline.
  app.on('select-client-certificate', (event, _contents, _url, _certificates, callback) => {
    event.preventDefault();
    callback();
  });
  // HTTP and proxy authentication: main's sign-in prompt decides, or it is cancelled.
  app.on('login', (event, contents, details, authInfo, callback) => {
    event.preventDefault();
    if (onLogin?.(contents, details, authInfo, callback) !== true) {
      callback();
    }
  });
  // Certificate errors: no 'certificate-error' handler, so Electron keeps rejecting them.
}
