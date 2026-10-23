# Phase 5 manual checks

These are the checks of Phase 5 (settings, privacy and control) that need a person: real sites, your own history, a site you are signed in to, a screen reader, and the packaged build. Automated tests cover the same features on synthetic data; this is the hands-on pass. **You run them yourself.**

For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for and send it back. A screenshot helps when the problem is visual.

## Before you start

- **Build:** run sections A–F in `npm run dev` from the repository root, and section H in the packaged build (`release\win-unpacked\Veltriva.exe`, made by `npm run package:dir`).
- **Use a throwaway profile for `npm run dev`.** In PowerShell:

  ```powershell
  $env:VELTRIVA_USER_DATA_DIR = "$env:TEMP\veltriva-manual-5"; npm run dev
  ```

  Keep that PowerShell window: every later `npm run dev` in this checklist runs in it, so the variable stays set.
- **Quit** means closing the window with its ✕ and waiting until `npm run dev` returns.
- **Sites:** well-known public pages. Section C signs out of one site you choose; nothing here pays.

---

## A. First run and Settings (M5.1)

### A1. Welcome

- [ ] 1. Start with the throwaway profile empty (delete `%TEMP%\veltriva-manual-5` first).
  - **Expected:** the first tab is "Welcome to Veltriva", with DuckDuckGo, Balanced and "Show me first" chosen.
- [ ] 2. Choose another engine and preset, choose "Start now", then press **Start browsing**.
  - **Expected:** the tab becomes the new-tab page. A search from the address bar goes to the engine you chose, and the sidebar shows no preview notice.
- [ ] 3. Quit and start again.
  - **Expected:** no Welcome this time; your tab comes back.
- **If it fails, report:** the step, and what the page or the address bar did instead.

### A2. Settings

- [ ] 1. Press the gear at the foot of the sidebar, then press it again from another tab.
  - **Expected:** one Settings tab, selected both times.
- [ ] 2. Choose each preset in turn and read its description.
  - **Expected:** each says in plain words when a tab is unloaded, how many stay in Tabs, and when Sleeping tabs are archived.
- [ ] 3. Open **Advanced**, type `0` in "Tabs kept in Tabs" and press Enter; then type `3` in "Memory is low below".
  - **Expected:** each time a sentence under the field says what is allowed, and the value doesn't change.
- [ ] 4. Choose **Another engine**, enter `http://example.com/?q={searchTerms}` and press **Use it**.
  - **Expected:** refused, with a sentence saying it needs https.
- [ ] 5. Choose **Start with a new tab**, open three pages and pin one, quit, and start again.
  - **Expected:** a new tab is selected, the pinned tab is there, and the other two are in the Archive. Set it back to **Continue where you left off**.
- [ ] 6. Turn on **Pause memory**, visit a page with an unusual word in its title, turn Pause memory off, then search the memory (Ctrl+Shift+K) for that word.
  - **Expected:** it isn't found.
- **If it fails, report:** the step, the value you typed, and what you saw.

### A3. Site rules

- [ ] 1. Right-click a tab of a site you use, and choose **Don't remember ‹site›**.
  - **Expected:** Settings ▸ Site rules lists the site with "Don't remember" ticked. A page on it you visit next is not found by the palette, and closing its tab leaves nothing for Ctrl+Shift+T.
- [ ] 2. Choose **Remember ‹site› again** from the same menu.
  - **Expected:** the rule goes from the list (unless the site is also protected).
- **If it fails, report:** the site and the step.

---

## B. JS dialogs, "Leave page?" and Print (M5.0)

- [ ] 1. On a page, open DevTools (F12) and run `setTimeout(() => alert('hello'), 5000)` in the console; switch to another tab within 5 seconds.
  - **Expected (a known limitation):** the box appears anyway and blocks the whole window until you press OK. Its title says "Veltriva Browser", and it doesn't name the site. Pressing OK gives the window back.
