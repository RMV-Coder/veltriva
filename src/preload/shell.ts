// Shell preload (ADR-0005 §4). It runs sandboxed with context isolation, so it can only use
// `electron`'s renderer modules. It builds a frozen `window.veltriva` from the IPC contract:
// one method per allow-listed command and an `on` for allow-listed events. It never exposes
// `ipcRenderer`, the IPC event object or a generic send. Web pages (tabs) never get a preload.
import { contextBridge, ipcRenderer } from 'electron';

import { COMMAND_NAMES, EVENT_CHANNEL, INVOKE_CHANNEL, isEventName } from '../shared/contracts/ipc';
import type { EventName } from '../shared/contracts/ipc';
import { SHELL_API_KEY } from '../shared/shell-api';
import type { ShellApi } from '../shared/shell-api';

type Listener = (payload: unknown) => void;

const listeners = new Map<EventName, Set<Listener>>();
let receiving = false;

function receiveEvents(): void {
  if (receiving) {
    return;
  }
  receiving = true;
  // The IPC event object stays here; listeners only ever see the payload.
  ipcRenderer.on(EVENT_CHANNEL, (_event, name: unknown, payload: unknown) => {
    if (!isEventName(name)) {
      return;
    }
    for (const listener of listeners.get(name) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`A listener for ${name} threw:`, error);
      }
    }
  });
}

function on(event: unknown, listener: unknown): () => void {
  if (!isEventName(event)) {
    throw new TypeError('Unknown event name');
  }
  if (typeof listener !== 'function') {
    throw new TypeError('The listener must be a function');
  }
  receiveEvents();
  const forEvent = listeners.get(event) ?? new Set<Listener>();
  listeners.set(event, forEvent);
  const subscribed = listener as Listener;
  forEvent.add(subscribed);
  return () => {
    forEvent.delete(subscribed);
  };
}

function buildCommands(): Record<string, Readonly<Record<string, (input?: unknown) => unknown>>> {
  const namespaces: Record<string, Record<string, (input?: unknown) => unknown>> = {};
  for (const command of COMMAND_NAMES) {
    const [namespace = '', method = ''] = command.split('.');
    const target = (namespaces[namespace] ??= {});
    // Main validates the input against the command's strict schema; nothing is trusted here.
    target[method] = (input?: unknown) =>
      ipcRenderer.invoke(INVOKE_CHANNEL, command, input === undefined ? {} : input);
  }
  return Object.fromEntries(
    Object.entries(namespaces).map(([namespace, methods]) => [namespace, Object.freeze(methods)]),
  );
}

const api = Object.freeze({ ...buildCommands(), on }) as unknown as ShellApi;

contextBridge.exposeInMainWorld(SHELL_API_KEY, api);
