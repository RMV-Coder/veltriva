'use strict';
// Part B: which main-process events does webContents.sendInputEvent produce?
//   input-event, before-input-event, before-mouse-event; and what happens for a cross-site iframe.

const h = require('../shared/harness');
const L = require('./lib');

const { sleep, record } = h;

/** Plain-JSON copy of an Electron event payload (for the results file). */
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

/** Attaches the three observers to `wc`; returns the live log and the first payload seen per source/type. */
function observeInput(wc) {
  const log = [];
  const samples = {};
  const add = (src, type, payload) => {
    log.push({ src, type });
    samples[`${src}:${type}`] ??= plain(payload);
  };
  wc.on('input-event', (_event, inputEvent) => add('input-event', inputEvent.type, inputEvent));
  wc.on('before-input-event', (_event, input) => add('before-input-event', input.type, input));
  wc.on('before-mouse-event', (_event, mouse) => add('before-mouse-event', mouse.type, mouse));
  return { log, samples };
}

/** Runs `fn`, waits for stragglers, and returns the {source: {type: count}} tally of what fired meanwhile. */
async function tallyDuring(log, fn) {
  const start = log.length;
  await fn();
  await sleep(200);
  const slice = log.slice(start);
  const tally = {};
  for (const entry of slice) {
    tally[entry.src] ??= {};
    tally[entry.src][entry.type] = (tally[entry.src][entry.type] ?? 0) + 1;
  }
  return { tally, order: slice.slice(0, 14).map((e) => `${e.src}:${e.type}`), total: slice.length };
}

const countOf = (result, src, type) => result.tally[src]?.[type] ?? 0;

