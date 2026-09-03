# Bases Table Kanban

Written by Claude for Leander, 2026-08-29, from his note
`Obsidian/Notes/Bases drag and drop.md`; renamed and extended 2026-08-30 from
`Obsidian/Notes/dealing with `+ new` button in bases.md`, which is where the
name is his. The folder id stays `bases-drag-drop` so his settings survive.

The build record, in his terms, is
`claude_vault/guides/bases table kanban plugin.md` — notes about my plugins live
in claude_vault, only the plugin itself lives here. This file is the internals —
read it first if an Obsidian update breaks something.

Two halves, one rule. **Drag** a note between the groups and rows of a base and
the properties that put it there are written for you. Press **+ New** and the
note is made with the base's template, offered for renaming, and then dropped
where you click. A base has no manual order, so neither half ever moves
anything: the gesture edits the note, and the position follows.

## Obsidian 1.13.7 internals it stands on

Everything here was read out of `obsidian-1.13.7.asar` and then confirmed
against the running app over the debugging port.

| What | Where |
|---|---|
| `BasesView.updateProperty(file, prop, value)` | the shared view base class — writes frontmatter inside `createTransaction` |
| `createTransaction(cb)` | pushes `{changes, state}` onto `view.undoStack`, then `queryController.requestNotifyView()` |
| `undoTransaction()` | per change: `processFrontMatter(f, fm => { if (JSON.stringify(fm) === JSON.stringify(change.end)) Object.assign(fm, change.start) })` |
| `dragManager.handleDrop(el, cb, always)` | cb returns `{action, dropEffect, hoverEl, hoverClass}`; `action` is the text drawn beside the drag ghost |
| `dragManager.handleDrag(el, cb)` / `dragLink(...)` | payload carries `.file` — cards already register this, table and list rows do not |
| `queryController.newItemMenu` | the `+ New` button; `open(name, frontmatter)` is on its prototype, and that second argument is applied to the new note's frontmatter last |
| `newItemTemplate` / `newItemFolder` | query-level keys behind the base's *New item template file* and *New item folder* settings; the template's **frontmatter only** is copied |
| `.bases-toolbar-new-item-menu` | the button's own container, inside `.bases-toolbar` |
| `plugin.getViewFactory(type)` | the controller calls it as `factory(controller, containerEl)`, a plain call — wrapping it catches every view, in leaves, popovers and embeds |
| table group | one `.bases-table` per group holding `[.bases-group-heading, summary row, .bases-tbody]` |
| cards group | `.bases-cards-group` + `.bases-group-heading`, items `.bases-cards-item` |
| list group | `.bases-list-group` + `.bases-list-group-list`, items `.bases-list-item` |
| `.table-drag-target.mod-row` | Obsidian's own insertion bar, from the markdown table editor |

## Six things that will bite

**The undo contract is a shape, not a call.** `undoTransaction` restores with
`Object.assign(fm, start)` after comparing `JSON.stringify(fm)` against `end`.
So `start` must be a snapshot taken *before* the edit and `end` must be the live
object. A JSON round-trip is exactly the right fidelity for `start`, since undo
compares by `JSON.stringify` anyway. One drop is ONE transaction — calling
`updateProperty` three times would cost three Ctrl+Z.

**Rows are virtualised and recycled, and `virtualize()` calls
`setChildrenInPlace` on the row element.** Anything appended to a `.bases-tr`
vanishes on the next scroll. Hence one floating grip that follows the pointer
rather than a grip per row. For the same reason nothing is ever resolved from
the virtualised arrays by index — only from the element under the pointer, which
is by definition rendered.

**Making a row draggable does not break cell selection.** It looks like it must;
it does not. `onTableSelectionStart` opens with
`if (evt.shiftKey || !evt.targetNode.draggable)`, so Obsidian's own selection
already stands aside for draggable targets. Check whether the app solved it
before designing around the hazard.

**`getSort()` may report `DECLARED`.** That is OOF Class Manager folding in its
`declaredOrder:` marker, not an Obsidian direction. It is read rather than
worked around: this plugin asks the same `getSort()` that the sorting itself
asks, so the two agree whatever state OOF is in.

**Nothing of mine may be parented into the view and left there.** v1.0.0 created
the grip with `root.createDiv(...)` in the layer's constructor and bound
`mousemove` to that same element; by the time anyone tried to drag, the grip was
detached — `getBoundingClientRect()` all zeros, `offsetParent` null, computed
styles empty — and the listener was firing into nothing. A base view rebuilds its
own DOM underneath a long-lived view object, so **an element reference captured
at construction is a reference to something the app may discard**. This is the
row-children trap one level up, and it cost the whole feature: clicking and
holding did nothing at all.

The fix is two rules, both in v1.0.1. `root` is a **getter** read live off the
view, never cached. And the grip and the insertion bar are **mounted on use**,
idempotently (`mount()` re-appends whenever the parent is not the current root).
All pointer and drag handling moved to **document-level listeners on the plugin**,
dispatched by hit-testing each layer's current root — which also fixed
`dragManager.handleDrop`'s listeners outliving the plugin, since it offers no way
to unbind them.

**A floating decoration occludes what it is positioned from.** The grip lies on
top of its row, so as soon as the pointer reaches it the event target is the
grip — a child of the container, not of any row. v1.0.1 recomputed from that
target, found no row, and hid the grip; the pointer was then over the row again,
so it reappeared. The cursor flickered between `grab` and default many times a
second and the grip **vanished under the press**, so it could never be grabbed.
Fixed in v1.0.2 by leaving the grip alone while the pointer is inside it. Any
hover-following element needs this: the thing you follow the pointer with becomes
the thing the pointer is over.

**A drag source that stays under the pointer eats its own drag.** The grip lies
on the leading edge of a row and kept its pointer events once the drag was
moving, so for the whole first stretch of the gesture *it* was the element under
the pointer — and being a child of the container rather than of any row, the drop
resolved to nothing: no bar, no highlight, and `dragover` never called
preventDefault, so dropping there did nothing at all. It is the self-occlusion
bug of v1.0.1 again, one phase later: that one was the grip hiding itself on
hover, this one is the grip swallowing its own drop. **And the first fix for it was worse.** v1.1.2 gave the grip
`pointer-events: none` for the duration of the drag, via a class removed in a
`dragend` handler — so one drag that ended without reaching that handler left the
grip permanently unpressable, and grabbing stopped working entirely. **A fix that
depends on cleanup can fail closed.**

