# Final manual checklist

This is the one checklist you run at the very end of the project, **in one sitting**. It replaces running the five phase checklists (`phase-1-manual-checks.md` to `phase-5-manual-checks.md`) one by one, and adds what Phase 6 built: the installer, the accessibility checks, the About page, the update notice and clean virtual machines. It is for Veltriva Browser **version 0.1.0**.

These are the checks that automated tests can't do: real sites, real accounts, real hardware, real keyboards, a screen reader, a quiet machine and a clean Windows. **You run them yourself.** Nothing here is automated, and nobody else drives the app for you.

For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for and send it back with the item's number, for example "7.3 failed". A screenshot helps when the problem is visual. Items marked *(optional)* or *(only if …)* can be skipped when they don't apply to you; say so when you send the list back.

**Six things are required by the project's brief.** They are marked **Required** where they come, so you can find them:

1. the OAuth popup check, "Sign in with Google/GitHub/Microsoft" in a popup on a real site (4.4 to 4.6);
2. the JS-dialog checks (9.1 to 9.3);
3. installing and uninstalling with the installer, by hand (sections 1 and 13);
4. installs on clean Windows 10 and Windows 11 virtual machines (section 14);
5. the memory benchmark on a quiet machine (12.4 to 12.7);
6. code signing, which is your decision (15.1).

**What was already done by a script.** `scripts/installer-test.ps1` ran the installer end to end on the development machine: install, the shortcuts and their AppUserModelID, launch, uninstall with each answer to the data question, reinstall, `/S`, `/S --delete-app-data`, and an upgrade from 0.0.0 to 0.1.0. It installs with `/S`, so it never saw the install window or SmartScreen, and it pressed the uninstaller's buttons itself. Your checks in sections 1, 13 and 14 are about what a person sees: SmartScreen, the wording and the default button of the dialogs, the Start menu, Settings ▸ Apps, and a Windows that has never seen Veltriva.

## How long it takes

These are rough estimates, not measurements. Your pace and your machine change them.

| Section | Hands-on time | Waits |
|---|---|---|
| 0. Before you start | 20 min | |
| 1. Install | 20 min | |
| 2. First run and settings | 15 min | |
| 3. Browsing basics and keyboard | 35 min | |
| 4. Web plumbing | 60 min | |
| 5. Session restore and crash recovery | 40 min | a 15-minute idle wait (5.24) |
| 6. Lifecycle and automation | 50 min | 3-minute waits, then 15 min (6.24) and 1 hour or more (6.25) |
| 7. Search memory and the palette | 25 min | |
| 8. Privacy, data and diagnostics | 40 min | |
| 9. JS dialogs, "Leave page?", print, file chooser | 15 min | |
| 10. Accessibility | 60 min | |
| 11. About and updates | 20 min | |
| 12. Benchmarks (a separate session) | 20 min of attention | about 15 min (search), about 2 hours (memory, 10/25/50 tabs) and about 1 hour more for 100 tabs, on a quiet machine |
| 13. Uninstall, reinstall and upgrade | 35 min | about 15 min more if you build the older installer (13.6) |
| 14. Clean Windows 10 and 11 virtual machines | 45 min per VM | |
| 15. Decisions for you | reading only | |

Sections 0 to 11 and 13 are about a working day. Do 6.24 and 6.25 at a natural break (lunch). Do section 12 on another day, or last, when nothing else needs the computer. The benchmark times are the least certain: they come from the protocol (18 runs for 10/25/50 tabs, each with 10-second settles and 60-second quiet windows), not from a run on a quiet machine.

## Where each check came from

Nothing was lost in the merge. **P1 to P5** are the phase checklists, **A11Y** is `accessibility.md`, **REL** is `docs/distribution/releasing.md`, **SIG** is `docs/distribution/signing.md`, **SEC** is `docs/security/security-review.md`, **BM** is `docs/benchmarks/phase-3-memory.md` (the earlier attempt) and `docs/benchmarks/memory.md` (the report), **GAP** is `docs/plans/mvp-gap-audit.md`. "P1 A3 s2" means Phase 1, group A3, step 2. This table is reference only: skip it unless you wonder where a check went.

| New | Old |
|---|---|
| 1.1 to 1.9 | New in Phase 6: REL (installer table, "Testing an installer on this machine"), SIG (SmartScreen, "Unknown publisher"), SEC finding 5 and "Licenses" (the four license files), `electron-builder.yml` and `scripts/installer-test.ps1` (folder, shortcuts, AppUserModelID, uninstall entry) |
| 2.1 | P1 D1 |
| 2.2 to 2.3 | P5 A1 s1–2 |
| 2.4 to 2.7 | P5 A2 s1–4 |
| 2.8 to 2.9 | P1 D3–D4; P2 G s4; P3 F s3; P4 E; P5 A1 s3; P5 H |
| 3.1 to 3.6 | P1 A3 s1–5; P3 A3 s1 (the F11 exit, 3.5); P4 A1 s1 |
| 3.7 to 3.10 | P1 A4 s1–3; P4 A1 s2 (3.8) |
| 3.11 to 3.26 | P1 B1, one row each in the same order; the F12 row (3.25) is also P1 D6 and P4 A1 s4; the Ctrl+Shift+K row (3.26) is also P4 B1 s1 |
| 3.27 to 3.33 | P1 B2, one row each in the same order (3.27–3.31 and 3.33); 3.32 (Ctrl+mouse wheel) comes from ADR-0008 and the README |
| 3.34 to 3.37 | P1 B3 s1, s2, s3, s5 (s4 went to 10.4) |
| 4.1 to 4.3 | P1 A1 s1–4 |
| 4.4 to 4.6 | P1 A2 s1–3 (the OAuth popup check skipped in Phase 1; spike S7 M2) |
| 4.7 to 4.12 | P1 C1 s1–6 |
| 4.13 to 4.15 | P1 C2 s1–3 |
| 4.16 to 4.19 | P1 C3 s1–4; P2 E2 s1 |
| 4.20 to 4.27 | P1 C4 s1–7 and its clean up; P1 D5 |
| 4.28 to 4.31 | P1 C5 s1–4 |
| 4.32 to 4.37 | P1 C6 s1–6 |
| 5.1 to 5.2 | P2 A1 s1–5; P2 G s1–2 |
| 5.3 to 5.6 | P2 A2 s1–4 |
| 5.7 | P2 A3 s1; P2 G s3 |
| 5.8 to 5.9 | P2 B1 s1–3 |
| 5.10 to 5.12 | P2 B2 s1–4 |
| 5.13 to 5.15 | P2 C s1–5 |
| 5.16 to 5.17 | P2 E1 s1–4 |
| 5.18 to 5.19 | P2 E2 s1–3 |
| 5.20 to 5.22 | P2 E3 s1–4 and its clean up |
| 5.23 | P5 A2 s5 |
| 5.24 to 5.26 | P2 F1 s1–4; P2 F2 s1–2 |
| 6.1 to 6.5 | P3 C1 s1–5; P3 F s1 |
| 6.6 to 6.8 | P3 E1 s1–2; P3 C3 s1–3 |
| 6.9 to 6.10 | P3 E2 s1–2 |
| 6.11 to 6.12 | P3 E3 s1–2 |
| 6.13 to 6.14 | P3 D1 s1–2 |
| 6.15 | P3 D2 s1 |
| 6.16 to 6.17 | P3 A1 s1–4 |
| 6.18 to 6.21 | P3 A2 s1, s1b, s2, s3 |
| 6.22 | P3 A3 s2 |
| 6.23 | P3 C4 s1; P3 F s2 |
| 6.24 to 6.25 | P3 B1 s1; P3 B2 s1 |
| 7.1 to 7.3 | P4 B1 s1–3 |
| 7.4 to 7.9 | P4 B2 s1–6; P4 E s1 (found by part of its title, back on Enter: 7.4 and 7.5) |
| 7.10 to 7.13 | P4 B3 s1–4 |
| 7.14 to 7.18 | P4 C s1–5 |
| 7.19 to 7.21 | P4 D s1–3 |
| 8.1 | P5 A2 s6 |
| 8.2 to 8.3 | P5 A3 s1–2 |
| 8.4 to 8.8 | P5 C s1–5 |
| 8.9 to 8.12 | P2 D1 s1–2; P2 D2 s1–2; P2 D3 s1; P2 D3 s2 |
| 8.13 | SEC "What M6.1 found and fixed", finding 1 (favicons) |
| 8.14 to 8.16 | P5 D s1–3 |
| 8.17 | P5 E s1 |
| 8.18 | SEC finding 3 (no addresses in the log) |
| 8.19 | P5 E s2 |
| 8.20 to 8.21 | P5 F s1–2 |
| 9.1 to 9.3 | P5 B s1–3 |
| 9.4 | P5 B s4 |
| 9.5 to 9.7 | P3 C2 s1–3 |
| 9.8 | P5 B s5 |
| 9.9 | GAP, "File chooser" row ("a manual check covers choosing a file"); no phase checklist had it |
| 10.1 to 10.29 | A11Y A1 to G1, in order: A is 10.1–10.5, B 10.6–10.12, C 10.13–10.17, D 10.18–10.20, E 10.21–10.24, F 10.25–10.28, G 10.29. Also P1 B1 (F6 row), P1 B3 s4 (10.4), P4 B3 s5 (10.15), P5 G s1 (10.21) |
| 11.1 to 11.10 | New in Phase 6: the About page, Settings ▸ Updates, REL "The update notice", SEC finding 5 |
| 12.1 to 12.3 | P4 F s1–2 (12.1 is its "close other apps first", with BM's "free memory well above 2 GB") |
| 12.4 to 12.5 | BM "To complete it"; P4 F (its last paragraph) |
| 12.6 to 12.7 | The Phase 6 plan (M6.4: 10, 25, 50 and 100 tabs) and the header of `tests/benchmarks/memory.bench.ts` |
| 13.1 to 13.9 | REL installer table (Uninstall, Reinstall / update, Silent uninstall); `build/installer.nsh`; `scripts/installer-test.ps1` |
| 14.1 to 14.20 | New in Phase 6: the phase-6 plan ("VM checks listed for the user"), REL, SIG |
| 15 | SIG; REL ("To publish later"); ADR-0007 items 4 and 5; the M6.3 report (the tag, the update feed) (decisions, not checks) |

The list of source checks that were merged into others (the duplicates) is at the end of this file.

---

## 0. Before you start

### What runs where

- **Sections 1 to 11 and 13 run in the installed app**, the build users get. They don't use `npm run dev`. The old checklists mixed `npm run dev` and the packaged build; the installed app does everything they did, and cookie encryption (a fuse that is on only in a packaged build) is on. F12 still opens a page's DevTools.
- **Section 12 (benchmarks)** runs from the repository, on a quiet machine, in a session of its own.
- **Section 14** runs inside two clean virtual machines.
- **Section 15** is decisions for you, not checks.

### What you need

- **The installer.** `release\Veltriva-Browser-Setup-0.1.0.exe` already exists: the release script built it (with every build and packaging check) on 2026-10-23, and `release\SHA256SUMS.txt` and `docs/releases/v0.1.0.md` give its SHA-256. Use that file. Only rebuild it if it is missing, or if you changed the code since: in the repository root, run `npm run package:installer`. A rebuilt installer is a different file with its own hash, so the hash on file no longer applies to it. If a build check fails, report that first; don't start this list. If Windows says a file in `release` is in use, restart the PC and run it again.
- **Accounts you sign in with yourself.** Veltriva has no password manager and stores no passwords, including the ones typed into the HTTP sign-in form. A sign-in leaves only what Chromium itself keeps for the site in the profile folder: cookies, cache and site storage. Deleting the profile folder removes all of it. A throwaway account is best. You need:
  - a Google account (4.1 to 4.3);
  - an account on a site whose "Sign in with Google", "Continue with Microsoft" or "Sign in with GitHub" button opens a popup (4.4 to 4.6; the check says which sites to try);
  - a site you are signed in to and don't mind signing in to again (8.5);
  - optional, for 6.15 and 6.21 and 9.4: a mail or chat page you are signed in to, and an online editor with a draft.
- **Hardware:** a camera, a microphone, Windows location access and a default mail app (4.7 to 4.19); a mouse with a wheel, ideally with back and forward side buttons (3.23, 3.32). Optional: a second monitor (5.6), display scaling other than 100% (5.5), and a keyboard layout with AltGr (3.33).
- **Narrator** (built into Windows) for section 10.
- **Node.js and the repository set up on this machine** (`npm run setup`, see `docs/development.md`), for the database reader `vq` below, for section 12 and for building the older installer in 13.6.
- **Two virtual machines** for section 14: one Windows 10 and one Windows 11, 64-bit (x64), and a way to copy the installer into them.
- **A quiet machine** for section 12. For the 100-tab size in 12.6, a machine with room: at about 34 MB per tab (`docs/benchmarks/memory.md`), 100 live tabs hold about 3.8 GB in all. The development laptop (7.9 GB) ran it with other programs open, and Windows paged to fit it, which slows the switch and load times but not the memory totals.
- **Sites:** only well-known public test pages and big mainstream sites. **Nothing here asks for payment details. Don't try any payment flow.**

### Back up your own profile first

The installed app, and `npm run dev`, both keep their data in `%APPDATA%\Veltriva`. This checklist starts from an empty profile, deletes it on purpose (6.0, 10.24), damages its database on purpose (5.24 to 5.26), and the uninstaller can delete it (13.5). So move yours aside **before you do anything else**:

```powershell
# Close Veltriva, and any "npm run dev" window, first.
if (Test-Path "$env:APPDATA\Veltriva") { Rename-Item "$env:APPDATA\Veltriva" "Veltriva-real-backup" }
```

- Don't run `npm run dev` while you work through this list: it would use the same folder.
- Every "delete the profile" step below means `%APPDATA%\Veltriva`, which is now only the test profile. Your own is safe in `Veltriva-real-backup`.
- Put it back at the end of section 13.

### PowerShell helpers

Open a PowerShell window and keep it. Define the database reader once:

```powershell
function vq($sql) { node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');console.table(new DatabaseSync(process.argv[1],{readOnly:true}).prepare(process.argv[2]).all())" "$env:APPDATA\Veltriva\veltriva.db" $sql }
```

`vq "SELECT ..."` prints a table. It only reads; it never changes the file. **Quit Veltriva before each `vq`.**

- **Start** means starting Veltriva from the Start menu or the desktop shortcut.
- **Quit** means closing the window with its ✕ and waiting until the app has exited. This prints nothing once it has:

  ```powershell
  Get-Process Veltriva -ErrorAction SilentlyContinue
  ```

- **Kill** means ending the app without letting it quit (used in section 5). In a second PowerShell window:

  ```powershell
  Stop-Process -Name Veltriva -Force
  ```

- **The log.** Warnings and errors go to a file. Addresses show as `[hidden]` unless Diagnostic logging is on (Settings ▸ Diagnostics). When something fails, copy the last lines:

  ```powershell
  Get-Content "$env:APPDATA\Veltriva\logs\veltriva.log" -Tail 30
  ```

  The old checklists said "any `popup.` lines in the terminal": in the installed app, those lines are in this file.

### Tips

- **DevTools Console.** Several checks paste a line into a page's Console (F12). If the Console warns about pasting and asks you to type `allow pasting`, type it, press Enter, and paste again.
- **Reporting.** Send back the unticked items with their numbers and what you saw.

### Known limitations (these are not failures)

From the README's "Known limitations". Don't report these:

- A page's `alert` and `confirm` boxes block the whole window until you answer, even one from a background tab, and they don't name the site. A page's `prompt()` shows nothing and gets no answer (9.1 to 9.3).
- A link inside a page that asks you to stay doesn't ask you: the page keeps you. Typing an address, reloading, going back or forward, and closing the tab all ask "Leave page?" (9.4 to 9.6).
- No Safe Browsing, and no DRM video (Widevine): paid or DRM videos not playing is expected (3.1).
- The database isn't encrypted at rest.
- Unsaved-work detection is a heuristic. A muted video inside a player embedded from another site may not be seen, so its tab can be unloaded (6.19).
- Site icons are decoded by Veltriva's own interface, and a site's icon request can still be steered by DNS rebinding.
- Unsigned builds, so Windows SmartScreen warns (1.2).
- Left out of this version: multiple windows and dragging a tab out, private windows, sync, extensions, a password manager and autofill, ad and tracker blocking, macOS and Linux. There are no bookmarks or history page; the memory (7) replaces them.
- The update check's default feed has no releases yet, so a check can't find anything (11.7).
- Chromium security fixes reach Veltriva with each Electron release, a little after Chrome.

---

## 1. Install

**Required: installing by hand.** About 20 minutes. If a Veltriva is already installed on this machine, uninstall it first (Settings ▸ Apps ▸ Installed apps ▸ Veltriva Browser ‹version› ▸ Uninstall; either answer is safe, because your own profile is already moved aside).

`scripts/installer-test.ps1` already checked on the development machine that the installer puts the right files, shortcuts and registry entry in place. It installs silently, so what is left for you is what you see: SmartScreen, the install window, the Start menu and Settings ▸ Apps. The PowerShell steps below (1.5 to 1.7) are there to confirm the same facts on your own machine, in a minute.

- [ ] 1.1. Compare the installer's checksum with the one the release script wrote:

  ```powershell
  (Get-FileHash "release\Veltriva-Browser-Setup-0.1.0.exe" -Algorithm SHA256).Hash -eq ((Get-Content release\SHA256SUMS.txt) -split '\s+')[0]
  Get-Content release\SHA256SUMS.txt
  ```

  - **Expected:** the first command prints `True`. The second shows one line: the hash `c8df080be7243ef8cfa3f7a8c6231d0c01cefcd01991423b7b684c53b734aee5`, then the file name `Veltriva-Browser-Setup-0.1.0.exe`. (The same hash is on the draft release page, `docs/releases/v0.1.0.md`.)
  - If you rebuilt the installer, the hash on file belongs to the old file and this check doesn't apply. Say so.
- [ ] 1.2. Double-click `release\Veltriva-Browser-Setup-0.1.0.exe`.
  - **Expected:**
    - Windows may show **Windows protected your PC** (Microsoft Defender SmartScreen) with "Unknown publisher", because the build is unsigned (see 15.1). Choose **More info**, then **Run anyway**. SmartScreen builds a reputation per file, so a new version shows it again.
    - If SmartScreen doesn't appear (for example because the file never came through a browser), that's fine. Say so.
    - If you downloaded the installer in Edge or Chrome, the browser may say it "isn't commonly downloaded": choose **Keep** (Edge: **⋯ ▸ Keep ▸ Keep anyway**).
- [ ] 1.3. Let the installer run.
  - **Expected:**
    - one click: no wizard pages to click through (only a small progress window) and **no administrator (UAC) prompt**, because it installs for your user only;
    - when it ends, Veltriva starts by itself, on the Welcome page.
- [ ] 1.4. Look at the Start menu and the desktop.
  - **Expected:** a shortcut named **Veltriva Browser** in each, with Veltriva's icon. In the Start menu it sits in the app list itself, not in a folder.
- [ ] 1.5. Check what the shortcuts point to, and the identity Windows groups them under (the AppUserModelID):

  ```powershell
  $links = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Veltriva Browser.lnk",
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Veltriva Browser.lnk')
  )
  foreach ($lnk in $links) {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $folder = (New-Object -ComObject Shell.Application).NameSpace((Split-Path $lnk))
    $aumid = $folder.ParseName((Split-Path $lnk -Leaf)).ExtendedProperty('System.AppUserModel.ID')
    Write-Output $lnk
    Write-Output "  target = $($link.TargetPath)"
    Write-Output "  aumid  = $aumid"
  }
  ```

  - **Expected:** two blocks. In each, `target` is `C:\Users\<you>\AppData\Local\Programs\veltriva\Veltriva.exe` and `aumid` is `io.github.rmv-coder.veltriva`. The install folder is `veltriva` (the package name), under `%LOCALAPPDATA%\Programs`.
- [ ] 1.6. Check the install folder:

  ```powershell
  $dir = "$env:LOCALAPPDATA\Programs\veltriva"
  'Veltriva.exe','Uninstall Veltriva.exe','LICENSE.electron.txt','LICENSES.chromium.html','resources\THIRD_PARTY_NOTICES.txt','resources\LICENSE.txt' | ForEach-Object { '{0,-44} {1}' -f $_, (Test-Path (Join-Path $dir $_)) }
  ```

  - **Expected:** six lines, each ending in `True`. The four license files (`resources\THIRD_PARTY_NOTICES.txt`, `resources\LICENSE.txt`, `LICENSE.electron.txt`, `LICENSES.chromium.html`) are the ones M6.1 added.
- [ ] 1.7. Check the uninstall entry the installer registered:

  ```powershell
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object DisplayName -like 'Veltriva*' | Format-List DisplayName, DisplayVersion, UninstallString
  ```

  - **Expected:** `DisplayName` is `Veltriva Browser 0.1.0`, `DisplayVersion` is `0.1.0`, and `UninstallString` is `"C:\Users\<you>\AppData\Local\Programs\veltriva\Uninstall Veltriva.exe" /currentuser`. It is under HKCU (your user), not HKLM.
- [ ] 1.8. Open Settings ▸ Apps ▸ Installed apps (Windows 10: Apps & features).
  - **Expected:** one entry, **Veltriva Browser 0.1.0** (the installer puts the version in the name), version 0.1.0, publisher **Raymond Valdepeñas**. That name comes from the installer's registry entry (`package.json`'s author), not from a signature: SmartScreen still says "Unknown publisher" (1.2).
