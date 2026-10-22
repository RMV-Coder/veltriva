// Test builds only: whether this launch shows first-run onboarding (M5.1). Every E2E and lifecycle
// launch starts on a new profile, which is a first run; the welcome page appears only when a test
// asks for it with this variable, so the other specs start on a new-tab page as before.
export const TEST_FIRST_RUN_ENV = 'VELTRIVA_TEST_FIRST_RUN';

export function testFirstRun(): boolean {
  return process.env[TEST_FIRST_RUN_ENV] === '1';
}