- [ ] 2. On a site with a form that warns about unsaved changes (a draft in a web mail, say), type something, then type another address in the address bar and press Enter.
  - **Expected:** a "Leave page?" strip in the toolbar. **Stay** keeps the page and your text; **Leave** goes to the new address.
- [ ] 3. Press Ctrl+P on a page, and choose **Print…** from a page's right-click menu.
  - **Expected:** Windows' print dialog both times. Cancel prints nothing.
- **If it fails, report:** the site, the step, and a screenshot of what appeared.

---

## C. Clearing data (M5.2)

- [ ] 1. Settings ▸ Clear data: choose **The last hour**, keep **Pages you visited**, press **Clear…**, then **Clear**.
  - **Expected:** a sentence says how many pages and visits went. The palette no longer finds pages from the last hour, and still finds older ones.
- [ ] 2. Sign in to a site you don't mind signing in to again. Then **Forget a site**: type it, keep both boxes ticked, **Forget…**, **Forget**.
  - **Expected:** you are signed out of it on the next visit, and the palette finds none of its pages.
- [ ] 3. In the palette, highlight a result and press Shift+Delete.
  - **Expected:** the footer says it was removed, and it disappears from the results.
- [ ] 4. Allow a site to send notifications, then Settings ▸ Site permissions: change it to **Blocked**, then **Remove** it.
  - **Expected:** the list follows each change; after Remove, the site asks again the next time.
- [ ] 5. Settings ▸ Memory: set "Keep pages you visited for" to `30`, leave the field, then reopen Settings.
  - **Expected:** 30 is kept.
- **If it fails, report:** the step, and what the page said.

---

## D. Diagnostics (M5.3)

- [ ] 1. Open a few heavy pages (a video site, a map), then go to `veltriva://diagnostics`.
  - **Expected:** "Memory per tab" lists them heaviest first, in MB; an unloaded tab shows "—". The database's size and last backup are shown.
- [ ] 2. Press **Export diagnostics…** and save; open the file in a text editor.
  - **Expected:** no page title and no address in it. With **Include the addresses of open tabs** ticked, a second export holds the addresses.
- [ ] 3. Press **Show the log folder**.
  - **Expected:** Explorer opens the profile's `logs` folder.
- **If it fails, report:** the step, and for 2 the lines that hold what they shouldn't.

## E. Diagnostic logging (M5.3)

- [ ] 1. Type an address that can't load, such as `http://127.0.0.1:9/`, then open `logs\veltriva.log` in the profile folder.
  - **Expected:** a `tab.loadFailed` line with `"url":"[hidden]"`.
- [ ] 2. Turn on Settings ▸ Diagnostics ▸ **Diagnostic logging**, load the same address, and look again.
  - **Expected:** the new line has the address. Turn it off again.
- **If it fails, report:** the two lines.

## F. Scroll restore (M5.3)

- [ ] 1. Scroll far down a long article, switch to another tab, quit, and start again; then select the article's tab.
  - **Expected:** it loads where you had scrolled.
- [ ] 2. Do the same on a sign-in page (with a password field).
  - **Expected:** it loads at the top.
- **If it fails, report:** the site and how far it was off.

## G. A screen reader (Narrator or NVDA)

- [ ] 1. In Settings, move through the controls with Tab and the arrow keys.
  - **Expected:** each control's name and what it does are read. A refused value's sentence is read when it appears. After **Clear…**, the focus is on the **Clear** button of the question.
- **If it fails, report:** the control, and what was read.

---

## H. The packaged build

Build it first with `npm run package:dir`. This uses the real profile, `%APPDATA%\Veltriva`, so the steps change nothing you'd miss.

- [ ] 1. Run `release\win-unpacked\Veltriva.exe`, open Settings, choose another preset and then Balanced again, then close the window.
  - **Expected:** Settings opens and keeps the choice; within a few seconds no `Veltriva.exe` is left in Task Manager.
- **If it fails, report:** the step, any dialog text, and whether `Veltriva.exe` was still running.

---

## When you're done

- Delete `%TEMP%\veltriva-manual-5`, the throwaway profile.
- Send back the unticked items with what you saw.
