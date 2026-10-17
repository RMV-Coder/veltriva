import { describe, expect, it } from 'vitest';

import {
  DANGEROUS_FILE_WARNING,
  DOWNLOAD_ACTION_LABELS,
  MAX_FILE_NAME_CHARS,
  downloadActions,
  downloadNameText,
  downloadProgress,
  downloadSiteText,
  downloadStatusText,
  downloadsButtonLabel,
  formatBytes,
  isActive,
  needsDecision,
  progressPercent,
  summarizeDownloads,
  truncateFileName,
} from './download-display';
import type { Download } from './download-display';

const MB = 1024 * 1024;

function download(overrides: Partial<Download> = {}): Download {
  return {
    id: 'download-1',
    fileName: 'report.pdf',
    state: 'progressing',
    receivedBytes: 0,
    totalBytes: 0,
    dangerous: false,
    confirmed: true,
    canResume: false,
    site: 'example.test',
    ...overrides,
  };
}

describe('formatBytes', () => {
  it('says bytes under a kilobyte, with no decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('uses one decimal below 10 and none from 10 up', () => {
    expect(formatBytes(3.2 * MB)).toBe('3.2 MB');
    expect(formatBytes(10 * MB)).toBe('10 MB');
    expect(formatBytes(12.6 * MB)).toBe('13 MB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
  });

  it('never ends in ".0"', () => {
    expect(formatBytes(3 * MB)).toBe('3 MB');
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('moves up a unit when rounding reaches 1024', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1 GB');
    // 1023.5 KB is 1024 after rounding, never "1024 KB".
    expect(formatBytes(1023.5 * 1024)).toBe('1 MB');
  });

  it('rounds up into 10 without writing "10.0"', () => {
    expect(formatBytes(9.96 * MB)).toBe('10 MB');
  });

  it('goes up to terabytes and stops there', () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2 TB');
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB');
  });

  it('copes with values that are not sizes', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('progressPercent', () => {
  it('is the share received, rounded down', () => {
    expect(progressPercent({ receivedBytes: 0, totalBytes: 100 })).toBe(0);
    expect(progressPercent({ receivedBytes: 32, totalBytes: 100 })).toBe(32);
    expect(progressPercent({ receivedBytes: 999, totalBytes: 1000 })).toBe(99);
    expect(progressPercent({ receivedBytes: 100, totalBytes: 100 })).toBe(100);
  });

  it('is null while the size is unknown', () => {
    expect(progressPercent({ receivedBytes: 500, totalBytes: 0 })).toBeNull();
  });

  it('stays between 0 and 100', () => {
    expect(progressPercent({ receivedBytes: 300, totalBytes: 100 })).toBe(100);
    expect(progressPercent({ receivedBytes: -5, totalBytes: 100 })).toBe(0);
  });
});

describe('truncateFileName', () => {
  it('leaves a name that fits', () => {
    expect(truncateFileName('report.pdf')).toBe('report.pdf');
    const exact = `${'a'.repeat(MAX_FILE_NAME_CHARS - 4)}.pdf`;
    expect(truncateFileName(exact)).toBe(exact);
  });

  it('cuts in the middle and keeps the extension', () => {
    const name = `${'very-long-'.repeat(8)}name.pdf`;
    const shown = truncateFileName(name);
    expect(Array.from(shown)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(shown.startsWith('very-long-')).toBe(true);
    expect(shown.endsWith('name.pdf')).toBe(true);
    expect(shown).toContain('…');
  });

  it('keeps a few characters of the end of the name before the extension', () => {
    const shown = truncateFileName(`${'a'.repeat(100)}-final-v2.zip`, 30);
    expect(Array.from(shown)).toHaveLength(30);
    expect(shown.endsWith('-final-v2.zip')).toBe(false); // only a third of the room, not all of it
    expect(shown).toMatch(/…[^…]+\.zip$/);
    expect(shown.startsWith('aaaa')).toBe(true);
  });

  it('puts the ellipsis exactly once', () => {
    expect(truncateFileName('x'.repeat(200) + '.exe').match(/…/g)).toHaveLength(1);
  });

  it('keeps only the last extension of a double one', () => {
    const shown = truncateFileName(`${'b'.repeat(80)}.tar.gz`, 40);
    expect(Array.from(shown)).toHaveLength(40);
    expect(shown.endsWith('.gz')).toBe(true);
  });

  it('cuts a name with no extension in the middle too', () => {
    const shown = truncateFileName('a'.repeat(30) + 'b'.repeat(30), 20);
    expect(Array.from(shown)).toHaveLength(20);
    expect(shown.startsWith('aaaa')).toBe(true);
    expect(shown.endsWith('bbbb')).toBe(true);
    expect(shown).toContain('…');
  });

  it('does not treat a leading dot as an extension', () => {
    const shown = truncateFileName(`.${'c'.repeat(80)}`, 20);
    expect(Array.from(shown)).toHaveLength(20);
    expect(shown.startsWith('.cccc')).toBe(true);
  });

  it('does not keep a long stretch of text after the last dot as an extension', () => {
    const shown = truncateFileName(`${'d'.repeat(40)}.${'e'.repeat(40)}`, 20);
    expect(Array.from(shown)).toHaveLength(20);
    expect(shown.endsWith('eeee')).toBe(true);
  });

  it('counts characters, not UTF-16 units, so a surrogate pair is never split', () => {
    const shown = truncateFileName(`${'😀'.repeat(60)}.png`, 20);
    expect(Array.from(shown)).toHaveLength(20);
    expect(shown).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(shown).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(shown.endsWith('.png')).toBe(true);
  });

  it('copes with a limit too small to show much', () => {
    expect(truncateFileName('abcdef', 1)).toBe('…');
    expect(truncateFileName('abcdef', 0)).toBe('');
    const tiny = truncateFileName('abcdefghij.pdf', 5);
    expect(Array.from(tiny)).toHaveLength(5);
  });
});

describe('downloadNameText', () => {
  it('shows a short name as it is, with no tooltip', () => {
    expect(downloadNameText('report.pdf')).toEqual({ text: 'report.pdf' });
  });

  it('keeps the whole of a shortened name for the tooltip', () => {
    const name = `${'q'.repeat(150)}.pdf`;
    const shown = downloadNameText(name);
    expect(Array.from(shown.text)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(shown.text.endsWith('.pdf')).toBe(true);
    expect(shown.full).toBe(name);
  });

  it('removes bidi overrides, so a name can not pose as another type', () => {
    // U+202E reverses what follows: "invoice‮fdp.exe" reads as "invoiceexe.pdf".
    expect(downloadNameText('invoice‮fdp.exe').text).toBe('invoice fdp.exe');
  });

  it('removes controls and zero-width marks', () => {
    expect(downloadNameText('a\u0000b\nc​d.txt').text).toBe('a b c d.txt');
  });

  it('falls back to a plain word when no text is left', () => {
    expect(downloadNameText('‮​').text).toBe('Download');
    expect(downloadNameText('').text).toBe('Download');
  });
});

describe('downloadSiteText', () => {
  it('shows the site', () => {
    expect(downloadSiteText('files.example.test')).toEqual({ text: 'files.example.test' });
  });

  it('is null when Veltriva started the download', () => {
    expect(downloadSiteText('')).toBeNull();
    expect(downloadSiteText('‮')).toBeNull();
  });

  it('cuts a long site at the start, so the end of the host stays', () => {
    const site = `${'a'.repeat(120)}.evil.example`;
    const shown = downloadSiteText(site);
    expect(shown?.text.startsWith('…')).toBe(true);
    expect(shown?.text.endsWith('.evil.example')).toBe(true);
    expect(shown?.full).toBe(site);
  });
});

describe('downloadStatusText', () => {
  it('says how far a download is', () => {
    expect(downloadStatusText(download({ receivedBytes: 3.2 * MB, totalBytes: 10 * MB }))).toBe(
      '3.2 MB of 10 MB',
    );
  });

  it('says only what arrived when the size is unknown', () => {
    expect(downloadStatusText(download({ receivedBytes: 2 * MB }))).toBe('2 MB');
  });

  it('says it is starting before anything arrives', () => {
    expect(downloadStatusText(download())).toBe('Starting…');
  });

  it('says "0 B of" when the size is known but nothing has arrived', () => {
    expect(downloadStatusText(download({ totalBytes: 10 * MB }))).toBe('0 B of 10 MB');
  });

  it('says a paused download is paused, and how far it got', () => {
    expect(
      downloadStatusText(
        download({ state: 'paused', receivedBytes: 3.2 * MB, totalBytes: 10 * MB }),
      ),
    ).toBe('Paused, 3.2 MB of 10 MB');
    expect(downloadStatusText(download({ state: 'paused' }))).toBe('Paused');
  });

  it('says a finished download is done, with its size', () => {
    expect(
      downloadStatusText(
        download({ state: 'completed', receivedBytes: 10 * MB, totalBytes: 10 * MB }),
      ),
    ).toBe('Done, 10 MB');
  });

  it('uses what arrived when a finished download never had a size', () => {
    expect(downloadStatusText(download({ state: 'completed', receivedBytes: 4 * MB }))).toBe(
      'Done, 4 MB',
    );
    expect(downloadStatusText(download({ state: 'completed' }))).toBe('Done');
  });

  it('says Cancelled and Failed', () => {
    expect(downloadStatusText(download({ state: 'cancelled' }))).toBe('Cancelled');
    expect(downloadStatusText(download({ state: 'interrupted' }))).toBe('Failed');
  });
});

describe('downloadActions', () => {
  it('offers Pause and Cancel while it downloads', () => {
    expect(downloadActions(download())).toEqual(['pause', 'cancel']);
  });

  it('offers Resume and Cancel while it is paused', () => {
    expect(downloadActions(download({ state: 'paused' }))).toEqual(['resume', 'cancel']);
  });

  it('offers Open, Show in folder and Remove once it is done', () => {
    expect(downloadActions(download({ state: 'completed' }))).toEqual(['open', 'show', 'remove']);
  });

  it('offers only Remove after a cancellation', () => {
    expect(downloadActions(download({ state: 'cancelled' }))).toEqual(['remove']);
  });

  it('offers Resume after a failure only when Chromium can resume it', () => {
    expect(downloadActions(download({ state: 'interrupted', canResume: true }))).toEqual([
      'resume',
      'remove',
    ]);
    expect(downloadActions(download({ state: 'interrupted', canResume: false }))).toEqual([
      'remove',
    ]);
  });

  describe('a dangerous file that was not kept', () => {
    const unkept = { dangerous: true, confirmed: false } as const;

    it('offers Discard and Keep once it is done, and neither Open nor Remove', () => {
      const actions = downloadActions(download({ ...unkept, state: 'completed' }));
      expect(actions).toEqual(['discard', 'keep']);
      expect(actions).not.toContain('open');
      expect(actions).not.toContain('show');
      expect(actions).not.toContain('remove');
    });

    it('offers Discard, but not Keep, while it downloads', () => {
      expect(downloadActions(download({ ...unkept }))).toEqual(['pause', 'cancel', 'discard']);
      expect(downloadActions(download({ ...unkept, state: 'paused' }))).toEqual([
        'resume',
        'cancel',
        'discard',
      ]);
    });

    it('can be removed after a failure, as main allows', () => {
      expect(downloadActions(download({ ...unkept, state: 'interrupted' }))).toEqual(['remove']);
    });
  });

  it('offers Open for a dangerous file that was kept', () => {
    expect(
      downloadActions(download({ dangerous: true, confirmed: true, state: 'completed' })),
    ).toEqual(['open', 'show', 'remove']);
  });

  it('never offers Keep for a file that is not dangerous', () => {
    for (const state of [
      'progressing',
      'paused',
      'completed',
      'cancelled',
      'interrupted',
    ] as const) {
      const actions = downloadActions(download({ state, canResume: true }));
      expect(actions).not.toContain('keep');
      expect(actions).not.toContain('discard');
    }
  });

  it('has a label for every action', () => {
    expect(DOWNLOAD_ACTION_LABELS).toEqual({
      pause: 'Pause',
      resume: 'Resume',
      cancel: 'Cancel',
      open: 'Open',
      show: 'Show in folder',
      keep: 'Keep',
      discard: 'Discard',
      remove: 'Remove',
    });
  });

  it('words the warning as the product does', () => {
    expect(DANGEROUS_FILE_WARNING).toBe('This type of file can harm your computer');
  });
});

describe('downloadProgress', () => {
  it('is a percentage while the size is known', () => {
    expect(downloadProgress(download({ receivedBytes: 25, totalBytes: 100 }))).toEqual({
      kind: 'percent',
      percent: 25,
    });
  });

  it('is indeterminate while the size is unknown', () => {
    expect(downloadProgress(download({ receivedBytes: 25 }))).toEqual({ kind: 'indeterminate' });
  });

  it('is there for a paused download and gone for a finished one', () => {
    expect(
      downloadProgress(download({ state: 'paused', receivedBytes: 1, totalBytes: 2 })),
    ).toEqual({ kind: 'percent', percent: 50 });
    expect(downloadProgress(download({ state: 'completed', totalBytes: 2 }))).toBeNull();
    expect(downloadProgress(download({ state: 'interrupted' }))).toBeNull();
  });
});

describe('isActive and needsDecision', () => {
  it('counts a download as active while it runs or is paused', () => {
    expect(isActive({ state: 'progressing' })).toBe(true);
    expect(isActive({ state: 'paused' })).toBe(true);
    expect(isActive({ state: 'completed' })).toBe(false);
    expect(isActive({ state: 'cancelled' })).toBe(false);
    expect(isActive({ state: 'interrupted' })).toBe(false);
  });

  it('needs a decision only for a finished dangerous file that was not kept', () => {
    const base = { dangerous: true, confirmed: false, state: 'completed' } as const;
    expect(needsDecision(base)).toBe(true);
    expect(needsDecision({ ...base, confirmed: true })).toBe(false);
    expect(needsDecision({ ...base, dangerous: false, confirmed: true })).toBe(false);
    expect(needsDecision({ ...base, state: 'progressing' })).toBe(false);
  });
});

describe('summarizeDownloads', () => {
  it('has nothing to show for an empty list', () => {
    expect(summarizeDownloads([])).toEqual({ count: 0, active: 0, fraction: null, waiting: 0 });
  });

  it('counts the downloads that are not over', () => {
    const summary = summarizeDownloads([
      download({ id: 'download-1', receivedBytes: 1, totalBytes: 4 }),
      download({ id: 'download-2', state: 'paused', receivedBytes: 1, totalBytes: 4 }),
      download({ id: 'download-3', state: 'completed', totalBytes: 9 }),
      download({ id: 'download-4', state: 'cancelled' }),
    ]);
    expect(summary).toMatchObject({ count: 4, active: 2 });
  });

  it('measures progress across the active downloads by bytes', () => {
    const summary = summarizeDownloads([
      download({ receivedBytes: 100, totalBytes: 100 }),
      download({ id: 'download-2', receivedBytes: 0, totalBytes: 300 }),
      download({ id: 'download-3', state: 'completed', receivedBytes: 999, totalBytes: 999 }),
    ]);
    expect(summary.fraction).toBe(0.25);
  });

  it('has no fraction while any active download has no size', () => {
    const summary = summarizeDownloads([
      download({ receivedBytes: 10, totalBytes: 100 }),
      download({ id: 'download-2', receivedBytes: 10 }),
    ]);
    expect(summary.active).toBe(2);
    expect(summary.fraction).toBeNull();
  });

  it('has no fraction when nothing is active', () => {
    expect(
      summarizeDownloads([download({ state: 'completed', totalBytes: 5 })]).fraction,
    ).toBeNull();
  });

  it('never counts more than a download has', () => {
    expect(summarizeDownloads([download({ receivedBytes: 500, totalBytes: 100 })]).fraction).toBe(
      1,
    );
  });

  it('counts the files waiting for a decision', () => {
    const summary = summarizeDownloads([
      download({ id: 'download-1', dangerous: true, confirmed: false, state: 'completed' }),
      download({ id: 'download-2', dangerous: true, confirmed: false, state: 'progressing' }),
      download({ id: 'download-3', dangerous: true, confirmed: true, state: 'completed' }),
    ]);
    expect(summary.waiting).toBe(1);
  });
});

describe('downloadsButtonLabel', () => {
  it('is just "Downloads" when nothing is going on', () => {
    expect(downloadsButtonLabel({ count: 3, active: 0, fraction: null, waiting: 0 })).toBe(
      'Downloads',
    );
  });

  it('says how many are in progress', () => {
    expect(downloadsButtonLabel({ count: 3, active: 2, fraction: 0.5, waiting: 0 })).toBe(
      'Downloads, 2 in progress',
    );
  });

  it('says a file waits for a decision', () => {
    expect(downloadsButtonLabel({ count: 1, active: 0, fraction: null, waiting: 1 })).toBe(
      'Downloads, 1 file waiting for your decision',
    );
    expect(downloadsButtonLabel({ count: 2, active: 1, fraction: null, waiting: 2 })).toBe(
      'Downloads, 1 in progress, 2 files waiting for your decision',
    );
  });
});
