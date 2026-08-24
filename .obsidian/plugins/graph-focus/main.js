/*
 * Graph Focus — written entirely by Claude for Leander.
 * Nothing in this folder is Leander's code, so the usual per-line "# Claude"
 * marking does not apply; the whole file is mine.
 *
 * What it does
 *   1. Focus lock — pin the graph highlight onto a node so you do not have to
 *      keep the cursor on it. Alt+click a node, or use the hotkey.
 *   2. Depth gradient — nodes two, three and four hops away fade out
 *      progressively instead of all dropping to Obsidian's flat 0.2 dim.
 *   3. Connexions — draw a link by the property it was written in, so `type of`
 *      and `related` and a body link stop looking like the same grey stick.
 *      Ordered rules, first match wins, each giving a symbol, a line and a
 *      colour. See linkKinds() and styleLink().
 *
 * How it works (Obsidian 1.13.x internals — see README.md)
 *   The graph renderer decides brightness from `renderer.getHighlightNode()`,
 *   which is `dragNode || highlightNode`. Assigning `highlightNode` therefore
 *   reproduces a hover exactly. The renderer clears it at the end of each frame
 *   if the pointer has moved off the node, but that check is skipped when
 *   `mouseX` / `mouseY` are null — so we null them while locked.
 *
 *   Native brightness is binary: focus node and direct neighbours at 1.0,
 *   everything else at 0.2. We leave depth 0 and 1 alone and only repaint
 *   depth >= 2, after the renderer's own frame has run.
 *
 * All patching is in memory. onunload() restores every property it replaced.
 */

'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, SearchComponent, AbstractInputSuggest } = obsidian;

/**
 * The operators Obsidian's own search suggester offers, taken from its table in
 * the bundle so the panel completes the same vocabulary.
 */
const QUERY_OPERATORS = [
	{ token: 'path:', hint: 'match the file path' },
	{ token: 'file:', hint: 'match the file name' },
	{ token: 'tag:', hint: 'match a tag' },
	{ token: 'line:()', hint: 'terms on the same line' },
	{ token: 'section:()', hint: 'terms in the same section' },
	{ token: '[]', hint: 'match a property' },
];

/** Obsidian's own dim level for everything outside the highlighted neighbourhood. */
const NATIVE_DIM = 0.2;

const DEFAULT_SETTINGS = {
	clickToLock: true,
	clickModifier: 'alt',
	// 'off' | 'local' (local graph panes only) | 'all' (every graph pane)
	followMode: 'local',
	clickFocuses: true,
	showPanel: true,
	showSearch: true,
	// Restrict matches to notes that are actually nodes in this pane.
	searchInGraphOnly: false,
	showHistory: true,
	historyCollapsed: false,
	highlightedCollapsed: false,
	searchCollapsed: false,
	// Give the focused notes' neighbours the same readable label the focused ones
	// get, drawn in the graph itself.
	labelConnected: true,
	// Arrows at the midpoint of every link, immune to the zoom fade.
	midArrows: true,
	// Multiplier on the size Obsidian would have drawn them at.
	arrowSize: 1,
	// 0 keeps one arrow per link; higher repeats them along its length.
	arrowDensity: 0,
	// When two notes link to each other, draw one double-headed arrow rather
	// than a single head that claims the link only runs one way.
	doubleArrows: true,
	// List a note's aliases under its name in the graph.
	showAliases: false,
	maxAliases: 3,
	// Take each arrow's colour from its own link rather than colors.arrow.
	arrowMatchLinks: true,
	// Draw links differently depending on which property they were written in.
	connexions: false,
	// Ordered, and the first one that matches a link decides all three of its
	// styles — so precedence lives in the order of this list, not in the order
	// the properties happen to appear in a note.
	connexionRules: [],
	// On-screen length of one dash and its gap, in pixels.
	dashPeriod: 14,
	// How much arrows shrink as the graph is zoomed out. 0 is Obsidian's own
	// behaviour (constant on screen), 0.5 matches how nodes shrink, 1 pins them
	// to the graph so they shrink with everything else.
	arrowZoom: 0.5,
	// A settings button in the corner of every graph pane, and which of the
	// options above it offers.
	showGraphSettings: true,
	graphSettingsKeys: ['gradient', 'falloff', 'curveShape', 'minAlpha'],
	// Most recently focused note paths, newest first.
	recentFocus: [],
	panelCollapsed: false,
	// 'off' | 'follow' (only when following the active note) | 'always'
	panMode: 'follow',
	debug: false,
	gradient: true,
	// 'native'    — only links touching the focused note get the highlight colour
	// 'highlight' — every link in the neighbourhood keeps it
	// 'blend'     — starts at the highlight colour and drifts back to the ordinary one
	linkColorMode: 'blend',
	colorFalloff: 0.75,
	// Each extra hop multiplies opacity by `falloff`, down to `minAlpha`.
	falloff: 0.6,
	minAlpha: 0.05,
	// Hops kept at full strength before any fading starts.
	fullRings: 1,
	// Bends the curve: 1 is plain geometric decay, >1 starts gently and then
	// bites, <1 drops immediately and trails off.
	curveShape: 1,
	notices: true,
};

/** Never walk further than this, however gentle the falloff. */
const DEPTH_CEILING = 16;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Blend two 0xRRGGBB colours, `t` of the way from `from` to `to`. Straight
 * per-channel interpolation, which is what the renderer's own tint easing does.
 */
function mixRgb(from, to, t) {
	if (typeof from !== 'number') return to;
	if (typeof to !== 'number' || t <= 0) return from;
	if (t >= 1) return to;
	const channel = (shift) => {
		const a = (from >> shift) & 255;
		const b = (to >> shift) & 255;
		return clamp(Math.round(a + (b - a) * t), 0, 255) << shift;
	};
	return channel(16) | channel(8) | channel(0);
}

/** Most matches a single search will report, so a broad query stays usable. */
const MAX_RESULTS = 60;

/**
 * The settings offered inside a graph pane, defined once so the settings tab and
 * the in-graph popover cannot drift apart.
 *
 * Deliberately excludes anything that rebuilds the panels — showPanel and
 * showSearch — since a control that destroys the popover it lives in is a poor
 * thing to click.
 */
const QUICK_OPTIONS = [
	{ key: 'gradient', name: 'Depth fade', type: 'toggle' },
	{ key: 'falloff', name: 'Falloff per hop', type: 'slider', min: 0.1, max: 0.95, step: 0.01 },
	{ key: 'curveShape', name: 'Curve shape', type: 'slider', min: 0.4, max: 2.5, step: 0.01 },
	{ key: 'fullRings', name: 'Hops at full strength', type: 'slider', min: 1, max: 4, step: 1 },
	{ key: 'minAlpha', name: 'Floor', type: 'slider', min: 0, max: 0.4, step: 0.01 },
	{
		key: 'linkColorMode',
		name: 'Link colour',
		type: 'dropdown',
		options: { blend: 'Drift back', highlight: 'Keep highlight', native: 'Obsidian default' },
	},
	{ key: 'colorFalloff', name: 'Colour drift per hop', type: 'slider', min: 0.1, max: 0.95, step: 0.01 },
	{
		key: 'followMode',
		name: 'Follow the active note',
		type: 'dropdown',
		options: { local: 'Local graphs', all: 'Every pane', off: 'Off' },
	},
	{
		key: 'panMode',
		name: 'Move the view to the focus',
		type: 'dropdown',
		options: { follow: 'When following', always: 'Any change', off: 'Off' },
	},
	{ key: 'searchInGraphOnly', name: 'Search only files in the graph', type: 'toggle' },
	{ key: 'showHistory', name: 'Show recent', type: 'toggle' },
	{ key: 'labelConnected', name: 'Name connected notes', type: 'toggle' },
	{ key: 'showAliases', name: 'Show aliases', type: 'toggle' },
	{ key: 'maxAliases', name: 'Aliases shown', type: 'slider', min: 1, max: 10, step: 1 },
	{ key: 'midArrows', name: 'Arrows in the middle of links', type: 'toggle' },
	{ key: 'arrowSize', name: 'Arrow size', type: 'slider', min: 0.25, max: 4, step: 0.05 },
	{ key: 'arrowDensity', name: 'Arrows per link', type: 'slider', min: 0, max: 1, step: 0.05 },
	{ key: 'doubleArrows', name: 'Double arrows both ways', type: 'toggle' },
	{ key: 'arrowMatchLinks', name: 'Arrows match link colour', type: 'toggle' },
	{ key: 'connexions', name: 'Style links by property', type: 'toggle' },
	{ key: 'arrowZoom', name: 'Arrow shrink with zoom', type: 'slider', min: 0, max: 1, step: 0.05 },
];

/** Ceiling on repeated arrows, so a long link cannot become a dotted line. */
const MAX_ARROWS_PER_LINK = 12;

/**
 * Connexions — styling a link by the property it was written in.
 *
 * A rule matches on a *kind*: either a real frontmatter property name, or one of
 * the four below for the links that have no property behind them. `(any)` is the
 * catch-all, and since the first matching rule wins it is only useful last.
 */
const KIND_ANY = '(any)';
const KIND_BODY = '(body)';
const KIND_EMBED = '(embed)';
const KIND_TAG = '(tag)';

const KIND_LABELS = {
	[KIND_ANY]: 'Any link',
	[KIND_BODY]: 'Written in the body',
	[KIND_EMBED]: 'Embedded (![[…]])',
	[KIND_TAG]: 'To a tag',
};

const SYMBOL_OPTIONS = {
	inherit: 'Leave the arrow alone',
	chevron: 'Chevron',
	triangle: 'Solid triangle',
	hollow: 'Hollow triangle',
	harpoon: 'Half arrow',
	double: 'Double chevron',
	none: 'No arrow',
};

const LINE_OPTIONS = {
	inherit: 'Leave the line alone',
	solid: 'Solid',
	dashed: 'Dashed',
	dotted: 'Dotted',
	hidden: 'Hidden, and pulling nothing',
};

const COLOR_OPTIONS = {
	inherit: 'Leave the colour alone',
	source: 'The note it starts from',
	target: 'The note it points to',
	custom: 'A colour of its own',
};

/** Fraction of one dash-and-gap that is actually drawn. */
const DASH_DUTY = { dashed: 0.6, dotted: 0.34 };
/** Dots run closer together than dashes, so one slider sets both. */
const DOT_PERIOD_RATIO = 0.45;
/** Ceiling on dashes per link, so a long one cannot cost hundreds of rectangles. */
const MAX_DASHES = 60;

const DEFAULT_RULE_COLOR = '#7c8cff';

/** Empty stand-in, so a missing row needs no branch at every call site. */
const NO_KINDS = [];

