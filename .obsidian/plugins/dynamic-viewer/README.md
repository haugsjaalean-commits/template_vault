# Dynamic Viewer

A list of bases shown as tabs, always about the note you are reading.

Built 2026-09-01 from `Obsidian/Notes/Dynamic Viewer.md`, which is the second half
of `Using dynamic bases.md`. The first half is `file.views()`, which lives in OOF
Class Manager.

---

## A dynamic view is a file

`Some dashboard.dview`, anywhere in the vault. New ones go in the folder
the settings name; existing ones are found wherever they live, like a `.base`.

```yaml
boxes:
  - function: file.views()
  - list: |-
      [[Improvement Base.base#dynamic project]]
      [[Backlink Base.base]]
embed: true
stacked: false
hideEmpty: true
```

**The file name is the name.** There is no `id` and no `name` inside: identity is
the path, the way a characteristic's name is its file name. Renaming the file
renames the dynamic view, and Obsidian rewrites any link to it.

Being a file is what lets it be **opened as a tab** — click it in the file
explorer and the dashboard fills the window, still aimed at the last note you
were reading — and what lets it be linked, hand-edited, carried by the vault and
seen in the graph.

**What is *not* in the file:** `collapsed` and `height`. Those are where you left
the furniture rather than what the dynamic view is, and Obsidian would rewrite the
file on every drag — which is exactly why `.base` and `.canvas` are untracked in
master_vault. They live in `data.json`, keyed by path, and follow a rename.

Two spellings of a box are read and one is written:

```yaml
- function: file.views()      - kind: function
- list: |-                      value: file.views()
    [[A.base#x]]
```

The short one is what this plugin writes, so a file it wrote round-trips exactly.
The long one is the shape the settings used to hold, so anything exported from
those still loads.

---

## Two levels

A **dynamic view** is a named list of base views, assembled out of as many
*boxes* as you like. So the pane has two rows, and each carries its own way to
add to it:

```
Views   Reading                    ⚙   <- the dynamic views, and the way to settings
────────────────────────────────────
 dynamic project   Backlinks           <- the base views inside the one selected
────────────────────────────────────
 Table   12 results   Sort  Filter …   <- Obsidian's own base toolbar
```

The top row is drawn even when there is only one dynamic view, so the pane always
says which one it is showing. The strip below it disappears when it has no tabs
to hold — stacked, or empty.

## These surfaces report; they do not edit

Neither row carries a `+`, and neither does the band drawn inside a note. A view
whose job is to tell you something should not also be a place to change it, and a
band repeated on every note repeats its clutter on every note. The only `+`
anywhere is Obsidian's own **+ New** inside a base, which belongs to the base.

Two ways out, one per surface:

- **the pane** has a gear in its own header — Obsidian's top-right — which opens
  the plugin's settings;
- **a band** has a ⋯ at the right of its header, which opens a menu: **the base
  it is showing**, in a tab of its own at the same view; the dynamic views pane
  in the sidebar; or this dynamic view's own file in a new tab. Stacked, every
  base on the screen gets its own line. A base opened this way is an ordinary
  base again, so `this` follows the active note rather than staying pinned to the
  note the band was drawn on.

**A dynamic view's definition lives in its own file's window.** Open a `.dview`
— from the file explorer, from *Open in a new tab*, or from *Edit its boxes…* —
and the tab holds two halves: a **Definition** section (its name, its three
switches, its boxes) above the dynamic view itself. The plugin's settings tab
holds only what is true of the plugin: the folder for new ones, and a list of
what exists with a button that opens each. The Definition section folds away,
because a dashboard opened for reading wants the height; where you left it is
remembered per file.

**A dynamic view's definition lives in its own file's window.** Open a `.dview`
— from the file explorer, from *Open in a new tab*, or from *Edit its boxes…* —
and the tab holds two halves: a **Definition** section (its name, its three
switches, its boxes) above the dynamic view itself. The plugin's settings tab
holds only what is true of the plugin: the folder for new ones, and a list of
what exists with a button that opens each. The Definition section folds away,
because a dashboard opened for reading wants the height; where you left it is
remembered per file.

