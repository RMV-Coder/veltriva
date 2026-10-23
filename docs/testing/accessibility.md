# Accessibility checks (Phase 6, M6.2)

Veltriva's own interface (the toolbar, the sidebar, the palette, the prompts and its pages) aims for WCAG 2.2 AA. Two kinds of checks cover it:
- **Automated:** `tests/e2e/accessibility.spec.ts` runs axe-core against the shell in every state a user can reach, in the light and the dark theme, with WCAG 2.2 A and AA rules. It runs in the E2E suite.
- **By hand, below:** what axe can't judge. Does Narrator say the right thing at the right time? Does the keyboard order make sense? Is the focus always visible?

The web pages in tabs are other people's documents, and Narrator reads them as it would in Edge. These checks are about Veltriva's interface only.

**You run them yourself,** in the packaged build or `npm run dev`. For each item, tick the box when the result matches **Expected**. If it doesn't, write down what **If it fails, report** asks for.

## Before you start

- **Narrator:** Ctrl+Win+Enter turns it on and off. The Narrator key is Caps Lock (or Insert).
  - Caps Lock+Space switches scan mode. Leave scan mode **off** in Veltriva's interface; Narrator turns it on in web pages by itself.
  - Caps Lock+Tab reads the focused item again.
- **The keyboard alone:** put the mouse aside for sections A–E.
- **Both themes:** run section F once with Windows in light mode and once in dark mode (Settings ▸ Personalization ▸ Colors ▸ Choose your mode).
- **Reduced motion:** section G turns Windows' animation effects off (Settings ▸ Accessibility ▸ Visual effects ▸ Animation effects). Turn them back on afterwards if you want them.
- Open three or four ordinary sites in tabs first, so the lists have something in them.

---

## A. Getting around by keyboard

- [ ] 1. Click into a web page, then press **F6**.
  - **Expected:** the address bar takes focus with its text selected. Narrator names it "Address and search bar" and reads the address.
- [ ] 2. Press **F6** again.
  - **Expected:** focus moves to the selected tab in the sidebar. Narrator reads the tab's title, "tab", its position ("2 of 4") and "selected".
- [ ] 3. Press **F6** again.
  - **Expected:** focus goes back to the page.
- [ ] 4. From the address bar, press **Tab** repeatedly, then **Shift+Tab**.
  - **Expected:** every control in the toolbar and the sidebar gets a visible focus ring, in reading order. Nothing is skipped or reached twice. Nothing invisible takes focus.
- [ ] 5. Press **Ctrl+L**, then **Alt+D**.
  - **Expected:** both put focus in the address bar.
- **If it fails, report:** the step, where the focus was before and after, and what Narrator said.

## B. The sidebar

- [ ] 1. With focus on a tab row, press **Down**, **Up**, **Home** and **End**.
  - **Expected:** focus moves between tabs without switching the page. Narrator reads each title, its position and its state ("Unloaded — click to reload", "Playing audio", "Protected from automation" and so on, where they apply).
- [ ] 2. Press **Enter** (or **Space**) on another tab.
  - **Expected:** that tab is shown, focus stays in the sidebar, and Narrator says "selected".
- [ ] 3. Press **Alt+Shift+Down**, then **Alt+Shift+Up**.
  - **Expected:** the focused tab moves one place down, then back. Focus stays on it.
- [ ] 4. Press **Shift+F10** (or the Menu key) on a tab.
  - **Expected:** the tab's menu opens. Narrator reads its items. Esc closes it.
- [ ] 5. Press **Delete** on a tab you don't need.
  - **Expected:** it closes, and focus moves to the next tab.
- [ ] 6. Tab to the **Sleeping** and **Archive** headings and press **Enter** on each.
  - **Expected:** Narrator says "collapsed" or "expanded", with the count. Expanding shows the rows; arrow keys move between them; Enter restores one.
- [ ] 7. After an action that offers Undo (archiving a tab from its menu), listen.
  - **Expected:** Narrator announces the Undo message once, without moving the focus. Tab reaches the Undo button.
