# Slide Groups

Keynote-style indented, collapsible slides for the Google Slides filmstrip. A Chrome extension.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick the `extension` folder
4. Reload any open Google Slides tabs

Do the same on your other desktop. Groups sync through Chrome sync, so both machines need
to be signed into the same Google account in Chrome with sync on.

## Use

| Action | How |
|---|---|
| Make sub-slides | Select any number of slides, drag them onto the **lower-right** of another slide (it lights up: "↳ Add as sub-slides"). They're added at the end of that slide's group. |
| Take slides out of a group | Drag them onto the **left edge** of any slide in the group (a line shows "↰ Out of group"). They land right after the group, at the top level. Dropping anywhere else between slides gives them the level of the slide they land above. |
| Label a group | Point at a group's first slide and click the small field at its bottom-left. Enter saves, Esc cancels. |
| Undo / redo | **⌘Z** / **⇧⌘Z** undo grouping, drops and labels in order with your other Slides edits |
| Make sub-slides (keyboard) | Select slides, press **Tab** |
| Un-indent (keyboard) | **Shift+Tab** |
| Collapse / expand | Click the chevron at the bottom-left of the group's first slide |
| Collapse / expand all | **⌥-click** a chevron |
| Move a whole group | Collapse it, then drag its first slide (the extension selects the hidden sub-slides for you). *Try it on a copy of a deck first.* |

Arrow keys skip over collapsed slides. Indenting a slide into a collapsed group opens it.
Jumping to a hidden slide (search, links) opens its group.

## How it works

Google draws the filmstrip as one SVG and decides what you clicked from the mouse position,
not from the thumbnail under the cursor. So the extension:

- moves/hides thumbnails with a generated stylesheet (never touching Google's own attributes)
- re-sends every mouse event over the filmstrip with its Y translated back to Google's layout
- scrolls through the filmstrip once after load (hidden, well under a second on most decks),
  because Google only draws thumbnails near the scroll position and every slide has to be
  drawn to know what you've selected
- keeps one undo timeline: grouping changes are its own steps, edits it sees you make in the
  deck are Slides' steps, and ⌘Z undoes whichever came last

Groups are stored per deck in `chrome.storage.sync` as `{ indent: {slideId: level}, collapsed: {slideId: true}, labels: {slideId: text} }`
(split into chunks for big decks).
Structure comes from slide order + indent, like Keynote, so moving slides re-parents them naturally.

## Limits

- Only you see the groups. Collaborators without the extension see a flat deck.
- It reads Google's internal filmstrip markup, which Google can change without notice. If the
  chevrons disappear or clicks select the wrong slide, the selectors at the top of
  `extension/content.js` are the first place to look.
- Grid view (the slide sorter) isn't grouped.

## Dev

`dev/build.sh` bundles the extension with a fake `chrome.storage` (`dev/shim.js`) into
`dev/inject.js`, for pasting into a Slides tab's console without loading the extension.
