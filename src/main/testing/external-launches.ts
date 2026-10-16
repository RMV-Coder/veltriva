// Test builds only (behind `import.meta.env.MODE`): the external-protocol guard's launcher, which
// records each URL instead of handing it to Windows, so no E2E run ever opens a real app. The
// test hooks expose the list (`externalLaunches`).
import type { Launcher } from '../external/protocol-guard';

const launches: string[] = [];

export const recordExternalLaunch: Launcher = (url) => {
  launches.push(url);
  return Promise.resolve();
};

export function recordedExternalLaunches(): string[] {
  return [...launches];
}
