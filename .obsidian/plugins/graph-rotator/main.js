/*
 * Graph Rotator — written entirely by Claude for Leander.
 * Nothing in this folder is Leander's code, so the usual per-line "# Claude"
 * marking does not apply; the whole file is mine.
 *
 * What it does
 *   Hold a modifier and scroll the mouse wheel over a graph pane: the graph
 *   turns. Rotation is per pane, anchored under the pointer (or on the centre
 *   of the view), eased the way Obsidian's own zoom is, and undone by a
 *   command or by disabling the plugin.
 *
 * How it works (Obsidian 1.13.x internals — see README.md)
 *   Every node circle, label, link sprite and arrow is a child of one PIXI
 *   container, `renderer.hanger`, whose transform *is* the camera: `setPan`
 *   writes `hanger.x/y` and `setScale` writes `hanger.scale`. So the whole
 *   camera gains a rotation by assigning `hanger.rotation` — one number, and
 *   PIXI redraws everything about it, in the right theme colours, with the
 *   right z-order.
 *
 *   What that does *not* fix is the places where the renderer converts between
 *   screen and world by hand, each of which assumes there is no rotation: the
 *   viewport rectangle it culls against, the hover test that drops
 *   `highlightNode` when the pointer has left the node, and — in Graph Focus —
 *   the pan target that centres a focused note. The first two are corrected
 *   here by intercepting the properties they read (`viewport`, `mouseX`,
 *   `mouseY`) rather than by patching the code that reads them, which is a
 *   closure. The third is another plugin's arithmetic, so this one only
 *   publishes the angle for it: see `app.__graphRotator`.
 *
 *   Everything PIXI resolves for itself — hit-testing the node under the
 *   cursor, dragging one, the arrows' own rotation — already goes through the
 *   hanger's transform and needs nothing.
 *
 * All patching is in memory. onunload() restores every property it replaced
 * and turns every pane back to 0°.
 */

'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice } = obsidian;

const DEFAULT_SETTINGS = {
	/** Which modifier turns the wheel from a zoom into a rotation. */
	modifier: 'alt',
	/** Degrees per wheel notch. */
	step: 15,
	/** Reverse which way a notch turns. */
	invert: false,
	/** What stays put while the rest turns: 'pointer' | 'center'. */
	pivot: 'pointer',
	/** Ease into the new angle instead of jumping to it. */
	smooth: true,
	/** Counter-rotate the note names so they stay level. */
	uprightLabels: true,
	/** Show the current angle in the status bar while a pane is turned. */
	statusBar: true,
};

/** How much of the remaining angle to cover per frame while easing. */
const EASE = 0.3;