v1.1.3 holds no state: when the event target is our own furniture, `resolve()`
hit-tests the rendered rows by rectangle (`itemAtPoint`) and carries on with the
row under the pointer. Nothing to set, nothing to unset, nothing to get stuck.
**Check what `document.elementFromPoint` returns mid-gesture, not just at rest.**

## The placement logic

`planRowDrop` walks the writable prefix of the sort keys. Agreed keys are
forced; the first differing key decides, with three answers (a strictly-between
value from the property's domain, or a tie with either neighbour). `betweenValue`
answers the domain question from `possible values` on the characteristic note —
words give a list to pick from, `[0, 10]` gives a midpoint, and everything else
(free text, dates, links) deliberately gives nothing.

`landingRange` then simulates the result against the **full** sort and returns a
range, not an index. `from === to` means the position is settled and a bar is
drawn; `from < to` means the sort cannot tell that block of rows apart, so the
block is lit instead. That distinction came out of testing against his real
base, where 33 of 40 rows are in such a block.

## v1.1 — every sort key, and every option shown at once

Two things he reported after using it: the choices were invisible until you had
already hovered them, and it looked like only the first sort key mattered.

**Only the first key mattered, and that was real.** The walk stopped at the first
key it could not split: it tied the note to a neighbour and gave up. But sharing a
neighbour's value only puts the note in that neighbour's *block* — every key
below can still separate the two. `refineAgainst` walks them, looking for a value
strictly past the anchor's (after it when the note goes below, before it when
above), and matching the anchor exactly when there is none, so the next key down
gets its turn. Nothing can overshoot: the anchor is the last row of its block on
the deciding key, so there is nothing between it and the row on the other side.

Two smaller repairs fell out of testing that against his vault:

- **A blank neighbour is not the end of the list.** Both sort last, so they order
  alike — but only one leaves room: any number sorts before a blank, while
  nothing sorts past the end. `BLANK` is now its own bound, separate from `END`.
- **An undeclared property is not a domain-less one.** His `priority` sort key has
  no characteristic note at all (the one he wrote is `active priority`), so it
  could never interpolate. Two numeric neighbours now give a midpoint whatever the
  vault declares — though an inferred domain will not reach *past* the last row,
  since it has no end to reach for.
- **A forced match is only a change when it changes something.** Refining onto a
  key that is blank on both sides used to record `priority → empty` on a note whose
  priority was already empty, so the label promised an edit that would not happen.

**`rowOptions` computes every distinct place in a group**, both tie directions at
every gap, deduped **on the place rather than on the edit** — several different
edits can land a note in the same spot, and one boundary deserves one mark. They
are drawn faintly all at once for the whole group while a drag is in flight, with
the solid bar on the one under the pointer. Blocks the sort cannot order get no
line at all: there is no boundary inside them to point at, so they light up as a
block instead.

## v1.2 — exactness is an outcome, not an opinion

He reported the bar highlighting a slot below the one he was hovering. It was not
the drawing: the *values chosen* did not produce the gap that had been asked for,
and the plan said they had.

`exact` used to be the walk's own opinion of whether it had separated the
neighbours. That can be true while the note lands somewhere else entirely:
dropping between two rows that agree on **every writable key** forces the note to
match them, after which an unwritable key — `file.mtime` here — decides where
among them it goes. One definite spot, nothing tied, and not the spot requested.
**90 of the 644 plans his own base can produce were exact-and-wrong that way.**

Both flags are now read off the outcome, never off the walk, and there are three
states because they are three different sentences:

| | means | shown as |
|---|---|---|
| `settled` | lands in one definite place, not anywhere in a block | a line; otherwise the block lights |
| `exact` | that place is the one asked for | solid bar; otherwise dashed |
| `chosen` | our values put it there, rather than an unwritable key | only wording: *order among equals set by …* |

The distinction matters for the marks too: an option's question is "is this one
definite place" (`settled`), not "is it the gap I happened to enumerate", so the
option marks and their dedupe use `settled` while the live bar uses `exact`.

**The invariant worth re-running after any change here**: for every group, every
dragged note and every gap, a plan reporting `exact` must land at the gap it was
asked for. It is 0 failures in 644 on his Improvement Base, and it was 90 before.

## v1.2.2 — a gap means one thing

He saw a line switch from dotted to solid as the pointer moved over and past it.
Two separate causes, and only one of them was meant.

**The unmeant one:** the walk consulted the pointer's half of the row whenever
the deciding key had no room, so the *same boundary* produced different writes
depending on whether it was approached from above or below — the bar stood still
while the label changed under it. Both routes are now computed and the better one
wins on its merits (`betterPlan`): lands where asked beats not, one definite place
beats a block, fewer writes beat more, **and a dead heat always resolves the same
way** rather than by pointer position. The pointer's half chooses *which* gap
(`gapFor`) and nothing else.

**The meant one:** two different gaps can land at the same boundary — one because
it is reachable, the other because it is not and this is the nearest place the
sort will accept. Same y, one solid and one dashed, and that difference is the
constraint being shown rather than a glitch.

The check for this is a pointer sweep: step through both halves of every rendered
row and group the readings by the y the bar lands on. **A boundary reached by one
gap must read exactly one way.** After the fix, the only y with two readings is
the one where two *different* gaps legitimately collapse onto it.

## v1.2.3 — the bar that never moved

The one that mattered, and no synthetic test of mine could have found it.

Hovering the dragged note's **own row** — which the pointer is over constantly,
since that is where the gesture starts and the row stays put while you drag —
resolved to the wrong gap. The row is absent from the list the gap is measured
against, so `indexOf` answered -1, and the fallback answered *the end of the
group*. So every hover over your own row planned a move to the bottom, wrote
whichever value sorts last, and pinned the insertion bar to one spot for the
entire drag.

A recording of a real drag is what showed it: 483 `dragover` events, the pointer
sweeping y=177→328, and `landing=0` with `bar@209` for every single one. My own
sweeps had always dispatched events at rows *other* than the dragged one.

The arithmetic now lives in `gapAt(all, hovered, dragged, bias)`, pure and out of
the DOM, because it is where the worst bug in this plugin lived and it deserves
tests. A dragged row's two boundaries collapse into one once it is removed from
the list, and that one is where it already sits — so both halves of it agree.

