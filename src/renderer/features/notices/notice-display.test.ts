import { describe, expect, it } from 'vitest';

import { partsText } from '../prompts/prompt-display';
import {
  MAX_NOTICE_FILE_CHARS,
  formatNoticeTime,
  noticeLabel,
  noticeSentence,
} from './notice-display';
import type { Notice } from './notice-display';

/** 21 October 2026, 08:30 UTC. */
const BACKUP_AT = Date.UTC(2026, 9, 21, 8, 30);
const CORRUPT = 'veltriva.db.corrupt-2026-10-21T08-30-00Z';
/** Tests name their language and zone, so they don't depend on the machine. */
const UTC_EN = { locale: 'en-US', timeZone: 'UTC' } as const;

// The characters a hostile file name could carry, written as code points so that none of them is
// ever typed into this file.
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const NULL = String.fromCodePoint(0x0000);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const LEFT_TO_RIGHT_ISOLATE = String.fromCodePoint(0x2066);

function restored(overrides: Partial<Extract<Notice, { kind: 'database-restored' }>> = {}): Notice {
  return {
    id: 'notice-1',
    kind: 'database-restored',
    backupAt: BACKUP_AT,
    corruptFile: CORRUPT,
    ...overrides,
  };
}

function reset(corruptFile = CORRUPT): Notice {
  return { id: 'notice-2', kind: 'database-reset', corruptFile };
}

/**
 * Time text may separate the time from AM or PM with a narrow no-break space, depending on the
 * ICU version: every kind of space becomes a plain one.
 */
const plainSpaces = (text: string): string => text.replace(/\s/gu, ' ');

describe('formatNoticeTime', () => {
  it('writes the date and the time in the given language and zone', () => {
    expect(plainSpaces(formatNoticeTime(BACKUP_AT, UTC_EN) ?? '')).toBe('Oct 21, 2026, 8:30 AM');
    expect(formatNoticeTime(BACKUP_AT, { locale: 'en-GB', timeZone: 'UTC' })).toBe(
      '21 Oct 2026, 08:30',
    );
    expect(formatNoticeTime(BACKUP_AT, { locale: 'de-DE', timeZone: 'Europe/Berlin' })).toBe(
      '21.10.2026, 10:30',
    );
  });

  it('moves the clock with the zone, and the date with it', () => {
    const lateEvening = Date.UTC(2026, 9, 21, 23, 45);
    expect(plainSpaces(formatNoticeTime(lateEvening, UTC_EN) ?? '')).toBe('Oct 21, 2026, 11:45 PM');
    expect(
      plainSpaces(formatNoticeTime(lateEvening, { locale: 'en-US', timeZone: 'Asia/Tokyo' }) ?? ''),
    ).toBe('Oct 22, 2026, 8:45 AM');
  });

  it('writes a time in the system language and zone when none is given', () => {
    // Whatever the machine's language, calendar and zone are, this is how it writes the moment.
    expect(formatNoticeTime(BACKUP_AT)).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        BACKUP_AT,
      ),
    );
  });

  it('is null for a time that cannot be written, never a wrong one', () => {
    expect(formatNoticeTime(Number.MAX_SAFE_INTEGER, UTC_EN)).toBeNull();
    expect(formatNoticeTime(Number.NaN, UTC_EN)).toBeNull();
    expect(formatNoticeTime(BACKUP_AT, { locale: 'en-US', timeZone: 'Not/AZone' })).toBeNull();
    expect(formatNoticeTime(BACKUP_AT, { locale: 'not a locale' })).toBeNull();
  });
});

