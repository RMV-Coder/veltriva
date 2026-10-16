import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APP_USER_MODEL_ID,
  EXECUTABLE_NAME,
  PRODUCT_NAME,
} from '../../shared/constants/app-identity';

// The app identity is repeated in package.json and electron-builder.yml, which can't import
// TypeScript. A silent drift would ship a build with a different AppUserModelID or name.

const repoFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8');

/** Reads a top-level `key: value` scalar. electron-builder.yml keeps these unquoted. */
function topLevelScalar(yaml: string, key: string): string | undefined {
  return new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(yaml)?.[1];
}

describe('app identity (ADR-0007 §6)', () => {
  const pkg = JSON.parse(repoFile('package.json')) as Record<string, unknown>;
  const builder = repoFile('electron-builder.yml');

  it('package.json productName matches', () => {
    expect(pkg.productName).toBe(PRODUCT_NAME);
  });

  it('electron-builder appId is the AppUserModelID', () => {
    expect(topLevelScalar(builder, 'appId')).toBe(APP_USER_MODEL_ID);
  });

  it('electron-builder productName matches', () => {
    expect(topLevelScalar(builder, 'productName')).toBe(PRODUCT_NAME);
  });

  it('electron-builder executableName matches', () => {
    expect(topLevelScalar(builder, 'executableName')).toBe(EXECUTABLE_NAME);
  });
});