/** `#rrggbb` (or `#rgb`) to the 0xRRGGBB the renderer wants. Null if unparseable. */
function parseHexColor(text) {
	if (typeof text !== 'string') return null;
	let hex = text.trim().replace(/^#/, '');
	if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
	return parseInt(hex, 16);
}

/**
 * Inside the hanger the renderer uses: link containers 0, node circles and
 * highlight rings 1, labels 2 — and arrows 1 as well, tying with the circles, so
 * which lands on top comes down to insertion order. Half sits them cleanly above
 * the links and below everything belonging to a node.
 */
const ARROW_Z = 0.5;
const ARROW_Z_NATIVE = 1;

/** Most focused notes to list before summarising the rest. */
const MAX_FOCUS_ROWS = 50;

/** How many past focuses to remember, and how many of them to show. */
const HISTORY_KEEP = 25;
const HISTORY_SHOW = 8;

/**
 * Obsidian's search-query class, borrowed from a live instance.
 *
 * The parser is not exported anywhere, but the graph engine builds one per
 * query in `setQuery()` and keeps them on `engine.searchQueries`. Colour groups
 * count, so that array is populated whenever any are configured. Taking the
 * constructor from an existing instance gets the real thing — full native
 * syntax, `file:` and `path:` and `tag:` and `[property]` and quoted phrases and
 * boolean operators — instead of a reimplementation that would drift from it.
 *
 * Returns null when there is nothing to borrow from, and the caller falls back
 * to plain substring matching.
 */
function searchQueryClass(view) {
	const engine = view && (view.dataEngine || view.engine);
	const queries = engine && engine.searchQueries;
	if (!Array.isArray(queries)) return null;
	for (const entry of queries) {
		const instance = entry && entry.query;
		if (instance && typeof instance.match === 'function') return instance.constructor;
	}
	return null;
}

/** True if `r` looks like a GraphRenderer we know how to drive. */
function isGraphRenderer(r) {
	return !!r && Array.isArray(r.nodes) && Array.isArray(r.links) &&
		typeof r.queueRender === 'function' && typeof r.changed === 'function';
}

function displayName(id) {
	const leaf = String(id).split('/').pop();
	return leaf.endsWith('.md') ? leaf.slice(0, -3) : leaf;
}

class GraphFocusPlugin extends Plugin {
	async onload() {
		const stored = (await this.loadData()) || {};
		// 1.0.0 had one opacity per depth. Its depth-2 value is exactly the first
		// step of a geometric curve, so it carries over as the falloff rate.
		if (typeof stored.alphaDepth2 === 'number' && typeof stored.falloff !== 'number') {
			stored.falloff = stored.alphaDepth2;
		}
		delete stored.alphaDepth2;
		delete stored.alphaDepth3;
		delete stored.alphaDepth4;
		// 1.1.0 had a bare on/off for the highlight colour. Only "off" carries a
		// real preference; "on" is indistinguishable from the default, so it falls
		// through to whatever the current default mode is.
		if (stored.highlightLinkColor === false && !stored.linkColorMode) {
			stored.linkColorMode = 'native';
		}
		delete stored.highlightLinkColor;
		// 1.5 only restored the focus when the click landed on the active note.
		// 1.7 focuses whatever you click, which covers that case and does not
		// depend on working out which note counts as active.
		if (typeof stored.clickActiveRestores === 'boolean' && typeof stored.clickFocuses !== 'boolean') {
			stored.clickFocuses = stored.clickActiveRestores;
		}
		delete stored.clickActiveRestores;
		// 1.22 briefly listed connected notes in the panel. What was wanted was
		// their names drawn in the graph, so the switch carries over to that.
		if (typeof stored.showConnections === 'boolean' && typeof stored.labelConnected !== 'boolean') {
			stored.labelConnected = stored.showConnections;
		}
		delete stored.showConnections;
		delete stored.connectionsCollapsed;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

		/** renderer -> { lockIds, depths, sig, cleanups } */
		this.attached = new Map();
		/** Set once if our own code throws, so we stop making it worse. */
		this.broken = false;
		/** Undoes the shared node-prototype patch. Installed lazily, see patchNodeRender(). */
		this.nodeRenderRestore = null;
		/** Same, for the link prototype. See patchLinkRender(). */
		this.linkRenderRestore = null;
		/** Obsidian's search-query class once a pane has been able to supply it. */
		this.cachedQueryClass = null;
		/** Debounce for persisting the focus history. */
		this.historyTimer = null;
		/**
		 * Bumped whenever the metadata cache changes, so cached alias labels are
		 * recomputed then rather than on every frame.
		 */
		this.aliasEpoch = 0;
		/**
		 * The same idea for the link-kind index, but bumped *only* by the metadata
		 * cache. aliasEpoch also moves on every settings change, and rebuilding the
		 * whole vault's index because a slider moved would be absurd.
		 */
		this.metaEpoch = 0;
		/** path -> Map(target id -> kinds), built lazily. See linkKinds(). */
		this.linkKindMap = null;
		this.linkKindEpoch = -1;
		this.linkKindProps = [];
		const onMetaChange = () => { this.aliasEpoch++; this.metaEpoch++; };
		this.registerEvent(this.app.metadataCache.on('resolved', onMetaChange));
		this.registerEvent(this.app.metadataCache.on('changed', onMetaChange));

		this.addSettingTab(new GraphFocusSettingTab(this.app, this));

		this.addCommand({
			id: 'lock-hovered-node',
			name: 'Lock focus on hovered node',
			callback: () => this.lockHovered(false),
		});
		this.addCommand({
			id: 'add-hovered-node',
			name: 'Add hovered node to the focus',
			callback: () => this.lockHovered(true),
		});
		this.addCommand({
			id: 'lock-active-note',
			name: 'Lock focus on active note',
			callback: () => this.lockActiveNote(false),
		});
		this.addCommand({
			id: 'add-active-note',
			name: 'Add active note to the focus',
			callback: () => this.lockActiveNote(true),
		});
		this.addCommand({
			id: 'clear-focus',
			name: 'Clear focus lock',
			callback: () => this.clearAll(true),
		});
		this.addCommand({
			id: 'log-diagnostics',
			name: 'Log diagnostics to the console',
			callback: () => this.logDiagnostics(),
		});

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			try {
				this.onFileOpen(file);
			} catch (e) {
				console.error('Graph Focus: could not follow the active note', e);
			}
		}));

		this.app.workspace.onLayoutReady(() => {
			this.scan();
			this.onFileOpen(this.app.workspace.getActiveFile());
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => this.scan()));
		// A graph outside the workspace announces itself; without this it would
		// only be picked up by the 2-second backstop below. Confirmed working
		// against the Bases graph view, 2026-08-11.
		this.registerEvent(this.app.workspace.on('extra-graph-views-changed', () => this.scan()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			this.scan();
			try {
				this.onActiveLeafChange(leaf);
			} catch (e) {
				console.error('Graph Focus: could not follow the active leaf', e);
			}
		}));
		// Graph panes can be created without a layout event (e.g. a popout window
		// finishing its init), so sweep periodically as a backstop.
		this.registerInterval(window.setInterval(() => this.scan(), 2000));
	}

	onunload() {
		if (this.historyTimer) {
			window.clearTimeout(this.historyTimer);
			this.historyTimer = null;
			this.saveData(this.settings);
		}
		for (const key of ['nodeRenderRestore', 'linkRenderRestore']) {
			if (!this[key]) continue;
			try {
				this[key]();
			} catch (e) {
				console.error(`Graph Focus: failed to unpatch (${key})`, e);
			}
			this[key] = null;
		}
		for (const [renderer, state] of this.attached) {
			try {
				if (state.lockIds.length) {
					state.lockIds = [];
					renderer.highlightNode = null;
				}
				this.dropDashes(renderer);
				for (const undo of state.cleanups) undo();
				// setData is unwrapped by the line above, so this puts back any link
				// a rule was hiding rather than leaving the graph short of edges
				// until something else happens to rebuild it.
				if (state.rawData && state.hideSig) renderer.setData(state.rawData);
				renderer.changed();
			} catch (e) {
				console.error('Graph Focus: failed to detach cleanly', e);
			}
		}
		this.attached.clear();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Alias labels are cached against this counter, and the settings that
		// shape them live here — cheaper to recompute them once after any change
		// than to work out which settings could have mattered.
		this.aliasEpoch++;
		const hideSig = this.hideSignature();
		for (const [renderer, state] of this.attached) {
			this.syncPanel(renderer, state);
			// Hiding a link changes the data the layout runs on, so it needs a
			// rebuild — but only when the set of hidden links actually changed.
			// setData restarts the simulation, which would be an appalling thing
			// to do on every tick of a slider.
			if (state.rawData && state.hideSig !== hideSig) {
				this.guard(() => renderer.setData(state.rawData));
			}
			renderer.changed();
		}
	}

	/**
	 * Bring a pane's panel into line with the settings, so toggling one takes
	 * effect on the panes already open rather than only on the next one.
	 */
	syncPanel(renderer, state) {
		if (!this.settings.showGraphSettings) {
			if (state.quick) {
				state.quick.destroy();
				state.quick = null;
			}
		} else if (!state.quick) {
			state.quick = new QuickSettings(this, renderer);
		} else {
			// Only when the chosen options change. A slider fires onChange for every
			// pixel of a drag, and each one lands here — re-rendering would destroy
			// the slider under the cursor mid-drag.
			state.quick.syncKeys();
		}

		if (!this.settings.showPanel) {
			if (state.panel) {
				state.panel.destroy();
				state.panel = null;
			}
			return;
		}
		if (!state.panel) state.panel = new FocusPanel(this, renderer, state);
		else state.panel.rebuild();
	}

	/* ---------------------------------------------------------------- panes */

	/** Every live graph pane in the workspace, with enough context to tell them apart. */
	liveGraphs() {
		const out = [];
		const add = (leaf, view) => {
			const renderer = view && view.renderer;
			if (!isGraphRenderer(renderer)) return;
			if (out.some((graph) => graph.renderer === renderer)) return;
			const type = typeof view.getViewType === 'function' ? view.getViewType() : '';
			out.push({ leaf, view, renderer, type });
		};

		this.app.workspace.iterateAllLeaves((leaf) => add(leaf, leaf && leaf.view));

		// Graphs that are not in a workspace leaf at all — the Bases graph view
		// builds one inside a Bases container, so iterateAllLeaves cannot see it.
		// Absent list, stale entries and destroyed renderers are all expected;
		// isGraphRenderer is what keeps a dead one out.
		const extra = this.app.__extraGraphViews;
		if (Array.isArray(extra)) {
			for (const view of extra.slice()) add(view && view.leaf, view);
		}

		return out;
	}

	/** Every live graph renderer (global graph and local graph). */
	liveRenderers() {
		return this.liveGraphs().map((graph) => graph.renderer);
	}

	scan() {
		if (this.broken) return;
		const graphs = this.liveGraphs();
		const fresh = [];
		for (const graph of graphs) {
			if (this.attached.has(graph.renderer)) continue;
			this.attach(graph.renderer, graph.view);
			fresh.push(graph);
		}
		// Drop panes that have been closed so their state can be collected.
		const live = graphs.map((graph) => graph.renderer);
		for (const renderer of Array.from(this.attached.keys())) {
			if (!live.includes(renderer)) this.attached.delete(renderer);
		}
		// A pane opened just now has missed every file-open event so far. Only
		// new panes, so this never overrides a focus set by hand.
		if (fresh.length) this.followInto(fresh, this.app.workspace.getActiveFile());
	}

	/**
	 * Replace a renderer property with a wrapper that survives reassignment:
	 * `initGraphics()` rebuilds these functions whenever the canvas is recreated,
	 * and the setter re-wraps whatever it is handed.
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

	attach(renderer, view) {
		if (this.attached.has(renderer)) return;

		const state = {
			lockIds: [],
			lockSet: new Set(),
			hovered: null,
			view: view || null,
			panel: null,
			quick: null,
			// Node id the view is easing toward, how long it has been trying, the
			// node's last position, and how many frames it has been settled for.
			neighbourIds: null,
			neighbourSig: '',
			panTarget: null,
			panFrames: 0,
			panNodeX: NaN,
			panNodeY: NaN,
			panSettled: 0,
			// Shape of the pane's data, to notice a rebuild, and when the focus
			// was last set, so only a rebuild that follows one re-aims the view.
			graphSig: null,
			focusAt: 0,
			depths: null,
			sig: '',
			cleanups: [],
		};
		this.attached.set(renderer, state);
		const self = this;

		// Per-frame hook. Re-assert the lock and advance the pan before the
		// renderer reads either, then repaint the deeper rings once it has
		// finished drawing.
		this.wrapProperty(renderer, 'renderCallback', (original) => function () {
			// Not gated on a focus: arrows and connexions are plain rendering options.
			if (self.settings.midArrows || self.settings.connexions) {
				self.guard(() => self.patchLinkRender(renderer));
			}
			if (state.lockIds.length) self.guard(() => self.assertLock(renderer, state));
			if (state.lockIds.length || self.settings.showAliases) {
				self.guard(() => self.patchNodeRender(renderer));
			}
			if (state.lockIds.length) self.guard(() => self.updateNeighbours(renderer, state));
			if (state.lockIds.length) self.guard(() => self.watchRebuild(renderer, state));
			if (state.panTarget) self.guard(() => self.stepPan(renderer, state));
			const result = original.apply(this, arguments);
			if (state.lockIds.length) self.guard(() => self.paintGradient(renderer, state));
			return result;
		}, state.cleanups);

		// A link a rule hides has to be gone from the data, not merely invisible:
		// the layout worker only knows what setData hands it, so a hidden line
		// left in place would keep pulling its two notes together. The raw data is
		// kept so the filter can be re-applied when the rules change.
		this.wrapProperty(renderer, 'setData', (original) => function (data) {
			state.rawData = data;
			state.hideSig = self.hideSignature();
			let filtered = data;
			try {
				filtered = self.hideLinks(data);
			} catch (e) {
				console.error('Graph Focus: could not hide links, showing them all', e);
			}
			return original.call(this, filtered);
		}, state.cleanups);

		// Pointer handlers set highlightNode / mouseX / mouseY. Let them run so
		// hover previews still work, then immediately restore the lock — doing it
		// in the same tick avoids a one-frame flicker.
		//
		// They are also the only place the genuinely hovered node is visible.
		// Once a lock is active we overwrite highlightNode every frame, so it can
		// no longer answer "what is the cursor on?" — hence state.hovered.
		this.wrapProperty(renderer, 'onPointerOver', (original) => function (node) {
			state.hovered = node || null;
			const result = original.apply(this, arguments);
			if (state.lockIds.length) self.guard(() => self.assertLock(renderer, state));
			return result;
		}, state.cleanups);

		this.wrapProperty(renderer, 'onPointerOut', (original) => function () {
			state.hovered = null;
			const result = original.apply(this, arguments);
			if (state.lockIds.length) self.guard(() => self.assertLock(renderer, state));
			return result;
		}, state.cleanups);

		// Registered whether or not a panel exists yet, since the setting can be
		// turned on later and this reads state.panel at teardown time.
		state.cleanups.push(() => {
			if (state.panel) state.panel.destroy();
			state.panel = null;
			if (state.quick) state.quick.destroy();
			state.quick = null;
		});
		if (this.settings.showPanel) state.panel = new FocusPanel(this, renderer, state);
		if (this.settings.showGraphSettings) state.quick = new QuickSettings(this, renderer);

		// Modifier+click locks instead of opening the note; adding the second
		// modifier extends the focus rather than replacing it.
		this.wrapProperty(renderer, 'onNodeClick', (original) => function (event, id) {
			if (self.settings.clickToLock && self.matchesModifier(event)) {
				if (self.matchesAddModifier(event)) self.toggleInFocus(renderer, id);
				else self.toggleLock(renderer, id);
				return;
			}
			// A plain click opens the note, so let the focus follow the same click.
			// That covers coming back to the note you already have open, which is
			// the case nothing else reaches: it navigates nowhere, fires no
			// file-open, and would otherwise strand the focus wherever you last
			// put it.
			if (self.settings.debug) {
				console.log('[Graph Focus] node click', {
					id,
					paneHome: self.homeId(renderer),
					activeFile: (self.app.workspace.getActiveFile() || {}).path || null,
					focused: (self.attached.get(renderer) || { lockIds: [] }).lockIds.slice(),
					clickFocuses: self.settings.clickFocuses,
				});
			}
			if (self.settings.clickFocuses) {
				self.guard(() => self.focusFromClick(renderer, id));
			}
			return original.apply(this, arguments);
		}, state.cleanups);
	}

	matchesModifier(event) {
		if (!event) return false;
		switch (this.settings.clickModifier) {
			case 'shift': return !!event.shiftKey;
			case 'ctrl': return !!(event.ctrlKey || event.metaKey);
			default: return !!event.altKey;
		}
	}

	/**
	 * The extra key that turns a focus click into an add-to-focus click. Shift,
	 * unless Shift is already the focus modifier, in which case Alt.
	 */
	addModifierName() {
		return this.settings.clickModifier === 'shift' ? 'Alt' : 'Shift';
	}

	matchesAddModifier(event) {
		if (!event) return false;
		return this.addModifierName() === 'Alt' ? !!event.altKey : !!event.shiftKey;
	}

	/**
	 * Give every focused node the full native highlight, not just the newest one.
	 *
	 * A node's render() decides everything from one flag: `getHighlightNode() ===
	 * this`. That flag draws the ring, forces the label to full opacity, exempts
	 * it from viewport culling, counter-scales it so it stays readable when
	 * zoomed out, and picks the highlight fill. `highlightNode` is a single slot,
	 * so only one node can set it — but the flag is computed per node, during
	 * that node's own render call.
	 *
	 * So instead of rebuilding the ring and label by hand out of PIXI objects the
	 * renderer would then fight us over, we let each focused node believe it is
	 * the highlighted one for the duration of its own render, and put the
	 * renderer straight back afterwards. Everything is drawn by Obsidian's own
	 * code, in the right theme colours, and cleaned up by it too.
	 *
	 * The patch is on the node prototype, which is shared by every pane, so it
	 * checks the pane the node belongs to before doing anything.
	 */
	/**
	 * The ids one link from the focus, recomputed only when the focus or the
	 * pane's links change. Read off `renderer.links` so it matches what the pane
	 * actually draws.
	 */
	updateNeighbours(renderer, state) {
		const signature = `${renderer.links.length}:${state.lockIds.join('|')}`;
		if (state.neighbourSig === signature) return;
		const focused = new Set(state.lockIds);
		const found = new Set();
		for (const edge of renderer.links) {
			if (!edge.source || !edge.target) continue;
			const a = edge.source.id;
			const b = edge.target.id;
			if (focused.has(a) && !focused.has(b)) found.add(b);
			else if (focused.has(b) && !focused.has(a)) found.add(a);
		}
		state.neighbourIds = found;
		state.neighbourSig = signature;
	}

	/**
	 * Move every arrow to the midpoint of its link and keep it visible.
	 *
	 * The renderer fades arrows with `clamp(2 * (scale - 0.3), 0, 1)`, so below a
	 * scale of 0.3 they are fully transparent — which is most of the time on a
	 * vault-sized graph. It also parks them against the target node, where they
	 * sit under the node itself once zoomed out.
	 *
	 * Same timing constraint as the labels: the renderer sets `visible` every
	 * frame before the single draw at the end of renderCallback, so this has to
	 * happen inside the link's own render, not after the frame.
	 */
	/**
	 * Which properties every link in the vault was written in.
	 *
	 * `metadataCache` already holds this: `frontmatterLinks` records a `key` for
	 * each link found in the frontmatter — `related.0`, or `contact.email.0` for
	 * a nested one — so the property is the first segment. Nothing is read from
	 * disk and there is no index to persist; the whole vault is a few Map writes
	 * per note, done once per change to the cache and only when a graph asks.
	 */
	linkKinds() {
		if (this.linkKindMap && this.linkKindEpoch === this.metaEpoch) return this.linkKindMap;

		const map = new Map();
		const props = new Set();
		const cache = this.app.metadataCache;

		const add = (from, to, kind) => {
			if (!to) return;
			let row = map.get(from);
			if (!row) { row = new Map(); map.set(from, row); }
			let kinds = row.get(to);
			if (!kinds) { kinds = []; row.set(to, kinds); }
			if (kinds.indexOf(kind) === -1) kinds.push(kind);
		};

		// Node ids are file paths, so a link has to be resolved the way Obsidian
		// resolved it. An unresolved one is a node too, under the text written —
		// which is what getFirstLinkpathDest returning null leaves us with.
		const resolve = (link, from) => {
			if (!link) return null;
			const target = String(link).split('#')[0].split('|')[0].trim();
			// A bare `#heading` points back at the note itself: no edge.
			if (!target) return null;
			const dest = cache.getFirstLinkpathDest(target, from);
			return dest ? dest.path : target;
		};

		for (const file of this.app.vault.getMarkdownFiles()) {
			const meta = cache.getFileCache(file);
			if (!meta) continue;
			for (const entry of meta.frontmatterLinks || []) {
				const prop = String(entry.key || '').split('.')[0];
				if (!prop) continue;
				props.add(prop);
				add(file.path, resolve(entry.link, file.path), prop);
			}
			for (const entry of meta.links || []) {
				add(file.path, resolve(entry.link, file.path), KIND_BODY);
			}
			for (const entry of meta.embeds || []) {
				add(file.path, resolve(entry.link, file.path), KIND_EMBED);
			}
		}

		this.linkKindMap = map;
		this.linkKindProps = Array.from(props).sort((a, b) => a.localeCompare(b));
		this.linkKindEpoch = this.metaEpoch;
		return map;
	}

	/** Every frontmatter property that holds a link somewhere in the vault. */
	linkProperties() {
		this.linkKinds();
		return this.linkKindProps;
	}

	/**
	 * The kinds behind one edge, both ways round.
	 *
	 * Deliberately undirected. A line is one object however many links produced
	 * it, and for a mutual link the renderer keeps whichever of the two edges
	 * sorts first — so reading only the forward direction would give the same
	 * pair of notes a different look depending on which edge survived. The cost
	 * is that a rule for `type of` also catches the link when it is the *other*
	 * note that declares it, which is the right answer for a line neither end
	 * owns.
	 */
	kindsFor(sourceId, targetId) {
		// Tag nodes are not files and have no frontmatter behind them.
		if (typeof targetId === 'string' && targetId.charAt(0) === '#') return [KIND_TAG];
		const map = this.linkKinds();
		const out = map.get(sourceId);
		const forward = out ? out.get(targetId) : null;
		const back = map.get(targetId);
		const reverse = back ? back.get(sourceId) : null;
		if (!reverse) return forward || NO_KINDS;
		if (!forward) return reverse;
		return forward.concat(reverse.filter((kind) => forward.indexOf(kind) === -1));
	}

	/** The rule governing an edge, or null. First match in the list wins. */
	connexionFor(edge) {
		if (!edge.source || !edge.target) return null;
		return this.ruleForIds(edge.source.id, edge.target.id);
	}

	/**
	 * Apply a rule's colour and line pattern. Runs inside the link's own render,
	 * after the renderer has drawn it, so anything written here survives the
	 * frame; `styleArrow` runs immediately after and reads `edge.gfConn`.
	 */
	styleLink(renderer, edge) {
		const rule = this.connexionFor(edge);
		edge.gfConn = rule;
		const line = edge.line;
		if (!line) return;

		// Native eases the tint toward colors.line every frame, so this is a snap
		// rather than a set — same as the depth gradient does.
		let tint = null;
		if (rule && rule.color && rule.color !== 'inherit') {
			if (rule.color === 'custom') {
				tint = parseHexColor(rule.customColor);
			} else {
				const node = rule.color === 'target' ? edge.target : edge.source;
				const fill = node && typeof node.getFillColor === 'function' ? node.getFillColor() : null;
				if (fill && typeof fill.rgb === 'number') tint = fill.rgb;
			}
		}
		edge.gfConnTint = tint;
		if (tint !== null) line.tint = tint;

		const pattern = rule && DASH_DUTY[rule.line] ? rule.line : null;
		this.styleDashes(renderer, edge, pattern);
	}

	/**
	 * Dashes, drawn as one PIXI.Graphics per patterned link, in the unit space
	 * the link's own container already provides.
	 *
	 * `edge.line` is a `PIXI.Sprite(Texture.WHITE)` — a stretched rectangle, so
	 * no pattern can be drawn into it. It is hidden and this is drawn over it
	 * instead. The trick that keeps it cheap is the one the repeated arrows use:
	 * the geometry is one rectangle per dash in a space where a dash-and-gap is
	 * exactly one unit wide and the line is one unit tall, then scaled to the
	 * link. So it only has to be rebuilt when the *number* of dashes changes,
	 * not as the link moves or the zoom changes.
	 */
	styleDashes(renderer, edge, pattern) {
		const line = edge.line;
		const dash = edge.gfDash;
		if (!pattern) {
			// No restoring to do: the renderer rewrites line.visible every frame.
			edge.gfLineShown = line.visible;
			if (dash) dash.visible = false;
			return;
		}

		// What the renderer decided about this link, before we hide it. The arrow
		// follows the line, and would otherwise disappear along with it.
		const wanted = line.visible;
		edge.gfLineShown = wanted;
		line.visible = false;
		if (!wanted) {
			if (dash) dash.visible = false;
			return;
		}

		const graphics = dash || this.makeDashGraphics(edge);
		// Nothing to draw with: better a solid line than no line.
		if (!graphics) { line.visible = true; return; }

		const length = Math.max(0, line.width);
		const scale = renderer.scale || 1;
		const period = clamp(this.settings.dashPeriod || 14, 4, 60)
			* (pattern === 'dotted' ? DOT_PERIOD_RATIO : 1);
		// From the length it *looks*, so the pattern holds its size on screen.
		const count = clamp(Math.round(length * scale / period), 1, MAX_DASHES);
		const duty = DASH_DUTY[pattern];
		if (edge.gfDashCount !== count || edge.gfDashDuty !== duty) {
			this.drawDashes(graphics, count, duty);
			edge.gfDashCount = count;
			edge.gfDashDuty = duty;
		}

		// The container is already placed at the source node and rotated along the
		// link, and the native line runs from x = 0 to x = width inside it.
		graphics.visible = true;
		graphics.x = 0;
		graphics.y = 0;
		graphics.scale.x = length / count;
		graphics.scale.y = line.height || 1;
		graphics.tint = line.tint;
		graphics.alpha = line.alpha;
	}

	drawDashes(graphics, count, duty) {
		graphics.clear();
		graphics.beginFill(0xffffff);
		for (let i = 0; i < count; i++) graphics.drawRect(i, -0.5, duty, 1);
		graphics.endFill();
	}

	/**
	 * A Graphics object for one link's dashes, borrowing the class from the arrow
	 * the renderer already made — PIXI is not exported anywhere a plugin can
	 * reach, but every link carries an instance of the class we need.
	 */
	makeDashGraphics(edge) {
		const template = edge.arrow;
		const container = edge.px;
		if (!template || !container || typeof container.addChild !== 'function') return null;
		const Graphics = Object.getPrototypeOf(template).constructor;
		let graphics;
		try {
			graphics = new Graphics();
		} catch (e) {
			console.error('Graph Focus: could not make a dashed line', e);
			return null;
		}
		graphics.eventMode = 'none';
		container.addChild(graphics);
		edge.gfDash = graphics;
		return graphics;
	}

	/** Destroy the dash objects belonging to one renderer's links. */
	dropDashes(renderer) {
		for (const edge of renderer.links || []) {
			if (!edge.gfDash) continue;
			try {
				if (edge.gfDash.parent) edge.gfDash.parent.removeChild(edge.gfDash);
				edge.gfDash.destroy();
			} catch (e) {
				console.error('Graph Focus: could not remove a dashed line', e);
			}
			edge.gfDash = null;
			delete edge.gfDashCount;
			delete edge.gfDashDuty;
			if (edge.line) edge.line.visible = true;
		}
	}

	/**
	 * Which links the rules currently hide, as a string. Comparing this is what
	 * decides whether a settings change is worth a graph rebuild.
	 */
	hideSignature() {
		if (!this.settings.connexions) return '';
		const rules = this.settings.connexionRules;
		if (!Array.isArray(rules)) return '';
		const hidden = [];
		for (const rule of rules) {
			if (!rule || rule.enabled === false) continue;
			// Order matters: an earlier rule matching the same property takes the
			// link, so it is only hidden if the hiding rule is the one that wins.
			hidden.push(rule.line === 'hidden' ? rule.property : `~${rule.property}`);
		}
		return hidden.join('|');
	}

	/**
	 * A copy of the graph data with the hidden links taken out.
	 *
	 * Hiding is done here rather than by setting `visible = false` because the
	 * layout worker is fed from this object: a link left in it goes on pulling
	 * its two notes together whether or not anything is drawn. Copied rather than
	 * mutated — the engine keeps this object, and a link removed from its copy
	 * would never come back when the rule does.
	 */
	hideLinks(data) {
		if (!this.hideSignature()) return data;
		const nodes = data && data.nodes;
		if (!nodes) return data;

		let touched = false;
		const out = Object.create(null);
		for (const id of Object.keys(nodes)) {
			const node = nodes[id];
			const links = node && node.links;
			if (!links) { out[id] = node; continue; }

			let kept = null;
			for (const target of Object.keys(links)) {
				const rule = this.ruleForIds(id, target);
				if (!rule || rule.line !== 'hidden') continue;
				if (!kept) kept = Object.assign(Object.create(null), links);
				delete kept[target];
			}
			if (!kept) { out[id] = node; continue; }
			out[id] = Object.assign({}, node, { links: kept });
			touched = true;
		}

		return touched ? Object.assign({}, data, { nodes: out }) : data;
	}

	/** The rule governing the link between two node ids, or null. */
	ruleForIds(sourceId, targetId) {
		const rules = this.settings.connexionRules;
		if (!this.settings.connexions || !Array.isArray(rules) || !rules.length) return null;
		const kinds = this.kindsFor(sourceId, targetId);
		for (const rule of rules) {
			if (!rule || rule.enabled === false) continue;
			if (rule.property === KIND_ANY || kinds.indexOf(rule.property) !== -1) return rule;
		}
		return null;
	}

	patchLinkRender(renderer) {
		if (this.linkRenderRestore) return;
		const sample = renderer.links[0];
		const proto = sample && Object.getPrototypeOf(sample);
		if (!proto || typeof proto.render !== 'function') return;

		const self = this;
		const original = proto.render;
		proto.render = function () {
			const result = original.apply(this, arguments);
			// Runs whether or not the option is on, so that switching it off can
			// put the original single-chevron geometry back. styleLink comes
			// first: it settles which rule applies, and the arrow reads it.
			try {
				self.styleLink(this.renderer, this);
			} catch (e) {
				console.error('Graph Focus: could not style a link', e);
			}
			try {
				self.styleArrow(this.renderer, this);
			} catch (e) {
				console.error('Graph Focus: could not style an arrow', e);
			}
			return result;
		};

		this.linkRenderRestore = () => { proto.render = original; };
	}

	/**
	 * Redraw a link's arrow object as `count` chevrons, `step` apart in its own
	 * local space.
	 *
	 * Repeating arrows along a link would normally mean one PIXI object each, and
	 * a lifetime to manage for every one of them. Drawing them all into the arrow
	 * the renderer already made avoids that entirely.
	 *
	 * Chevron shape copied from the renderer's own: (0,0) (-4,-2) (-3,0) (-4,2).
	 *
	 * With `both`, every position gets a second chevron facing the other way,
	 * the two placed tip-outward and tail-to-tail so the pair straddles the
	 * position and reads as one double-headed arrow rather than two crossing
	 * ones. The single-head case keeps its tip exactly on the position.
	 *
	 * `shape` picks the head a connexion rule asked for. Every one of them is
	 * asymmetric along the link, so it still says which way the link runs — a
	 * symbol that reads the same both ways would throw the direction away.
	 */
	drawChevrons(arrow, count, step, both, shape) {
		const kind = shape || 'chevron';
		const hollow = kind === 'hollow';
		arrow.clear();
		// A hollow head is the outline of the solid one. Width is in the arrow's
		// own units, which its scale then takes to screen size along with the rest.
		if (hollow) arrow.lineStyle(0.7, 0xffffff, 1);
		else arrow.beginFill(0xffffff);

		// `dir` 1 points along the link, -1 back down it; the body always runs
		// behind the tip.
		const chevron = (tip, dir) => {
			arrow.moveTo(tip, 0);
			arrow.lineTo(tip - 4 * dir, -2);
			arrow.lineTo(tip - 3 * dir, 0);
			arrow.lineTo(tip - 4 * dir, 2);
		};
		const triangle = (tip, dir) => {
			arrow.moveTo(tip, 0);
			arrow.lineTo(tip - 4.5 * dir, -2.4);
			arrow.lineTo(tip - 4.5 * dir, 2.4);
			arrow.lineTo(tip, 0);
		};
		const head = (tip, dir) => {
			switch (kind) {
				case 'triangle':
				case 'hollow':
					triangle(tip, dir);
					break;
				// Half a head: one barb only, so it reads as a lighter link
				// without losing the direction.
				case 'harpoon':
					arrow.moveTo(tip, 0);
					arrow.lineTo(tip - 5 * dir, -2.8);
					arrow.lineTo(tip - 3.4 * dir, 0);
					break;
				case 'double':
					chevron(tip, dir);
					chevron(tip - 3.2 * dir, dir);
					break;
				default:
					chevron(tip, dir);
			}
		};

		for (let i = 0; i < count; i++) {
			const x = i * step;
			if (both) {
				head(x + 4, 1);
				head(x - 4, -1);
			} else {
				head(x, 1);
			}
		}
		if (!hollow) arrow.endFill();
	}

	styleArrow(renderer, edge) {
		const arrow = edge.arrow;
		if (!arrow || !renderer) return;

		// The head a connexion rule asked for, if any. Kept separate from where
		// the arrow is drawn: a rule can change the symbol whether or not the
		// mid-link placement is on.
		const rule = edge.gfConn;
		const symbol = rule && rule.symbol && rule.symbol !== 'inherit' ? rule.symbol : null;
		if (symbol === 'none') {
			arrow.visible = false;
			return;
		}
		const shape = symbol || 'chevron';

		// Switched off: put the single chevron back, since the renderer draws that
		// geometry once at creation and would never restore it itself. A rule's
		// symbol still applies, in Obsidian's own position.
		if (!this.settings.midArrows) {
			if (edge.gfArrowCount !== undefined || edge.gfArrowShape !== shape) {
				this.drawChevrons(arrow, 1, 0, false, shape);
				delete edge.gfArrowCount;
				delete edge.gfArrowStep;
				delete edge.gfArrowBoth;
				edge.gfArrowShape = shape;
			}
			if (arrow.zIndex !== ARROW_Z_NATIVE) arrow.zIndex = ARROW_Z_NATIVE;
			return;
		}

		const source = edge.source;
		const target = edge.target;
		// Obsidian's own arrows toggle still wins.
		if (!source || !target || !renderer.fShowArrow) return;

		// A mutual link is two edges, and the renderer keeps only one of the two
		// lines: `!(source.reverse[target.id] && source.id.localeCompare(target.id) < 0)`.
		// The arrow follows the line's `visible`, so the losing edge's arrow is
		// hidden too — which is why a link both notes make used to show a single
		// head, claiming a direction it does not have. The surviving edge draws
		// both heads instead, and the hidden one still has nothing to draw.
		const mutual = !!source.reverse
			&& source.id !== target.id
			&& Object.prototype.hasOwnProperty.call(source.reverse, target.id);
		const both = mutual && this.settings.doubleArrows !== false;

		const dx = target.x - source.x;
		const dy = target.y - source.y;
		const length = Math.sqrt(dx * dx + dy * dy);
		arrow.rotation = Math.atan2(dy, dx);
		arrow.pivot.set(0, 0);
		// Only on a change: PIXI's zIndex setter marks the parent for re-sorting,
		// and the hanger sorts every frame. Assigning it blindly would re-sort
		// every child of the graph on every frame.
		if (arrow.zIndex !== ARROW_Z) arrow.zIndex = ARROW_Z;

		// The renderer sizes arrows at `2√lineSizeMult / scale`. Since the hanger
		// is itself scaled by `scale`, that cancels out: arrows hold a constant
		// size on screen however far you zoom. Nodes do not — they use
		// `√(1/scale)`, so they shrink as `√scale`, which is why arrows appear to
		// grow relative to everything else on the way out.
		//
		// The exponent on `1/scale` is what picks the behaviour: 1 is Obsidian's
		// constant-on-screen, 0.5 is exactly the nodes' law, 0 pins arrows to the
		// graph. The slider runs across that range.
		const scale = renderer.scale || 1;
		const zoomFollow = clamp(this.settings.arrowZoom || 0, 0, 1);
		const size = 2 * Math.sqrt(renderer.fLineSizeMult || 1)
			* Math.pow(1 / scale, 1 - zoomFollow)
			* (this.settings.arrowSize || 1);
		arrow.scale.x = size;
		arrow.scale.y = size;

		// How many arrows the link earns, from how long it *looks* — screen length,
		// not world length, so the count does not swing about with the zoom. The
		// gap is in screen pixels and owes nothing to the arrow's size, so making
		// arrows bigger no longer spreads them out and thins them.
		const density = clamp(this.settings.arrowDensity || 0, 0, 1);
		const gap = 200 - 180 * density;
		let count = 1;
		if (density > 0 && gap > 0) {
			count = clamp(Math.round(length * scale / gap), 1, MAX_ARROWS_PER_LINK);
		}

		// Then divide the link into that many equal segments and put one arrow in
		// the middle of each. At a count of one that is the midpoint, which is
		// exactly the single-arrow case. Spread across the whole link rather than
		// bunched in a fixed-length run at its centre.
		const step = count > 0 && size > 0 ? (length / count) / size : 0;
		// Geometry only depends on the count and the local step, and rebuilding it
		// is the expensive part — so tolerate small drift rather than redrawing
		// every link every frame as the simulation nudges things about.
		const settled = edge.gfArrowStep > 0
			&& Math.abs(step - edge.gfArrowStep) / edge.gfArrowStep < 0.02;
		if (edge.gfArrowCount !== count || edge.gfArrowBoth !== both
			|| edge.gfArrowShape !== shape || !settled) {
			this.drawChevrons(arrow, count, step, both, shape);
			edge.gfArrowCount = count;
			edge.gfArrowStep = step;
			edge.gfArrowBoth = both;
			edge.gfArrowShape = shape;
		}

		const lead = 0.5 / count;
		arrow.x = source.x + dx * lead;
		arrow.y = source.y + dy * lead;

		// Matching the link means picking up whatever the link ended up as —
		// including the highlight colour and its drift with depth — rather than
		// the single flat colors.arrow the renderer would use.
		const lineTint = edge.line && typeof edge.line.tint === 'number' ? edge.line.tint : null;
		if (this.settings.arrowMatchLinks && lineTint !== null) {
			arrow.tint = lineTint;
		} else {
			const arrowColor = (renderer.colors || {}).arrow;
			if (arrowColor && typeof arrowColor.rgb === 'number') arrow.tint = arrowColor.rgb;
		}

		// Follow the line: same fade, same culling, same bidirectional de-duping
		// the renderer already worked out for it. gfLineShown rather than
		// line.visible, because a dashed link's line is hidden on purpose and its
		// arrow must not go with it.
		if (edge.line) {
			arrow.visible = edge.gfLineShown !== undefined ? edge.gfLineShown : edge.line.visible;
			arrow.alpha = edge.line.alpha;
		} else {
			arrow.visible = true;
			arrow.alpha = 1;
		}
	}

	/**
	 * A note's aliases, or null. `parseFrontMatterAliases` is public API, so the
	 * plugin agrees with Obsidian about what counts as an alias — `alias` and
	 * `aliases`, string or list — rather than reading frontmatter itself.
	 */
	aliasesFor(id) {
		const file = this.app.vault.getAbstractFileByPath(id);
		// Tags and unresolved links are nodes without files.
		if (!file || typeof obsidian.parseFrontMatterAliases !== 'function') return null;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;
		const aliases = obsidian.parseFrontMatterAliases(cache.frontmatter);
		return aliases && aliases.length ? aliases : null;
	}

	/**
	 * List a node's aliases under its name.
	 *
	 * The label is a PIXI.Text anchored at (0.5, 0) with centred alignment, so
	 * extra lines simply stack under the name and stay centred — no second object
	 * and no layout of our own.
	 *
	 * Setting `.text` rebuilds the label's texture, so this recomputes only when
	 * the setting changes or the metadata cache says something did. The renderer
	 * sets the content once at creation and never revisits it, so a value written
	 * here survives without being reapplied per frame.
	 */
	applyAliases(node) {
		const text = node.text;
		if (!text) return;
		const wanted = !!this.settings.showAliases;
		if (node.gfAliasEpoch === this.aliasEpoch && node.gfAliasOn === wanted) return;
		node.gfAliasEpoch = this.aliasEpoch;
		node.gfAliasOn = wanted;

		const base = typeof node.getDisplayText === 'function' ? node.getDisplayText() : text.text;
		let next = base;
		if (wanted) {
			const aliases = this.aliasesFor(node.id);
			if (aliases) {
				const limit = clamp(Math.round(this.settings.maxAliases || 1), 1, 10);
				next = [base].concat(aliases.slice(0, limit)).join('\n');
			}
		}
		if (text.text !== next) text.text = next;
	}

	patchNodeRender(renderer) {
		if (this.nodeRenderRestore) return;
		const sample = renderer.nodes[0];
		const proto = sample && Object.getPrototypeOf(sample);
		if (!proto || typeof proto.render !== 'function') return;

		const self = this;
		const original = proto.render;
		proto.render = function () {
			const state = this.renderer && self.attached.get(this.renderer);
			// Aliases are independent of any focus, so they are applied before the
			// early exit rather than alongside the focus work below.
			if (self.settings.showAliases || this.gfAliasOn) {
				try {
					self.applyAliases(this);
				} catch (e) {
					console.error('Graph Focus: could not label aliases', e);
				}
			}
			if (!state || !state.lockIds.length) return original.apply(this, arguments);

			const impersonate = state.lockIds.length > 1 &&
				state.lockSet && state.lockSet.has(this.id) &&
				this.renderer.getHighlightNode() !== this;

			let result;
			if (impersonate) {
				const node = this;
				const owner = this.renderer;
				// Instance property shadowing the prototype method, removed below.
				owner.getHighlightNode = function () { return node; };
				try {
					result = original.apply(this, arguments);
				} finally {
					delete owner.getHighlightNode;
				}
			} else {
				result = original.apply(this, arguments);
			}

			// Naming the neighbours has to happen here, not in paintGradient.
			// The actual draw is the `px.render()` at the end of renderCallback,
			// after every node has rendered — so a label forced visible *after*
			// that is overwritten by the next frame before it is ever drawn.
			// Alpha survives that because the renderer recomputes it from
			// `fadeAlpha`, which we set; visibility has no such input.
			if (!impersonate && self.settings.labelConnected &&
					state.neighbourIds && state.neighbourIds.has(this.id)) {
				self.forceLabel(this.renderer, this);
			}
			return result;
		};

		this.nodeRenderRestore = () => { proto.render = original; };
	}

	/** Run our own code without ever breaking the host render loop. */
	guard(fn) {
		try {
			fn();
		} catch (e) {
			this.broken = true;
			console.error('Graph Focus: disabled after an internal error', e);
			new Notice('Graph Focus hit an error and stopped. Check the console.');
			this.clearAll(false);
		}
	}

	/* ----------------------------------------------------------------- lock */

	/**
	 * The note a pane considers "home". A local graph view is a FileView and
	 * carries its own centre file, which is both more reliable than the
	 * workspace's active file and closer to what the centre node means — the two
	 * can disagree, e.g. when the pane is bound to a file you have navigated away
	 * from. Global graph panes have no centre, so they fall back to the workspace.
	 */
	homeId(renderer) {
		const state = this.attached.get(renderer);
		const view = state && state.view;
		if (view && view.file && view.file.path) return view.file.path;
		const file = this.app.workspace.getActiveFile();
		return file ? file.path : null;
	}

	/**
	 * Obsidian's search-query class, from whichever pane can supply it.
	 *
	 * Any graph engine will do — they all build the same class — so this looks
	 * across every open pane rather than only the one asking. A pane whose
	 * `searchQueries` is empty simply has no colour groups or filter set at that
	 * moment, which says nothing about the others. Cached once found, since the
	 * class itself never changes.
	 */
	queryClass() {
		if (this.cachedQueryClass) return this.cachedQueryClass;
		for (const graph of this.liveGraphs()) {
			const found = searchQueryClass(graph.view);
			if (found) {
				this.cachedQueryClass = found;
				return found;
			}
		}
		return null;
	}

	/** Everything the plugin believes about the current panes, for debugging. */
	logDiagnostics() {
		this.scan();
		const active = this.app.workspace.getActiveFile();
		const rows = this.liveGraphs().map((graph) => {
			const state = this.attached.get(graph.renderer) || {};
			const home = this.homeId(graph.renderer);
			return {
				type: graph.type,
				attached: this.attached.has(graph.renderer),
				engineQueries: (() => {
					const engine = graph.view && (graph.view.dataEngine || graph.view.engine);
					if (!engine) return 'no engine';
					if (!Array.isArray(engine.searchQueries)) return String(engine.searchQueries);
					return engine.searchQueries.length;
				})(),
				paneHome: home,
				homeNodeInPane: !!(graph.renderer.nodeLookup && home && graph.renderer.nodeLookup[home]),
				focused: (state.lockIds || []).slice(),
				nodes: graph.renderer.nodes.length,
				panel: !!state.panel,
				nativeInput: !!(state.panel && state.panel.search),
				suggestions: !!(state.panel && state.panel.suggest),
				onNodeClickWrapped: typeof graph.renderer.onNodeClick === 'function',
				pinned: !!(graph.leaf && graph.leaf.pinned),
			};
		});
		console.log('[Graph Focus] diagnostics', {
			version: '1.34.0',
			broken: this.broken,
			api: {
				SearchComponent: typeof SearchComponent,
				AbstractInputSuggest: typeof AbstractInputSuggest,
				queryParser: !!this.queryClass(),
			},
			panels: rows.filter((row) => row.panel).length,
			activeFile: active ? active.path : null,
			settings: this.settings,
			panes: rows,
		});
		new Notice(`Graph Focus: logged ${rows.length} graph pane(s) to the console.`);
	}

	/**
	 * Move the focus to the node an ordinary click just opened. Silent when it is
	 * already the sole focus, so re-clicking does not spam notices.
	 */
	focusFromClick(renderer, id) {
		const state = this.attached.get(renderer);
		if (!state) return;
		// Already the sole focus: nothing to do. Clicking it used to recentre the
		// view as well, which he tried and did not want.
		if (state.lockIds.length === 1 && state.lockIds[0] === id) return;
		this.setFocus(renderer, [id], `Focus: ${displayName(id)}`);
	}

	/** Point the view at a node and let stepPan() walk it there. */
	aimPan(renderer, state, id) {
		if (this.settings.panMode === 'off' || !id) return;
		state.panTarget = id;
		state.panFrames = 0;
		state.panSettled = 0;
		state.panNodeX = NaN;
		state.panNodeY = NaN;
		renderer.changed();
	}

	/** Focus every node the pane currently holds. */
	focusAll(renderer) {
		const ids = [];
		const seen = new Set();
		for (const node of renderer.nodes) {
			if (!node || seen.has(node.id)) continue;
			seen.add(node.id);
			ids.push(node.id);
		}
		if (!ids.length) {
			new Notice('Graph Focus: nothing in this pane to focus.');
			return;
		}
		this.setFocus(renderer, ids, `Focused all ${ids.length}`, { remember: false });
	}

	/** Replace the focus set with a single node. */
	setLock(renderer, id) {
		this.setFocus(renderer, [id], `Focus locked: ${displayName(id)}`);
	}

	/** Add a node to the focus set, or drop it if it is already there. */
	toggleInFocus(renderer, id) {
		const state = this.attached.get(renderer);
		if (!state) return;
		if (state.lockIds.includes(id)) {
			const rest = state.lockIds.filter((other) => other !== id);
			if (!rest.length) this.clearLock(renderer, true);
			else this.setFocus(renderer, rest, `Removed: ${displayName(id)} (${rest.length} focused)`);
			return;
		}
		// Newest goes last: the tail is the one that gets the native highlight.
		const next = state.lockIds.concat(id);
		this.setFocus(renderer, next, `Added: ${displayName(id)} (${next.length} focused)`);
	}

	setFocus(renderer, ids, message, options) {
		const state = this.attached.get(renderer);
		if (!state) return;
		state.lockIds = ids;
		// Membership is tested once per node per frame in the render hook, so it
		// needs to be O(1) — "focus everything" turns an indexOf into a scan of
		// the whole vault, squared.
		state.lockSet = new Set(ids);
		state.depths = null;
		state.sig = '';
		state.focusAt = Date.now();
		if (this.shouldPan(options && options.following)) {
			// Aim at the newest focus node, the one wearing the native highlight.
			this.aimPan(renderer, state, ids[ids.length - 1]);
		}
		// A bulk selection is not a thing you would want to return to later, and
		// would flood the list in one click.
		if (!options || options.remember !== false) this.rememberFocus(ids);
		this.assertLock(renderer, state);
		renderer.changed();
		if (state.panel) state.panel.refresh();
		if (this.settings.notices && message) new Notice(message);
	}

	/** Drop one note from the history, leaving the rest in order. */
	forgetFocus(path) {
		const history = this.settings.recentFocus || [];
		const at = history.indexOf(path);
		if (at === -1) return;
		history.splice(at, 1);
		this.saveHistory();
	}

	clearHistory() {
		if (!(this.settings.recentFocus || []).length) return;
		this.settings.recentFocus = [];
		this.saveHistory();
	}

	/** Persist now and bring every panel's list into line. */
	saveHistory() {
		if (this.historyTimer) {
			window.clearTimeout(this.historyTimer);
			this.historyTimer = null;
		}
		this.saveData(this.settings);
		for (const state of this.attached.values()) {
			if (state.panel) state.panel.refresh();
		}
	}

	/**
	 * Keep a most-recent-first list of what has been focused.
	 *
	 * Saving is debounced because following the active note calls this on every
	 * navigation, and writing data.json that often for a list of strings would be
	 * absurd. All panels are refreshed on the same timer so their history lists
	 * agree with each other.
	 */
	rememberFocus(ids) {
		const history = Array.isArray(this.settings.recentFocus) ? this.settings.recentFocus : [];
		let changed = false;
		for (const id of ids) {
			if (history[0] === id) continue;
			const at = history.indexOf(id);
			if (at !== -1) history.splice(at, 1);
			history.unshift(id);
			changed = true;
		}
		if (!changed) return;
		this.settings.recentFocus = history.slice(0, HISTORY_KEEP);
		if (this.historyTimer) window.clearTimeout(this.historyTimer);
		this.historyTimer = window.setTimeout(() => {
			this.historyTimer = null;
			this.saveData(this.settings);
			for (const state of this.attached.values()) {
				if (state.panel) state.panel.refresh();
			}
		}, 2000);
	}

	shouldPan(following) {
		const mode = this.settings.panMode;
		return mode === 'always' || (mode === 'follow' && !!following);
	}

	/**
	 * Re-aim the view when the pane's data is replaced under it.
	 *
	 * Clicking a note in a local graph rebuilds the pane around it, and the
	 * rebuild lands *after* the focus is set. Node positions are reshuffled by
	 * it, so a pan that had already finished is now pointing at where the node
	 * used to be — which is how a note ends up off screen entirely rather than
	 * merely off centre. Only rebuilds shortly after a focus change re-aim, so a
	 * later one cannot yank the view out from under you.
	 */
	watchRebuild(renderer, state) {
		const sig = `${renderer.nodes.length}:${renderer.links.length}`;
		if (state.graphSig === sig) return;
		const known = state.graphSig !== null;
		state.graphSig = sig;
		if (!known || !this.shouldPan(true)) return;
		if (Date.now() - state.focusAt > 5000) return;
		state.panTarget = state.lockIds[state.lockIds.length - 1] || null;
		state.panFrames = 0;
		state.panSettled = 0;
		state.panNodeX = NaN;
		state.panNodeY = NaN;
	}

	/**
	 * Ease the view toward the focused node, one frame at a time.
	 *
	 * The renderer's transform is `screen = world * scale + pan`, in device
	 * pixels — the same relation `resetPan()` uses when it centres the origin
	 * with `setPan(width / 2 * dpr, height / 2 * dpr)`.
	 *
	 * The target is recomputed every frame rather than once, because the force
	 * simulation keeps moving the node: this chases it rather than aiming where
	 * it used to be.
	 *
	 * It holds on until the node has *stopped* moving, not merely until the view
	 * has caught up. Releasing at "close enough" leaves the note drifting off to
	 * one side for as long as the simulation keeps running, which after a graph
	 * rebuild is a second or two — long enough to land visibly off centre.
	 */
	stepPan(renderer, state) {
		// Any deliberate move of your own wins immediately.
		if (renderer.panning || renderer.dragNode) {
			state.panTarget = null;
			return;
		}
		const timedOut = ++state.panFrames > 600;
		const node = renderer.nodeLookup && renderer.nodeLookup[state.panTarget];

		// Measure the pane live rather than trusting renderer.width/height, which
		// are only refreshed by onResize — a pane that has just opened, or one
		// whose layout has changed without a resize event, can still be carrying
		// stale numbers, and half a stale width puts the note far off centre.
		const el = renderer.containerEl;
		const width = (el && el.clientWidth) || renderer.width || 0;
		const height = (el && el.clientHeight) || renderer.height || 0;

		// A rebuilt pane briefly has neither a laid-out size nor the node.
		if (!width || !height || !node || typeof node.x !== 'number') {
			if (timedOut) state.panTarget = null;
			return;
		}

		const dpr = window.devicePixelRatio || 1;
		const scale = renderer.scale || 1;
		// The pane may be turned. `screen = pan + R(angle)·(world · scale)` is the
		// hanger's real transform, so centring a node means undoing all three and
		// not just the scale — without the rotation the view aims at where the
		// note would sit if the graph were level, and settles confidently there.
		// Graph Rotator publishes the angle for this; 0 when it is not installed,
		// which is the arithmetic this had before.
		const rotator = this.app && this.app.__graphRotator;
		const angle = rotator && typeof rotator.angleOf === 'function' ? rotator.angleOf(renderer) : 0;
		const wx = node.x * scale;
		const wy = node.y * scale;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const targetX = (width / 2) * dpr - (wx * cos - wy * sin);
		const targetY = (height / 2) * dpr - (wx * sin + wy * cos);
		const dx = targetX - renderer.panX;
		const dy = targetY - renderer.panY;

		// How far the node itself travelled since the last frame. NaN on the first
		// frame, which compares false, so it can never settle immediately.
		const drift = Math.abs(node.x - state.panNodeX) + Math.abs(node.y - state.panNodeY);
		state.panNodeX = node.x;
		state.panNodeY = node.y;

		const centred = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;
		if (centred && drift < 0.05) state.panSettled++;
		else state.panSettled = 0;

		if (this.settings.debug && state.panFrames % 20 === 1) {
			console.log('[Graph Focus] pan', {
				node: state.panTarget,
				frame: state.panFrames,
				world: [Math.round(node.x), Math.round(node.y)],
				pane: [width, height],
				dpr,
				scale,
				pan: [Math.round(renderer.panX), Math.round(renderer.panY)],
				target: [Math.round(targetX), Math.round(targetY)],
				off: [Math.round(dx), Math.round(dy)],
				drift: Math.round(drift * 100) / 100,
			});
		}

		// Every exit lands the pan exactly, including the timeout. Giving up
		// mid-flight is what leaves a note off screen; if the simulation simply
		// will not settle, snapping is still the right answer.
		if (state.panSettled > 10 || timedOut) {
			renderer.setPan(targetX, targetY);
			state.panTarget = null;
			renderer.changed();
			return;
		}

		const ease = 0.18;
		renderer.setPan(renderer.panX + dx * ease, renderer.panY + dy * ease);
		// Keep frames coming while the view is still travelling.
		renderer.changed();
	}

	clearLock(renderer, announce) {
		const state = this.attached.get(renderer);
		if (!state || !state.lockIds.length) return false;
		state.lockIds = [];
		state.lockSet = new Set();
		state.depths = null;
		state.panTarget = null;
		state.panSettled = 0;
		renderer.highlightNode = null;
		// Alphas we wrote last frame fade back to native over the next few frames.
		renderer.changed();
		if (state.panel) state.panel.refresh();
		if (announce && this.settings.notices) new Notice('Focus lock cleared');
		return true;
	}

	toggleLock(renderer, id) {
		const state = this.attached.get(renderer);
		const only = state && state.lockIds.length === 1 && state.lockIds[0] === id;
		if (only) this.clearLock(renderer, true);
		else this.setLock(renderer, id);
	}

	clearAll(announce) {
		let cleared = 0;
		for (const renderer of this.attached.keys()) {
			if (this.clearLock(renderer, false)) cleared++;
		}
		if (announce && this.settings.notices) {
			new Notice(cleared ? 'Focus lock cleared' : 'No focus lock to clear');
		}
	}

	/** The focused ids that actually exist in this pane right now. */
	presentIds(renderer, state) {
		if (!renderer.nodeLookup) return [];
		return state.lockIds.filter((id) => renderer.nodeLookup[id]);
	}

	/**
	 * Re-assign the highlight and blank the pointer position. The renderer's
	 * end-of-frame "is the mouse still on it?" check only runs when both
	 * coordinates are non-null, so this is what makes the lock persist.
	 *
	 * `highlightNode` is a single slot, so only the most recently focused node
	 * gets the native treatment — ring, highlight fill, full-strength label. The
	 * rest are painted to match in paintGradient(), minus the ring, which the
	 * renderer will only ever draw for one node.
	 */
	assertLock(renderer, state) {
		const present = this.presentIds(renderer, state);
		if (!present.length) return; // none in this pane right now — lock stays pending
		renderer.highlightNode = renderer.nodeLookup[present[present.length - 1]];
		renderer.mouseX = null;
		renderer.mouseY = null;
	}

	lockHovered(add) {
		this.scan();
		for (const renderer of this.liveRenderers()) {
			const state = this.attached.get(renderer);
			// state.hovered is the real cursor target; highlightNode is only
			// trustworthy before anything has been locked in this pane.
			const node = (state && state.hovered) || renderer.dragNode || renderer.highlightNode;
			if (node) {
				if (add) this.toggleInFocus(renderer, node.id);
				else this.setLock(renderer, node.id);
				return;
			}
		}
		new Notice('Graph Focus: point at a node in a graph pane, then press the hotkey.');
	}

	/**
	 * Follow the active note. The focus is set even when the node is not in the
	 * pane yet — a local graph rebuilds asynchronously after navigation, and
	 * assertLock() runs every frame, so a pending lock simply takes hold the
	 * moment the node appears.
	 */
	onFileOpen(file) {
		if (this.settings.followMode === 'off' || !file) return;
		this.scan();
		this.followInto(this.liveGraphs(), file);
	}

	/**
	 * Clicking back into a note you already have open usually fires no
	 * `file-open` at all — the active file has not changed, only the leaf. That
	 * is exactly the moment the focus should come home, so the leaf change has to
	 * be watched as well. Graph panes are ignored here: activating one is the
	 * side effect of clicking inside it, not a decision to go somewhere.
	 */
	onActiveLeafChange(leaf) {
		if (this.settings.followMode === 'off') return;
		const view = leaf && leaf.view;
		if (!view || isGraphRenderer(view.renderer)) return;
		const file = view.file || this.app.workspace.getActiveFile();
		if (!file || !file.path) return;
		if (this.settings.debug) {
			console.log('[Graph Focus] active leaf change', {
				view: typeof view.getViewType === 'function' ? view.getViewType() : '?',
				file: file.path,
			});
		}
		this.followInto(this.liveGraphs(), file);
	}

	followInto(graphs, file) {
		const mode = this.settings.followMode;
		if (mode === 'off' || !file) return;
		const activeLeaf = this.app.workspace.activeLeaf;
		for (const graph of graphs) {
			if (mode === 'local' && graph.type !== 'localgraph') continue;
			// A pinned pane is deliberately not tracking the active file.
			if (graph.leaf && graph.leaf.pinned) continue;
			// The pane you are working inside is the one place following must not
			// reach. A local graph is a FileView, so clicking in it makes it active
			// and Obsidian reports its own centre note as opened — which would undo
			// the focus that very click had just set. Any *other* leaf becoming
			// active is a real move on your part, and should bring the focus home.
			if (graph.leaf && graph.leaf === activeLeaf) continue;
			const state = this.attached.get(graph.renderer);
			if (!state) continue;
			if (state.lockIds.length === 1 && state.lockIds[0] === file.path) continue;
			if (this.settings.debug) {
				console.log('[Graph Focus] following', {
					pane: graph.type,
					to: file.path,
					was: state.lockIds.slice(),
				});
			}
			// No notice: this fires on every navigation.
			this.setFocus(graph.renderer, [file.path], null, { following: true });
		}
	}

	lockActiveNote(add) {
		this.scan();
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('Graph Focus: no active note.');
			return;
		}
		let found = 0;
		for (const renderer of this.liveRenderers()) {
			if (renderer.nodeLookup && renderer.nodeLookup[file.path]) {
				if (add) this.toggleInFocus(renderer, file.path);
				else this.setLock(renderer, file.path);
				found++;
			}
		}
		if (!found) new Notice(`Graph Focus: "${file.basename}" is not in any open graph.`);
	}

	/* ------------------------------------------------------------- gradient */

	/**
	 * Hop distance to the *nearest* focused node, over the links actually in this
	 * pane. A plain breadth-first walk seeded with every focus node at once, which
	 * is what makes multiple foci fall out for free: the frontier expands from all
	 * of them simultaneously, so the first time a node is reached is by definition
	 * its distance to the closest one.
	 */
	depthMap(renderer, state, sources, maxDepth) {
		const sig = `${renderer.nodes.length}:${renderer.links.length}:${sources.join('|')}:${maxDepth}`;
		if (state.depths && state.sig === sig) return state.depths;

		const adjacency = new Map();
		const link = (a, b) => {
			let list = adjacency.get(a);
			if (!list) adjacency.set(a, (list = []));
			list.push(b);
		};
		for (const edge of renderer.links) {
			if (!edge.source || !edge.target) continue;
			link(edge.source.id, edge.target.id);
			link(edge.target.id, edge.source.id);
		}

		const depths = new Map(sources.map((id) => [id, 0]));
		let frontier = sources.slice();
		for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
			const next = [];
			for (const id of frontier) {
				for (const neighbour of adjacency.get(id) || []) {
					if (depths.has(neighbour)) continue;
					depths.set(neighbour, depth);
					next.push(neighbour);
				}
			}
			frontier = next;
		}

		state.depths = depths;
		state.sig = sig;
		return depths;
	}

	/**
	 * Opacity for something sitting `depth` hops from the focused node.
	 * Geometric: every extra hop multiplies by `falloff`, with `minAlpha` as the
	 * floor. Depth 0 and 1 stay at full strength, which is what Obsidian already
	 * draws. Unreachable nodes count as infinitely far and get the floor.
	 */
	alphaForDepth(depth) {
		const { falloff, minAlpha, fullRings, curveShape, gradient } = this.settings;
		// With the fade off this becomes Obsidian's own binary rule — full
		// strength for the focus and its direct links, the flat 0.2 beyond. The
		// difference is that it is applied around *every* focused note, which is
		// the thing the renderer cannot do for itself.
		if (!gradient) return depth <= 1 ? 1 : NATIVE_DIM;
		if (depth <= fullRings) return 1;
		if (!Number.isFinite(depth)) return minAlpha;
		// `curveShape` bends the step count before the falloff is applied to it.
		// At 1 this is plain geometric decay, a constant ratio per hop. Above 1
		// the early hops are stretched, so the fade starts gently and then bites;
		// below 1 they are compressed, so it drops at once and trails off.
		const steps = Math.pow(depth - fullRings, curveShape);
		return Math.max(minAlpha, Math.pow(falloff, steps));
	}

	/**
	 * The hop count at which the curve has flattened onto the floor. Past this,
	 * every node has the same opacity, so there is nothing to gain by walking
	 * further — which keeps the BFS bounded no matter how gentle the falloff.
	 *
	 * Found by walking the curve rather than inverting it, so it cannot drift out
	 * of agreement with alphaForDepth() whatever shape that ends up having.
	 */
	maxUsefulDepth() {
		// Flat past the first ring, so there is nothing to distinguish beyond it.
		if (!this.settings.gradient) return 2;
		const floor = this.settings.minAlpha;
		for (let depth = this.settings.fullRings + 1; depth <= DEPTH_CEILING; depth++) {
			if (this.alphaForDepth(depth) <= floor) return depth;
		}
		return DEPTH_CEILING;
	}

	/**
	 * Give a node the readable label the renderer reserves for the highlighted
	 * one, without any of the rest of the highlight.
	 *
	 * Its render() derives the label from the same `d` flag as the ring: full
	 * opacity, exempt from the viewport test that hides distant labels, and — the
	 * part that actually matters when zoomed out — counter-scaled by `1/scale`
	 * instead of shrinking with the graph. Reproduced here rather than by
	 * impersonation, because impersonating would bring the ring and highlight
	 * fill along with it.
	 *
	 * The renderer only positions a label on the frames it decides to draw one,
	 * so forcing visibility means positioning it too, or it appears wherever it
	 * was last left.
	 */
	forceLabel(renderer, node) {
		const text = node.text;
		if (!text || typeof node.x !== 'number') return;
		const colors = renderer.colors || {};
		const scale = renderer.scale || 1;
		const nodeScale = renderer.nodeScale || 1;
		const size = typeof node.getSize === 'function' ? node.getSize() : 8;

		text.visible = true;
		text.alpha = colors.text && typeof colors.text.a === 'number' ? colors.text.a : 1;
		text.x = node.x;
		text.y = node.y + (size + 5) * nodeScale;
		const factor = scale < 1 ? 1 / scale : nodeScale;
		text.scale.x = factor;
		text.scale.y = factor;
	}

	/**
	 * Repaint by depth. With a single focus node the renderer already draws
	 * depth 0 and 1 correctly and we only touch what lies beyond; with several,
	 * it cannot — `highlightNode` is one slot, so it brightens the neighbours of
	 * the primary focus only and dims everyone else's to 0.2. So every node
	 * except the natively highlighted one is painted here.
	 *
	 * This runs after the frame has been drawn, so values land on the next one.
	 * The renderer keeps rendering for ~60 frames after any change(), so the
	 * one-frame delay is never visible.
	 */
	paintGradient(renderer, state) {
		const sources = this.presentIds(renderer, state);
		if (!sources.length) return;
		// Note there is no early return for `gradient` being off. Turning the fade
		// off must not turn off multi-focus support with it: the renderer only
		// ever brightens one node's neighbourhood, so with several focused the
		// rest would lose their bright links entirely. alphaForDepth() flattens
		// the curve instead.

		const depths = this.depthMap(renderer, state, sources, this.maxUsefulDepth());
		const depthOf = (id) => {
			const depth = depths.get(id);
			return depth === undefined ? Infinity : depth;
		};

		const colors = renderer.colors || {};
		const alphaOf = (key) => (colors[key] && typeof colors[key].a === 'number' ? colors[key].a : 1);
		const textAlpha = typeof renderer.textAlpha === 'number' ? renderer.textAlpha : 1;
		const arrowFade = clamp(2 * ((renderer.scale || 1) - 0.3), 0, 1);
		// The one node the renderer is treating as highlighted — dragNode wins over
		// highlightNode, exactly as getHighlightNode() has it. Left untouched so it
		// keeps its ring, its highlight fill and its full-strength label.
		const primary = renderer.dragNode || renderer.highlightNode;
		const highlightFill = colors.fillHighlight;
		// Obsidian gets depth 0 and 1 right by itself only when there is a single
		// focus node and it is the one being highlighted. Drag a node and the
		// highlight moves to it, so we have to take those rings over too.
		const nativeHandlesNear = sources.length === 1 && !renderer.dragNode;

		for (const node of renderer.nodes) {
			if (node === primary) continue;
			const depth = depthOf(node.id);
			// Once patchNodeRender() is in place every focused node has already had
			// the full native treatment — ring, label, highlight fill — so leave
			// them entirely alone rather than repainting over it.
			if (depth === 0 && this.nodeRenderRestore) continue;
			// Left to Obsidian where it can, so colour groups and label sizing stay
			// exactly as it drew them. Neighbour labels are handled in the node
			// render hook, which is the only place early enough to be drawn.
			if (nativeHandlesNear && depth <= 1) continue;
			const alpha = this.alphaForDepth(depth);
			// Keep fadeAlpha in step so releasing the lock eases from the right value.
			node.fadeAlpha = alpha;
			if (node.circle && node.circle.visible) {
				// Secondary focus nodes get the highlight fill, so all the focused
				// notes read alike even though only one can carry the ring.
				const focused = depth === 0 && highlightFill && typeof highlightFill.rgb === 'number';
				const fill = focused ? highlightFill : (node.getFillColor ? node.getFillColor() : null);
				node.circle.alpha = alpha * (fill && typeof fill.a === 'number' ? fill.a : 1);
				if (focused) node.circle.tint = highlightFill.rgb;
			}
			if (node.text && node.text.visible) {
				node.text.alpha = alpha * textAlpha * alphaOf('text');
			}
		}

		// Obsidian tints a link with colors.lineHighlight only when it touches the
		// focused node, and colors.line otherwise — so without this the deeper
		// rings fade but revert to the ordinary link colour. Recolouring also
		// forces us down to depth 1: a link between two direct neighbours is
		// depth 1 by max(), and leaving it native would strand it at 0.2 while
		// the depth-2 links around it sit at 0.6.
		const mode = this.settings.linkColorMode;
		const recolor = mode !== 'native';
		const near = colors.lineHighlight || colors.line || { rgb: 0, a: 1 };
		const far = colors.line || near;
		const nearAlpha = typeof near.a === 'number' ? near.a : 1;
		const farAlpha = typeof far.a === 'number' ? far.a : 1;
		// With several foci the renderer only brightens the links around the
		// primary one, so nothing can be left to it — including depth 0, which is
		// a link running directly between two focused notes.
		const minLinkDepth = nativeHandlesNear ? (recolor ? 1 : 2) : 0;

		for (const edge of renderer.links) {
			if (!edge.source || !edge.target) continue;
			// In native-colour mode, leave the links the renderer has already
			// highlighted alone rather than restating them.
			if (!recolor && (edge.source === primary || edge.target === primary)) continue;
			const depth = Math.max(depthOf(edge.source.id), depthOf(edge.target.id));
			if (depth < minLinkDepth) continue;
			const alpha = this.alphaForDepth(depth);
			if (edge.line) {
				// How far this link has travelled from the highlight colour back to
				// the ordinary one. 0 at the focused note, approaching 1 with depth.
				// Infinity (unconnected) gives pow -> 0, so t -> 1. No NaN.
				const t = mode === 'blend'
					? 1 - Math.pow(this.settings.colorFalloff, Math.max(0, depth - 1))
					: 0;
				edge.line.alpha = alpha * (nearAlpha + (farAlpha - nearAlpha) * t);
				// Native eases the tint toward colors.line each frame; we snap it
				// back after, so it settles where we put it.
				//
				// A link a connexion rule has coloured keeps that colour: the two
				// carry different information, and depth is already saying its
				// piece through the opacity, which still applies here.
				const ruled = this.settings.connexions
					&& edge.gfConnTint !== null && edge.gfConnTint !== undefined;
				if (recolor && !ruled) edge.line.tint = mixRgb(near.rgb, far.rgb, t);
			}
			// Arrows have no highlight colour in Obsidian, so only the alpha moves.
			if (edge.arrow) edge.arrow.alpha = alpha * arrowFade * alphaOf('arrow');
		}
	}
}