**Everything a dynamic view can do is still in one menu**: right-click any pill,
or click the one you are already on. Open it in a new tab, add a base, add a
function, edit its boxes, make a new dynamic view, rename, stack, hide when empty,
show at the top of every note, delete. *Open in a new tab* sits alone at the top
because it is the only item that takes you somewhere rather than changing
something. The settings tab drives the same methods, so the two surfaces
cannot come to disagree.

---

## What it does

The plugin draws that list as a strip of tabs over one live base — or, with
**Show every base at once** on, as all of them stacked one under another, each
with its own name, its own toolbar and its own results. Per dynamic view, from
its menu or the settings: a list of three dashboards is read down, a list of
twelve is switched between.

Stacked, they share the dynamic view's height, which any of them can be dragged
to set — a stack of different heights reads as a mistake rather than as a choice.
The tab strip keeps only the `+`, since every base is already on the screen but
adding one is still something you do from here. The base is
rendered exactly as if it were embedded in the note you are reading — so
`this.file` inside its filters is that note, and a view like `dynamic project`
(`project.contains(this.file)`) becomes a dashboard that re-aims itself as you
move around the vault.

It is Obsidian's own base embed, so the toolbar is there: views, results, sort,
filter, properties, search, **+ New**. Edits made from it are saved back to the
`.base` file.

Two places it can be:

- **the right sidebar** — the pane is called **Dynamic views** and wears
  Lucide's `orbit`: a centre with something going round it, which is what a
  dynamic view is. Reach it from the ribbon or *Dynamic Viewer: open dynamic
  views*. It follows the note you are looking at.

  The pane keeps that name whatever it is showing. A pane is named for what it
  is; *which* dynamic view is on is what the pills above it say — and they appear
  exactly when there is more than one of them, which is the only time the
  question comes up.
- **inside every note, under the properties** — the *embed* switch beside each
  dynamic view, or *Show at the top of every note* in its menu. Nothing is
  written into the file: the band is a decoration in the note's own scroll area,
  so it **moves with the note** the way an embed does rather than taking a strip
  off the top of the pane. Its height is a drag away, and its header collapses it
  to a single bar — collapsed is a property of the dynamic view, like its height
  and its layout, so it applies wherever the band is drawn rather than only in
  the note you clicked in. Each note's band is about **that note**, so a
  background tab keeps its own dashboard.

Several dynamic views can exist at once. The sidebar shows one at a time, picked
from the pills at the top; every one shown at the top of every note gets a section
in the band, and carries a pin on its pill so you can see which.

### When there is nothing to show

**Hide it when there is nothing to show** — per dynamic view, on by default. One
fed by `file.views()` is empty on most notes, so without this a band at the top of
every note offers a message and a button on every note that has no views. With it
on the section simply is not drawn, and a band with no sections does not appear at
all.

With it off, an empty dynamic view says so in one line and offers nothing —
adding a base is done from the menu on its pill, or from the settings.

---

## Boxes

A dynamic view is not one list. It is **as many boxes as you like**, read in
order, each contributing bases in its own way:

| box | holds | example |
|---|---|---|
| **List** | links, one per line | `[[Improvement Base.base#dynamic project]]` |
| **Function** | one call | `file.views()`, `file.classBase()` |

Add one of either from the dynamic view's menu — *Add a base…* writes into a list
box, *Add a function…* makes a function box — or from the settings tab, which is
where the boxes themselves are edited as plain text. A base named twice is one
tab, and it keeps the position of the box that named it first.

### The two spellings of a list, and why they both work

A list box reads **both** of the spellings this system produces, because they
have to mean the same thing.

Typed by hand, or written by the base picker, a list is one entry per line — the
way a list property looks in Obsidian's own property editor:

```
[[Improvement Base.base#dynamic project]]
[[Backlink Base.base]]
```

Printed by a function, the same list is what `ListValue.toString()` gives:

```
[[Improvement Base.base#dynamic project]], [[Backlink Base.base]]
```

That method joins with `", "`, and a `LinkValue` prints itself in brackets — both
read off Obsidian's own source. So the output of `file.views()` pastes into a
list box verbatim and parses identically. A leading `- ` is dropped too, so a
YAML list copied out of frontmatter works.

