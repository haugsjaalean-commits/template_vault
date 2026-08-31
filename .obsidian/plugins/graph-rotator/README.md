# Graph Rotator

Hold a modifier and scroll the mouse wheel over a graph pane: the graph turns.

That is the whole feature, and it is what `Graph Rotator.md` asks for. The work
is not in the turning — one PIXI container holds the entire camera, so the angle
is a single assignment — but in everything that is computed from a node's
position by hand, each of which quietly assumes the graph is level. There turned
out to be five of those, across this plugin and its two siblings.

## Enabling it

Already enabled in `template_vault`, and installed nowhere else. Settings →
Community plugins → **Graph Rotator**.

## Using it

**Alt + wheel** over any graph pane. A plain wheel still zooms; the modifier is
what makes it a rotation, and it can be changed to Shift or Ctrl in the
settings.

**One modifier gives both directions.** Scrolling down turns the graph one way
and scrolling up turns it back — there is no second key and no mode to switch.
*Reverse the direction* swaps which way is which; it does not pick a single
direction to be stuck with.

It works in the global graph, in a local graph, and in the graph layout the
**Graphs for Bases** plugin adds — the same three places Graph Focus attaches
to, found the same way.

Each pane keeps its own angle. Nothing is persisted: reopening Obsidian, or
reopening the pane, gives you a level graph again.

| | |
|---|---|
| Turn a pane | Alt + wheel over it |
| Turn it from the keyboard | *Rotate graph clockwise* / *counter-clockwise*, one step per press |
| Straighten it | *Reset graph rotation*, or the **Reset** button in the settings |
| Change what it turns around | *What stays put* in the settings — the pointer, the centre of the graph, or the active note |

The commands act on the graph pane you are in. Run from the palette with a note
focused instead of a graph, they act on every graph pane at once — which is also
how *Reset* rescues a pane you have turned and then lost track of.

While anything is turned, the status bar shows the angle. That is the reminder
that the graph is not level; it disappears at 0°.

## The settings

**Modifier** — Alt, Shift or Ctrl / Cmd. Exactly that modifier and no other:
Alt+Shift+wheel does not rotate when Alt+wheel is the gesture, because the
combination may well mean something else to something else. Ctrl is also the
application zoom, so Alt and Shift stay out of the way.

**Degrees per notch** — 1° to 90°, 15° by default. A trackpad sends much smaller
deltas than a notched wheel and so turns proportionally more finely; a
line-mode or page-mode wheel is normalised the same way Obsidian normalises it
before zooming, so all three agree.

**Reverse the direction** — by default scrolling down turns clockwise and
scrolling up turns counter-clockwise. This swaps the pair over. It is not a
choice of one direction: both are always available under the one modifier.

**What stays put** — the point the graph turns around. Three choices:

| | |
|---|---|
| **The pointer** | The same anchoring the wheel already gives you when it zooms. |
| **The centre of the graph** | The middle of the nodes themselves, so the graph spins in place wherever it happens to sit on screen. |
| **The active note** | That one note stays put and everything else swings around it. In a local graph it is the note the pane is built on, not whatever the workspace calls active — clicking into a graph pane makes *it* the active leaf without changing which note it is showing. |

Each falls through to the centre of the graph when it cannot be had: the pointer
when a *command* started the turn and there is no pointer, the active note when
it is not a node in this pane — the ordinary case in a Bases graph, or in a local
graph of some other note. With nothing laid out yet, the middle of the pane is
the floor.

"The centre of the graph" is the middle of the **box** the nodes occupy, not
their average position. The average gets dragged around by whichever cluster
happens to be densest, which is not where the graph looks like its middle is.

**Ease into the turn** — slide to the new angle over a few frames rather than
jumping, matching the easing of Obsidian's own zoom. Off means the graph is at
the new angle on the next frame.

**Keep the names level** — counter-rotate the note names so they stay readable,
and hold each one directly below its node. Off lets the labels lie over with
the graph, which is the honest rendering but not a readable one past about 40°.

**Show the angle in the status bar** — only while something is turned.

## How it works

Obsidian exposes no public API for graph view, so this reads and writes
internal properties of `GraphRenderer`. Verified against the **1.13.7** bundle
(`%APPDATA%/obsidian/obsidian-<version>.asar` — searchable as ASCII despite
being minified).

### The rotation itself is one number

Every node circle, every label, every link sprite and every arrow is a child of
one `PIXI.Container`, `renderer.hanger`, and that container's transform *is* the
camera: `setPan()` writes `hanger.x/y`, `setScale()` writes `hanger.scale`. So
the camera gains a rotation by assigning `hanger.rotation`, and PIXI redraws
everything about it — in the right theme colours, in the right z-order, with the
link arrows keeping the rotation they compute for themselves.

