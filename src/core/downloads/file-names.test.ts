import { describe, expect, it } from 'vitest';

import {
  MAX_FILE_NAME_LENGTH,
  extensionOf,
  isDangerousFileName,
  sanitizeFileName,
  uniqueFileName,
} from './file-names';

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['  spaced   out .txt ', 'spaced out .txt'],
    ['../../Windows/System32/evil.dll', '_.._Windows_System32_evil.dll'],
    ['..\\..\\startup.bat', '_.._startup.bat'],
    ['C:\\Users\\x\\a.txt', 'C__Users_x_a.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['trailing dots...', 'trailing dots'],
    ['invoice.pdf. . .', 'invoice.pdf'],
    ['.hidden', 'hidden'],
    ['..', 'download'],
    ['', 'download'],
    ['   ', 'download'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['NUL.tar.gz', '_NUL.tar.gz'],
    ['lpt1', '_lpt1'],
    ['console.log', 'console.log'],
    ['tab\there.txt', 'tabhere.txt'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected);
  });

  it('removes a right-to-left override, so the real extension shows', () => {
    // "invoice‮fdp.exe" displays as "invoiceexe.pdf".
    const name = sanitizeFileName('invoice\u202efdp.exe');
    expect(name).toBe('invoicefdp.exe');
    expect(isDangerousFileName(name)).toBe(true);
  });

  it('keeps the extension when it shortens a long name', () => {
    const name = sanitizeFileName(`${'a'.repeat(400)}.exe`);
    expect(name.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(name.endsWith('.exe')).toBe(true);
    const emoji = sanitizeFileName(`x${'😀'.repeat(200)}`);
    expect(emoji.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    // Well formed: encodeURIComponent throws on half a surrogate pair.
    expect(() => encodeURIComponent(emoji)).not.toThrow();
  });
});

describe('uniqueFileName', () => {
  it('numbers like Chrome when the name is taken', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf']);
    expect(uniqueFileName('report.pdf', (name) => taken.has(name))).toBe('report (2).pdf');
    expect(uniqueFileName('notes', (name) => name === 'notes')).toBe('notes (1)');
    expect(uniqueFileName('free.txt', () => false)).toBe('free.txt');
  });

  it('takes the first free number', () => {
    expect(uniqueFileName('x.txt', (name) => !name.startsWith('x ('))).toBe('x (1).txt');
  });
});

describe('isDangerousFileName and extensionOf', () => {
  it.each([
    ['setup.exe', true],
    ['SETUP.EXE', true],
    ['invoice.pdf.exe', true],
    ['script.ps1', true],
    ['shortcut.lnk', true],
    ['disk.iso', true],
    ['page.hta', true],
    ['report.pdf', false],
    ['archive.zip', false],
    ['exe', false],
    ['photo.exe.jpg', false],
  ])('%s → %s', (name, dangerous) => {
    expect(isDangerousFileName(name)).toBe(dangerous);
  });

  it('reads the last extension only', () => {
    expect(extensionOf('a.tar.gz')).toBe('gz');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('dot.')).toBe('');
  });
});
