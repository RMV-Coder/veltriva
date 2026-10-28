// File names for downloads (ADR-0002 §4, assessment §6.4). A download's name comes from the site
// (Content-Disposition or the URL), so it is untrusted: it must not reach outside the Downloads
// folder, hit a Windows device name, hide its real extension behind bidi tricks, or overwrite an
// existing file. Pure, so every rule is unit-tested.

/**
 * Types that need "Keep" before they can be opened. Open hands the file to Windows (`shell.openPath`),
 * so anything Windows runs, loads or installs must be here. Taken from Chromium's own list: every
 * type whose Windows danger level is DANGEROUS or ALLOW_ON_USER_GESTURE in
 * components/safe_browsing/content/resources/download_file_types.asciipb (version_id 69, read
 * 2026-10-17; 168 types). Veltriva asks for Keep on all of them, even where Chrome waives the
 * warning after a gesture. Added on top: the assessment §6.4 disk images, and types Chromium
 * lacks that Windows still runs or installs (`cab`, `psd1`, `appinstaller`, `searchconnector-ms`).
 */
const CHROMIUM_DANGEROUS_ON_WINDOWS = [
  'accda',
  'accdb',
  'accde',
  'accdr',
  'ad',
  'ade',
  'adp',
  'app',
  'application',
  'appref-ms',
  'appx',
  'appxbundle',
  'asp',
  'asx',
  'bas',
  'bat',
  'bgi',
  'cer',
  'cfg',
  'chi',
  'chm',
  'class',
  'cmd',
  'com',
  'cpi',
  'cpl',
  'crt',
  'crx',
  'der',
  'diagcab',
  'diagcfg',
  'diagpkg',
  'dll',
  'drv',
  'efi',
  'eml',
  'exe',
  'fon',
  'fxp',
  'gadget',
  'grp',
  'hlp',
  'hta',
  'htt',
  'img',
  'inf',
  'ini',
  'ins',
  'inx',
  'iqy',
  'isp',
  'isu',
  'jar',
  'jnlp',
  'job',
  'js',
  'jse',
  'library-ms',
  'lnk',
  'local',
  'mad',
  'maf',
  'mag',
  'mam',
  'manifest',
  'maq',
  'mar',
  'mas',
  'mat',
  'mau',
  'mav',
  'maw',
  'mda',
  'mdb',
  'mde',
  'mdt',
  'mdw',
  'mdz',
  'mht',
  'mhtml',
  'mmc',
  'mof',
  'msc',
  'msg',
  'msh',
  'msh1',
  'msh1xml',
  'msh2',
  'msh2xml',
  'mshxml',
  'msi',
  'msix',
  'msixbundle',
  'msp',
  'mst',
  'ocx',
  'ops',
  'oxt',
  'paf',
  'partial',
  'pcd',
  'pif',
  'pl',
  'plg',
  'prf',
  'prg',
  'ps1',
  'ps1xml',
  'ps2',
  'ps2xml',
  'psc1',
  'psc2',
  'psm1',
  'pst',
  'py',
  'pyc',
  'pyd',
  'pyo',
  'pyw',
  'pyz',
  'pyzw',
  'rb',
  'reg',
  'rels',
  'rgs',
  'scf',
  'scr',
  'sct',
  'search-ms',
  'settingcontent-ms',
  'shb',
  'shs',
  'slk',
  'spl',
  'swf',
  'sys',
  'u3p',
  'url',
  'vb',
  'vbe',
  'vbs',
  'vbscript',
  'vdx',
  'vsd',
  'vsdm',
  'vsdx',
  'vsmacros',
  'vss',
  'vssm',
  'vssx',
  'vst',
  'vstm',
  'vstx',
  'vsw',
  'vsx',
  'vtx',
  'website',
  'ws',
  'wsc',
  'wsf',
  'wsh',
  'xbap',
  'xll',
  'xml',
  'xnk',
  'xrm-ms',
  'xsd',
  'xsl',
];

const ALSO_DANGEROUS = ['appinstaller', 'cab', 'iso', 'psd1', 'searchconnector-ms', 'vhd', 'vhdx'];

export const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  ...CHROMIUM_DANGEROUS_ON_WINDOWS,
  ...ALSO_DANGEROUS,
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

/**
 * The name without its trailing dots and spaces, which Windows ignores. A loop, not `/[. ]+$/`:
 * that regex is retried from every position, so a long run of dots and spaces in a name a server
 * sent (before the name is cut to length) took seconds of main's time (M6.2 review).
 */
export function trimTrailingDotsAndSpaces(name: string): string {
  let end = name.length;
  while (end > 0 && (name.charAt(end - 1) === '.' || name.charAt(end - 1) === ' ')) {
    end -= 1;
  }
  return name.slice(0, end);
}

/** The last extension, lowercased, or '' when there is none. */
export function extensionOf(name: string): string {
  // Windows ignores trailing dots and spaces: "Setup.PIF." is a .pif.
  const trimmed = trimTrailingDotsAndSpaces(name);
  const dot = trimmed.lastIndexOf('.');
  return dot <= 0 ? '' : trimmed.slice(dot + 1).toLowerCase();
}

/**
 * A raw name longer than this keeps only its start and its end (where the extension is) before
 * anything else runs: it is cut to MAX_FILE_NAME_LENGTH anyway, and a server chooses it, so the work
 * on it stays small (M6.2 review).
 */
export const MAX_RAW_NAME_LENGTH = 4096;

/** A name that is safe as a single file in the Downloads folder. */
export function sanitizeFileName(raw: string): string {
  const half = MAX_RAW_NAME_LENGTH / 2;
  const bounded = raw.length > MAX_RAW_NAME_LENGTH ? raw.slice(0, half) + raw.slice(-half) : raw;
  let name = bounded.replace(INVISIBLE, '').replace(FORBIDDEN, '_').replace(/\s+/g, ' ').trim();
  // Windows drops trailing dots and spaces, which would change the extension it sees.
  name = trimTrailingDotsAndSpaces(name);
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