async function run(ctx) {
  const { win, fixture, rows } = ctx;
  const data = { phases: {}, iframe: {} };

  // -------------------------------------------------------------------------------------
  // B1: scripted sequence on form.html
  // -------------------------------------------------------------------------------------
  {
    const { view, wc } = await L.openTab(win, fixture.url('/form.html', 'a.test'));
    const { log, samples } = observeInput(wc);
    const target = await L.rectOf(wc, '#text');
    const { cx, cy } = target;
    const phases = data.phases;

    phases.idle = await tallyDuring(log, () => sleep(300));
    phases.mouseMove = await tallyDuring(log, async () => {
      for (let i = 0; i < 5; i += 1) {
        wc.sendInputEvent({ type: 'mouseMove', x: 100 + i * 20, y: 300 });
        await sleep(10);
      }
    });
    phases.mouseEnterLeave = await tallyDuring(log, async () => {
      wc.sendInputEvent({ type: 'mouseEnter', x: cx, y: cy });
      wc.sendInputEvent({ type: 'mouseLeave', x: cx, y: cy });
    });
    phases.click = await tallyDuring(log, () => L.click(wc, cx, cy));
    phases.mouseWheel = await tallyDuring(log, async () => {
      for (let i = 0; i < 2; i += 1) {
        wc.sendInputEvent({ type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -60, canScroll: true });
        await sleep(20);
      }
    });
    phases.typeABC = await tallyDuring(log, () => L.typeText(wc, 'abc'));
    phases.tabKey = await tallyDuring(log, () => L.pressKey(wc, 'Tab'));
    phases.controlScriptedGesture = await tallyDuring(log, () =>
      wc.executeJavaScript(`document.getElementById('area').focus(); true`, /* userGesture */ true));
    phases.controlSyntheticDomEvents = await tallyDuring(log, () =>
      L.evalMain(
        wc,
        `document.getElementById('text').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         document.getElementById('text').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); true`,
      ));

    const typedValue = await L.evalMain(wc, `document.getElementById('text').value`);
    data.samples = samples;
    data.typedValueAfterSequence = typedValue;

    record(rows, 'B1 idle page produces no input events', phases.idle.tally, phases.idle.total === 0);
    record(rows, 'B1 mouseMove x5: which events fire', phases.mouseMove.tally,
      countOf(phases.mouseMove, 'input-event', 'mouseMove') === 5,
      'input-event includes mouseMove (so it must only stamp a time; see S1 for rate under real input)');
    record(rows, 'B1 mouseMove: before-mouse-event count', countOf(phases.mouseMove, 'before-mouse-event', 'mouseMove'), null);
    record(rows, 'B1 mouseEnter/mouseLeave: which events fire', phases.mouseEnterLeave.tally, null);
    record(rows, 'B1 click (mouseDown+mouseUp): which events fire', { tally: phases.click.tally, order: phases.click.order },
      countOf(phases.click, 'input-event', 'mouseDown') === 1 && countOf(phases.click, 'input-event', 'mouseUp') === 1);
    record(rows, 'B1 mouseWheel x2: which events fire', phases.mouseWheel.tally, null);
    record(rows, 'B1 typing "abc" (keyDown+char+keyUp per character): which events fire', { tally: phases.typeABC.tally, order: phases.typeABC.order },
      countOf(phases.typeABC, 'input-event', 'rawKeyDown') === 3 && countOf(phases.typeABC, 'input-event', 'char') === 3 &&
        countOf(phases.typeABC, 'input-event', 'keyUp') === 3 && countOf(phases.typeABC, 'before-input-event', 'keyDown') === 3 &&
        countOf(phases.typeABC, 'before-input-event', 'char') === 0,
      'input-event reports key presses as rawKeyDown/char/keyUp; before-input-event as keyDown/keyUp (never char)');
    record(rows, 'B1 Tab key (keyDown+keyUp): which events fire', phases.tabKey.tally, null);
    record(rows, 'B1 control: executeJavaScript(userGesture=true) produces no input events', phases.controlScriptedGesture.tally,
      phases.controlScriptedGesture.total === 0);
    record(rows, 'B1 control: page-synthesised DOM events produce no input events', phases.controlSyntheticDomEvents.tally,
      phases.controlSyntheticDomEvents.total === 0);
    record(rows, 'B1 the typed characters reached the page', typedValue, typeof typedValue === 'string' && typedValue.includes('abc'));

    const totals = {};
    for (const key of ['mouseMove', 'mouseEnterLeave', 'click', 'mouseWheel', 'typeABC', 'tabKey']) {
      for (const [src, types] of Object.entries(phases[key].tally)) {
        totals[src] ??= {};
        for (const [type, n] of Object.entries(types)) totals[src][type] = (totals[src][type] ?? 0) + n;
      }
    }
    data.scriptedSequenceTotals = totals;
    record(rows, 'B1 totals for the scripted sequence (5 moves, enter/leave, click, 2 wheel, "abc", Tab)', totals, null);
    L.dispose(win, { view, wc });
  }

  // -------------------------------------------------------------------------------------
  // B2: input inside a cross-site iframe (parent a.test, child b.test)
  // -------------------------------------------------------------------------------------
  {
    const { view, wc } = await L.openTab(win, fixture.url('/iframe-parent.html', 'a.test'));
    const { log, samples } = observeInput(wc);
    const child = await h.pollUntil(() => wc.mainFrame.frames.find((f) => f.url.includes('iframe-child.html')), { timeoutMs: 8000 });
    await h.pollUntil(() => child.executeJavaScript(`Boolean(document.getElementById('child-text'))`).catch(() => false), { timeoutMs: 8000 });
    const crossProcess = child.processId !== wc.mainFrame.processId;

    const iframeBox = await L.evalMain(
      wc,
      `(() => { const f = document.getElementById('child'); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, clientLeft: f.clientLeft, clientTop: f.clientTop }; })()`,
    );
    const inChild = await child.executeJavaScript(
      `(() => { const r = document.getElementById('child-text').getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`,
    );
    const abs = { x: iframeBox.x + iframeBox.clientLeft + inChild.cx, y: iframeBox.y + iframeBox.clientTop + inChild.cy };
    const hitTag = await L.evalMain(wc, `document.elementFromPoint(${abs.x}, ${abs.y}).tagName`);
    data.iframe.geometry = { iframeBox, inChild, abs, parentHitTest: hitTag, crossProcess, childUrl: child.url };
    record(rows, 'B2 child frame is a cross-process frame; target point hits the <iframe> in the parent', { crossProcess, hitTag, abs },
      crossProcess && hitTag === 'IFRAME');

    const childState = () =>
      child.executeJavaScript(`({ active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), value: document.getElementById('child-text').value })`);
    const parentActive = () => L.evalMain(wc, `document.activeElement && (document.activeElement.id || document.activeElement.tagName)`);
    const childBeacons = () => fixture.beacons.filter((b) => b.query.event === 'child-input').length;

    // Route 1: sendInputEvent mouseDown/mouseUp at the iframe coordinates, then typing.
    // Wait for the child's hit-test data to reach the browser first, and click up to 3 times, so a negative
    // result cannot be blamed on a click that arrived too early.
    await sleep(1000);
    const beaconsBefore1 = childBeacons();
    let route1Clicks = 0;
    const clickResult = await tallyDuring(log, async () => {
      while (route1Clicks < 3) {
        route1Clicks += 1;
        await L.click(wc, abs.x, abs.y);
        if ((await childState()).active === 'child-text') break;
        await sleep(300);
      }
    });
    const afterClick = { clicksSent: route1Clicks, child: await childState(), parentActive: await parentActive() };
    const typeResult = await tallyDuring(log, () => L.typeText(wc, 'xy'));
    const afterType = { child: await childState(), parentActive: await parentActive(), childInputBeacons: childBeacons() - beaconsBefore1 };
    data.iframe.route1_sendInputEvent = { click: clickResult, afterClick, type: typeResult, afterType };
    record(rows, 'B2 route 1: sendInputEvent click at the iframe coordinates: did the child input get focus?', afterClick,
      afterClick.child.active === 'child-text', 'expected by hypothesis; refuted if the child input stays unfocused');
    record(rows, 'B2 route 1: parent webContents events during that click', clickResult.tally, null);
    record(rows, 'B2 route 1: typed "xy" with sendInputEvent: did the child receive it?', afterType, afterType.child.value.includes('xy'),
      'REFUTED if it fails: sendInputEvent feeds the root widget only, so it cannot drive a cross-process child');
    record(rows, 'B2 route 1: parent webContents events during typing', typeResult.tally, null);

    // Route 2: Chrome DevTools Protocol input, which Chromium routes to the right frame (OOPIF input router).
    // A mouseMoved first and `buttons` on the press matter: a bare mousePressed did not focus the child input.
    let cdp = { attached: false };
    try {
      wc.debugger.attach('1.3');
      cdp.attached = true;
      const beaconsBefore3 = childBeacons();
      let clicksNeeded = false;
      const cdpClick = await tallyDuring(log, async () => {
        clicksNeeded = await L.cdpFocusChildInput(wc, child, '#child-text', abs.x, abs.y);
      });
      const afterCdpClick = { child: await childState(), parentActive: await parentActive() };
      const cdpType = await tallyDuring(log, () => L.cdpType(wc, 'rs'));
      const afterCdpType = { child: await childState(), childInputBeacons: childBeacons() - beaconsBefore3 };
      cdp = { attached: true, clicksNeeded, click: cdpClick, afterClick: afterCdpClick, type: cdpType, afterType: afterCdpType };
      record(rows, 'B2 route 2 (CDP Input.dispatch*): click focused the child input', { clicksNeeded, ...afterCdpClick }, afterCdpClick.child.active === 'child-text',
        'tally below covers every click attempt; clicksNeeded > 1 means the first click was routed to the parent');
      record(rows, 'B2 route 2: typed "rs" reached the child input', afterCdpType, afterCdpType.child.value.includes('rs') && afterCdpType.childInputBeacons >= 2);
      record(rows, 'B2 route 2: parent webContents events during the CDP click', cdpClick.tally, null);
      record(rows, 'B2 route 2: parent webContents events during CDP typing', cdpType.tally, null);
    } catch (error) {
      cdp.error = String(error.message ?? error);
      record(rows, 'B2 route 2 (CDP) failed', cdp.error, null);
    } finally {
      try {
        wc.debugger.detach();
      } catch {
        /* not attached */
      }
    }
    data.iframe.route2_cdp = cdp;

    // Route 3: focus the child's input from the main process (frame.executeJavaScript), then type with sendInputEvent.
    await child.executeJavaScript(`document.activeElement.blur(); true`, false);
    await sleep(50);
    const beaconsBefore2 = childBeacons();
    await child.executeJavaScript(`document.getElementById('child-text').focus(); true`, false);
    await sleep(100);
    const focusedState = { child: await childState(), parentActive: await parentActive() };
    const type2 = await tallyDuring(log, () => L.typeText(wc, 'pq'));
    const afterType2 = { child: await childState(), childInputBeacons: childBeacons() - beaconsBefore2 };
    data.iframe.route3_focusViaFrameThenSendInputEvent = { focusedState, type: type2, afterType2 };
    record(rows, 'B2 route 3: child input focused via frame.executeJavaScript, then typed "pq" with sendInputEvent', { focusedState, afterType2 },
      afterType2.child.value.includes('pq'), 'refuted if the child value does not change');
    record(rows, 'B2 route 3: parent webContents events during that typing', type2.tally, null);
    data.iframe.finalChildValue = (await childState()).value;
    data.iframe.samples = samples;
    L.dispose(win, { view, wc });
  }

  return data;
}

module.exports = { run };
