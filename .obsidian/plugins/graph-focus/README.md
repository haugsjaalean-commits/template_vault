# Graph Focus

Lock the graph highlight onto a node without keeping the cursor on it, and fade
notes progressively by how many hops away they are.

Written by Claude for Leander. Everything here is Claude's code — no part of it
came from Leander's own files.

## Enabling it

1. Restart Obsidian (or close and reopen the Community plugins settings pane) so
   it notices the new folder.
2. Settings → Community plugins → enable **Graph Focus**.

To remove it completely: turn it off and delete this folder. It writes nothing
outside `.obsidian/plugins/graph-focus/` (settings go in `data.json` here).

## Using it

| Action | How |
| --- | --- |
| Lock focus on a node | Alt+click it in any graph pane |
| Focus several notes at once | Alt+**Shift**+click each extra one |
| Drop one from the set | Alt+Shift+click it again |
| Release everything | Alt+click the focused node, or run **Clear focus lock** |
| Move the focus and open the note | Plain click any node |
| Bring the focused note into view | **Move the view to the focused note** in settings |
| Come back to the note you're reading | Plain click its node — the centre one, in a local graph |
| Lock without the mouse | Point at a node, run **Lock focus on hovered node** |
| Lock the note you're reading | Run **Lock focus on active note** |
| Focus every note you open, automatically | **Follow the active note** in settings — on by default for local graph panes |

Every command takes a hotkey in Settings → Hotkeys, and the two lock commands
have **Add …to the focus** counterparts for building up a set from the keyboard.
The click modifier can be changed to Shift or Ctrl in the plugin's settings; Alt
is the default because Ctrl+click is already Obsidian's "open in new tab". The
add-to-focus key is Shift, or Alt if you have set the main modifier to Shift.

An ordinary click opens the note, and the focus moves with it — **An ordinary
click focuses the node it opens**, on by default. That is also the way back after
focusing your way around a pane: click the note you have open, which in a local
graph is the centre node, and the focus returns to it. That case needs the
setting, because clicking a note you already have open navigates nowhere and
fires no event; without it the focus would stay stranded wherever you last put
it.

**Follow the active note** keeps the focus on whatever you navigate to, so the
gradient is simply always on. It applies to local graph panes by default, or to
every graph pane, or not at all. A pane you have pinned is left alone, since a
pinned pane is deliberately not tracking the active file. A focus you set by
hand survives until the next time you open a note, which takes it back.

With several notes focused, depth is the distance to the **nearest** one, so the
fade describes the whole selected neighbourhood rather than any single note.
Every focused note gets the complete highlight treatment — ring, highlight fill,
and a readable label — not just the one you focused last.

The depth fade only shows something when more than one ring of notes is on
screen. In a **local graph** pane, open the filter controls and raise **Depth**
as far as you find useful — the fade follows it however deep it goes.

The fade goes as deep as the graph does, and four sliders describe it. The
settings pane prints the resulting opacities live as you drag.

`alpha(depth) = max(floor, falloff ^ (depth - fullRings) ^ shape)`

- **Falloff per hop** — the speed. Low collapses attention onto the immediate
  neighbourhood, high keeps distant notes readable.
- **Curve shape** — the shape, as opposed to the speed. See below.
- **Hops at full strength** — rings held completely undimmed before any fading
  starts. 1 matches Obsidian: the focused note and its direct links.
- **Floor** — opacity never drops below this. Also where anything unconnected to
  the focused note sits, being infinitely far away.

At shape 1 every hop costs the same ratio, so the first step is the harshest and
the tail is long. Above 1 the near hops are stretched — a gentle start that bites
further out. Below 1 it drops at once and then flattens.

    falloff 0.60, floor 0.05
    depth                     0     1     2     3     4     5     6     7
    shape 1.0 (default)       1.00  1.00  0.60  0.36  0.22  0.13  0.08  0.05
    shape 1.8                 1.00  1.00  0.60  0.17  0.05  0.05  0.05  0.05
    shape 0.6                 1.00  1.00  0.60  0.46  0.37  0.31  0.26  0.22
    2 full rings, shape 1.4   1.00  1.00  1.00  0.60  0.26  0.09  0.05  0.05

