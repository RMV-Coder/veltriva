# Phase 2 manual checks

These are the checks of Phase 2 (persistence and session restore) that need a person: real restarts, real kills, a real window on your screens, and a look at the database the app writes. Automated tests cover the same features; this is the hands-on pass. **You run them yourself.**

For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for and send it back. A screenshot helps when the problem is visual.

## Before you start

- **Build:** run sections A–F in `npm run dev` from the repository root (run `npm run setup` first if the checkout is new), and section G in the packaged build (`release\win-unpacked\Veltriva.exe`, made by `npm run package:dir`).
- **Use a throwaway profile for `npm run dev`.** Sections B and F kill the app and damage its database on purpose. In PowerShell:

  ```powershell
  $env:VELTRIVA_USER_DATA_DIR = "$env:TEMP\veltriva-manual"; npm run dev
  ```

  Keep that PowerShell window: every later `npm run dev` in this checklist runs in it, so the variable stays set. The packaged build ignores the variable and always uses `%APPDATA%\Veltriva`.
- **Quit** means closing the window with its ✕ and waiting until the app has exited (the `npm run dev` command returns).
- **Kill** means ending the app without letting it quit. In a second PowerShell window:

  ```powershell
  Get-Process electron | Where-Object Path -like '*Veltriva*' | Stop-Process -Force
  ```

  That ends only the Electron of this repository. If `npm run dev` doesn't return by itself, press Ctrl+C in its window.
- **Reading the database.** Phase 2 has no history screen yet (search and the history view are Phase 4), so some checks read the file directly. With the app **quit**, define this once in a PowerShell window at the repository root (it needs Node, which `npm run setup` already required):

  ```powershell
  function vq($sql) { node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');console.table(new DatabaseSync(process.argv[1],{readOnly:true}).prepare(process.argv[2]).all())" "$env:TEMP\veltriva-manual\veltriva.db" $sql }
  ```

  Then `vq "SELECT ..."` prints a table. It only reads; it never changes the file.
- **Sites:** only well-known public test pages and big mainstream sites, as in Phase 1. Nothing here signs in or pays.

---

## A. Restart and the window

### A1. Your tabs come back
- [ ] 1. Start the app. Open five tabs: `https://example.com`, `https://en.wikipedia.org/wiki/Web_browser`, `https://permission.site`, `https://httpbin.org/html` and `https://www.iana.org/help/example-domains`.
- [ ] 2. In the Wikipedia tab, follow two links, then press Back once.
- [ ] 3. Pin the example.com tab (right-click it in the sidebar, **Pin**). Drag the permission.site tab to the bottom. Select the httpbin tab.
- [ ] 4. Quit, then start the app again.
  - **Expected:**
    - the same five tabs, in the same order, the pinned one first, with their titles;
    - the httpbin tab is selected and shows its page;
    - the other tabs load only when you select them: each one shows its loading indicator then, not before.
- [ ] 5. Select the Wikipedia tab, then press Back and Forward.
  - **Expected:** Back and Forward walk the same pages as before the restart.
- **If it fails, report:** which tab was missing, out of order, or loaded early, and what Back and Forward did.

### A2. The window opens where it was
- [ ] 1. Make the window smaller, and move it to another place on the screen (or to another monitor, if you have one). Quit and start again.
  - **Expected:** same place, same size.
- [ ] 2. Maximize the window. Quit and start again.
  - **Expected:** it opens maximized. Restoring it (the middle title-bar button) gives back the size from step 1.
- [ ] 3. If you use display scaling other than 100% (Settings → System → Display → Scale), quit and start three times in a row without touching the window.
  - **Expected:** the size never grows or shrinks between starts.
- [ ] 4. If you have two monitors: put the window on the second one, quit, disconnect or turn off that monitor, start again.
  - **Expected:** the window opens on the remaining screen, fully visible.
- **If it fails, report:** your scaling, your monitor layout, and the size or place you got (a screenshot helps).

### A3. One Veltriva at a time
- [ ] 1. With the app running, start it a second time (another `npm run dev` in another window, with the same `VELTRIVA_USER_DATA_DIR`).
  - **Expected:** no second window. Within about two seconds the second start ends by itself and the open window comes to the front, its tabs untouched.
- **If it fails, report:** whether a second window opened, and any error text.

---

## B. Crashes

### B1. A kill, and the notice
- [ ] 1. Open two or three tabs, select one, and wait a few seconds.
- [ ] 2. Kill the app. Start it again.
  - **Expected:**
    - your tabs are back, the selected one loaded;
    - a notice under the toolbar says **"Veltriva didn't close properly last time. Your tabs are back; the others load when you select them."**;
    - **Dismiss** removes it, and it doesn't come back on the next normal start.
- [ ] 3. Open a new tab with any site, then kill the app **within about a second**. Start it again.
  - **Expected:** everything up to about a second before the kill is back. The last tab may be missing; nothing older is.
- **If it fails, report:** what was missing after the restart, and the notice text if it differed.

