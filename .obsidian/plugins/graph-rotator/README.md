# Graph Rotator

Hold a modifier and scroll the mouse wheel over a graph pane: the graph turns.

That is the whole feature, and it is what `Graph Rotator.md` asks for. The work
is not in the turning — one PIXI container holds the entire camera, so the angle
is a single assignment — but in the three places Obsidian's renderer converts
between screen and world coordinates by hand, each of which quietly assumes the
graph is level.

## Enabling it

Already enabled in `template_vault`, and installed nowhere else. Settings →
Community plugins → **Graph Rotator**.

## Using it

**Alt + wheel** over any graph pane. A plain wheel still zooms; the modifier is
what makes it a rotation, and it can be changed to Shift or Ctrl in the
settings.

It works in the global graph, in a local graph, and in the graph layout the
**Bases Graph View** plugin adds — the same three places Graph Focus attaches
to, found the same way.

Each pane keeps its own angle. Nothing is persisted: reopening Obsidian, or
reopening the pane, gives you a level graph again.

| | |
|---|---|
| Turn a pane | Alt + wheel over it |
| Turn it from the keyboard | *Rotate graph clockwise* / *counter-clockwise*, one step per press |
| Straighten it | *Reset graph rotation*, or the **Reset** button in the settings |

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

**Reverse the direction** — by default scrolling down turns clockwise.

**What stays put** — the pointer, or the centre of the pane. Anchoring on the
pointer is the same behaviour the wheel already has when it zooms. The commands
always use the centre, having no pointer to work from.

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

### What does break, and how it is corrected

Three places convert screen to world by hand. All three are inside closures
built during `initGraphics()`, so none of them can be patched. Two are fixed by
intercepting the *properties they read* instead — a getter can lie about a
number without anyone having to reach the code doing the reading.

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

- **Graph Focus's pan-to-node.** `stepPan()` centres a focused note with
  `pan = width/2·dpr - node.x·scale`, which is the same rotation-free reasoning
  and lands off-centre while the pane is turned. That one belongs to another
  plugin, so this plugin only publishes what it would need: `app.__graphRotator`
  with an `angleOf(renderer)`. Graph Focus does not read it yet — centring a
  focused note in a turned pane is off by the rotation until it does.

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

The correction is applied *after* the frame, so it lands one frame late. The
renderer keeps rendering for roughly 60 frames after any `changed()`, so it is
never visible.

### The gesture

`onWheel` was bound to the canvas in the renderer's *constructor*
(`el.addEventListener('wheel', this.onWheel.bind(this))`), so replacing
`renderer.onWheel` afterwards changes nothing — the listener holds a copy taken
at bind time. A capture-phase listener on `containerEl`, one element up, runs
before it and can stop it with `stopPropagation()`. Without the modifier the
listener returns immediately and the zoom is untouched.

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