Links are recoloured as well as faded. Obsidian tints a link with
`colors.lineHighlight` only when it touches the focused note, and leaves
everything else the ordinary link colour. **Link colour** offers three
behaviours:

- **Drift back to the default colour** (default) — links start at the highlight
  colour next to the focused note and blend back toward the ordinary one as they
  get further away, so depth reads as both a fade and a hue shift. **Colour
  drift per hop** sets the rate: it is the fraction of the highlight colour that
  survives each extra hop. Keep it above the opacity falloff and the colour lags
  behind the fade, which is what makes the shift look gradual rather than abrupt.
- **Keep the highlight colour throughout** — the whole focused neighbourhood
  stays highlight-coloured and only opacity carries depth.
- **Leave Obsidian's colours alone** — stock tinting, gradient still applies to
  opacity.

Arrows have no highlight colour in Obsidian, so only their opacity changes.

## The focus panel

Every graph pane gets a panel in its top-left corner, listing what is currently
highlighted and offering a search for adding more. Click the header to collapse
it — the folding arrow is the same `collapse-icon` the Bases graph legend uses,
so it turns the way every other fold in Obsidian does. Whether it is folded is
remembered as the state new panels open in.

It is deliberately the mirror image of Obsidian's own graph controls in the
opposite corner: same inset (`--size-4-3`), same width
(`--graph-controls-width`), same menu surface, so the two read as a matched pair.
If a theme ever moves the controls to the same side, the panel measures the
overlap and drops below them.

The settings nest, and all of them apply to panes that are already open rather
than only to the next one:

    Focus panel
      Searching
        Search only files in the graph
      Show history of highlighted nodes
    Name connected notes in the graph
    Show aliases in the graph
      Aliases shown
    Arrows in the middle of links
      Arrow size
      Arrow shrink with zoom
      Arrows match link colour
      Arrows per link
      Double arrows both ways
    Display settings in the graph
      (which options that button offers)

**Search only files in the graph** drops matches that are not nodes in the pane
you are searching from, instead of greying them out. Most useful in a local
graph, which holds only its neighbourhood. The filter is applied during the scan,
so the 60-result cap counts matches you can actually act on.

**Show history of highlighted nodes** adds a *Recent* list of what you have
focused before, newest first, so you can put one back without searching for it
again. It survives restarts, and whatever is focused right now is left out of it.

**Show aliases in the graph** lists a note's aliases under its name, one per
line. A label is a `PIXI.Text` anchored at (0.5, 0) with centred alignment, so
the extra lines stack under the name and stay centred with no second object and
no layout of its own. Aliases come from Obsidian's own `parseFrontMatterAliases`,
so `alias` and `aliases`, string and list forms, all count the same as they do
everywhere else.

**Aliases shown** caps how many are listed, 1 to 10, defaulting to 3 — a note
with a long list would otherwise push a column of text across the graph.

They only appear where the name does — so on focused notes and, with the option
above, their neighbours, until you zoom in far enough for Obsidian to draw labels
itself.

**Arrows in the middle of links** fixes two things Obsidian does to link arrows.
It fades them with `clamp(2 * (scale - 0.3), 0, 1)`, so below a zoom of 0.3 they
are fully transparent — most of the time on a vault-sized graph — and it parks
them against the target node, where they end up underneath it. Each arrow moves
to the midpoint of its link and takes the line's own visibility and opacity, so
it fades with the depth gradient and disappears with the link rather than with
the zoom. Obsidian's own arrows toggle still has to be on.

**Arrow size** multiplies whatever size Obsidian would have drawn them at, from
0.25× to 4×, so they still track the graph's own line-thickness setting and the
zoom rather than being pinned to a fixed size.

**Arrow shrink with zoom** decides which of the renderer's own sizing laws
arrows follow. They are not all the same:

| | world size | on screen |
| --- | --- | --- |
| links | `lineSizeMult / scale` | constant |
| arrows | `2√lineSizeMult / scale` | constant |
| nodes | `size/100 × √(1/scale)` | shrinks as `√scale` |