/**
 * Query completion for the panel's search box.
 *
 * Built on the public `AbstractInputSuggest` rather than borrowing Obsidian's
 * own suggester class. The internal one would need a live instance to steal the
 * constructor from and there is no dependable place to find one — unlike the
 * query parser, which the colour groups keep alive on `engine.searchQueries`.
 * The base class is the same machinery its suggester uses, so this completes the
 * same vocabulary through an API that is meant to be used.
 *
 * Completion applies to the token under the cursor, so it works part-way through
 * a longer query rather than only on an empty box.
 */
// `extends` is evaluated when this file loads, so a missing export would stop
// the whole plugin rather than just costing us the suggestions. Fall back to an
// inert base; nothing constructs QuerySuggest unless the real one is present.
const SuggestBase = typeof AbstractInputSuggest === 'function' ? AbstractInputSuggest : class {};

class QuerySuggest extends SuggestBase {
	constructor(app, inputEl, onComplete) {
		super(app, inputEl);
		// Named away from anything the base class owns. `isOpen` in particular is
		// PopoverSuggest's own open-state flag, and writing to it stops the popup
		// from ever opening — it decides it is already showing.
		this.queryInputEl = inputEl;
		// Called when the chosen suggestion finishes the query rather than
		// starting one, so picking a tag searches instead of just typing it.
		this.onComplete = onComplete;
	}

