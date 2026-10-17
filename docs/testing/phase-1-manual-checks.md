# Phase 1 manual checks

These are the checks that automated tests can't do: real sites, real accounts, real hardware, real keyboards and the packaged build. **You run them yourself.** Nothing here is automated, and nobody else drives the app for you.

For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for and send it back. A screenshot helps when the problem is visual.

## Before you start

- **Build:** run sections A–C in `npm run dev` from the repository root, and section D in the packaged build (`release/win-unpacked/Veltriva.exe`, made by `npm run package:dir`).
- **Use a throwaway profile for `npm run dev`.** The development build and the packaged build both use `%APPDATA%\Veltriva` by default. Cookie encryption is a fuse that is on only in the packaged build, so a development profile stores cookies unencrypted. In PowerShell:

  ```powershell
  $env:VELTRIVA_USER_DATA_DIR = "$env:TEMP\veltriva-manual"; npm run dev
  ```

  Delete `%TEMP%\veltriva-manual` when you're done. The packaged build ignores the variable and always uses `%APPDATA%\Veltriva`.
- **Accounts:** you sign in yourself, with accounts you choose. A throwaway account is best. Veltriva has no password manager and stores no passwords, including the ones typed into the HTTP sign-in form. A sign-in leaves only what Chromium itself keeps for the site in the profile folder: cookies, cache and site storage. Chromium also remembers an HTTP sign-in in memory until the app quits. Deleting the profile folder removes all of it.
- **Logs:** the terminal running `npm run dev` prints main-process warnings, such as `popup.refused`, `auth.crossOriginRefused` and `guard.unknownWebContents`. When something fails, copy the lines printed around that moment.
- **Sites:** only well-known public test pages and big mainstream sites. Nothing here asks for payment details. Don't try any payment flow.

---

## A. Real-world sites (spike S7 checks M1–M4)

### A1. Google sign-in (M1)
- [ ] 1. Open `https://accounts.google.com`.
- [ ] 2. Press F12 to open DevTools for the tab. In its Console, run `navigator.userAgent`.
  - **Expected:** a Chrome user agent with **no** `Electron` and no `Veltriva` in it.
- [ ] 3. Sign in with your account: email, Next, password, Next, plus any 2-step prompt.
  - **Expected:** you reach your account page or Google's normal 2-step prompt. You should **not** see "Couldn't sign you in: This browser or app may not be secure".
- [ ] 4. Close the tab, open `https://myaccount.google.com` in a new tab.
  - **Expected:** you're still signed in. The cookie lives in the profile.
- **If it fails, report:**
  - the exact error text Google shows, and the step where it showed;
  - the user agent from step 2.
  - Don't try workarounds. The result decides whether the per-site user-agent override (assessment §3.7) is needed.

### A2. An OAuth popup flow (M2)
- [ ] 1. Open a third-party site you already use whose "Sign in with Google" (or "with GitHub") button opens a **small popup window**, not a full-page redirect. Click the button.
  - **Expected:** a separate small window opens.
    - Its top bar shows the popup's real address, read-only.
    - There is no "Pop-up blocked" strip in the main window, because you clicked.
- [ ] 2. Finish the sign-in in the popup.
  - **Expected:** the popup closes by itself, and the original page shows you signed in. This proves `window.opener` and `postMessage` survive a real cross-site flow.
- [ ] 3. Repeat, but close the opener tab while the popup is still open. Use Ctrl+W in the main window.
  - **Expected:** the popup stays open (`outlivesOpener`). Closing it afterwards causes no error.
- **If it fails, report:**
  - which site you used;
  - whether the popup opened as a window, opened as a tab, or was blocked;
  - whether it closed itself;
  - any `popup.` lines in the terminal.
  - If the page stays signed out, open the popup's DevTools (F12 inside it) and run `window.opener === null`, then report the result.

### A3. YouTube playback and fullscreen (M3)
- [ ] 1. Open any normal public video on `https://www.youtube.com`.
  - **Expected:** it plays with sound, seeking works, and 1080p can be selected in the quality menu.
- [ ] 2. Click YouTube's fullscreen button.
  - **Expected:**
    - the window goes fullscreen;
    - the toolbar and sidebar hide;
    - a notice says the site is fullscreen and **"Press Esc to exit full screen"**, then fades.
- [ ] 3. Press Esc.
  - **Expected:** the video and the window both leave fullscreen, and the toolbar is back.
- [ ] 4. Go fullscreen again, then press Ctrl+Tab with a second tab open.
  - **Expected:** fullscreen ends and the next tab is selected.
