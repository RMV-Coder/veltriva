// A test-only preload for ipc-sender.spec.ts. It gives a *tab* what a tab never has in the real
// app: a way to send on the shell's IPC channels. The spec then proves IpcRouter refuses it and
// that main never sends it shell events.
//
// It is sandboxed-compatible plain CommonJS: a sandboxed preload can only require('electron').
// The channel names are the ones in src/shared/contracts/ipc.ts, repeated here because a sandboxed
// preload can't import that module. If they drift, ipc-sender.spec.ts fails: the invoke gets no
// handler, and its control event never arrives.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNEL = 'veltriva:invoke';
const EVENT_CHANNEL = 'veltriva:event';

/** Every event received on the shell's event channel, as plain data. */
const received = [];
ipcRenderer.on(EVENT_CHANNEL, (_event, name, payload) => {
  received.push({ name, payload });
});

contextBridge.exposeInMainWorld('__ipcProbe', {
  /** Sends `veltriva:invoke` exactly as the shell preload does. Resolves to main's reply. */
  invoke: (command, input) => ipcRenderer.invoke(INVOKE_CHANNEL, command, input),
  /** A copy of every event received so far. */
  events: () => received.slice(),
});
