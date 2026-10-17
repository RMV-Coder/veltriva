// Which internal page a failed load shows (ADR-0002 §4, assessment §3.7). Chromium's net error
// codes: certificate errors are -200 to -299 (ERR_CERT_*), and a server that wants a client
// certificate fails with an SSL client-auth error once Veltriva declines to pick one. Neither page
// has a way to proceed anyway in the MVP. Pure, so the mapping is unit-tested.
import type { InternalPage } from '../url/internal-pages';

/** ERR_SSL_CLIENT_AUTH_CERT_NEEDED, ERR_BAD_SSL_CLIENT_AUTH_CERT, ERR_SSL_CLIENT_AUTH_CERT_NO_PRIVATE_KEY. */
const CLIENT_CERTIFICATE_ERRORS: ReadonlySet<number> = new Set([-110, -117, -134]);

export type ErrorPage = Extract<
  InternalPage,
  'network-error' | 'certificate-error' | 'client-certificate'
>;

export function errorPageFor(code: number): ErrorPage {
  if (code <= -200 && code > -300) {
    return 'certificate-error';
  }
  if (CLIENT_CERTIFICATE_ERRORS.has(code)) {
    return 'client-certificate';
  }
  return 'network-error';
}
