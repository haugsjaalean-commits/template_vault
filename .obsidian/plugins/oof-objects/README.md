# OOF Classes

A panel over the **classes** of the vault — the notes that act as classes.
Edit a class's name, characteristics and parents in one place; press
**Update**, and the consequences are pushed out to the ordinary notes, the
templates and the characteristic notes.

This is the plugin described in `OOF 0.3`.

## The model

| | where | shape |
|---|---|---|
| **class** | `Obsidian/Notes/` | `#class`, `characteristics:`, `type of:` |
| **characteristic** | `Obsidian/Characteristics/` | named `∘ <name>`; `characteristic meaning:`, `property type:`, `possible values:` |
| **template** | `Obsidian/Templates/` | `is a: [[Class]]` + one key per characteristic |
| **instance** | anywhere | `is a: [[Class]]` + the same keys, filled in |

Person declares `children`, `location`, `relation to me`. Artist inherits from
Person and adds `domain`. So Artist's template carries **all four**. Producing
that flattening by hand is the chore this plugin removes.

Two rules:

- **Nothing is implicit.** There is no root class, and no parent is ever added
  on your behalf. A class inherits exactly what its own note says it inherits,
  so the files are the whole truth.
- Parents are **`type of`** links, not `is a`. `is a` is instantiation, so an
  *instance* uses it to name its class; `type of` is subclassing, so a *class*
  uses it to name its parent. The panel, the generated bases and the
  [base functions](#in-base-queries) all draw that same line.

### Changing what a note is

A note created from a template says so explicitly:

```yaml
is a: "[[Note]]"
```

To make it something else, delete that and put the class you want:

```yaml
is a: "[[Artist]]"
```

The next **Update** brings the note into line — adding the properties Artist
carries, and removing the ones it no longer has (empty ones only; anything
holding a value is reported as a conflict instead).

`Note` is an ordinary class like any other. If you want Artists to carry what
Notes carry, say so: give `Artist.md` a `type of: "[[Note]]"`.

## `#class`

A class carries the tag `#class`. Update adds it to any class that lacks it,
keeping the tags you already had. The tag also counts as evidence on its own: a
note tagged `#class` is a class even if it declares nothing yet.

A card above the classes lists the **base characteristics** — the properties the
system reasons with, as opposed to the ones that merely describe a subject:

```
is a          instantiation: this note is one of these
characteristics  what this class's instances carry
type of          subclassing: this class is a kind of that one
```

Every class below gets **one editable row per entry**, so adding a fourth here
adds a fourth row everywhere.

**A base characteristic appears only where it carries a value.** A template
therefore gets `is a: "[[Class]]"` and nothing else from this list — a new note
is not a class, so `characteristics` and `type of` would be blank, and blank base
characteristics are not written.

In practice they are added in exactly two situations:

1. **a new class** — usually a `type of`
2. **a new note** — usually an `is a`

A note that is **not** tagged `#class` has its blank base characteristics removed
on Update. A class keeps its full set, blank or not: that is what being a class
looks like.

**Update enforces this on classes.** Any class whose note is missing one of
these properties is brought into line — the key is added, empty. Nothing is
invented: a class with no parent still gets `type of:` with nothing after
it. The plan labels those entries *(missing)* to distinguish them from values
you changed.

**Removing one cleans up after itself.** Take a base characteristic off the list
and the next Update removes that now-orphaned property from every class that
still carries it — empty ones only. One holding a value is reported as a
conflict and left alone, the same rule as everywhere else. Those entries are
labelled *(retired)*.

The three defaults are anchors the engine depends on and cannot be removed;
anything you add beyond them is read, shown and written faithfully, but carries
no inheritance meaning of its own.

## Unused characteristics

With **Trash unused characteristics** on (the default), Update offers to clear
out characteristic notes nothing refers to any more.

"Unused" is deliberately strict. A characteristic stays if **any** of these hold:

- it is a base characteristic, or one being retired
- any class lists it — including an edit in the panel you have not applied yet
- any note still carries it as a property **with a value**; the class may have
  dropped it while the data is still there
- anything links to it from outside the characteristics folder

Only when all four are false is it offered. A characteristic that is unused but
still linked is **reported instead of removed**, naming the notes that link to
it, so you can decide.

### It is trashed, not deleted

These are the only whole files this plugin removes, so they go through
Obsidian's own `trashFile` — landing wherever your **Deleted files** setting
puts them, and recoverable. They are marked in red in the Update plan, and the
plan counts them separately above the list.

## Property order

Properties are always laid out **by property type first, then alphabetically**,
whatever order they were added in the panel. `property type` comes from each
characteristic note; anything with no type known sorts last.

> **If a property looks out of place, check its characteristic note.** A blank
> `property type` means "unknown", and unknown sorts after everything else — so
> the property lands at the bottom rather than with its own kind. Update now
> fills in `property type: list` for the base characteristics, and says so in
> the plan, but an ordinary characteristic's type is yours to set.

```yaml
born:              # date
characteristics:   # list
children:          # list
domain:            # list
is a: "[[Artist]]" # list
rating:            # number
```

This is **checked on Update**, not only applied when something else changes: a
note whose keys are out of order is planned with the label *order*, and the plan
says what the new layout will be. Templates, class notes and instances all
follow the same rule.

Your own fields — a Templater `created:` line, `cover image`, `tags` — are never
shuffled. They keep their relative order and stay in front of the managed block.

## The panel

Classes are listed **by descent, then by name**: everything a class descends
from sits above it, and within one generation the names run alphabetically. So
`Person` and `Zebra` come first, then `Artist`, then `Aardvark`. Switch *Order
in the panel* to **By name** for plain alphabetical.

A **Find a class…** box at the top filters the list as you type,
case-insensitively. Escape clears it; the base-characteristics card steps out of
the way while you are searching.

### It follows the note you are reading

The panel highlights the class the active note is about — **itself** if that note
is a class, otherwise whatever its `is a` names — and scrolls to it. The card is
outlined, and marked *active* when the note is the class itself, or *active note*
followed by an `is a` chip when the note is one of its instances. Only the chip
is filled: `is a` is a property name and looks like one, while *active note* is
prose and is merely coloured.

It scrolls **only when you move to a different note**, never on an ordinary
redraw, so it will not yank the list around while you are editing chips. Turn it
off with *Follow the active note*.

### Each class is a dropdown

A class is **one row** until you open it: a twisty, its name, and everything that
acts on it. Click the row anywhere to open it; click again to close.

```
▸ Person                        ✎        📄 ▤ ▦ ⟳  ＋
▾ Artist          active note is a       📄 ▤ ▦ ⟳  ＋
    is a             ‹chips›
    characteristics  ‹chips›
    inherited        ‹chips, greyed›
    type of          ‹chips›
```

Open cards are remembered across restarts — which class you are working on
outlasts a session. **Unfold all** and **Fold all** are the two icons at the
right of the title — VS Code's pair, a square with a plus and a square with a
minus. Each greys out when it would do nothing, so neither depends on how many
cards happen to be open. Both act on every class, not just the ones the search
box is currently showing, and both are in the command palette (*Unfold all
classes*, *Fold all classes*) if they are worth a hotkey.

Opened, a class shows:

1. **one row per base characteristic** — `is a`, `characteristics`, `type of`, and
   whatever else you add. Chips link to the note behind each value
2. **inherited** — greyed under `characteristics`, not editable there because they
   belong to the parent, but still clickable

Type in the `+` box and press Enter to add. Click `×` to remove. A characteristic
that has no note yet is created on Update.

### The icons on the row

Everything a class has or does, on the one line — these used to be a row of words
underneath it.

| | what |
|---|---|
| **✎** pencil, beside the name | renames the class — see below |
| **📄** note | opens the class note |
| **▤** template | opens `<Class> Template.md` |
| **▦** base | opens `<Class> Base.base` |
| **⟳** refresh | queues that base to be regenerated — see *Generated bases* |
| **＋** new note, ending the row | creates an instance from the template |

Three of them **open** a file, and they are grouped together for that reason.
Rename **changes** a file, so it stays beside the name it acts on; new-instance
**creates** one, so it ends the row and gets the biggest glyph.

A file that does not exist yet keeps its place, faint, and says why when clicked —
*No base for "Artist" yet — Update creates it* — rather than making the row jump
about as templates and bases come into being.

**New class** is the **+** beside the count of classes in the header, in the same
accent colour and at the same size as the number itself.

### Renaming a class

A **pencil** sits beside each class's name — that is rename. It lives beside the
name rather than with the file icons, because every one of those opens a file and
this one changes one.

It moves three files — the class note, its `<Class> Template.md` and its
`<Class> Base.base` — and **Obsidian rewrites every link to them across the
vault**: the `type of` on its children, the `is a` on its instances, its
template's own `is a`. None of that is done by hand.

Unlike everything else here it happens **straight away rather than on Update**,
because it is not destructive and a rename left pending would leave the panel
showing a name your vault does not have. The confirmation lists exactly which
files move.

Any unapplied edits and a queued base refresh travel with the class, so a rename
never quietly discards work.

## Generated bases

With **Create a base for each class** on (the default), Update also writes
`Obsidian/Bases/<Class> Base.base` — one per class, listing that class's
instances:

```yaml
filters:
  and:
    - file.isA("Artist")
    - '!file.inFolder("Obsidian/Templates")'
views:
  - type: table
    name: Table
    order:
      - file.name
      - domain
      - children
      - location
      - relation to me
```

- **Templates are always excluded.** A template names its class through `is a`
  too, so without that clause it would appear as one of its own instances.
- **Filtering is by inheritance**, via `file.isA()` — so an Artist base includes
  everything that is an Artist through any chain, not just notes that name it
  directly. That function is [part of this plugin](#in-base-queries), so a
  generated base works with nothing else installed.
- **Columns are the class's characteristics.** By default everything an
  instance actually carries, inherited included; switch *Columns* to
  own-only to list just what the class adds.

### Created once, then yours

Unlike templates — which are regenerated so they stay in step — **a base is
written once and never touched again.** It is a starting point you go on to
edit: adding views, sorts, group-bys, extra filters. Rewriting it would throw
that work away.

So an existing base is left alone however far it drifts from what the plugin
would generate today, and Update never lists it.

### …unless you ask for it back

Each class with a base has a **⟳ refresh** icon on its row. Clicking it queues
that base to be regenerated: it appears in the next Update plan as *"Rewrite base for
X — replaces your edits"*, and nothing happens until you apply that plan. Click
again to cancel, or press **Discard** to drop every queued request.

A queued refresh is pending work like any other, so it marks the panel *unsaved*
and survives a restart. Applying it spends the request — the base goes back to
being yours.

## The `∘` on characteristic notes

A characteristic note's **file name** begins with `∘`, the way `•` begins a name
and `‣` begins a word:

```
Obsidian/Characteristics/
  ∘ children.md
  ∘ domain.md
  ∘ relation to me.md
```

**The characteristic itself is not prefixed, and neither is the property.** The
note above is `∘ domain`; the characteristic is `domain`; the frontmatter on every
note that carries it says `domain:`. This is the whole point of keeping the prefix
in the file name only — a characteristic's name *is* the property key, so
prefixing the name would put `∘ domain:` in your notes.

Where the prefix does appear is a link: a class lists
`characteristics: "[[∘ domain]]"`, because that is the file. The panel shows
`domain`.

Update **renames any characteristic note that lacks the prefix**, through
Obsidian's own `renameFile`, so every `[[domain]]` pointing at it is rewritten by
Obsidian rather than by this plugin. The plan says how many links each one
affects, and repeats that the property is untouched.

Two notes reducing to the same characteristic — `domain.md` beside
`∘ domain.md`, a migration stopped halfway — is **reported as a conflict, never
renamed over**, because only one of them is ever used and renaming would destroy
the other.

Change the character in **Characteristic prefix**, or empty it to turn the
convention off. Changing it migrates cleanly: an existing symbol prefix is
replaced rather than stacked, so you never get `◈ ∘ domain`. Letters are safe from
that — a characteristic called `état` keeps its é.

`Characteristic Template.md` does the same thing for a note you create by hand,
with a Templater rename at the top. It renames whatever the title is at that
moment, so if you create the note as *Untitled* you will get `∘ Untitled` and
should rename it; characteristics created from the Update plan get the real name
straight away.

## How it works, in three steps

Everything below is one loop, run in this order.

**1. The picture.** Every note in `Notes` becomes an object in memory — *all* of
them, whether or not they are classes, down to a note with no frontmatter at all.
Each carries the roles it plays (class, instance) rather than one label, because a
note can be both at once.

Templates and characteristics are **not** objects: they describe the system rather
than being subjects of it. They still shape the picture — a characteristic's
`property type` and `possible values` are in it, and templates are what the plan
writes — and editing either still rebuilds it. The rebuild trigger is all three
folders; the object set is `Notes` alone.

**2. Discrepancies.** The picture is compared against what the model says should
be true. Everything that is not is a discrepancy, and there are two kinds:

- **solvable** — the plugin knows the fix and applies it on Update
- **insolvable** — it needs you; the plugin only names it

Both are listed in the panel under a ⚠ caution card, with counts.

**3. Update.** Your edits are written, and then the discrepancy handler settles
whatever those edits disturbed — repeatedly, until nothing solvable is left. A
fix can create work of its own (a new characteristic note then wants a
`property type`; a new class then wants a template), so it runs in passes rather
than once.

**Update is disabled while any insolvable discrepancy stands.** Solvable ones
never block — those are what Update is *for*. If one is insolvable and you mean
it to stay that way, **dismiss** it: it stays listed and stays true, but stops
blocking.

The same mechanism converges an edit you made by hand in a note, with no panel
involvement at all. "Correct" has one definition and one code path, whatever
caused the drift.

### What it will not decide for you

| | |
|---|---|
| `is a` naming a note that does not exist | listed — a typo and a missing class look identical, so neither is guessed at |
| `type of` naming a note that does not exist | listed. **It used to create it**, which turned a typo into a class |
| a class that is its own ancestor | listed — nothing can be inherited safely around a cycle |
| two classes differing only by case | listed — Obsidian cannot tell them apart |
| a value outside `possible values`, or of the wrong shape | listed — a value you typed is yours |

A class you create **in the panel** has no note yet either, and that is different:
you asked for it, so Update makes it.

## `possible values`

A characteristic note may say what its values are allowed to be. Three kinds,
told apart by how you write the entry:

```yaml
# a link to a class — the value must be a link to an instance of it
possible values: "[[Genre]]"

# words — the value must be one of them
possible values:
  - oil
  - ink

# an interval — the value must be a number inside it
possible values: "[0, 10]"
```

**A class means instances of it, through the whole chain.** `[[Genre]]` admits
`[[Rock]]` when Rock says `is a: "[[Genre]]"`, and equally admits `[[Blues]]`
when Blues is a `[[Subgenre]]` and Subgenre is a `type of` `[[Genre]]`. It is the
same walk [`file.isA()`](#in-base-queries) does, so a base and this check cannot
disagree about what counts as a Genre. The class itself is not one of its own
instances unless *A class is its own instance* is on.

A link to a note that is **not** a class stays an ordinary literal — the value
must be that note.

**Intervals use the bracket facing the number.** `[0, 10]` includes both ends;
`[1, 3[` is 1 up to but not including 3; `]0, 10]` excludes the 0. An empty side
or `inf` is unbounded: `[0, [`. A semicolon works as the separator too.

> **Quote a half-open interval.** `possible values: [0, 10]` is a YAML flow
> sequence — the brackets are gone before the plugin sees it, leaving the two
> numbers, which are read as a closed interval. That happens to be right for
> `[0, 10]`, and impossible for `[1, 3[`, which is not valid YAML at all. Written
> as `"[1, 3["` it survives intact.

**The kinds mix, and a value passes if any entry admits it** — which is what
"possible values" says:

```yaml
possible values:
  - "[[Location]]"
  - str
```

accepts a link to any instance of Location, or the word `str`. And on a
list-typed characteristic, one value may use both at once — `[[Brussels]]` *and*
`str` in the same property both pass, because every entry of the value is checked
against every entry of the constraint.

Nothing here is ever fixed for you. A value that fits none of them is reported as
a conflict naming the offender and what was expected:

```
Beige — not permitted by the possible values for genre (instances of Genre).
12 — not permitted by the possible values for rating ([0, 10]).
Techno (no such note) — not permitted by the possible values for genre (instances of Genre).
```

An empty `possible values` means "any value of the right shape", not "no values".
Shape is the separate `property type` check.

## In base queries

The same hierarchy answers questions inside any base. Four functions are added
to the Bases formula language:

```
file.isA("Person")           an instance of Person, through its class's chain
file.inheritsFrom("Person")  a subclass of Person, following `type of` only
file.ancestors()             everything above it by either relation, nearest first
file.isADistance("Person")   how many hops along the chain, or null
```

```yaml
filters:
  and:
    - file.isA("Person")
formulas:
  lineage: file.ancestors()
  depth: file.isADistance("Person")
```

`ancestors()` is a list, so it groups the way tags do; `isADistance()` is a
number, so it sorts.

**A note names only its direct parent.** `Sheng Lam` says `is a: "[[Artist]]"`
and nothing more; `file.isA("Person")` still finds it, because `Artist` is a
`type of` `Person` and the chain is walked at query time. This is what removes
the hand-maintained transitive closure — `is a: dog, mammal, animal` — that
`OOF 0.1` needed.

The two relations **compose in one direction only**: `x isA T` holds when
`x --is a--> C` and `C --type of--> … --> T`. So `is a` does not chain through
itself — a class-to-class link written as `is a` inherits nothing. Write it as
`type of`.

Parents may be wikilinks or bare text in the same property, aliases and headings
are handled (`[[Person|people]]`, `[[Person#Traits]]`), matching is
case-insensitive, and a parent with no note behind it still works as a name.
Cycles terminate.

*Is `Artist` itself an Artist?* By default no — a class is not one of its own
instances. **Bases → A class is its own instance** turns that on, at distance 0.

> These four were a separate plugin, **Bases Is A**, until 2026-08-17. They read
> the property names configured here, so there is nothing to keep in step.

## Editing costs you nothing

Panel edits are **kept as you make them**, in the plugin's own `data.json`.
There is no Save button to forget and no state where an edit exists only in
memory — close Obsidian mid-thought and it is all still there.

**None of it touches a note.** The only thing that writes to your vault is
**Update**.

- a header badge reads *pending* whenever there are edits the vault has not been
  told about
- **Discard** throws those edits away — again, no note is touched
- an edit that ends up matching your notes again stops being an edit, so the
  badge clears on its own

*Pending* is deliberately not *unsaved*: your edits are always saved. What they
are not yet is **applied**.

## Update is a preview, not a button that fires

Editing the panel changes nothing on disk. **Update** builds a plan, shows every
action and every conflict, and writes only once you confirm. Applying a plan
clears the drafts it came from.

**Every file in the plan explains itself.** Each entry gives the file, and under
it a line per thing that will change:

```
Update "Artist" — characteristics
Obsidian/Notes/Artist.md
  │ characteristics — domain, medium  →  domain

Update instance "Sheng Lam" (+2)
Obsidian/Notes/Sheng Lam.md
  │ Add, empty: medium, children — carried by Artist.

Create base for "Artist"
Obsidian/Bases/Artist Base.base
  │ Table of everything that is a Artist, templates excluded.
  │ Columns: file.name, domain, medium, children
  │ Created once — from then on it is yours, and Update leaves it alone.
```

An object property shows **before → after**; a property the note was missing
says so; a base refresh says in words that your edits will be lost.

Writes go through Obsidian's `processFrontMatter`, so **note bodies are never
touched** — only frontmatter.

### Data is never destroyed

When a characteristic is dropped from a class, existing instances still carry
that property. The rule:

- the property is **empty** → it is removed
- the property **holds a value** → it is left exactly as it is, and listed as a
  **conflict** for you to resolve

Properties with no characteristic note behind them — `cover image`, `tags`,
anything of your own — are never touched at all. That holds for **templates**
too: a `created: <% tp.date.now() %>` line in a template's frontmatter survives
a rewrite, because no characteristic note claims it.

## Settings

Folders (`Obsidian/Notes`, `Obsidian/Characteristics`, `Obsidian/Templates`),
the template suffix (` Template`), the **characteristic prefix** (`∘ `), the base
characteristics, the bases options above, and **A class is its own instance** for
the base functions.

## Not yet

- **`property type` and `possible values` are checked, never enforced** — a value
  that contradicts either is reported as a conflict and left alone, because a
  value you typed is yours. Generated properties are created empty; Obsidian's own
  `types.json` governs how they are displayed.
- **One argument per call.** `file.isA("Artist")`, not
  `file.isA("Artist", "Writer")`; `file.isA("a") or file.isA("b")` says the same
  thing.

Built by Claude.