So arrows hold their screen size while nodes shrink, which is why they seem to
grow on the way out. The slider is the exponent on `1/scale`: **0** is
Obsidian's constant-on-screen, **0.5** (the default) shrinks arrows exactly as
nodes do, **1** pins them to the graph so they shrink with everything else.

**Arrows match link colour** takes each arrow's colour from its own link instead
of the single flat arrow colour, so arrows pick up the highlight colour and its
drift with depth along with the link they belong to.

**Arrows per link** repeats the arrow along the link — one at zero, more the
higher it goes and the longer the link, capped at 12.

The count comes from how long the link *looks* — its screen length divided by a
target gap in pixels — so it does not swing about as you zoom, and it owes
nothing to the arrow size. The link is then divided into that many equal
segments with one arrow in the middle of each, so they spread across its whole
length: at three arrows they sit at 17%, 50% and 83%, and at one, at the
midpoint.

The extra arrows cost no extra objects: they are drawn as repeated chevrons
*inside* the single arrow the renderer already made for that link. Rebuilding
that geometry is the expensive part, so it is only redrawn when the count
changes or the spacing drifts by more than 2%.

**Double arrows both ways** draws a head at each end when two notes link to each
other, so a mutual link is visibly mutual.

Obsidian builds a link object per direction, and its own arrows sit against the
target node, so a mutual pair naturally shows one arrowhead at each end. But only
one of the two *lines* is drawn — the renderer hides the one whose source id
sorts first — and moving the arrow to the midpoint made it inherit that, since it
takes the line's visibility. The surviving arrow then pointed one way and claimed
a direction the link does not have.

So the surviving arrow draws both heads: the ordinary chevron with a mirrored one
behind it, tail-to-tail and tips outward, straddling the position rather than
sitting on it. The hidden edge still draws nothing, so a mutual link costs no
more objects than a one-way one. It repeats with **Arrows per link** like any
other, and switching it off gives back the single head.

Arrows are also given a z-index of 0.5, which puts them above the links and
below the nodes. The renderer's own values inside the hanger are: link
containers 0, node circles and highlight rings 1, labels 2 — and arrows 1 as
well, tying with the circles, so which drew on top came down to insertion order.

**Display settings in the graph** puts a slider button in the **bottom-right** of
every graph pane — opposite the focus panel, at the same inset as Obsidian's own
controls — opening a popover of plugin settings so you can adjust the fade
without leaving the graph. The sub-settings choose which options it offers;
everything remains available in the settings tab regardless. The popover opens
upward so it never runs off the pane.

*Highlighted* carries **All** and **None**: focus every node the pane holds, or
clear the focus. In a local graph "All" is the neighbourhood; in the global graph
it is the whole vault, so the list caps at 50 rows and says how many more there
are, and a bulk selection is deliberately kept out of the history.

Every heading folds — *Highlighted*, *Search* and *Recent* — with the same arrow
as the panel itself, each remembering whether you left it open. Folding *Search*
takes the results with it, since the box and its results are one section.

In *Recent*, click a row to focus that note again, the ✕ on a row to forget just
that one, or **Clear** in the heading to forget the lot.
The ✕ deliberately does not focus the note on its way past.

The search takes **Obsidian's own query syntax** — `tag:#art`, `path:Obsidian/`,
`[rating]`, `"a phrase"`, `file:` and boolean operators all work, because it uses
the same parser the graph's own filter does rather than a reimplementation.

The input is Obsidian's `SearchComponent`, the same one the search pane and the
graph's filter box use, and it completes as you type: the operators
`path:` `file:` `tag:` `line:` `section:` `[property]`, then your actual tag
names, folders, file names and property names once you have picked one.
Completion applies to the token under the cursor, so it works part-way through a
longer query. While the suggestion list is open, Enter takes a suggestion;
otherwise it runs the search.

Picking a suggestion that **finishes** the query runs it straight away — a tag, a
folder, a file name, a property, or your plain text. Picking a bare operator like
`tag:` does not, since there is obviously more to type; it opens the list of tags
instead.