- [ ] 5. Go fullscreen again, then close the tab with Ctrl+W.
  - **Expected:** the window leaves fullscreen too. It doesn't stay fullscreen with no page.
- **If it fails, report:**
  - which step;
  - any "browser not supported" banner;
  - whether the window stayed stuck in fullscreen.
  - Paid or DRM videos not playing is **expected** (there's no Widevine), so it isn't a failure.

### A4. A real PDF (M4)
- [ ] 1. Open a long PDF you trust, for example `https://www.rfc-editor.org/rfc/pdfrfc/rfc9110.txt.pdf` (about 200 pages).
  - **Expected:**
    - it renders in the built-in viewer;
    - scrolling, the viewer's own zoom, the thumbnail sidebar and text select-and-copy work.
- [ ] 2. Press the viewer's print button, then cancel the dialog.
  - **Expected:** the print dialog opens and cancels cleanly.
- [ ] 3. Press the viewer's download button.
  - **Expected:**
    - the file goes straight to your Downloads folder with **no Save As dialog**;
    - it shows in the downloads panel under the toolbar.
- **If it fails, report:** what didn't work, and roughly how long the first page took to appear.

---

## B. Keyboard and focus (assessment §3.9)

Have **three or more ordinary tabs** open, for example `https://example.com`, `https://www.wikipedia.org` and `https://developer.mozilla.org`. Do each step with the **page** focused (click inside it first), unless the step says otherwise.

### B1. Browser-reserved shortcuts (the page never sees these)
| ✓ | Keys | Expected |
|---|---|---|
| [ ] | Ctrl+T | A new tab opens, selected, with the cursor in the address bar. |
| [ ] | Ctrl+W, and Ctrl+F4 | The current tab closes. |
| [ ] | Ctrl+Shift+T | The last closed tab comes back, at its place, with its page. |
| [ ] | Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab, wrapping around at the ends. |
| [ ] | Ctrl+1 … Ctrl+8 | The 1st … 8th tab. A number with no tab does nothing. |
| [ ] | Ctrl+9 | The last tab. |
| [ ] | Number-pad digits with Ctrl | The same as the top-row digits. |
| [ ] | Ctrl+L, and Alt+D | The address bar takes focus with its text selected. |
| [ ] | F6 (press it several times) | Focus moves between the address bar and the page. |
| [ ] | F5, and Ctrl+R | The page reloads. |
| [ ] | Ctrl+F5, Shift+F5, Ctrl+Shift+R | The page reloads, bypassing the cache. |
| [ ] | Alt+← / Alt+→ | Back / forward, when there's history. |
| [ ] | The mouse's back / forward side buttons (if your mouse has them) | Back / forward. |
| [ ] | F11, twice | The window goes fullscreen, then comes back. |
| [ ] | F12, twice | DevTools for the tab opens in its own window, then closes. |
| [ ] | Ctrl+Shift+K | Nothing happens (reserved for the memory palette, Phase 4). The page doesn't react either. |

### B2. Page-first shortcuts (the page can claim these; otherwise the browser acts)
| ✓ | Keys | Expected |
|---|---|---|
| [ ] | Ctrl+F on `example.com` | The find bar opens. Typing finds matches, Enter / Shift+Enter step through them, Esc closes it. |
| [ ] | F3 / Shift+F3, Ctrl+G / Ctrl+Shift+G (find bar open) | Next / previous match. |
| [ ] | Ctrl+K on `developer.mozilla.org` | **MDN's own search** opens: the page claimed the key, and the browser doesn't act. |
| [ ] | Ctrl+= or Ctrl++, Ctrl+-, Ctrl+0 | Zoom in, zoom out and reset. A zoom badge shows when the zoom isn't 100%. |
| [ ] | Ctrl with the number pad's +, -, 0 | The same as the row above. |
| [ ] | (Only if you use a layout with AltGr, such as Polish or German) Type AltGr characters in a page's text box | The characters type. No tab shortcut fires. |

### B3. Focus behavior
- [ ] 1. Press Ctrl+L, type `example.com` and press Enter.
  - **Expected:** once the page loads, focus is **in the page**. Pressing Space or ↓ scrolls the page and types nothing in the address bar.
- [ ] 2. Press Ctrl+L, type a few characters, then press Esc.
  - **Expected:** the address bar goes back to the page's address, with all of it selected. Focus stays in the address bar. Phase 1 has no suggestions list.
- [ ] 3. Focus a page text field, press Ctrl+F, then press Esc.
  - **Expected:** the find bar closes, and focus goes back to the text field.
- [ ] 4. Press Tab repeatedly from the address bar.
  - **Expected:** a visible focus ring moves through the toolbar buttons. Nothing is unreachable, and no focus is invisible.
- [ ] 5. Right-click a link, then press Esc.
  - **Expected:** the menu closes, and the page keeps focus.
- **If it fails, report:** the keys, which element had focus before, and what happened instead.

---

## C. Milestone 1.4 by hand

### C1. Camera, microphone and location prompts
Use `https://permission.site`.
- [ ] 1. Click **Camera**.
  - **Expected:**
    - a strip under the toolbar says the page wants to use your camera, with Allow, Block and ✕;
    - Allow can't be clicked for about half a second after the strip appears.
- [ ] 2. Click **Block**.
  - **Expected:** the site reports the camera as denied. Your camera light stays off.
- [ ] 3. Reload, click **Camera** again, then click **Allow**.
  - **Expected:** Windows' camera privacy settings may show their own prompt. Then the camera turns on, its light goes on, and the site shows video. Close the tab afterwards.
- [ ] 4. Repeat steps 1–3 for **Microphone** and **Location**.
- [ ] 5. Ask for the camera, then dismiss with ✕, three times in a row.
  - **Expected:** after the third time, the site stops prompting for that permission.
- [ ] 6. Click a permission that isn't prompted, such as **Pointer Lock**, **MIDI** or **USB**.
  - **Expected:** it's denied silently. There's no strip.
- **If it fails, report:** the permission, what the strip showed (take a screenshot), and what the site reported.

### C2. Blocked popup, then "open anyway"
- [ ] 1. On `https://permission.site`, open DevTools (F12). In its Console, run:

  ```js
  setTimeout(() => window.open('https://example.com', '_blank', 'width=500,height=400'), 6000)
  ```

  Then wait 6 seconds **without clicking the page**.
  - **Expected:** no window opens. A **"Pop-up blocked"** strip offers **Open pop-up**.
- [ ] 2. Click **Open pop-up**.
  - **Expected:** `https://example.com` opens.
- [ ] 3. Click the site's own **Popup** button.
  - **Expected:** it opens, with no strip, because you clicked.
- **If it fails, report:** whether the strip showed, and what opened (a window, a tab or nothing).

### C3. A `mailto:` link
- [ ] 1. Open `https://example.com`, press F12, and run this in the Console:

  ```js
  document.body.insertAdjacentHTML('beforeend', '<p><a href="mailto:test@example.com">mail</a></p>')
  ```

  Then click the new **mail** link on the page. A typed `data:` page won't work, because a tab can't show `data:` documents.
  - **Expected:**
    - a strip asks whether to open the link in another app, naming the scheme, with **Open** and **Cancel**;
    - nothing opens before you answer.
- [ ] 2. Click **Cancel**.
  - **Expected:** nothing opens.
- [ ] 3. Click the link again, then click **Open**.
  - **Expected:** your default mail app opens a new message to `test@example.com`. Don't send it.
- [ ] 4. Tick the "always allow" box, then click **Open**. Click the link once more.
  - **Expected:** this time it opens without asking.
- **If it fails, report:** the strip's text, and whether anything opened before you answered.

### C4. Downloads
- [ ] 1. **An ordinary file.** Open `https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dnotes.txt`.
  - **Expected:**
    - `notes.txt` lands in your Downloads folder, with **no Save As dialog**;
    - the downloads panel shows it as done, with **Open** and **Show in folder**.
  - Click each one.
  - **Expected:** Notepad opens the file, and Explorer opens with the file selected.
- [ ] 2. **The same name again.** Repeat step 1.
  - **Expected:** the second copy is named `notes (1).txt`.
- [ ] 3. **Pause, resume and cancel.** Open `https://httpbin.org/drip?duration=30&numbytes=3000&delay=0`.
  - **Expected:** it downloads slowly. **Pause** stops the progress, **Resume** continues, and **Cancel** stops it and leaves no file behind.
- [ ] 4. **A risky file that needs Keep.** Open `https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dtest.bat`. Its content is harmless JSON text, but `.bat` is a type Windows can run.
  - **Expected:**
    - the panel warns **"This type of file can harm your computer"**, with **Keep** and **Discard**;
    - the toolbar's downloads button shows a dot;
    - Explorer shows `test.bat.unconfirmed` in Downloads, and **Open** and **Show in folder** aren't offered.
- [ ] 5. Click **Keep**.
  - **Expected:** the file becomes `test.bat`, and **Show in folder** appears. **Don't open or run it.**
- [ ] 6. **Mark-of-the-Web.** In Explorer, right-click `test.bat`, then choose Properties.
  - **Expected:** the General tab has a Security note, "This file came from another computer…", with an **Unblock** checkbox. Don't tick it. Also check `notes.txt` from step 1.
- [ ] 7. Repeat step 4, then click **Discard**.
  - **Expected:** the file disappears from Downloads.
- [ ] Clean up: delete `notes*.txt` and `test.bat` from Downloads.
- **If it fails, report:**
  - the step;
  - the file name Explorer shows;
  - a screenshot of the panel or of the Properties window.

### C5. Certificate errors (badssl.com)
- [ ] 1. Open each of these:
  - `https://expired.badssl.com`
  - `https://self-signed.badssl.com`
  - `https://wrong.host.badssl.com`
  - `https://untrusted-root.badssl.com`
  - **Expected, for each:**
    - the page **"Your connection to this site isn't private"**, with the address and an error name (e.g. `ERR_CERT_DATE_INVALID`);
    - **Try again**, and **Go back** if there's history;
    - **no** way to proceed to the site.
- [ ] 2. Open `https://badssl.com` (a valid certificate).
  - **Expected:** it loads normally, with the secure-connection icon.
- [ ] 3. Open `http://http.badssl.com`.
  - **Expected:** it loads, and the address bar marks it **Not secure**.
- [ ] 4. Open `https://client.badssl.com` (the site asks for a client certificate).
  - **Expected:** Veltriva never offers a certificate picker. Either the site needs-a-certificate page appears, or badssl's own "400 No required SSL certificate was sent" page.
- **If it fails, report:** the address, the page title and error name you saw, or the fact that the site loaded anyway.

### C6. HTTP Basic sign-in
- [ ] 1. Open `https://httpbin.org/basic-auth/user/pass`.
  - **Expected:**
    - a **Sign in** strip under the toolbar names `httpbin.org` and shows the server's realm as quoted server text;
    - the cursor is already in the username field.
- [ ] 2. Enter `user` / `pass` (httpbin's public test values), then click **Sign in**.
  - **Expected:** the page shows `"authenticated": true`.
- [ ] 3. Open `https://httpbin.org/basic-auth/user/other`. Enter `user` with a wrong password, such as `nope`, three times.
  - **Expected:** after the third try, the strip stops coming back and the page shows the server's refusal (a blank page or a 401).
- [ ] 4. Open `http://httpbin.org/basic-auth/user/pass` (plain **http**).
  - **Expected:** the strip warns **"Your password will be sent unencrypted"**. Click **Cancel**.
- [ ] 5. Open `https://httpbin.org/basic-auth/user/cancelme`, then click **Cancel**.
  - **Expected:** the page shows the server's refusal (a blank page or a 401). Nothing is signed in.
- [ ] 6. Reopen the step 2 address in a new tab.
  - **Expected:** no prompt, because Chromium remembers that sign-in in memory. Quit the app (close its window), start it again and reopen the address.
  - **Expected:** it asks again. Nothing was written to disk.
- **If it fails, report:** the strip's text (take a screenshot), and the step.

---

## D. The packaged build

Build it first with `npm run package:dir`. This uses the real profile, `%APPDATA%\Veltriva`.

- [ ] 1. Run `release\win-unpacked\Veltriva.exe`.
  - **Expected:**
    - a window titled **Veltriva Browser** opens with the toolbar, sidebar and new-tab page drawn (not a blank window);
    - no error dialog.
- [ ] 2. Open `https://example.com` and one other site.
  - **Expected:** both load.
- [ ] 3. Close the window with its ✕.
  - **Expected:** the app exits. Within a few seconds, no `Veltriva.exe` is left in Task Manager.
- [ ] 4. Run `Veltriva.exe` again.
  - **Expected:** it launches normally, with no "already running" or profile-lock error. Phase 1 has no session restore, so starting with a fresh tab is expected.
- [ ] 5. In the packaged app, repeat **C4 step 4–6** (a risky download, Keep, then Properties).
  - **Expected:** Mark-of-the-Web is present here too.
- [ ] 6. Press F12 on a page in the packaged app.
  - **Expected:** DevTools for that page opens in its own window. F12 again closes it.
- **If it fails, report:**
  - the step;
  - any dialog text;
  - whether `Veltriva.exe` was still in Task Manager.
  - For a blank window, take a screenshot.

---

## When you're done
- Delete `%TEMP%\veltriva-manual`, the development profile.
- To remove the packaged app's sign-ins too, delete `%APPDATA%\Veltriva`.
- Send back the unticked items with what you saw.