- [ ] 1.9. *(Optional.)* With Veltriva running, right-click its taskbar icon ▸ **Pin to taskbar**. Quit Veltriva. Click the pinned icon.
  - **Expected:** Veltriva starts, and its window sits under the pinned icon. There is no second Veltriva icon beside it (the shortcuts and the app share one AppUserModelID).
- **If it fails, report:**
  - the step, and any dialog text (a screenshot);
  - for 1.5 to 1.7, the output as text;
  - the installer's exact file name.

---

## 2. First run and settings

About 15 minutes. This is the first start of the installed app on an empty profile, so Veltriva is already showing the Welcome page from 1.3.

### The first start

- [ ] 2.1. Look at the window that opened.
  - **Expected:**
    - a window titled **Veltriva Browser** with the toolbar, sidebar and page drawn (not a blank window);
    - no error dialog.
- [ ] 2.2. Look at the first tab.
  - **Expected:** the first tab is "Welcome to Veltriva", with DuckDuckGo, Balanced and "Show me first" chosen.
- [ ] 2.3. Choose another engine and another preset. Choose **Start now**, then press **Start browsing**.
  - **Expected:**
    - the tab becomes the new-tab page;
    - a search from the address bar goes to the engine you chose;
    - the sidebar shows no preview notice.
- **If it fails, report:** the step, and what the page or the address bar did instead.

### Settings

- [ ] 2.4. Press the gear at the foot of the sidebar, then open another tab and press the gear again.
  - **Expected:** one Settings tab, selected both times.
- [ ] 2.5. Choose each preset in turn and read its description. End on **Balanced**.
  - **Expected:** each says in plain words when a tab is unloaded, how many stay in Tabs, and when Sleeping tabs are archived.
- [ ] 2.6. Open **Advanced**. Type `0` in "Tabs kept in Tabs" and press Enter. Then type `3` in "Memory is low below" and press Enter.
  - **Expected:** each time, a sentence under the field says what is wrong, and the value doesn't change:
    - for `0`: "Enter a whole number from 1 to 500 (tabs).";
    - for `3`: "Very low" must be below "low": pick a lower number here, or change the other one first. (The default for "very low" is 4, and `3` would put "low" under it.)
- [ ] 2.7. Choose **Another engine**, enter `http://example.com/?q={searchTerms}` and press **Use it**.
  - **Expected:** refused, with the sentence "Veltriva can't search with that address: it needs https, and {searchTerms} in its path or query." The engine you chose in 2.3 is still the one in use.
- **If it fails, report:** the step, the value you typed, and what you saw.

### Quit and start again

- [ ] 2.8. Close the window with its ✕.
  - **Expected:** the app exits. Within a few seconds, no `Veltriva.exe` is left in Task Manager (Details tab), or in `Get-Process Veltriva`.
- [ ] 2.9. Start Veltriva again.
  - **Expected:**
    - it launches normally, with no "already running" or profile-lock error;
    - no Welcome page this time, and your tab comes back;
    - Settings still shows **Balanced** and the engine you chose in 2.3.
- **If it fails, report:** the step, any dialog text, and whether `Veltriva.exe` was still running.

---

## 3. Browsing basics and keyboard

About 35 minutes. Have **three or more ordinary tabs** open for the keyboard tables, for example `https://example.com`, `https://www.wikipedia.org` and `https://developer.mozilla.org`.

### Everyday pages