	/** The whitespace-delimited token the cursor sits in. */
	currentToken() {
		const value = this.queryInputEl.value;
		const caret = this.queryInputEl.selectionStart === null
			? value.length
			: this.queryInputEl.selectionStart;
		const start = value.lastIndexOf(' ', caret - 1) + 1;
		return { text: value.slice(start, caret), start, end: caret };
	}

	getSuggestions() {
		const token = this.currentToken();
		const text = token.text;
		const items = [];
		const lower = text.toLowerCase();

		// `complete` marks a suggestion that finishes the query. An operator like
		// `tag:` needs a value after it; an actual tag does not.
		const add = (value, hint, complete) => items.push({ value, hint, complete, token });

		if (text.startsWith('tag:')) {
			const needle = text.slice(4).toLowerCase();
			const tags = this.app.metadataCache.getTags ? this.app.metadataCache.getTags() : {};
			for (const tag of Object.keys(tags)) {
				if (tag.toLowerCase().indexOf(needle) === -1) continue;
				add(`tag:${tag}`, `${tags[tag]} notes`, true);
			}
		} else if (text.startsWith('path:') || text.startsWith('file:')) {
			const operator = text.slice(0, 5);
			const needle = text.slice(5).toLowerCase();
			const seen = new Set();
			for (const file of this.app.vault.getFiles()) {
				const candidate = operator === 'path:' ? file.parent && file.parent.path : file.basename;
				if (!candidate || candidate === '/' || seen.has(candidate)) continue;
				if (candidate.toLowerCase().indexOf(needle) === -1) continue;
				seen.add(candidate);
				add(`${operator}${candidate}`, null, true);
			}
		} else if (text.startsWith('[')) {
			let typed = text.slice(1);
			if (typed.endsWith(']')) typed = typed.slice(0, -1);
			const needle = typed.toLowerCase();
			const infos = typeof this.app.metadataCache.getAllPropertyInfos === 'function'
				? this.app.metadataCache.getAllPropertyInfos()
				: {};
			for (const name of Object.keys(infos)) {
				if (name.toLowerCase().indexOf(needle) === -1) continue;
				add(`[${name}]`, infos[name] && infos[name].type, true);
			}
		} else {
			for (const operator of QUERY_OPERATORS) {
				if (text && operator.token.toLowerCase().indexOf(lower) !== 0) continue;
				add(operator.token, operator.hint, false);
			}
			// Plain text is already a valid query on its own.
			if (text) add(text, 'search for this text', true);
		}

		return items.slice(0, 20);
	}

