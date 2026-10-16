// A handler throws CommandError to answer with a specific code (for example, a closed tab's id).
// IpcRouter maps it to `{ ok: false, code }`; any other error becomes `internal`.
import type { ErrorCode } from '../../shared/contracts/ipc';

export class CommandError extends Error {
  readonly code: Extract<ErrorCode, 'not_found'>;

  constructor(code: Extract<ErrorCode, 'not_found'>) {
    super(code);
    this.name = 'CommandError';
    this.code = code;
  }
}
