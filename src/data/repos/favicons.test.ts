import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_FAVICON_BYTES, RASTER_TYPES } from '../../core/net/favicon-format';
import type { RasterType } from '../../core/net/favicon-format';
import { MAX_FAVICON_BASE64, MAX_FAVICONS_PER_GET } from '../../shared/contracts/data-rpc';
import { DataError } from '../errors';
import { faviconHandlers } from './favicons';
import { callerFor, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The smallest bytes each type sniffs as (core/net/favicon-format.ts). */
const SAMPLES: Readonly<Record<RasterType, readonly number[]>> = {
  'image/png': PNG,
  'image/x-icon': [0, 0, 1, 0, 1, 0],
  'image/gif': [...Buffer.from('GIF89a')],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
  'image/bmp': [...Buffer.from('BM'), ...new Array<number>(24).fill(0)],
};

/** An image of `mime` as far as the repository checks: its magic number, then `body`. */
function image(mime: RasterType, ...body: number[]): Buffer {
  return Buffer.from([...SAMPLES[mime], ...body]);
}
const png = (...body: number[]): Buffer => image('image/png', ...body);
const base64 = (bytes: Buffer): string => bytes.toString('base64');
/** A PNG of exactly `length` bytes (too many for a spread of arguments). */
const sized = (length: number, fill: number): Buffer =>
  Buffer.concat([Buffer.from(PNG), Buffer.alloc(length - PNG.length, fill)]);

describe('favicons', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    const call = callerFor(faviconHandlers(db));
    const put = (bytes: Buffer, mime: RasterType = 'image/png', at = T0) =>
      call('favicons.put', { bytes: base64(bytes), mime, at });
    const rows = () =>
      db
        .prepare(
          'SELECT id, sha256, mime, bytes, updated_at AS updatedAt FROM favicons ORDER BY id',
        )
        .all() as {
        id: number;
        sha256: string;
        mime: string;
        bytes: Buffer;
        updatedAt: number;
      }[];
    /** The error the repository throws for these bytes, or undefined if it took them. */
    const refusal = (bytes: Buffer, mime: RasterType = 'image/png'): unknown => {
      try {
        put(bytes, mime);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    return { db, call, put, rows, refusal };
  };

  describe('favicons.put', () => {
    it('stores an icon and answers with its id', () => {
      const { put, rows } = setup();

      const { id } = put(png(1, 2, 3, 4));

      expect(id).toBeGreaterThan(0);
      expect(rows().map((row) => row.id)).toEqual([id]);
    });

    it.each(RASTER_TYPES)('stores %s bytes exactly as given, with their type', (mime) => {
      const { put, rows } = setup();
      const bytes = image(mime, 10, 20, 30);

      put(bytes, mime);

      expect(rows()[0]?.bytes.equals(bytes)).toBe(true);
      expect(rows()[0]?.mime).toBe(mime);
    });

    it('keys the row by the SHA-256 of the bytes, in lower-case hex', () => {
      const { put, rows } = setup();
      const bytes = png(7, 7, 7);

      put(bytes);

      expect(rows()[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(rows()[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records the time it was put', () => {
      const { put, rows } = setup();

      put(png(1), 'image/png', T0 + 123);

      expect(rows()[0]?.updatedAt).toBe(T0 + 123);
    });

    it('answers with the same id for the same bytes, and stores them once', () => {
      const { put, rows } = setup();
      const bytes = png(1, 2, 3);

      const first = put(bytes);
      const second = put(bytes, 'image/png', T0 + 1);
      const third = put(bytes, 'image/png', T0 + 2);

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(rows()).toHaveLength(1);
    });

    it('answers with a different id for different bytes, even a single byte apart', () => {
      const { put, rows } = setup();
      const body = new Array<number>(2000).fill(5);
      const almost = [...body];
      almost[1999] = 6;

      const first = put(png(...body));
      const second = put(png(...almost));

      expect(second.id).not.toBe(first.id);
      expect(rows()).toHaveLength(2);
    });

    it('is one icon whether or not the base64 text carries its padding', () => {
      const { call, rows } = setup();
      // 8 + 2 bytes: base64 ends in `==` padding.
      const padded = base64(png(1, 2));
      expect(padded.endsWith('=')).toBe(true);

      const first = call('favicons.put', { bytes: padded, mime: 'image/png', at: T0 });
      const second = call('favicons.put', {
        bytes: padded.replace(/=+$/, ''),
        mime: 'image/png',
        at: T0,
      });

      expect(second.id).toBe(first.id);
      expect(rows()).toHaveLength(1);
    });

    it('moves the time forward when the same icon is put later, never back', () => {
      const { put, rows } = setup();
      const bytes = png(1);
      put(bytes, 'image/png', T0);

      put(bytes, 'image/png', T0 + 10);
      expect(rows()[0]?.updatedAt).toBe(T0 + 10);

      put(bytes, 'image/png', T0); // A clock that went back.
      put(bytes, 'image/png', 0);
      expect(rows()[0]?.updatedAt).toBe(T0 + 10);
    });

    it('keeps the bytes and the id it has when the same icon is put again', () => {
      const { put, rows } = setup();
      const bytes = png(4, 5, 6);
      const first = put(bytes);
      put(png(9));

      expect(put(bytes, 'image/png', T0 + 1).id).toBe(first.id);
      expect(rows()[0]?.bytes.equals(bytes)).toBe(true);
    });

    it('takes an icon of exactly MAX_FAVICON_BYTES, which is the longest base64 the contract takes', () => {
      const { put, rows } = setup();
      const bytes = sized(MAX_FAVICON_BYTES, 9);
      expect(bytes.length).toBe(MAX_FAVICON_BYTES);
      expect(base64(bytes).length).toBeLessThanOrEqual(MAX_FAVICON_BASE64);

      const { id } = put(bytes);

      expect(
        rows()
          .find((row) => row.id === id)
          ?.bytes.equals(bytes),
      ).toBe(true);
    });

    it('takes an icon that is no more than its magic number', () => {
      const { put, rows } = setup();

      put(Buffer.from(PNG));

      expect(rows()).toHaveLength(1);
    });

    describe('what it refuses', () => {
      const refused = (error: unknown, rows: () => unknown[]) => {
        expect(error).toBeInstanceOf(DataError);
        // No detail: nothing about the bytes leaves the worker.
        expect(error).toMatchObject({ code: 'invalid_input', detail: undefined });
        expect(rows()).toEqual([]);
      };

      it.each([
        ['text', Buffer.from('this is not an image at all')],
        ['SVG text', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
        ['a PNG signature one byte short', Buffer.from(PNG.slice(0, 7))],
        ['a single byte', Buffer.from([0x89])],
        ['a PNG signature with the last byte wrong', Buffer.from([...PNG.slice(0, 7), 0x0b, 1])],
        ['a PNG signature after a byte of padding', Buffer.from([0, ...PNG, 1])],
        ['zeros', Buffer.alloc(64)],
      ])('refuses %s', (_what, bytes) => {
        const { refusal, rows } = setup();

        refused(refusal(bytes), rows);
      });

      it.each(
        RASTER_TYPES.flatMap((real) =>
          RASTER_TYPES.filter((said) => said !== real).map((said) => [real, said] as const),
        ),
      )('refuses %s bytes said to be %s: the bytes decide, not the caller', (real, said) => {
        const { refusal, rows } = setup();

        refused(refusal(image(real, 1), said), rows);
      });

      it('refuses more than MAX_FAVICON_BYTES, though the base64 fits the contract', () => {
        const { refusal, rows } = setup();
        // 65,537 bytes is 87,384 base64 characters: what the contract allows for 65,536.
        const bytes = sized(MAX_FAVICON_BYTES + 1, 1);
        expect(base64(bytes).length).toBeLessThanOrEqual(MAX_FAVICON_BASE64);

        refused(refusal(bytes), rows);
      });

      it('stores nothing for a refused icon, beside icons that are fine', () => {
        const { put, rows, refusal } = setup();
        put(png(1));

        refusal(Buffer.from('not an image'));
        put(png(2));

        expect(rows()).toHaveLength(2);
      });

      it('has the schema refuse a type that is not a raster image, whatever the bytes', () => {
        const { db } = setup();

        expect(() =>
          db
            .prepare(
              "INSERT INTO favicons (sha256, bytes, mime, updated_at) VALUES ('x', x'00', ?, 1)",
            )
            .run(['image/svg+xml']),
        ).toThrow(/CHECK/);
      });
    });
  });

  describe('favicons.get', () => {
    it('answers with nothing for an id that is not there', () => {
      const { call } = setup();

      expect(call('favicons.get', { ids: [1, 2, 3] })).toEqual({ favicons: [] });
    });

    it('answers with the icon: its type, and the base64 of the bytes that were put', () => {
      const { call, put } = setup();
      const bytes = image('image/x-icon', 1, 2, 3, 4);
      const { id } = put(bytes, 'image/x-icon');

      expect(call('favicons.get', { ids: [id] })).toEqual({
        favicons: [{ id, mime: 'image/x-icon', bytes: base64(bytes) }],
      });
    });

    it('answers in the order of the ids, whatever order they were asked in, each once', () => {
      const { call, put } = setup();
      const a = put(png(1));
      const b = put(png(2));
      const c = put(png(3));

      const { favicons } = call('favicons.get', { ids: [c.id, a.id, 9999, b.id, a.id] });

      expect(favicons.map((icon) => icon.id)).toEqual([a.id, b.id, c.id]);
    });

    it(`takes ${String(MAX_FAVICONS_PER_GET)} ids at once, and the contract no more`, () => {
      const { call, put } = setup();
      const { id } = put(png(1));
      const ids = Array.from({ length: MAX_FAVICONS_PER_GET }, (_, n) =>
        n === 50 ? id : n + 10_000,
      );

      expect(call('favicons.get', { ids }).favicons.map((icon) => icon.id)).toEqual([id]);
      expect(() => call('favicons.get', { ids: [...ids, 1] })).toThrow();
    });

    it('round-trips an icon of the largest size', () => {
      const { call, put } = setup();
      const bytes = sized(MAX_FAVICON_BYTES, 3);
      const { id } = put(bytes);

      expect(call('favicons.get', { ids: [id] }).favicons[0]?.bytes).toBe(base64(bytes));
    });
  });
});