	renderSuggestion(item, el) {
		el.createSpan({ text: item.value });
		if (item.hint) el.createSpan({ cls: 'search-suggest-info-text', text: String(item.hint) });
	}

	selectSuggestion(item) {
		const input = this.queryInputEl;
		const insert = item.value;
		// line:() and section:() and [] want the caret inside the brackets.
		const inside = insert.endsWith('()') || insert.endsWith('[]');
		input.value = input.value.slice(0, item.token.start) + insert + input.value.slice(item.token.end);
		const caret = item.token.start + insert.length - (inside ? 1 : 0);
		input.setSelectionRange(caret, caret);
		input.focus();
		this.close();
		if (item.complete) {
			// The query is finished — nothing useful is left to type, so run it.
			if (this.onComplete) this.onComplete(input.value);
			return;
		}
		// Re-run completion from the new caret position, so picking `tag:` leads
		// straight into the list of tags.
		input.dispatchEvent(new Event('input'));
	}
}

/**
 * Render one QUICK_OPTIONS entry as a settings row into `parent`.
 *
 * Shared by the settings tab and the in-graph popover so a control behaves
 * identically wherever it appears.
 */
function renderQuickOption(plugin, parent, option) {
	const setting = new Setting(parent).setName(option.name);
	const commit = async (value) => {
		plugin.settings[option.key] = value;
		await plugin.saveSettings();
	};
	if (option.type === 'toggle') {
		setting.addToggle((t) => t.setValue(!!plugin.settings[option.key]).onChange(commit));
	} else if (option.type === 'dropdown') {
		setting.addDropdown((d) => d
			.addOptions(option.options)
			.setValue(plugin.settings[option.key])
			.onChange(commit));
	} else {
		setting.addSlider((s) => s
			.setLimits(option.min, option.max, option.step)
			.setValue(plugin.settings[option.key])
			.setDynamicTooltip()
			.onChange(commit));
	}
	return setting;
}

