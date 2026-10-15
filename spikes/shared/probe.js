'use strict';
// The unsaved-input probe from assessment §4.10, as source text for
// webContents.executeJavaScriptInIsolatedWorld(worldId, [{ code: PROBE_SOURCE }]).
// It runs in an isolated world: it sees the DOM but not the page's JavaScript objects.

const PROBE_WORLD_ID = 1001;

const PROBE_SOURCE = `(() => {
  const skipTypes = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);
  const dirty = [];
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const id = el.id || el.name || el.tagName.toLowerCase();
    if (el instanceof HTMLSelectElement) {
      for (const option of el.options) {
        if (option.selected !== option.defaultSelected) { dirty.push(id); break; }
      }
      continue;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) dirty.push(id);
      continue;
    }
    if (skipTypes.has(el.type)) continue;
    if (el.value !== el.defaultValue) dirty.push(id);
  }
  const active = document.activeElement;
  return {
    dirty,
    focusedEditable: Boolean(active && (active.isContentEditable || active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !skipTypes.has(active.type)))),
    sensitive: Boolean(document.querySelector('input[type=password], input[autocomplete^="cc-"]')),
    hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
  };
})()`;

module.exports = { PROBE_SOURCE, PROBE_WORLD_ID };
