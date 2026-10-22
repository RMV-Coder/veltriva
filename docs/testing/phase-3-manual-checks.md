# Phase 3 manual checks

These are the checks of Phase 3 (the tab lifecycle) that need a person: real pages, real time passing, your own hands on the sidebar and a real laptop's memory. Automated tests cover the same features on an accelerated clock; this is the hands-on pass. **You run them yourself.**

For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for and send it back. A screenshot helps when the problem is visual.

## Before you start

- **Build:** run sections A–E in `npm run dev` from the repository root, and section F in the packaged build (`release\win-unpacked\Veltriva.exe`, made by `npm run package:dir`).
- **Use a throwaway profile for `npm run dev`.** In PowerShell:

  ```powershell
  $env:VELTRIVA_USER_DATA_DIR = "$env:TEMP\veltriva-manual-3"; npm run dev
  ```

  Keep that PowerShell window: every later `npm run dev` in this checklist runs in it, so the variable stays set.
- **Quit** means closing the window with its ✕ and waiting until `npm run dev` returns.
- **Automation is slow on purpose.** With the shipped settings (Balanced), a hidden tab is unloaded after an hour, a tab moves to Sleeping after 2 hours of your active use, and a Sleeping tab is archived after 3 days of use; for your first 3 active days automation only *previews* its moves. There is no settings page until Phase 5, so the sections that need automation shorten those times in the throwaway profile's settings first. With the app **quit**, define this once in the PowerShell window, at the repository root:

  ```powershell
  function vlife($json) { node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const row=db.prepare('SELECT json FROM settings WHERE id = 1').get();const doc=row?JSON.parse(row.json):{};doc.lifecycle={...(doc.lifecycle??{}),...JSON.parse(process.argv[2])};db.prepare('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(JSON.stringify(doc));console.log(doc.lifecycle)" "$env:TEMP\veltriva-manual-3\veltriva.db" $json }
  ```

  It changes only the lifecycle section of that profile's settings. The database exists after the first start, so start and quit the app once before using it.
- **Automation needs a moment.** It does nothing in the first 2 minutes after a start, then looks every minute. "Wait 3 minutes" below means: leave the app running and use another tab or another app.
- **Sites:** well-known public pages only, as in earlier phases. Nothing here signs in or pays.

---

## A. Unloading a background tab (M3.1)

### A1. A tab you come back to reloads where you left it
- [ ] 1. Quit, then run `vlife '{"preview":"off","overrides":{"discardAfterMs":60000}}'` and start the app. Open `https://en.wikipedia.org/wiki/Web_browser`, scroll halfway down, and open `https://example.com` in a new tab.
- [ ] 2. Wait 3 minutes on the example.com tab.
- [ ] 3. Hover the Wikipedia tab in the sidebar.
  - **Expected:** the tooltip says "Unloaded to save memory — click to reload".
- [ ] 4. Select it.
  - **Expected:** it reloads (a short loading indicator) and comes back at the place you scrolled to. Back still works.
- **If it fails, report:** the tooltip text, and where the page came back.

### A2. What is never unloaded
- [ ] 1. Same settings. In a tab, play a YouTube video (or any page with sound), then switch to another tab and wait 3 minutes.
  - **Expected:** the video keeps playing; hovering its tab says "Kept awake: playing audio" (or "playing media").
