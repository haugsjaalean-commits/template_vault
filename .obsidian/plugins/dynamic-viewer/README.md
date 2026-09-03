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
- **a band** has a ⋯ at the right of its header, which opens a menu:
  the dynamic views pane in the sidebar, or this dynamic view's own file in a
  new tab. Both lead to the same panel; which one you want depends on whether
  you are keeping this note in front of you.

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
| **Function** | one call | `file.views()` |

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

One so far, and it is matched by name rather than parsed: Obsidian exports no
formula parser, and one function does not need a grammar.

```
file.views()   the bases this note is looked at through, from OOF Class Manager
```

A function box holding anything else contributes nothing, and the settings tab
says so under it rather than the pane — a typo belongs where it can be corrected.
Adding a second function is a row in `FUNCTIONS` and nothing else.

---

## Why `file.views()` lives in the other plugin

It climbs `is a` and then `type of`, and the **names** of those two properties are
OOF Class Manager's settings. Two plugins reading one hierarchy through two
settings free to disagree is the mistake that had Bases Is A folded into OOF in
the first place.

The rest of this plugin does not depend on it: a list of links typed by hand
works with OOF disabled, and `file.views()` then quietly answers nothing.

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

**The band lives in CodeMirror's DOM, and survives there by never trusting it.**
It is inserted into the sizer — `.cm-sizer` in live preview and source,
`.markdown-preview-sizer` in reading mode — after whichever child of it holds
`.metadata-container`, so "under the properties" is one rule for all three modes.
Both modes are in the document at once, one hidden, so the band follows the mode
the view reports and only one base query is ever live per note.

`anchorFor()` re-reads the tree every time, `mount()` is idempotent by
construction rather than by a flag, and a `MutationObserver` on the sizer puts
the band back when CodeMirror rebuilds or reading mode re-renders its sections —
neither of which fires a workspace event.

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
