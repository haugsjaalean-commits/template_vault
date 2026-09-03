# Dynamic Sticky Notes

A right-sidebar panel of sticky notes that follows the note you are in.

Written by Claude for Leander, 2026-09-01, from `Obsidian/Notes/Dynamic Sticky Notes.md`.
Nothing in this folder is his code.

---

## The idea

> The point of this is to allow me to quickly jot down thoughts without needing to
> give a second thought about where to put them. This follows the philosophy of
> *note first, organize later*.

You are reading something, a thought arrives, and the panel already has a blank
sticky note waiting. You write in it. A real note is created and stuck to the
file you were in. You decided nothing.

## The direction of the link

There is **no `notepad:` key on your notes**, and this plugin never writes into
the file you are reading. A sticky note carries `file:` naming what it is stuck
to — nothing, one file, or several — and every question the panel asks is
answered off that one property. This is his own correction of his first design:

> I previously said that I thought that each file should have a field through
> which it could link to a notepad, but this is obviously the wrong conception.
> It is undoubtedly better for the notepads themselves to link to files.

The relation is visible from the other end for free, in the note's backlinks,
which is the second reason nothing is written there.

## The three views

**Notes.** A grid of the sticky notes currently open. Every sticky note of the
active file comes in automatically and is outlined; a card that is neither
pinned nor of that file is cleared when you move on, into the trash view. If the
active file has no sticky note at all there is a blank dashed one at the top —
writing in it is what creates the note.

**Base.** Your `Sticky Note Base.base`, drawn inside the panel itself, toolbar
and all. It is Obsidian's own base view, not a reimplementation.

**Trash.** What was just cleared. Each card has a check circle in its top right;
tick the ones you want and press *Put back*. **Nothing here is deleted** — the
trash view is a memory of the panel, not of the vault. The eraser button empties
the list and leaves every note where it is.

## The toolbar

| | |
|---|---|
| `Notes` `Base` `Trash` | the three views; the trash carries its count |
| ⊞ | new sticky note **for the current file** |
| + | new sticky note, stuck to nothing |
| ⋮ | open the base in a real tab, unpin everything, collect the empty notes |

Each card carries, on hover: pin, colour, a ⋮ menu, and × to clear it. The card's
title is **what it is stuck to**, not what it is called — a sticky note is named
after the second it was made, so its own name tells you nothing, while "what is
this stuck to" is the only thing that distinguishes a pinned card of another
file from the one you are reading. Click the title to open the note.

## Colour

`color:` on the sticky note holds a **name** — `Yellow`, `Blue` — and the plugin
maps names to a light and a dark hex in its settings. So the vault stores a word
and only the screen knows the hex, and the same note reads as paper in both
themes.

New sticky notes are a random colour by default; the settings dropdown can pin
that to one colour or to none. The palette is editable — add, rename, recolour,
remove.

Adding those names under `possible values` on your `∘ color` note is what makes
them offered when you type the property by hand (OOF Class Manager's value
suggestions read that field). **This plugin never writes there** — a
characteristic note is yours.

## Resizing

Drag the grip in a card's **bottom right corner** to make it taller. Vertical
only — a card's width is the grid's, so the cursor says `ns-resize` rather than
`nwse-resize`; a corner offering a width you cannot change is a corner that lies.
Double-click the grip, or *Reset the height* in the card's ⋮ menu, to give it
back to the default.

**A height belongs to the note, not to the panel.** You drag *this* card because
*this* thought is longer than the others, so the height is remembered per sticky
note; the settings' *Sticky note height* is what a card nobody has dragged looks
like. The blank card resizes too, and the height it was dragged to follows the
note it becomes — a card you made room in before typing should not snap back the
moment your thought becomes a file.