- **If it fails, report:** the step, the row's title, and what Narrator said instead.

## C. The address bar and the memory palette

- [ ] 1. In the address bar, type two letters of a site you visited.
  - **Expected:** Narrator says how many suggestions there are. Down and Up move through them and Narrator reads each one ("Switch to tab" where it applies), while focus stays in the field. Esc closes the list.
- [ ] 2. Press **Ctrl+Shift+K**.
  - **Expected:** the palette opens with focus in "Search memory". Narrator reads the field's name.
- [ ] 3. Type a word from a page you visited.
  - **Expected:** Narrator announces the number of results. Down and Up read each result: its title, site, when you visited it, and where the tab is (Open, Sleeping, Archived).
- [ ] 4. Press **Tab** a few times, then **Shift+Tab**.
  - **Expected:** the filter moves on (All, Open, Sleeping, Archived, Today, This week) while focus stays in the field. Narrator announces the filter with the count ("Open: 3 results").
- [ ] 5. Press **Esc**.
  - **Expected:** the palette closes, and focus returns to where it was.
- **If it fails, report:** the step and what Narrator said.

## D. Prompts and notices

- [ ] 1. On a site that asks to show notifications (or to know your location), let it ask.
  - **Expected:** the question appears in the strip under the toolbar. Narrator reads it once ("site wants to …") without moving focus. Tab reaches its buttons, and each button's name says what it does.
- [ ] 2. Answer with the keyboard.
  - **Expected:** the strip closes, and focus returns to where it was.
- [ ] 3. Open a site that goes fullscreen (a video's fullscreen button), with the keyboard if the site allows.
  - **Expected:** Narrator reads the notice naming the site and how to leave. Esc leaves fullscreen.
- **If it fails, report:** the site, the step, and what Narrator said.

## E. Veltriva's pages

- [ ] 1. Open Settings (the gear at the foot of the sidebar, or `veltriva://settings`). Move through it with Tab, and read it with Narrator's arrow keys (Caps Lock+Right).
  - **Expected:**
    - Each section has a heading.
    - Every switch, choice and field has a name that says what it does.
    - A value main refuses is announced as an error next to its field.
- [ ] 2. Do the same on `veltriva://diagnostics`.
  - **Expected:** the tables read row by row, with their headers. "Refresh" announces when it's done.
- [ ] 3. Open a tab on `http://127.0.0.1:9/`, an address that always fails.
  - **Expected:** Narrator reads the error page's heading and the error code. Tab reaches "Try again".
- [ ] 4. On a new profile (or after deleting a throwaway profile), go through the Welcome page by keyboard.
  - **Expected:** each choice is a group of radio buttons with a name. "Start browsing" is reachable.
- **If it fails, report:** the page, the control, and what Narrator said.

## F. Seeing it: focus, contrast, zoom (once per theme)

- [ ] 1. Tab through the toolbar, the sidebar, a prompt and Settings.
  - **Expected:** the focused control always has a ring you can see clearly, never only a color change.
- [ ] 2. Look at the gray text: tab states, counts, hints, the palette's sites and dates.
  - **Expected:** it is easy to read against its background, in both themes.
- [ ] 3. Set Windows' text size to 150% (Settings ▸ Accessibility ▸ Text size), then restart Veltriva.
  - **Expected:** the interface grows. Nothing is cut off or overlaps in the toolbar, the sidebar, the palette or Settings.
- [ ] 4. Turn on a Windows contrast theme (Settings ▸ Accessibility ▸ Contrast themes), then restart Veltriva.
  - **Expected:** the interface stays usable: text is readable and the focus ring is visible. (Veltriva doesn't draw its own contrast-theme colors; this checks that nothing disappears.)
- **If it fails, report:** a screenshot, the theme, and where.

## G. Reduced motion

- [ ] 1. With animation effects off, load a slow page, open the palette, and start a download.
  - **Expected:** the loading bar, the tab spinner and the download progress stand still (a dimmed bar, a still circle) instead of moving. The palette appears without fading in. Sections open without turning arrows.
- **If it fails, report:** what still moved.