- [ ] 1b. Mute that video (the player's own mute button), switch away, wait 3 minutes.
  - **Expected:** still playing, muted: the tab is kept ("Kept awake: playing media", shown once automation has asked the page).
  - **Known limit:** a muted video inside a player *embedded from another site* (for example a YouTube video embedded in a blog post) is not seen, and that tab may be unloaded; with its sound on, it is kept. Note it if it surprises you in daily use.
- [ ] 2. On a page with a text field you can type in (for example a search box that stays on the page, or a comment field), type a few words without sending them, switch away, wait 3 minutes.
  - **Expected:** the tab is still loaded and your text is still there.
- [ ] 3. Open a page that asks "Leave site?" when you close it with unsaved changes (for example an online text editor with a draft), type something, switch away, wait 3 minutes.
  - **Expected:** the tab is still loaded; its tooltip says it reported unsaved changes.
- **If it fails, report:** which page, and what happened to the tab or your text.

### A3. Fullscreen and the restart (from M3.1's review)
- [ ] 1. Play a video fullscreen (the page's own fullscreen button). Leave fullscreen with **Esc**, then again with **F11**, then by switching tabs with **Ctrl+Tab**.
  - **Expected:** each time, the window and the sidebar come back as they were; the toolbar is not covered.
- [ ] 2. Let a tab be unloaded (A1), quit, start again, and select that tab.
  - **Expected:** it loads its page as after any restart, at the same address, with Back working.
- **If it fails, report:** the step and what was left on screen.

---

## B. Automation (M3.2)

### B1. Under memory pressure (this laptop)
- [ ] 1. With your usual browsing (15 or more tabs), leave some in the background for 15 minutes or more while you work in others.
  - **Expected:** a background tab may reload when you select it; its tooltip and the Activity view (the **Activity** button, a scroll icon, at the bottom of the sidebar) say "Unloaded because memory was low" or "very low". The tab you use never reloads under you.
- **If it fails, report:** what reloaded and when, and what the Activity view says.

### B2. Waking up
- [ ] 1. Lock the screen or sleep the laptop for an hour or more, then come back.
  - **Expected:** nothing happens at once: no burst of reloads, no tabs moving the moment you return.
- **If it fails, report:** what moved or reloaded, and how long after you returned.

---

## C. Sleeping and the Archive (M3.3)

### C1. By hand
- [ ] 1. Right-click a tab → **Move to Sleeping**.
  - **Expected:** it leaves the tab list and appears under **Sleeping** (count 1); a toast says "Moved to Sleeping" with **Undo**. The summary at the bottom says "Sleeping 1 · Archived today 0".
- [ ] 2. Click **Undo**.
  - **Expected:** the tab is back where it was.
- [ ] 3. Move it to Sleeping again, select another tab, then click the Sleeping row.
  - **Expected:** the tab comes back next to the tab you were on, selected, with its page as it was.
- [ ] 4. Right-click a tab → **Archive tab**. Open **Archive** in the sidebar.
  - **Expected:** under "Recently archived" it shows with "… · by you", and "Archived today 1". Clicking it reopens the page next to the current tab; Back works.
- [ ] 5. Try **Move to Sleeping** on a pinned tab.
  - **Expected:** the item is greyed out.
- **If it fails, report:** the step, the counts, and where the tab ended up.

### C2. Leave page?
- [ ] 1. On a page that warns before leaving (an online editor with a draft), type something, then press **Ctrl+W**.
  - **Expected:** the toolbar asks "Leave ‹site›? Changes you made may not be saved." with **Leave** and **Stay**.
- [ ] 2. Click **Stay**, then press Ctrl+W again and click **Leave**.
  - **Expected:** Stay keeps the tab and your text; Leave closes it. **Ctrl+Shift+T** brings the tab back (without the text).
- [ ] 3. Close a page you never touched with the tab's ✕.
  - **Expected:** it closes at once, without asking.
- **If it fails, report:** the site and what was asked or not.

### C3. Automation moves tabs, with Undo
- [ ] 1. Quit, then run `vlife '{"preview":"off","overrides":{"stripCap":3,"shelveAfterEngagedMs":60000,"interactionGuardMs":0}}'` and start the app. Open 6 tabs on different sites and use them for a minute or two, then stay on the last one.
- [ ] 2. Keep using the app (scroll, click) for 3 minutes.
  - **Expected:** the tabs you used least go to Sleeping, all but the 3 most recent unpinned ones; a toast says "Moved N tabs to Sleeping" with Undo; the Activity view lists each move with "Moved to Sleeping — too many open tabs".
- [ ] 3. Click **Undo** in the toast within a minute.
  - **Expected:** they come back in their places, and they are not moved again right away.
- **If it fails, report:** how many moved, which ones, and what the toast and Activity view said.

### C4. After a restart
- [ ] 1. With tabs in Sleeping and the Archive, quit and start again.
  - **Expected:** they are still there, unloaded; a protected tab still shows its shield.
- **If it fails, report:** what was missing.

---

## D. Protection and the "why" (M3.4)

### D1. Protecting a tab and a site
- [ ] 1. Right-click a tab → **Protect from automation**.
  - **Expected:** a shield on the tab; its tooltip says "Protected from automation". With the short times of C3 it never moves or unloads. You can still archive it yourself.
- [ ] 2. Right-click a tab → **Always protect ‹site›**.
  - **Expected:** every tab on that site (also ones you open later, and after a restart) says its site is protected, and automation leaves them alone. **Stop protecting ‹site›** undoes it.
- **If it fails, report:** which tab moved or unloaded anyway.

### D2. Kept awake
- [ ] 1. With A1's short times, leave in the background: a page playing sound, a page you allowed to show notifications (for example `https://permission.site`, Notifications, Allow), and a chat or mail page that changes its title when something arrives.
  - **Expected:** hovering each shows why it is kept: "Kept awake: playing audio", "… the site can send you notifications", "… active in the background". The plain pages beside them unload.
- **If it fails, report:** the page and the tooltip text.

---

## E. Preview, Pause and diagnostics (M3.4)

### E1. Preview on a new profile
- [ ] 1. Delete `%TEMP%\veltriva-manual-3` (a new profile), start the app, quit, run `vlife '{"overrides":{"stripCap":3,"shelveAfterEngagedMs":60000,"interactionGuardMs":0}}'` (preview stays on), and start again. Open 6 tabs and use the app for 3 minutes.
  - **Expected:** nothing moves. The sidebar's footer says "Preview: automation shows what it would move (day 1 of 3)", and the tabs it would move carry a small mark whose tooltip says "Preview: would move to Sleeping".
- [ ] 2. Click **Start now**.
  - **Expected:** within about a minute the marked tabs move, with the usual toast and Undo.
- **If it fails, report:** what moved during preview, and what the sidebar said.

### E2. Pause
- [ ] 1. Click **Pause automation** in the sidebar's footer.
  - **Expected:** the footer says "Automation paused" and the button now reads **Resume automation**; with C3's short times nothing moves or unloads, even after several minutes. Quit and start: still paused.
- [ ] 2. Click **Resume automation**.
  - **Expected:** automation goes on within a few minutes.
- **If it fails, report:** what moved while paused.

### E3. The diagnostics page
- [ ] 1. Type `veltriva://diagnostics` in the address bar.
  - **Expected:** a page of Veltriva's own, "Automation diagnostics", with the regret metric (moves, how many you took back within an engaged hour, the rate), the unloads you reloaded within the hour, your active day and engaged hours, the settings, and the memory it sees. It says it never leaves this machine.
- [ ] 2. After C3, bring a moved tab back from Sleeping at once, then refresh the page.
  - **Expected:** one more regret is counted.
- **If it fails, report:** what the page showed.

---

## F. The packaged build

Build it first with `npm run package:dir`. This uses the real profile, `%APPDATA%\Veltriva`, with the shipped settings.

- [ ] 1. Run `release\win-unpacked\Veltriva.exe`, open a few sites, move one to Sleeping and archive another, and close the window.
- [ ] 2. Run it again.
  - **Expected:** the tabs, Sleeping and the Archive are as you left them; the sidebar shows automation in preview (your first active days).
- [ ] 3. Close the window.
  - **Expected:** within a few seconds no `Veltriva.exe` is left in Task Manager.
- **If it fails, report:** the step, any dialog text, and whether `Veltriva.exe` was still running.

---

## When you're done
- Delete `%TEMP%\veltriva-manual-3`, the throwaway profile.
- Send back the unticked items with what you saw.
