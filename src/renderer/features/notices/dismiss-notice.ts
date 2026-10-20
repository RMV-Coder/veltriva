// The notice strip's one command. It behaves like the wrappers in ../../state/commands.ts: it
// sends the intent and waits for the next workspace snapshot to change what is shown, never
// resolves to an error, and logs a failure by name and code only.

/** Removes a notice from the strip. Resolves to false if main refused or couldn't be reached. */
export async function dismissNotice(noticeId: string): Promise<boolean> {
  try {
    const result = await window.veltriva.notices.dismiss({ noticeId });
    if (!result.ok) {
      // `not_found` is a notice that was already gone: another click, or the list changed.
      console.warn(`veltriva: notices.dismiss failed (${result.code})`);
    }
    return result.ok;
  } catch (error) {
    console.warn('veltriva: notices.dismiss could not reach the main process', error);
    return false;
  }
}