It runs when you press Enter, not as you type — though emptying the box, by hand
or with the clear button, drops the results rather than leaving them stranded
under a blank query. **Listing matches is not the same as highlighting them**: click a result to add it to the focus, click it
again to remove it. So a broad query like `tag:#art` gives you a list to pick
from rather than lighting up two hundred notes at once. Malformed queries say so.

Results stream in as they are found, and the scan stops at 60 matches — a common
word finishes after a few dozen files rather than reading the whole vault. Tag,
path and property queries never read file contents at all, since the matcher
takes those from the metadata cache, so they return more or less instantly. Only
a plain-text search has to read notes, and Obsidian caches those reads, so a
repeat search is fast.

Matches that are not among the pane's own nodes are shown greyed and italic. A
local graph only holds the neighbourhood, so most of the vault cannot be
highlighted in one — the search is at its most useful in the global graph.

## How it works

Obsidian exposes no public API for graph view, so this reads and writes internal
properties of `GraphRenderer`. Verified against the **1.13.6** bundle and
re-checked against **1.13.7** (`%APPDATA%/obsidian/obsidian-<version>.asar` —
searchable as ASCII despite being minified):

- Brightness comes from `renderer.getHighlightNode()`, which returns
  `dragNode || highlightNode`. Assigning `highlightNode` therefore reproduces a
  hover exactly — highlight ring, fill colour, neighbour brightening.
- Each frame ends with a check that clears `highlightNode` when the pointer has
  moved off the node. It is skipped when `mouseX` / `mouseY` are `null`, so the
  plugin nulls them while locked. That is the whole trick behind the lock.
- Native dimming is binary: the focused node and its direct neighbours render at
  alpha `1.0`, everything else at `0.2` (the `JQ` constant). The gradient is new
  behaviour, so the plugin repaints only nodes at depth ≥ 2 and leaves 0 and 1
  alone.
- Link colour is chosen the same binary way: `colors.line`, swapped for
  `colors.lineHighlight` only when the link touches the focus node, then applied
  as `line.tint = t$(line.tint, h.rgb)` — an easing lerp, which is why snapping
  the tint back after each frame settles cleanly on the highlight colour.
  Links are repainted from depth 1 rather than 2, because a link between two
  direct neighbours is depth 1 by `max()` and would otherwise be stranded at
  `0.2` while the depth-2 links around it sit at `0.6`. Arrows have no highlight
  colour, so only their alpha is touched.
- `renderCallback` is a per-instance function scheduled through
  `requestAnimationFrame`. It is replaced with a getter/setter pair so the wrap
  survives `initGraphics()` rebuilding it after a resize or theme change.
- Following the active note rides on the `file-open` workspace event. A local
  graph rebuilds asynchronously after navigation, so the node usually does not
  exist yet at that moment — which needs no special handling, because the focus
  is stored by id and `assertLock()` runs every frame, so a pending lock takes
  hold the instant the node appears.
- **Naming the neighbours** reproduces the label half of the highlight without
  the rest of it. A node's `render()` derives its label from the same `d` flag as
  the ring — full opacity, exempt from the viewport test that hides distant
  labels, and counter-scaled by `1/scale` rather than shrinking with the graph,
  which is what makes it readable when zoomed out. Impersonation would have been
  easier but brings the ring and highlight fill with it, so the label treatment
  is applied directly instead. The renderer only *positions* a label on frames it
  decides to draw one, so forcing visibility means positioning it too.
- **The search query parser is borrowed, not reimplemented.** It is not exported
  anywhere, but the graph engine constructs one per query in `setQuery()` and
  keeps them on `engine.searchQueries` — colour groups count, so that array is
  populated whenever any are configured. Taking the constructor off a live
  instance gets the real parser: `new Query(app, text, false)` yields `.matcher`
  (null when the query is malformed), `.requiredInputs` (whether file *content*
  is needed, which most queries do not), and `.match(file, content)`. Matching
  then walks the vault the way the engine's own search does, skipping ignored and
  unsupported files and reading contents only when required, yielding to the
  interface every 40ms. If no instance can be borrowed — you would have to delete
  every colour group — it falls back to plain substring matching on the path and
  says so in the panel.