describe('noticeSentence', () => {
  it('says a restored database was damaged, when its backup is from, and where the file went', () => {
    expect(plainSpaces(partsText(noticeSentence(restored(), UTC_EN)))).toBe(
      "Veltriva's database was damaged, so it was restored from a backup from Oct 21, 2026, 8:30 AM. " +
        'The damaged file was kept as veltriva.db.corrupt-2026-10-21T08-30-00Z in your profile folder.',
    );
  });

  it('says a reset database was damaged, that no backup helped, and where the file went', () => {
    expect(partsText(noticeSentence(reset(), UTC_EN))).toBe(
      "Veltriva's database was damaged and no backup could be used, so Veltriva started with an empty one. " +
        'The damaged file was kept as veltriva.db.corrupt-2026-10-21T08-30-00Z in your profile folder.',
    );
  });

  it('writes the time in the user’s language', () => {
    const text = partsText(
      noticeSentence(restored(), { locale: 'de-DE', timeZone: 'Europe/Berlin' }),
    );
    expect(text).toContain('restored from a backup from 21.10.2026, 10:30. ');
  });

  it('leaves the time out, rather than guess one, when it cannot be written', () => {
    const text = partsText(noticeSentence(restored({ backupAt: Number.MAX_SAFE_INTEGER }), UTC_EN));
    expect(text).toBe(
      "Veltriva's database was damaged, so it was restored from a backup. " +
        'The damaged file was kept as veltriva.db.corrupt-2026-10-21T08-30-00Z in your profile folder.',
    );
  });

  it('marks the file name, and only the file name, as untrusted text', () => {
    for (const notice of [restored(), reset()]) {
      const untrusted = noticeSentence(notice, UTC_EN).filter((part) => part.untrusted);
      expect(untrusted).toEqual([{ text: CORRUPT, untrusted: true, strong: false }]);
    }
  });

  it('removes controls, bidi overrides and invisible marks from the file name', () => {
    // Whatever they could do to the words around the name, they are gone before it shows.
    const hostile = [
      'evil',
      RIGHT_TO_LEFT_OVERRIDE,
      'gnp.exe',
      NULL,
      ZERO_WIDTH_JOINER,
      LINE_SEPARATOR,
      LEFT_TO_RIGHT_ISOLATE,
      '.db',
    ].join('');
    const gone = [
      RIGHT_TO_LEFT_OVERRIDE,
      NULL,
      ZERO_WIDTH_JOINER,
      LINE_SEPARATOR,
      LEFT_TO_RIGHT_ISOLATE,
    ];
    for (const notice of [restored({ corruptFile: hostile }), reset(hostile)]) {
      const parts = noticeSentence(notice, UTC_EN);
      const name = parts.find((part) => part.untrusted);
      expect(name?.text).toBe('evil gnp.exe .db');
      const text = partsText(parts);
      for (const character of gone) {
        expect(text.includes(character), `U+${character.codePointAt(0)?.toString(16) ?? '?'}`).toBe(
          false,
        );
      }
    }
  });

  it('cuts a long name in the middle, keeps its end, and offers the whole name as the tooltip', () => {
    const long = `veltriva.db.corrupt-${'x'.repeat(200)}-2026-10-21T08-30-00Z`;
    const name = noticeSentence(reset(long), UTC_EN).find((part) => part.untrusted);
    expect(Array.from(name?.text ?? '')).toHaveLength(MAX_NOTICE_FILE_CHARS);
    expect(name?.text).toContain('…');
    expect(name?.text.startsWith('veltriva.db.corrupt-')).toBe(true);
    expect(name?.text.endsWith('08-30-00Z')).toBe(true);
    expect(name?.full).toBe(long);
  });

  it('gives a name that fits no tooltip of its own', () => {
    const name = noticeSentence(reset(), UTC_EN).find((part) => part.untrusted);
    expect(name).not.toHaveProperty('full');
  });

  it('names no file when nothing of the name is left, and still reads as a sentence', () => {
    const invisible = `${RIGHT_TO_LEFT_OVERRIDE}${ZERO_WIDTH_SPACE}`;
    for (const notice of [restored({ corruptFile: invisible }), reset('   ')]) {
      const parts = noticeSentence(notice, UTC_EN);
      expect(parts.some((part) => part.untrusted)).toBe(false);
      expect(partsText(parts)).toMatch(/ The damaged file was kept in your profile folder\.$/u);
    }
  });

  it('keeps a name that looks like markup as one untrusted run of text', () => {
    // The component renders `text` as a React child, so it is text, never markup. What matters
    // here is that it stays one untrusted part, which the component isolates in a <bdi>.
    const parts = noticeSentence(reset('<img src=x onerror=alert(1)>.db'), UTC_EN);
    expect(parts.filter((part) => part.untrusted).map((part) => part.text)).toEqual([
      '<img src=x onerror=alert(1)>.db',
    ]);
  });
});

describe('noticeLabel', () => {
  it('names each region differently', () => {
    expect(noticeLabel('database-restored')).toBe('Database restored from backup');
    expect(noticeLabel('database-reset')).toBe('Database reset');
  });
});
