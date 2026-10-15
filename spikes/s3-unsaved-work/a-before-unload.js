'use strict';
// Part A: webContents.close({ waitForBeforeUnload: true }) and the will-prevent-unload event.
// Fixture: beforeunload.html?mode=always|dirty|never (reports beforeunload/pagehide beacons).

const h = require('../shared/harness');
const L = require('./lib');

const { sleep, record } = h;

async function run(ctx) {
  const { win, fixture, rows, watcher } = ctx;
  const url = (mode) => fixture.url(`/beforeunload.html?mode=${mode}`, 'a.test');
  const data = { scenarios: {}, timing: {} };
  const watcherReady = await watcher.ready();
  data.nativeWindowWatcherReady = watcherReady;

  /** Opens mode=dirty, types `text` into #text with real (sendInputEvent) input and verifies the value. */
  async function openDirtyWithRealInput(text = 'hi', { detachAfterTyping = false } = {}) {
    const tab = await L.openTab(win, url('dirty'));
    const typing = await L.clickAndType(tab.wc, '#text', text);
    const state = await L.evalMain(
      tab.wc,
      `({ value: document.getElementById('text').value, focused: document.activeElement && document.activeElement.id, ` +
        `hasBeenActive: navigator.userActivation.hasBeenActive })`,
    );
    state.inputAttempts = typing.attempts; // >1 means the first attempt was dropped (window had lost OS focus)
    state.inputOk = !typing.failed;
    if (typing.failed) state.inputDiagnostics = { diag: typing.diag, electronProcesses: typing.electronProcesses };
    if (detachAfterTyping) L.detach(win, tab.view);
    return { ...tab, state };
  }

  const newVisibleWindows = (before, during) =>
    Array.isArray(before) && Array.isArray(during) ? during.filter((w) => !before.includes(w)) : null;

  // ---------------------------------------------------------------------------------------
  // A1 + A2: untouched page, mode=always
  // ---------------------------------------------------------------------------------------
  {
    const { view, wc } = await L.openTab(win, url('always'));
    const activationBefore = await L.userActivation(wc);
    const windowsBefore = watcherReady ? await watcher.list() : null;
    const mark = fixture.beacons.length;

    const obs = await L.closeAndObserve(wc, {
      waitForBeforeUnload: true,
      observeMs: 3000,
      midpoint: async () => (watcherReady ? watcher.list() : null),
    });
    const alive = !wc.isDestroyed();
    const after = alive
      ? { title: await L.evalMain(wc, 'document.title'), activation: await L.userActivation(wc) }
      : null;
    await sleep(300);
    const beacons = L.beaconsSince(fixture, mark);
    const windowsDuring = obs.midpointResult;
    data.scenarios.A1 = { activationBefore, obs, after, beacons, windowsBefore, windowsDuring };

    record(rows, 'A1 untouched page, mode=always, close({waitForBeforeUnload}): will-prevent-unload emitted',
      { count: obs.willPreventUnloadCount, atMs: obs.willPreventUnloadAtMs, hasBeenActiveBeforeClose: activationBefore.hasBeenActive },
      obs.willPreventUnloadCount >= 1, 'page had no user input, yet the objection was surfaced');
    record(rows, 'A1 no preventDefault: page still alive 3 s later, no destroyed event',
      { isDestroyedAtEnd: obs.isDestroyedAtEnd, destroyedEventAtMs: obs.destroyedEventAtMs, observedForMs: obs.observedForMs },
      alive && obs.destroyedEventAtMs == null);
    record(rows, 'A1 no modal dialog or new native window appeared',
      { newVisibleWindows: newVisibleWindows(windowsBefore, windowsDuring), before: windowsBefore, during: windowsDuring },
      watcherReady ? (newVisibleWindows(windowsBefore, windowsDuring) ?? []).length === 0 : null,
      'evidence: user32 EnumWindows for this process at 1.5 s into the wait, plus the run was not blocked');
    record(rows, 'A1 beforeunload reached the page; pagehide did not (page stays alive)',
      beacons, beacons.some((b) => b.event === 'beforeunload' && b.objected === 'true') && !beacons.some((b) => b.event === 'pagehide'));
    record(rows, 'A1 side effect: close() granted user activation to the page',
      { before: activationBefore, after: after?.activation, pageResponsive: after?.title },
      after ? activationBefore.hasBeenActive === false && after.activation.hasBeenActive === true : false,
      'a cancelled close attempt permanently flips navigator.userActivation.hasBeenActive');

    // A2: same page, plain close() with no option.
    const mark2 = fixture.beacons.length;
    const plain = await L.closeAndObserve(wc, { waitForBeforeUnload: false, observeMs: 3000 });
    await sleep(1000); // let any teardown beacons arrive
    const beacons2 = L.beaconsSince(fixture, mark2);
    data.scenarios.A2_samePage = { obs: plain, beacons: beacons2 };
    record(rows, 'A2 same page, plain close(): destroyed immediately',
      { isDestroyedRightAfterCall: plain.isDestroyedRightAfterCall, destroyedEventAtMs: plain.destroyedEventAtMs, willPreventUnloadCount: plain.willPreventUnloadCount },
      plain.destroyedEventAtMs != null && plain.willPreventUnloadCount === 0);
    record(rows, 'A2 same page, plain close(): page-side events seen by the fixture server',
      beacons2, null, 'beforeunload is not dispatched by plain close(); see pagehide row');
    L.dispose(win, { view, wc });
  }

  // A2b: fresh untouched page, plain close(), to separate it from A1's side effects.
  {
    const { view, wc } = await L.openTab(win, url('always'));
    const mark = fixture.beacons.length;
    const plain = await L.closeAndObserve(wc, { waitForBeforeUnload: false, observeMs: 3000 });
    await sleep(1000);
    const beacons = L.beaconsSince(fixture, mark);
    data.scenarios.A2_freshPage = { obs: plain, beacons };
    record(rows, 'A2b fresh untouched page, plain close(): destroyed, beacons',
      { destroyedEventAtMs: plain.destroyedEventAtMs, isDestroyedRightAfterCall: plain.isDestroyedRightAfterCall, beacons },
      plain.destroyedEventAtMs != null);
    L.dispose(win, { view, wc });
  }

  // A2c: did the page-side handlers run at all? Beacons can be lost in teardown, so also record into
  // localStorage (same origin, same in-memory session) and read it back from a new page.
  {
    // Each handler writes localStorage, sends a beacon and logs to the console, so any one channel can prove it ran.
    const install = `(() => { for (const t of ['beforeunload', 'pagehide', 'unload', 'visibilitychange']) addEventListener(t, () => {
      try { localStorage.setItem('s3-log-' + t, String(Date.now())); } catch (e) {}
      try { navigator.sendBeacon('/beacon?event=s3-' + t); } catch (e) {}
      console.log('s3-log-' + t);
    }); })()`;
    const readLog = `JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('s3-log-')).map((k) => [k.slice(7), true])))`;
    const variants = [
      { label: 'plain close()', mode: 'always', opts: {} },
      { label: 'close({waitForBeforeUnload}) on a page that does not object', mode: 'never', opts: { waitForBeforeUnload: true } },
    ];
    data.scenarios.A2c = {};
    for (const variant of variants) {
      const probeTab = await L.openTab(win, fixture.url('/index.html', 'a.test'), { focus: false });
      await L.evalMain(probeTab.wc, 'localStorage.clear()');
      L.dispose(win, probeTab);
      const { view, wc } = await L.openTab(win, url(variant.mode));
      await L.evalMain(wc, install);
      const consoleSeen = [];
      wc.on('console-message', (event, ...legacy) => {
        const message = event?.message ?? legacy[1];
        if (String(message).startsWith('s3-log-')) consoleSeen.push(String(message).slice(7));
      });
      const beaconMark = fixture.beacons.length;
      const obs = await L.closeAndObserve(wc, { observeMs: 3000, ...variant.opts });
      await sleep(500);
      const beaconSeen = fixture.beacons.slice(beaconMark).map((b) => b.query.event).filter((e) => String(e).startsWith('s3-')).map((e) => e.slice(3));
      const reader = await L.openTab(win, fixture.url('/index.html', 'a.test'), { focus: false });
      const handlersThatRan = JSON.parse(await L.evalMain(reader.wc, readLog));
      L.dispose(win, reader);
      data.scenarios.A2c[variant.label] = { destroyedEventAtMs: obs.destroyedEventAtMs, handlersThatRan, consoleSeen, beaconSeen };
      record(rows, `A2c which page handlers ran on ${variant.label} (localStorage / console / beacon evidence)`,
        { destroyedEventAtMs: obs.destroyedEventAtMs, handlersThatRan, consoleSeen, beaconSeen }, null);
      L.dispose(win, { view, wc });
    }
  }

  // ---------------------------------------------------------------------------------------
  // A3: mode=dirty
  // ---------------------------------------------------------------------------------------
  // A3-control: dirty page, never touched: no objection, closes normally.
  {
    const { view, wc } = await L.openTab(win, url('dirty'));
    const mark = fixture.beacons.length;
    const obs = await L.closeAndObserve(wc, { waitForBeforeUnload: true, observeMs: 3000 });
    await sleep(300);
    data.scenarios.A3_untouched = { obs, beacons: L.beaconsSince(fixture, mark) };
    record(rows, 'A3 control: mode=dirty never touched, close({waitForBeforeUnload}) closes normally',
      { willPreventUnloadCount: obs.willPreventUnloadCount, destroyedEventAtMs: obs.destroyedEventAtMs, beacons: data.scenarios.A3_untouched.beacons },
      obs.willPreventUnloadCount === 0 && obs.destroyedEventAtMs != null);
    L.dispose(win, { view, wc });
  }

  // A3 main: real input, then close; then repeat with preventDefault on the same page.
  {
    const { view, wc, state } = await openDirtyWithRealInput('hi');
    record(rows, 'A3 real input via sendInputEvent reached the page (#text value, focus, activation)',
      state, state.value === 'hi' && state.focused === 'text' && state.hasBeenActive === true);
    const windowsBefore = watcherReady ? await watcher.list() : null;
    const mark = fixture.beacons.length;
    const first = await L.closeAndObserve(wc, {
      waitForBeforeUnload: true,
      observeMs: 3000,
      midpoint: async () => (watcherReady ? watcher.list() : null),
    });
    const aliveAfterFirst = !wc.isDestroyed();
    const stateAfterFirst = aliveAfterFirst
      ? await L.evalMain(wc, `({ value: document.getElementById('text').value })`)
      : null;
    // The page must stay fully usable after the cancelled close: type one more character.
    let typedAfterCancel = null;
    if (aliveAfterFirst) {
      await L.typeText(wc, '!');
      typedAfterCancel = await L.evalMain(wc, `document.getElementById('text').value`);
    }
    const beaconsFirst = L.beaconsSince(fixture, mark);
    record(rows, 'A3 dirty after real input, close({waitForBeforeUnload}) without preventDefault: will-prevent-unload emitted',
      { count: first.willPreventUnloadCount, atMs: first.willPreventUnloadAtMs }, first.willPreventUnloadCount >= 1);
    record(rows, 'A3 ... and the page is kept alive (3 s, no destroyed event), typed text intact, still accepts input',
      { isDestroyedAtEnd: first.isDestroyedAtEnd, destroyedEventAtMs: first.destroyedEventAtMs, valueAfterCancel: stateAfterFirst?.value, valueAfterTypingMore: typedAfterCancel },
      aliveAfterFirst && first.destroyedEventAtMs == null && stateAfterFirst?.value === 'hi' && typedAfterCancel === 'hi!');
    record(rows, 'A3 ... no modal dialog or new native window',
      { newVisibleWindows: newVisibleWindows(windowsBefore, first.midpointResult) },
      watcherReady ? (newVisibleWindows(windowsBefore, first.midpointResult) ?? []).length === 0 : null);
    record(rows, 'A3 ... beforeunload beacon says dirty=true, objected=true', beaconsFirst,
      beaconsFirst.some((b) => b.event === 'beforeunload' && b.dirty === 'true' && b.objected === 'true'));

    // Repeat on the same, still-alive page, now calling event.preventDefault() in the handler.
    const mark2 = fixture.beacons.length;
    const second = wc.isDestroyed()
      ? { skipped: 'page already destroyed by the first attempt', willPreventUnloadCount: 0, destroyedEventAtMs: null, isDestroyedAtEnd: true }
      : await L.closeAndObserve(wc, { waitForBeforeUnload: true, preventDefault: true, observeMs: 3000 });
    await sleep(500);
    const beaconsSecond = L.beaconsSince(fixture, mark2);
    data.scenarios.A3_realInput = { state, first, stateAfterFirst, typedAfterCancel, beaconsFirst, second, beaconsSecond, windowsBefore, windowsDuring: first.midpointResult };
    record(rows, 'A3 same page again, handler calls event.preventDefault(): page closes',
      { willPreventUnloadCount: second.willPreventUnloadCount, destroyedEventAtMs: second.destroyedEventAtMs, isDestroyedAtEnd: second.isDestroyedAtEnd, beacons: beaconsSecond },
      second.willPreventUnloadCount >= 1 && second.destroyedEventAtMs != null);
    L.dispose(win, { view, wc });
  }

  // A3-hidden: same, but the view is detached from the window (a hidden tab, the real discard case).
  {
    const { view, wc, state } = await openDirtyWithRealInput('hi', { detachAfterTyping: true });
    record(rows, 'A3h precondition: real input reached the page before it was detached', state, state.inputOk);
    const first = await L.closeAndObserve(wc, { waitForBeforeUnload: true, observeMs: 3000 });
    const alive = !wc.isDestroyed();
    let second = null;
    if (alive) second = await L.closeAndObserve(wc, { waitForBeforeUnload: true, preventDefault: true, observeMs: 3000 });
    data.scenarios.A3_realInput_detachedView = { state, first, second };
    record(rows, 'A3h detached (hidden) view, real input, close({waitForBeforeUnload}): will-prevent-unload emitted and page kept',
      { count: first.willPreventUnloadCount, atMs: first.willPreventUnloadAtMs, aliveAfter3s: alive && first.destroyedEventAtMs == null },
      first.willPreventUnloadCount >= 1 && alive && first.destroyedEventAtMs == null);
    record(rows, 'A3h detached view + preventDefault: page closes',
      { destroyedEventAtMs: second?.destroyedEventAtMs }, second?.destroyedEventAtMs != null);
    L.dispose(win, { view, wc });
  }

  // A3-synthetic: page made "dirty" by a main-world script (no real input, no user activation).
  {
    const { view, wc } = await L.openTab(win, url('dirty'));
    await L.evalMain(
      wc,
      `(() => { const el = document.getElementById('text'); el.value = 'scripted'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    const activation = await L.userActivation(wc);
    const obs = await L.closeAndObserve(wc, { waitForBeforeUnload: true, observeMs: 1500 });
    data.scenarios.A3_syntheticDirty = { activation, obs };
    record(rows, 'A3s page dirtied by script only (no user activation), close({waitForBeforeUnload}): objection still honoured',
      { hasBeenActiveBeforeClose: activation.hasBeenActive, willPreventUnloadCount: obs.willPreventUnloadCount, aliveAfter: !wc.isDestroyed() },
      null, 'confirms that close() itself supplies the activation Chromium normally requires');
    L.dispose(win, { view, wc });
  }

  // ---------------------------------------------------------------------------------------
  // A4: mode=never
  // ---------------------------------------------------------------------------------------
  {
    const { view, wc } = await L.openTab(win, url('never'));
    const typing = await L.clickAndType(wc, '#text', 'hello'); // even with real input, a non-objecting handler lets the close through
    const mark = fixture.beacons.length;
    const obs = await L.closeAndObserve(wc, { waitForBeforeUnload: true, observeMs: 3000 });
    await sleep(500);
    const beacons = L.beaconsSince(fixture, mark);
    data.scenarios.A4_never = { typing: { attempts: typing.attempts, failed: typing.failed }, obs, beacons };
    record(rows, 'A4 mode=never (handler registered, never objects), close({waitForBeforeUnload}) closes normally',
      { willPreventUnloadCount: obs.willPreventUnloadCount, destroyedEventAtMs: obs.destroyedEventAtMs, beacons },
      obs.willPreventUnloadCount === 0 && obs.destroyedEventAtMs != null);
    L.dispose(win, { view, wc });
  }

  // ---------------------------------------------------------------------------------------
  // A6: the beforeunload handler lives in a cross-site CHILD frame (b.test inside a.test)
  // ---------------------------------------------------------------------------------------
  async function openParentWithBeforeUnloadChild(mode) {
    const tab = await L.openTab(win, fixture.url('/iframe-parent.html', 'a.test'));
    await L.evalMain(
      tab.wc,
      `(() => { document.getElementById('child').remove(); const f = document.createElement('iframe'); f.id = 'bu'; f.width = 600; f.height = 300;
         f.src = 'http://b.test:' + location.port + '/beforeunload.html?mode=${mode}'; document.body.appendChild(f); })()`,
    );
    const child = await h.pollUntil(() => tab.wc.mainFrame.frames.find((f) => f.url.includes('beforeunload.html')), { timeoutMs: 8000 });
    await h.pollUntil(() => child.executeJavaScript("Boolean(document.getElementById('text'))").catch(() => false), { timeoutMs: 8000 });
    return { ...tab, child };
  }

  {
    // A6a: child says "always", nobody touched anything.
    const tab = await openParentWithBeforeUnloadChild('always');
    const mark = fixture.beacons.length;
    const obs = await L.closeAndObserve(tab.wc, { waitForBeforeUnload: true, observeMs: 1500 });
    await sleep(300);
    const beacons = L.beaconsSince(fixture, mark);
    data.scenarios.A6a_childAlwaysUntouched = { obs, beacons };
    record(rows, 'A6a cross-site child with mode=always, nothing touched: close({waitForBeforeUnload})',
      { willPreventUnloadCount: obs.willPreventUnloadCount, destroyedEventAtMs: obs.destroyedEventAtMs, beacons }, null,
      'close() activates only the top frame; compare with A1 where the same handler sat in the top frame');
    L.dispose(win, tab);
  }
  {
    // A6b: child says "dirty after input"; make it dirty with routed real input (CDP), then close.
    const tab = await openParentWithBeforeUnloadChild('dirty');
    const box = await L.evalMain(tab.wc, `(() => { const f = document.getElementById('bu'); const r = f.getBoundingClientRect(); return { x: r.x + f.clientLeft, y: r.y + f.clientTop }; })()`);
    const inChild = await tab.child.executeJavaScript(`(() => { const r = document.getElementById('text').getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    let clicksNeeded = false;
    let childActiveAfterClick = null;
    await L.withDebugger(tab.wc, async () => {
      clicksNeeded = await L.cdpFocusChildInput(tab.wc, tab.child, '#text', box.x + inChild.cx, box.y + inChild.cy);
      childActiveAfterClick = await tab.child.executeJavaScript('document.activeElement.id || document.activeElement.tagName');
      await L.cdpType(tab.wc, 'hi');
    });
    const childValue = await tab.child.executeJavaScript("document.getElementById('text').value");
    record(rows, 'A6b precondition: routed (CDP) typing reached the cross-site child input', { clicksNeeded, childActiveAfterClick, childValue }, childValue === 'hi');
    const mark = fixture.beacons.length;
    const first = await L.closeAndObserve(tab.wc, { waitForBeforeUnload: true, observeMs: 2000 });
    await sleep(300);
    const beacons = L.beaconsSince(fixture, mark);
    data.scenarios.A6b_childDirtyAfterRoutedInput = { box, inChild, clicksNeeded, childActiveAfterClick, childValue, first, beacons };
    record(rows, 'A6b cross-site child, mode=dirty, typed into via routed (CDP) input, close({waitForBeforeUnload})',
      { childActiveAfterClick, childValue, willPreventUnloadCount: first.willPreventUnloadCount, aliveAfter: !tab.wc.isDestroyed(), beacons },
      childValue === 'hi' ? first.willPreventUnloadCount >= 1 && !tab.wc.isDestroyed() : null,
      'is a subframe objection surfaced through will-prevent-unload?');
    L.dispose(win, tab);
  }

  // ---------------------------------------------------------------------------------------
  // A5: timing, 5 runs each, attached and detached
  // ---------------------------------------------------------------------------------------
  const RUNS = 5;
  const scenarios = [
    { key: 'prevent_always_untouched', title: 'close({waitForBeforeUnload}) -> will-prevent-unload, mode=always untouched', mode: 'always', realInput: false, wfb: true, metric: 'willPreventUnloadAtMs' },
    { key: 'prevent_dirty_realInput', title: 'close({waitForBeforeUnload}) -> will-prevent-unload, mode=dirty after real input', mode: 'dirty', realInput: true, wfb: true, metric: 'willPreventUnloadAtMs' },
    { key: 'destroyed_never_wfb', title: 'close({waitForBeforeUnload}) -> destroyed, mode=never', mode: 'never', realInput: false, wfb: true, metric: 'destroyedEventAtMs' },
    { key: 'destroyed_always_preventDefault', title: 'close({waitForBeforeUnload}) + preventDefault -> destroyed, mode=always', mode: 'always', realInput: false, wfb: true, preventDefault: true, metric: 'destroyedEventAtMs' },
    { key: 'destroyed_plain_close', title: 'plain close() -> destroyed, mode=always', mode: 'always', realInput: false, wfb: false, metric: 'destroyedEventAtMs' },
  ];
  for (const scenario of scenarios) {
    for (const attached of [true, false]) {
      const samples = [];
      let inputFailures = 0;
      for (let i = 0; i < RUNS; i += 1) {
        let tab;
        if (scenario.realInput) {
          tab = await openDirtyWithRealInput('a', { detachAfterTyping: !attached });
          if (!tab.state.inputOk) inputFailures += 1;
        } else {
          tab = await L.openTab(win, url(scenario.mode));
          if (!attached) L.detach(win, tab.view);
        }
        const obs = await L.closeAndObserve(tab.wc, {
          waitForBeforeUnload: scenario.wfb,
          preventDefault: Boolean(scenario.preventDefault),
          observeMs: scenario.metric === 'destroyedEventAtMs' ? 2000 : 400,
        });
        samples.push(obs[scenario.metric]);
        L.dispose(win, tab); // removes the view from the window even when the page is already destroyed
      }
      const summary = { samples, ...L.stats(samples), ...(scenario.realInput ? { inputFailures } : {}) };
      data.timing[`${scenario.key}${attached ? '' : '__detached'}`] = { title: scenario.title, attached, ...summary };
      record(rows, `A5 ${scenario.title} [${attached ? 'attached' : 'detached'}] ms`, summary, null);
    }
  }

  return data;
}

module.exports = { run };