/**
 * A settings button in the bottom-right of a graph pane, opposite the focus
 * panel, opening the subset of options chosen in the settings tab.
 *
 * Kept separate from FocusPanel rather than folded into it: changing an option
 * calls saveSettings(), which rebuilds every panel, and a popover that destroys
 * itself the moment you touch a control would be unusable.
 */
class QuickSettings {
	constructor(plugin, renderer) {
		this.plugin = plugin;
		this.renderer = renderer;
		this.open = false;
		this.build();
	}

	build() {
		const host = this.renderer.containerEl;
		if (!host) return;
		this.el = host.createDiv('graph-focus-quick');

		this.body = this.el.createDiv('graph-focus-quick-body');
		this.body.addClass('is-hidden');

		const button = this.el.createDiv('graph-focus-quick-button');
		if (obsidian.setIcon) obsidian.setIcon(button, 'lucide-sliders-horizontal');
		button.setAttribute('title', 'Graph Focus settings');
		button.addEventListener('click', () => this.toggle());

		this.renderBody();
	}

	toggle() {
		this.open = !this.open;
		this.body.toggleClass('is-hidden', !this.open);
		if (this.open) this.syncKeys();
	}

	/** Re-render only if the chosen set has actually changed. */
	syncKeys() {
		const signature = (this.plugin.settings.graphSettingsKeys || []).join('|');
		if (signature === this.renderedKeys) return;
		this.renderBody();
	}

	renderBody() {
		if (!this.body) return;
		this.body.empty();
		const chosen = this.plugin.settings.graphSettingsKeys || [];
		this.renderedKeys = chosen.join('|');
		const options = QUICK_OPTIONS.filter((option) => chosen.indexOf(option.key) !== -1);
		if (!options.length) {
			this.body.createDiv({
				cls: 'graph-focus-empty',
				text: 'No options chosen — pick some in the plugin settings.',
			});
			return;
		}
		for (const option of options) renderQuickOption(this.plugin, this.body, option);
	}

	destroy() {
		if (this.el) this.el.remove();
		this.el = null;
		this.body = null;
	}
}

/**
 * The panel drawn inside a graph pane: what is focused right now, and a search
 * for adding more.
 *
 * Deliberately not live. A query is run when you submit it and the matches are
 * listed for you to pick from, so a broad query like `tag:#art` never floods the
 * focus set — the list is the safety valve.
 */
