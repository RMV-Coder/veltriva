import { describe, expect, it } from 'vitest';

import { errorPageFor } from './error-pages';

describe('errorPageFor', () => {
  it.each([
    [-200, 'certificate-error'], // ERR_CERT_COMMON_NAME_INVALID
    [-201, 'certificate-error'], // ERR_CERT_DATE_INVALID
    [-202, 'certificate-error'], // ERR_CERT_AUTHORITY_INVALID (self-signed)
    [-207, 'certificate-error'], // ERR_CERT_INVALID
    [-299, 'certificate-error'],
    [-110, 'client-certificate'], // ERR_SSL_CLIENT_AUTH_CERT_NEEDED
    [-117, 'client-certificate'], // ERR_BAD_SSL_CLIENT_AUTH_CERT
    [-134, 'client-certificate'], // ERR_SSL_CLIENT_AUTH_CERT_NO_PRIVATE_KEY
    [-105, 'network-error'], // ERR_NAME_NOT_RESOLVED
    [-102, 'network-error'], // ERR_CONNECTION_REFUSED
    [-107, 'network-error'], // ERR_SSL_PROTOCOL_ERROR: not a certificate the user could judge
    [-300, 'network-error'], // ERR_INVALID_URL
    [-199, 'network-error'],
  ])('%i → %s', (code, page) => {
    expect(errorPageFor(code)).toBe(page);
  });
});
