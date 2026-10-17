// File names for downloads (ADR-0002 §4, assessment §6.4). A download's name comes from the site
// (Content-Disposition or the URL), so it is untrusted: it must not reach outside the Downloads
// folder, hit a Windows device name, hide its real extension behind bidi tricks, or overwrite an
// existing file. Pure, so every rule is unit-tested.

/** Types that need "Keep" before they can be opened (assessment §6.4). */
export const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'msi',
  'msix',
  'appx',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'vbs',
  'js',
  'jse',
  'wsf',
  'hta',
  'lnk',
  'reg',
  'jar',
  'iso',
  'img',
  'vhd',
  'vhdx',
]);

/** Windows reserved device names, with or without an extension (`CON.txt` is still CON). */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** Characters Windows forbids in names, path separators included. */
const FORBIDDEN = /[<>:"/\\|?*]/g;
/** Controls and invisible formatting: a right-to-left override can make `cod.exe` read `exe.doc`. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Longest name kept, in UTF-16 units; leaves room for the folder and a " (99)" suffix. */
export const MAX_FILE_NAME_LENGTH = 180;
const FALLBACK_NAME = 'download';

/** The last extension, lowercased, or '' when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** A name that is safe as a single file in the Downloads folder. */
export function sanitizeFileName(raw: string): string {
  let name = raw.replace(INVISIBLE, '').replace(FORBIDDEN, '_').replace(/\s+/g, ' ').trim();
  // Windows drops trailing dots and spaces, which would change the extension it sees.
  name = name.replace(/[. ]+$/, '');
  // A leading dot would make a hidden-looking dotfile; ".." can't be a name at all.
  name = name.replace(/^\.+/, '');
  if (name === '') {
    return FALLBACK_NAME;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const base = stem.split('.')[0] ?? stem;
  const safeStem = RESERVED_NAMES.test(base.trim()) ? `_${stem}` : stem;
  return truncate(safeStem, extension);
}

/** Keeps the extension whole: a long name loses the end of its stem, never its type. */
function truncate(stem: string, extension: string): string {
  if (stem.length + extension.length <= MAX_FILE_NAME_LENGTH) {
    return stem + extension;
  }
  const room = Math.max(1, MAX_FILE_NAME_LENGTH - extension.length);
  // Whole characters only: never half a surrogate pair.
  let cut = '';
  for (const char of stem) {
    if (cut.length + char.length > room) {
      break;
    }
    cut += char;
  }
  return cut + extension.slice(0, MAX_FILE_NAME_LENGTH - cut.length);
}

/**
 * The first free name: `report.pdf`, then `report (1).pdf`, `report (2).pdf` and so on, as Chrome
 * names them. `taken` answers for a name on disk or one a download in progress already holds.
 */
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${stem} (${String(index)})${extension}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
  return `${stem} (${String(Date.now())})${extension}`;
}

/** Whether a file needs "Keep" before it can be opened. */
export function isDangerousFileName(name: string): boolean {
  return DANGEROUS_EXTENSIONS.has(extensionOf(name));
}

/** The name a dangerous file has on disk until the user keeps it: Windows won't run it. */
export const UNCONFIRMED_SUFFIX = '.unconfirmed';
