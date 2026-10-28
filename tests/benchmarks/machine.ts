// What the benchmarks record about the machine they ran on (§9.3): the hardware, Windows, power and
// Defender once per file, and how loaded the machine was at each run's start, because this laptop
// is shared with other work and its numbers mean little without that.
import { execFileSync } from 'node:child_process';
import { cpus, freemem, release, totalmem } from 'node:os';

/** A read-only PowerShell query; '' when it fails (the field is then reported unknown). */
export function powershell(command: string): string {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    }).trim();
  } catch {
    return '';
  }
}

export function environment() {
  return {
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryMb: Math.round(totalmem() / 2 ** 20),
    windows:
      powershell(
        '$o = Get-CimInstance Win32_OperatingSystem; "$($o.Caption) $($o.Version) build $($o.BuildNumber)"',
      ) || `Windows ${release()}`,
    // BatteryStatus 2 is "on AC"; a desktop has no battery.
    power:
      powershell(
        '$b = Get-CimInstance Win32_Battery; if ($null -eq $b) { "no battery" } elseif ($b.BatteryStatus -eq 2) { "AC power" } else { "battery (status $($b.BatteryStatus))" }',
      ) || 'unknown',
    powerPlan: powershell('powercfg /getactivescheme') || 'unknown',
    defenderRealTime:
      powershell('(Get-MpComputerStatus).RealTimeProtectionEnabled') || 'unknown (not readable)',
    electron: 'see package.json',
  };
}

export interface Load {
  readonly freeMb: number;
  /** Committed memory against the commit limit, in MB; null when Windows wouldn't say. */
  readonly commitMb: number | null;
  readonly commitLimitMb: number | null;
  /** Windows' average processor load at that moment, in percent; null when unknown. */
  readonly cpuPercent: number | null;
}

/** The machine's largest processes by working set, named, for the record of what else ran. */
export function busiestProcesses(count = 10): readonly { name: string; workingSetMb: number }[] {
  return powershell(
    `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${String(count)} | ForEach-Object { "$($_.ProcessName)=$([math]::Round($_.WorkingSet64 / 1MB))" }`,
  )
    .split(/\r?\n/)
    .map((line) => line.trim().split('='))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '')
    .map(([name, mb]) => ({ name, workingSetMb: Number(mb) }));
}

/** How busy the machine is right now. */
export function currentLoad(): Load {
  const numbers = powershell(
    '$o = Get-CimInstance Win32_OperatingSystem; $p = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; "$($o.TotalVirtualMemorySize - $o.FreeVirtualMemory) $($o.TotalVirtualMemorySize) $p"',
  )
    .split(/\s+/)
    .map(Number);
  const [usedKb, limitKb, cpu] = numbers;
  const known = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value);
  return {
    freeMb: Math.round(freemem() / 2 ** 20),
    commitMb: known(usedKb) ? Math.round(usedKb / 1024) : null,
    commitLimitMb: known(limitKb) ? Math.round(limitKb / 1024) : null,
    cpuPercent: known(cpu) ? cpu : null,
  };
}