Two consequences worth stating, because they are why this is a small plugin:

- **Hit-testing needs nothing.** Hovering a node, clicking one and dragging one
  all go through PIXI's own event system, which resolves positions against the
  real transform. Dragging in particular reads `event.getLocalPosition(hanger)`,
  so a node dragged in a turned pane follows the cursor exactly and hands the
  layout worker the right world coordinates.
- **Zooming needs nothing either.** Obsidian's zoom-to-cursor keeps a screen
  point fixed by recomputing the pan from the world point under the cursor,
  which under rotation is the wrong world point — but a uniform scale commutes
  with a rotation, so the whole expression collapses to
  `pan' = c + (scale'/scale)·(pan - c)`, which has no rotation in it. The naive
  arithmetic and the correct arithmetic are the same arithmetic.

  The same identity is what makes the pivot cheap here: holding a screen point
  `c` still across a turn of `d` is `pan' = c + R(d)·(pan - c)`, with no scale
  term to carry.

- **A world pivot needs no second formula.** Two of the three choices — the
  graph's centre and the active note — name a point in the *graph*, not on the
  screen. But converting that world point to its current screen position and
  holding *that* pixel still is the same thing: substituting
  `c = pan + R(angle)·(scale·W)` into the line above leaves
  `pan' + R(angle + d)·(scale·W) = c`, so `W` comes out under the pixel it went
  in under, at any angle and any zoom. So there is one pivot formula, and the
  world choices differ only in resolving `c` again on every frame instead of
  once — which is what keeps a note truly still while the angle eases, rather
  than merely at the start and the end of it.

  The world point itself is frozen when the gesture starts. Recomputing the
  graph's centre every frame would be an O(n) sweep, and a centre that shifted
  under the ease would make the graph crawl rather than spin.

### What does break, and how it is corrected

Two places inside the renderer convert screen to world by hand, both inside
closures built during `initGraphics()`, so neither can be patched. They are
fixed by intercepting the *properties they read* instead — a getter can lie
about a number without anyone having to reach the code doing the reading.

- **The culling rectangle.** Each frame sets `renderer.viewport` to an
  axis-aligned world rectangle derived from the pan and scale alone, and both
  nodes and links are skipped when they fall outside it. Under rotation the
  visible region is a *turned* rectangle, so nodes still on screen would vanish
  near the edges. `viewport` becomes an accessor whose getter returns the
  bounding box of the four real screen corners mapped back into world space. At
  0° it hands back exactly what was written.

- **The hover test.** The last thing a frame does is drop `highlightNode` if the
  pointer has left the node's radius, computing the pointer's world position as
  `(mouse · dpr - pan) / scale`. In a turned pane that lands somewhere else
  entirely, and every hover would be cancelled the moment it happened. So
  `mouseX` and `mouseY` become accessors that return a *pre-turned* pointer —
  the value for which the renderer's own formula produces the true world point.
  Both coordinates are needed to correct either one, and the renderer reads them
  one after the other, so they are recorded on the way **in** rather than on the
  way out; recording them as they are read corrects the first read of a frame
  against the previous frame's other half, which is a real bug and was caught by
  the harness.

- **Two more live in the sibling plugins**, and both now read the angle from
  `app.__graphRotator.angleOf(renderer)`, which this plugin publishes for them
  and which returns 0 when it is not installed:
  - Graph Focus's `stepPan()` centres a focused note with
    `pan = width/2·dpr - node.x·scale`, and without the rotation it aims at
    where the note would sit if the graph were level — and settles there
    (fixed in Graph Focus 1.36.0).
  - Graphs for Bases's `nodeAnchor()` places the hover tooltip over a node the
    same way, putting it most of the pane away at 90° (fixed in 1.46.0).

  Note that grepping for `panX` finds these two and misses the labels entirely,
  because a label's position is written in world coordinates with no pan in it.
  The sweep that matters is "what is computed from `node.x`", not "what touches
  the pan".

### The labels

A label is a `PIXI.Text` anchored at `(0.5, 0)`, positioned each frame at
`node.x, node.y + (size + 5)·nodeScale`. It is a child of the hanger, so a turn
carries it round and lies it over with everything else.

Keeping it level takes two things, not one: the text's own `rotation` is set to
`-angle`, which cancels the camera, and its anchor is moved to the *turned-back*
offset — `node + R(-angle)·(0, d)` — so that once the camera turns it again the
label sits directly below its node on screen. The renderer rewrites `x` and `y`
every frame but never touches `rotation`, so only the position has to be
re-derived, and it is re-derived from the value the renderer just wrote
(`text.y - node.y`). That is only meaningful for a label the renderer actually
drew this frame, which is what the `text.visible` check means.

