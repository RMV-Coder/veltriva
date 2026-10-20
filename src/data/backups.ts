// The backup folder (assessment §5.6): pre-upgrade copies and daily copies, side by side, each
// named with the UTC time it was taken. Recovery picks the newest one of either kind that passes
// a check (./startup.ts).
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type BackupKind = 'upgrade' | 'daily';

export interface BackupFile {
  readonly name: string;
  readonly kind: BackupKind;
  /** When it was taken, from its name. */
  readonly takenAt: number;
}

/** Daily and pre-upgrade backups kept, each kind on its own. */
export const KEPT_BACKUPS = 3;

/** `2026-10-21T08-30-15Z`: ISO 8601 to the second, with `-` for `:` (Windows names). */
const STAMP = /(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)Z/;
const NAMES: readonly (readonly [BackupKind, RegExp])[] = [
  ['upgrade', new RegExp(`^veltriva-v\\d+-before-v\\d+-(${STAMP.source})\\.db$`)],
  ['daily', new RegExp(`^veltriva-daily-(${STAMP.source})\\.db$`)],
];

export function backupStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
}

export function upgradeBackupName(fromVersion: number, toVersion: number, at: number): string {
  return `veltriva-v${String(fromVersion)}-before-v${String(toVersion)}-${backupStamp(at)}.db`;
}

export function dailyBackupName(at: number): string {
  return `veltriva-daily-${backupStamp(at)}.db`;
}

/** Every backup in the folder, newest first. Other files are ignored. A missing folder is empty. */
export function listBackups(backupDir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  const backups: BackupFile[] = [];
  for (const name of names) {
    for (const [kind, pattern] of NAMES) {
      const match = pattern.exec(name);
      const stamp = match?.[1];
      if (stamp !== undefined) {
        const [, day, hours, minutes, seconds] = STAMP.exec(stamp) ?? [];
        const takenAt = Date.parse(
          `${day ?? ''}T${hours ?? ''}:${minutes ?? ''}:${seconds ?? ''}Z`,
        );
        if (Number.isFinite(takenAt)) {
          backups.push({ name, kind, takenAt });
        }
      }
    }
  }
  return backups.sort((a, b) => b.takenAt - a.takenAt || b.name.localeCompare(a.name));
}

/** Keeps the newest KEPT_BACKUPS of one kind. */
export function pruneBackups(backupDir: string, kind: BackupKind): void {
  const ofKind = listBackups(backupDir).filter((backup) => backup.kind === kind);
  for (const { name } of ofKind.slice(KEPT_BACKUPS)) {
    rmSync(join(backupDir, name), { force: true });
  }
}