- [ ] 3.1. Open any normal public video on `https://www.youtube.com`.
  - **Expected:** it plays with sound, seeking works, and 1080p can be selected in the quality menu. Paid or DRM videos not playing is **expected** (there's no Widevine).
- [ ] 3.2. Click YouTube's fullscreen button.
  - **Expected:**
    - the window goes fullscreen;
    - the toolbar and sidebar hide;
    - a notice says the site is fullscreen and **"Press Esc to exit full screen"**, then fades.
- [ ] 3.3. Press Esc.
  - **Expected:** the video and the window both leave fullscreen, and the toolbar is back. The window and the sidebar come back as they were; the toolbar is not covered.
- [ ] 3.4. Go fullscreen again, then press Ctrl+Tab with a second tab open.
  - **Expected:** fullscreen ends and the next tab is selected. The window and the sidebar come back as they were.
- [ ] 3.5. Go fullscreen again, then press F11.
  - **Expected:** fullscreen ends. The window and the sidebar come back as they were; the toolbar is not covered.
- [ ] 3.6. Go fullscreen again, then close the tab with Ctrl+W.
  - **Expected:** the window leaves fullscreen too. It doesn't stay fullscreen with no page.
- [ ] 3.7. Open a long PDF you trust, for example `https://www.rfc-editor.org/rfc/pdfrfc/rfc9110.txt.pdf` (about 200 pages).
  - **Expected:**
    - it renders in the built-in viewer;
    - scrolling, the viewer's own zoom, the thumbnail sidebar and text select-and-copy work.
- [ ] 3.8. In the PDF, find a word with Ctrl+F, then press Esc.
  - **Expected:** the find bar finds the word. Esc closes the bar and the match stays selected in the page.
- [ ] 3.9. Press the viewer's print button, then cancel the dialog.
  - **Expected:** the print dialog opens and cancels cleanly.
- [ ] 3.10. Press the viewer's download button.
  - **Expected:**
    - the file goes straight to your Downloads folder with **no Save As dialog**;
    - it shows in the downloads panel under the toolbar.
- **If it fails, report:**
  - which step;
  - any "browser not supported" banner;
  - whether the window stayed stuck in fullscreen;
  - for the PDF, what didn't work and roughly how long the first page took to appear.

### Browser-reserved shortcuts (the page never sees these)

Do each step with the **page** focused (click inside it first), unless the step says otherwise.

| ✓ | # | Keys | Expected |
|---|---|---|---|
| [ ] | 3.11 | Ctrl+T | A new tab opens, selected, with the cursor in the address bar. |
| [ ] | 3.12 | Ctrl+W, and Ctrl+F4 | The current tab closes. |
| [ ] | 3.13 | Ctrl+Shift+T | The last closed tab comes back, at its place, with its page. |
| [ ] | 3.14 | Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab, wrapping around at the ends. |
| [ ] | 3.15 | Ctrl+1 … Ctrl+8 | The 1st … 8th tab. A number with no tab does nothing. |
| [ ] | 3.16 | Ctrl+9 | The last tab. |
| [ ] | 3.17 | Number-pad digits with Ctrl | The same as the top-row digits. |
| [ ] | 3.18 | Ctrl+L, and Alt+D | The address bar takes focus with its text selected. |
| [ ] | 3.19 | F6 (press it several times) | F6 cycles **three stops**: from the page to the address bar (text selected), then to the selected tab in the sidebar, then back to the page, and round again. Section 10 checks this with Narrator. |
| [ ] | 3.20 | F5, and Ctrl+R | The page reloads. |
| [ ] | 3.21 | Ctrl+F5, Shift+F5, Ctrl+Shift+R | The page reloads, bypassing the cache. |
| [ ] | 3.22 | Alt+← / Alt+→ | Back / forward, when there's history. |
| [ ] | 3.23 | The mouse's back / forward side buttons (if your mouse has them) | Back / forward. |
| [ ] | 3.24 | F11, twice | The window goes fullscreen, then comes back. |
| [ ] | 3.25 | F12, twice | DevTools for the tab opens in its own window, then closes. Closing it with its ✕ works too, and the app keeps running. |
| [ ] | 3.26 | Ctrl+Shift+K | The memory palette opens over the page, with the cursor in its search field (section 7 checks it closely). The page doesn't react to the key. |

### Page-first shortcuts (the page can claim these; otherwise the browser acts)

| ✓ | # | Keys | Expected |
|---|---|---|---|
| [ ] | 3.27 | Ctrl+F on `example.com` | The find bar opens. Typing finds matches, Enter / Shift+Enter step through them, Esc closes it. |
| [ ] | 3.28 | F3 / Shift+F3, Ctrl+G / Ctrl+Shift+G (find bar open) | Next / previous match. |
| [ ] | 3.29 | Ctrl+K on `developer.mozilla.org` | **MDN's own search** opens: the page claimed the key, and the browser doesn't act. |
| [ ] | 3.30 | Ctrl+= or Ctrl++, Ctrl+-, Ctrl+0 | Zoom in, zoom out and reset. A zoom badge shows when the zoom isn't 100%. |
| [ ] | 3.31 | Ctrl with the number pad's +, -, 0 | The same as the row above. |
| [ ] | 3.32 | Ctrl with the mouse wheel, one notch at a time | The page zooms in with wheel up and out with wheel down, one zoom step per notch. The badge shows. Ctrl+0 resets. |
| [ ] | 3.33 | *(Only if you use a layout with AltGr, such as Polish or German.)* Type AltGr characters in a page's text box | The characters type. No tab shortcut fires. |

### Focus behavior

- [ ] 3.34. Press Ctrl+L, type `example.com` and press Enter.
  - **Expected:** once the page loads, focus is **in the page**. Pressing Space or ↓ scrolls the page and types nothing in the address bar.
- [ ] 3.35. Press Ctrl+L, type a few letters that match nothing you visited (for example `zzqqxx`), then press Esc.
  - **Expected:** the address bar goes back to the page's address, with all of it selected. Focus stays in the address bar. (When a suggestion list is open, Esc works in two steps; that is 7.17.)
- [ ] 3.36. Focus a page text field, press Ctrl+F, then press Esc.
  - **Expected:** the find bar closes, and focus goes back to the text field.
- [ ] 3.37. Right-click a link, then press Esc.
  - **Expected:** the menu closes, and the page keeps focus.
- **If it fails, report:** the keys, which element had focus before, and what happened instead. (The focus ring while tabbing through the toolbar is checked in 10.4.)

---

## 4. Web plumbing

About 60 minutes. Real accounts, permissions, popups, downloads, other apps, certificates and sign-in.

### Google sign-in

Veltriva sends Firefox's user agent in the `User-Agent` header to `accounts.google.com` and to no other site, because Google's sign-in refused plain Chromium-in-Electron (ADR-0002, item 11). The page's own `navigator.userAgent` stays Chromium's. The sign-in passed in the packaged build on 2026-10-19, so this check re-runs a result that was known to be good.

- [ ] 4.1. Open `https://accounts.google.com`. Press F12 to open DevTools for the tab. In its Console, run `navigator.userAgent`.
  - **Expected:** a Chrome user agent with **no** `Electron` and no `Veltriva` in it.
- [ ] 4.2. Sign in with your account: email, Next, password, Next, plus any 2-step prompt.
  - **Expected:** you reach your account page or Google's normal 2-step prompt, straight through. You should **not** see "Couldn't sign you in: This browser or app may not be secure", and no "Try again" step should be needed.
- [ ] 4.3. Close the tab, open `https://myaccount.google.com` in a new tab.
  - **Expected:** you're still signed in. The cookie lives in the profile.
- **If it fails, report:**
  - the exact error text Google shows, and the step where it showed;
  - whether "Try again" let you in;
  - the user agent from 4.1.
  - Don't try workarounds. A failure here is new: the earlier retest passed.

### An OAuth popup flow (skipped in Phase 1)

**Required: the OAuth popup check** (spike S7's M2, which Phase 1 skipped because no site was at hand). It proves that a "Sign in with Google/GitHub/Microsoft" popup keeps `window.opener` and `postMessage` across a real cross-site flow. It needs a real account on a real site.

**Pick the site first.** You need a site where you already have an account (or can make a throwaway one), and whose sign-in button opens a **small separate window** (a popup) instead of taking the whole tab to the provider's page.

- **How to tell:** click the button. A small window opening on top of the tab is a popup flow, and the one to use. If the whole tab navigates to Google, GitHub or Microsoft, it is a redirect flow, which doesn't test this: go back and try the next site.
- **Which sites use a popup changes over time, so none can be promised.** In the order I would try them:
  1. **Notion** (`https://www.notion.so/login`). Notion's own help page ("Log in & out") says that **Continue with Google** asks for your password in a pop-up window, and says the same for Apple and Microsoft. A throwaway Google account can make a Notion account on the spot.
  2. **Any site with Google's own "Sign in with Google" button**, the button that carries the Google "G". Google's button opens a popup unless the site chose a redirect, because popup is the default mode of Google Identity Services.
  3. **Dropbox** (Sign in with Google), **Canva** (Continue with Google), **Figma** (Continue with Google). These have used popups, but nobody checked them for this list.
  4. For GitHub: **StackBlitz** or **CodeSandbox** (Sign in with GitHub), and demo pages built on Firebase's `signInWithPopup`. Also not checked.
- **If a site redirects instead of opening a popup,** go back and try the next one. If none of them opens a popup, leave 4.4 to 4.6 unticked and report "no popup site found" with the sites you tried; that is a result too.
- Use a throwaway Google or GitHub account where you can. You only sign in; don't enter payment details.

- [ ] 4.4. Open the site and click the sign-in button.
  - **Expected:** a separate small window opens.
    - Its top bar shows the popup's real address, read-only.
    - There is no "Pop-up blocked" strip in the main window, because you clicked.
- [ ] 4.5. Finish the sign-in in the popup.
  - **Expected:** the popup closes by itself, and the original page shows you signed in. This proves `window.opener` and `postMessage` survive a real cross-site flow.
- [ ] 4.6. Sign out of the site, then repeat 4.4, but close the opener tab while the popup is still open. Use Ctrl+W in the main window.
  - **Expected:** the popup stays open after its opener is gone. Closing it afterwards causes no error.
- **If it fails, report:**
  - which site you used;
  - whether the popup opened as a window, opened as a tab, or was blocked;
  - whether it closed itself;
  - any `popup.` lines in the log.
  - If the page stays signed out, open the popup's DevTools (F12 inside it) and run `window.opener === null`, then report the result. A site can also break the link itself with a `Cross-Origin-Opener-Policy` header on its callback page; that is the site's choice, not Veltriva's.

### Camera, microphone and location prompts

Use `https://permission.site`.

- [ ] 4.7. Click **Camera**.
  - **Expected:**
    - a strip under the toolbar says the page wants to use your camera, with Allow, Block and ✕;
    - Allow can't be clicked for about half a second after the strip appears.
- [ ] 4.8. Click **Block**.
  - **Expected:** the site reports the camera as denied. Your camera light stays off.
- [ ] 4.9. Reload, click **Camera** again, then click **Allow**.
  - **Expected:** Windows' camera privacy settings may show their own prompt. Then the camera turns on, its light goes on, and the site shows video. Close the tab afterwards.
- [ ] 4.10. Repeat 4.7 to 4.9 for **Microphone** and **Location**.
- [ ] 4.11. Ask for the camera, then dismiss with ✕, three times in a row.
  - **Expected:** after the third time, the site stops prompting for that permission.
- [ ] 4.12. Click a permission that isn't prompted, such as **Pointer Lock**, **MIDI** or **USB**.
  - **Expected:** it's denied silently. There's no strip.
- **If it fails, report:** the permission, what the strip showed (take a screenshot), and what the site reported.

### Blocked popup, then "open anyway"

- [ ] 4.13. On `https://permission.site`, open DevTools (F12). In its Console, run:

  ```js
  setTimeout(() => window.open('https://example.com', '_blank', 'width=500,height=400'), 6000)
  ```

  Then wait 6 seconds **without clicking the page**.
  - **Expected:** no window opens. A **"Pop-up blocked"** strip offers **Open pop-up**.
- [ ] 4.14. Click **Open pop-up**.
  - **Expected:** `https://example.com` opens.
- [ ] 4.15. Click the site's own **Popup** button.
  - **Expected:** it opens, with no strip, because you clicked.
- **If it fails, report:** whether the strip showed, and what opened (a window, a tab or nothing).

### A `mailto:` link

- [ ] 4.16. Open `https://example.com`, press F12, and run this in the Console:

  ```js
  document.body.insertAdjacentHTML('beforeend', '<p><a href="mailto:test@example.com">mail</a></p>')
  ```

  Then click the new **mail** link on the page. A typed `data:` page won't work, because a tab can't show `data:` documents.
  - **Expected:**
    - a strip asks whether to open the link in another app, naming the scheme, with **Open** and **Cancel**;
    - nothing opens before you answer.
- [ ] 4.17. Click **Cancel**.
  - **Expected:** nothing opens.
- [ ] 4.18. Click the link again, then click **Open**.
  - **Expected:** your default mail app opens a new message to `test@example.com`. **Don't send it.**
- [ ] 4.19. Click the link, tick the box "Always allow example.com to open mailto: links", then click **Open**. Click the link once more.
  - **Expected:** this time it opens without asking. (5.18 checks that this survives a restart.)
- **If it fails, report:** the strip's text, and whether anything opened before you answered.

### Downloads

- [ ] 4.20. **An ordinary file.** Open `https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dnotes.txt`.
  - **Expected:**
    - `notes.txt` lands in your Downloads folder, with **no Save As dialog**;
    - the downloads panel shows it as done, with **Open** and **Show in folder**.
  - Click each one.
  - **Expected:** Notepad opens the file, and Explorer opens with the file selected.
- [ ] 4.21. **The same name again.** Repeat 4.20.
  - **Expected:** the second copy is named `notes (1).txt`.
- [ ] 4.22. **Pause, resume and cancel.** Open `https://httpbin.org/drip?duration=30&numbytes=3000&delay=0`.
  - **Expected:** it downloads slowly. **Pause** stops the progress, **Resume** continues, and **Cancel** stops it and leaves no file behind.
- [ ] 4.23. **A risky file that needs Keep.** Open `https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dtest.bat`. Its content is harmless JSON text, but `.bat` is a type Windows can run.
  - **Expected:**
    - the panel warns **"This type of file can harm your computer"**, with **Keep** and **Discard**;
    - the toolbar's downloads button shows a dot;
    - Explorer shows `test.bat.unconfirmed` in Downloads, and **Open** and **Show in folder** aren't offered.
- [ ] 4.24. Click **Keep**.
  - **Expected:** the file becomes `test.bat`, and **Show in folder** appears. **Don't open or run it.**
- [ ] 4.25. **Mark-of-the-Web.** In Explorer, right-click `test.bat`, then choose Properties.
  - **Expected:** the General tab has a Security note, "This file came from another computer…", with an **Unblock** checkbox. Don't tick it. Also check `notes.txt` from 4.20.
- [ ] 4.26. Repeat 4.23, then click **Discard**.
  - **Expected:** the file disappears from Downloads.
- [ ] 4.27. Clean up: delete `notes*.txt` and `test.bat` from Downloads.
  - **Expected:** Downloads no longer holds them. (5.20 recreates them.)
- **If it fails, report:**
  - the step;
  - the file name Explorer shows;
  - a screenshot of the panel or of the Properties window.

### Certificate errors (badssl.com)

- [ ] 4.28. Open each of these:
  - `https://expired.badssl.com`
  - `https://self-signed.badssl.com`
  - `https://wrong.host.badssl.com`
  - `https://untrusted-root.badssl.com`
  - **Expected, for each:**
    - the page **"Your connection to this site isn't private"**, with the address and an error name (e.g. `ERR_CERT_DATE_INVALID`);
    - **Try again**, and **Go back** if there's history;
    - **no** way to proceed to the site.
- [ ] 4.29. Open `https://badssl.com` (a valid certificate).
  - **Expected:** it loads normally, with the secure-connection icon.
- [ ] 4.30. Open `http://http.badssl.com`.
  - **Expected:** it loads, and the address bar marks it **Not secure**.
- [ ] 4.31. Open `https://client.badssl.com` (the site asks for a client certificate).
  - **Expected:** Veltriva never offers a certificate picker. Either the needs-a-certificate page appears, or badssl's own "400 No required SSL certificate was sent" page.
- **If it fails, report:** the address, the page title and error name you saw, or the fact that the site loaded anyway.

### HTTP Basic sign-in

- [ ] 4.32. Open `https://httpbin.org/basic-auth/user/pass`.
  - **Expected:**
    - a **Sign in** strip under the toolbar names `httpbin.org` and shows the server's realm as quoted server text;
    - the cursor is already in the username field.
- [ ] 4.33. Enter `user` / `pass` (httpbin's public test values), then click **Sign in**.
  - **Expected:** the page shows `"authenticated": true`.
- [ ] 4.34. Open `https://httpbin.org/basic-auth/user/other`. Enter `user` with a wrong password, such as `nope`, three times.
  - **Expected:** after the third try, the strip stops coming back and the page shows the server's refusal (a blank page or a 401).
- [ ] 4.35. Open `http://httpbin.org/basic-auth/user/pass` (plain **http**).
  - **Expected:** the strip warns **"Your password will be sent unencrypted"**. Click **Cancel**.
- [ ] 4.36. Open `https://httpbin.org/basic-auth/user/cancelme`, then click **Cancel**.
  - **Expected:** the page shows the server's refusal (a blank page or a 401). Nothing is signed in.
- [ ] 4.37. Reopen the 4.33 address in a new tab.
  - **Expected:** no prompt, because Chromium remembers that sign-in in memory. Quit the app, start it again and reopen the address.
  - **Expected:** it asks again. Nothing was written to disk.
- **If it fails, report:** the strip's text (take a screenshot), and the step.

---

## 5. Session restore and crash recovery

About 40 minutes, plus one 15-minute idle wait (5.24). This section restarts, kills and finally damages the app, so it runs on the test profile only. It ends with the profile damaged on purpose; section 6 starts by deleting it.

### Your tabs come back

- [ ] 5.1. Open five tabs: `https://example.com`, `https://en.wikipedia.org/wiki/Web_browser`, `https://permission.site`, `https://httpbin.org/html` and `https://www.iana.org/help/example-domains`. In the Wikipedia tab, follow two links, then press Back once. Pin the example.com tab (right-click it in the sidebar, **Pin**). Drag the permission.site tab to the bottom. Select the httpbin tab. Then quit and start Veltriva again.
  - **Expected:**
    - the same five tabs, in the same order, the pinned one first, with their titles;
    - the httpbin tab is selected and shows its page;
    - the other tabs load only when you select them: each one shows its loading indicator then, not before.
- [ ] 5.2. Select the Wikipedia tab, then press Back and Forward.
  - **Expected:** Back and Forward walk the same pages as before the restart.
- **If it fails, report:** which tab was missing, out of order, or loaded early, and what Back and Forward did.

### The window opens where it was

- [ ] 5.3. Make the window smaller, and move it to another place on the screen (or to another monitor, if you have one). Quit and start again.
  - **Expected:** same place, same size.
- [ ] 5.4. Maximize the window. Quit and start again.
  - **Expected:** it opens maximized. Restoring it (the middle title-bar button) gives back the size from 5.3.
- [ ] 5.5. *(Only if you use display scaling other than 100%: Settings ▸ System ▸ Display ▸ Scale.)* Quit and start three times in a row without touching the window.
  - **Expected:** the size never grows or shrinks between starts.
- [ ] 5.6. *(Only if you have two monitors.)* Put the window on the second one, quit, disconnect or turn off that monitor, start again.
  - **Expected:** the window opens on the remaining screen, fully visible.
- **If it fails, report:** your scaling, your monitor layout, and the size or place you got (a screenshot helps).

### One Veltriva at a time

- [ ] 5.7. With the app running, start it a second time (from the Start menu).
  - **Expected:** no second window. Within about two seconds the second start ends by itself and the open window comes to the front, its tabs untouched.
- **If it fails, report:** whether a second window opened, and any error text.

### Crashes

Let the app run for **more than a minute** before you kill it in 5.8 and 5.9. A kill within a minute of starting counts towards safe mode, which is 5.10's job.

- [ ] 5.8. Open two or three tabs, select one, and wait a few seconds. Kill the app. Start it again.
  - **Expected:**
    - your tabs are back, the selected one loaded;
    - a notice under the toolbar says **"Veltriva didn't close properly last time. Your tabs are back; the others load when you select them."**;
    - **Dismiss** removes it, and it doesn't come back on the next normal start (quit normally and start once more to see).
- [ ] 5.9. Open a new tab with any site, then kill the app **within about a second**. Start it again.
  - **Expected:** everything up to about a second before the kill is back. The last tab may be missing; nothing older is.
- [ ] 5.10. **Safe mode.** Start the app, wait until its window shows, then kill it **within a minute of starting**. Do that a second time: start, kill within a minute. Start the app a third time and leave it running.
  - **Expected:**
    - a notice: **"Veltriva closed unexpectedly twice soon after starting, so your tabs are back without loading. Select a tab, or press Reload, to load it."**;
    - every tab is listed, and none has loaded, the selected one included.
- [ ] 5.11. Press Reload on the selected tab. Then select another tab.
  - **Expected:** each loads when you do that.
- [ ] 5.12. Quit normally and start again.
  - **Expected:** a normal start: no safe-mode notice, and the selected tab loads by itself.
- **If it fails, report:** what was missing after the restart, the notice text if it differed, the step, and whether any tab loaded by itself in 5.10.

### Recently closed

- [ ] 5.13. Open three tabs, A, B and C, each with a different site, and in C follow one link. Close C, then B (Ctrl+W). Press Ctrl+Shift+T twice.
  - **Expected:** B comes back, then C, each where it was in the sidebar. In C, Back goes to the page before its link.
- [ ] 5.14. Close B and C again (B first, then C). Quit, start the app, and press Ctrl+Shift+T twice.
  - **Expected:** the same, after the restart: C, then B, with C's history.
- [ ] 5.15. Close every tab one by one (Ctrl+W), so the app opens a new-tab page by itself, then press Ctrl+Shift+T.
  - **Expected:** the last tab you closed comes back.
- **If it fails, report:** which tab came back (or didn't), where it landed, and what Back did.

### Choices that stay

- [ ] 5.16. On `https://permission.site`, click **Location**, then **Allow** in the strip. Click **Notifications**, then **Block**. Quit, start the app, reload permission.site, and click **Location** and **Notifications** again.
  - **Expected:** no strip for either. Location works (the site reports your position, or Windows asks for its own location permission); Notifications is denied.
- [ ] 5.17. Click **Camera**, then dismiss the strip with ✕, three times in a row. Quit, start the app, reload, and click **Camera**.
  - **Expected:**
    - after the third dismissal, the site stops prompting for the camera;
    - after the restart, the strip appears again. A dismissal is never stored; only Allow and Block are.
- [ ] 5.18. You ticked "always allow" for the `mailto:` link in 4.19. Quit, start the app, open `https://example.com`, add the link again (the Console line from 4.16) and click it.
  - **Expected:** your mail app opens without a strip. Close the new message without sending.
- [ ] 5.19. Do the same on `https://www.iana.org` (another site).
  - **Expected:** a strip asks first: the choice belongs to example.com only.
- **If it fails, report:** the step, what the site reported, and whether a strip appeared after the restart.

### Download history

- [ ] 5.20. Repeat 4.20 (`notes.txt`) and 4.23 (`test.bat`), but don't click Keep or Discard yet. Start `https://httpbin.org/drip?duration=60&numbytes=6000&delay=0`, and while it's still running, kill the app. Start the app and open the downloads panel.
  - **Expected:**
    - `notes.txt` is listed as done, and **Open** opens it;
    - `test.bat` still waits for **Keep** or **Discard**, and **Keep** works;
    - the drip download shows as **interrupted**, with no Resume.
- [ ] 5.21. Remove the drip download from the list, quit and start again.
  - **Expected:** it stays gone; the others are still listed.
- [ ] 5.22. Clean up: delete `notes*.txt`, `test.bat` and any `drip*` file from Downloads.
  - **Expected:** they are gone from Downloads.
- **If it fails, report:** the panel as you saw it (a screenshot), and the step.

### What happens at startup

- [ ] 5.23. Settings ▸ **When Veltriva starts** ▸ **Start with a new tab**. Open three pages and pin one, quit, and start again.
  - **Expected:** a new tab is selected, the pinned tab is there, and the other two are in the Archive. Then set the choice back to **Continue where you left off**.
- **If it fails, report:** the step, and which tabs were where.

### Database recovery

**This damages the database on purpose.** Your own profile is already safe in `Veltriva-real-backup` (section 0); don't do this if it isn't.

- [ ] 5.24. Start the app, open two or three sites, then **leave the computer alone for 15 minutes** (no mouse or keyboard). Veltriva takes its daily backup only while you're away, and checks every 10 minutes after 5 idle minutes. Quit. Check that a backup exists:

  ```powershell
  Get-ChildItem "$env:APPDATA\Veltriva\backups"
  ```

  - **Expected:** a file named `veltriva-daily-<date and time>.db`. If there is none, repeat the 15 minutes.
- [ ] 5.25. Damage the database's first 100 bytes, then start the app:

  ```powershell
  $f = "$env:APPDATA\Veltriva\veltriva.db"; $b = [IO.File]::ReadAllBytes($f); [Array]::Clear($b, 0, 100); [IO.File]::WriteAllBytes($f, $b)
  ```

  - **Expected:**
    - it starts normally, with a notice: **"Veltriva's database was damaged, so it was restored from a backup from …"**, naming the time of the backup and the file the damaged one was kept as;
    - the profile folder has that `veltriva.db.corrupt-…` file (`Get-ChildItem "$env:APPDATA\Veltriva"`); nothing was deleted;
    - the history from before the backup is there. Quit, then `vq "SELECT url, title FROM pages"` lists the sites you opened in 5.24. Pages visited after the backup was taken aren't expected.
- [ ] 5.26. Quit. Move the backups away, then damage the file again, and start the app:

  ```powershell
  Move-Item "$env:APPDATA\Veltriva\backups" "$env:TEMP\veltriva-backups-saved"
  $f = "$env:APPDATA\Veltriva\veltriva.db"; $b = [IO.File]::ReadAllBytes($f); [Array]::Clear($b, 0, 100); [IO.File]::WriteAllBytes($f, $b)
  ```

  - **Expected:** it starts with one new tab and the notice **"Veltriva's database was damaged and no backup could be used, so Veltriva started with an empty one."**, naming the kept file.
- **If it fails, report:** the notice text, the files in `%APPDATA%\Veltriva` (`Get-ChildItem`), and any error.

---

## 6. Lifecycle and automation

About 50 minutes, plus waits. Automation is slow on purpose. With the shipped settings (Balanced), a hidden tab is unloaded after an hour, a tab moves to Sleeping after 2 hours of your active use, and a Sleeping tab is archived after 3 days of use; for your first 3 active days automation only *previews* its moves. So this section shortens the times in **Settings ▸ Tabs and automation ▸ Advanced** (a collapsed heading; type a number and press Enter, it applies at once). The old checklist edited the database for this; Settings does the same now.

- **Automation needs a moment.** It does nothing in the first 2 minutes after a start, then looks every minute. "Wait 3 minutes" below means: leave the app running and use another tab or another app.
- **Sites:** well-known public pages only. Nothing here signs in or pays.

### Start from a fresh profile

6.0 is setup, not a check. The preview check (6.6) needs a profile that is new.

- Quit Veltriva, then delete the test profile and start again:

  ```powershell
  Remove-Item -Recurse -Force "$env:APPDATA\Veltriva"
  ```

- The Welcome page appears. Leave **DuckDuckGo, Balanced and "Show me first"** as they are, and press **Start browsing**.

### By hand: Sleeping and the Archive

Open four or five tabs on different sites first.

- [ ] 6.1. Right-click a tab ▸ **Move to Sleeping**.
  - **Expected:** it leaves the tab list and appears under **Sleeping** (count 1); a toast says "Moved to Sleeping" with **Undo**. The summary at the bottom says "Sleeping 1 · Archived today 0".
- [ ] 6.2. Click **Undo**.
  - **Expected:** the tab is back where it was.
- [ ] 6.3. Move it to Sleeping again, select another tab, then click the Sleeping row.
  - **Expected:** the tab comes back next to the tab you were on, selected, with its page as it was.
- [ ] 6.4. Right-click a tab ▸ **Archive tab**. Open **Archive** in the sidebar.
  - **Expected:** under "Recently archived" it shows with "… · by you", and "Archived today 1". Clicking it reopens the page next to the current tab; Back works.
- [ ] 6.5. Try **Move to Sleeping** on a pinned tab.
  - **Expected:** the item is greyed out.
- **If it fails, report:** the step, the counts, and where the tab ended up.

### Preview, "Start now" and Undo

Set these in Advanced (they make automation act within a few minutes). Leave preview on:

| Field | Type |
|---|---|
| Tabs kept in Tabs | `3` |
| Move a tab beyond them to Sleeping after (minutes of browsing) | `1` |
| Leave a tab you used alone for (minutes) | `0` |

- [ ] 6.6. Open 6 tabs on different sites, use them for a minute or two, then stay on the last one. Keep using the app (scroll, click) for 3 minutes.
  - **Expected:** nothing moves. The sidebar's footer says "Preview: automation shows what it would move (day 1 of 3)", and the tabs it would move carry a small mark whose tooltip says "Preview: would move to Sleeping".
- [ ] 6.7. Click **Start now**.
  - **Expected:**
    - within about a minute the marked tabs move, with the usual toast ("Moved N tabs to Sleeping") and **Undo**;
    - the tabs you used least go to Sleeping, all but the 3 most recent unpinned ones;
    - the Activity view (the **Activity** button, a scroll icon, at the bottom of the sidebar) lists each move with "Moved to Sleeping — too many open tabs".
- [ ] 6.8. Click **Undo** in the toast within a minute.
  - **Expected:** they come back in their places, and they are not moved again right away.
- **If it fails, report:** what moved during preview, what the sidebar said, how many moved, which ones, and what the toast and Activity view said.

### Pause

Now also set "Unload a hidden tab after" to `1` (minute) in Advanced; later checks need it.

- [ ] 6.9. Click **Pause automation** in the sidebar's footer.
  - **Expected:** the footer says "Automation paused" and the button now reads **Resume automation**. With the short times, nothing moves or unloads, even after several minutes. Quit and start: still paused.
- [ ] 6.10. Click **Resume automation**.
  - **Expected:** automation goes on within a few minutes.
- **If it fails, report:** what moved while paused.

### The diagnostics page

- [ ] 6.11. Type `veltriva://diagnostics` in the address bar.
  - **Expected:** a page of Veltriva's own, "Automation diagnostics", with the regret metric (moves, how many you took back within an engaged hour, the rate), the unloads you reloaded within the hour, your active day and engaged hours, the settings, and the memory it sees. It says it never leaves this machine.
- [ ] 6.12. Once automation has moved a tab again after 6.10, bring that tab back from Sleeping at once, then refresh the diagnostics page.
  - **Expected:** one more regret is counted.
- **If it fails, report:** what the page showed.

### Protection and the "why"

- [ ] 6.13. Right-click a tab ▸ **Protect from automation**.
  - **Expected:** a shield on the tab; its tooltip says "Protected from automation". With the short times it never moves or unloads. You can still archive it yourself.
- [ ] 6.14. Right-click a tab ▸ **Always protect ‹site›**.
  - **Expected:** every tab on that site (also ones you open later, and after a restart) says its site is protected, and automation leaves them alone. **Stop protecting ‹site›** undoes it.
- [ ] 6.15. Leave in the background: a page playing sound, a page you allowed to show notifications (for example `https://permission.site`, Notifications, Allow), and a chat or mail page you are signed in to that changes its title when something arrives. Wait 3 minutes.
  - **Expected:** hovering each shows why it is kept: "Kept awake: playing audio", "… the site can send you notifications", "… active in the background". The plain pages beside them unload. (Skip the third page if you have no mail or chat page, and say so.)
- **If it fails, report:** which tab moved or unloaded anyway, the page, and the tooltip text.

### Unloading a background tab

- [ ] 6.16. Open `https://en.wikipedia.org/wiki/Web_browser`, scroll halfway down, and open `https://example.com` in a new tab. Wait 3 minutes on the example.com tab. Hover the Wikipedia tab in the sidebar.
  - **Expected:** the tooltip says "Unloaded to save memory — click to reload".
- [ ] 6.17. Select the Wikipedia tab.
  - **Expected:** it reloads (a short loading indicator) and comes back at the place you scrolled to. Back still works.
- [ ] 6.18. Play a YouTube video (or any page with sound), then switch to another tab and wait 3 minutes.
  - **Expected:** the video keeps playing; hovering its tab says "Kept awake: playing audio" (or "playing media").
- [ ] 6.19. Mute that video (the player's own mute button), switch away, wait 3 minutes.
  - **Expected:** still playing, muted: the tab is kept ("Kept awake: playing media", shown once automation has asked the page).
  - **Known limit:** a muted video inside a player *embedded from another site* (for example a YouTube video embedded in a blog post) is not seen, and that tab may be unloaded; with its sound on, it is kept. Note it if it surprises you in daily use.
- [ ] 6.20. On a page with a text field you can type in (for example a search box that stays on the page, or a comment field), type a few words without sending them, switch away, wait 3 minutes.
  - **Expected:** the tab is still loaded and your text is still there.
- [ ] 6.21. Open a page that asks "Leave site?" when you close it with unsaved changes (for example an online text editor with a draft), type something, switch away, wait 3 minutes.
  - **Expected:** the tab is still loaded; its tooltip says it reported unsaved changes.
- [ ] 6.22. Let a tab be unloaded (as in 6.16), quit, start again, and select that tab.
  - **Expected:** it loads its page as after any restart, at the same address, with Back working.
- [ ] 6.23. With tabs in Sleeping and the Archive, and a protected tab, quit and start again.
  - **Expected:** the Sleeping tabs and the Archive are still there, unloaded; the protected tab still shows its shield.
- **If it fails, report:** the tooltip text, where the page came back, which page, what happened to the tab or your text, and what was missing after the restart.

### Real memory and waking up

Put the times back to the shipped ones first: Settings ▸ Tabs and automation ▸ choose **Balanced** and press **Reset all to the preset** in Advanced. Do these two at a natural break.

- [ ] 6.24. With your usual browsing (15 or more tabs), leave some in the background for 15 minutes or more while you work in others.
  - **Expected:** a background tab may reload when you select it; its tooltip and the Activity view say "Unloaded because memory was low" or "very low". The tab you use never reloads under you.
- [ ] 6.25. Lock the screen or sleep the laptop for an hour or more, then come back.
  - **Expected:** nothing happens at once: no burst of reloads, no tabs moving the moment you return.
- **If it fails, report:** what reloaded or moved and when, how long after you returned, and what the Activity view says.

---

## 7. Search memory and the palette

About 25 minutes. Your own browsing, in the memory. First visit at least 10 different pages (docs, news, a few searches), open 3 or 4 of them as tabs, move one tab to Sleeping and archive another (the tab's right-click menu), so the memory has something in each place.

### Opening it

- [ ] 7.1. Press **Ctrl+Shift+K** while a page has the keyboard.
  - **Expected:** a panel opens over the page, with a field ("Search your tabs and history") that already has the keyboard; the page stays visible (and a playing video keeps playing) under a dim layer; the toolbar and sidebar look as before.
- [ ] 7.2. Close it with **Esc**, then open it with the **Search memory…** button at the top of the sidebar.
  - **Expected:** Esc closes it and the page has the keyboard again (type into a text field on the page to check); the button opens the same panel.
- [ ] 7.3. With nothing typed, look at the list.
  - **Expected:** the pages you use most and most recently, open tabs among them, each with its site and "visited … ago", and a state label where a tab shows it: **Open**, **Sleeping** or **Archived**.
- **If it fails, report:** the step, and what the panel or the page did instead.

### Finding things

- [ ] 7.4. Type **a few partial words** of the archived tab's title (for example the first 3 letters of two of its words).
  - **Expected:** it is in the list, labelled **Archived**, with the typed parts highlighted in its title.
- [ ] 7.5. Press **Enter**.
  - **Expected:** the palette closes, the tab is back in the Tabs list next to the current tab, selected, on its page.
- [ ] 7.6. Open the palette, type part of the Sleeping tab's title, and press Enter.
  - **Expected:** it comes back from Sleeping, selected.
- [ ] 7.7. Open the palette, type part of a page that is open in a tab, and press **Ctrl+Enter**.
  - **Expected:** a new tab opens with that page; the other tab stays.
- [ ] 7.8. Type something that matches nothing (for example `zzqqxx`).
  - **Expected:** "No pages match", no error.
- [ ] 7.9. Type characters a search engine treats specially: `-docs "news OR (x`.
  - **Expected:** no error and no surprise: the punctuation is ignored, and the results are the pages with words starting with `docs`, `news` and `or` (a one-letter word like `x` doesn't narrow the search), or "No pages match".
- **If it fails, report:** what you typed, what the list showed, and a screenshot.

### Filters and keys

- [ ] 7.10. With the palette open, press **Tab** a few times, then **Shift+Tab**.
  - **Expected:** the filter row moves through All, Open, Sleeping, Archived, Today, This week and back; the list changes to match (Archived shows only archived tabs).
- [ ] 7.11. Type `site:` and a site you visited, then a word, for example `site:wikipedia.org history`.
  - **Expected:** a "site: wikipedia.org" chip appears next to the field and every result is from that site; a click on the chip removes it (and the `site:` word).
- [ ] 7.12. Use **Up**, **Down**, **PageUp** and **PageDown**.
  - **Expected:** the highlighted result moves; Down from the last goes back to the first.
- [ ] 7.13. Press **Alt+S** (or the **Score details** button).
  - **Expected:** a small panel shows how the highlighted result was scored (Text match, Frecency, Title words, …), with two decimals; Alt+S again hides it.
- **If it fails, report:** the key, and what happened.

### The address bar's memory

- [ ] 7.14. Click the address bar and type 3 or more letters of a page you visited.
  - **Expected:** up to 6 suggestions hang under the address bar over the page, with the typed parts highlighted; nothing else changes.
- [ ] 7.15. Type part of a page that is open in another tab.
  - **Expected:** that suggestion says **Switch to tab**; pressing Down to it and Enter selects that tab instead of loading the page again.
- [ ] 7.16. Choose a suggestion for a page no tab shows.
  - **Expected:** the current tab goes to that page.
- [ ] 7.17. Type something, press **Esc** once, then again.
  - **Expected:** the first Esc closes the suggestions and keeps your text; the second puts the tab's address back.
- [ ] 7.18. Type a full address (`example.com`) and press Enter without choosing a suggestion.
  - **Expected:** it goes to that address, as before the memory existed.
- **If it fails, report:** what you typed, what the list showed, and which tab ended up where.

### The Archive list

- [ ] 7.19. Open the **Archive** section of the sidebar.
  - **Expected:** every archived tab is listed, newest first, with when and by whom it was archived (not only the newest 200).
- [ ] 7.20. Scroll the list quickly to the end and back.
  - **Expected:** it scrolls smoothly; rows may say "Loading…" for a moment and then show their tabs.
- [ ] 7.21. Click an archived tab (or focus it and press Enter).
  - **Expected:** it comes back to the Tabs list, selected.
- **If it fails, report:** how many tabs the Archive said it had, and what the list did.

To try the Archive with thousands of tabs you need real use over time, or the E2E fixture that seeds 10,000 archived tabs (ask for it).

---

## 8. Privacy, data and diagnostics

About 40 minutes. What Veltriva remembers, how you take it back, and what it writes about itself.

### Pause memory and site rules

- [ ] 8.1. Turn on Settings ▸ Memory ▸ **Pause memory**, visit a page with an unusual word in its title, turn Pause memory off, then search the memory (Ctrl+Shift+K) for that word.
  - **Expected:** it isn't found.
- [ ] 8.2. Right-click a tab of a site you use, and choose **Don't remember ‹site›**.
  - **Expected:** Settings ▸ Site rules lists the site with "Don't remember" ticked. A page on it you visit next is not found by the palette, and closing its tab leaves nothing for Ctrl+Shift+T.
- [ ] 8.3. Choose **Remember ‹site› again** from the same menu.
  - **Expected:** the rule goes from the list (unless the site is also protected).
- **If it fails, report:** the site and the step.

### Clearing data

- [ ] 8.4. Settings ▸ Clear data: choose **The last hour**, keep **Pages you visited**, press **Clear…**, then **Clear**.
  - **Expected:** a sentence says how many pages and visits went. The palette no longer finds pages from the last hour, and still finds older ones. (This needs pages older than an hour in the memory; the profile from 6.0 on usually has some. If not, only the first half can be checked.)
- [ ] 8.5. Sign in to a site you don't mind signing in to again. Then **Forget a site**: type it, keep both boxes ticked, **Forget…**, **Forget**.
  - **Expected:** you are signed out of it on the next visit, and the palette finds none of its pages.
- [ ] 8.6. In the palette, highlight a result and press Shift+Delete.
  - **Expected:** the footer says it was removed, and it disappears from the results.
- [ ] 8.7. Allow a site to send notifications, then Settings ▸ Site permissions: change it to **Blocked**, then **Remove** it.
  - **Expected:** the list follows each change; after Remove, the site asks again the next time.
- [ ] 8.8. Settings ▸ Memory: set "Keep pages you visited for" to `30`, leave the field, then reopen Settings.
  - **Expected:** 30 is kept.
- **If it fails, report:** the step, and what the page said.

### Reading the database

Some checks read the profile's database file directly, with `vq` (section 0). **Quit Veltriva before each `vq`.** Other rows from your earlier browsing may also appear; look for the ones described.

- [ ] 8.9. Start the app. In a new tab: type `example.com` in the address bar and press Enter; then type `veltriva test search` and press Enter (a search); press Back once (back to example.com); press Reload. In another tab, type `https://en.wikipedia.org/wiki/Main_Page` and press Enter, then click any article link. Wait three seconds, then quit. Run:

  ```powershell
  vq "SELECT * FROM (SELECT v.visited_at, p.url, p.title, p.visit_count, p.typed_count, v.transition FROM visits v JOIN pages p ON p.id = v.page_id ORDER BY v.visited_at DESC LIMIT 12) ORDER BY visited_at"
  ```

  - **Expected:**
    - `https://example.com/` with the title **Example Domain**, visited as `typed`, then `back_forward`, then `reload`; its `typed_count` is 1;
    - the search results page, visited as `generated` (the search engine's own page may add a row or two of its own, as `link`);
    - the Wikipedia main page as `typed`, and the article as `link`;
    - every row has a real title, not an empty one or the previous page's.
- [ ] 8.10. **Addresses are cleaned before they're stored.** Start the app and open each of these, one by one, in the address bar:
  - `https://example.com/?utm_source=manual&fbclid=abc&id=7&token=secret123#access_token=secret456`
  - `https://example.com/callback?code=secret789&state=xyz`
  - `https://example.com/cb#access_token=secret000`

  **Close those three tabs** (the session keeps an open tab's exact address so it can come back; that's checked separately), wait three seconds, and quit. Run:

  ```powershell
  vq "SELECT url, url_key FROM pages WHERE host = 'example.com'"
  vq "SELECT count(*) AS secrets FROM pages WHERE url LIKE '%secret%' OR url_key LIKE '%secret%'"
  ```

  - **Expected:**
    - one row with `url` = `https://example.com/?utm_source=manual&fbclid=abc&id=7` (the token parameter and the token fragment are gone) and `url_key` = `https://example.com/?id=7` (tracking parameters gone too);
    - **no** row for `/callback` or `/cb`: sign-in callbacks are never recorded;
    - `secrets` is `0`.
- [ ] 8.11. **Icons.** Start the app, open `https://en.wikipedia.org/wiki/Web_browser`, then type `https://en.wikipedia.org/wiki/Tab_(interface)` in the same tab.
  - **Expected:** the sidebar shows Wikipedia's "W" icon for **both** pages (the second page has the same icon as the first).
- [ ] 8.12. Quit, then run:

  ```powershell
  vq "SELECT p.title, f.mime, length(f.bytes) AS bytes FROM pages p JOIN favicons f ON f.id = p.favicon_id WHERE p.host = 'en.wikipedia.org'"
  ```

  - **Expected:** both pages, sharing one icon: the same `mime` and `bytes` on both rows.
- [ ] 8.13. Open a few ordinary sites, one after another, for example `https://www.wikipedia.org`, `https://github.com`, `https://developer.mozilla.org` and `https://www.youtube.com`.
  - **Expected:** each shows its own icon in the sidebar within a few seconds. (`example.com` has no icon of its own, so that is not a failure.) Icons are fetched by Veltriva's main process, which M6.1 changed to re-check every redirect and every address; this confirms ordinary icons still arrive.
- **If it fails, report:** the `vq` output (copy it as text), both outputs for 8.10, whether the sidebar showed the icons, and which sites had no icon.

### The diagnostics page

- [ ] 8.14. Open a few heavy pages (a video site, a map), then go to `veltriva://diagnostics`.
  - **Expected:** "Memory per tab" lists them heaviest first, in MB; an unloaded tab shows "—". The database's size and last backup are shown.
- [ ] 8.15. Press **Export diagnostics…** and save; open the file in a text editor.
  - **Expected:** no page title and no address in it. With **Include the addresses of open tabs** ticked, a second export holds the addresses.
- [ ] 8.16. Press **Show the log folder**.
  - **Expected:** Explorer opens the profile's `logs` folder.
- **If it fails, report:** the step, and for 8.15 the lines that hold what they shouldn't.

### Diagnostic logging

- [ ] 8.17. Type an address that can't load, such as `http://127.0.0.1:9/`, then open `logs\veltriva.log` in the profile folder.
  - **Expected:** a `tab.loadFailed` line with `"url":"[hidden]"`.
- [ ] 8.18. With Diagnostic logging still **off**, search the whole log for anything that looks like an address:

  ```powershell
  Select-String -Path "$env:APPDATA\Veltriva\logs\veltriva.log" -Pattern 'http|mailto:|file:'
  ```

  - **Expected:** no output. Wherever a web address, an e-mail address, a path or a host would be, the log says `[hidden]`.
- [ ] 8.19. Turn on Settings ▸ Diagnostics ▸ **Diagnostic logging**, load the same address, and look again.
  - **Expected:** the new line has the address. Turn it off again.
- **If it fails, report:** the two lines, or the line that shows an address.

### Scroll restore

- [ ] 8.20. Scroll far down a long article, switch to another tab, quit, and start again; then select the article's tab.
  - **Expected:** it loads where you had scrolled.
- [ ] 8.21. Do the same on a sign-in page (with a password field). If it is too short to scroll, zoom in (Ctrl+=) until it scrolls.
  - **Expected:** it loads at the top.
- **If it fails, report:** the site and how far it was off.

---

## 9. JS dialogs, "Leave page?", print and the file chooser

About 15 minutes. The first three are known limitations (see section 0): you are checking that they behave as documented, not that they are nice.

### JS dialogs

**Required: the JS-dialog checks.** Phase 5 decided to keep Electron's native dialogs for v1.0, because Electron 45 has no way to handle them in the browser (ADR-0002 item 12, `docs/plans/mvp-gap-audit.md`, the README's Known limitations). 9.1 to 9.3 confirm that this is what a person sees: `alert` and `confirm` block the whole window and don't name the site, `prompt()` returns nothing, and a page's second dialog offers to stop the page.

- [ ] 9.1. On a page, open DevTools (F12) and run `setTimeout(() => alert('hello'), 5000)` in the Console; switch to another tab within 5 seconds.
  - **Expected (a known limitation):** the box appears anyway and blocks the whole window until you press OK. Its title says "Veltriva Browser", and it doesn't name the site. Pressing OK gives the window back.
- [ ] 9.2. In the same Console, run `alert('one'); alert('two')`.
  - **Expected:** the first box has only OK. The second also has a box to tick, "Prevent this app from creating additional dialogs". Tick it and press OK, then run `alert('three')`: no box appears.
- [ ] 9.3. Run `prompt('Your name?')`.
  - **Expected (a known limitation):** no box appears, and the Console shows `null`.
- **If it fails, report:** the step, and a screenshot of what appeared.

### "Leave page?"

Use a site with a form that warns about unsaved changes (a draft in a web mail or an online editor). With no such site handy: on `https://example.com`, open DevTools (F12), run `addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' })`, then click once inside the page.

- [ ] 9.4. Type something in the form, then type another address in the address bar and press Enter.
  - **Expected:** a strip in the toolbar asks "Leave ‹site›? Changes you made may not be saved." (its name for a screen reader is "Leave page"). **Stay** keeps the page and your text; **Leave** goes to the new address.
- [ ] 9.5. On the same kind of page, type something, then press **Ctrl+W**.
  - **Expected:** the toolbar asks "Leave ‹site›? Changes you made may not be saved." with **Leave** and **Stay**.
- [ ] 9.6. Click **Stay**, then press Ctrl+W again and click **Leave**.
  - **Expected:** Stay keeps the tab and your text; Leave closes it. **Ctrl+Shift+T** brings the tab back (without the text).
- [ ] 9.7. Close a page you never touched with the tab's ✕.
  - **Expected:** it closes at once, without asking.
- **If it fails, report:** the site, and what was asked or not.

### Print and the file chooser

- [ ] 9.8. Press Ctrl+P on a page, and choose **Print…** from a page's right-click menu.
  - **Expected:** Windows' print dialog both times. Cancel prints nothing.
- [ ] 9.9. On any page, open DevTools (F12) and run this in the Console:

  ```js
  document.body.insertAdjacentHTML('beforeend', '<p><input type="file"></p>')
  ```

  Then click the new **Choose File** button and choose a small file you don't mind.
  - **Expected:** Windows' own **Open** dialog appears. It is modal to the Veltriva window, as Chrome's is. After you choose a file, the page's input shows its name. Nothing is uploaded.
- **If it fails, report:** the step, and a screenshot of what appeared.

---

## 10. Accessibility

About 60 minutes. These are the checks of `docs/testing/accessibility.md`, **sections A to G, in the same order and with the same wording**: A is 10.1–10.5, B 10.6–10.12, C 10.13–10.17, D 10.18–10.20, E 10.21–10.24, F 10.25–10.28 and G 10.29. They are short, so they are repeated here to keep this list complete; tick them here or there, not both. Veltriva's own interface (the toolbar, the sidebar, the palette, the prompts and its pages) aims for WCAG 2.2 AA. An automated axe-core scan already covers the shell in every state in both themes; these are the checks axe can't judge: does Narrator say the right thing at the right time, does the keyboard order make sense, is the focus always visible. The web pages in tabs are other people's documents, and Narrator reads them as it would in Edge; these checks are about Veltriva's interface only.

- **Narrator:** Ctrl+Win+Enter turns it on and off. The Narrator key is Caps Lock (or Insert).
  - Caps Lock+Space switches scan mode. Leave scan mode **off** in Veltriva's interface; Narrator turns it on in web pages by itself.
  - Caps Lock+Tab reads the focused item again.
- **The keyboard alone:** put the mouse aside for 10.1 to 10.24.
- **Both themes:** run 10.25 to 10.28 once with Windows in light mode and once in dark mode (Settings ▸ Personalization ▸ Colors ▸ Choose your mode). Tick a box only when it passed in both.
- **Reduced motion:** 10.29 turns Windows' animation effects off (Settings ▸ Accessibility ▸ Visual effects ▸ Animation effects).
- Open three or four ordinary sites in tabs first, so the lists have something in them.
- When you are done, put Windows back: animation effects on, text size 100%, contrast theme off, Narrator off, your usual light or dark mode.

### Getting around by keyboard

- [ ] 10.1. Click into a web page, then press **F6**.
  - **Expected:** the address bar takes focus with its text selected. Narrator names it "Address and search bar" and reads the address.
- [ ] 10.2. Press **F6** again.
  - **Expected:** focus moves to the selected tab in the sidebar. Narrator reads the tab's title, "tab", its position ("2 of 4") and "selected".
- [ ] 10.3. Press **F6** again.
  - **Expected:** focus goes back to the page. F6 cycles three stops: the address bar, the sidebar's selected tab, the page, and then the address bar again.
- [ ] 10.4. From the address bar, press **Tab** repeatedly, then **Shift+Tab**.
  - **Expected:** every control in the toolbar and the sidebar gets a visible focus ring, in reading order. Nothing is skipped or reached twice. Nothing invisible takes focus, and nothing is unreachable.
- [ ] 10.5. Press **Ctrl+L**, then **Alt+D**.
  - **Expected:** both put focus in the address bar.
- **If it fails, report:** the step, where the focus was before and after, and what Narrator said.

### The sidebar

- [ ] 10.6. With focus on a tab row, press **Down**, **Up**, **Home** and **End**.
  - **Expected:** focus moves between tabs without switching the page. Narrator reads each title, its position and its state ("Unloaded — click to reload", "Playing audio", "Protected from automation" and so on, where they apply).
- [ ] 10.7. Press **Enter** (or **Space**) on another tab.
  - **Expected:** that tab is shown, focus stays in the sidebar, and Narrator says "selected".
- [ ] 10.8. Press **Alt+Shift+Down**, then **Alt+Shift+Up**.
  - **Expected:** the focused tab moves one place down, then back. Focus stays on it.
- [ ] 10.9. Press **Shift+F10** (or the Menu key) on a tab.
  - **Expected:** the tab's menu opens. Narrator reads its items. Esc closes it.
- [ ] 10.10. Press **Delete** on a tab you don't need.
  - **Expected:** it closes, and focus moves to the next tab.
- [ ] 10.11. Tab to the **Sleeping** and **Archive** headings and press **Enter** on each.
  - **Expected:** Narrator says "collapsed" or "expanded", with the count. Expanding shows the rows; arrow keys move between them; Enter restores one.
- [ ] 10.12. After an action that offers Undo (archiving a tab from its menu), listen.
  - **Expected:** Narrator announces the Undo message once, without moving the focus. Tab reaches the Undo button.
- **If it fails, report:** the step, the row's title, and what Narrator said instead.

### The address bar and the memory palette

- [ ] 10.13. In the address bar, type two letters of a site you visited.
  - **Expected:** Narrator says how many suggestions there are. Down and Up move through them and Narrator reads each one ("Switch to tab" where it applies), while focus stays in the field. Esc closes the list.
- [ ] 10.14. Press **Ctrl+Shift+K**.
  - **Expected:** the palette opens with focus in "Search memory". Narrator reads the field's name.
- [ ] 10.15. Type a word from a page you visited.
  - **Expected:** Narrator announces the number of results. Down and Up read each result: its title, site, when you visited it, and where the tab is (Open, Sleeping, Archived). The field announces the highlighted one.
- [ ] 10.16. Press **Tab** a few times, then **Shift+Tab**.
  - **Expected:** the filter moves on (All, Open, Sleeping, Archived, Today, This week) while focus stays in the field. Narrator announces the filter with the count ("Open: 3 results").
- [ ] 10.17. Press **Esc**.
  - **Expected:** the palette closes, and focus returns to where it was.
- **If it fails, report:** the step and what Narrator said.

### Prompts and notices

- [ ] 10.18. On a site that asks to show notifications (or to know your location), let it ask.
  - **Expected:** the question appears in the strip under the toolbar. Narrator reads it once ("site wants to …") without moving focus. Tab reaches its buttons, and each button's name says what it does.
- [ ] 10.19. Answer with the keyboard.
  - **Expected:** the strip closes, and focus returns to where it was.
- [ ] 10.20. Open a site that goes fullscreen (a video's fullscreen button), with the keyboard if the site allows.
  - **Expected:** Narrator reads the notice naming the site and how to leave. Esc leaves fullscreen.
- **If it fails, report:** the site, the step, and what Narrator said.

### Veltriva's pages

- [ ] 10.21. Open Settings (the gear at the foot of the sidebar, or `veltriva://settings`). Move through it with Tab, and read it with Narrator's arrow keys (Caps Lock+Right). Use Settings ▸ Clear data ▸ **Clear…** once. NVDA works as well as Narrator.
  - **Expected:**
    - Each section has a heading.
    - Every switch, choice and field has a name that says what it does.
    - A value main refuses is announced as an error next to its field.
    - After **Clear…**, the focus is on the **Clear** button of the question.
- [ ] 10.22. Do the same on `veltriva://diagnostics`.
  - **Expected:** the tables read row by row, with their headers. "Refresh" announces when it's done.
- [ ] 10.23. Open a tab on `http://127.0.0.1:9/`, an address that always fails.
  - **Expected:** Narrator reads the error page's heading and the error code. Tab reaches "Try again".
- [ ] 10.24. **This starts a new profile.** Quit Veltriva, delete the test profile (`Remove-Item -Recurse -Force "$env:APPDATA\Veltriva"`), start Veltriva, and go through the Welcome page by keyboard.
  - **Expected:** each choice is a group of radio buttons with a name. "Start browsing" is reachable.
- **If it fails, report:** the page, the control, and what Narrator said.

### Seeing it: focus, contrast, zoom (once per theme)

- [ ] 10.25. Tab through the toolbar, the sidebar, a prompt and Settings.
  - **Expected:** the focused control always has a ring you can see clearly, never only a color change.
- [ ] 10.26. Look at the gray text: tab states, counts, hints, the palette's sites and dates.
  - **Expected:** it is easy to read against its background, in both themes.
- [ ] 10.27. Set Windows' text size to 150% (Settings ▸ Accessibility ▸ Text size), then restart Veltriva.
  - **Expected:** the interface grows. Nothing is cut off or overlaps in the toolbar, the sidebar, the palette or Settings.
- [ ] 10.28. Turn on a Windows contrast theme (Settings ▸ Accessibility ▸ Contrast themes), then restart Veltriva.
  - **Expected:** the interface stays usable: text is readable and the focus ring is visible. (Veltriva doesn't draw its own contrast-theme colors; this checks that nothing disappears.)
- **If it fails, report:** a screenshot, the theme, and where.

### Reduced motion

- [ ] 10.29. With animation effects off, load a slow page, open the palette, and start a download.
  - **Expected:** the loading bar, the tab spinner and the download progress stand still (a dimmed bar, a still circle) instead of moving. The palette appears without fading in. Sections open without turning arrows.
- **If it fails, report:** what still moved.

---

## 11. About and updates

About 20 minutes. The update notice is **off by default and silent while off**: no request, no DNS lookup and no timer runs until you turn it on.

- 11.1 to 11.5 check the off state and the About page.
- 11.6 to 11.10 turn the check on once, to see what a user sees today. The default feed is GitHub's API for `RMV-Coder/veltriva`, which has no published release yet, so a check can't find a newer version: it says it got no answer. Turning it on makes one request to `api.github.com`; turn it off again at the end (11.10).
- A real "newer version" notice is covered by automated tests with a local feed, so you don't need to produce one.

- [ ] 11.1. Type `veltriva://about` in the address bar.
  - **Expected:** a page "About Veltriva Browser", with a "This build" table: the versions of **Veltriva Browser** (**0.1.0**, the number in the installer's file name), **Electron** (45.0.0), **Chromium**, **Node.js** and **V8**.
- [ ] 11.2. Scroll to **License**.
  - **Expected:** it says Veltriva Browser is free software under the MIT License, and holds the MIT license text in a box you can scroll.
- [ ] 11.3. Open **Third-party notices**.
  - **Expected:** a long text that starts with "THIRD-PARTY SOFTWARE NOTICES" and lists the packages Veltriva ships (for example Electron and React). Below it, a line says Chromium's and Node.js's own licenses are in `LICENSES.chromium.html`, next to `Veltriva.exe` in the installation folder (you saw that file in 1.6).
- [ ] 11.4. Open Settings ▸ **Updates**.
  - **Expected:**
    - a note that says Veltriva can tell you when a newer version is out and never downloads or installs anything by itself;
    - **Check for new versions** is **not** ticked;
    - the status sentence is "Off. Veltriva never contacts the release feed while this is off.";
    - there is no **Check now** button;
    - the "Release feed" box holds `https://api.github.com/repos/RMV-Coder/veltriva/releases/latest`, with a **Use it** button, and an **About Veltriva** button opens the About page.
- [ ] 11.5. Look at **Updates** on the About page.
  - **Expected:** the same "Off. …" sentence, no **Check now** button, and an **Update settings** button that opens Settings.
- [ ] 11.6. In Settings ▸ Updates, tick **Check for new versions**.
  - **Expected:** a **Check now** button appears next to the status sentence. Veltriva may start its first check at once, because it waits only two minutes after the app starts and has been running longer; the sentence may already have changed.
- [ ] 11.7. Press **Check now**.
  - **Expected:** the sentence says "Checking…" for a moment (a check gives up after 15 seconds), then, with no release published yet:
    - **"The last check didn't get an answer (‹date and time›). Veltriva tries again a day later."** The same sentence appears if you are offline;
    - no update notice appears anywhere;
    - the log has an `updates.checkFailed` warning line (`Get-Content "$env:APPDATA\Veltriva\logs\veltriva.log" -Tail 5`), with no address in it.
  - If a release `v0.1.0` has been published at that repository by the time you run this, the sentence is "Veltriva 0.1.0 is the newest version (checked ‹date and time›)." instead. If a newer release exists, it is "Veltriva ‹version› is available. You have 0.1.0.", with a notice offering **View release**, **Skip this version** and **Dismiss**. Any of the three is right; report which you saw.
- [ ] 11.8. Open `veltriva://about` again and look at **Updates**.
  - **Expected:** the same sentence as 11.7, now with a **Check now** button beside **Update settings**.
- [ ] 11.9. In Settings ▸ Updates, replace the feed address with `http://example.com/releases` and press **Use it**.
  - **Expected:** refused, with the sentence "Veltriva only checks an https address (or http on this computer), with no user name or password in it." Reload Settings (F5): the box holds the default address again. Then try `example.com/releases` and **Use it**: the sentence is "Use an https address, such as https://api.github.com/repos/owner/name/releases/latest." If the box doesn't hold the default address afterwards, type it back (`https://api.github.com/repos/RMV-Coder/veltriva/releases/latest`) and press **Use it**.
- [ ] 11.10. Untick **Check for new versions**.
  - **Expected:** the status sentence goes back to "Off. Veltriva never contacts the release feed while this is off." and **Check now** disappears. No update notice has appeared anywhere during this whole checklist.
- **If it fails, report:** the step, the sentence you saw (or a screenshot of the page), and for 11.7 the last lines of the log.

---

## 12. Benchmarks on a quiet machine (a separate session)

**Required: the memory benchmark on a quiet machine (12.4 to 12.7).** About 20 minutes of attention, plus about 15 minutes for the search benchmark and about 2 hours for the memory benchmark (rough; the 100-tab size adds about an hour more).

Where the numbers stand:
- **Memory.** The first attempt (2026-10-22, `docs/benchmarks/phase-3-memory.md`) failed because the laptop was too loaded: every run of the 10-tab size stalled under heavy paging. The development laptop's later run, reported in `docs/benchmarks/memory.md`, **was made under load**; that report says how loaded the machine was (free memory, commit charge, processor load and the biggest processes at each run's start). **The quiet-machine run is what confirms or replaces those numbers.**
- **Search.** Measured on the same laptop (2026-10-23), every §5.4 target met (`docs/benchmarks/search.md`), also under load. A quiet-machine run (12.2 to 12.3) confirms it.

Both need a machine with nothing else on it, and **you shouldn't use the computer while they run**. They run from the repository (set up with `npm run setup`), not from the installed app.

- [ ] 12.1. Get the machine quiet: close every other app (browsers, editors, dev servers, Docker, chat, Veltriva itself) and plug the laptop in. In Task Manager ▸ Performance ▸ Memory, look at **Available**.
  - **Expected:** well over 2 GB available with nothing else running (the 50-tab size needs it). If you can't get there, run only the smaller sizes (see the tip below) and say so.
- [ ] 12.2. In the repository root, run the search benchmark (about 15 minutes):

  ```powershell
  npm run bench:search
  ```

  - **Expected:** it ends with `1 passed`, and a new `docs/benchmarks/data/phase-4-search-<date>-1000-10000-50000-first-after-5000ms.json.gz` exists.
- [ ] 12.3. Run the summarizer on that file:

  ```powershell
  node tests/benchmarks/summarize-search.mjs docs/benchmarks/data/phase-4-search-<date>-1000-10000-50000-first-after-5000ms.json.gz
  ```

  - **Expected:** every "§5.4 targets" line says **met** (p95 at 10,000 pages ≤ 30 ms; at 50,000 pages p95 ≤ 50 ms, p99 ≤ 60 ms, first search ≤ 100 ms).
- [ ] 12.4. **Required.** Run the memory benchmark (about 2 hours; sizes 10, 25 and 50 tabs, each with one warm-up run, discarded, and 5 measured runs, each a fresh launch):

  ```powershell
  npm run bench:memory
  ```

  - **Expected:** it finishes, and new files `docs/benchmarks/data/memory-<date>-10-25-50.json.gz` and `.csv` exist. (Each run is saved as it ends, and a run that fails is recorded with its error and the next one starts.)
- [ ] 12.5. **Required.** Run the summarizer on the memory file:

  ```powershell
  node tests/benchmarks/summarize-memory.mjs docs/benchmarks/data/memory-<date>-10-25-50.json.gz
  ```

  - **Expected:** a table for each size (10, 25, 50), headed "‹N› tabs (5 of 5 measured runs finished)", with rows for **Empty (start)**, **A: all live**, **B: moved to Sleeping, live** and **C: unloaded**, as the median and range of the measured runs.
    - **No "Run ‹n› failed" lines** under any size.
    - **C is clearly lower than A.** The earlier partial readings had unloading 9 of 10 tabs free about 307 MB (about 34 MB per tab), and spike S8 measured about 40 MB per tab.
    - **B is about the same as A**, or slightly higher (14 to 16 MB in the earlier readings): moving tabs to Sleeping alone frees nothing.
    - **The load lines are low.** Under each size, "Free memory at each run's start", "Commit charge at each run's start … processor load …" and "Largest processes at run ‹n›'s start" show how quiet the machine was. Compare them with the ones in `docs/benchmarks/memory.md`: free memory should be higher, the processor load lower, and no browser or dev server in the largest-processes list.
- [ ] 12.6. *(Only if the machine has room: see section 0.)* Run the 100-tab size, which the default leaves out (about an hour):

  ```powershell
  $env:BENCH_SIZES = "100"; npm run bench:memory; Remove-Item Env:BENCH_SIZES
  ```

  - **Expected:** it finishes, and new files `docs/benchmarks/data/memory-<date>-100.json.gz` and `.csv` exist.
- [ ] 12.7. *(Only if you ran 12.6.)* Run the summarizer on both memory files:

  ```powershell
  node tests/benchmarks/summarize-memory.mjs docs/benchmarks/data/memory-<date>-10-25-50.json.gz docs/benchmarks/data/memory-<date>-100.json.gz
  ```

  - **Expected:** a fourth table, for 100 tabs, with the same shape and no failed runs. If the per-tab saving holds, unloading 99 tabs frees roughly 99 times the per-tab figure of the smaller sizes.
- **If it fails, report:** the command's last output, the summarizer's output (copy it as text), and the free memory Task Manager showed before you started. Then send back the new files in `docs/benchmarks/data/`: they become the benchmark report.

**Tip: one size at a time.** If the machine struggles, run a size alone and give the summarizer all the files:

```powershell
$env:BENCH_SIZES = "10"; npm run bench:memory; Remove-Item Env:BENCH_SIZES
```

---

## 13. Uninstall, reinstall and upgrade

**Required: uninstalling by hand.** About 35 minutes, plus about 15 minutes if you build the older installer for 13.6. This uses the installed app and the test profile. **The uninstaller's "Yes" deletes `%APPDATA%\Veltriva`.** That is the test profile; yours is in `Veltriva-real-backup` (section 0).

`scripts/installer-test.ps1` already ran every path below on the development machine, pressing the uninstaller's buttons itself. What it can't tell you is what a person sees: the wording of the two questions and which button is the default.

Before you start, open two sites in Veltriva and pin one, so you can see the profile survive. Then quit. If Veltriva is still running when you start the installer or the uninstaller, Windows says "Veltriva Browser is running. Click OK to close it."; quit it yourself first.

Uninstall means: Settings ▸ Apps ▸ Installed apps (Windows 10: Apps & features) ▸ **Veltriva Browser 0.1.0** ▸ Uninstall (Windows 11: the ⋯ menu beside it). Windows may ask you to confirm first; that box is Windows', not Veltriva's.

- [ ] 13.1. *(Optional.)* **Reinstall over the same version.** With Veltriva installed and quit, run `release\Veltriva-Browser-Setup-0.1.0.exe` again.
  - **Expected:**
    - it replaces the app without asking anything: no "Are you sure?" and no question about your data;
    - Veltriva starts when it ends, with your two tabs and the pin still there, and no Welcome page.
  - The script didn't run this one; it ran an upgrade from an older version (13.7).
- [ ] 13.2. **Cancel.** Start an uninstall. The uninstaller's first box (after any confirmation from Windows itself) reads **"Are you sure you want to uninstall Veltriva Browser?"**, with **OK** and **Cancel**. Choose **Cancel**.

  ```powershell
  Test-Path "$env:LOCALAPPDATA\Programs\veltriva\Veltriva.exe"
  ```

  - **Expected:** the uninstaller closes and nothing is removed: the command prints `True`, and both shortcuts and the Installed apps entry are still there.
- [ ] 13.3. **Uninstall, keeping the data.** Quit Veltriva and start an uninstall. Choose **OK** at "Are you sure …?". The next box is Veltriva's own:

  > Also remove your Veltriva data from this computer?
  >
  > This deletes your tabs, history, settings and site data in C:\Users\‹you›\AppData\Roaming\Veltriva. Choose No to keep them for a later install.

  It has **Yes** and **No**. **No is the default button**: it is the one with the focus when the box opens. Don't click it; press **Enter**, which chooses the default.

  ```powershell
  Test-Path "$env:LOCALAPPDATA\Programs\veltriva"
  Test-Path "$env:APPDATA\Veltriva\veltriva.db"
  ```

  - **Expected:**
    - the box reads as above, with Yes and No and No highlighted;
    - the app is gone: both shortcuts are gone, it's gone from Installed apps, and the first command prints `False`;
    - the second command prints `True`: pressing Enter kept your profile.
- [ ] 13.4. Run the installer again.
  - **Expected:** Veltriva starts with the two tabs and the pin from before: the profile was kept. No Welcome page.
- [ ] 13.5. **Uninstall, removing the data.** Quit Veltriva and uninstall again. Choose **OK** at "Are you sure …?". This time click **Yes** at "Also remove your Veltriva data from this computer?".
  - **Expected:** the app is gone, and `Test-Path "$env:APPDATA\Veltriva"` prints `False`.
- [ ] 13.6. **Install an older version.** This needs an older installer, and you have none (0.1.0 is the first release). Build one from the commit just before the version became 0.1.0, in a throwaway copy (about 15 minutes, most of it `npm run setup`):

  ```powershell
  # In the repository root. Use git here: it is a scratch copy.
  git worktree add --detach "$env:TEMP\veltriva-old" bd5f89b
  Select-String '"version"' "$env:TEMP\veltriva-old\package.json"
  Push-Location "$env:TEMP\veltriva-old"
  npm run setup
  npm run package:installer
  Copy-Item release\Veltriva-Browser-Setup-0.0.0.exe "$env:TEMP\"
  Pop-Location
  git worktree remove --force "$env:TEMP\veltriva-old"
  ```

  The `Select-String` line must show `"version": "0.0.0"`. Then, with nothing installed, run `%TEMP%\Veltriva-Browser-Setup-0.0.0.exe`. On the Welcome page choose **Start browsing**, open two sites, pin one, and quit.
  - **Expected:** it installs like 1.2 and 1.3, and Installed apps lists **Veltriva Browser 0.0.0**. Skip 13.6 to 13.7 if you don't want to build the older installer, and say so.
- [ ] 13.7. **Upgrade over it.** Run `release\Veltriva-Browser-Setup-0.1.0.exe` over the 0.0.0 install.

  ```powershell
  Test-Path "$env:APPDATA\Veltriva\veltriva.db"
  ```

  - **Expected:**
    - it asks nothing: no "Are you sure?" and no question about your data (an update's uninstall step never asks and never removes the profile);
    - Veltriva starts when it ends, with your two tabs and the pin, and no Welcome page; `Test-Path` prints `True`;
    - `veltriva://about` shows Veltriva Browser **0.1.0**;
    - Installed apps shows one entry, **Veltriva Browser 0.1.0**, not two.
- [ ] 13.8. *(Optional.)* **Silent uninstall, keeping the profile.** Quit Veltriva, then:

  ```powershell
  Start-Process "$env:LOCALAPPDATA\Programs\veltriva\Uninstall Veltriva.exe" -ArgumentList '/currentuser /S' -Wait
  Start-Sleep 10
  Test-Path "$env:LOCALAPPDATA\Programs\veltriva"
  Test-Path "$env:APPDATA\Veltriva\veltriva.db"
  ```

  - **Expected:** no dialog at all. The uninstaller finishes from a temporary copy of itself, which is why the command waits ten seconds. The commands print `False`, then `True`.
- [ ] 13.9. *(Optional.)* **Silent uninstall, removing the profile.** Run the installer again, let Veltriva start, quit it, then:

  ```powershell
  Start-Process "$env:LOCALAPPDATA\Programs\veltriva\Uninstall Veltriva.exe" -ArgumentList '/currentuser /S --delete-app-data' -Wait
  Start-Sleep 10
  Test-Path "$env:LOCALAPPDATA\Programs\veltriva"
  Test-Path "$env:APPDATA\Veltriva"
  ```

  - **Expected:** no dialog. Both commands print `False`.
- **If it fails, report:**
  - the step;
  - the question's exact wording, which button had the focus, or that it never appeared;
  - what `Test-Path` printed;
  - any dialog text.

**Then put your own profile back,** if you have one:

```powershell
if (Test-Path "$env:APPDATA\Veltriva") { Remove-Item -Recurse -Force "$env:APPDATA\Veltriva" }
if (Test-Path "$env:APPDATA\Veltriva-real-backup") { Rename-Item "$env:APPDATA\Veltriva-real-backup" "Veltriva" }
```

Install Veltriva again afterwards if you want to keep using it.

---

## 14. Clean Windows 10 and Windows 11 virtual machines

**Required: installs on clean Windows 10 and Windows 11.** About 45 minutes per VM. This is the one test of a Windows that has never seen Veltriva, Node, or this repository. Use **64-bit (x64)** virtual machines, freshly installed, ideally from a snapshot you can go back to. Copy `Veltriva-Browser-Setup-0.1.0.exe` into each (a shared folder, a USB disk, or any download you host), and check its hash there: `Get-FileHash` must show `C8DF080BE7243EF8CFA3F7A8C6231D0C01CEFCD01991423B7B684C53B734AEE5` (PowerShell prints it in capitals). Run the same steps on each. **Windows 10 answers No at the uninstall question, Windows 11 answers Yes,** so each answer is tried on a clean machine; the last item of each VM tries the other answer.

**Write down, for each VM:**
- the Windows version and build (`winver`, for example "Version 22H2, OS Build 19045.‹n›"), and the edition;
- the VM product and version, the memory and processors you gave it, and whether 3D acceleration was on;
- whether it had internet and sound.

**No runtime should be asked for.** Veltriva carries its own Chromium, and the installer is per user. It needs no .NET, no Visual C++ Redistributable and no WebView2. If any step asks you to install one of those, or shows a missing-DLL error, stop and report the step, the exact text and the program that asked. That would be a bug, not a setup step.

### Windows 10

- [ ] 14.1. Run the installer.
  - **Expected:** as 1.2 and 1.3: SmartScreen may show "Windows protected your PC" (choose More info, then Run anyway); no administrator prompt; no wizard; Veltriva starts by itself.
- [ ] 14.2. Look at the window, the desktop, the Start menu and Settings ▸ Apps ▸ Apps & features.
  - **Expected:** a window titled **Veltriva Browser** with the toolbar, sidebar and page drawn (not blank or black), no error dialog, a **Veltriva Browser** shortcut on the desktop and in the Start menu, and an entry **Veltriva Browser 0.1.0** in Apps & features.
- [ ] 14.3. Look at the first tab, choose any engine and preset, and press **Start browsing**.
  - **Expected:** the first tab is "Welcome to Veltriva"; after Start browsing it becomes the new-tab page.
- [ ] 14.4. Browse a few sites: `https://example.com`, `https://en.wikipedia.org/wiki/Web_browser`, a YouTube video, and a search from the address bar. Open three tabs.
  - **Expected:** the pages load; the sidebar shows their titles and icons; the search goes to the engine you chose; the video plays (if the VM has sound, it plays with sound).
- [ ] 14.5. Type `veltriva://about`.
  - **Expected:** the About page shows version 0.1.0, the MIT license and the third-party notices (11.1 to 11.3).
- [ ] 14.6. *(Quick.)* Press Ctrl+Shift+K and type part of a page you visited.
  - **Expected:** the palette finds it; Enter switches to its tab.
- [ ] 14.7. Close the window with its ✕.
  - **Expected:** within a few seconds no `Veltriva.exe` is left in Task Manager (Details tab).
- [ ] 14.8. Start Veltriva from the Start menu.
  - **Expected:** your tabs are back; no Welcome page.
- [ ] 14.9. Quit, then uninstall: Settings ▸ Apps ▸ Apps & features ▸ **Veltriva Browser 0.1.0** ▸ Uninstall. Choose **OK** at "Are you sure you want to uninstall Veltriva Browser?", then answer **No** to "Also remove your Veltriva data from this computer?".
  - **Expected:** both boxes read as in 13.3, with No as the default. The app and both shortcuts are gone; `%APPDATA%\Veltriva` is still there.
- [ ] 14.10. *(Optional.)* Run the installer again (your tabs come back), quit, and uninstall again, answering **Yes** this time.
  - **Expected:** the app and both shortcuts are gone, and `%APPDATA%\Veltriva` is gone too.
- **If it fails, report:**
  - the Windows build (`winver`) and the VM product;
  - the step and any dialog text;
  - a screenshot, especially for a blank or black window (and the VM's 3D acceleration setting);
  - whether `Veltriva.exe` was still running;
  - anything that asked for a runtime.

### Windows 11

- [ ] 14.11. Run the installer.
  - **Expected:** as 14.1.
- [ ] 14.12. Look at the window, the desktop, the Start menu and Settings ▸ Apps ▸ Installed apps.
  - **Expected:** as 14.2, with the entry in Installed apps.
- [ ] 14.13. Look at the first tab, choose any engine and preset, and press **Start browsing**.
  - **Expected:** as 14.3.
- [ ] 14.14. Browse a few sites, as in 14.4.
  - **Expected:** as 14.4.
- [ ] 14.15. Type `veltriva://about`.
  - **Expected:** as 14.5.
- [ ] 14.16. *(Quick.)* Press Ctrl+Shift+K and type part of a page you visited.
  - **Expected:** as 14.6.
- [ ] 14.17. Close the window with its ✕.
  - **Expected:** as 14.7.
- [ ] 14.18. Start Veltriva from the Start menu.
  - **Expected:** as 14.8.
- [ ] 14.19. Quit, then uninstall: Settings ▸ Apps ▸ Installed apps ▸ **Veltriva Browser 0.1.0** ▸ Uninstall. Choose **OK** at "Are you sure you want to uninstall Veltriva Browser?", then answer **Yes** to "Also remove your Veltriva data from this computer?".
  - **Expected:** both boxes read as in 13.3, with No as the default. The app and both shortcuts are gone, and `%APPDATA%\Veltriva` is gone too.
- [ ] 14.20. *(Optional.)* Run the installer again (the Welcome page appears, on a new profile), quit, and uninstall again, answering **No** this time.
  - **Expected:** the app and both shortcuts are gone, and `%APPDATA%\Veltriva` is still there.
- **If it fails, report:** as for Windows 10.

---

## 15. Decisions for you

These are not checks. Nothing in the repository needs to change until you decide, and nothing has been published.

### 15.1 Code signing

**Required: code signing is your decision** (ADR-0007 item 5; `docs/distribution/signing.md`). Veltriva's builds are **unsigned**. Signing costs money, or needs a public repository for the free route. Until you decide, builds stay unsigned.

**What users see with an unsigned build** (you saw it in 1.2, 1.8 and section 14):
- Edge and Chrome may say the installer "isn't commonly downloaded": **Keep** (Edge: **⋯ ▸ Keep ▸ Keep anyway**).
- Windows SmartScreen shows **"Windows protected your PC"** with "Unknown publisher": **More info ▸ Run anyway**. SmartScreen builds a reputation per file, so every new version shows the warning again until enough people have run it.
- Installed apps shows the publisher the installer wrote into its registry entry (Raymond Valdepeñas), but nothing proves it: that name isn't signed. No UAC prompt appears, because the installer is per-user.
- The ASAR integrity fuse still detects a modified `app.asar`. Signing adds proof of **who** built it.

**The three routes** (details and what to change in each case: `docs/distribution/signing.md`):

| Route | Cost | Needs |
|---|---|---|
| **SignPath Foundation** (ADR-0007's choice) | Free for open source | A public repository under an OSI license (MIT is fine); builds made by CI from that repository; MFA. You approve each release in SignPath |
| **Azure Artifact Signing** (formerly Trusted Signing) | A monthly fee | An Azure subscription and identity validation; the public-trust tier for individuals is region-limited |
| **An OV or EV certificate** | Yearly fee; EV costs more | A hardware token or a cloud HSM (required for new certificates since 2023) |

After you choose, a signed build is checked with `Get-AuthenticodeSignature` (its `Status` must be `Valid`, with a timestamp); both commands are in `signing.md`. Silent auto-update (`electron-updater`) is planned only once builds are signed.

### 15.2 Publishing releases

Nothing is published. What exists, locally:
- the **tag `v0.1.0`** (annotated and unsigned, on the M6.3 release commit 654e29e);
- the draft release page `docs/releases/v0.1.0.md`;
- `release\Veltriva-Browser-Setup-0.1.0.exe` and `release\SHA256SUMS.txt`.

The repository has no remote, nothing is pushed, the release script (`npm run release -- <version>`) only tags locally, and the CI workflows (`ci.yml`, `codeql.yml`, `release.yml`, Dependabot) run only once you push to GitHub yourself. **Pushing and publishing are your call.** To publish, when you decide (`docs/distribution/releasing.md`, "To publish later"):
1. Push the branch and the tag: `veyra push origin main`, `veyra push origin v0.1.0`. There is no remote yet, so create the GitHub repository and add it as `origin` first.
2. `release.yml` makes a **draft** release with the installer and `SHA256SUMS.txt`, or you make one by hand with those two files.
3. Fill in the draft page's highlights, then publish the release on GitHub.

One thing to settle first: the tag sits on 654e29e, **before** M6.4's README, benchmark report and docs. If you want the published v0.1.0 to include them, prepare the tag again after M6.4 (`veyra undo` reverses the release commits and the tag, or delete the local tag and run `npm run release -- 0.1.0` again). Nothing has been pushed, so moving it costs nothing; the installer is rebuilt then, and the hash in 1.1 and 14 changes with it.

### 15.3 The update check's default feed

The update notice is **off in every build** until a user turns it on (Settings ▸ Updates ▸ **Check for new versions**), and silent while off. Its default feed is GitHub's latest-release API for `RMV-Coder/veltriva`, `https://api.github.com/repos/RMV-Coder/veltriva/releases/latest`. It only answers once a published release exists there; until then a check says it "didn't get an answer" (11.7). The decision:
- **Leave it as it is,** if the project will live at `RMV-Coder/veltriva`. Nothing needs to change, and the notice starts working with the first published release.
- **Change it before you publish,** if it will live somewhere else: `DEFAULT_FEED_URL` in `src/core/updates/release-feed.ts`, and the tests and docs that name the address. Any user can already point the check at another feed in Settings ▸ Updates.

When a newer version exists, the notice offers **View release**, **Skip this version** and **Dismiss**, and downloads nothing. After your first public release, one check closes this: install the older build, turn the setting on, press **Check now**, and see the notice for the newer version.

---

## When you're done

- Make sure your own profile is back (the end of section 13).
- Delete `%TEMP%\veltriva-backups-saved` (from 5.26), and `%TEMP%\Veltriva-Browser-Setup-0.0.0.exe` if you built it (13.6).
- If you built the older installer, check that the scratch copy `%TEMP%\veltriva-old` is gone (`git worktree list` shows only the repository).
- Leave Veltriva installed or not, as you like.
- Send back the unticked items, with their numbers and what you saw.

## Source checks merged into others (the duplicates)

Every distinct check from the five phase checklists is above. These repeated another one and were merged, with the check each went into:

| Old check | Merged into |
|---|---|
| P1 D2 (open example.com and one other site) | 3.1, 4.x and 14.4: every other check loads pages |
| P1 D3, P2 G s4, P3 F s3, P4 E (exit part), P5 H (exit part): "no `Veltriva.exe` left in Task Manager" | 2.8 (and 14.7, 14.17) |
| P1 D4 (start again; no lock error) and P5 A1 s3 (no Welcome the second time) | 2.9 |
| P1 D5 (Mark-of-the-Web in the packaged build) | 4.23 to 4.25 (this list already runs in the installed app) |
| P1 D6 and P4 A1 s4 (F12 DevTools) | 3.25 |
| P4 A1 s1 (YouTube, fullscreen, Esc) | 3.1 to 3.3 |
| P4 A1 s2 (a PDF, find a word) | 3.7 and 3.8 |
| P4 A1 s3 (download a small file) | 3.10 and 4.20 |
| P2 G s1–2 (packaged: two tabs come back) and P2 G s3 (second start) | 5.1 and 5.7 |
| P2 E2 s1 ("repeat C3") | 4.16 to 4.19, which 5.18 builds on |
| P3 A3 s1 (leave fullscreen with Esc, F11, Ctrl+Tab) | 3.3 to 3.5 |
| P3 F s1–2 (packaged: Sleeping and Archive survive a restart) | 6.1 to 6.4 and 6.23 |
| P4 E s1 (packaged: find an archived tab by its title) | 7.4 and 7.5 |
| P1 B3 s4 (Tab through the toolbar; a visible focus ring) | 10.4 |
| P1 B1 "F6" row (alternates the address bar and the page) | 3.19 and 10.1 to 10.3, with the wording M6.2 made current: the address bar, the sidebar, then the page |
| P4 B3 s5 (Narrator in the palette) | 10.15 |
| P5 G s1 (a screen reader in Settings) | 10.21 |
| P5 H s1 (packaged: Settings keeps the preset) | 2.5 and 2.9 |

Four things also changed from the old checklists, so nothing in them is stale:

- **The installed app replaces `npm run dev`** and the `VELTRIVA_USER_DATA_DIR` throwaway profile. The profile is `%APPDATA%\Veltriva`, which you move aside in section 0. Kill is `Stop-Process -Name Veltriva -Force`, and `popup.` and similar lines are in `logs\veltriva.log`, not a terminal.
- **Phase 3's `vlife` helper is gone.** Settings ▸ Advanced (added in Phase 5) sets the same short times.
- **Out-of-date expectations were brought up to date:** Ctrl+Shift+K opens the palette (Phase 1 said nothing happens), Esc in the address bar has a suggestions step (Phase 1 said there is no list), F6 cycles three places (Phase 1 said two), a restart restores your tabs (Phase 1's packaged check said it starts fresh), and Google's sign-in has had its per-site user agent since 2026-10-19, so 4.1 to 4.3 no longer wait to decide whether one is needed.
- **Two checks were added** because their source named them as manual and no checklist had them: Ctrl with the real mouse wheel (3.32; ADR-0008) and choosing a file in the file chooser (9.9; the gap audit).