**It has to happen before the draw, and that is the whole difficulty.** A frame
positions every label from scratch — `text.x` is *assigned* `node.x`, not
adjusted — and only then calls `px.render()`. A correction applied after the
callback is therefore overwritten by the next frame's positioning pass before it
has ever been drawn. The `rotation` survives, because nothing else writes it, so
getting this wrong does not look like no effect: it looks like level names
sitting at the un-turned offset, sticking out from their nodes at the angle of
the turn. That was the 1.0.x bug.

So the hook is `px.render()` itself — the draw, called from inside the callback
on the PIXI Application its closure captured. Shadowing that one method, per
instance, is the only moment between the node renders and the frame reaching the
screen. It also means nothing runs on a frame the renderer skipped as idle, so
there is no half-laid-out frame to read an offset from.

Coming back to 0° releases *every* label rather than only the visible ones: one
that happened to be hidden on that frame would otherwise keep its
counter-rotation for good and reappear later as a single tilted name.

### The gesture

`onWheel` was bound to the canvas in the renderer's *constructor*
(`el.addEventListener('wheel', this.onWheel.bind(this))`), so replacing
`renderer.onWheel` afterwards changes nothing — the listener holds a copy taken
at bind time. A capture-phase listener on `containerEl`, one element up, runs
before it and can stop it with `stopPropagation()`. Without the modifier the
listener returns immediately and the zoom is untouched.

**Either axis turns the graph** (1.0.1). Holding Shift makes the platform report
a vertical wheel as a *horizontal* scroll: `deltaY` is 0 and the movement
arrives on `deltaX`. Reading `deltaY` alone therefore left the Shift modifier
doing nothing at all, in either direction — the one modifier of the three that
looked like the obvious choice. A tilt wheel and a trackpad's sideways swipe
land on the same axis, so both now turn as well. `deltaY` still wins when both
are present, so a diagonal trackpad gesture cannot turn twice as far.

### Everything else

- `renderCallback` is wrapped with the same getter/setter pair Graph Focus uses,
  so the wrap survives `initGraphics()` rebuilding the function after a resize
  or a theme change. The animation steps *before* the original runs, so the
  viewport, the node positions and the hit test agree within one frame; the
  labels are straightened after it.
- The hanger is destroyed and rebuilt by `initGraphics()` too, taking the
  rotation with it, so the angle is re-asserted on it every frame it differs.
- The angle is folded back into one turn whenever it settles, so scrolling in
  one direction for a long time cannot walk it out towards a large float.
- Nothing is written to disk except the settings. There is no per-pane state to
  persist and none is kept.
- Disabling the plugin turns every pane back to 0° before it lets go, and
  restores every property it replaced. A rotated pane whose plugin has gone
  would have no way back and a permanently wrong hover test.

## Troubleshooting

**The wheel zooms instead of rotating.** Another listener may be taking the
event first, or the modifier is not the one in the settings. The commands
*Rotate graph clockwise* / *counter-clockwise* do not go through the wheel at
all, so if those work and Alt+wheel does not, it is the gesture and not the
rotation.

**It only turns one way.** It should not: up and down are the two directions.
If one of them does nothing, the wheel is sending an asymmetric delta — worth
checking in the console with
`addEventListener('wheel', e => console.log(e.deltaX, e.deltaY, e.deltaMode))`.

**A pane is turned and you cannot turn it back.** *Reset graph rotation* from
the palette. Run with a note focused rather than a graph, it straightens every
pane.

**Labels drift out from under their nodes.** Turn off *Keep the names level* to
see whether the label treatment is what is wrong, or the rotation itself.

If the plugin's own code throws, it stops patching rather than throw again on
every frame, and says so once in the console (Ctrl+Shift+I). A graph that
suddenly stops rotating but otherwise behaves normally has hit that path.

## If a future Obsidian update breaks it

The things it depends on, roughly in order of how likely they are to move:

1. `renderer.hanger` being the container that carries the pan and the scale.
   Everything rests on this. If the camera moves onto `px.stage`, or the
   renderer starts computing screen coordinates per sprite, the rotation has to
   move with it.
2. `renderer.viewport` being an assigned `{left, right, top, bottom}` in world
   coordinates. If the culling becomes a method call, the interception has
   nothing to intercept and nodes will disappear near the edges of a turned
   pane.
3. `renderer.mouseX` / `mouseY` being plain properties in CSS pixels, read at
   the end of the frame. If the hover test starts reading the event directly,
   hovering in a turned pane will stop working.
4. `renderCallback` being a per-instance function, and the wheel listener being
   bound on `interactiveEl` at construction.