## v1.3 — two bugs a screenshot found, and a working off-switch

Neither of these came from my own testing. They came from looking at his running
session: a screenshot, and the live view state.

**Every drag left its bar drawn on the table.** When the option marks arrived in
v1.1.0 the dragend/drop sweep changed from `hideIndicator()` to `endDrag()`, and
`endDrag()` never hid the indicator. Bars persisted after every gesture. Alone,
that makes the whole feature look broken — and it was visible in a screenshot of
his vault with no drag in progress.

**A list-valued group-by was flattening his lists.** His Table view groups by
`project`; notes hold `project: ["[[Class Manager]]"]`. The group value came from
the group's rendered heading, so a list became the string `"[[Class Manager]]"` —
and the group of notes in two projects would have written
`"[[Class Manager]], [[Graph Focus]]"`, one string that is neither a list nor a
link. `groupValue()` now copies the raw frontmatter of a note **already in the
group**, which is exact for lists, links, numbers and text alike and needs no
guessing about YAML shape.

**And the off-switch was broken.** *Drop between rows* also gated the grip — the
only way to start a drag from a table or list row — so switching row drops off
took group drops down with it and turned the feature off entirely instead of
reducing it. The grip now survives while *either* kind of drop is enabled. With
row drops off: hovering a row plans the group change only, no bar and no option
marks are drawn, and the group heading still works.

## v1.5 — the marks stay

His correction: the line it left was visible for only a split second. Two causes,
and the fade was the lesser one.

**The real one: a base re-renders on its own**, so the row carrying the outline is
recycled and the origin line — parented into the container — is simply
**detached**. `isShown()` then reports false, with no event to hang a repair on.
Marks are therefore *remembered* (`this.landed = { path, origin }`) and
**re-asserted** every 200ms against the FILE, not left where they were put. Scroll
alone was not enough; nor was refusing to hide on a missing neighbour.

**The blink took three tries, and measurement to settle.** Re-asserting every
200ms blinked visibly; every *frame* still blinked, because the app's render runs
**after** my rAF callback — each frame I re-attached and it removed again before
paint. A probe settled it: a div appended to `scrollEl` does not survive a
re-render, while the same div on `scrollEl.parentElement` does. So the marks are
put back by a **MutationObserver on the root's child list**, which fires as a
microtask — after the removal and before the browser paints — with the frame loop
and the slow timer left as backstops.

Sampled frame by frame across a real drop: **1 transition, 0 off-episodes**,
against 5 and 2 before.

**And nothing fades any more.** Both marks stand until the next click, keypress or
drag. The landed row gets an inset accent outline rather than a wash, so its text
stays as legible as every other row's.

## v1.4 — where it landed

A drop writes frontmatter and the base re-sorts itself, both instantly and both
silent, so the only evidence a drag did anything was that the table looked
slightly different than a moment ago. The row the note ended up in now flashes.

Two things it must not assume. The row **does not exist** when `applyChanges`
resolves: the write goes through `createTransaction`, which asks the query
controller to re-run, so the re-render lands later — and the entry object is
*replaced* by that re-query rather than moved, so holding the old one finds
nothing. `flashLanding` therefore polls on `requestAnimationFrame` for the row
belonging to that **file**, for up to 1.5s, making no assumption about which
render arrives or when.

It ends on `animationend` rather than a timer, so a row recycled underneath it
cannot be left lit, and the class is removed and re-added (with a forced reflow)
so flashing the same row twice restarts cleanly.

**v1.4.1 marks both ends.** A dashed grey rule is drawn where the note *left*
from — the boundary the two neighbouring rows have now closed over — fading on
the same clock as the landed row, so a move reads as a journey rather than as one
row lighting up for no visible reason. The origin is captured **before** the
write, as the paths of the rows above and below, because the re-query builds new
entry objects and may rebuild the grouping around the change. It is skipped when
neither neighbour is on screen, which includes the note having been alone in a
group that has now gone.

Also in the vocabulary table: a block the sort cannot order is **bracketed top
and bottom by two dashed rules** (v1.3.2). It used to be a 2px accent stripe down
the left edge of every lit row, which on contiguous rows stacked into a single
continuous **vertical** line — a different kind of object from every other mark
here, and he had to ask what it meant. A region and a boundary differ in number
and weight, not in axis.

## v1.6 — moving between folders

His ask, with his boundary: **the folder may change, the file name never does.**
So `file.folder` became a writable key while `file.name` and `file.path` stayed
untouchable, and the new path is always the target folder plus the name the note
already has.

"Only where folder is a sorting or grouping parameter" needed no gate of its own —
the plugin only ever writes keys the view is organised by, so that is already the
only way a folder change can arise.

**A move cannot join the base's transaction**, and that is the whole reason it is
a switch (*Move between folders*, on). `applyChanges` therefore splits: the
frontmatter goes through `createTransaction` as before, then the move happens
separately and **after** it — so if the move fails, the property edit still
stands and is still undoable, which is the better half to keep. Ctrl+Z will not
bring a file back across folders; dragging it back will.

Two refusals worth keeping: a **name collision** in the target folder throws
rather than clobbering, and it is deliberately **not** retried, because that will
never resolve itself. **EBUSY is** retried, three times with a backoff — his vault
is in Dropbox, which holds a brief lock on a file it is syncing, and the first
live test of this feature failed on exactly that.

**v1.6.0 and .1 shipped with the feature dead**, and the cause is worth keeping:
`folderMoves` never reached `DEFAULT_SETTINGS`. The edit that should have added it
matched nothing and did nothing, and it was the one replacement in that batch
without an assert. So the toggle read `undefined`, the key stayed unwritable
however it was set, and every folder-grouped view kept refusing. Nothing errored;
`node --check` passed; the tests passed. There is now a test that reads this
source, collects every `settings.<key>` it references and asserts each has a
default — it catches the whole class in one assertion.

Also fixed here: a view grouped by something unwritable refused every row drop
**with a blank label**, because `planRowDrop` returned the wrapper around the
refusal instead of the refusal. The one place the plugin has to explain itself is
where it says no.

## v1.7 — dates are never written

His call. A date on a note is usually a fact about the thing — when it was
created, when someone was born — not a dial to turn, and a drag that quietly
rewrote `created` would be doing real damage for a cosmetic reason. The plugin
could only ever *copy* a date anyway (there is no sensible value between two
dates), so refusing outright loses nothing.

