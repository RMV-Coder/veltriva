// Types for ./release-notes.mjs, which scripts/release.mjs and its unit tests import.

export type AreaKey =
  | 'browsing'
  | 'lifecycle'
  | 'memory'
  | 'privacy'
  | 'security'
  | 'accessibility'
  | 'release'
  | 'platform'
  | 'development';

export interface Commit {
  readonly sha: string;
  readonly subject: string;
  readonly body?: string;
  readonly paths: readonly string[];
}

export const AREAS: readonly { readonly key: AreaKey; readonly title: string }[];

export function areaOfPath(path: string): AreaKey | undefined;
export function areaOf(commit: Pick<Commit, 'subject' | 'body' | 'paths'>): AreaKey;
export function formatNotes(commits: readonly Commit[], options?: { title?: string }): string;
export function defaultRange(options?: { cwd?: string }): string;
export function commitsIn(range: string, options?: { cwd?: string }): Commit[];
export function releaseNotes(options?: { range?: string; title?: string; cwd?: string }): string;
export function releaseSection(name: string, text: string): string;
export function fillReleasePage(page: string, sections: Readonly<Record<string, string>>): string;