It is kept in the plugin's `data.json`, beside the open list and the pins, and
**not** in the note's frontmatter: a card's height on this screen is not a fact
about the note, there is no `∘ height` characteristic behind it, and writing
frontmatter with nothing behind it is the one thing every plugin here refuses to
do. Renames carry it (and the pin, and the card's place) across.

## Garbage collection

His sentence: *"If a notepad is not linked to by any other note and it contains
no text, then the garbage collection of the plugin will delete it."*

This is the only thing here that destroys anything, so it is the narrowest
reading of that sentence. **Six** conditions have to hold at once:

1. it is a sticky note by the class test;
2. its body, once the frontmatter is off, is entirely whitespace;
3. its `file:` property resolves to nothing — unless the switch below says otherwise;
4. nothing in the vault links to it (`metadataCache.resolvedLinks`);
5. it is not open in a pane, nor in the panel, nor pinned;
6. it has not been touched in the last ten seconds — which is what stops a sweep
   racing a note being made.

**One of the six is a switch**, and it is the only setting here that ships
**off**: *Collect them even when they are stuck to a file*. His sentence is
ambiguous in a way that matters — "not linked to by any other note" is about
links coming *in*, and a sticky note's `file:` is a link going *out* — so the
literal rule collects an empty attached note while the design ("a sticky note is
stuck to something") says being attached is being wanted. Both readings are
defensible, which is when the answer is his; the default is the one that deletes
less. On, only the text matters: press New and walk away without writing, and it
goes within the minute.

It goes through `fileManager.trashFile`, so it obeys your own *Deleted files*
setting rather than deleting outright. One toggle switches the whole thing off.

**When it runs.** Once about six seconds after the vault is ready; when a card
leaves the view; on the command; and — since the trigger was measured and found
wanting — on your navigation, at most once a minute. That last one exists
because the second one can almost never succeed: a sticky note leaves the view
when you walk into another file, which is normally seconds after you made it,
inside the ten-second grace period. Without a trigger that comes back later, an
empty unlinked sticky note sat collectable and uncollected until a restart. A
background sweep that actually took something says so in a notice — a file
removed with no word is the difference between tidying up and losing a note.

---

## Internals

### A card is a real Obsidian editor

Not a textarea with markdown-coloured CSS. `app.embedRegistry.embedByExtension.md`
returns **two different classes**, and one field of the context object decides
which:

```js
creator({ app, containerEl, displayMode: true }, file, '')  // read-only preview: loadFile, path
creator({ app, containerEl },                     file, '')  // the file-backed editor
```

The second is the class Canvas puts in its note cards: `showEditor`, `save`,
`onFileChanged`, a real CodeMirror, `[[` completion, every editor command, and
writes that go straight to the file. Measured live in the app before a line of
this was written; the `displayMode` branch was found by handing the creator three
different contexts and reading back their prototypes.

Two consequences run through the whole file.

**Cards are never rebuilt, only added, removed and reordered.** A render that
emptied the grid and drew it again would destroy the CodeMirror under the
cursor. `renderNotes` reconciles against a `Map` of live cards, and reorders only
when the order actually differs — `appendChild` on a node already in place is
still a remove and an insert, which blurs a focused editor.

**`workspace.activeEditor` is set on `focusin`,** which is what makes the app's
own commands and the link suggester address the card you are in rather than
whatever note was last open in the main area. Obsidian's hover-popover editor
does exactly this; the asar says so.

If those two undocumented classes ever change shape, `Card.mount` falls back to a
plain textarea bound to the same file, debounced through `vault.process`. The
panel keeps working; only the niceties go.

### The base is Obsidian's own

`app.embedRegistry.embedByExtension.base`, with `displayMode: true`, into a div
in the panel. Nothing about bases is reimplemented, so the filter, the views, the
sort and the toolbar are the ones you built.

### The blank card is a textarea, deliberately

There is no file to bind an editor to yet — and creating the file *before* a
keystroke is exactly the litter garbage collection exists to clean up. On the
first input the note is created, whatever has been typed by then is written into
it, and the real card takes the draft's place with the cursor at the end.

### Creating a note

`vault.create` → **pour the template** → `processFrontMatter`. That order matters:
Obsidian's own template copying takes the frontmatter and nothing else, so
Templater's `write_template_to_file` is the missing half that runs the template's
commands (the unique-file-name block among them); and Templater merges a
list-valued key by *concatenating*, so writing frontmatter first would leave a
null appended to a list. This is the same helper and the same reasoning as Bases
Table Kanban's `+ New`.

### Two events, one guard

`file-open` and `active-leaf-change`, because clicking back into a note you
already have open fires no `file-open` — only the leaf changed. The guard is
`isNoteLeaf`: the leaf must carry a `TFile` and live in `rootSplit`. This panel's
own leaf fails both, so nothing done inside the panel can move the active file.
Graph Focus met this first.

A sticky note opened in the main area is also refused as "the file you are in" —
otherwise the panel would offer to stick things to a sticky note.

### The index

Which notes are sticky notes and what each is stuck to, rebuilt lazily behind a
dirty flag rather than maintained incrementally. The whole answer is a walk of
frontmatter Obsidian already holds in memory; an incremental index is a second
copy of the truth waiting to disagree with the first.

The class test excludes the configured template **and everything in its folder** —
a class's template is an instance of it by every test that reads frontmatter,
which is why your own base says `!file.inFolder("Obsidian/Templates")`.

### What it does not depend on

`oof-objects` is never called and need not be installed. `is a` is a convention
in the notes, not state in a plugin — the rule the OOF Declared Order extraction
settled. All four names (`is a`, `Sticky Note`, `file`, `color`) are settings.

---

## Tests

`claude_vault/tools/dsn-tests/run.js` — 56 assertions over the real `main.js`
with `obsidian` stubbed:

```
node run.js
```

It covers the rules and not the rendering: the name reading, the class test (and
its honest half — the same note *is* found once it leaves the templates folder),
target resolution, `stickiesFor` ordering, the walking-into-a-file plan in six
shapes, and what "contains no text" means. `getFrontMatterInfo` is
reimplemented rather than faked, because the empty-body test is *about* it.

### The blank panel, and the name that caused it

`this.open = []` on the view. **`View.prototype.open` is the method the leaf
calls to attach the container and run `onOpen`** — an instance field of that name
shadows it, the call goes nowhere, and the leaf is left holding a view that was
constructed and never opened: `_loaded: false`, `containerEl.parentElement:
null`, a completely blank pane, and no error anywhere. `headerEl` and `actionsEl`
are ItemView's own and were shadowed too.

A subclass shares one namespace with its base, and Obsidian's is undocumented.
The check is to read `Object.keys()` off a **live** view of another plugin and
walk its prototype chain — that enumerated all three in one call. Hence
`openPaths`, `toolbarEl`, `topEl`.

### Two more bugs that only driving the real panel found

**A cached element passed a liveness check it does not answer.** `ensureGrid`
asked `!this.gridEl.parentElement`, which reads as *is it still on screen* and is
not — a detached subtree still has parents. After a second `onOpen` the stale
grid passed and every card was drawn into a tree nobody was looking at. The test
is `parentElement !== this.bodyEl`.

**A guard starved the thing it was guarding.** `onActiveChanged` ignores a
sidebar leaf becoming active, which is right — revealing this panel fires
`file-open` with no file, and that is not you leaving the note. But it was also
the only thing that ever *set* `activeFile`, so enabling the plugin with a
sidebar focused left it null for good. `currentFile()` fills a null in once,
from the workspace, leaving the rule intact.

## Known limits

- With Obsidian's *Properties in document* set to **source**, a card shows its
  own YAML as text. The CSS hides the properties widget, which is the other two
  settings; raw source mode is indistinguishable from body text.
- The trash view renders at most *Sticky notes kept in the trash view* cards.
- Cards are not draggable between positions; a base has no manual order and
  neither does this.