Detected from two sources, because either alone has a hole: the characteristic
note's `property type`, and **Obsidian's own `metadataTypeManager.getTypeInfo`**,
which knows the type of properties his model has no note for. A date key is then
unwritable exactly like `file.mtime` — it truncates the sort keys, it is named as
the blocking key, and grouping by one is refused in those words.

Live: all five of his date characteristics (`duedate`, `created`, `birth day`,
`death day`, `class date`) are refused; `status`, `activity`, `active priority`
and `project` are untouched.

**The test for this caught a latent crash.** `(s && s.characteristicPrefix) !==
undefined` reads as a null guard and is not one: with no OOF Class Manager installed
`s` is null, `(null) !== undefined` is true, and the next line throws. The claim
that this plugin works without OOF was false until 1.7.1.

## v1.8 — a group for every possible value

His ask: *"it would be really nice if all possible groups were visible in bases
(for characteristics which have `possible values`). This would allow me to drag
and drop something into a group in which no note currently resides."*

A base only has the groups its notes put there, so a value nothing carries yet
has no heading — and **you cannot drop a note into a group that is not on the
screen**. So a group is drawn for each value the characteristic declares, empty
ones included.

This is the plugin's own idea read backwards. Everywhere else a *position* is a
consequence of a note's values; here a *group* is a consequence of the values the
characteristic declares, whether or not any note has got round to using one. Same
field, same classifier as `betweenValue`: **words give a list; an interval is a
shape and a class is a type**, and neither of those two is enumerated — grouping
his notes by `project` would grow a heading for each of eighty-four notes in
place of the eight values actually in use.

They are drawn **collapsed**, which was his condition and is the right one: a
full-strength heading with nothing under it is exactly the visual clutter the
plugin exists to remove. A small dashed slot in `--text-faint` at rest; while a
drag is in flight every one of them comes up together, before the pointer has
found any — the same argument as drawing every landing place at once rather than
only the one being hovered.

### Where it hooks, and the collision that cost the most

`data` is a brand new object on every query run and `onDataUpdated` is the one
call that follows it, so that is the hook — installed on the **view instance**,
not on a prototype. `groupedData` is a prototype getter that OOF Declared Order
has already patched, and two plugins restoring one descriptor in the wrong order
would reinstate a getter that had unloaded.

The guard on that hook started life as `hasOwnProperty(view, 'onDataUpdated')`,
which looked like *"have I already installed?"* and is not. **OOF Declared Order
wraps this very method on this very object, for the very same reason** — it is
the moment a view's data exists — so the slot was already an own property, this
hook silently declined to install, and the empty groups appeared with nothing
ever marking them in the DOM. The guard is our own flag now, the previous
descriptor is captured and put back, and the restore stands aside if someone has
stacked on top since. *Sibling plugins meet at the same seams; a hook must ask
only whether it itself is in.*

Two things fall out of the hook's position:

- **The groups are rebuilt, not topped up.** A phantom is only ever a consequence
  of what the characteristic declares, so one whose word has since left `possible
  values`, or that a real group has appeared for, has to go — and the only way to
  be sure of that is to take them all out and ask again. The array is emptied in
  place so the identity the getter cached survives.
- **The classes are re-applied after every render, and then the view is
  re-measured.** The table builds a fresh heading element each time, and a group's
  height is read off the DOM in `updateVirtualDisplay`, which has already run by
  the time our class lands — without the second pass every group below an empty
  one sits a few pixels wrong.

Where a phantom is *placed* is the same comparator Obsidian uses: its group sort
is `new Intl.Collator(undefined, {sensitivity: 'base', numeric: true})` — already
at the top of `main.js` — with the group holding no value pushed to the end. A
direction that is neither ASC nor DESC is OOF Declared Order's `DECLARED`, and
there the order *is* the `possible values` list, which is the list being walked.

`BasesEntryGroup` and `StringValue` are ordinary exports of the `obsidian`
module, so an empty group is a **real** group rather than an object shaped like
one — Obsidian calls `key.renderTo()` on it to draw the heading and OOF Declared
Order calls `hasKey()` on it to rank it.

The drop itself needed no new code: `planGroupDrop` already reached a group's
value through the group **key** when no member could supply it. That branch had
simply never had to work before, because until now every group had a member.

Live, on his Improvement Base: two fabricated values appear as collapsed slots in
declared order, a planned drop onto one reports `checkpoint → lost`, and clearing
the fabricated domain withdraws them again.

### v1.8.1 — the slot must not animate into existence

He found the dashed line flickering bright-then-faint, twice, every time he edited
a field in the base. Not a drag: **an inherited transition firing on the frame the
decoration is first applied**.

Three facts compound. `.bases-group-heading` already carries `transition: all`;
the table builds a **fresh** heading element on every render; and an unclassed
heading has `border-width: 0` with `border-color` defaulting to `currentColor`,
which is the full-strength text colour. So the border was born bright and animated
down to faint on each render — and editing one field re-queries twice.

`transition: none` on the resting state, and the 100ms transition moved into the
`.bases-dnd-dragging` rule, which is the state being *entered* and therefore where
a transition is read from. Coming back out of a drag snaps, which is the right way
round: a drag ending should leave nothing fading behind it.

The general rule, since this is the only place the plugin classes an element
Obsidian creates fresh each render: **an inherited transition is not a free
effect**. Check what the host already declares before adding a class to something
you did not build.

## v2.0 — the `+ New` button, and the rename

From his note `Obsidian/Notes/dealing with \`+ new\` button in bases.md`. He named
the result **Bases Table Kanban**; the folder id stays `bases-drag-drop` so his
settings survive.

His three steps *are* the design:

1. the note is created in the base, with the base's template
2. a window offers to change the name Templater gave it
3. clicking out of that window arms the placement, which "will look exactly like
   as if they had grabbed the file, except instead of releasing to drop, they
   simply click where they want to drop"

Plus a fourth line, first in his note: an option to hide the button entirely.

### "The button should bring up no menu"

That sentence is the one that shapes the code, and it is worth stating why it is
right. The first build asked *first* — a dialog listing every reachable
placement, computed against a **draft**: an entry-shaped object carrying the
template's frontmatter, so the walk could be run over a note that did not exist
yet. It worked, and it was wrong twice over.