**A comma only separates outside `[[ ]]`.** `Books, read.base` is a legal file
name, and splitting on every comma would cut it in half.

Boxes are written back one entry per line — that is the one spelling this plugin
*writes*, even though it reads both.

### Functions

Two, both matched **by name rather than parsed**: Obsidian exports no formula
parser, and a table of names needs no grammar.

```
file.views()      the bases this note is looked at through, from OOF Class Manager
file.classBase()  the generated base of this note's class, from OOF Class Manager
```

They answer two different questions about one note, which is why both are worth
a box. `file.views()` is what a class **chose** for its instances — a list,
often empty. `file.classBase()` is the generated base that actually **holds**
the note: its class's `<Class> Base.base`, or the nearest one above it, with
nothing written anywhere to make it true. So a dynamic view whose only box is
`file.classBase()` shows the right dashboard for whatever note you are standing
on, on every note, for ever.

It contributes one entry or none — a note with no class base draws an empty
section, or none at all with *Hide it when there is nothing to show* on.

A function box holding anything else contributes nothing, and the settings tab
says so under it rather than the pane — a typo belongs where it can be corrected.
Spacing and case are forgiven (`file . ClassBase ( )` is the same call), but the
name is not: the table is the whole parser. Adding a third function is a row in
`FUNCTIONS` and a branch in `callFunction`.

---

## Why both functions live in the other plugin

`file.views()` climbs `is a` and then `type of`, and the **names** of those two
properties are OOF Class Manager's settings. Two plugins reading one hierarchy
through two settings free to disagree is the mistake that had Bases Is A folded
into OOF in the first place. `file.classBase()` adds a second reason: which
`.base` belongs to a class is decided by that plugin's **Bases folder** and
**Base suffix**, so asking it is the only way the answer follows a setting
changed there.

The rest of this plugin does not depend on either: a list of links typed by hand
works with OOF disabled, and both functions then quietly answer nothing.

---

## How it works

The whole plugin rests on one thing Obsidian already does:

```js
app.embedRegistry.embedByExtension['base'](
    { app, containerEl, sourcePath, linktext, depth, showInline, displayMode },
    baseFile,
    '#view name',
)
```

That is the factory behind `![[Some Base.base#a view]]`, and `sourcePath` is the
embedding note — which is what `this` resolves to inside the base. So "show me
this base as though the note I am reading were embedding it" is not something to
reimplement; it is the argument.

The embed owns a real `QueryController`, and every remaining requirement falls
out of it for free:

| wanted | how |
|---|---|
| the toolbar | the controller draws it |
| editing the base from here | `controller.requestSave` → `vault.modify` |
| following the active note | `controller.updateCurrentFile(file)` — a re-query in place, not a rebuild |
| two tabs over one base | `controller.selectView(name)` — one embed, not two |

### Two things worth keeping

**The list is re-resolved on every note, the embed is not.** `file.views()` is a
different answer for each note, so the tabs are recomputed each time; when the
answer is unchanged the embed is kept and merely told which note it is now about.
Rebuilding would throw away scroll position, sort and search on every click.

**The order the pinned dynamic views are drawn in lives in the settings**, as one
list of paths, with ↑↓ beside each row of the settings tab. Not as an `order:`
number inside each `.dview`, which was the first design: a number per file can
collide, and two files both claiming to be second is a state with no right answer.
The deeper reason is the same in another form — **an order is a property of the
collection, not of any member**. Which comes first is not a fact about
`Base.dview`; a number inside it would be that file making a claim about an
arrangement it cannot see.

The cost is real and worth naming: unlike `boxes` and the three switches, the
order does not travel with the files. A dynamic view the list has never heard of
goes at the end, sorted alphabetically among its kind — which is what the whole
list used to be — so a file copied in from elsewhere is placed rather than lost.
Reordering rebuilds the list from what is actually on screen, so a stale path or a
missing one is normalised by the act of moving something.

