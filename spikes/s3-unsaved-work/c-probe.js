'use strict';
// Part C: the isolated-world unsaved-input probe from shared/probe.js.

const h = require('../shared/harness');
const L = require('./lib');
const { PROBE_SOURCE, PROBE_WORLD_ID } = require('../shared/probe');

const { sleep, record } = h;

const probe = (wc) => wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: PROBE_SOURCE }]);
const inProbeWorld = (wc, code) => wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code }]);

async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function run(ctx) {
  const { win, fixture, rows } = ctx;
  const data = { fields: {}, sensitive: {}, isolation: {}, iframe: {}, cost: {} };
  const formUrl = fixture.url('/form.html', 'a.test');
  const fresh = () => L.openTab(win, formUrl);

  // -------------------------------------------------------------------------------------
  // C1: form.html
  // -------------------------------------------------------------------------------------
  {
    const { view, wc } = await fresh();
    const first = await probe(wc);
    const second = await probe(wc);
    const activationMain = await L.userActivation(wc);
    data.fields.untouched = { first, second, activationMain };
    record(rows, 'C1 untouched form.html: dirty is empty, no focus, not sensitive, hasBeenActive=false',
      first, same(first, { dirty: [], focusedEditable: false, sensitive: false, hasBeenActive: false }));
    record(rows, 'C1 running the probe twice does not change hasBeenActive', { second, activationMain }, second.hasBeenActive === false && activationMain.hasBeenActive === false);

    // mouseMove only: not a user activation.
    await L.ensureFocus(wc);
    for (let i = 0; i < 5; i += 1) wc.sendInputEvent({ type: 'mouseMove', x: 120 + i * 10, y: 250 });
    await sleep(100);
    const afterMove = await probe(wc);
    record(rows, 'C1 after real mouseMove only: hasBeenActive still false', afterMove, afterMove.hasBeenActive === false);

    // Click on #text: focus without edit.
    const r = await L.rectOf(wc, '#text');
    await L.click(wc, r.cx, r.cy);
    const afterClick = await probe(wc);
    data.fields.afterClickOnText = afterClick;
    record(rows, 'C1 click into #text (no edit): focusedEditable=true, dirty empty, hasBeenActive=true', afterClick,
      afterClick.focusedEditable === true && afterClick.dirty.length === 0 && afterClick.hasBeenActive === true,
      'focusing an untouched field marks the tab as "focused editable" but not dirty');
    L.dispose(win, { view, wc });
  }

  // Things the app itself might do that could pollute hasBeenActive.
  {
    const { view, wc } = await fresh();
    const base = (await probe(wc)).hasBeenActive;
    await inProbeWorld(wc, '1');
    const afterIsolatedWorldCall = (await probe(wc)).hasBeenActive;
    wc.focus();
    const afterFocus = (await probe(wc)).hasBeenActive;
    await wc.executeJavaScript('1', true); // userGesture = true
    const afterUserGestureEval = (await probe(wc)).hasBeenActive;
    data.fields.activationPollution = { base, afterIsolatedWorldCall, afterFocus, afterUserGestureEval };
    record(rows, 'C1 hasBeenActive stays false after isolated-world calls and wc.focus(), but executeJavaScript(code, userGesture=true) sets it',
      data.fields.activationPollution, base === false && afterIsolatedWorldCall === false && afterFocus === false && afterUserGestureEval === true,
      'the app must never pass userGesture=true on tabs whose hasBeenActive it relies on');
    L.dispose(win, { view, wc });
  }

  // Lifecycle of hasBeenActive: survives same-document navigation, resets on cross-document navigation.
  {
    const { view, wc } = await fresh();
    const r = await L.rectOf(wc, '#text');
    await L.click(wc, r.cx, r.cy);
    const afterClick = (await probe(wc)).hasBeenActive;
    await L.evalMain(wc, "history.pushState({}, '', '#same-document'); true");
    const afterPushState = (await probe(wc)).hasBeenActive;
    await wc.loadURL(fixture.url('/form.html?second=1', 'a.test'));
    const afterNewDocument = (await probe(wc)).hasBeenActive;
    data.fields.activationLifecycle = { afterClick, afterPushState, afterNewDocument };
    record(rows, 'C1 hasBeenActive survives history.pushState and resets on a cross-document navigation (same site)',
      data.fields.activationLifecycle, afterClick === true && afterPushState === true && afterNewDocument === false);
    L.dispose(win, { view, wc });
  }

  /** Fresh form.html, apply `act`, probe. Returns { result, evidence }. */
  async function fieldCase(name, expectedDirty, act) {
    const { view, wc } = await fresh();
    const evidence = (await act(wc)) ?? {};
    const result = await probe(wc);
    data.fields[name] = { result, evidence };
    L.dispose(win, { view, wc });
    return { result, evidence };
  }

  {
    const { result, evidence } = await fieldCase('text', ['text'], async (wc) => {
      const typing = await L.clickAndType(wc, '#text', 'x');
      return { typed: typing.typed, inputAttempts: typing.attempts };
    });
    record(rows, 'C1 #text edited with real input is detected', { result, evidence }, result.dirty.includes('text') && String(evidence.typed).includes('x'));
  }
  {
    const { result, evidence } = await fieldCase('area', ['area'], async (wc) => {
      const typing = await L.clickAndType(wc, '#area', 'y');
      return { typed: typing.typed, inputAttempts: typing.attempts };
    });
    record(rows, 'C1 #area edited with real input is detected', { result, evidence }, result.dirty.includes('area'));
  }
  {
    const { result, evidence } = await fieldCase('sel', ['sel'], async (wc) => {
      await L.ensureFocus(wc);
      await L.evalMain(wc, `document.getElementById('sel').focus()`); // focus only; the change below is a real key press
      await L.pressKey(wc, 'Down');
      const value = await L.evalMain(wc, `document.getElementById('sel').value`);
      return { valueAfterRealArrowDownKey: value };
    });
    record(rows, 'C1 #sel changed with a real ArrowDown key press is detected', { result, evidence },
      evidence.valueAfterRealArrowDownKey === 'b' && result.dirty.includes('sel'),
      'select focused programmatically (clicking opens a native popup); the change itself is a real key event');
  }
  {
    const { result, evidence } = await fieldCase('chk', ['chk'], async (wc) => {
      await L.ensureFocus(wc);
      const r = await L.rectOf(wc, '#chk');
      await L.click(wc, r.cx, r.cy);
      return { checked: await L.evalMain(wc, `document.getElementById('chk').checked`) };
    });
    record(rows, 'C1 #chk toggled with a real click is detected', { result, evidence }, evidence.checked === true && result.dirty.includes('chk'));
  }
  {
    const { result, evidence } = await fieldCase('reactish', [], async (wc) => {
      const typing = await L.clickAndType(wc, '#reactish', 'hello');
      const state = await L.evalMain(wc, `(() => { const e = document.getElementById('reactish'); return { value: e.value, defaultValue: e.defaultValue }; })()`);
      return { typed: typing.typed, ...state };
    });
    record(rows, 'C1 #reactish (value attribute synced on every input) typed with real input: NOT detected (false negative)',
      { result, evidence }, evidence.value === 'hello' && evidence.defaultValue === 'hello' && !result.dirty.includes('reactish'),
      'defaultValue tracks value, so value !== defaultValue is false even though the user typed');
  }
  {
    // contenteditable: focus, type, blur.
    const { view, wc } = await fresh();
    await L.ensureFocus(wc);
    const before = await probe(wc);
    const r = await L.rectOf(wc, '#ce');
    await L.click(wc, r.cx, r.cy);
    const focused = await probe(wc);
    await L.typeText(wc, 'edit');
    const typedText = await L.evalMain(wc, `document.getElementById('ce').textContent`);
    const whileFocusedAfterTyping = await probe(wc);
    const h1 = await L.rectOf(wc, 'h1');
    await L.click(wc, h1.x + 5, h1.cy); // blur the editable region by clicking plain text
    const afterBlur = await probe(wc);
    data.fields.contenteditable = { before, focused, typedText, whileFocusedAfterTyping, afterBlur };
    record(rows, 'C1 #ce before any input: focusedEditable=false, hasBeenActive=false', before,
      before.focusedEditable === false && before.hasBeenActive === false);
    record(rows, 'C1 #ce focused by a real click: focusedEditable=true, hasBeenActive=true', focused,
      focused.focusedEditable === true && focused.hasBeenActive === true);
    record(rows, 'C1 #ce typed into: contenteditable edit itself is not in dirty[]', { typedText, whileFocusedAfterTyping },
      typedText.includes('edit') && whileFocusedAfterTyping.dirty.length === 0);
    record(rows, 'C1 #ce blurred after typing: edit becomes invisible to the probe (dirty=[], focusedEditable=false)', afterBlur,
      afterBlur.dirty.length === 0 && afterBlur.focusedEditable === false,
      'the probe only checks focus for contenteditable, never content; the §4.10 wording "focused or edited" over-promises');
    L.dispose(win, { view, wc });
  }
  {
    // Programmatic changes need no input events: value !== defaultValue is enough. And restoring the original is clean.
    const { view, wc } = await fresh();
    await L.evalMain(wc, `document.getElementById('text').value = 'script-set'`);
    const scripted = await probe(wc);
    await L.evalMain(wc, `document.getElementById('text').value = 'initial'`);
    const restored = await probe(wc);
    data.fields.programmatic = { scripted, restored };
    record(rows, 'C1 programmatic .value change (no events) is detected; restoring the original value is not', { scripted, restored },
      scripted.dirty.includes('text') && restored.dirty.length === 0);
    L.dispose(win, { view, wc });
  }

  // -------------------------------------------------------------------------------------
  // C2: sensitive.html
  // -------------------------------------------------------------------------------------
  {
    const { view, wc } = await L.openTab(win, fixture.url('/sensitive.html', 'a.test'));
    const base = await probe(wc);
    await L.evalMain(wc, `document.getElementById('pw').remove()`);
    const withoutPassword = await probe(wc);
    await L.evalMain(wc, `document.getElementById('cc').remove()`);
    const withoutBoth = await probe(wc);
    data.sensitive = { base, withoutPassword, withoutBoth };
    record(rows, 'C2 sensitive.html: sensitive=true (untouched)', base, base.sensitive === true && base.dirty.length === 0);
    record(rows, 'C2 password removed: still sensitive via autocomplete=cc-number; both removed: false', { withoutPassword, withoutBoth },
      withoutPassword.sensitive === true && withoutBoth.sensitive === false);
    L.dispose(win, { view, wc });
  }

  // -------------------------------------------------------------------------------------
  // C3: isolation
  // -------------------------------------------------------------------------------------
  {
    const { view, wc } = await fresh();
    await L.evalMain(wc, `window.__secret = 1`);
    const mainSees = await L.evalMain(wc, `typeof window.__secret`);
    const probeSees = await inProbeWorld(wc, `typeof window.__secret`);
    await inProbeWorld(wc, `window.__probeOnly = 2`);
    const pageSeesProbeVar = await L.evalMain(wc, `typeof window.__probeOnly`);
    const probeSeesOwnVar = await inProbeWorld(wc, `typeof window.__probeOnly`);
    data.isolation.globals = { mainSees, probeSees, pageSeesProbeVar, probeSeesOwnVar };
    record(rows, 'C3 window.__secret set in the main world is invisible in the probe world',
      { mainWorld: mainSees, probeWorld: probeSees }, mainSees === 'number' && probeSees === 'undefined');
    record(rows, 'C3 a variable created in the probe world is invisible to the page',
      { pageWorld: pageSeesProbeVar, probeWorld: probeSeesOwnVar }, pageSeesProbeVar === 'undefined' && probeSeesOwnVar === 'number');

    // The page tampers with prototypes and with navigator.userActivation; the probe must still tell the truth.
    await L.clickAndType(wc, '#text', 'x');
    await L.evalMain(
      wc,
      `Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, get() { return this.defaultValue; }, set(v) {} });
       Object.defineProperty(Navigator.prototype, 'userActivation', { configurable: true, get() { return { hasBeenActive: false, isActive: false }; } });
       true`,
    );
    const spoofedMain = await L.evalMain(wc, `({ textValue: document.getElementById('text').value, hasBeenActive: navigator.userActivation.hasBeenActive })`);
    const probeResult = await probe(wc);
    data.isolation.tamper = { spoofedMain, probeResult };
    record(rows, 'C3 page overrides HTMLInputElement.value and navigator.userActivation: probe still reports the truth',
      { whatThePageSees: spoofedMain, probe: probeResult }, probeResult.dirty.includes('text') && probeResult.hasBeenActive === true && spoofedMain.hasBeenActive === false);
    L.dispose(win, { view, wc });
  }

  // -------------------------------------------------------------------------------------
  // C4: cross-site iframe
  // -------------------------------------------------------------------------------------
  {
    const { view, wc } = await L.openTab(win, fixture.url('/iframe-parent.html', 'a.test'));
    const child = await h.pollUntil(() => wc.mainFrame.frames.find((f) => f.url.includes('iframe-child.html')), { timeoutMs: 8000 });
    await h.pollUntil(() => child.executeJavaScript(`Boolean(document.getElementById('child-text'))`).catch(() => false), { timeoutMs: 8000 });

    // Make the child's input dirty with routed (CDP) input: sendInputEvent cannot reach a cross-process child (see part B).
    const iframeBox = await L.evalMain(wc, `(() => { const f = document.getElementById('child'); const r = f.getBoundingClientRect(); return { x: r.x + f.clientLeft, y: r.y + f.clientTop }; })()`);
    const inChild = await child.executeJavaScript(`(() => { const r = document.getElementById('child-text').getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    const x = iframeBox.x + inChild.cx;
    const y = iframeBox.y + inChild.cy;
    const beaconsBefore = fixture.beacons.filter((b) => b.query.event === 'child-input').length;
    const activationBefore = {
      topFrame: (await probe(wc)).hasBeenActive,
      childFrame: await child.executeJavaScript('navigator.userActivation.hasBeenActive'),
    };
    const clicksNeeded = await L.withDebugger(wc, async () => {
      const clicks = await L.cdpFocusChildInput(wc, child, '#child-text', x, y);
      await L.cdpType(wc, 'zz');
      return clicks;
    });
    await sleep(100);
    const activationAfter = {
      topFrame: (await probe(wc)).hasBeenActive,
      childFrame: await child.executeJavaScript('navigator.userActivation.hasBeenActive'),
    };
    data.iframe.activationPropagation = { activationBefore, activationAfter, cdpClicksNeeded: clicksNeeded };
    record(rows, 'C4 user activation inside the cross-site child also flips hasBeenActive in the TOP frame (seen by the top-frame probe)',
      { activationBefore, activationAfter }, activationBefore.topFrame === false && activationAfter.topFrame === true && activationAfter.childFrame === true,
      'so hasBeenActive covers iframe interaction that the top-frame DOM scan cannot see');
    const childValue = await child.executeJavaScript(`document.getElementById('child-text').value`);
    const childBeacons = fixture.beacons.filter((b) => b.query.event === 'child-input').length - beaconsBefore;
    const mainFrameProbe = await probe(wc);
    const childProbeInMainWorld = await child.executeJavaScript(PROBE_SOURCE);
    data.iframe.visibility = { childValue, childBeacons, mainFrameProbe, childProbeInMainWorld };
    record(rows, 'C4 child input was really edited (value + child-input beacons)', { childValue, childBeacons }, childValue.endsWith('zz') && childBeacons >= 2);
    record(rows, 'C4 main-frame probe does not see the cross-site child\'s edit (expected: blind)', mainFrameProbe,
      mainFrameProbe.dirty.length === 0 && mainFrameProbe.focusedEditable === false,
      'parent document.activeElement is the <iframe>; the probe does not descend into frames');
    record(rows, 'C4 for comparison: the same probe source run via webFrameMain.executeJavaScript in the child (main world) sees it', childProbeInMainWorld,
      childProbeInMainWorld.dirty.includes('child-text'), 'works, but in the page\'s own JavaScript world');

    // Which world does webFrameMain.executeJavaScript use? Load a page with known page-defined globals into a cross-site child.
    await L.evalMain(
      wc,
      `(() => { const f = document.createElement('iframe'); f.id = 'probe-frame'; f.width = 300; f.height = 100;
         f.src = 'http://b.test:' + location.port + '/beforeunload.html?mode=never'; document.body.appendChild(f); })()`,
    );
    const worldFrame = await h.pollUntil(() => wc.mainFrame.frames.find((f) => f.url.includes('beforeunload.html')), { timeoutMs: 8000 });
    await h.pollUntil(() => worldFrame.executeJavaScript(`typeof document.getElementById('text')`).then((t) => t === 'object').catch(() => false), { timeoutMs: 8000 });
    const worldCheck = await worldFrame.executeJavaScript(`({ report: typeof report, mode: typeof mode, windowReport: typeof window.report })`);
    // And for the main frame: variable set via webContents.executeJavaScript is visible through mainFrame.executeJavaScript.
    await L.evalMain(wc, `window.__secret = 1`);
    const mainFrameWorld = await wc.mainFrame.executeJavaScript(`typeof window.__secret`);
    data.iframe.world = {
      subframeCrossProcess: worldFrame.processId !== wc.mainFrame.processId,
      worldCheck,
      mainFrameWorld,
      webFrameMainHasIsolatedWorldApi: typeof worldFrame.executeJavaScriptInIsolatedWorld,
      webFrameMainMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(worldFrame)).filter((n) => /execute|isolated|world/i.test(n)),
    };
    record(rows, 'C4 webFrameMain.executeJavaScript runs in a cross-process subframe, in the MAIN world (sees page globals report/mode)',
      data.iframe.world, worldCheck.report === 'function' && worldCheck.mode === 'string' && data.iframe.world.subframeCrossProcess);
    record(rows, 'C4 webFrameMain.executeJavaScript on the main frame shares the main world with webContents.executeJavaScript',
      mainFrameWorld, mainFrameWorld === 'number');
    record(rows, 'C4 webFrameMain has no isolated-world execution API (methods matching /execute|isolated|world/)',
      data.iframe.world.webFrameMainMethods, data.iframe.world.webFrameMainHasIsolatedWorldApi === 'undefined');

    // Exploratory: isolated world inside the cross-process child through CDP (Page.createIsolatedWorld).
    const cdp = { attempted: true };
    try {
      wc.debugger.attach('1.3');
      const sessions = [];
      wc.debugger.on('message', (_event, method, params) => {
        if (method === 'Target.attachedToTarget') sessions.push({ sessionId: params.sessionId, type: params.targetInfo.type, url: params.targetInfo.url });
      });
      await wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await h.pollUntil(() => sessions.some((s) => s.url.includes('iframe-child.html')), { timeoutMs: 5000 });
      const target = sessions.find((s) => s.url.includes('iframe-child.html'));
      cdp.sessions = sessions;
      if (target) {
        const tree = await wc.debugger.sendCommand('Page.getFrameTree', {}, target.sessionId);
        const world = await wc.debugger.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'veltriva-probe' }, target.sessionId);
        const t0 = performance.now();
        const evaluated = await wc.debugger.sendCommand('Runtime.evaluate', { expression: PROBE_SOURCE, contextId: world.executionContextId, returnByValue: true }, target.sessionId);
        cdp.evaluateMs = L.round(performance.now() - t0, 1);
        cdp.result = evaluated.result?.value;
        // Isolation inside the child: a global set in the child's main world must be invisible to the CDP isolated world.
        await child.executeJavaScript('window.__childSecret = 1');
        const iso = await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'typeof window.__childSecret', contextId: world.executionContextId, returnByValue: true }, target.sessionId);
        cdp.childMainWorldSees = await child.executeJavaScript('typeof window.__childSecret');
        cdp.isolatedWorldSees = iso.result?.value;
      }
    } catch (error) {
      cdp.error = String(error.message ?? error);
    } finally {
      try {
        wc.debugger.detach();
      } catch {
        /* not attached */
      }
    }
    data.iframe.cdpIsolatedWorld = cdp;
    record(rows, 'C4 exploratory: CDP Page.createIsolatedWorld + Runtime.evaluate runs the probe in the cross-process child, in an isolated world',
      cdp, (cdp.result?.dirty?.includes('child-text') ?? false) && cdp.isolatedWorldSees === 'undefined', 'not required by S3; shows a possible route for iframe forms');
    L.dispose(win, { view, wc });
  }

  // -------------------------------------------------------------------------------------
  // C6 (exploratory, not asked for by S3): a trusted-input tracker in the isolated world.
  // Idea: install a capture-phase 'input' listener in the probe world right after load, and read a counter at
  // discard time. It does not depend on value/defaultValue, so it should catch the two false negatives of C1.
  // -------------------------------------------------------------------------------------
  {
    const TRACKER = `(() => {
      if (window.__s3Tracker) return 'already-installed';
      const state = (window.__s3Tracker = { total: 0, trusted: 0, targets: [] });
      addEventListener('input', (event) => {
        state.total += 1;
        if (event.isTrusted) state.trusted += 1;
        const t = event.target;
        state.targets.push((t && (t.id || t.tagName)) || '?');
      }, true);
      return 'installed';
    })()`;
    const READ = 'window.__s3Tracker ? { total: __s3Tracker.total, trusted: __s3Tracker.trusted, targets: __s3Tracker.targets.slice() } : null';

    const { view, wc } = await fresh();
    await inProbeWorld(wc, TRACKER);
    await L.clickAndType(wc, '#reactish', 'hi');
    const ce = await L.rectOf(wc, '#ce');
    await L.click(wc, ce.cx, ce.cy);
    await L.typeText(wc, 'ed');
    const h1 = await L.rectOf(wc, 'h1');
    await L.click(wc, h1.x + 5, h1.cy); // blur the editable region
    const tracker = await inProbeWorld(wc, READ);
    const probeResult = await probe(wc);
    data.fields.inputTracker = { tracker, probeResult };
    record(rows, 'C6 exploratory: isolated-world input tracker sees the typing the value probe misses (#reactish and blurred #ce)',
      { tracker, valueProbe: probeResult }, tracker?.trusted >= 4 && tracker.targets.includes('reactish') && tracker.targets.includes('ce') && probeResult.dirty.length === 0,
      'trusted flag is true for sendInputEvent input');
    L.dispose(win, { view, wc });

    // A hostile (or just unusual) page that stops 'input' events at the window in the capture phase before the tracker is installed.
    const hostile = await fresh();
    await L.evalMain(hostile.wc, "window.addEventListener('input', (e) => e.stopImmediatePropagation(), true); true");
    await inProbeWorld(hostile.wc, TRACKER);
    await L.clickAndType(hostile.wc, '#text', 'x');
    const hostileTracker = await inProbeWorld(hostile.wc, READ);
    data.fields.inputTrackerHostilePage = hostileTracker;
    record(rows, 'C6 limitation: a page-registered window capture listener that calls stopImmediatePropagation hides input from the tracker',
      hostileTracker, hostileTracker?.total === 0, 'the value probe is unaffected by this (see C3), so use both');
    L.dispose(win, hostile);
  }

  // -------------------------------------------------------------------------------------
  // C5: cost
  // -------------------------------------------------------------------------------------
  {
    const N = 10;
    // Baseline: a trivial main-world call.
    const { view, wc } = await fresh();
    await probe(wc); // warm up
    const baseline = [];
    for (let i = 0; i < N; i += 1) baseline.push((await timed(() => wc.executeJavaScript('1', false))).ms);
    const warm = [];
    for (let i = 0; i < N; i += 1) warm.push((await timed(() => probe(wc))).ms);
    L.detach(win, view);
    await sleep(200);
    const warmHidden = [];
    for (let i = 0; i < N; i += 1) warmHidden.push((await timed(() => probe(wc))).ms);
    L.attach(win, view);
    L.dispose(win, { view, wc });

    const cold = [];
    for (let i = 0; i < N; i += 1) {
      const tab = await fresh();
      cold.push((await timed(() => probe(tab.wc))).ms);
      L.dispose(win, tab);
    }

    // Heavy DOM: 2000 inputs plus 200 selects.
    const heavy = await fresh();
    await L.evalMain(
      heavy.wc,
      `(() => { const box = document.createElement('div');
         for (let i = 0; i < 2000; i += 1) { const e = document.createElement('input'); e.id = 'bulk' + i; e.value = 'v' + i; box.appendChild(e); }
         for (let i = 0; i < 200; i += 1) { const s = document.createElement('select'); s.innerHTML = '<option>a</option><option selected>b</option><option>c</option>'; box.appendChild(s); }
         document.body.appendChild(box); })()`,
    );
    await probe(heavy.wc);
    const heavySamples = [];
    for (let i = 0; i < N; i += 1) heavySamples.push((await timed(() => probe(heavy.wc))).ms);
    const heavyResult = await probe(heavy.wc);

    // A busy renderer main thread: the probe cannot pre-empt it, so the 100 ms budget must be enforced by the caller.
    await L.evalMain(heavy.wc, `setTimeout(() => { const t = performance.now(); while (performance.now() - t < 700); }, 0); true`);
    await sleep(20);
    const busyStart = performance.now();
    const pending = probe(heavy.wc).then(() => performance.now() - busyStart);
    const raced = await Promise.race([pending, sleep(100).then(() => 'timeout')]);
    const finishedAfterMs = await pending;
    L.dispose(win, heavy);

    data.cost = {
      runsEach: N,
      trivialMainWorldCall: { samples: baseline.map((v) => L.round(v, 2)), ...L.stats(baseline) },
      probeWarmAttached: { samples: warm.map((v) => L.round(v, 2)), ...L.stats(warm) },
      probeWarmHidden: { samples: warmHidden.map((v) => L.round(v, 2)), ...L.stats(warmHidden) },
      probeColdFirstCallOnFreshPage: { samples: cold.map((v) => L.round(v, 2)), ...L.stats(cold) },
      probeHeavyDom_2000inputs_200selects: { samples: heavySamples.map((v) => L.round(v, 2)), ...L.stats(heavySamples), dirtyFound: heavyResult.dirty.length },
      busyRenderer700ms: { callerBudgetResult: raced === 'timeout' ? 'timed out at 100 ms' : 'returned within 100 ms', probeFinallyReturnedAfterMs: L.round(finishedAfterMs, 1) },
    };
    record(rows, 'C5 probe round trip, warm, attached view (ms)', data.cost.probeWarmAttached, null);
    record(rows, 'C5 probe round trip, warm, detached (hidden) view (ms)', data.cost.probeWarmHidden, null);
    record(rows, 'C5 probe round trip, cold first call on a fresh page (ms)', data.cost.probeColdFirstCallOnFreshPage, null);
    record(rows, 'C5 baseline: trivial executeJavaScript("1") round trip (ms)', data.cost.trivialMainWorldCall, null);
    record(rows, 'C5 heavy DOM (2000 inputs + 200 selects) probe (ms)', data.cost.probeHeavyDom_2000inputs_200selects, null);
    record(rows, 'C5 renderer busy for 700 ms: a 100 ms caller-side budget is needed (probe cannot pre-empt)', data.cost.busyRenderer700ms,
      data.cost.busyRenderer700ms.callerBudgetResult === 'timed out at 100 ms');
  }

  return data;
}

module.exports = { run };