It was a second way to answer a question this plugin already answers. And the
draft was a fiction that had to be maintained: it needed `getValue` to agree with
`cellOfLiteral` about how a list is spelled, it could not see the properties
Obsidian derives from the base's filters, and every one of those was a place for
the dialog to promise something the creation would not deliver.

Creating first deletes all of it. The note is a real row in a real group, so
step 3 is **the ordinary drag walk**, and placement mode is 90 lines that drive
the very same `onDrop` from mousemove and click instead of dragover and drop.
`draftEntry`, `newNotePlacements` and the dialog are gone.

### Where it hooks

The button is `queryController.newItemMenu`, and `open(name, frontmatter)` is on
its prototype — so one patch reaches every base, in leaves, popovers and embeds
alike. The class is internal, so it is reached lazily through a live controller
in `attach()`: a live view is the only name it has.

The guard is **our own mark**, not `hasOwnProperty(proto, 'open')` — `open` is
the prototype's own method to begin with, so that question is always answered
yes. Same lesson as the empty-groups collision with OOF Declared Order: a hook
asks whether *it* is installed, keeps what it replaced, and stands aside on
restore if somebody has stacked on top since.

### Why the button needed taking over at all

Obsidian derives a new note's properties from the base's filters, but its
deriver understands a fixed list of shapes — `note.x == v`, `.isEmpty()`,
`startsWith`/`endsWith`/`contains`/`containsAll`/`containsAny`, `file.hasTag`,
`file.inFolder`, `file.folder ==`, `file.hasProperty` — and skips negated rules
outright. `file.isA("Improvement")` matches none of them and is dropped in
silence, so a note made in a class base is born carrying no `is a` and is
filtered straight out of the base it was made in. Obsidian even ships the
message for it: *"This note will be filtered out because it doesn't match your
criteria"*.

Its own `newItemTemplate` would fix that, except that it copies a template's
**frontmatter and nothing else** — no body, and no Templater, so a class
template's unique-file-name block never runs and step 2 has no name to offer.

### Pouring the template, and why the order is fixed

`templater.write_template_to_file(template, file)` parses the template (running
its commands, `tp.file.rename` included), merges its frontmatter into the file's
and appends its body. That is the missing half.

It has to happen **between `createNewFile` and `processFrontMatter`**, and there
is no argument on `open` for that — so `createNewFile` is wrapped for the length
of one call, fires once, and is put back in a `finally` and only if it is still
ours.

Not afterwards, and this is the sharp edge: Templater merges a list-valued
property by **concatenating** (`[i].concat([n]).unique()`), with no guard for an
empty incoming value. A template key left blank parses as `null`, so pouring
after the placement had written `project: ["[[Class Manager]]"]` would leave
`project: ["[[Class Manager]]", null]`. Pouring first leaves Obsidian's
`processFrontMatter` — plain assignment — with the last word.

**Templater's own folder trigger stands aside**, and it does so by a mechanism
worth knowing: `on_file_creation` waits 300ms, then returns early if the path is
in `files_with_pending_templates`, which `write_template_to_file` adds to
synchronously. Its second guard is `content.length - frontmatterInfo.contentStart
=== 0` — the folder template only applies to a file whose **body** is empty — so
where it does still fire afterwards it re-runs commands rather than applying a
second template.

### Which template

Two sources, in order:

1. `query.newItemTemplate` — Obsidian's own key, settable from the base's own
   *New item template file* setting. Explicit, so it wins.
2. otherwise, a base whose top-level filter says `isA("X")` is a base of X's, and
   X's template is `X Template.md`, found by name, case-insensitively the way
   Obsidian resolves any name.

That second read is of the **vault**, not of OOF Class Manager: `is a` is a
convention he invented and wrote into his notes, `isA()` is a line of text in a
`.base` file on disk, and `<Class> Template.md` is a note's name. Nothing here
touches `app.plugins`, which is what keeps the Declared Order split honest.

Two refusals, both deliberate. Only the **top-level** filters are read — a view's
own filters narrow the base, they do not say what it is of. And only when there
is **exactly one** class: a base filtering on two is a base about two things, and
picking one silently is worse than no template, which the base can always
override by naming one.

Measured over his own vault: `Improvement`, `Obsidian Plugin` and `Effort` all
resolve; `Bug Fix Base` filters `isA("bug")` and `Creator Base` filters
`isA("Artist")`, and neither class has a template — those two are discrepancies
in the vault, and the plugin reports nothing rather than reaching for the
similarly-named `Bug Fix Template.md` and `Creator Template.md`.

### Placement mode

`DragLayer.beginPlacement(file)` waits for the **entry**, not for a render event:
the base re-queries asynchronously after a creation, so the row does not exist
yet, and polling for the entry makes no assumption about which render arrives or
when. Two seconds, after which the note is filtered out of this base rather than
late, and a Notice says so.

From there the plugin routes:

| in a drag | in placement mode |
|---|---|
| `dragover` → `onDrop(evt, draggable, true)` | `mousemove` → the same |
| `drop` → `onDrop(evt, draggable, false)` | `click` → the same |
| `dragManager.setAction` draws the label | `.bases-dnd-place-label` follows the pointer |
| `dragManager.updateHover` lights the group | `paintPlaceHover` adds the same class |
| release ends it | Escape, or a click outside, ends it |

A click is the drop, so it must not *also* be what the click would ordinarily
have been. Both `mousedown` and `click` are swallowed in the **capture** phase —
mousedown because that is where the table's cell selection starts, click because
that is where a note gets opened.

A refusal leaves the mode armed. The click landed somewhere this base cannot put
the note, and cancelling on it would throw away the placement for what is really
a mis-aim; the reason is already on the label.

Verified live against his Improvement Base: hovering a row 19 rows down gives
`active priority → 0 · can't go between those two — value decides`, with the bar
drawn and two alternative marks; a group heading he is already in refuses with
`Already in this group.` and no hover class; and `stopPlacement()` leaves no
stray `.bases-dnd-over`, no label and no marks.

### v2.0.1 — armed where there was nothing to place

His bug, the day it shipped: `+ New` on the `Object Base` **Cards** view — no
grouping, no sort — made the note and then armed the placement, where every
place the pointer could reach refused with *"This view has no sort to write."*
A red tooltip following the cursor, with nothing to click and no obvious way out.

**The message was right and the arming was wrong**, and the difference is who
asked. A drag in that view is a gesture somebody made, and explaining why it
cannot land is the answer; the placement is *offered*, so offering one that can
only refuse is a defect. A view with no writable group-by and no writable first
sort key has no order at all — a card's position in it is whatever order the
query returned, which is not something a drop can choose.