### B2. Safe mode
- [ ] 1. Start the app, wait until its window shows, then kill it **within a minute of starting**. Do that a second time: start, kill within a minute.
- [ ] 2. Start the app a third time and leave it running.
  - **Expected:**
    - a notice: **"Veltriva closed unexpectedly twice soon after starting, so your tabs are back without loading. Select a tab, or press Reload, to load it."**;
    - every tab is listed, and none has loaded, the selected one included.
- [ ] 3. Press Reload on the selected tab. Then select another tab.
  - **Expected:** each loads when you do that.
- [ ] 4. Quit normally and start again.
  - **Expected:** a normal start: no safe-mode notice, and the selected tab loads by itself.
- **If it fails, report:** the step, and whether any tab loaded by itself in step 2.

---

## C. Recently closed
- [ ] 1. Open three tabs, A, B and C, each with a different site, and in C follow one link.
- [ ] 2. Close C, then B (Ctrl+W).
- [ ] 3. Press Ctrl+Shift+T twice.
  - **Expected:** B comes back, then C, each where it was in the sidebar. In C, Back goes to the page before its link.
- [ ] 4. Close B and C again. Quit, start the app, and press Ctrl+Shift+T twice.
  - **Expected:** the same, after the restart: C, then B, with C's history.
- [ ] 5. Close every tab one by one (Ctrl+W), so the app opens a new-tab page by itself, then press Ctrl+Shift+T.
  - **Expected:** the last tab you closed comes back.