**How the band is attached in editing mode is a setting too**, and a separate
question from where it sits. *As an embed in the document* (the default) makes it
a CodeMirror **block widget** — the same mechanism Obsidian uses to draw
`![[a base]]`, with nothing written into the file. *In the note's layout* is the
older attachment, a plain element beside the properties.

The embed is the tidier of the two, and the difference is in kind rather than in
degree. Its height belongs to CodeMirror's height map, so `contentDOM.offsetTop`
does not grow, every scroll position corresponds to a real document position, and
Obsidian's untouched `getScroll`/`applyScroll` are simply accurate. Measured:
`offsetTop` 1582 → **1073**, `docHeight` 480 → **962** (the band's 482px is now
inside it), and a round trip through Obsidian's own unhelped `applyScroll` of
**79 / 0 / 0 / 0 / 0** px — the 79 being what a note with properties and no band
does anyway. A mode switch measures **0 / −470 / 0**, which is *identical to the
same note with the band hidden entirely*: attached this way the band contributes
nothing to it at all, and what is left is Obsidian's own.

**A block decoration must come from a StateField, never a `ViewPlugin`** —
CodeMirror throws *"Block decorations may not be specified via plugins"* — and
that rule is exactly why this works: heights have to be known to the state before
the view renders, which is also what removes the race described below. CodeMirror
marks the widget `contenteditable="false"` itself, so the band is not editable
text; the base's toolbar, search field and drag grips are all present inside it.

**The editor only owns the band while the editor is the one being looked at.**
There is one band element per note and reading mode needs it inside `.mod-header`,
so a widget that hands it over would take it straight back on its next render —
which is what happened: the band ended up in the hidden editor's `.cm-content` at
zero height and reading mode had none at all. `toDOM` therefore returns a
placeholder whenever its view reports `preview`, and `mount()` asks for the
widgets to be rebuilt when it finds the band still inside `contentDOM`, which is
what makes CodeMirror let go.

**And the switch back restores the scroll.** The two modes disagree about the band
in this attachment — reading counts it as header, above the first line, while the
editor counts it as document — so one scroll value means two different places and
Obsidian carries a scroll value across. `restoreScroll` therefore runs on the
editing side of a switch too, retrying **until the write takes** rather than a
fixed number of times, because coming back to a long note the position wanted can
briefly be past the end of a document CodeMirror is still growing. It stands down
the moment the position moves to somewhere it did not put it: that is you
scrolling, and your scroll outranks the repair. Measured over a round trip at 10,
30 and 50% of a long note: **0 / 0 / 0**.

**What it cannot restore is a position below the end of the text.** Obsidian's
scroll value is a line number, and on a note with `embedded-backlinks` taller than
the note itself (4567px against 3289px on `Class Manager`) everything past the last
line saturates at that line — `view.scroll` reads 68.5 of 69 lines whether you are
just past the text or four thousand pixels into the backlinks. No line number
names those positions, in either attachment or with no plugin at all.

Two costs. *Above the file name* cannot be expressed this way — the title and the
properties are not part of the document — so it falls back to *under the
properties*, which as a widget means the start of the first body line. And
`registerEditorExtension` must come **after** `this.views` is built in `onload`:
registering reconfigures every open editor on the spot, the field is created
immediately and asks for `bandHeightHint()`, which reads them.

**Where the band sits is a setting, one per mode**, with three places each: above
the file name, under the properties, or after the body text. Two settings rather
than one, because the two modes are two different DOMs with different rules about
what may live where.

**Editing and live preview** — all three are ordinary siblings in `.cm-sizer`.
CodeMirror virtualises inside `.cm-content`, not here, so nothing is ever carried
away. *After the body text* is the one that matters beyond taste: it is the only
place that does not sit between the top of the scroller and the first line, and
Obsidian's own scroll ↔ line mapping (`getScroll`/`applyScroll`) cannot represent
positions in that stretch — it falls back to `scrollIntoView` and lands at *first
line just visible*. Measured round-trip drift: **1165px** above the text, **79px**
below it, and 79px is what a note with properties and no band does anyway.