So `canPlaceIn(view, domains)` is asked **before** the popover is even waited on
(the answer cannot change while he types a name), and where it is false the note
is simply made — which was the complete outcome in that view anyway.

Asserted as the invariant rather than by reproducing the tooltip: eight
assertions that arming happens exactly where something can be written, including
that a date group-by is *not* an order a drop can set, and two that the drag's
refusal in the same view is unchanged. A fixture that is the bug goes green by
going red the moment the bug is fixed.

### Hiding the button

A body class, `bases-dnd-no-new`, not a hidden element. The toolbar is
Obsidian's and it rebuilds it, so an element hidden by hand comes back visible on
the next render — and holding a reference to it in order to re-hide it is exactly
the mistake of caching an element the app owns. A rule keyed on the body applies
to every base that has ever been drawn, including the ones drawn later.

## v2.1 — the cards view, and a value that decayed

He reported the cards view as "quite broken". Three separate defects, and the
worst of them had been quietly damaging data since v1.0.

### The marks were drawn on the wrong axis

`.bases-dnd-indicator`, `.bases-dnd-option` and `.bases-dnd-from` were all
`height: 0` with a `border-top` — horizontal lines, positioned by
`boundaryY`, which returned the *top* of the row after the gap. That is right for
a table or a list and meaningless for a grid: cards wrap into rows, so every gap
in one row resolved to the same full-width line across it. Four gaps, one mark.

`boundaryY` is now `boundaryBox`, returning a rect. In a grid the bar stands on
the **left edge of the card after the gap** — the one description that reads the
same whether the two cards sit side by side or on either side of a row wrap —
falling back to the right edge of the card before it for the end of the last row.

The bar itself needed no new styling: `.table-drag-target.mod-row` and
`.mod-col` are Obsidian's own two insertion bars and they are exactly symmetric,
one bleeding its `::after` vertically out of a zero-height box and the other
horizontally out of a zero-width one. A grid gets the app's vertical bar for
free, in both themes, exactly as a list gets its horizontal one.

Measured live: the bar now lands at six distinct positions across the six cards,
`width: 0`, `height` the card's, and wraps to `top: 326.75px` at the end of the
first row.

### The cards heading is a sibling, and the property is undefined

`LAYOUTS.cards.headingEl` read `g.groupHeadingEl`. On 1.13.7 a cards group
carries `view`, `containerEl` and `groupHeadingEl` — and that last one is
`undefined`; the heading is a **sibling** placed before the container inside
`.bases-cards-container`. It is read off the DOM now, and only when the element
before really is one. This had silently taken the empty-group marking out of the
cards view entirely.

### A value chosen for ordering is also a value somebody reads

The one that matters. Six notes he had made that afternoon, in a cards view
sorted by `rating` DESC, read:

    4.9688   4.9375   4.875   4.75   4.4375   4.2657

Nobody types those. `betweenValue` took the **midpoint** of two neighbours, which
is always a correct ordering value and always a worse-looking one than either —
so every drop buried the rating another digit deep. On a `priority` nobody reads
that is merely ugly; on a rating he assigns by judgement it is data loss.

Worse, **every hover proposed one, including the hover over the card's own
position**. The walk asked `betweenValue` for a fresh value at the deciding key
without ever asking whether the note already held one that put it there. So
dropping a card back where it was still rewrote its rating.

Two rules:

1. **A key the note already satisfies is not written.** Before asking for a
   value, check whether the note's current one already sits strictly between the
   two bounds. If it does, keep it. An empty plan already had a graceful refusal
   — *"Already there — nothing to change."* — which now actually gets used.
2. **The simplest number, not the midpoint.** `simplestBetween(lo, hi, aim)`
   returns the value with the fewest decimal places, and among those the one
   nearest what it aims at — the midpoint normally, or just past the single known
   neighbour at the ends. Between 4.875 and 4.9375 that is 4.9, where the
   midpoint is 4.90625. Bisection survives only as the fallback for an interval
   too narrow to hold a short decimal.

On his own six cards, before: `4.9063 4.8125 4.5938 …` and a rewrite for
standing still. After: `Already there` for the first gap, then `4.9 4.8 4.6 4.4 4`.

Four existing assertions had encoded the old behaviour — including one that
expected `activity` to be rewritten from `dead` to `sleeping` in order to put a
note where it already was. They assert the new rule now, plus eight that pin
this one: that the result is always strictly inside the interval, that twenty
drops into the same shrinking gap stay readable, and that a declared `[0, 10]`
is what makes "below everything" answer 4 rather than the neighbour minus one.

### The lesson

A value that is correct for ordering can still be wrong as data, and the
difference only shows up when the gesture is repeated. Judge a write by what a
hundred of them leave behind, not by whether one of them sorts right.

## v2.2 — the marks were 79px too high, in every layout, since v1.0

He said the cards view "still looks quite rough around the edges". Screenshotting
the running app and then measuring the elements found something much worse than
roughness.

### The containing block

`.bases-view` ships `position: static`. Every mark this plugin draws is
`position: absolute` and appended to it — so they never resolved against it at
all. They resolved against `.workspace-leaf-content`, the nearest positioned
ancestor, which sits **79px higher and outside the scroller**.

Measured on his cards view: a bar whose inline `top` was a correct `12px`
rendered at y=52 while its card started at y=131. It painted over the toolbar
instead of clipping to the view, and it would not have scrolled with the content.

An A/B in the running app, flipping `position` back to `static` on the live
element, gives the same 79px in the **table** view: a bar at 449 renders at 370,
which is about two and a half rows out. So this was wrong everywhere, from v1.0,
and the manual `scrollTop` arithmetic in `placeMark` had been compensating
against the wrong element the whole time.

The fix is one declaration — `.bases-view { position: relative }` — which moves
nothing on its own and only makes the element the containing block its own
children were always assumed to have. It is the `z-index needs a stacking
context` lesson wearing a different hat: **an absolutely positioned child is a
claim about its parent, and the claim has to be checked.**

### Standing in the gutter, not on a border

His cards are 221px wide with an 11px gap. A bar drawn at a card's left edge
lands exactly on that card's border, where it reads as *that card is
highlighted* rather than as *here, between these two*. Where the two neighbours
share a visual row there is a real gutter to centre in; across a row wrap, or at
either end, the bar steps half a gutter off the card it belongs beside.