class FocusPanel {
	constructor(plugin, renderer, state) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.renderer = renderer;
		this.state = state;
		this.results = [];
		this.note = '';
		this.collapsed = plugin.settings.panelCollapsed === true;
		this.build();
	}

	/** Tear the panel down and put it back, picking up any changed settings. */
	rebuild() {
		// `collapsed` survives on the instance, and build() applies it.
		this.destroy();
		this.build();
	}

	build() {
		const host = this.renderer.containerEl;
		if (!host) return;
		this.search = null;
		this.input = null;
		this.suggest = null;
		this.resultsEl = null;
		this.el = host.createDiv('graph-focus-panel');
		this.avoidControls();

		this.el.toggleClass('is-collapsed', this.collapsed);

		// Same folding arrow as the Bases graph legend: Obsidian's own
		// `.collapse-icon` rotates itself when `is-collapsed` is set.
		const header = this.el.createDiv('graph-focus-panel-header');
		const icon = header.createDiv('collapse-icon');
		if (obsidian.setIcon) obsidian.setIcon(icon, 'right-triangle');
		icon.toggleClass('is-collapsed', this.collapsed);
		header.createSpan({ cls: 'graph-focus-panel-title', text: 'Focus' });
		this.countEl = header.createSpan({ cls: 'graph-focus-panel-count' });
		header.addEventListener('click', () => {
			this.collapsed = !this.collapsed;
			this.el.toggleClass('is-collapsed', this.collapsed);
			icon.toggleClass('is-collapsed', this.collapsed);
			// Remembered as the state new panels open in. Saved directly rather
			// than through saveSettings(), which would rebuild every panel.
			this.plugin.settings.panelCollapsed = this.collapsed;
			this.plugin.saveData(this.plugin.settings);
		});

		this.body = this.el.createDiv('graph-focus-panel-body');

		this.focusListEl = this.foldableSection('Highlighted', 'highlightedCollapsed', [
			{
				text: 'All',
				title: 'Focus every node in this pane',
				onClick: () => this.plugin.focusAll(this.renderer),
			},
			{
				text: 'None',
				title: 'Clear the focus',
				onClick: () => this.plugin.clearLock(this.renderer, false),
			},
		]);

		if (!this.plugin.settings.showSearch) {
			this.buildHistory();
			this.refresh();
			return;
		}

		// The box and its results fold together, so the whole section goes inside
		// the foldable element rather than only the list under it.
		const searchSection = this.foldableSection('Search', 'searchCollapsed');

		// Obsidian's own search input — same markup and clear button as the search
		// pane and the graph's filter box, so it inherits their styling exactly.
		if (typeof SearchComponent === 'function') {
			this.search = new SearchComponent(searchSection);
			this.search.setPlaceholder('tag:#art, path:…, "phrase"');
			this.input = this.search.inputEl;
		} else {
			this.input = searchSection.createEl('input', { type: 'search' });
		}

		// Created before anything that could throw, and before the suggester.
		// runSearch() refuses to run without it, so leaving it until last meant a
		// single failure above silently cost the entire search while still showing
		// the box. DOM order still puts it under the input.
		this.resultsEl = searchSection.createDiv();

		// Operator and value completion, on the public suggester base.
		if (typeof AbstractInputSuggest === 'function') {
			try {
				this.suggest = new QuerySuggest(this.app, this.input, (value) => this.startSearch(value));
			} catch (e) {
				console.error('Graph Focus: query suggestions unavailable', e);
				this.suggest = null;
			}
		}

		// Enter is handled twice, on purpose. The suggester registers its own Enter
		// handling as a keymap scope, which Obsidian runs at the document level in
		// the capture phase — so while the popup is open it sees the key before any
		// listener on the input can, and if nothing is selected it swallows it. A
		// scope that consumes keydown still lets keyup through, so the second
		// listener catches exactly the presses the first one never sees.
		this.input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			// Decided from the text, not from the suggester's state. `isOpen` is
			// guarded internally by `if (!this.isOpen)`, so anything that leaves it
			// stuck true would swallow every Enter from then on — too fragile a
			// thing to hang the only way of running a search on. A query still
			// waiting for its value is simply not worth submitting.
			const query = this.input.value.trim();
			if (!query || query.endsWith(':') || query.endsWith('(') || query.endsWith('[')) return;
			event.preventDefault();
			this.enterHandled = true;
			this.startSearch(query);
		});

		this.input.addEventListener('keyup', (event) => {
			if (event.key !== 'Enter') return;
			if (this.enterHandled) {
				this.enterHandled = false;
				return;
			}
			const query = this.input.value.trim();
			if (!query || query.endsWith(':') || query.endsWith('(') || query.endsWith('[')) return;
			this.startSearch(query);
		});
		// Emptying the box clears the results. Not live search — nothing runs on
		// typing — but stale results under an empty query are just clutter.
		//
		// Two routes, and they are genuinely different: typing raises `input`,
		// while the component's clear button sets `value = ""` and calls
		// `onChanged()` directly, dispatching no DOM event at all. Neither one
		// covers the other.
		this.input.addEventListener('input', () => this.clearIfEmpty());
		try {
			if (this.search && typeof this.search.onChange === 'function') {
				this.search.onChange(() => this.clearIfEmpty());
			}
		} catch (e) {
			console.error('Graph Focus: could not hook the clear button', e);
		}

		// The graph binds single keys on window; without this they act on the
		// graph while you are typing a query.
		this.input.addEventListener('keyup', (event) => event.stopPropagation());

		this.buildHistory();
		this.refresh();
	}

	/**
	 * A section title that folds, remembering its state in `collapsedKey`.
	 * Returns the list element the section's rows go into.
	 */
	foldableSection(title, collapsedKey, actions) {
		const collapsed = this.plugin.settings[collapsedKey] === true;
		const header = this.body.createDiv('graph-focus-section-header');
		const icon = header.createDiv('collapse-icon');
		if (obsidian.setIcon) obsidian.setIcon(icon, 'right-triangle');
		icon.toggleClass('is-collapsed', collapsed);
		header.createSpan({ cls: 'graph-focus-section-title', text: title });

		for (const action of [].concat(actions || [])) {
			if (!action) continue;
			const control = header.createSpan({
				cls: 'graph-focus-section-action',
				text: action.text,
			});
			control.setAttribute('title', action.title || '');
			// Its own click, or the header would fold at the same time.
			control.addEventListener('click', (event) => {
				event.stopPropagation();
				this.plugin.guard(action.onClick);
			});
		}

		const list = this.body.createDiv('graph-focus-section-list');
		list.toggleClass('is-collapsed', collapsed);

		header.addEventListener('click', () => {
			const now = !this.plugin.settings[collapsedKey];
			this.plugin.settings[collapsedKey] = now;
			this.plugin.saveData(this.plugin.settings);
			icon.toggleClass('is-collapsed', now);
			list.toggleClass('is-collapsed', now);
		});
		return list;
	}

	buildHistory() {
		this.historyEl = null;
		if (!this.plugin.settings.showHistory) return;
		this.historyEl = this.foldableSection('Recent', 'historyCollapsed', {
			text: 'Clear',
			title: 'Forget every note in this list',
			onClick: () => this.plugin.clearHistory(),
		});
	}

	/**
	 * Previously focused notes, newest first, minus whatever is focused right now
	 * — those are already listed above and re-offering them is just noise.
	 */
	renderHistory() {
		if (!this.historyEl) return;
		this.historyEl.empty();
		const history = this.plugin.settings.recentFocus || [];
		const past = history
			.filter((path) => !this.state.lockSet.has(path))
			.slice(0, HISTORY_SHOW);
		if (!past.length) {
			this.historyEl.createDiv({ cls: 'graph-focus-empty', text: 'Nothing yet.' });
			return;
		}
		for (const path of past) {
			this.row(this.historyEl, path, {
				focused: false,
				action: '✕',
				actionTitle: 'Forget this one',
				onAction: () => this.plugin.forgetFocus(path),
			});
		}
	}

	/**
	 * Obsidian puts its graph controls in the opposite corner, so normally there
	 * is nothing to avoid and the panel keeps the inset the stylesheet gives it.
	 * Only if something has moved them — a theme, a snippet — does this drop the
	 * panel below them, and it measures rather than assuming a side.
	 */
	avoidControls() {
		if (!this.el) return;
		this.el.style.top = '';
		const controls = this.renderer.containerEl
			&& this.renderer.containerEl.querySelector('.graph-controls');
		if (!controls) return;
		const mine = this.el.getBoundingClientRect();
		const theirs = controls.getBoundingClientRect();
		const overlaps = mine.left < theirs.right && theirs.left < mine.right;
		if (!overlaps) return;
		this.el.style.top = `${controls.offsetTop + controls.offsetHeight + 8}px`;
	}

	/** One clickable row. */
	row(parent, path, { focused, action, actionTitle, onAction }) {
		const present = !!(this.renderer.nodeLookup && this.renderer.nodeLookup[path]);
		const item = parent.createDiv('graph-focus-item');
		item.toggleClass('is-focused', !!focused);
		item.toggleClass('is-absent', !present);
		item.createSpan({ cls: 'graph-focus-item-name', text: displayName(path) });
		const control = item.createSpan({ cls: 'graph-focus-item-action', text: action });
		if (actionTitle) control.setAttribute('title', actionTitle);
		item.setAttribute('title', present ? path : `${path}\n(not one of this pane's notes)`);
		item.addEventListener('click', () => {
			this.plugin.guard(() => this.plugin.toggleInFocus(this.renderer, path));
		});
		// A row whose control does something else — forgetting a history entry
		// rather than focusing it — needs the click kept off the row itself.
		if (onAction) {
			control.addClass('is-interactive');
			control.addEventListener('click', (event) => {
				event.stopPropagation();
				this.plugin.guard(onAction);
			});
		}
		return item;
	}

	/** Redraw the focus list. Called whenever the focus changes. */
	refresh() {
		if (!this.el) return;
		this.avoidControls();
		const ids = this.state.lockIds;
		this.countEl.setText(ids.length ? String(ids.length) : '');
		this.focusListEl.empty();
		if (!ids.length) {
			this.focusListEl.createDiv({
				cls: 'graph-focus-empty',
				text: 'Nothing focused. Alt+click a node, or search below.',
			});
		} else {
			// Capped: "All" can focus the whole vault, and a row per note would
			// make the panel taller than the screen and slower than the graph.
			for (const id of ids.slice(0, MAX_FOCUS_ROWS)) {
				this.row(this.focusListEl, id, { focused: true, action: '✕' });
			}
			if (ids.length > MAX_FOCUS_ROWS) {
				this.focusListEl.createDiv({
					cls: 'graph-focus-note',
					text: `${ids.length - MAX_FOCUS_ROWS} more focused.`,
				});
			}
		}
		this.renderResults();
		this.renderHistory();
	}

	renderResults() {
		// Rebuild the container if it has gone missing. It is created early
		// precisely so it always exists, but nothing about a search should depend
		// on that having worked — a silent return here costs the whole feature.
		if (!this.resultsEl && this.body) this.resultsEl = this.body.createDiv();
		if (!this.resultsEl) return;
		this.resultsEl.empty();
		if (this.note) this.resultsEl.createDiv({ cls: 'graph-focus-note', text: this.note });

		// A result you have picked moves up into Highlighted, so drop it from here
		// rather than listing the same note twice. Clicking one then visibly does
		// something, instead of leaving it looking untouched.
		const remaining = this.results.filter((path) => !this.state.lockSet.has(path));
		const taken = this.results.length - remaining.length;
		if (taken) {
			this.resultsEl.createDiv({
				cls: 'graph-focus-note',
				text: `${taken} already highlighted.`,
			});
		}
		for (const path of remaining) {
			this.row(this.resultsEl, path, { focused: false, action: '+' });
		}
	}

	/** Drop the results once the query box is empty. Safe to call repeatedly. */
	clearIfEmpty() {
		if (!this.input) return;
		if (this.input.value.trim()) return;
		if (!this.results.length && !this.note) return;
		if (this.plugin.settings.debug) {
			console.log('[Graph Focus] clearing results for an empty query');
		}
		this.results = [];
		this.note = '';
		this.renderResults();
	}

	/**
	 * The only entry point for running a search.
	 *
	 * runSearch is async, so `guard()` — a synchronous try/catch — cannot see
	 * anything it throws past the first await. A rejected promise would be
	 * swallowed and look exactly like a search that did nothing, so the rejection
	 * is caught here and reported in the panel.
	 */
	startSearch(query) {
		// Immediate, before any work. A content search reads the whole vault and
		// can take seconds, during which an unchanged panel is indistinguishable
		// from a click that did nothing at all — which is precisely how this last
		// failure presented.
		if (this.plugin.settings.debug) console.log('[Graph Focus] search requested:', query);
		this.results = [];
		this.note = 'Searching…';
		this.renderResults();

		let running;
		try {
			running = this.runSearch(query);
		} catch (e) {
			running = Promise.reject(e);
		}
		if (running && typeof running.catch === 'function') {
			running.catch((e) => {
				console.error('Graph Focus: search failed', e);
				this.results = [];
				this.note = 'Search failed — see the console.';
				this.renderResults();
			});
		}
	}

	async runSearch(raw) {
		const query = (raw || '').trim();
		this.results = [];
		if (!query) {
			this.note = '';
			this.renderResults();
			return;
		}

		const Query = this.plugin.queryClass();
		let outcome = null;
		if (Query) {
			try {
				outcome = await this.nativeSearch(Query, query);
			} catch (e) {
				console.error('Graph Focus: native search failed, falling back', e);
				outcome = null;
			}
		}

		if (outcome && outcome.invalid) {
			// A malformed query is worth saying so about, rather than reporting it
			// as no matches and leaving you to wonder which it was.
			this.note = 'Not a valid search query.';
			this.renderResults();
			return;
		}

		// Notes accumulate. Overwriting them was hiding the important one: a
		// fallback that finds nothing used to report a bare "No matches", which
		// looks like a working search on an empty vault rather than a search that
		// never understood the query.
		const notes = [];
		if (!outcome) {
			outcome = {
				files: this.substringSearch(query),
				tested: this.app.vault.getFiles().length,
				failures: 0,
			};
			notes.push(Query
				? 'Query parser failed — matched on name only.'
				: 'Query parser unavailable — matched on name only, so operators like tag: will not work.');
		}

		if (outcome.failures) {
			notes.push(`${outcome.failures} of ${outcome.tested + outcome.failures} files errored `
				+ 'while matching — see the console.');
		}

		const total = outcome.files.length;
		this.results = outcome.files.slice(0, MAX_RESULTS).map((file) => file.path);
		if (!total) notes.push(`No matches, out of ${outcome.tested || 0} notes searched.`);
		else if (outcome.truncated) notes.push(`First ${total} matches — refine to narrow it.`);
		else if (total > MAX_RESULTS) notes.push(`${total} matches, showing ${MAX_RESULTS}.`);
		this.note = notes.join(' ');
		this.renderResults();
	}

	/**
	 * Walk the vault the way the engine's own search does: skip ignored and
	 * unsupported files, and read file contents only when the query actually
	 * needs them — `requiredInputs` says so, and most queries do not.
	 */
	async nativeSearch(Query, query) {
		const search = new Query(this.app, query, false);
		// The parser leaves `matcher` null when it cannot make sense of the query.
		if (!search.matcher) return { files: [], invalid: true };
		// Exactly the engine's own test: `u = md||canvas` and `if (!u || !t.content)
		// skip the read`. Reading whenever `requiredInputs` looked untrustworthy
		// was my own invention, and it meant loading every file in the vault —
		// attachments included — one at a time, for every search. Mirror the host
		// rather than second-guessing it.
		const inputs = search.requiredInputs || {};
		const wantsContent = !!inputs.content;
		const cache = this.app.metadataCache;
		const out = [];
		let tested = 0;
		let failures = 0;
		let since = performance.now();
		const files = this.app.vault.getFiles();
		let scanned = 0;
		let truncated = false;
		let painted = since;
		for (const file of files) {
			scanned++;
			if (typeof cache.isUserIgnored === 'function' && cache.isUserIgnored(file.path)) continue;
			if (typeof cache.isSupportedFile === 'function' && !cache.isSupportedFile(file)) continue;
			const textual = file.extension === 'md' || file.extension === 'canvas';
			let content = '';
			if (wantsContent && textual) {
				try {
					content = await this.app.vault.cachedRead(file);
				} catch (e) {
					continue;
				}
			}
			// One unreadable or unusual file must not abandon the whole search —
			// but failing on *every* file must not look like an empty result set
			// either, so they are counted and reported.
			try {
				tested++;
				// The filter goes here rather than after the scan so the result cap
				// counts matches you can actually act on. Filtering afterwards would
				// stop at 60 raw matches and then throw most of them away.
				if (search.match(file, content) && this.inGraph(file.path)) out.push(file);
			} catch (e) {
				failures++;
				if (failures === 1) console.error('Graph Focus: could not match', file.path, e);
			}

			// Only ever MAX_RESULTS are shown, so reading the rest of the vault
			// buys nothing but a total nobody asked for. A common word now stops
			// after a few dozen files instead of every one.
			if (out.length >= MAX_RESULTS) {
				truncated = true;
				break;
			}

			const now = performance.now();
			if (now - since > 40) {
				// Stream what has been found rather than making you wait for the
				// whole scan. This is most of why Obsidian's own search feels
				// instant — it renders as results arrive.
				if (now - painted > 150) {
					this.results = out.map((match) => match.path);
					this.note = `Searching… ${scanned} of ${files.length}`;
					this.renderResults();
					painted = now;
				}
				await new Promise((resolve) => window.setTimeout(resolve, 0));
				since = performance.now();
			}
		}
		if (this.plugin.settings.debug) {
			console.log('[Graph Focus] search', {
				query,
				wantsContent,
				requiredInputs: inputs,
				tested,
				failures,
				matched: out.length,
			});
		}
		return { files: out, invalid: false, tested, failures, truncated };
	}

	/**
	 * Whether a path may appear in results. With "search only files in graph" off
	 * everything qualifies; with it on, only this pane's own nodes do — which in a
	 * local graph is a handful of notes rather than the whole vault.
	 */
	inGraph(path) {
		if (!this.plugin.settings.searchInGraphOnly) return true;
		return !!(this.renderer.nodeLookup && this.renderer.nodeLookup[path]);
	}

	/** Fallback when the query class cannot be borrowed. */
	substringSearch(query) {
		const needle = query.toLowerCase();
		return this.app.vault.getFiles()
			.filter((file) => file.path.toLowerCase().indexOf(needle) !== -1 && this.inGraph(file.path));
	}

	destroy() {
		if (this.suggest) {
			try {
				this.suggest.close();
			} catch (e) {
				/* the popup may already be gone with the pane */
			}
			this.suggest = null;
		}
		if (this.el) this.el.remove();
		this.el = null;
	}
}

class GraphFocusSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Focus lock').setHeading();

		new Setting(containerEl)
			.setName('Click a node to lock focus')
			.setDesc(`Hold the modifier below and click a node in any graph pane; click it again to `
				+ `release. Add ${this.plugin.addModifierName()} to focus several notes at once — `
				+ `every focused note stays at full strength, and everything else fades by its `
				+ `distance to the nearest one.`)
			.addToggle((t) => t
				.setValue(this.plugin.settings.clickToLock)
				.onChange(async (v) => {
					this.plugin.settings.clickToLock = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Modifier')
			.setDesc('Ctrl is also Obsidian’s "open in new tab", so Alt or Shift stay out of the way.')
			.addDropdown((d) => d
				.addOptions({ alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl / Cmd' })
				.setValue(this.plugin.settings.clickModifier)
				.onChange(async (v) => {
					this.plugin.settings.clickModifier = v;
					await this.plugin.saveSettings();
					// The add-to-focus key depends on this one, so restate it.
					this.display();
				}));

		new Setting(containerEl)
			.setName('An ordinary click focuses the node it opens')
			.setDesc('A plain click already opens the note, so the focus moves with it. This is '
				+ 'also how you come back after focusing your way around a pane: click the note '
				+ 'you have open — the centre one, in a local graph — and the focus returns to it.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.clickFocuses)
				.onChange(async (v) => {
					this.plugin.settings.clickFocuses = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Follow the active note')
			.setDesc('Focus whatever note you navigate to, without clicking. A pane you have pinned '
				+ 'is left alone, and so is any focus you set by hand — until the next time you '
				+ 'open a note, which takes the focus back.')
			.addDropdown((d) => d
				.addOptions({
					local: 'In local graph panes',
					all: 'In every graph pane',
					off: 'Off',
				})
				.setValue(this.plugin.settings.followMode)
				.onChange(async (v) => {
					this.plugin.settings.followMode = v;
					await this.plugin.saveSettings();
					this.plugin.onFileOpen(this.app.workspace.getActiveFile());
				}));

		new Setting(containerEl)
			.setName('Focus panel')
			.setDesc('A panel in the corner of every graph pane listing what is currently '
				+ 'highlighted, with a button on each to unfocus it.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.showPanel)
				.onChange(async (v) => {
					this.plugin.settings.showPanel = v;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.showPanel) {
			const sub = containerEl.createDiv('graph-focus-subsettings');

			new Setting(sub)
				.setName('Searching')
				.setDesc('Adds a search box taking Obsidian’s own query syntax, with completion for '
					+ 'operators, tags, folders and properties. Results are listed for you to click, '
					+ 'which adds them to the highlights.')
				.addToggle((t) => t
					.setValue(this.plugin.settings.showSearch)
					.onChange(async (v) => {
						this.plugin.settings.showSearch = v;
						await this.plugin.saveSettings();
						this.display();
					}));

			if (this.plugin.settings.showSearch) {
				const subSub = sub.createDiv('graph-focus-subsettings');
				new Setting(subSub)
					.setName('Search only files in the graph')
					.setDesc('Drop matches that are not nodes in the pane you are searching from. A '
						+ 'local graph holds only its neighbourhood, so most of the vault cannot be '
						+ 'highlighted there — this hides those rather than greying them out.')
					.addToggle((t) => t
						.setValue(this.plugin.settings.searchInGraphOnly)
						.onChange(async (v) => {
							this.plugin.settings.searchInGraphOnly = v;
							await this.plugin.saveSettings();
						}));
			}

			new Setting(sub)
				.setName('Show history of highlighted nodes')
				.setDesc('Lists what you have focused recently, so you can put one back without '
					+ 'searching for it again. Kept across restarts.')
				.addToggle((t) => t
					.setValue(this.plugin.settings.showHistory)
					.onChange(async (v) => {
						this.plugin.settings.showHistory = v;
						await this.plugin.saveSettings();
					}));

		}

		new Setting(containerEl)
			.setName('Name connected notes in the graph')
			.setDesc('Draw the names of everything one link from the focus at readable size, the way '
				+ 'the focused note itself is named — so you can read the neighbourhood without '
				+ 'zooming in or hovering. Only their labels change; the ring and highlight colour '
				+ 'stay reserved for what is actually focused.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.labelConnected)
				.onChange(async (v) => {
					this.plugin.settings.labelConnected = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show aliases in the graph')
			.setDesc('List a note’s aliases under its name, one per line. Uses Obsidian’s own alias '
				+ 'parsing, so `alias` and `aliases` and both string and list forms all count. Only '
				+ 'visible where the name is — so mostly on focused notes and their neighbours '
				+ 'until you zoom in.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.showAliases)
				.onChange(async (v) => {
					this.plugin.settings.showAliases = v;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.showAliases) {
			const sub = containerEl.createDiv('graph-focus-subsettings');
			new Setting(sub)
				.setName('Aliases shown')
				.setDesc('How many to list under a name before the rest are left off. A note with a '
					+ 'long list of aliases would otherwise push a column of text across the graph.')
				.addSlider((s) => s
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.maxAliases)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxAliases = v;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Arrows in the middle of links')
			.setDesc('Obsidian fades link arrows out below a zoom of 0.3 and parks them against the '
				+ 'target node, which puts them under it once zoomed out. This moves each arrow to '
				+ 'the middle of its link and keeps it as visible as the link itself. Obsidian’s own '
				+ 'arrows toggle still has to be on.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.midArrows)
				.onChange(async (v) => {
					this.plugin.settings.midArrows = v;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.midArrows) {
			const sub = containerEl.createDiv('graph-focus-subsettings');
			new Setting(sub)
				.setName('Arrow size')
				.setDesc('Multiplies the size Obsidian would have drawn them at, so they still track '
					+ 'the graph’s own line thickness and the zoom.')
				.addSlider((s) => s
					.setLimits(0.25, 4, 0.05)
					.setValue(this.plugin.settings.arrowSize)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.arrowSize = v;
						await this.plugin.saveSettings();
					}));

			new Setting(sub)
				.setName('Arrow shrink with zoom')
				.setDesc('Obsidian holds arrows at a constant size on screen however far you zoom, '
					+ 'while nodes shrink — which is why arrows look like they grow on the way out. '
					+ 'At 0 you get Obsidian’s behaviour, at 0.5 arrows shrink exactly as nodes do, '
					+ 'at 1 they are pinned to the graph and shrink with everything else.')
				.addSlider((s) => s
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.arrowZoom)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.arrowZoom = v;
						await this.plugin.saveSettings();
					}));

			new Setting(sub)
				.setName('Arrows match link colour')
				.setDesc('Take each arrow’s colour from its own link instead of the single flat '
					+ 'arrow colour, so arrows pick up the highlight colour and its drift with '
					+ 'depth along with the link they belong to.')
				.addToggle((t) => t
					.setValue(this.plugin.settings.arrowMatchLinks)
					.onChange(async (v) => {
						this.plugin.settings.arrowMatchLinks = v;
						await this.plugin.saveSettings();
					}));

			new Setting(sub)
				.setName('Arrows per link')
				.setDesc('At zero, one arrow in the middle of each link. Raise it to repeat them '
					+ 'along the link, more of them the longer it is, up to '
					+ `${MAX_ARROWS_PER_LINK}. Useful for telling direction at a glance on a graph `
					+ 'where links run a long way.')
				.addSlider((s) => s
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.arrowDensity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.arrowDensity = v;
						await this.plugin.saveSettings();
					}));

			new Setting(sub)
				.setName('Double arrows both ways')
				.setDesc('When two notes link to each other, Obsidian keeps only one of the two '
					+ 'lines — so a single arrow in the middle of it would claim a direction the '
					+ 'link does not have. This draws a head at each end instead, so a mutual link '
					+ 'is visibly mutual.')
				.addToggle((t) => t
					.setValue(this.plugin.settings.doubleArrows)
					.onChange(async (v) => {
						this.plugin.settings.doubleArrows = v;
						await this.plugin.saveSettings();
					}));
		}

		this.displayConnexions(containerEl);

		new Setting(containerEl)
			.setName('Display settings in the graph')
			.setDesc('A settings button in the bottom-right of every graph pane, opposite the focus '
				+ 'panel, for changing things without leaving the graph.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.showGraphSettings)
				.onChange(async (v) => {
					this.plugin.settings.showGraphSettings = v;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.showGraphSettings) {
			const sub = containerEl.createDiv('graph-focus-subsettings');
			sub.createEl('p', {
				cls: 'setting-item-description',
				text: 'Which options that button offers. Everything stays available here whether or '
					+ 'not it is ticked.',
			});
			for (const option of QUICK_OPTIONS) {
				new Setting(sub)
					.setName(option.name)
					.addToggle((t) => t
						.setValue((this.plugin.settings.graphSettingsKeys || []).indexOf(option.key) !== -1)
						.onChange(async (v) => {
							const keys = (this.plugin.settings.graphSettingsKeys || []).slice();
							const at = keys.indexOf(option.key);
							if (v && at === -1) keys.push(option.key);
							else if (!v && at !== -1) keys.splice(at, 1);
							// Kept in registry order so the popover reads consistently
							// however they were ticked.
							this.plugin.settings.graphSettingsKeys = QUICK_OPTIONS
								.map((entry) => entry.key)
								.filter((key) => keys.indexOf(key) !== -1);
							await this.plugin.saveSettings();
						}));
			}
		}

		new Setting(containerEl)
			.setName('Move the view to the focused note')
			.setDesc('Glide the graph until the focused note sits in the middle of the pane, instead '
				+ 'of leaving you to find it. Your own panning or dragging cancels it immediately.')
			.addDropdown((d) => d
				.addOptions({
					follow: 'When following the active note',
					always: 'On any change of focus',
					off: 'Off',
				})
				.setValue(this.plugin.settings.panMode)
				.onChange(async (v) => {
					this.plugin.settings.panMode = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show a notice when locking')
			.addToggle((t) => t
				.setValue(this.plugin.settings.notices)
				.onChange(async (v) => {
					this.plugin.settings.notices = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Log clicks to the console')
			.setDesc('Troubleshooting only. Prints what the plugin sees on every node click — '
				+ 'which note it thinks is active, and whether it matched.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.debug)
				.onChange(async (v) => {
					this.plugin.settings.debug = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Depth fade').setHeading();

		containerEl.createEl('p', {
			text: 'The focused node and its direct links stay at full strength. Everything further out '
				+ 'fades by a fixed ratio per hop, for as many hops as the graph has, so how far '
				+ 'something sits from the focus is readable at a glance.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Depth gradient')
			.setDesc('Turn off for Obsidian’s flat dim — full strength for the focus and its direct '
				+ 'links, dim beyond. Everything else the plugin does still applies, including '
				+ 'around every focused note rather than just the last one.')
			.addToggle((t) => t
				.setValue(this.plugin.settings.gradient)
				.onChange(async (v) => {
					this.plugin.settings.gradient = v;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Link colour')
			.setDesc('Obsidian only tints links that touch the focused note, and leaves everything '
				+ 'else the ordinary link colour.')
			.addDropdown((d) => d
				.addOptions({
					blend: 'Drift back to the default colour',
					highlight: 'Keep the highlight colour throughout',
					native: 'Leave Obsidian’s colours alone',
				})
				.setValue(this.plugin.settings.linkColorMode)
				.onChange(async (v) => {
					this.plugin.settings.linkColorMode = v;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.linkColorMode === 'blend') {
			new Setting(containerEl)
				.setName('Colour drift per hop')
				.setDesc('How much of the highlight colour survives each extra hop. Keep this above '
					+ 'the opacity falloff and the colour lags behind the fade, so links change '
					+ 'hue gradually rather than all at once.')
				.addSlider((s) => s
					.setLimits(0.1, 0.95, 0.01)
					.setValue(this.plugin.settings.colorFalloff)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.colorFalloff = v;
						await this.plugin.saveSettings();
					}));
		}

		// Link colour above stays available with the fade off — it is independent
		// of it. Only the curve's own controls go.
		if (!this.plugin.settings.gradient) return;

		let updatePreview = () => {};

		const slider = (key, name, desc, min, max, step) => new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addSlider((s) => s
				.setLimits(min, max, step || 0.01)
				.setValue(this.plugin.settings[key])
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings[key] = v;
					updatePreview();
					await this.plugin.saveSettings();
				}));

		slider('falloff', 'Falloff per hop',
			'How fast things drop off. Each extra hop multiplies opacity by this, so a low value '
			+ 'collapses to the immediate neighbourhood and a high one keeps distant notes readable.',
			0.1, 0.95);

		slider('curveShape', 'Curve shape',
			'The shape of the fade, as opposed to its speed. At 1 every hop costs the same ratio, '
			+ 'so the first step is the harshest and the tail is long. Above 1 the near hops are '
			+ 'stretched — a gentle start that bites further out, good for reading a wide '
			+ 'neighbourhood. Below 1 it drops at once and then flattens, isolating the immediate '
			+ 'links.',
			0.4, 2.5);

		slider('fullRings', 'Hops at full strength',
			'How many rings stay completely undimmed before the fade begins. At 1 the focused note '
			+ 'and its direct links are bright, which is what Obsidian does. Raise it to hold a '
			+ 'wider neighbourhood at full strength and start fading beyond that.',
			1, 4, 1);

		slider('minAlpha', 'Floor',
			`Opacity never drops below this. Obsidian's own dim is ${NATIVE_DIM}; going lower pushes `
			+ 'far-away notes further back than it normally allows. Anything not connected to the '
			+ 'focused note at all sits here too.',
			0, 0.4);

		const preview = containerEl.createDiv({ cls: 'setting-item-description' });
		preview.style.marginBottom = '0.75em';
		updatePreview = () => {
			const steps = [];
			for (let depth = 0; depth <= 7; depth++) {
				steps.push(this.plugin.alphaForDepth(depth).toFixed(2));
			}
			preview.setText(`Opacity at depth 0 to 7:   ${steps.join('   ')}`);
		};
		updatePreview();

		new Setting(containerEl)
			.addButton((b) => b
				.setButtonText('Reset fade to defaults')
				.onClick(async () => {
					for (const key of ['falloff', 'minAlpha', 'curveShape', 'fullRings']) {
						this.plugin.settings[key] = DEFAULT_SETTINGS[key];
					}
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl).setName('Local graph').setHeading();
		containerEl.createEl('p', {
			text: 'The gradient only has something to show when more than one ring of notes is on screen. '
				+ 'In a local graph pane, open the filter controls and raise Depth to 3 or 4.',
			cls: 'setting-item-description',
		});
	}

	/**
	 * The Connexions section: an ordered list of rules, each matching links by
	 * the property they were written in and giving them a symbol, a line and a
	 * colour.
	 */
	displayConnexions(containerEl) {
		const plugin = this.plugin;

		new Setting(containerEl).setName('Connexions').setHeading();

		containerEl.createEl('p', {
			text: 'Draw links differently depending on the property they were written in, so the '
				+ 'graph shows what kind of relation each one is instead of one identical line for '
				+ 'all of them. Rules are tried in order and the first one that matches a link '
				+ 'decides all three of its styles — so put the specific ones above the general '
				+ 'ones, and “Any link” last.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Style links by property')
			.setDesc('Off leaves every link exactly as Obsidian draws it, rules and all.')
			.addToggle((t) => t
				.setValue(plugin.settings.connexions)
				.onChange(async (v) => {
					plugin.settings.connexions = v;
					await plugin.saveSettings();
					this.display();
				}));

		if (!plugin.settings.connexions) return;

		const rules = Array.isArray(plugin.settings.connexionRules)
			? plugin.settings.connexionRules
			: [];

		// Every property in the vault that holds a link, plus the four kinds that
		// have no property behind them. A rule pointing at something no longer
		// present is kept in the list rather than silently switched to another.
		const options = {};
		for (const kind of [KIND_ANY, KIND_BODY, KIND_EMBED, KIND_TAG]) options[kind] = KIND_LABELS[kind];
		for (const prop of plugin.linkProperties()) options[prop] = prop;
		for (const rule of rules) {
			if (rule && rule.property && !options[rule.property]) {
				options[rule.property] = `${rule.property} (not in the vault)`;
			}
		}

		const save = async (redraw) => {
			plugin.settings.connexionRules = rules;
			await plugin.saveSettings();
			if (redraw) this.display();
		};

		const list = containerEl.createDiv('graph-focus-rules');

		rules.forEach((rule, index) => {
			const row = list.createDiv('graph-focus-rule');

			const header = new Setting(row)
				.setName(`Links in ${options[rule.property] || rule.property}`)
				.addExtraButton((b) => b
					.setIcon('chevron-up')
					.setTooltip('Move up — earlier rules win')
					.setDisabled(index === 0)
					.onClick(() => {
						rules.splice(index - 1, 0, rules.splice(index, 1)[0]);
						save(true);
					}))
				.addExtraButton((b) => b
					.setIcon('chevron-down')
					.setTooltip('Move down')
					.setDisabled(index === rules.length - 1)
					.onClick(() => {
						rules.splice(index + 1, 0, rules.splice(index, 1)[0]);
						save(true);
					}))
				.addExtraButton((b) => b
					.setIcon('trash-2')
					.setTooltip('Remove this rule')
					.onClick(() => {
						rules.splice(index, 1);
						save(true);
					}));
			header.settingEl.addClass('graph-focus-rule-header');
			if (rule.enabled === false) header.settingEl.addClass('graph-focus-rule-off');

			new Setting(row)
				.setName('Property')
				.addToggle((t) => t
					.setTooltip('Use this rule')
					.setValue(rule.enabled !== false)
					.onChange((v) => {
						rule.enabled = v;
						save(true);
					}))
				.addDropdown((d) => d
					.addOptions(options)
					.setValue(rule.property)
					.onChange((v) => {
						rule.property = v;
						save(true);
					}));

			new Setting(row)
				.setName('Symbol')
				.addDropdown((d) => d
					.addOptions(SYMBOL_OPTIONS)
					.setValue(rule.symbol || 'inherit')
					.onChange((v) => {
						rule.symbol = v;
						save(false);
					}));

			new Setting(row)
				.setName('Line')
				.addDropdown((d) => d
					.addOptions(LINE_OPTIONS)
					.setValue(rule.line || 'inherit')
					.onChange((v) => {
						rule.line = v;
						save(true);
					}));

			const color = new Setting(row)
				.setName('Colour')
				.addDropdown((d) => d
					.addOptions(COLOR_OPTIONS)
					.setValue(rule.color || 'inherit')
					.onChange((v) => {
						rule.color = v;
						save(true);
					}));

			if ((rule.color || 'inherit') === 'custom') {
				color.addColorPicker((c) => c
					.setValue(rule.customColor || DEFAULT_RULE_COLOR)
					.onChange((v) => {
						rule.customColor = v;
						save(false);
					}));
			}
		});

		if (!rules.length) {
			list.createEl('p', {
				text: 'No rules yet — nothing is styled until you add one.',
				cls: 'setting-item-description',
			});
		}

		new Setting(containerEl)
			.addButton((b) => b
				.setButtonText('Add a rule')
				.setCta()
				.onClick(() => {
					const props = plugin.linkProperties();
					rules.push({
						property: props.length ? props[0] : KIND_BODY,
						enabled: true,
						symbol: 'inherit',
						line: 'inherit',
						color: 'custom',
						customColor: DEFAULT_RULE_COLOR,
					});
					save(true);
				}));

		const patterned = rules.some((rule) => rule && rule.enabled !== false
			&& (rule.line === 'dashed' || rule.line === 'dotted'));
		if (patterned) {
			new Setting(containerEl)
				.setName('Dash length')
				.setDesc('How long one dash and its gap are on screen, in pixels — so the pattern '
					+ 'holds its size however far you zoom. Dots run at a little under half this.')
				.addSlider((s) => s
					.setLimits(4, 40, 1)
					.setValue(plugin.settings.dashPeriod)
					.setDynamicTooltip()
					.onChange(async (v) => {
						plugin.settings.dashPeriod = v;
						await plugin.saveSettings();
					}));
		}

		const hides = rules.some((rule) => rule && rule.enabled !== false && rule.line === 'hidden');
		if (hides) {
			containerEl.createEl('p', {
				text: 'A hidden link is taken out of the graph’s data rather than just left '
					+ 'undrawn, so it stops pulling its two notes together. Changing which links '
					+ 'are hidden restarts the layout, which is why the graph jumps when you do it.',
				cls: 'setting-item-description',
			});
		}

		const symbols = rules.some((rule) => rule && rule.enabled !== false
			&& rule.symbol && rule.symbol !== 'inherit' && rule.symbol !== 'none');
		if (symbols && !plugin.settings.midArrows) {
			containerEl.createEl('p', {
				text: 'Symbols are drawn where Obsidian puts arrows — against the target note, and '
					+ 'faded out below a zoom of 0.3. Turn on “Arrows in the middle of links” above '
					+ 'to see them at any zoom.',
				cls: 'setting-item-description',
			});
		}
	}
}

module.exports = GraphFocusPlugin;
