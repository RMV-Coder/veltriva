// The baseline every session gets (ADR-0002 §4, assessment §3.7). Electron's defaults grant
// every permission, pick the first client certificate and show a save dialog for downloads, so
// each of those is overridden. For now everything is denied; the permission broker, the download
// manager and the external-protocol guard (M1.4) replace these deny-alls with real policy.
import { app } from 'electron';
import type { Session } from 'electron';

import { isTabPermissionGranted } from './permission-policy';

/**
 * Hunspell dictionaries for languages Windows can't spellcheck would come from Google's CDN
 * (spike S7). Until we host them, point downloads at the discard port on loopback, so the
 * request fails at once and never leaves the machine. Windows' own spellchecker still works.
 */
export const SPELLCHECK_DICTIONARY_PLACEHOLDER = 'http://127.0.0.1:9/spellcheck-dictionaries/';

const hardened = new WeakSet<Session>();

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
  // No downloads until the download manager (M1.4); cancelling also prevents the save dialog.
  session.on('will-download', (event) => {
    event.preventDefault();
  });
  session.setSpellCheckerDictionaryDownloadURL(SPELLCHECK_DICTIONARY_PLACEHOLDER);
}

/**
 * The browsing session (tabs) additionally gets the few permissions Chrome grants without a
 * prompt (./permission-policy.ts). Call right after hardening it, before any tab exists.
 */
export function grantTabPermissions(session: Session): void {
  hardenSession(session);
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isTabPermissionGranted(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) => isTabPermissionGranted(permission));
}

/** Install before `ready`, so no session or request is created without the baseline. */
export function installSessionBaseline(): void {
  app.on('session-created', hardenSession);

  // Electron auto-selects the first client certificate unless the app intervenes. Decline.
  app.on('select-client-certificate', (event, _contents, _url, _certificates, callback) => {
    event.preventDefault();
    callback();
  });
  // HTTP and proxy authentication: cancel (a credential prompt is a later should-have).
  app.on('login', (event, _contents, _details, _authInfo, callback) => {
    event.preventDefault();
    callback();
  });
  // Certificate errors: no 'certificate-error' handler, so Electron keeps rejecting them.
}
