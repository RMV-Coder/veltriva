// The scripts main runs inside a tab's page, always in our own isolated world (assessment §4.9,
// §4.10, spikes S2 and S3). The page can't see their globals, can't replace the DOM methods they
// call, and can't forge what they record. None runs with `userGesture`: that would grant the page
// user activation, which the discard reads as "the user was here" (S3).
//
// These strings are page code: plain JavaScript, no imports, nothing from main.

/**
 * Our isolated world: the page's own is 0 and Electron's is 999. One world for all of main's
 * scripts, so the probe reads what the tracker recorded.
 */
export const BROWSER_WORLD_ID = 1001;

/** Leaves HTML fullscreen in our world, so a page that replaced the method can't trap the user. */
export const EXIT_FULLSCREEN = 'document.fullscreenElement ? document.exitFullscreen() : undefined';

/**
 * The trusted-input tracker (S3 change 5), installed when each document's DOM is ready. A passive
 * capture listener records the fields the user typed into (trusted `input` and `change` events),
 * and the text a `contenteditable` region held before its first edit. The probe then asks whether
 * each still holds what was typed, which catches the React-style inputs and blurred editors that a
 * value check misses. Bounded: the 64 most recent fields. A page that stops `input` at the window
 * in the capture phase before this runs hides its input from it (S3); the value check remains.
 */
export const INSTALL_INPUT_TRACKER = `(() => {
  if (globalThis.__veltrivaInputTracker !== undefined) {
    return true;
  }
  const edited = [];
  globalThis.__veltrivaInputTracker = { edited };
  const editingHost = (node) => {
    let element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    if (element === null || !element.isContentEditable) {
      return null;
    }
    while (element.parentElement !== null && element.parentElement.isContentEditable) {
      element = element.parentElement;
    }
    return element;
  };
  const track = (element, before) => {
    for (const entry of edited) {
      if (entry.element === element) {
        return;
      }
    }
    if (edited.length >= 64) {
      edited.shift();
    }
    edited.push({ element, before });
  };
  addEventListener('beforeinput', (event) => {
    if (!event.isTrusted) {
      return;
    }
    const host = editingHost(event.target);
    if (host !== null) {
      track(host, host.textContent);
    }
  }, true);
  const onInput = (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      track(target, null);
      return;
    }
    const host = editingHost(target);
    if (host !== null) {
      track(host, null);
    }
  };
  addEventListener('input', onInput, true);
  addEventListener('change', onInput, true);
  return true;
})()`;

/**
 * The discard probe (§4.9 step 3). It reports, without changing anything the page can observe:
 *   - changedFields: fields whose value differs from their default (input, textarea, select,
 *     checkbox, radio, a chosen file);
 *   - editedFields: fields the tracker saw the user type into that still hold text;
 *   - focusedEditable: a focused contenteditable (soft: a plain click sets it, S3);
 *   - sensitive: password or payment fields on the page;
 *   - hasBeenActive: whether the user activated the page since it loaded (S3);
 * then flushes the page state with `history.replaceState(history.state, '')`, so the snapshot
 * that follows has fresh scroll and form values (S2). That causes one same-document commit, which
 * the runtime drops: it is neither a navigation nor engagement.
 */
export const PROBE = `(() => {
  const ignoredTypes = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
  const selectChanged = (select) => {
    if (select.multiple) {
      for (const option of select.options) {
        if (option.selected !== option.defaultSelected) {
          return true;
        }
      }
      return false;
    }
    let initial = -1;
    for (let index = 0; index < select.options.length; index += 1) {
      if (select.options[index].defaultSelected) {
        initial = index;
      }
    }
    if (initial === -1 && select.size <= 1) {
      for (let index = 0; index < select.options.length; index += 1) {
        if (!select.options[index].disabled) {
          initial = index;
          break;
        }
      }
    }
    return select.selectedIndex !== initial;
  };
  let changedFields = 0;
  for (const field of document.querySelectorAll('input, textarea, select')) {
    if (field instanceof HTMLSelectElement) {
      if (selectChanged(field)) {
        changedFields += 1;
      }
    } else if (field instanceof HTMLTextAreaElement) {
      if (field.value !== field.defaultValue) {
        changedFields += 1;
      }
    } else if (field instanceof HTMLInputElement) {
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked !== field.defaultChecked) {
          changedFields += 1;
        }
      } else if (field.type === 'file') {
        if (field.files !== null && field.files.length > 0) {
          changedFields += 1;
        }
      } else if (!ignoredTypes.has(field.type) && field.value !== field.defaultValue) {
        changedFields += 1;
      }
    }
  }
  let editedFields = 0;
  const tracker = globalThis.__veltrivaInputTracker;
  if (tracker !== undefined) {
    for (const { element, before } of tracker.edited) {
      if (!element.isConnected) {
        continue;
      }
      if (element instanceof HTMLInputElement) {
        if (element.type !== 'checkbox' && element.type !== 'radio' && element.value !== '') {
          editedFields += 1;
        }
      } else if (element instanceof HTMLTextAreaElement) {
        if (element.value !== '') {
          editedFields += 1;
        }
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        const text = element.textContent;
        if (before === null ? text.trim() !== '' : text !== before) {
          editedFields += 1;
        }
      }
    }
  }
  const active = document.activeElement;
  const focusedEditable = active instanceof HTMLElement && active.isContentEditable;
  const sensitive =
    document.querySelector('input[type=password], input[autocomplete^="cc-"]') !== null;
  const activation = navigator.userActivation;
  const hasBeenActive = activation === undefined ? true : activation.hasBeenActive;
  let flushed = false;
  try {
    history.replaceState(history.state, '');
    flushed = true;
  } catch {
    flushed = false;
  }
  return { changedFields, editedFields, focusedEditable, sensitive, hasBeenActive, flushed };
})()`;
