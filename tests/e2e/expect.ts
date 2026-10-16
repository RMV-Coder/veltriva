// `expect` for the M1.3a specs: the same assertions, web-first retries and `expect.poll`, with a
// longer default timeout than playwright.config.ts gives the older specs (10 s). The machine that
// runs the suite is often busy with other work, and these specs wait for the shell to render a
// snapshot main sent, for pages to load and for tabs to settle. A slow run is not a failure; an
// assertion that never becomes true still fails, only 10 s later.
import { expect as baseExpect } from '@playwright/test';

export const expect = baseExpect.configure({ timeout: 20_000 });
