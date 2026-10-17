// A throwaway TLS identity for the HTTPS fixture (M1.4b), made at test time with Node's `crypto`
// and nothing else: a fresh P-256 key pair and a self-signed X.509 certificate built by hand in
// DER. The private key lives in memory only and is never written anywhere. Node has no API to
// make a certificate, which is why the few ASN.1 pieces a certificate needs are encoded here.
//
// The certificate is self-signed and otherwise right (valid dates, the name 127.0.0.1), so what
// Chromium finds wrong is exactly that no one it trusts signed it: ERR_CERT_AUTHORITY_INVALID.
// An expired or wrong-name certificate would be reported the same way, because Chromium names the
// authority first when a certificate has several faults (measured), so those variants would add
// nothing to a spec.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export interface ServerIdentity {
  /** PEM, PKCS#8. For `https.createServer` only. */
  readonly key: string;
  /** PEM. */
  readonly cert: string;
  /** Base64 SHA-256 of the certificate's public key, the form `--ignore-certificate-errors-spki-list` takes. */
  readonly spkiSha256: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── DER ─────────────────────────────────────────────────────────────────────────────────────────

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER element: its tag, the length of its contents, then the contents. */
function element(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...contents: Buffer[]): Buffer => element(0x30, ...contents);
const setOf = (...contents: Buffer[]): Buffer => element(0x31, ...contents);
const octetString = (contents: Buffer): Buffer => element(0x04, contents);
const boolean = (value: boolean): Buffer => element(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (text: string): Buffer => element(0x0c, Buffer.from(text, 'utf8'));
const bitString = (contents: Buffer, unusedBits = 0): Buffer =>
  element(0x03, Buffer.from([unusedBits]), contents);

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const trimmed = bytes.subarray(start);
  const padded = (trimmed[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return element(0x02, padded);
}

function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const [first = 0, second = 0, ...rest] = arcs;
  const encoded: number[] = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      groups.unshift((value & 0x7f) | 0x80);
    }
    encoded.push(...groups);
  }
  return element(0x06, Buffer.from(encoded));
}

/** UTCTime, which covers 1950 to 2049. */
function utcTime(date: Date): Buffer {
  const two = (value: number): string => String(value).padStart(2, '0');
  const text =
    two(date.getUTCFullYear() % 100) +
    two(date.getUTCMonth() + 1) +
    two(date.getUTCDate()) +
    two(date.getUTCHours()) +
    two(date.getUTCMinutes()) +
    two(date.getUTCSeconds()) +
    'Z';
  return element(0x17, Buffer.from(text, 'ascii'));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(objectIdentifier(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function name(commonName: string): Buffer {
  return sequence(setOf(sequence(objectIdentifier('2.5.4.3'), utf8String(commonName))));
}

// ── The certificate ─────────────────────────────────────────────────────────────────────────────

/** ecdsa-with-SHA256 */
const SIGNATURE_ALGORITHM = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
const SUBJECT_NAME = 'Veltriva test fixture - self-signed throwaway';

/** A fresh key pair and a self-signed certificate for 127.0.0.1, valid from yesterday for a month. */
export function createServerIdentity(): ServerIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const now = Date.now();
  const notBefore = new Date(now - DAY_MS);
  const notAfter = new Date(now + 30 * DAY_MS);

  // 127.0.0.1 as an IP address (tag [7]).
  const alternativeNames = [element(0x87, Buffer.from([127, 0, 0, 1]))];

  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;

  const toBeSigned = sequence(
    element(0xa0, integer(Buffer.from([2]))), // version 3
    integer(serial),
    SIGNATURE_ALGORITHM,
    name(SUBJECT_NAME), // issuer: the same as the subject, which is what self-signed means
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name(SUBJECT_NAME),
    spki,
    element(
      0xa3,
      sequence(
        extension('2.5.29.19', true, sequence()), // basicConstraints: not a CA
        extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)), // keyUsage: digitalSignature
        extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))), // serverAuth
        extension('2.5.29.17', false, sequence(...alternativeNames)), // subjectAltName
      ),
    ),
  );
  const signature = sign('sha256', toBeSigned, { key: privateKey, dsaEncoding: 'der' });
  const certificate = sequence(toBeSigned, SIGNATURE_ALGORITHM, bitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate),
    spkiSha256: createHash('sha256').update(spki).digest('base64'),
  };
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
