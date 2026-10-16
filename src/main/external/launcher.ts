// The one place Veltriva hands a URL to another app. Only the external-protocol guard calls it,
// with a URL it parsed, escaped and length-capped (./protocol-guard.ts). Test builds use a
// recording launcher instead (src/main/testing/external-launches.ts), so no real app ever opens.
import { shell } from 'electron';

import type { Launcher } from './protocol-guard';

export const systemLauncher: Launcher = (url) => shell.openExternal(url);