/** Below this (radians, about 0.06°) the animation is finished. */
const EPS = 1e-3;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const MODIFIER_NAMES = { alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl / Cmd' };

/** True if `r` looks like a GraphRenderer we know how to drive. */
function isGraphRenderer(r) {
	return !!r && Array.isArray(r.nodes) && Array.isArray(r.links) &&
		typeof r.queueRender === 'function' && typeof r.changed === 'function' &&
		typeof r.setPan === 'function';
}

/**
 * Exactly one modifier, and no others: Alt+Shift+wheel should not rotate when
 * Alt+wheel is what was asked for, because that combination may well mean
 * something else to something else.
 */
function matchesModifier(event, wanted) {
	const alt = !!event.altKey;
	const shift = !!event.shiftKey;
	const ctrl = !!(event.ctrlKey || event.metaKey);
	if (wanted === 'shift') return shift && !alt && !ctrl;
	if (wanted === 'ctrl') return ctrl && !alt && !shift;
	return alt && !shift && !ctrl;
}

/** Signed degrees in (-180, 180], for display. */
function prettyDegrees(radians) {
	let deg = (radians / DEG) % 360;
	if (deg > 180) deg -= 360;
	if (deg <= -180) deg += 360;
	return Math.round(deg);
}

class GraphRotatorPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});

		/** renderer -> state, see attach(). */
		this.attached = new Map();
		/** Set once if our own code throws, so we stop making it worse. */
		this.broken = false;
		/** Last text written to the status bar, so it is only rewritten on change. */
		this.statusText = null;
		this.statusEl = null;

		this.addSettingTab(new GraphRotatorSettingTab(this.app, this));

		this.addCommand({
			id: 'rotate-clockwise',
			name: 'Rotate graph clockwise',
			callback: () => this.rotateActive(1),
		});
		this.addCommand({
			id: 'rotate-counter-clockwise',
			name: 'Rotate graph counter-clockwise',
			callback: () => this.rotateActive(-1),
		});
		this.addCommand({
			id: 'reset-rotation',
			name: 'Reset graph rotation',
			callback: () => this.resetActive(),
		});

		// Published so another plugin can ask what a pane is turned by. Graph
		// Focus's "centre on the focused note" is the one thing in this vault
		// that computes a pan from world coordinates and so needs to know.
		this.app.__graphRotator = {
			angleOf: (renderer) => {
				const state = this.attached.get(renderer);
				return state ? state.angle : 0;
			},
		};

		this.app.workspace.onLayoutReady(() => this.scan());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.scan()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scan()));
		// A graph outside the workspace announces itself on this event — the
		// Bases graph view builds one inside a Bases container, where
		// iterateAllLeaves cannot see it.
		this.registerEvent(this.app.workspace.on('extra-graph-views-changed', () => this.scan()));
		// Panes can appear without a layout event (a popout window finishing its
		// init, for one), so sweep periodically as a backstop.
		this.registerInterval(window.setInterval(() => this.scan(), 2000));
	}

	onunload() {
		for (const [renderer, state] of this.attached) {
			try {
				// Leave nothing turned: a rotated pane whose plugin is gone has no
				// way back, and its hover test would stay wrong.
				state.pivotX = null;
				state.pivotY = null;
				state.target = 0;
				this.applyAngle(renderer, state, 0);
				this.restoreLabels(renderer);
				renderer.changed();
			} catch (e) {
				console.error('Graph Rotator: could not straighten a pane on unload', e);
			}
			for (const undo of state.cleanups) {
				try {
					undo();
				} catch (e) {
					console.error('Graph Rotator: failed to unpatch a graph pane', e);
				}
			}
		}
		this.attached.clear();
		if (this.app.__graphRotator) delete this.app.__graphRotator;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Run `fn`, and if it throws, stop patching rather than throw again every frame. */
	guard(fn) {
		if (this.broken) return;
		try {
			fn();
		} catch (e) {
			this.broken = true;
			console.error('Graph Rotator: disabling itself after an error', e);
		}
	}

	/* ---------------------------------------------------------------- panes */

	/** Every live graph pane in the workspace, with enough context to tell them apart. */
	liveGraphs() {
		const out = [];
		const add = (leaf, view) => {
			const renderer = view && view.renderer;
			if (!isGraphRenderer(renderer)) return;
			if (out.some((graph) => graph.renderer === renderer)) return;
			out.push({ leaf: leaf || (view && view.leaf) || null, view, renderer });
		};

		this.app.workspace.iterateAllLeaves((leaf) => add(leaf, leaf && leaf.view));

		const extra = this.app.__extraGraphViews;
		if (Array.isArray(extra)) {
			for (const view of extra.slice()) add(view && view.leaf, view);
		}

		return out;
	}

	scan() {
		if (this.broken) return;
		const graphs = this.liveGraphs();
		for (const graph of graphs) {
			if (!this.attached.has(graph.renderer)) this.guard(() => this.attach(graph.renderer));
		}
		const live = graphs.map((graph) => graph.renderer);
		for (const [renderer, state] of Array.from(this.attached)) {
			if (live.includes(renderer)) continue;
			for (const undo of state.cleanups) {
				try {
					undo();
				} catch (e) {
					// A destroyed pane is expected to fail here; there is nothing left
					// to restore the property to.
				}
			}
			this.attached.delete(renderer);
		}
		this.syncStatus();
	}

	/**
	 * Replace a renderer property with a wrapper that survives reassignment:
	 * `initGraphics()` rebuilds `renderCallback` whenever the canvas is
	 * recreated, and the setter re-wraps whatever it is handed.
	 */
	wrapProperty(renderer, name, makeWrapper, cleanups) {
		let raw = renderer[name];
		let wrapped = typeof raw === 'function' ? makeWrapper(raw) : raw;
		Object.defineProperty(renderer, name, {
			configurable: true,
			enumerable: true,
			get: () => wrapped,
			set: (value) => {
				raw = value;
				wrapped = typeof value === 'function' ? makeWrapper(value) : value;
			},
		});
		cleanups.push(() => {
			delete renderer[name];
			renderer[name] = raw;
		});
	}

	/**
	 * Replace a plain data property with a getter that may rewrite what is read.
	 * `read` is handed the last value written and returns what a reader sees;
	 * `write`, if given, is told about every value on its way in — which is the
	 * only place to record one, since a correction that needs two properties
	 * cannot wait for both of them to be read.
	 */
	interceptProperty(renderer, name, read, cleanups, write) {
		let raw = renderer[name];
		if (write) write(raw);
		Object.defineProperty(renderer, name, {
			configurable: true,
			enumerable: true,
			get: () => read(raw),
			set: (value) => {
				raw = value;
				if (write) write(value);
			},
		});
		cleanups.push(() => {
			delete renderer[name];
			renderer[name] = raw;
		});
	}

	attach(renderer) {
		if (this.attached.has(renderer)) return;

		const state = {
			/** Where the pane is now, in radians, clockwise. */
			angle: 0,
			/** Where it is heading; the two differ only while easing. */
			target: 0,
			/** The screen point held still, in device pixels. Null means the centre. */
			pivotX: null,
			pivotY: null,
			/** The pointer as the renderer last reported it, before correction. */
			rawMouseX: null,
			rawMouseY: null,
			/** Whether the labels are currently counter-rotated. */
			uprightApplied: false,
			cleanups: [],
		};
		this.attached.set(renderer, state);

		const self = this;

		// Step the animation before the frame is drawn, so the viewport, the node
		// positions and the hit test all agree within one frame; straighten the
		// labels after it, because the renderer writes their position itself.
		this.wrapProperty(renderer, 'renderCallback', (original) => function () {
			self.guard(() => self.step(renderer, state));
			original.call(this);
			self.guard(() => self.after(renderer, state));
		}, state.cleanups);

		// The renderer culls against an axis-aligned rectangle it derives from the
		// pan and the scale alone. Under rotation the visible region is a turned
		// rectangle, so nodes near the edges would be dropped while still on
		// screen. Hand back the bounding box of the real one instead.
		this.interceptProperty(renderer, 'viewport', (raw) => {
			if (!state.angle) return raw;
			return self.rotatedViewport(renderer, state) || raw;
		}, state.cleanups);

		// The last thing a frame does is drop `highlightNode` if the pointer is no
		// longer within the node's radius — computing the pointer's world position
		// with the same rotation-free arithmetic, so a turned pane would unhover
		// everything the instant it was hovered. Rather than reach into that
		// closure, hand it a pointer position that has been turned back, so its
		// own formula lands on the true world point.
		// Both coordinates are needed to correct either of them, and the renderer
		// reads them one after the other, so they are recorded as they are
		// written rather than as they are read — otherwise the first read of a
		// frame would be corrected against the previous frame's other half.
		this.interceptProperty(renderer, 'mouseX',
			() => self.correctedMouse(renderer, state, 'x'),
			state.cleanups, (v) => { state.rawMouseX = v; });
		this.interceptProperty(renderer, 'mouseY',
			() => self.correctedMouse(renderer, state, 'y'),
			state.cleanups, (v) => { state.rawMouseY = v; });

		// Obsidian's own wheel handler was bound to the canvas in the renderer's
		// constructor, so replacing `renderer.onWheel` would change nothing. A
		// capture-phase listener one element up runs first and can stop it.
		const container = renderer.containerEl;
		if (container) {
			const onWheel = (event) => this.guard(() => this.onWheel(renderer, state, event));
			const options = { capture: true, passive: false };
			container.addEventListener('wheel', onWheel, options);
			state.cleanups.push(() => container.removeEventListener('wheel', onWheel, options));
		}
	}

	/* -------------------------------------------------------------- geometry */

	/** The screen point, in device pixels, that a rotation holds still. */
	pivotPoint(renderer, state) {
		if (state.pivotX !== null && state.pivotY !== null) {
			return { x: state.pivotX, y: state.pivotY };
		}
		const dpr = window.devicePixelRatio || 1;
		// Measure live rather than trusting renderer.width/height, which are only
		// refreshed on resize and can be stale in a pane that has just opened.
		const el = renderer.containerEl;
		const width = (el && el.clientWidth) || renderer.width || 0;
		const height = (el && el.clientHeight) || renderer.height || 0;
		return { x: (width / 2) * dpr, y: (height / 2) * dpr };
	}

	/**
	 * Turn the camera to `next`, holding the pivot still.
	 *
	 * The hanger's transform is translate(pan) · rotate(angle) · scale(scale).
	 * Keeping a screen point `c` fixed across a turn of `d` means
	 * `pan' = c + R(d)·(pan - c)` — the scale drops out, because a uniform scale
	 * commutes with a rotation. That is also why zooming needs no correction
	 * here: Obsidian's own zoom-to-cursor arithmetic reduces to the same
	 * expression whether or not the pane is turned.
	 */
	applyAngle(renderer, state, next) {
		const delta = next - state.angle;
		if (delta) {
			const c = this.pivotPoint(renderer, state);
			const cos = Math.cos(delta);
			const sin = Math.sin(delta);
			const vx = renderer.panX - c.x;
			const vy = renderer.panY - c.y;
			renderer.setPan(c.x + vx * cos - vy * sin, c.y + vx * sin + vy * cos);
		}
		state.angle = next;
		// Compared rather than assigned blindly, but assigned every frame it
		// differs, so a hanger rebuilt by initGraphics — after a resize, or a
		// theme change — comes back turned.
		const hanger = renderer.hanger;
		if (hanger && hanger.rotation !== next) hanger.rotation = next;
	}

	/** Called at the top of every frame: ease towards the target angle. */
	step(renderer, state) {
		if (!renderer.hanger) return;
		const gap = state.target - state.angle;
		if (Math.abs(gap) > EPS) {
			this.applyAngle(renderer, state, this.settings.smooth ? state.angle + gap * EASE : state.target);
			// Keep the frames coming until it has settled.
			renderer.idleFrames = 0;
			return;
		}
		if (state.angle !== state.target) {
			this.applyAngle(renderer, state, state.target);
			this.normalize(state);
			this.syncStatus();
			return;
		}
		// Nothing is moving, but the hanger may have been rebuilt under us.
		this.applyAngle(renderer, state, state.angle);
	}

	/** Keep the angle inside one turn, so it cannot drift towards a big float. */
	normalize(state) {
		if (state.angle !== state.target) return;
		const turns = Math.round(state.angle / TAU);
		if (!turns) return;
		state.angle -= turns * TAU;
		state.target = state.angle;
	}

	/**
	 * Counter-rotate the note names so they stay level.
	 *
	 * A label hangs a fixed distance below its node in *world* space, which the
	 * turn carries round with it. Putting its anchor at the turned-back offset
	 * lands it directly under the node on screen again, and the label's own
	 * `-angle` cancels the camera. The renderer rewrites `x`/`y` every frame but
	 * never touches `rotation`, so only the position has to be re-derived — from
	 * the value it just wrote, which is what `text.y - node.y` reads. It is only
	 * safe to read that from a label the renderer drew this frame, which is what
	 * `text.visible` means here.
	 */
	after(renderer, state) {
		const want = this.settings.uprightLabels && !!state.angle;
		if (!want && !state.uprightApplied) return;
		const cos = Math.cos(state.angle);
		const sin = Math.sin(state.angle);
		for (const node of renderer.nodes) {
			const text = node && node.text;
			if (!text || !text.visible) continue;
			if (!want) {
				text.rotation = 0;
				continue;
			}
			const offset = text.y - node.y;
			text.rotation = -state.angle;
			text.x = node.x + offset * sin;
			text.y = node.y + offset * cos;
		}
		state.uprightApplied = want;
	}

	/** Put every label back the way the renderer draws it. */
	restoreLabels(renderer) {
		for (const node of renderer.nodes) {
			const text = node && node.text;
			if (text) text.rotation = 0;
		}
	}

	/** The bounding box, in world coordinates, of the turned visible rectangle. */
	rotatedViewport(renderer, state) {
		const scale = renderer.scale || 0;
		if (!scale) return null;
		const dpr = window.devicePixelRatio || 1;
		const el = renderer.containerEl;
		const width = ((el && el.clientWidth) || renderer.width || 0) * dpr;
		const height = ((el && el.clientHeight) || renderer.height || 0) * dpr;
		if (!width || !height) return null;

		const cos = Math.cos(state.angle);
		const sin = Math.sin(state.angle);
		const corners = [[0, 0], [width, 0], [width, height], [0, height]];
		let left = Infinity;
		let right = -Infinity;
		let top = Infinity;
		let bottom = -Infinity;
		for (const corner of corners) {
			const px = corner[0] - renderer.panX;
			const py = corner[1] - renderer.panY;
			// world = R(-angle) · (screen - pan) / scale
			const x = (px * cos + py * sin) / scale;
			const y = (py * cos - px * sin) / scale;
			if (x < left) left = x;
			if (x > right) right = x;
			if (y < top) top = y;
			if (y > bottom) bottom = y;
		}
		return { left, right, top, bottom };
	}

	/**
	 * The pointer position to report, in CSS pixels, chosen so that the
	 * renderer's own `(mouse · dpr - pan) / scale` lands on the world point the
	 * pointer is really over.
	 */
	correctedMouse(renderer, state, axis) {
		const raw = axis === 'x' ? state.rawMouseX : state.rawMouseY;
		if (!state.angle || raw === null || raw === undefined) return raw;
		const x = state.rawMouseX;
		const y = state.rawMouseY;
		if (x === null || x === undefined || y === null || y === undefined) return raw;
		const dpr = window.devicePixelRatio || 1;
		const px = x * dpr - renderer.panX;
		const py = y * dpr - renderer.panY;
		const cos = Math.cos(state.angle);
		const sin = Math.sin(state.angle);
		const rx = px * cos + py * sin;
		const ry = py * cos - px * sin;
		return axis === 'x' ? (rx + renderer.panX) / dpr : (ry + renderer.panY) / dpr;
	}

	/* ---------------------------------------------------------- the gesture */

	onWheel(renderer, state, event) {
		if (!matchesModifier(event, this.settings.modifier)) return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();

		// The same normalisation the renderer applies before zooming, so a line-
		// or page-mode wheel turns by the same amount as a pixel-mode one.
		let delta = event.deltaY;
		if (event.deltaMode === 1) delta *= 40;
		else if (event.deltaMode === 2) delta *= 800;
		if (!delta) return;

		let degrees = (delta / 120) * this.settings.step;
		if (this.settings.invert) degrees = -degrees;
		this.rotateBy(renderer, state, degrees * DEG, this.wheelPivot(renderer, event));
	}

	wheelPivot(renderer, event) {
		if (this.settings.pivot !== 'pointer') return null;
		const el = renderer.interactiveEl || renderer.containerEl;
		if (!el || typeof el.getBoundingClientRect !== 'function') return null;
		const rect = el.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		return { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
	}

	rotateBy(renderer, state, radians, pivot) {
		state.pivotX = pivot ? pivot.x : null;
		state.pivotY = pivot ? pivot.y : null;
		state.target += radians;
		if (!this.settings.smooth) {
			this.applyAngle(renderer, state, state.target);
			this.normalize(state);
		}
		renderer.changed();
		this.syncStatus();
	}

	/* ------------------------------------------------------------- commands */

	/**
	 * The pane a command acts on: the graph you are in, or every attached pane
	 * when the active leaf is not a graph — which is what happens when the
	 * command is run from the palette with a note focused.
	 */
	targets() {
		const active = this.app.workspace.activeLeaf;
		if (active) {
			for (const graph of this.liveGraphs()) {
				if (graph.leaf === active && this.attached.has(graph.renderer)) {
					return [[graph.renderer, this.attached.get(graph.renderer)]];
				}
			}
		}
		return Array.from(this.attached);
	}

	rotateActive(direction) {
		const targets = this.targets();
		if (!targets.length) {
			new Notice('Graph Rotator: no graph pane is open.');
			return;
		}
		for (const pair of targets) {
			this.guard(() => this.rotateBy(pair[0], pair[1], direction * this.settings.step * DEG, null));
		}
	}

	resetActive() {
		let turned = 0;
		for (const pair of this.targets()) {
			const renderer = pair[0];
			const state = pair[1];
			if (!state.angle && !state.target) continue;
			turned++;
			this.guard(() => {
				state.pivotX = null;
				state.pivotY = null;
				state.target = 0;
				if (!this.settings.smooth) this.applyAngle(renderer, state, 0);
				renderer.changed();
			});
		}
		if (!turned) new Notice('Graph Rotator: nothing is turned.');
		this.syncStatus();
	}

	/* ----------------------------------------------------------- status bar */

	/** The largest angle currently in play, since the bar has room for one. */
	syncStatus() {
		let text = null;
		if (this.settings.statusBar) {
			let widest = 0;
			for (const state of this.attached.values()) {
				const deg = prettyDegrees(state.target);
				if (Math.abs(deg) > Math.abs(widest)) widest = deg;
			}
			if (widest) text = `Graph ${widest}°`;
		}
		if (text === this.statusText) return;
		this.statusText = text;
		if (!text) {
			if (this.statusEl) {
				this.statusEl.remove();
				this.statusEl = null;
			}
			return;
		}
		if (!this.statusEl) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.setAttribute('aria-label',
				'Graph rotation — run "Reset graph rotation" to straighten it');
		}
		this.statusEl.setText(text);
	}
}

class GraphRotatorSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('The gesture').setHeading();

		new Setting(containerEl)
			.setName('Modifier')
			.setDesc('Hold this and scroll the wheel over a graph pane to turn it. Without it the '
				+ 'wheel still zooms. Ctrl is also the application zoom, so Alt or Shift stay out '
				+ 'of the way.')
			.addDropdown((d) => d
				.addOptions(MODIFIER_NAMES)
				.setValue(this.plugin.settings.modifier)
				.onChange(async (v) => {
					this.plugin.settings.modifier = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Degrees per notch')
			.setDesc('How far one click of the wheel turns the graph. A trackpad sends much smaller '
				+ 'steps than a notched wheel, so it turns proportionally more finely.')
			.addSlider((s) => s
				.setLimits(1, 90, 1)
				.setValue(this.plugin.settings.step)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.step = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Reverse the direction')
			.setDesc('Scrolling down turns the graph clockwise. This swaps it.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.invert)
				.onChange(async (v) => {
					this.plugin.settings.invert = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('What stays put')
			.setDesc('The point the graph turns around. Under the pointer is the same anchoring the '
				+ 'wheel already gives you when it zooms; the commands always use the centre, since '
				+ 'they have no pointer to work from.')
			.addDropdown((d) => d
				.addOptions({ pointer: 'The pointer', center: 'The centre of the pane' })
				.setValue(this.plugin.settings.pivot)
				.onChange(async (v) => {
					this.plugin.settings.pivot = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Drawing').setHeading();

		new Setting(containerEl)
			.setName('Ease into the turn')
			.setDesc('Slide to the new angle over a few frames instead of jumping to it, the way '
				+ 'Obsidian’s own zoom eases.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.smooth)
				.onChange(async (v) => {
					this.plugin.settings.smooth = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Keep the names level')
			.setDesc('Counter-rotate the note names so they stay readable, and hold each one '
				+ 'directly below its node. Turn this off to let the labels lie over with the graph.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.uprightLabels)
				.onChange(async (v) => {
					this.plugin.settings.uprightLabels = v;
					await this.plugin.saveSettings();
					for (const renderer of this.plugin.attached.keys()) renderer.changed();
				}));

		new Setting(containerEl)
			.setName('Show the angle in the status bar')
			.setDesc('Only while something is actually turned, so it is a reminder that the graph '
				+ 'is not level rather than a permanent readout.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.statusBar)
				.onChange(async (v) => {
					this.plugin.settings.statusBar = v;
					await this.plugin.saveSettings();
					this.plugin.syncStatus();
				}));

		new Setting(containerEl).setName('Straightening up').setHeading();

		new Setting(containerEl)
			.setName('Reset the rotation')
			.setDesc('Turns the graph pane you are in back to 0° — or every pane, if you '
				+ 'are not in one. There is a command for this too, so it can have a hotkey.')
			.addButton((b) => b
				.setButtonText('Reset')
				.onClick(() => this.plugin.resetActive()));
	}
}

module.exports = GraphRotatorPlugin;