- **Panning** uses the renderer's transform directly: `screen = world * scale +
  pan`, in device pixels. That is the relation `resetPan()` encodes when it
  centres the origin with `setPan(width / 2 * dpr, height / 2 * dpr)`, so
  centring node *n* means `setPan(width / 2 * dpr - n.x * scale, …)`. The target
  is recomputed every frame rather than once, because the force simulation keeps
  moving the node — the view chases it instead of aiming where it used to be,
  and holds on until the node has *stopped* moving rather than merely until the
  view has caught up. Releasing at "close enough" leaves the note drifting off to
  one side for as long as the simulation runs, which after a rebuild is a second
  or two. It might never converge, so there is a 600-frame budget, and any
  panning or dragging of your own cancels it at once.
- **Following watches two events, and ignores one leaf.** `file-open` alone is
  wrong in both directions: it fires when a graph pane merely becomes the active
  leaf (a local graph is a `FileView` whose file is its centre note), and it does
  *not* fire when you click back into a note you already have open, since the
  active file has not changed. So `active-leaf-change` is watched as well, and
  the discriminator is not the filename but the leaf: following skips any pane
  that is itself the active leaf. Clicking inside a graph pane therefore never
  undoes the focus that click just set, while clicking back into a note does
  bring the focus home.
- `highlightNode` is a single slot, so multiple foci cannot be handed to the
  renderer directly. But a node's `render()` derives everything from one flag,
  `getHighlightNode() === this` — the ring, the label at full opacity, exemption
  from viewport culling, the counter-scaling that keeps a label readable when
  zoomed out, and the highlight fill. That flag is computed *per node, during
  that node's own render call*. So the node prototype's `render` is wrapped, and
  a focused node is handed a renderer that names it the highlighted one for the
  length of its own call, restored immediately after. Obsidian draws the whole
  treatment itself, in the right theme colours, and destroys the ring itself when
  the node stops being focused. The prototype is shared across panes, so the
  wrapper checks which pane the node belongs to first.
- Neighbour brightening still has to be done by hand: the impersonation lasts
  only for the focused node's own render, so when a neighbour renders it sees the
  real highlight and is dimmed unless it is adjacent to *that* one. The plugin
  therefore takes over depth 0 and 1 whenever more than one note is focused.
  `dragNode` wins over `highlightNode` in `getHighlightNode()`, so dragging
  temporarily moves the native highlight and the plugin picks up the near rings
  for the duration.
- Hop distance is a breadth-first walk over `renderer.links`, so it only ever
  counts links actually present in that pane. It is seeded with every focus node
  at depth 0 at once, so the first time a node is reached is by definition its
  distance to the closest focused note — multiple foci need no extra machinery. Cached, and recomputed when the
  node or link count changes. The walk stops at the depth where the geometric
  curve has already reached the floor, since every node past that point gets the
  same opacity — so a gentle falloff costs more traversal, and a steep one less,
  without either being unbounded.

Because the renderer draws inside `renderCallback`, alpha written afterwards
lands on the following frame. The renderer keeps rendering for roughly 60 frames
after any `changed()`, so the delay is never visible.

## Troubleshooting

Two things to reach for, both in the plugin's settings and the command palette:

- **Log clicks to the console** — prints what the plugin sees on every node
  click: the id clicked, which note it believes is the pane's home, the
  workspace's active file, and whether they matched.
- **Log diagnostics to the console** (command) — dumps every graph pane it has
  attached to, the home note it computed, whether that node is currently in the
  pane, and the full settings.

Open the console with Ctrl+Shift+I. If a click produces no log line at all, the
renderer is not calling `onNodeClick` and the problem is upstream of anything the
plugin decides.

## If a future Obsidian update breaks it

Every hook is shape-checked before use and every callback runs inside a guard.
If something throws, the plugin logs to the console, shows a notice, and stops
touching the graph rather than breaking the render loop. Turning the plugin off
restores stock behaviour immediately; `onunload` puts back every property it
replaced.
