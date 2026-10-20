// What a notice strip says, derived from the snapshot's `notices`. Pure, so Vitest covers it; the
// component only renders what this returns.
//
// A notice is Veltriva talking about itself, so every word is written here, with one exception:
// `corruptFile` is a file name that came from the profile folder, and it is shown as untrusted
// text, like everything in the prompt strip that this file doesn't write (see
// ../prompts/prompt-display.ts):
//   - controls and invisible formatting (bidi overrides included) are removed, because `<bdi>`
//     isolates a run from the words around it, not from an override inside it. Main already makes
//     the name safe; this is the second line of defense;
//   - the component renders it in `<bdi dir="ltr">`, so bidirectional text can't reorder the
//     sentence around it;
//   - a long name is cut in the middle, keeping its end, and the whole name is the tooltip.
// The time is formatted here from a number, never taken from text, so it is trusted.
import type { NoticeSnapshot } from '../../../shared/contracts/schemas';
import { truncateFileName } from '../downloads/download-display';
import { cleanText } from '../prompts/prompt-display';
import type { PromptPart } from '../prompts/prompt-display';

export type Notice = NoticeSnapshot;
export type NoticeKind = Notice['kind'];
/** One run of the sentence: the same shape the prompt strip's sentences have. */
export type NoticePart = PromptPart;

/** The file name is shown with at most this many characters, ellipsis included. */
export const MAX_NOTICE_FILE_CHARS = 64;

/** The region's accessible name. */
export function noticeLabel(kind: NoticeKind): string {
  switch (kind) {
    case 'database-restored':
      return 'Database restored from backup';
    case 'database-reset':
      return 'Database reset';
  }
}

/**
 * Which language and time zone to write a time in. Both are the system's when left out, which is
 * what the shell wants; tests give them so that their expectations don't depend on the machine.
 */
export interface TimeFormat {
  readonly locale?: string;
  readonly timeZone?: string;
}

/**
 * A moment for people, in the user's own language: "Oct 21, 2026, 8:30 AM". Null when it can't be
 * written (a number `Date` can't hold, or a language or zone the system doesn't know): the
 * sentence then leaves the time out rather than show a wrong one.
 */
export function formatNoticeTime(ms: number, format: TimeFormat = {}): string | null {
  try {
    return new Intl.DateTimeFormat(format.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(format.timeZone === undefined ? {} : { timeZone: format.timeZone }),
    }).format(ms);
  } catch {
    return null;
  }
}

function plain(text: string): NoticePart {
  return { text, untrusted: false, strong: false };
}

/** The sentence's last words, naming the file the damaged database was kept as. */
function keptAs(corruptFile: string): readonly NoticePart[] {
  const full = cleanText(corruptFile);
  if (full === '') {
    return [plain(' The damaged file was kept in your profile folder.')];
  }
  const text = truncateFileName(full, MAX_NOTICE_FILE_CHARS);
  return [
    plain(' The damaged file was kept as '),
    text === full
      ? { text, untrusted: true, strong: false }
      : { text, untrusted: true, strong: false, full },
    plain(' in your profile folder.'),
  ];
}

/** The strip's sentence for a notice, as parts. */
export function noticeSentence(notice: Notice, format: TimeFormat = {}): readonly NoticePart[] {
  switch (notice.kind) {
    case 'database-restored': {
      const time = formatNoticeTime(notice.backupAt, format);
      return [
        plain(
          time === null
            ? "Veltriva's database was damaged, so it was restored from a backup."
            : `Veltriva's database was damaged, so it was restored from a backup from ${time}.`,
        ),
        ...keptAs(notice.corruptFile),
      ];
    }
    case 'database-reset':
      return [
        plain(
          "Veltriva's database was damaged and no backup could be used, so Veltriva started with an empty one.",
        ),
        ...keptAs(notice.corruptFile),
      ];
  }
}