- **If it fails, report:** which tab came back (or didn't), where it landed, and what Back did.

---

## D. The memory (history) and what it leaves out

Phase 2 records history but has no screen for it, so this section reads the file with `vq` (see [Before you start](#before-you-start)). **Quit the app before each `vq`.**

### D1. Pages and how you got there
- [ ] 1. Start the app. In a new tab: type `example.com` in the address bar and press Enter; then type `veltriva test search` and press Enter (a search); press Back once (back to example.com); press Reload. In another tab, type `https://en.wikipedia.org/wiki/Main_Page` and press Enter, then click any article link.
- [ ] 2. Wait three seconds, then quit. Run:

  ```powershell
  vq "SELECT p.url, p.title, p.visit_count, p.typed_count, v.transition FROM visits v JOIN pages p ON p.id = v.page_id ORDER BY v.visited_at"
  ```

  - **Expected:**
    - `https://example.com/` with the title **Example Domain**, visited as `typed`, then `back_forward`, then `reload`; its `typed_count` is 1;
    - the search results page, visited as `generated` (the search engine's own page may add a row or two of its own, as `link`);
    - the Wikipedia main page as `typed`, and the article as `link`;
    - every row has a real title, not an empty one or the previous page's.
- **If it fails, report:** the `vq` output (copy it as text).

### D2. Addresses are cleaned before they're stored
- [ ] 1. Start the app and open each of these, one by one, in the address bar:
  - `https://example.com/?utm_source=manual&fbclid=abc&id=7&token=secret123#access_token=secret456`
  - `https://example.com/callback?code=secret789&state=xyz`
  - `https://example.com/cb#access_token=secret000`
- [ ] 2. **Close those three tabs** (the session keeps an open tab's exact address so it can come back; that's checked separately), wait three seconds, and quit. Run:

  ```powershell
  vq "SELECT url, url_key FROM pages WHERE host = 'example.com'"
  vq "SELECT count(*) AS secrets FROM pages WHERE url LIKE '%secret%' OR url_key LIKE '%secret%'"
  ```

  - **Expected:**
    - one row with `url` = `https://example.com/?utm_source=manual&fbclid=abc&id=7` (the token parameter and the token fragment are gone) and `url_key` = `https://example.com/?id=7` (tracking parameters gone too);
    - **no** row for `/callback` or `/cb`: sign-in callbacks are never recorded;
    - `secrets` is `0`.
- **If it fails, report:** both outputs.

### D3. Icons
- [ ] 1. Start the app, open `https://en.wikipedia.org/wiki/Web_browser`, then type `https://en.wikipedia.org/wiki/Tab_(interface)` in the same tab.
  - **Expected:** the sidebar shows Wikipedia's "W" icon for **both** pages (the second page has the same icon as the first).
- [ ] 2. Quit, then run:

  ```powershell
  vq "SELECT p.title, f.mime, length(f.bytes) AS bytes FROM pages p JOIN favicons f ON f.id = p.favicon_id WHERE p.host = 'en.wikipedia.org'"
  ```

  - **Expected:** both pages, sharing one icon: the same `mime` and `bytes` on both rows.
- **If it fails, report:** whether the sidebar showed the icons, and the `vq` output.

---

## E. Choices that stay

### E1. Permission decisions
Use `https://permission.site`.
- [ ] 1. Click **Location**, then **Allow** in the strip. Click **Notifications**, then **Block**.
- [ ] 2. Quit, start the app, reload permission.site, and click **Location** and **Notifications** again.
  - **Expected:** no strip for either. Location works (the site reports your position, or Windows asks for its own location permission); Notifications is denied.
- [ ] 3. Click **Camera**, then dismiss the strip with ✕, three times in a row.
  - **Expected:** after the third time, the site stops prompting for the camera.
- [ ] 4. Quit, start the app, reload, and click **Camera**.
  - **Expected:** the strip appears again. A dismissal is never stored; only Allow and Block are.
- **If it fails, report:** the step, and what the site reported.

### E2. "Always allow" for another app's links
- [ ] 1. Repeat Phase 1's **C3** (a `mailto:` link on example.com), including step 4: tick **always allow**, then **Open**. Don't send the mail.
- [ ] 2. Quit, start the app, add the link again (C3 step 1's Console line) and click it.
  - **Expected:** your mail app opens without a strip. Close the new message without sending.
- [ ] 3. Do the same on `https://www.iana.org` (another site).
  - **Expected:** a strip asks first: the choice belongs to example.com only.
- **If it fails, report:** whether a strip appeared after the restart.

### E3. Download history
- [ ] 1. Repeat Phase 1's **C4 steps 1 and 4** (`notes.txt`, then the risky `test.bat`, but don't click Keep or Discard yet).
- [ ] 2. Start `https://httpbin.org/drip?duration=60&numbytes=6000&delay=0`, and while it's still running, kill the app.
- [ ] 3. Start the app and open the downloads panel.
  - **Expected:**
    - `notes.txt` is listed as done, and **Open** opens it;
    - `test.bat` still waits for **Keep** or **Discard**, and **Keep** works;
    - the drip download shows as **interrupted**, with no Resume.
- [ ] 4. Remove the drip download from the list, quit and start again.
  - **Expected:** it stays gone; the others are still listed.
- [ ] Clean up: delete `notes*.txt`, `test.bat` and any `drip*` file from Downloads.
- **If it fails, report:** the panel as you saw it (a screenshot), and the step.

---

## F. Database recovery

This damages the database on purpose: **only with the throwaway profile.**

### F1. Restored from a backup
- [ ] 1. Start the app, open two or three sites, then **leave the computer alone for 15 minutes** (no mouse or keyboard). Veltriva takes its daily backup only while you're away, and checks every 10 minutes after 5 idle minutes.
- [ ] 2. Quit. Check that a backup exists:

  ```powershell
  Get-ChildItem "$env:TEMP\veltriva-manual\backups"
  ```

  - **Expected:** a file named `veltriva-daily-<date and time>.db`. If there is none, repeat step 1.
- [ ] 3. Damage the database's first 100 bytes:

  ```powershell
  $f = "$env:TEMP\veltriva-manual\veltriva.db"; $b = [IO.File]::ReadAllBytes($f); [Array]::Clear($b, 0, 100); [IO.File]::WriteAllBytes($f, $b)
  ```

- [ ] 4. Start the app.
  - **Expected:**
    - it starts normally, with a notice: **"Veltriva's database was damaged, so it was restored from a backup from …"**, naming the time of the backup and the file the damaged one was kept as;
    - the profile folder has that `veltriva.db.corrupt-…` file; nothing was deleted;
    - the history from before the backup is there (`vq` after quitting, as in D1).
- **If it fails, report:** the notice text, the files in `%TEMP%\veltriva-manual` (`Get-ChildItem`), and any error.

### F2. No backup to use
- [ ] 1. Quit. Move the backups away, then damage the file again:

  ```powershell
  Move-Item "$env:TEMP\veltriva-manual\backups" "$env:TEMP\veltriva-manual-backups-saved"
  $f = "$env:TEMP\veltriva-manual\veltriva.db"; $b = [IO.File]::ReadAllBytes($f); [Array]::Clear($b, 0, 100); [IO.File]::WriteAllBytes($f, $b)
  ```

- [ ] 2. Start the app.
  - **Expected:** it starts with one new tab and the notice **"Veltriva's database was damaged and no backup could be used, so Veltriva started with an empty one."**, naming the kept file.
- **If it fails, report:** as in F1.

---

## G. The packaged build

Build it first with `npm run package:dir`. This uses the real profile, `%APPDATA%\Veltriva`, so nothing here damages or kills anything.

- [ ] 1. Run `release\win-unpacked\Veltriva.exe`, open two sites, select the first, and close the window.
- [ ] 2. Run it again.
  - **Expected:** both tabs are back, the first one selected and loaded, at the same window size and place.
- [ ] 3. While it runs, start `Veltriva.exe` a second time.
  - **Expected:** no second window; the open one comes to the front.
- [ ] 4. Close the window.
  - **Expected:** within a few seconds no `Veltriva.exe` is left in Task Manager.
- **If it fails, report:** the step, any dialog text, and whether `Veltriva.exe` was still running.

---

## When you're done
- Delete `%TEMP%\veltriva-manual` and `%TEMP%\veltriva-manual-backups-saved`, the throwaway profile.
- The packaged app's profile, `%APPDATA%\Veltriva`, now holds your tabs and history from section G. Delete it to start fresh.
- Send back the unticked items with what you saw.
