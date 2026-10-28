// The license texts the About page shows (M6.3): Veltriva's own and THIRD_PARTY_NOTICES.txt. A
// packaged app has them in its resources (electron-builder.yml `extraResources`); an unpackaged
// build reads them from the repository, where scripts/third-party-notices.mjs keeps the notices.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';

export interface Licenses {
  readonly license: string;
  readonly notices: string;
}

const MAX_LICENSE_CHARS = 20_000;
const MAX_NOTICES_CHARS = 2_000_000;

async function readText(path: string, max: number): Promise<string> {
  const text = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

export async function readLicenses(): Promise<Licenses> {
  const [license, notices] = app.isPackaged
    ? [
        join(process.resourcesPath, 'LICENSE.txt'),
        join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt'),
      ]
    : [join(app.getAppPath(), 'LICENSE'), join(app.getAppPath(), 'THIRD_PARTY_NOTICES.txt')];
  return {
    license: await readText(license, MAX_LICENSE_CHARS),
    notices: await readText(notices, MAX_NOTICES_CHARS),
  };
}
