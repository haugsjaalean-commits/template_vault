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
| **characteristic** | `Obsidian/Characteristics/` | named `∘ <name>`; `characteristic meaning:`, `property type:`, `possible values:`, `default value:`, and a [defaults table](#the-defaults-table) in the body |
| **template** | `Obsidian/Templates/` | `is a: [[Class]]` + one key per characteristic |
| **instance** | anywhere | `is a: [[Class]]` + the same keys, filled in |

Person declares `children`, `location`, `relation to me`. Artist inherits from
Person and adds `domain`. So Artist's template carries **all four**. Producing
that flattening by hand is the chore this plugin removes.

Two rules:

- **Nothing is implicit** — unless you ask for it. By default no parent is ever
  added on your behalf, and a class inherits exactly what its own note says, so
  the files are the whole truth. Setting a **root class** trades that for brevity:
  see below.
- Parents are **`type of`** links, not `is a`. `is a` is instantiation, so an
  *instance* uses it to name its class; `type of` is subclassing, so a *class*
  uses it to name its parent. The panel, the generated bases and the
  [base functions](#in-base-queries) all draw that same line.

### A root class

**Its own template writes `is a` empty.** The root has nothing to point at — a
note made from its template is a root note without saying so, which is the whole
setting — but the key is still written. An absent property and an empty one look
nothing alike in the properties view, and the empty one is there to fill in with
something narrower the moment the note becomes more than a note.

**It reaches the notes folder only.** A note that names no class is one of the
root's without saying so anywhere — but only inside `Obsidian/Notes`. An entry
note or a readme living at the root of the vault is not swept in.

An explicit `is a` is a statement you made, and is honoured wherever you made it
— **except in the three folders that describe the system**: the templates, the
characteristics and the generated bases. A note filed with the bases is about
the bases. A template names its class and is regenerated rather than patched.
Nothing in those folders is ever treated as an instance.


**Root class** (settings, empty by default) names a class every note belongs to
without saying so. Everything is a root note and a type of one; **no link is
written anywhere**, which is the point — the boilerplate disappears rather than
being generated.

It reaches everything at once: the panel, generated templates, the instance pass,
and `file.isA()`. There is one function deciding what sits above a note, so a
generated base cannot disagree with the card beside it.

Two consequences worth knowing before you switch it on:

- **A note that names no class becomes one of the root's**, and gains what the
  root carries. That is the feature, but it means ordinary notes are touched.
- **Frontmatter stops explaining itself.** A class note showing an empty
  `type of:` still inherits. That is the price of the brevity, and it is why this
  is off by default.

Characteristic notes and templates are never swept up — they describe the system
rather than belonging to it.

### Entries that say nothing new

`is a` and `type of` are tidied on Update when an entry adds nothing:

| | example | why it goes |
|---|---|---|
| blank | `type of: [[Artist]], ` | an empty list item |
| repeated | `is a: [[Artist]], [[Artist]]` | named twice |
| implied | `is a: [[Artist]], Person` | Artist is a `type of` Person, so Person is already reached |

The last is safe for the same reason as the root links: **what is removed is still
true afterwards.** `file.isA("Person")` keeps answering yes, through the entry
that stays.

Two classes that reach *each other* — a cycle — are both kept, because there is no
saying which of them is the redundant one. Two unrelated classes are both kept
too; that is a note being two things at once, not a mistake.

**Existing links to the root are removed.** An `is a: "[[Obsidian Note]]"` written
before you set the root says exactly what the setting now says, so Update takes it
out — keeping any other entries in the same list. This is the only place a
property holding a value is rewritten rather than reported, and it is safe for a
narrow reason: the value being removed is the value the setting puts back.

**The root's own template writes no `is a`.** A note made from it is a root note
without saying so, so the line would be the very clutter the setting removes.
Every other template keeps its `is a` — that is what tells a new note which class
it belongs to.

**The root sits at the top of the panel**, above the alphabetical run rather than
inside it, badged *root* and outlined in the accent colour — it is what the list
hangs from, not one of the list.

### Two inheritances, not one

Both links carry characteristics, and they carry them to different places:

| | what it means | who ends up with the properties |
|---|---|---|
| `A is a B` | A **is** one of B's | **A itself** — A's frontmatter gains B's characteristics |
| `A type of B` | A is a kind of B | **instances of A** — they gain A's own *and* B's. A itself gains nothing |

A class card shows both, each under the row that causes it:

```
is a             Obsidian Note
  carries        related, note rating, rating, created   ← on this note
characteristics  test attribute
  inherited      —                                       ← for its instances
type of          —
```

A class note may legitimately have both links, and usually wants them: `is a`
gives the class note itself the properties every note has, and `type of` passes
them on to its instances. If one is set and the other is not, the card says so
underneath.

#### Or let `is a` hand them down too

**Instances inherit what their class carries** (settings, off by default) removes
the need for the second link. With it on, an instance also receives whatever its
class carries through its own `is a`, so a chain of `is a` passes characteristics
all the way down and `type of` becomes a statement of meaning rather than a
requirement.

Off is the stricter reading and the original one: `is a` gives properties to the
note that declares it and stops there. Switching it on changes what **every**
instance in the vault is expected to hold, so read the Update plan afterwards.

**The setting reaches `file.isA()` too.** With it on, that function follows the
`is a` chain as well, so a generated base contains exactly the notes the panel
says belong to the class. One hierarchy, one answer, wherever you ask.

`file.inheritsFrom()` is deliberately left strict — it asks "is this a *subclass*
of that?", which stays a different question however characteristics are handed
down.

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

### Or apply the class from the panel

Editing the frontmatter by hand is one way. The other is the **☑ apply** icon on
a class's row: it makes the note you currently have open an instance of that
class.

Because that writes into a note you were not necessarily thinking about, it asks
first — **yes or no, with the diff underneath**, produced by the same
`changePreview` the discrepancy view uses. So a yes is a yes to lines you have
read, not to a description of them:

```
      created: "2026-08-16 14:42"
      is a:
[-]     - "[[Artist]]"
[+]     - "[[Visual Artist]]"
      related:
[+]   medium:
[+]   visual domain:
[+]   art domain:
```

Above the diff it says what is being displaced (*It is currently an Artist. That
is replaced.*), what arrives, and what the old class leaves behind.

Three things it deliberately does **not** do:

- **It does not remove the old class's properties.** They stay, with their
  values, and the next Update decides — under the rules it already has, where an
  empty one goes and a populated one is a conflict you are asked about. One
  confirmation should not smuggle in another.
- **It does not overwrite a value.** A property the note already has keeps what
  is in it; only missing ones arrive, and they arrive empty.
- **It does not reorder the frontmatter.** Putting the keys in inheritance order
  would rewrite every line the note already had, and in a diff those moves look
  exactly like deletions — on a real note it turned a 3-line change into a
  15-line one. Order is Update's business.

It refuses, with a reason, when there is no note open, when the open note **is**
that class, and when the open note is a class at all — putting one class under
another is what `type of` is for, and writing `is a` between two classes is the
mistake the two-relations design exists to prevent.

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

## What nothing uses

With **Trash what nothing uses** on (the default), Update offers to clear out
three things: characteristic notes nothing refers to, and the template and base of
a class that no longer exists.

### A template whose name does not match its class

A class's template is found **by its name** — `<Class> Template.md` — and that is
the only link between the two. A template filed under any other name is invisible:
nothing finds it, a second one is generated beside it, and the two drift apart.

So a template that says `is a: "[[Art]]"` and is not called `Art Template.md` is a
discrepancy, and Update renames it. Through Obsidian's own rename, so links to it
are rewritten.

Two things it will not do:

- **A template that claims no class is left alone.** One with no `is a` is either
  yours or the root's, whose template writes none by design — and neither can be
  placed by guessing.
- **When the correct name is already taken**, nothing is renamed. Two templates
  claiming one class is reported instead, naming both: a class has exactly one
  template, so one of the two is not it, and choosing which is not the plugin's
  call.

### Renaming a characteristic

Rename `∘ domain.md` to `∘ field.md` and Obsidian rewrites the links. What it
cannot do is rename the **property**: every note still says `domain:` with its
value, under a name nothing declares any more.

So the rename is noticed as it happens and carried through on the next Update —
`domain:` becomes `field:` on every note and template that has it, value and all.

Nothing else can see this. Only the file system knows what `field` used to be
called, and by Update time the old note is gone, so the rename is written into
the plugin's settings the moment it happens and kept until no note carries the
old key. Renaming twice before an Update follows the chain rather than trying
each hop.

A note that has **both** keys with values is reported instead: which one is real
is yours to say.

#### A rename it never saw

That only works for a rename the plugin is running to witness. One made while it
was off leaves a key on your notes that nothing declares — and the plugin cannot
know what it became.

So it asks. A key carried by **two or more** notes with nothing declaring it is
reported as **one** discrepancy — `"lifespan" — on 69 notes, declared by nothing`
— with a button that lets you say what it turned into. Answering records the same
kind of rename, and Update carries every note across.

Where the values give it away, the answer is suggested: `lifespan` holding
`current` and `legacy` against a `life stage` that allows `current, dated,
legacy` is a match, and against a `maturity` that allows four other things is
not. No overlap, no suggestion — you are the one who knows.

**One note carrying such a key is an anomaly, not a rename**, and stays reported
as itself, naming the note and the class. Two or more is a shape.

While the question is open, the **empty** copies are left alone. They would
otherwise be swept away as unaccounted-for, destroying most of the evidence
before you had answered — thirty of the sixty-nine, in the case above.

### The prefix is a characteristic's

`∘` starts the name of a characteristic and nothing else. A class is never
created carrying it — not from the panel, not by renaming — and a characteristic
named where a class belongs, `type of: "[[∘ shelf]]"`, is **reported** rather
than taken at face value.

It used to be taken at face value: a `∘ shelf` card appeared in the panel and
Update offered to generate `∘ shelf Template.md` and `∘ shelf Base.base` beside
it. The characteristic it names is also protected from trash collection while
the conflict stands — being told to fix a mistake and having the thing it refers
to deleted is the worst of both.

### Orphaned templates and bases

Renaming a class moves all three of its files, so these only appear when a class
note is **deleted by hand** — and then they sit there for ever.

**A filename is not evidence.** `Characteristic Template.md` and `Base Base.base`
match the naming exactly and are nothing to do with any class. So a file is only
taken when it also *looks generated*:

| | must also |
|---|---|
| `<Class> Template.md` | carry `is a: "[[<Class>]]"` |
| `<Class> Base.base` | filter on `file.isA("<Class>")` |

Your own files do neither, and are left alone.

### Unused characteristics

A characteristic note is cleared out once nothing refers to it any more.

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

## All notes carry the base characteristics

By default a note that is not a class carries a base characteristic **only when
it has something to say with it** — an instance has `is a`, and a blank `type of`
or `characteristics` is cleared out on Update.

**Settings → All notes carry the base characteristics** inverts that: every note
gets every one of them, empty or not, and nothing is cleared. Generated templates
write them too, so a new note is born in step rather than being corrected the
moment it exists.

"Base characteristic" means the logic properties — `is a`, `type of`,
`characteristics` — plus any characteristic note flagged
`is base characteristic: true`.

`is a` still leads. It and the others are one band and one heading, but within it
the alphabet would put `characteristics` first, and the line saying what the note
*is* should be the one you read first.

Turning it back off is safe and symmetric: the empty ones are cleared out again
on the next Update, and any that hold a value are left alone — the same rule as
everywhere else.

## Property order

Properties are always laid out **by property type first, then alphabetically**,
whatever order they were added in the panel. `property type` comes from each
characteristic note; anything with no type known sorts last.

> **If a property looks out of place, check its characteristic note.** A blank
> `property type` means "unknown", and unknown sorts after everything else — so
> the property lands at the bottom rather than with its own kind. Update now
> fills in `property type: list` for the base characteristics, and says so in
> the plan, but an ordinary characteristic's type is yours to set.

### Or group by the class it came from

**Settings → Properties → Property order** switches the layout to *Grouped by the
class it came from*. Each class's characteristics then sit together, the nearest
class first, and inside each group the old type-then-name rule still decides.

A `Visual Artist` template, both ways:

```yaml
# by property type              # grouped by class
birth day:                      is a:
death day:                      art domain:      ─┐
art domain:                     medium:           │ Visual Artist
children:                       visual domain:   ─┘
is a:                           birth day:       ─┐
medium:                         death day:        │
relation to me:                 children:         │ Person
visual domain:                  relation to me:   │
location:                       location:        ─┘
```

Two things fall out of grouping that are worth knowing:

- **`is a` and `type of` lead the note.** They are base characteristics — no
  class declares them — so they get a group of their own at the top. In flat
  order they are sorted like anything else, and `is a` lands wherever the
  alphabet puts it among the other lists, which on a real note is usually the
  middle.
- **A characteristic two classes both declare is credited to the nearer one**,
  which is the class you would name if asked where it came from.

Anything managed that no class in the chain declares trails at the end.

**Changing this setting rewrites the property order of every note**, since order
is part of being in step. The next Update plan shows it as an ordinary reorder,
file by file, before anything is written.

#### The headings you see are drawn, not written

With grouping on, the properties panel gains a heading over each group:

```
is a                    ← base characteristics, no heading
── PERSON ──
birth day
death day
children
── NOT FROM A CLASS ──
garden
lifespan
```

**None of that is in the file.** Frontmatter keeps no comments and no blank
lines — Obsidian re-emits the block from a parsed object every time a property
is touched, so a heading written there would have to be a real property, and
would then be a real property for ever: in the panel, in every base, in the
count. Drawing it over the panel costs the file nothing and cannot decay.

The sections run **general to specific**, top to bottom:

```
Native attributes            fields Obsidian owns
Base characteristics         what the note is
Not from a class             a characteristic nothing accounts for
Obsidian Note characteristics   ← the root, the most general class
Person characteristics
Artist characteristics
Visual Artist characteristics   ← the class the note actually claims
```

Reading down the panel is reading down the hierarchy: what every note has, then
what every Person has, then what only a Visual Artist has. The **root comes
before every other class**, whatever its distance — it is reachable from
anywhere, so measuring by distance put it in the middle, and it is placed
instead.

Every row sits under a heading. Three of them do not name a class:

| heading | what is under it |
|---|---|
| **&lt;Class&gt; characteristics** | what that class hands down — `Person characteristics`, `Obsidian Note characteristics` |
| **Base characteristics** | `is a`, `type of`, `characteristics` — and anything a characteristic note flags with `is base characteristic: true` |
| **Not from a class** | a real characteristic that no class in the chain, and no root, hands down |
| **Native attributes** | a field Obsidian itself owns — `tags`, `aliases`, anything with no characteristic note |

The last two are deliberately not synonyms. *Not from a class* is a question
about the hierarchy — usually a property whose class was changed, or one that
predates it. *Native attributes* is not a question at all: those fields belong to
Obsidian, and the class system has no opinion about them.

One thing is left undecorated: **a note with nothing but native attributes**. A
single heading over the whole of a journal entry is not information, and the
section exists to separate those fields *from* the class ones, which needs there
to be some.

**Class notes are decorated too.** A class says what its instances carry through
`characteristics` and `type of`, and normally leaves its own `is a` empty — but
the class note is still a note with properties of its own.

**The root class counts.** When a root is set, every note is one implicitly and
writes no link saying so, so the headings ask `rootAbove()` as well as reading
`is a`. Without that a root class could never be named, and its characteristics
would be reported as belonging to nothing.

So *Not from a class* means what it says: no class, no ancestor and no root
accounts for that property. On a class note it usually means either the class
note should say what **it** is an instance of, or that the class those
properties come from should be your root.

The headings are restored whenever Obsidian rebuilds the panel, which it does
each time you edit a property.

#### Folding a group away

Click a heading — anywhere on it, not just the chevron — and its properties fold
away, with a count of what is hidden:

```
is a
▾ PERSON
  birth day
  death day
  children
▸ OBSIDIAN NOTE   6
```

All of them fold like any other group.

**Settings → Name class sections after their characteristics** switches the class
headings between *Person characteristics* and plain *Person*. It changes the
wording only: a folded section is remembered by the class name either way, so
switching it never unfolds anything.

**Folding is by class, not by note.** A group is folded because that whole class
is boilerplate you would rather not look at — the root's housekeeping properties,
usually — and wanting that on one note means wanting it on all of them. So it
applies everywhere at once, in every open pane, and is remembered across
restarts.

It is a view and nothing else: the file is untouched, and a folded property is
still there, still written, still in every base.

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

Classes are listed **alphabetically**, all of them together, in one run from A to
Z. Switch *Order in the panel* to **By descent** to group them by generation
instead — everything a class descends from above it, alphabetically within each
generation, so `Person` and `Zebra` come first, then `Artist`, then `Aardvark`.

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

### The tree

There are two drawings of it, and they differ in what the horizontal space is
spent on.

**A tree** — *classes aligned, connexions drawn out*. Every node in one column
beside the cards, so the names line up and the dots line up. A child directly
below its parent is joined by a plain vertical; anything else is a **bracket**:
out from the parent, down a lane, and back in at the child. The lanes carry only
the detours, so the width is the number of connexions that have to overtake each
other rather than the depth of the hierarchy. Brackets nest — the shortest reach
innermost, the longest furthest out.

**A graph** — *a lane per branch, like a commit graph*. A lane belongs to a class
and holds it for as long as it has descendants, so the node's position tells you
which branch it is on.

**The ⑂ button on the title row**, beside unfold-all and fold-all, steps round the
three. It shows the icon of the one you will get next, is accented while either
drawing is on, and is greyed out while you are searching — a filtered tree has holes in it, so the panel falls
back to the list.

The same choice is **Settings → Class layout**, beside *Order in the panel*.
Choosing the tree hides that sort, since the tree is the order.

The tree draws the classes as a git graph: one class per row, rails in lanes to
the left, and a node on the lane the class sits in.

```
●  Obsidian Note
├● Art
│├● Location
││● Person
││● Artist
││● Visual Artist
│││● Project
│││● Issue
●││ Obsidian Plugin
    ● Todo
```

Four things it does:

- **Only `type of`.** Subclassing is the tree. `is a` is instantiation, and
  drawing it here would be a different picture entirely.
- **One class per row**, which is what stops two nodes ever sharing a horizontal
  position.
- **A parent is always drawn above its child** — including a class with two
  parents, which waits until both are above it and then hangs from the second.
  Its **other** parent is a wire of its own: out of that parent's node, down a
  lane, and back in at the child — dashed by default, so it is obvious which of
  the two the rows are ordered by, and solid if you would rather they looked
  alike.
- **The root class is above everything**, drawn as an edge even though no note
  contains it. That is what a root is, and without it a vault whose classes name
  no parent comes out as a row of separate trees.

### Wires that cross

A class that is a `type of` two classes has two edges, and only one of them can
be the descent the drawing is built around. The other is routed as a wire in a
lane of its own — **a band outside the class lanes**, so adding one never moves a
node: the classes keep their lanes and their distance from the cards, and the
drawing only grows at the outer edge.

**As many lanes as there are wires that have to overtake each other**, and no
more. Two wires whose spans do not overlap share a lane; two that do get one
each. Shortest first, so a short wire ends up inside the ones that contain it
rather than crossing them.

**Where two wires cross, one gives way.** The vertical is drawn straight through
and the horizontal is cut either side of it, the way a wiring diagram has always
said "these two do not touch". The horizontal is the one cut, which falls the
right way round on its own: a second-parent wire is horizontal for the whole of
its detour out and back, so it is the wire doing nearly all of the crossing and
nearly all of the giving way.

This applies to the bracket drawing too, where every edge is already a wire in a
lane — the brackets used to run straight through each other. And the bracket
drawing **shows second parents at all** now; until this it drew only the descent,
which meant a class could be a `type of` two things and the picture said one.

**Settings - A row with more in it than fits** decides what a card does when a
row holds more than the panel is wide. It covers **both** rows of a card: the
chips, and the card's own top line — the name, the symbol, the rating, the badges
and the file icons.

**No item is ever squeezed under any of the four.** A badge reading `IS` over `A`
is the row breaking a word, and a name cut to four letters is the row deleting
one; neither is an answer. What the settings differ on is where the extra room
comes from.

**Each row scrolls on its own** (the default) turns one row sideways under the
wheel and leaves the rest of the panel where it is.

**One bar at the bottom scrolls everything** keeps every row on one line and
widens the panel instead, so a single horizontal scrollbar at the bottom moves
the lot. Everything stays lined up, which is the case for it: you read across the
cards together rather than scrolling each row into place.

**The chips wrap; the card widens for the top line** lets the chips take as many
lines as they need, so the card comes out only as wide as its top line.

**Everything wraps to fit the panel** takes no room at all. The top line wraps
too — **between its items, never inside one**, which is the distinction that
makes it work: a badge moved whole onto a second line is the row breaking where
it is allowed to. Nothing is ever wider than the panel and there is no sideways
scrolling anywhere. The only thing that can still give way is a class name longer
than the panel, which keeps its ellipsis as a last resort rather than push the
card past the edge.

Measured on three cards of six characteristics each, in a 300px sidebar:

| | card | panel scroll | top line | chips | height |
|---|---|---|---|---|---|
| each row on its own | 276px | none | 1 line | 1 line | 340px |
| one bar at the bottom | 602px | 379px | 1 line | 1 line | 376px |
| chips wrap, card widens | 420px | 197px | 1 line | 2 lines | 478px |
| everything wraps to fit | fits | **none** | 2-3 lines | 4-5 lines | 670px |

The last one is the tallest and the only one you never have to scroll — in the
tree drawing its top line comes out as `name + pencil + rating`, then
`active note + is a`, then the file icons.

**Only the classes are ever wider than the panel, and only the classes move.**
The header, the discrepancies and the base characteristics stay at the pane's
width and stay where they are while the class cards scroll under them. They are
prose and controls — there is nothing in them to read sideways, widening them
only cut their sentences off at the pane edge, and sliding the discrepancies out
of the way to read a class is worse than useless, since the discrepancies are the
reason you are looking at the classes.

Two other details are shared by the two settings that widen. The bar is the
panel's own scroll container, because that is the only element whose box is the
part you are looking at — anywhere else it would sit at the bottom of a stack of
cards several screens tall. And the cards come out **one width**, so the edge is
not ragged.

Those three blocks are held still by the view rather than by `position: sticky`,
and the reason is worth writing down. A sticky element is held within its
containing block, so the room it has to resist scrolling with is
`wrapperWidth - itsOwnWidth`, while the distance it must resist is
`scrollWidth - paneWidth`. Those agree only while nothing **outside** the wrapper
carries side padding — and what carries side padding is the pane, whose rules a
theme is entitled to outbid. The failure mode is the worst kind: the blocks hold
for most of the scroll and slip the last few pixels, which reads as a bug rather
than as a choice, and cannot be seen at all in a harness with no theme loaded.
Cancelling the scroll offset with a transform needs no arithmetic and no
assumption about anyone else's padding.

**Settings - The wire to a second parent** draws it dashed or solid. Dashed is
the default and tells the two parentages apart at a glance. Solid draws them
alike, which is arguably the truer reading: both are ordinary `type of`, and
which one the rows are ordered by is decided by the drawing rather than by
anything in the vault. Either way it is the wire that gives way where two cross —
that is about which line is easier to follow, not about which parent matters.

**Everything the class inherits from is lit** for the class you are reading — up
every wire leading to it, through both parents of a class that has two and their
parents in turn, out to the roots. The class the note belongs to is a filled
node; everything above it is a ringed one, so the highlight reads as one run
while still saying where the note actually sits.

**Settings - How far the highlight reaches** turns that down to *only the line it
descends from*: the single chain the rows are ordered by, which is one path even
where the class has more than one parent. That was the behaviour before there
were wires to follow, and it is quieter on a hierarchy where nearly everything
has two parents. Either way the wire arriving at the highlighted class is lit —
an edge landing on that node is part of what the highlight is saying.

**Hovering a class lights the same thing**, in a tint of the accent
rather than the accent — same run, same filled node and ringed ancestors, half
the weight. Point at any class and you can read where it hangs from without
opening it. The tint is the point: the line for the note you are *reading* has to
stay the one bright thing in the drawing, or a pointer wandering across the panel
would keep overwriting the one highlight that says where you actually are. Where
the two paths overlap the bright one wins.

**Settings → How a connexion turns** bends a connexion in a curve or in a right
angle. Rounded is the default. A turn is its own piece — a box with two borders
and a radius on the corner between them, which is exactly a quarter arc — so the
straights stay straight and only the bend is curved.

**Settings → Inside a node** leaves a node empty, so it reads as a ring — the
lines stop at the circle rather than running under it, or fills it with the panel colour so it sits over the line.
Empty is the default. **The root empties with the rest**: it is drawn in the
accent and ringed in it, and the ring is what says it is the root — so an accent
ring with the line running through it reads as the root perfectly well, and one
node quietly ignoring a setting called *Empty* read as a bug.

**A class with two parents empties too.** Its node used to be filled grey,
because back when a second parentage was a stub that did not reach — and in the
bracket drawing was not drawn at all — the fill was standing in for a missing
line. The line exists now, so the fill said the same thing twice, in the one
language the node already uses for something else: filled means *the class you
are reading*. On a hierarchy where several classes have two parents it read as a
scattering of highlights that were not highlights.

So only two nodes stay filled either way — the class you are reading and the
class under the pointer. For those the fill is the whole of the mark.

**Settings → Nodes that are not highlighted** draws a node in the colour of the
lines, so the graph reads as one drawing, or a shade darker so each class stands
out on its own. The lines' colour is the default: a node louder than the line
running into it competes with the highlight, which is the only thing in the panel
that should be shouting.

**Settings → Which side the tree runs down** puts the rails to the right of the
classes instead of the left. Left is how a commit graph is drawn; right suits the
sidebar the panel usually lives in — the lines sit against the window edge, and
the name is the first thing you read. The root stays the outermost lane either
way, so the graph mirrors rather than turning inside out.

The tree **is** the order, so the sort setting has nothing to say while it is on.
Searching falls back to the list, because a filtered tree has holes in it and the
rails would run to classes that are not there.

Collapsed, a class is the same one-line stub it is in the list; expanded, it is
the same card. The rails run the full height of a row whatever is in it.

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

**Tab takes the first suggestion**, the way a shell or an editor does. Type
`rel`, press Tab, get `related` with the completed part selected — so typing on
replaces it rather than appending. Tab again, with nothing left to add, moves
focus like an ordinary Tab. Enter adds whatever is in the box.

The list is re-ordered as you type — things that *start* with what you typed
first, then things that merely contain it — and Tab always takes the entry at the
top of the list you are looking at, because both read the same ordering.

**Adding several in a row stays where you are.** Every edit rebuilds the panel,
which used to throw the list back to the top and drop the caret. The scroll
position and the focused box are carried across the rebuild, and the box is
cleared as the chip appears — so you can type, Enter, type, Enter without touching
the mouse. Escape empties the box and steps out of it.

### A symbol per class

A class can carry a mark, and it shows in the two places a class appears:

```
▾ ◆ Person          +6
    ◆ Artist        +2      ← inherited, drawn faintly
      ▲ Visual Artist  +2   ← its own
```

and over that class's section in the properties view:

```
── ▲ Visual Artist characteristics ──
```

It lives in the class note's own `symbol:` property, and it is **inherited,
nearest first** — the same walk as characteristics and defaults. Marking `Person`
marks everything below it; a subclass overrides by setting its own. That is what
makes one symbol worth typing, and why an inherited one is drawn faint: the mark
is true of all of them, but only one of them said it.

**Set it from the pencil beside the class name** — see below.

Like every other edit here it goes through **Update**: the plan says
`symbol — empty → ◆` before anything is written. Clearing one empties the property
rather than removing it, for the same reason the root's `is a` is written empty —
an absent property and an empty one look nothing alike in the properties view.

### Setting one: the pencil's menu

The **pencil** beside a class name opens a menu:

```
✎ Rename…
◈ Change symbol…
✕ Remove symbol
```

Both change what the class is *called* — by name, or by mark — which is why they
share a button rather than costing the row another icon. That row is full; a
symbol button of its own is what squeezed the class name to nothing the first
time round.

**Change symbol…** opens the picker, with three tabs:

| tab | what |
|---|---|
| **Symbols** | 60 typographic marks — the default, and the ask |
| **Icons** | every Lucide icon Obsidian ships — all of them, searchable by name |
| **Emoji** | a broad set, grouped and searchable by word |

It opens on whichever tab the current symbol came from, and choosing the one
already set removes it — the same click, undone.

**The Icons tab is the Notion-looking one.** Obsidian bundles Lucide, which is the
flat outline set Notion's icons are drawn from, and `getIconIds()` hands over
every one at runtime — so nothing is shipped as artwork and nothing is embedded as
a list, and the names come with them, which is what makes a thousand icons
searchable. An icon is stored as `lucide:heart`: still a plain string in the
frontmatter, still one value, and every place that draws a symbol goes through one
painter, so a class marked with an icon behaves exactly like one marked with a
character.

**All of them, unsearched, and grouped by what they mean** — Faces & people,
Animals, Nature & weather, Food & drink, Places & travel, Study & making, Play &
sport, Body & care, Things & money, Marks & signs, then *Everything else*. The
emoji categories, filled with Lucide.

Alphabetical is the worst order for browsing an icon set: `smile` sits between
`slash` and `snail`, and the one you would have chosen is fifty screens from the
one you thought of. Nothing is hidden — an icon no group claims is still there,
under a heading that says so. Measured: 1,500 cells build and lay out in **29ms**,
so there was nothing to protect.

**Search reads meanings, not just names.** "happy" finds `smile`, "love" finds
`heart`, "idea" finds `lightbulb`, "launch" finds `rocket`, "pet" finds `cat`.
Lucide keeps those words in its own metadata and Obsidian does not expose them, so
the ones worth having ship with the plugin.

### Symbols and emoji

Nothing is converted. A symbol is drawn exactly as it is stored: a typographic
mark from the Symbols tab is flat because Unicode says that character is flat, and
an emoji from the Emoji tab is an emoji because it is stored as one.

There was a **How symbols are drawn** setting here, and it was a mistake. It
appended a variation selector to every symbol, and *Symbols* — the default —
appended the **text** one, which flattens any emoji that has a text form. Measured
at 16px:

| | drawn bare | forced to text |
|---|---|---|
| ❤ ☀ ✏ ✂ ⚙ | 13.5–16px | same, and flat |
| ❤ as an emoji | **22px** | 15.5px |
| 🚀 | **22px** | **16px** — flattened as well |

So picking a heart gave an outline, and even a rocket lost its colour. The setting
is gone. **Presentation belongs to the value**: the Emoji tab stores its picks with
U+FE0F, so they are emoji wherever they appear and for ever, with nothing having to
remember why. The Symbols tab stores bare characters, which Unicode already draws
flat.

The property holds **one grapheme** — a variation selector is part of that
grapheme, so it survives being read back. A word pasted in is still cut to its
first character.

Rename the property with **Settings → Symbol property**, or empty it to turn the
whole convention off.

### What the `+N` says

Every class is rated by **how much new metadata it adds** — a number beside its
name, and the busiest thing about it is how often it turns out to be zero:

```
▸ Obsidian Note   +8
▸ Person          +6
▸ Visual Artist   +2
▸ Style           +0
```

**New means new to the chain, not new to the note.** A class that lists
`children` when `Person` above it already declares `children` has added nothing —
an instance carries it either way — so the badge counts only what no ancestor
already declares. Counting the `characteristics:` list as written would credit a
class for work it did not do, which is the opposite of the question being asked.

A redeclaration is not an error, so it is not reported as one; the number is
underlined and the tooltip names it.

**`+0` is worth seeing.** It means the class adds no metadata of its own — it
exists to *narrow* what its parent already says, which is a real thing to want
(`Obsidian Plugin` is a kind of `Project` and nothing more) and equally the shape
a class takes when it is redundant. The badge does not decide which; it just
stops the question being invisible.

Base characteristics are left out. `is a`, `characteristics` and `type of` are how
the system talks about itself, and every class has them, so they say nothing about
any one class.

Hovering gives the whole of it:

```
Artist adds 2 characteristics that nothing above it declares: domain, medium.
An instance carries 4 in all.
```

The number follows the **panel**, not the files — add a characteristic to a class
and it moves before Update writes anything.

Turn it off with **Settings → Rate each class by what it adds**.

### The icons on the row

Everything a class has or does, on the one line — these used to be a row of words
underneath it.

| | what |
|---|---|
| **✎** pencil, beside the name | renames the class — see below |
| **📄** note | opens the class note |
| **▤** template | opens `<Class> Template.md` |
| **▦** base | opens `<Class> Base.base` |
| **⟳** reset | queues that base to be regenerated, losing your edits — asks for a typed code |
| **☑** apply | makes the note you have open an instance of this class — asks yes or no |
| **＋** new note, ending the row | creates an instance from the template |

Three of them **open** a file, and they are grouped together for that reason.
Rename **changes** a file, so it stays beside the name it acts on; apply and
new-instance are the same act from either end — one makes an instance of the note
you have, the other makes a note that is an instance — so they sit together and
end the row.

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

Each class with a base has a **⟳ reset** icon on its row. It is the one control
in the panel that destroys work nothing else holds a copy of — the views, sorts,
group-bys and filters you built on a base by hand.

**It asks for a typed code.** A five-character code is shown; the confirm button
stays dead until you type it. The code is random rather than the class's own name
on purpose: you have typed "Artist" a hundred times and would type it again
without reading, while five characters you have never seen cannot be entered
without reading the sentence above them. No `0`/`O` or `1`/`I`/`L` appear in it.

Cancelling a queued reset needs no code — that is the safe direction, and a gate
in front of the way out would be safety theatre.

Clicking it queues that base to be regenerated: it appears in the next Update plan as *"Rewrite base for
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

Every entry has a **see the change** button. For a solvable one it shows the
file's frontmatter line by line, with what will go marked `-` and what will
arrive marked `+`, before anything is written. For one that needs you, it shows
the file as it stands with the line at issue marked `!`.

The diff is produced by running the very function that will do the writing against
a copy of the frontmatter — so it cannot describe something other than what Update
does.

A changed line with nothing visible in it — `  - `, a list entry that is present
but empty — is the commonest thing a tidy removes, and colouring an empty line
red still shows you nothing. So the whole row is tinted and struck through, and
the line says **(an empty entry)** in words. A wholly blank line says
**(a blank line)**.

**3. Update.** Your edits are written, and then the discrepancy handler settles
whatever those edits disturbed — repeatedly, until nothing solvable is left. A
fix can create work of its own (a new characteristic note then wants a
`property type`; a new class then wants a template), so it runs in passes rather
than once.

**Update is disabled while any insolvable discrepancy stands.** Solvable ones
never block — those are what Update is *for*. If one is insolvable and you mean
it to stay that way, **dismiss** it: it stays listed and stays true, but stops
blocking.

It is also disabled, the same faded way **Discard** is with no pending edits, when
there is simply nothing to do — the vault already matches the panel. Hovering
either state says which it is.

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
| a value that disagrees with a **strict default** | listed, unless *Strict defaults also override differing values* is on |
| a defaults row giving both a default and a different strict default | listed — the strict one would be written and the other never used |

A class you create **in the panel** has no note yet either, and that is different:
you asked for it, so Update makes it.

## `default value`

What a generated template should put in this property, written **verbatim** — so a
Templater expression reaches the template intact and renders when a note is made
from it:

```yaml
# ∘ created.md
property type: datetime
default value: <% tp.date.now("YYYY-MM-DD HH:mm") %>
```

Every template that carries `created` then gets that line, and every note made
from one gets a real timestamp.

- **Templates only.** An instance gains the key *empty*; the value arrives from
  Templater at creation. Writing the expression into a note would leave the text
  sitting there unrendered.
- **Notes that missed it are filled in.** A note written before the characteristic
  existed has an empty `created:` that Templater will never fill. Update fills it
  **from the file's own creation time** — never from the clock, because the point
  is to recover a fact rather than to claim every old note was made today. Only
  empty ones; a date you wrote yourself is yours. Date and datetime
  characteristics only, and only where the default is a Templater expression.
- **Checked, not just written.** A template whose value has drifted from the
  characteristic is brought back into line on Update, the same as a missing key.
- Leave it empty and the template gets an empty key, as before.
- **Per class, use the [defaults table](#the-defaults-table) below.** This key is
  the same claim about every note that carries the characteristic, and it is read
  last — the table's *All notes* row is what replaces it.

> This is also the answer to a subtler problem. A property with **no**
> characteristic note is left alone in templates — that is what protected a
> hand-written `created: <% … %>` line. The moment `created` became a
> characteristic it turned into a *managed* key, and managed keys are cleared and
> rewritten. `default value` is where that expression belongs once the system
> knows about the property.

## The defaults table

`default value` says one thing for every note that carries the characteristic.
The **defaults table** says it per class — *every visual artist has
`domain: visual`* — and it lives in the body of the characteristic's own note:

```markdown
| Default location  | Default value | Strict default value |
| ----------------- | ------------- | -------------------- |
| All notes         |               |                      |
| [[Artist]]        | art           |                      |
| [[Visual Artist]] |               | visual               |
```

A row per class, plus *All notes*. Add as many as you like.

**Why here and not in the template.** A template is the *flattening* — `Artist
Template.md` and `Visual Artist Template.md` both carry `domain:`, so a value in
the second says nothing about whether Visual Artist declared it or inherited it,
and a plugin that cannot tell those apart either destroys your edit when the
parent changes or silently stops inheriting. The same defect `is a: dog, mammal,
animal` had in `OOF 0.1`. A row exists or it does not.

The class note still tells you: the location is a **link**, so `Visual Artist`'s
backlinks show the row that names it, value and all.

### The two columns are not the same claim

| | |
|---|---|
| **Default value** | what a note is **created** with. The template carries it; from then on the value is the note's own, and nothing here ever touches it again |
| **Strict default value** | a standing claim about every instance. An empty value is **never accepted** while one stands — Update fills it, retroactively, for ever |

That is the whole difference, and it is what *"if a characteristic has a default
value, then NONE is never accepted"* means once it is written down: it is the
strict column that is total.

A value that is neither empty nor the strict one is a third case, and it is a
setting. **Off** — the default — it is *reported*, because a value you typed is
yours everywhere else in this plugin:

```
Otto Vance · domain
The defaults table for domain gives an instance of Visual Artist the strict
value visual, and this holds sculpture. Left untouched — change it, change the
row, or turn on Strict defaults also override differing values.
```

**On**, it is replaced, and the plan shows `sculpture → visual` before anything
is written.

### Inheritance

The walk is the one `characteristics` already does: **the class, then its
ancestors nearest first**. A class with no row of its own uses its parent's; a
child that declares one wins over everything above it. Two parents at the same
distance are met in the order the class names them.

*All notes* is the weakest row, and the `default value:` in frontmatter is behind
even that — it is what the *All notes* row replaces, kept working so nothing has
to be migrated. Three of the characteristics in this vault use it today and go on
behaving exactly as they did.

Only the classes that **carry** the characteristic are reached. A row naming a
class that never declares `domain` does nothing.

### What is written

The strict value if there is one, otherwise the default. A row that gives **both**,
differing, is reported rather than guessed at: the strict one would be written and
the other would be visibly ignored for ever.

Cells are text, and the value is coerced to the characteristic's `property type` on
the way out — `12` into a number property is the number, `a, b` into a list is two
entries, and a comma inside `[[Paris, France]]` does not split it. A Templater
expression is left as text, because it is machinery: it reaches the template intact
and renders at creation. A **strict** default written as one is not enforced on
existing notes — there is nothing to enforce, and `fill-datetime` is what recovers
those from the file's own creation time.

### The table is an input

It is read, never rewritten. Editing a row is editing a note, the same as
`property type` and `possible values` above it.

**Every characteristic note carries one.** A note created by Update is created
with it; a note that has none gets one appended, listed in the plan like anything
else. That is the only thing in this plugin that writes into a body at all, and it
is narrowed until it cannot lose anything:

- **appended, never merged.** The whole write is *what is there* + *the table*.
  Nothing already written is read, moved or removed
- **once.** A note that already has a table is left alone, whatever is in it
- **switchable.** Turn **Settings → Every characteristic note carries the table**
  off and existing notes are left as they are; only the ones Update creates carry
  one

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
anything of your own — are never touched on an ordinary note.

**Templates are the exception, and deliberately so.** A template is not a note
about something; it is the *shape* of one, and its shape is its class's to decide.
So a key in a template that no characteristic claims does not belong there:

| in a template | what happens |
|---|---|
| a Templater expression — any value containing `<%` | left alone, never reported. It is machinery, not data |
| a key nothing claims, **empty** | removed on Update, and the plan names it |
| a key nothing claims, **holding a value** | reported as a conflict, left untouched |
| a value that breaks its characteristic's `property type` or `possible values` | reported — a default in a template reaches every instance made from it |

That is why `created: <% tp.date.now() %>` survives while `poopoo:` does not.

### And the same on ordinary notes

A note is what its class says it is, so a field its class does not declare is
reported there too — same split: empty is removed, populated is reported and left
alone.

**Native attributes** are the properties the class system has no opinion about.
Nothing in one is ever flagged, and they are grouped under that heading in the
properties view. **Settings → Native attributes** is the list:

```
tags, aliases, cssclasses, cssclass, publish, permalink, cover image
```

Obsidian owns the first six. `cover image` is his (2026-08-24) — the first entry
that is a decision rather than a fact, and exactly the decision this setting
exists for: under this model a property every Artist carries *is* a
characteristic of Artist, and he has said this one is not.

**Everything else is reported, `created` included.** A timestamp your template
wrote is still a property your class does not declare, and the model says what to
do about it: declare it. Adding `created` to the root class settles every note
that inherits from it at once. Silencing it would be hiding an incomplete model
rather than a nuisance.

The same goes for fields of your own — under this model, a property every Artist
carries **is** a characteristic of Artist. If you disagree in a particular case,
add it to **Native attributes**, which is what `cover image` is doing there.

> A class note is not an instance of anything unless it says so, so it inherits
> nothing — which means a `created:` on a *class* note is reported even after the
> class declares `created` for its instances. Give the class an
> `is a: "[[Note]]"` if you want it to carry what its own notes carry.

## The "Add property" button

**Settings → Hide the "Add property" button** takes it out of the properties
panel. What replaces it is a command — **OOF Classes: Add a property to the open
note** — which you bind to whatever key you like in Settings → Hotkeys.

The command **presses Obsidian's own button** rather than reimplementing what it
does. Adding a property is Obsidian's business, and a second implementation would
be one more thing to keep in step with its properties UI. So the button is hidden
rather than removed, and briefly made real again for the press itself, in case
anything positions itself against it.

No default hotkey is claimed. Every combination worth having is already yours,
and silently taking one would be worse than asking. Because of that, hiding the
button without binding the key would leave you with **neither** — so the settings
tab says which key it is bound to, and warns in orange when it is bound to
nothing.

## Settings

Folders (`Obsidian/Notes`, `Obsidian/Characteristics`, `Obsidian/Templates`),
the template suffix (` Template`), the **characteristic prefix** (`∘ `), the base
characteristics, the bases options above, and **A class is its own instance** for
the base functions.

**Symbol property** for the mark before a class name; **Rate each class by what it adds** for the `+N` after it.

Two for the [defaults table](#the-defaults-table): **Strict defaults also override
differing values**, and **Every characteristic note carries the table** — the only
setting in the plugin that leads to a note's body being written, and the only
reason to turn it off.

## Not yet

- **`property type` and `possible values` are checked, never enforced** — a value
  that contradicts either is reported as a conflict and left alone, because a
  value you typed is yours. A **strict default** is the one thing that does get
  written, and only into an empty value unless you turn the setting on. Generated properties are created empty; Obsidian's own
  `types.json` governs how they are displayed.
- **One argument per call.** `file.isA("Artist")`, not
  `file.isA("Artist", "Writer")`; `file.isA("a") or file.isA("b")` says the same
  thing.

Built by Claude.