It is also inset at both ends now (`min(12, height/6)`), for the same reason: a
line running a card's exact height butts against its corners and reads as a
border, where one pulled in at both ends reads as a mark standing between them.

### Saying which note is in hand

A drag has the browser's own ghost under the pointer. A **placement** has no
button held and no ghost — so until now the entire gesture was about a note that
was not identified anywhere on the screen. The card being placed is now outlined
and dimmed (`.bases-dnd-placing`).

Two details. The outline goes round the card's own silhouette rather than on one
edge, which is what an outline is for. And the class is **re-asserted on every
pointer move** rather than set once, because cards and rows are recycled — a
class put on an element is handed to a different note the moment the view
re-renders. It is keyed on the file, which is what survives a re-query. No
transition of ours, for the same reason: anything animating on arrival would
restart continuously.

### v2.2.1 — the empty space was the largest dead target on the screen

Dragging a card and hovering the blank area of a cards view answered
*"This view is not grouped."* and drew nothing at all.

`resolve` had only two cases — the pointer is on a row, or it is on the group —
and `!itemEl` fell into the second. So in an ungrouped view the biggest target on
the screen replied with a refusal about grouping, in a view where every card was
a legal drop. Below the last group it was worse: no group element under the
pointer at all, `groupIdx` null, and `resolve` returned null, so there was no
feedback of any kind.

Empty space now means **the end of that group** — the position it obviously
points at, and the only way to reach the end of a group whose last row is off the
bottom of the view. His N.B. gave the *heading* to "regroup without choosing a
position", so the empty space was never the thing that had to carry that meaning.
A grouped view with nothing writable to sort by still falls back to the regroup,
so nothing is lost.

`groupAbovePointer` handles the pane below every group: inside one wins,
otherwise the last group that ends above the pointer.

Verified on his cards view: hovering the blank pane draws the live bar after the
last card, five faint marks in the gutters between the others, and the label
`rating → 4`.

### v2.2.2 — and the fallback invented a group

The fix above went too far. Where there was no group element under the pointer
it took the nearest group above — which in an **ungrouped** view is the tail of
the only group there is, and in a **grouped** one is whichever group happens to
end last.

Measured on his Improvement Base, four groups by `checkpoint`: hovering the pane
below all of them offered
`checkpoint = reached · activity = sleeping · active priority = 0`. A silent
regroup into the last group, from a piece of blank pane that belongs to no group
at all.

So the fallback now applies only where there is **exactly one group**. Below the
last group of a grouped view there is genuinely nothing to point at, and nothing
is what it draws.

The general shape of the mistake: a fallback that is obviously right in the case
you are looking at, reached from a condition broader than that case.

### v2.3 — empty space is where you ask "where CAN it go?"

Two rounds of narrowing what the empty pane meant still left it useless in the
commonest case: dragging a note that is already at the end of its group, the
label read *"Already there — nothing to change."* and nothing was drawn.

Both halves were true and the pair was worthless. Empty space asks for the end of
the group, which for a note already there is genuinely no change — but the
refusal ran through `hideIndicator`, and **`hideIndicator` clears the option
marks as well as the bar**. So the one moment you most want to be shown every
place the note could go showed none of them.

The insight the three rounds were circling: **the empty pane is not aimed at a
spot.** It is where you look when you do not yet know where you are going. So a
refusal there keeps the marks:

* the spot under the pointer is unusable — no bar, `dropEffect: none`
* every *other* place in the group is not — so all of them are drawn
* and the label points at them rather than restating the refusal:
  *"Already at the end — the marks show where else it can go."*

`groupIdx` and an `emptySpace` flag now ride along on the refusal, which is all
`showOptions` needed to work from it.

Measured on his own cards view, dragging `Ear (3)` (last, rating 4.4375) over
the blank pane: **six marks**, no bar, that label. Dragging the first note over
the same pane still gives `rating → 4` with the bar at the end.

### v2.3.1 — white space is a place, not a destination

*"any white space reroutes to the end of the list instead of the correct place."*

The `!itemEl` branch asked for `Number.MAX_SAFE_INTEGER` — the end — for every
pointer position with no card under it. But "no card under the pointer" is two
different situations:

* the **gutter** between two cards, or the gap between two rows, which is an
  ordinary place and belongs to the cards beside it
* the **open pane** past the last card, which really does mean the end

Cards sit in a grid with an 11px gutter, so most of the space between them is not
on a card at all — and all of it was being sent to the end.

`nearestSpot` answers both with one question: which rendered item is nearest, and
which side of it is the pointer on. Distance is measured to the item's
**rectangle**, not its centre, so a pointer level with a card but far to its right
is "just outside that card" rather than "closer to the one diagonally below". The
side comes from the axis the layout flows along, except when the pointer is clear
above or below an item, which settles it on its own.

**The end stops being a special case** and becomes a consequence: past the last
card, the nearest item is the last card, approached from below, which is the end.

Measured on his cards view, dragging the first note: the gutter between cards 2
and 3 lands at 1 (`rating → 4.877`), the gutter between 3 and 4 lands at 2
(`rating → 4.8`), and the space right of the last card lands at 4 (`rating → 4`).
Distinct, ordered, and the end reached only from the end.

### v2.3.2 — a cards heading belongs to no group

Dropping onto a group heading in the **cards** view did nothing at all: no bar,
no label, no refusal.

`resolve` finds the group with `target.closest(groupSel)`. The table and the list
parent the heading **inside** the group element, so that works from the heading.
The cards view makes it a **sibling**, placed before the container — measured on
1.13.7, `headingInsideContainer: false` for every group — so `closest` found
nothing, `groupIdx` was null, and the whole gesture resolved to nothing.

It had never worked in the cards layout, and it is the one gesture his N.B.
reserves: *"If the user wants to only regroup a note and not decide its position,
then they can drop it in the heading of the group."*

`groupIndexOfHeading` maps a heading back to its group through
`layout.headingEl`, which already knew where each layout keeps its own — the
inverse lookup was simply missing.

Measured on his cards view, grouped by `is a`, dragging `Aranet 4` out of
`[[Air Monitor]]`: its own heading refuses with *"Already in this group."*, and
the other two give a clean regroup with no position —
`is a = [[Ear (from Nothing)]]` and `is a = [[Headphone]]`.