**Reading mode** — the rule is one sentence: **never a direct child of
`.markdown-preview-sizer`.** Those children are the preview renderer's own
sections and it virtualises them, taking them out of the document as they scroll
off. A band placed as a sibling of `.mod-header` in there was detached at **7 of
7** scroll positions, and only the observer below ever put it back — 85 re-mounts
in 7 seconds, each moving the scroll by the band's own height. So each place is
either outside the sizer, or *inside* one of the renderer's own elements rather
than beside it:

- *above the file name* → first child of `.markdown-preview-view`, the scroller,
  which belongs to nobody.
- *under the properties* → **inside** `.mod-header`, which the renderer keeps in
  the document throughout (present at 13 of 13 stops) and measures live, so it
  accounts for the band instead of fighting it.
- *after the body text* → last child of the scroller, which **lands below the
  backlinks**, not between them and the text: that gap is inside the sizer, and a
  band inside `.mod-footer` was detached at 11 of 13 stops with the footer itself
  in the document at only 2 of them.

All six combinations measure 0 detachments, 0 scroll corrections and 0 reading-mode
round-trip drift. Outside the sizer the band restates the width the sizer would
have given it (`max-width: var(--file-line-width)`, auto margins), measured
identical to the sizer's own box.

Both modes are in the document at once, one hidden, so the band follows the mode
the view reports and only one base query is ever live per note.

`anchorFor()` re-reads the tree every time, `mount()` is idempotent by
construction rather than by a flag, and a `MutationObserver` on whatever the band
is mounted in puts it back when CodeMirror rebuilds or a mode change swaps the
container — neither of which fires a workspace event. That observer is a **net,
not a motor**: if it fires steadily while nothing is happening, the mount point
is wrong again.

**A mode change puts the scroll back itself.** Obsidian restores the scroll on a
mode switch *before* the band has moved into the mode being switched to, so it
computes against a layout missing the band and lands wrong by roughly its height
— caught frame by frame: at the moment the view reports `source` again the band
is still in `mod-header` and the position is right, and a few frames later the
band arrives and it is not. `view.scroll` is the line Obsidian carried across and
it survives both switches intact, so `restoreScroll()` applies it again once the
layout is the one it was meant for — twice, on the next frame and 60ms later,
because Obsidian's own last correction would otherwise land after ours.

In editing mode it is applied by arithmetic (`scrollPixelFor`) rather than by
`MarkdownView.applyScroll`, because that method takes its exact path only when
the target line is **already rendered**: with a band above the text the top of the
note maps onto the frontmatter, which live preview never renders, so it falls
back to `scrollIntoView`. Measured against the position asked for, Obsidian is
1165 / 850 / 535 / 115 px out down the note and exact only once the text is on
screen; the formula — Obsidian's own, with the gate removed — is 0 at every one.
The height map answers `lineBlockAt` whether or not a line is drawn, which is the
whole reason it works where the gate does not. In reading mode the renderer's own
`applyScroll` is exact already, so it is simply called again.

Measured round trip through reading mode and back, at 15%, 50% and 90% of the
note:

| editing / reading | before | after |
|---|---|---|
| under the properties (default) | 1165 / 850 / 115 px out | **0 / 0 / 0** |
| above the file name | — | **0 / 0 / 0** |
| after the body text | — | 0 / −735 / −433 |
| *no band at all — Obsidian alone* | — | *0 / −355 / 0* |

With the band above the text in both modes the switch is now exact, which is
better than Obsidian manages on an ordinary note. *After the body text* leaves the
two modes with different amounts above the first line — in reading mode that place
is below the backlinks — and a scroll value is a line number, which cannot tell
two such layouts apart; the last row is there to show that some of that is
Obsidian's own.

**The pane follows the note, not the active leaf.** A sidebar leaf becomes active
the moment you click a tab in one; `isNoteLeaf()` requires a `TFile` and
`rootSplit`, so the panel never re-aims itself at nothing. Both `file-open` and
`active-leaf-change` are listened to, because clicking back into a note already
open fires only the second.

---

## Settings

One card per dynamic view: its name, the *embed* switch right beside it, a delete
button, and a box of entries, one per line.

Nothing else. Collapse state and the band's height are remembered per dynamic
view rather than asked about.
