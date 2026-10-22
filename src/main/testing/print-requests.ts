// Test builds only (behind `import.meta.env.MODE`): the print path records which tab asked instead
// of opening the system print dialog, which no E2E run could close (M5.0). The test hooks expose
// the list (`printRequests`).
import type { TabId } from '../tabs/tab-manager';

const requests: TabId[] = [];

export function recordPrintRequest(tabId: TabId): void {
  requests.push(tabId);
}

export function recordedPrintRequests(): TabId[] {
  return [...requests];
}
