# Phase 4 manual checks

These are the checks of Phase 4 (search and the memory) that need a person: your own browsing history, real sites, a screen reader or keyboard in your hands, and a quiet machine for the benchmark. Automated tests cover the same features on synthetic data; this is the hands-on pass. **You run them yourself.**

For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for and send it back. A screenshot helps when the problem is visual.

## Before you start

- **Build:** run sections A–D in `npm run dev` from the repository root, and section E in the packaged build (`release\win-unpacked\Veltriva.exe`, made by `npm run package:dir`).
- **Use a throwaway profile for `npm run dev`.** In PowerShell:

  ```powershell
  $env:VELTRIVA_USER_DATA_DIR = "$env:TEMP\veltriva-manual-4"; npm run dev
  ```

  Keep that PowerShell window: every later `npm run dev` in this checklist runs in it, so the variable stays set.
- **Quit** means closing the window with its ✕ and waiting until `npm run dev` returns.
- **Sites:** well-known public pages only, as in earlier phases. Nothing here signs in or pays.
- **Phase 4 runs on Electron 45** (Chromium 156). Section A rechecks a few things the upgrade could have changed.

---

## A. Electron 45 (Phase 4 Step 0)

### A1. Everyday browsing still works

- [ ] 1. Open a YouTube video, play it, make it full screen (F or the player's button), then press Esc.
  - **Expected:** it plays with sound; the "is now full screen" notice shows for a moment; Esc leaves full screen.
- [ ] 2. Open a PDF (any public one), find a word with Ctrl+F, then press Esc.
  - **Expected:** the PDF shows; the find bar finds the word; Esc closes the bar and the match stays selected in the page.
- [ ] 3. Download a small file (any public image is fine).
  - **Expected:** it appears in the downloads panel and lands in your Downloads folder.
- [ ] 4. Press F12 on a page, then close DevTools with its ✕.
  - **Expected:** DevTools opens in its own window and closes cleanly; the app keeps running.
- **If it fails, report:** the step, the site, and what you saw instead.

---

## B. The memory palette (M4.2)

Visit at least 10 different pages first (docs, news, a few searches), open 3 or 4 of them as tabs, move one tab to Sleeping and archive another (the tab's right-click menu), so the memory has something in each place.

### B1. Opening it

- [ ] 1. Press **Ctrl+Shift+K** while a page has the keyboard.
  - **Expected:** a panel opens over the page, with a field ("Search your tabs and history") that already has the keyboard; the page stays visible (and a playing video keeps playing) under a dim layer; the toolbar and sidebar look as before.
- [ ] 2. Close it with **Esc**, then open it with the **Search memory…** button at the top of the sidebar.
  - **Expected:** Esc closes it and the page has the keyboard again (type into a text field on the page to check); the button opens the same panel.
- [ ] 3. With nothing typed, look at the list.
  - **Expected:** the pages you use most and most recently, open tabs among them, each with its site and "visited … ago", and a state label where a tab shows it: **Open**, **Sleeping** or **Archived**.

### B2. Finding things

- [ ] 1. Type **a few partial words** of the archived tab's title (for example the first 3 letters of two of its words).
  - **Expected:** it is in the list, labelled **Archived**, with the typed parts highlighted in its title.
- [ ] 2. Press **Enter**.
  - **Expected:** the palette closes, the tab is back in the Tabs list next to the current tab, selected, on its page.
- [ ] 3. Open the palette, type part of the Sleeping tab's title, and press Enter.
  - **Expected:** it comes back from Sleeping, selected.
- [ ] 4. Open the palette, type part of a page that is open in a tab, and press **Ctrl+Enter**.
  - **Expected:** a new tab opens with that page; the other tab stays.
- [ ] 5. Type something that matches nothing (for example `zzqqxx`).
  - **Expected:** "No pages match", no error.
- [ ] 6. Type characters a search engine treats specially: `-docs "news OR (x`.
  - **Expected:** no error and no surprise: the punctuation is ignored, and the results are the pages with words starting with `docs`, `news` and `or` (a one-letter word like `x` doesn't narrow the search), or "No pages match".
- **If it fails, report:** what you typed, what the list showed, and a screenshot.

### B3. Filters and keys

- [ ] 1. With the palette open, press **Tab** a few times, then **Shift+Tab**.
  - **Expected:** the filter row moves through All, Open, Sleeping, Archived, Today, This week and back; the list changes to match (Archived shows only archived tabs).
- [ ] 2. Type `site:` and a site you visited, then a word, for example `site:wikipedia.org history`.
  - **Expected:** a "site: wikipedia.org" chip appears next to the field and every result is from that site; a click on the chip removes it (and the `site:` word).
- [ ] 3. Use **Up**, **Down**, **PageUp** and **PageDown**.
  - **Expected:** the highlighted result moves; Down from the last goes back to the first.
- [ ] 4. Press **Alt+S** (or the **Score details** button).
  - **Expected:** a small panel shows how the highlighted result was scored (Text match, Frecency, Title words, …), with two decimals; Alt+S again hides it.
- [ ] 5. Optional, with a screen reader (Narrator: Ctrl+Win+Enter): move through the results.
  - **Expected:** each result is read with its title and state ("Archived", "Open"), and the field announces the highlighted one.
- **If it fails, report:** the key, what happened, and the screen reader's words if one was on.

---

## C. The address bar's memory (M4.2)

- [ ] 1. Click the address bar and type 3 or more letters of a page you visited.
  - **Expected:** up to 6 suggestions hang under the address bar over the page, with the typed parts highlighted; nothing else changes.
- [ ] 2. Type part of a page that is open in another tab.
  - **Expected:** that suggestion says **Switch to tab**; pressing Down to it and Enter selects that tab instead of loading the page again.
- [ ] 3. Choose a suggestion for a page no tab shows.
  - **Expected:** the current tab goes to that page.
- [ ] 4. Type something, press **Esc** once, then again.
  - **Expected:** the first Esc closes the suggestions and keeps your text; the second puts the tab's address back.
- [ ] 5. Type a full address (`example.com`) and press Enter without choosing a suggestion.
  - **Expected:** it goes to that address, as before Phase 4.
- **If it fails, report:** what you typed, what the list showed, and which tab ended up where.

---

## D. The Archive list (M4.2)

- [ ] 1. Open the **Archive** section of the sidebar.
  - **Expected:** every archived tab is listed, newest first, with when and by whom it was archived (not only the newest 200).
- [ ] 2. Scroll the list quickly to the end and back.
  - **Expected:** it scrolls smoothly; rows may say "Loading…" for a moment and then show their tabs.
- [ ] 3. Click an archived tab (or focus it and press Enter).
  - **Expected:** it comes back to the Tabs list, selected.
- **If it fails, report:** how many tabs the Archive said it had, and what the list did.

To try it with a large Archive, use the packaged build after real use, or ask for the E2E fixture that seeds 10,000 archived tabs.

---

## E. The packaged build

Build it first with `npm run package:dir` (if Windows says a file in `release` is in use, restart the PC and try again). This uses the real profile, `%APPDATA%\Veltriva`.

- [ ] 1. Run `release\win-unpacked\Veltriva.exe`, visit a few pages, archive one tab, press Ctrl+Shift+K and find it by part of its title, then close the window.
  - **Expected:** it is found and comes back on Enter; within a few seconds no `Veltriva.exe` is left in Task Manager.
- **If it fails, report:** the step, any dialog text, and whether `Veltriva.exe` was still running.

---

## F. The search benchmark, on a quiet machine

The measured search latency is in `docs/benchmarks/search.md`, taken while this laptop was busy with other work. To repeat it with nothing else running (close other apps first; about 15 minutes):

```bash
npm run bench:search
```

- [ ] 1. It ends with `1 passed`, and a new `docs/benchmarks/data/phase-4-search-…-first-after-5000ms.json.gz` exists.
- [ ] 2. Run the summarizer on it (`node tests/benchmarks/summarize-search.mjs <that file>`).
  - **Expected:** every "§5.4 targets" line says **met**.
- **If it fails, report:** the summarizer's output, or the error.

While the machine is quiet, also run the Phase 3 memory measurement that is still owed: `npm run bench:memory` (over an hour; see `docs/benchmarks/phase-3-memory.md`).

---

## When you're done

- Delete `%TEMP%\veltriva-manual-4`, the throwaway profile.
- Send back the unticked items with what you saw.
