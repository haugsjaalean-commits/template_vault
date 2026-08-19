# Bases Formulas

A right-sidebar panel over the formulas of **every** base in the vault. There is one
list of formulas and it is shared: a formula written once is defined in every base,
so it appears in every base's column picker, filter menu and sort menu without being
retyped.

Open it from the ribbon (Σ) or from **Open the formulas panel** in the command palette.

## What the panel does

| | |
|---|---|
| **New formula** | name it, write the expression — it is pushed into every base |
| **×** | removes it from every base, references included |
| the list | every formula, its expression, and how many bases carry it |
| **In** | `Every base`, `Only…`, or `All except…` — the per-base limit |
| **Shown as** | the display name written under `properties:` |
| **Add as column** | a one-shot request to show it as a column (see below) |
| **Sync now** | shows a plan of every file that would change, and writes on confirmation |

## Both directions

Obsidian's own base UI can add a formula too, and when it does the plugin **adopts**
it: an unknown formula found in a base joins the shared list and is passed to the
others. So "adding a formula to one base adds it to all bases" holds whichever way
it was added.

Which way an edit travels is decided by a snapshot of what was last written to each
base:

    base differs from the snapshot  ->  the base was edited, the base wins
    base matches the snapshot       ->  the list was edited, the list wins

Two consequences worth knowing:

- **Deleting a formula from a base through the base UI puts it back.** Removing one
  for good is what the panel's × is for — otherwise a formula shared by twelve bases
  could be destroyed by tidying one of them. Keeping one deliberately out of a base
  is what `All except…` is for.
- **Adding a formula back to a base it was scoped out of re-includes that base**,
  because we know we did not put it there.

A formula the plugin has never heard of is left where it is, with its expression
untouched, when *Pick up formulas from bases* is off.

## Columns are not added unasked

Defining a formula in a base does not make it a visible column — a column appears
when a view's `order:` names it. Adding columns to every view of every base on its
own would rearrange tables built by hand, so it is the **Add as column** button
instead, per formula, applied once at the next sync.

Even then, only views that **already have an `order:` list** are touched. A view with
no `order:` is showing Obsidian's default columns, and giving it a one-item `order:`
would hide the rest.

## How it writes

The plugin edits `.base` files, so it edits by *surgery*, not by re-serialising: it
replaces the `formulas:` block, the `formula.*` entries under `properties:`, and the
references to a removed formula inside `views:`. Everything else — filters, views,
column widths, the graph state Obsidian churns — comes out byte for byte identical.
Re-emitting a parsed file would reformat all of it and lose anything the parser did
not model.

Removing a formula removes what points at it as well, since a reference to a formula
that no longer exists shows as a broken column:

    - formula.x               an entry in a view's `order:`
    - property: formula.x     an entry in `sort:`, and the `direction:` under it
    formula.x: 379            a key in `columnSize:` or `summaries:`

Renaming a formula in the panel carries all of those to the new name rather than
dropping and re-adding the column.

`Sync now` shows every file and every line that would change and writes only once
that is confirmed. **Sync automatically** (on by default) does the same work without
the confirmation, which is the point of it — turn it off and nothing is ever written
except through the plan, while the panel still keeps up with what the bases contain.

## Settings

| | |
|---|---|
| Sync automatically | write as soon as the list or a base changes. Off: only through `Sync now` |
| Pick up formulas from bases | adopt formulas written through the base UI |
| Manage display names | also write each formula's `displayName` into `properties:` |
| Bases folder | limit the plugin to bases under one folder. Empty = the whole vault |

## Where the list lives

In this plugin's `data.json`, alongside the snapshots, under `formulas`. The bases
are the copies; `data.json` is the original — there has to be somewhere holding the
union for "in every base" to mean anything.

Deleting `data.json` therefore forgets the scopes and the snapshots. It does not lose
the formulas themselves: they are all still in the bases, and the next scan adopts
them back, as `Every base`.
