// A tiny, valid, one-page PDF built in code, so the cross-reference table is correct by
// construction (every offset is measured, never hand-counted). The page says "Veltriva PDF fixture".

/** The PDF header, then the five objects a one-page document needs. Everything is ASCII. */
export function buildSamplePdf(): Buffer {
  const content = 'BT /F1 24 Tf 20 100 Td (Veltriva PDF fixture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  // The second line is a comment of four bytes above 127, which tells tools the file is binary.
  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });

  // Each xref entry is exactly 20 bytes: a 10-digit offset, a 5-digit generation, a flag, " \n".
  const xrefOffset = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`);
  body +=
    `xref\n0 ${String(objects.length + 1)}\n` +
    '0000000000 65535 f \n' +
    entries.join('') +
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;

  // 'latin1' maps each character to the one byte of the same value, so offsets stay byte offsets.
  return Buffer.from(body, 'latin1');
}
