import { describe, expect, it } from 'vitest';

import { FullscreenController, NOTICE_MS, NOTICE_READY_TIMEOUT_MS } from './fullscreen';

function setup(url = 'https://video.example/watch') {
  const calls: string[] = [];
  const timers: { callback: () => void; ms: number }[] = [];
  let changes = 0;
  /** The OS window. Chromium makes it fullscreen by itself when a page goes fullscreen. */
  const window = { fullscreen: false };
  const controller = new FullscreenController({
    layout: {
      setFullscreen: (on) => calls.push(`fullscreen:${String(on)}`),
      raiseShell: () => calls.push('raise'),
      lowerShell: () => calls.push('lower'),
    },
    window: {
      isFullScreen: () => window.fullscreen,
      setFullScreen: (on) => {
        window.fullscreen = on;
        calls.push(`window:${String(on)}`);
      },
    },
    urlOf: () => url,
    focusPage: (tabId) => calls.push(`focus:${tabId}`),
    onChange: () => {
      changes += 1;
    },
    schedule: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => {
      const index = timers.indexOf(timer as unknown as (typeof timers)[number]);
      if (index !== -1) {
        timers.splice(index, 1);
      }
    },
  });
  /** Runs the one pending timer, checking its delay. */
  const fire = (ms: number): void => {
    expect(timers).toHaveLength(1);
    const [timer] = timers.splice(0, 1);
    expect(timer?.ms).toBe(ms);
    timer?.callback();
  };
  return { controller, calls, timers, fire, window, changes: () => changes };
}

describe('FullscreenController', () => {
  it('fills the window, names the origin, raises the shell once it shows the notice, then lowers it', () => {
    const { controller, calls, fire } = setup('https://paypal.com@evil.example/x');
    controller.update('tab-1');
    expect(controller.state()).toEqual({ tabId: 'tab-1', origin: 'evil.example', notice: true });
    expect(calls).toEqual(['fullscreen:true']);
    expect(controller.shellRaised()).toBe(false);

    controller.noticeShown();
    expect(calls).toEqual(['fullscreen:true', 'raise']);
    expect(controller.shellRaised()).toBe(true);

    fire(NOTICE_MS);
    expect(controller.state()).toEqual({ tabId: 'tab-1', origin: 'evil.example', notice: false });
    expect(calls).toEqual(['fullscreen:true', 'raise', 'lower', 'focus:tab-1']);
    expect(controller.shellRaised()).toBe(false);
  });

  it('raises the shell anyway when it does not confirm the notice in time', () => {
    const { controller, calls, fire } = setup();
    controller.update('tab-1');
    fire(NOTICE_READY_TIMEOUT_MS);
    expect(calls).toEqual(['fullscreen:true', 'raise']);
    fire(NOTICE_MS);
    expect(controller.state()?.notice).toBe(false);
  });

  it('hides the notice early on a click, and only once', () => {
    const { controller, calls, timers } = setup();
    controller.update('tab-1');
    controller.noticeShown();
    controller.dismissNotice();
    controller.dismissNotice();
    controller.noticeShown();
    expect(calls).toEqual(['fullscreen:true', 'raise', 'lower', 'focus:tab-1']);
    expect(timers).toHaveLength(0);
  });

  it('leaves fullscreen: back to the chrome, the shell lowered, no timers', () => {
    const { controller, calls, timers } = setup();
    controller.update('tab-1');
    controller.noticeShown();
    controller.update(null);
    expect(controller.state()).toBeNull();
    expect(calls).toEqual(['fullscreen:true', 'raise', 'lower', 'fullscreen:false']);
    expect(timers).toHaveLength(0);
  });

  it('leaves fullscreen before the notice was even raised', () => {
    const { controller, calls, timers } = setup();
    controller.update('tab-1');
    controller.update(null);
    expect(calls).toEqual(['fullscreen:true', 'fullscreen:false']);
    expect(timers).toHaveLength(0);
  });

  it('takes the window out of fullscreen with the page, which Chromium skips when the tab closes', () => {
    const { controller, calls, window } = setup();
    window.fullscreen = true;
    controller.update('tab-1');
    controller.update(null);
    expect(calls).toEqual(['fullscreen:true', 'fullscreen:false', 'window:false']);
    expect(window.fullscreen).toBe(false);
  });

  it("keeps the user's own fullscreen (F11) when a page leaves its fullscreen", () => {
    const { controller, calls, window } = setup();
    controller.toggleWindow();
    controller.update('tab-1');
    controller.update(null);
    expect(calls).toEqual(['window:true', 'fullscreen:true', 'fullscreen:false']);
    expect(window.fullscreen).toBe(true);

    // F11 again ends it; after that, a page's fullscreen is the page's alone again.
    controller.toggleWindow();
    expect(window.fullscreen).toBe(false);
    window.fullscreen = true;
    controller.update('tab-2');
    controller.update(null);
    expect(window.fullscreen).toBe(false);
  });

  it('labels pages that are not on a web host plainly', () => {
    const { controller } = setup('file:///C:/movie.html');
    controller.update('tab-1');
    expect(controller.state()?.origin).toBe('A local file');
  });
});
