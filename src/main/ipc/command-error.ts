// A handler throws CommandError to answer with a specific code: `not_found` for a closed tab's id,
// say, or `invalid_input` for a settings change that would make an invalid document (M5.1).
// IpcRouter maps it to `{ ok: false, code }`; any other error becomes `internal`.
import type { ErrorCode } from '../../shared/contracts/ipc';

export class CommandError extends Error {
  readonly code: Extract<ErrorCode, 'not_found' | 'invalid_input'>;

  constructor(code: Extract<ErrorCode, 'not_found' | 'invalid_input'>) {
    super(code);
    this.name = 'CommandError';
    this.code = code;
  }
}