**The pattern to notice**: this is the same shape as the `groupHeadingEl` bug in
v2.2 — the cards view keeps its heading somewhere else, and every piece of code
that assumed otherwise failed silently rather than loudly.

## v2.4 — a group owns a band, not a box

Dropping onto a group in the cards view did nothing, and the previous four
attempts at this had all been guesses. This one was measured: a recorder wrapped
around `resolve` and `commit`, and **he performed the drag**.

823 pointer positions. The log killed every hypothesis at once:

* `head: false` on all of them — the pointer **never once registered on a
  heading**
* `lit: 0` and `obs: 0` throughout — nothing was ever highlighted, by us or by
  Obsidian, so the "it highlights all of them" was not a hover class at all
* `drops: []` — commit was never reached, in either of two drags
* **117 distinct positions resolved to nothing**, every one of them
  `tgt: bases-cards-container`, at the y of a heading

**A cards heading is only as wide as its text.** `[[Air Monitor]]` is 91px in a
919px pane, so the rest of that horizontal strip is bare container, belonging to
no group and no heading — and that strip is exactly where you aim when you mean
"put it in this group".

And dead there is worse than it sounds. With no plan we never call
`preventDefault` on the dragover, and **an unprevented dragover means the browser
fires no `drop` event at all**. Releasing did not do nothing figuratively;
nothing was dispatched.

So `bandAtPoint`: a group owns the whole horizontal **band** of its heading and
of its body, not merely the boxes painted there. Only the pointer's Y is
consulted, because at a given height in a grouped view there is exactly one
group whatever the horizontal position. The 8px margins *between* groups go to
the nearer one — but only between the first and the last, since past the end
there is genuinely nothing to point at, which is the v2.2.2 lesson kept intact.

**Verified by replaying his own recorded coordinates**: all 117 dead positions
now resolve (48 a regroup, 11 a position, 58 the correct "Already in this
group."), and the 40 that already worked are untouched. A simulated release at
`(382, 171)` — one of the dead ones — now prevents the dragover, lights exactly
one group, and reaches commit with `is a = [[Air Monitor]]`.

**The lesson, and it is the one that would have saved four rounds:** when a
report and a reproduction disagree, instrument the real gesture rather than
refining the reproduction. Every simulation I wrote passed, because I was
choosing the target element myself — which is precisely the step that was
failing.

### v2.4.1 — the column list nulled the template

`+ New` on his Improvement Base made a note **without its `is a`**, so it was
filtered straight out of the base it had just been made in.

Obsidian derives a new note's properties from the base's filters — and it also
adds `null` for **every `note.*` key in the view's `order:` list**. That table has
an `is a` column. Its pass runs *after* our template pour, and it is a plain
assignment, so `is a = null` went straight over the `[[Improvement]]` Templater
had just written.

The plugin's own comment said pouring first "leaves Obsidian's
`processFrontMatter` — plain assignment — with the last word". That was the bug
written down as a design note: its last word is a null.

The repair goes in the one place that runs after Obsidian's pass — the
frontmatter callback it invokes last. The frontmatter the file really holds after
the pour is read back with `parseYaml` (from the FILE, not the template's cache
entry, because a template's `created:` is `<% tp.date.now() %>` there and a real
date in the note), and any of those values is restored **where the key is now
blank**.

Blank is the whole rule. A value the filters genuinely derived is a fact about
this base and outranks the template; a null from the column list is not a value
at all.

Seven assertions cover it, including that a derived `rating: 7` is not
overwritten by the template's `3`, that a key the template left empty stays
empty, and that a failed pour restores nothing. One older assertion had to
change: it expected the caller's callback to leave `{ mine: true }` alone, which
was the missing restore recorded as an expectation.

## Tests

`claude_vault/tools/bases-dnd-tests/run.js` — 175 assertions over the placement
logic, with `obsidian` stubbed and the real module loaded. Run with

    node run.js

The live checks that a stub cannot do are worth repeating after an Obsidian
update, over the debugging port against `template_vault`:

1. every entry of every group, removed and re-inserted, lands inside its own
   `landingRange` (40/40 on his Improvement Base);
2. a synthetic dragover on a real row resolves to the right group, entry and
   label;
3. a write of two properties followed by `undoTransaction()` leaves the file
   byte-identical.

`plugin.diagnostics` exposes the placement functions on the live instance for
exactly this. It reads nothing and writes nothing.

---

## v2.5 — `+ New` in an embedded base

Obsidian's `NewItemMenu.open` ends by building the rename popover and calls
`setIsFocused` on it unguarded. In a base drawn as an **embed** — a Dynamic Viewer
band, a `![[X.base]]` in a note — the popover factory returns `null`, so `open`
rejects *after* the note has been created, named by Templater and given its
frontmatter. The button looked inert while quietly leaving files behind.

Three changes:

- **A throw is only a throw when there is no note.** The wrapper rethrows only if
  `menu.newlyCreatedFile` is absent; otherwise it logs a warning and carries on
  with the steps Obsidian's failure would have eaten.
- **The name is asked in a modal** where the popover could not be built and
  *Offer a name for the new note* is on. This is not a second copy of Obsidian's
  creation — nothing is created there, the note exists and the modal renames it
  through `fileManager`, so links are rewritten. Obsidian's own fallback (its
  phone path) opens the note in a tab, which would navigate away from the base the
  note is being placed into.
- **The drag layer is resolved when the name is settled**, not when the note is
  made: an embedded base's `view` is not on its controller yet at creation time.

---

## v2.6 — which subclass

A `+ New` in a class base asks which class, before anything is created: the base's
own class and every class below it by `type of`, indented by depth and carrying
each class's `symbol:` where that symbol is a Lucide id. Picking one makes the note
from *that* class's template.

An Improvement Base can therefore make a Project — a Project is a `type of` Effort
is a `type of` Improvement, so it satisfies the base's own filter and belongs
there — without editing the frontmatter afterwards.

- Shown only where there is something to choose. One candidate is not a question,
  and a base that names its own `newItemTemplate` has already answered.
- Dismissing it creates nothing.
- The picked class **outranks** the `is a` Obsidian derives from the base's filter,
  which is the parent. That is the one exception to *a derived value beats the
  template*: without it the choice is undone as it is made.
- `type of` and `is a` are read from OOF Class Manager's settings when it is
  loaded, and default to those names otherwise.
- Off switch: *Ask which subclass*.
