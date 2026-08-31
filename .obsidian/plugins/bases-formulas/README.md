# Bases Sharing

Two right-sidebar panels over what every base in the vault has in common, and one
Sync behind both:

| tab | one shared list of… |
|---|---|
| **Formulas** (Σ) | formulas — written once, defined in every base |
| **Views** (▦) | views — built once, present in every base |

They are two halves of one plugin rather than two plugins because they write the
same lines of the same files: a shared view's `order:` and `sort:` name `formula.*`
columns, so whatever writes views has to know which formulas each base carries.

Open either from the ribbon, or from **Open the formulas panel** / **Open the views
panel** in the command palette.

---

# The formulas half

A panel over the formulas of **every** base in the vault. There is one list of
formulas and it is shared: a formula written once is defined in every base, so it
appears in every base's column picker, filter menu and sort menu without being
retyped.

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
Shared by both halves — one Sync writes both.

| | |
|---|---|
| Sync automatically | write as soon as a list or a base changes. Off: only through `Sync now` |
| Pick up formulas from bases | adopt formulas written through the base UI |
| Follow view edits made in a base | a shared view tuned in one base becomes the shared one |
| Kept per base | keys of a shared view every base keeps its own copy of |
| Manage display names | also write each formula's `displayName` into `properties:` |
| Bases folder | limit the plugin to bases under one folder. Empty = the whole vault |

## Where the list lives

In this plugin's `data.json`, alongside the snapshots, under `formulas`. The bases
are the copies; `data.json` is the original — there has to be somewhere holding the
union for "in every base" to mean anything.

Deleting `data.json` therefore forgets the scopes and the snapshots. It does not lose
the formulas themselves: they are all still in the bases, and the next scan adopts
them back, as `Every base`.

---

# The views half

The same idea, applied to views: build a view once — its layout, its sort, its
grouping, its own filter, and for a graph the whole set of forces and colour groups
— and every other base gets that view.

Open it from the ribbon (▦) or **Open the views panel**.

## Sharing is opt-in

Unlike formulas, a view joins the shared list only when you pick it. A formula is
small and having two copies of one is always a mistake; a one-off table in one base
is an ordinary thing to want.

**Share a view** lists every view of every base that is not shared yet, grouped by
base. Picking one captures its YAML as it stands *there*, and from the next sync
every other base holds that view. A view whose name appears in several bases says so
in the list, because sharing it replaces the others.

From then on it is kept in step both ways: tune the shared view in any base and the
others follow, exactly as a formula does.

## Global filters stay per base

A view carries its **own** filter, inside its own block in `views:`. The base's
top-level `filters:` is a different block and is never touched.

That is what makes a shared view usable at all — the same local filter applied over
each base's own global one:

```yaml
filters:                       # the base's own. Never shared.
  and:
    - file.isA("Person")
views:
  - type: graph
    name: Graph
    filters:                   # the shared view's own. Travels with it.
      and:
        - '!file.hasTag("draft")'
```

## What each base keeps for itself

Some keys are not shared, because Obsidian rewrites them from merely *looking* at a
view. Sharing those would mean one pan of one graph rewriting every base in the
vault, forever:

| | |
|---|---|
| `columnSize` | column widths, dragged per base |
| `graphOptions.scale` | where the graph camera is |
| `graphOptions.close`, `graphOptions.collapse-*` | which settings sections are folded |

They are stripped when a view is captured, and put back **from each base's own copy,
in the position they were in**, when it is written. Position matters: Obsidian writes
`scale` after `linkDistance` and scatters the `collapse-` keys through the block, so
appending them at the end would move them, Obsidian would move them back, and the two
would rewrite the file at each other indefinitely.

The list is editable — **Kept per base** in the settings, one key per line, `parent.child`
for a nested one.

## Formulas a base does not carry

A shared view can sort on or show a formula that is scoped out of the base it is
being written into. A column pointing at a formula that is not there is a broken
column, so the view arrives without it — and if that was the only entry of a `sort:`
or an `order:`, the now-empty key goes too, rather than being left as a null.

## The rest of the panel

| | |
|---|---|
| the name | click to rename — the view is renamed in every base that carries it |
| **×** | removes the view from every base |
| **Stop sharing** | takes it off the list and touches nothing; every copy stays where it is and they drift apart from now on |
| the fold | the view's YAML, editable. It must parse, or it is not kept |
| **In** | `Every base`, `Only…`, `All except…` — the same scopes as a formula |

Two things worth knowing:

- **Renaming a shared view does not update embeds.** A note embedding it as
  `![[Some Base.base#Graph]]` has to be updated by hand.
- **Removing the only view a base has removes its `views:` block**, and Obsidian
  falls back to a default view there. The plan says so before it writes.

## Where the list lives

In `data.json` under `views`, next to `formulas`, each with its captured YAML body,
its type and its scope — plus `viewSnapshots`, which records what was last written to
each base so an edit can be told from a difference.

Deleting `data.json` forgets which views were shared and stops keeping them in step.
It does not remove them: every base keeps the copy it has.
