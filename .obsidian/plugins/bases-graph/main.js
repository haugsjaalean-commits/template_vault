'use strict';

/*
 * Bases Graph View
 * ----------------
 * Adds a "Graph" view type to Bases. Instead of drawing a graph from scratch,
 * it builds Obsidian's own graph view (renderer + data engine) inside the Bases
 * view container and scopes it to the notes the base returns.
 *
 * How the scoping works (see the guide note for the full reverse-engineering):
 * the graph's data engine decides which nodes exist through a single per-path
 * predicate, which reads two plain instance fields:
 *
 *     searchQueries === null   -> everything is included
 *     otherwise                -> fileFilter[path], or !hasFilter if absent
 *
 * So we wrap engine.render(), swap in a fileFilter built from the base's rows,
 * let Obsidian draw, and restore the originals afterwards. Nothing is
 * reimplemented: theme colours, forces, the controls panel, hover previews,
 * click-to-open and the right-click menu are all Obsidian's own.
 */

const obsidian = require('obsidian');

const VIEW_TYPE = 'graph';
const GRAPH_VIEW_TYPE = 'graph';
const OPTIONS_KEY = 'graphOptions';

/*
 * Stand-in search query. Its only job is to make searchQueries non-null so the
 * engine consults fileFilter at all. It passes tags and attachments through
 * untouched, so those follow whatever the user set in the graph's own controls.
 */
const PASS_ALL_QUERY = {
	color: null,
	query: {
		matchTag: function () { return true; },
		matchFilepath: function () { return true; },
	},
};

function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

/* ------------------------------------------------------------ property nodes
 *
 * Tags are already nodes in Obsidian's graph despite not being notes, and
 * nothing about them is special-cased: renderer.setData() takes
 * {id: {type, links, color}} with arbitrary string ids. Property nodes are the
 * same trick, two levels deep — a node per property, linked to a node per
 * distinct value, linked to the notes carrying it.
 *
 * Ids are prefixed with NUL, which cannot occur in a vault path, so a synthetic
 * node can never collide with a real one.
 */

const NUL = String.fromCharCode(0);
const KEY_PREFIX = NUL + 'K' + NUL;
const VALUE_PREFIX = NUL + 'V' + NUL;
const MODE_LEVELS = 'levels';
const MODE_FLAT = 'flat';

/*
 * How a rank is spaced out. 'position' places a value at the position of the
 * first note holding it, so three notes at the top push the next value well
 * down. 'value' gives every distinct value an equal step regardless of how many
 * notes hold it. Ties draw identically either way.
 *
 * Declared above DEFAULT_SETTINGS because it references them: a `const` used
 * earlier in the file than it is declared throws at load, and a plugin that
 * throws at load never registers its view.
 */
const RANK_POSITION = 'position';
const RANK_VALUE = 'value';
/*
 * The odd one out: 'position' and 'value' both rank by *ordering*, so the first
 * row always gets a full ring and the last always none, whatever the numbers
 * are. 'proportional' reads the number itself and ignores the sort entirely — a
 * 5 out of 10 draws a half ring even if nothing else is rated.
 */
const RANK_PROPORTIONAL = 'proportional';
/*
 * Proportional on a log scale. Anything long-tailed — file size, word count,
 * link count — puts almost every note within a rounding error of the smallest
 * when scaled linearly, because a handful of outliers own the whole range. On a
 * log scale each step of ring size is a multiplication rather than an addition,
 * which is how those quantities actually vary.
 */
const RANK_LOG = 'log';

const NEIGHBOUR_DEPTH_KEY = 'neighbourDepth';
const MAX_NEIGHBOUR_DEPTH = 5;
const RING_RANK_KEY = 'ringRank';
/*
 * Ring spread, in multiples of RING_UNIT — so 1 puts the top of the sort one
 * smallest-node-radius beyond its own edge, and 0 draws every ring flush.
 * Replaces the old ringGrowth, which was a multiplier starting at 1 and could
 * not express "no spread" or anything really large.
 */
const RING_SPREAD_KEY = 'ringSpread';
const DEFAULT_RING_SPREAD = 2;
const MAX_RING_SPREAD = 40;
/*
 * Uncapped rings. Spread answers "how big is the largest ring" — every rank is
 * squeezed into that range, so the top of the sort is the same size whether the
 * base holds ten notes or two thousand. Uncapped answers the other question:
 * "how much does one step of the sort add", and the largest ring is then
 * whatever the base's own size makes it. Nothing else changes — the ranks, the
 * cut-off and the minimum gap all still mean what they meant.
 */
const RING_UNCAPPED_KEY = 'ringUncapped';
/*
 * How fast the rings grow, as a 0–100 dial rather than a quantity.
 *
 * The quantity behind it is growth per step of the sort, in multiples of
 * RING_UNIT — but what counts as a step differs by three orders of magnitude
 * between one base and the next: 1800 rows ranked by position against a rating
 * out of 10. A linear slider over that range is unusable at one end and too
 * coarse at the other, so the dial is cubed: speed 5 is ~0.001 of a node radius
 * per step, speed 100 is 10 of them, and the useful region simply sits at a
 * different part of the dial depending on how big the base is.
 */
/* Not `ringGrowth`: that key already meant the retired 1.2–5 multiplier above,
 * and a base still carrying one would be read as a speed. */
const RING_SPEED_KEY = 'ringSpeed';
const MAX_RING_SPEED = 100;
// 20 puts the top of a ~50-row base about one large node beyond its own edge.
const DEFAULT_RING_SPEED = 20;
// What the top of the dial is worth, in RING_UNITs per step.
const RING_GROWTH_CEILING = 10;

const DEFAULT_SETTINGS = {
	propertyNodes: true,
	// 'levels': property -> value -> notes. 'flat': property -> notes, with the
	// values only listed in the panel.
	propertyMode: MODE_LEVELS,
	hideEmptyValues: true,
	// Depth lives on the view, not here — see NEIGHBOUR_DEPTH_KEY. How far out to
	// look is a property of a particular base, not of the plugin.
	// 'dim' | 'group' | 'none' — see NEIGHBOUR_* below. dimNeighbours is the old
	// boolean form, kept only so existing settings migrate.
	neighbourColor: 'dim',
	dimNeighbours: true,
	hideOrphanAttachments: true,
	sortRings: true,
	/*
	 * Skip rings whose node the renderer has culled. Much cheaper with many notes,
	 * but not free of consequence: `circle.visible` is computed from the *node's*
	 * radius, and a ring is larger than its node — so a big ring belonging to a
	 * node just off screen is dropped even though part of it would have shown.
	 */
	cullRings: true,
	/*
	 * Screen pixels. A ring standing less than this far off its node's edge is not
	 * drawn. 0.5 is the point below which it would be inside the node anyway, so
	 * the default costs nothing visually; raising it trades the low end of the
	 * sort for less drawing work.
	 */
	ringMinGap: 0.5,
	/*
	 * Draw at most this many rings, keeping the highest ranked. 0 is unlimited.
	 *
	 * Both renderers turned out to be expensive at ~1600 rings — the immediate one
	 * for tessellating them all every frame, the pooled one for putting that many
	 * objects in the scene. Neither is fixed by drawing them more cleverly, so the
	 * lever that actually works is drawing fewer.
	 */
	maxRings: 0,
	/*
	 * The engine builds the timelapse button for anything that is not a local
	 * graph, so a Bases graph gets one. It replays the vault's history, which says
	 * nothing about a filtered set of notes, so it is hidden by default here.
	 */
	hideAnimate: true,
	/*
	 * 'pooled' keeps one Graphics per ringed note and only rebuilds its geometry
	 * when the radius or line width actually changes — position, colour and fade
	 * are transform and tint writes, which is how Obsidian draws its own nodes.
	 * 'immediate' clears one Graphics and re-tessellates every ring every frame:
	 * simpler, no objects to keep alive, and much slower with many notes.
	 */
	ringDraw: 'pooled',
	// Ring spacing and spread both live on the view — see RING_RANK_KEY and
	// RING_SPREAD_KEY. What the rings mean, and how far they reach, are both
	// properties of the base rather than of the plugin.
	groupColors: true,
	/*
	 * Which colouring wins where both apply. A colour group in the graph's own
	 * controls is the user pointing at a set of notes by hand; the plugin's
	 * colouring — group colours, the muted linked-note colour — is derived from
	 * configuration. The hand-made statement wins by default, and it is also the
	 * only one of the two that can name a particular note: the group palette is
	 * assigned by index.
	 */
	colorGroupsOverride: true,
	groupLegend: true,
	/*
	 * The graph's own colour groups as legend rows of their own. Worth having
	 * whichever precedence is set — with colour groups winning they are the
	 * unexplained colours on screen, and with the base winning they are the ones
	 * that only show up on notes the base did not colour.
	 */
	legendColorGroups: true,
	legendCollapsed: false,
	// One switch for the hover label, covering both sources of colour: the base's
	// group-by and a colour group from the graph's own controls. A note in both
	// gets a line for each — you get both or neither.
	groupTooltip: true,
	tooltipEmptyGroup: true,
	/*
	 * The other thing the graph says about a note without naming it: its value for
	 * the property the base sorts by — the number the ring around it is drawn from.
	 * A separate switch from the group label, because they answer different
	 * questions and a base may well be sorted without being grouped.
	 */
	sortTooltip: true,
	/*
	 * The markers in front of the label's lines: a filled dot carrying the group's
	 * colour, and a hollow ring on the sorted value. Each is one switch, because
	 * they point at two different things — the colour of the node, and the ring
	 * around it — and either is worth having without the other. Lines left without
	 * a marker indent to keep the column, so any combination still lines up.
	 */
	tooltipSwatch: true,
	tooltipRing: true,
	colorEmptyGroup: true,
};

const NEIGHBOUR_DIM = 'dim';
const NEIGHBOUR_GROUP = 'group';
const NEIGHBOUR_NONE = 'none';

const MAX_LEGEND_ROWS = 50;
/*
 * "No value" reaches us in two shapes — an absent property gives a keyless
 * group, a present-but-blank one gives a real key that stringifies to nothing —
 * and both mean the same thing to a reader, so they share one label. A note with
 * no label at all is a different case again: not a row of this base.
 */
const EMPTY_GROUP_LABEL = '(none)';

function rgbToCss(rgb) {
	return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

/*
 * Colours arrive as {a, rgb} objects from two places — Obsidian's colour-group
 * pickers and this plugin's palette — and are compared by value rather than by
 * reference, since the engine copies them around freely.
 */
function colorKey(color) {
	if (!color || typeof color !== 'object') return 'none';
	const alpha = typeof color.a === 'number' ? color.a : 1;
	return (color.rgb >>> 0) + ':' + alpha;
}

/*
 * Obsidian has no random-colour API — a new graph colour group just opens a
 * picker. These are its own palette variables, so the colours follow the theme
 * and match what the rest of the app uses. Groups beyond the eighth step around
 * the hue circle instead.
 */
const PALETTE_VARS = [
	'--color-red', '--color-orange', '--color-yellow', '--color-green',
	'--color-cyan', '--color-blue', '--color-purple', '--color-pink',
];
const GOLDEN_ANGLE = 137.508;
const RING_FAILURE_LIMIT = 3;
const RING_BENCH_FRAMES = 60;
const RING_BENCH_CYCLES = 12;
// getSize() clamps to max(8, ...), so this is the radius of the smallest node.
const RING_UNIT = 8;
/* How far the hover label stands off the top of the node it describes, in CSS
 * pixels. Enough that the label never sits under the cursor that summoned it —
 * the pointer is inside the node, the label is clear of it. */
const TOOLTIP_GAP = 10;


function parseRgbInt(text) {
	const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(String(text));
	if (!match) return null;
	const r = Math.round(Number(match[1])) & 255;
	const g = Math.round(Number(match[2])) & 255;
	const b = Math.round(Number(match[3])) & 255;
	return (r << 16) | (g << 8) | b;
}

function hslToRgbInt(h, s, l) {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60) { r = c; g = x; }
	else if (h < 120) { r = x; g = c; }
	else if (h < 180) { g = c; b = x; }
	else if (h < 240) { g = x; b = c; }
	else if (h < 300) { r = x; b = c; }
	else { r = c; b = x; }
	const to255 = function (v) { return Math.round((v + m) * 255) & 255; };
	return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/*
 * Unique per note by definition, so they would add one value node per row and
 * say nothing. They are also the default order, which every base has before the
 * Properties panel is touched.
 */
const SKIP_PROPERTY_IDS = new Set(['file.name', 'file.path', 'file.file']);

const MAX_VALUES_PER_PROPERTY = 50;
const MAX_PANEL_ROWS = 200;

function isSyntheticId(id) {
	return typeof id === 'string' && id.charCodeAt(0) === 0;
}

/*
 * A node's label is Vl(id) — the basename after the last "/", minus a .md
 * extension — which would mangle both the NUL prefix and any value containing a
 * slash. getDisplayText is wrapped on the node prototype instead, so labels are
 * exact. The prototype is shared with every real graph pane in the app, hence
 * one install for all views, reference counted, and a lookup that only answers
 * for ids no real node can have.
 */
const LABELS = new Map();
let labelRestore = null;
let labelUsers = 0;

function retainLabels() {
	labelUsers++;
}

function ensureLabelWrap(sampleNode) {
	if (labelRestore || !sampleNode) return;
	const proto = Object.getPrototypeOf(sampleNode);
	if (!proto || typeof proto.getDisplayText !== 'function') return;

	const original = proto.getDisplayText;
	proto.getDisplayText = function () {
		const label = LABELS.get(this.id);
		return label !== undefined ? label : original.call(this);
	};
	labelRestore = function () { proto.getDisplayText = original; };
}

function releaseLabels() {
	labelUsers = Math.max(0, labelUsers - 1);
	if (labelUsers > 0) return;
	if (labelRestore) {
		try { labelRestore(); } catch (e) { console.error('[bases-graph]', e); }
		labelRestore = null;
	}
	LABELS.clear();
}

/* A property id as stored by a `property` option row, e.g. "note.language". */
function propertyLabel(raw) {
	const at = String(raw).indexOf('.');
	return at === -1 ? String(raw) : String(raw).slice(at + 1);
}

/*
 * A note with nothing in a property gets Obsidian's NullValue, whose toString is
 * the literal "null" — so without this a "null" node collects every note that is
 * simply missing the property. The class carries a static `type`, so this
 * recognises it outright rather than matching on the word.
 */
function isEmptyValue(raw, text) {
	if (raw === null || raw === undefined) return true;
	if (raw.constructor && raw.constructor.type === 'Null') return true;
	const trimmed = String(text).trim().toLowerCase();
	return trimmed === '' || trimmed === 'null' || trimmed === 'undefined';
}

/*
 * Every displayable string a cell holds. A list property contributes one value
 * per item, which is what makes `tags` or `related` behave like tags do.
 */
function valueStrings(value, hideEmpty) {
	if (value === null || value === undefined) return [];

	const out = [];
	const push = function (raw) {
		if (raw === null || raw === undefined) return;
		let text;
		try {
			text = raw.toString ? raw.toString() : String(raw);
		} catch (e) {
			return;
		}
		text = String(text).trim();
		if (!text) return;
		if (hideEmpty && isEmptyValue(raw, text)) return;
		out.push(text);
	};

	if (Array.isArray(value.data) && typeof value.getNumbers === 'function') {
		for (let i = 0; i < value.data.length; i++) push(value.data[i]);
	} else {
		push(value);
	}

	return out;
}

/*
 * ---------------------------------------------------------------- distance
 *
 * `file.linkDistance()` — how many link hops separate a note from the base's
 * `this` file. This is what "Linked notes to include" should always have been:
 * a filter clause instead of a pile of extra nodes bolted on after the filter
 * has run. Rows chosen by a filter can be excluded, sorted and shown like any
 * other row; neighbours smuggled in behind it cannot.
 *
 * It costs almost nothing. resolvedLinks is already in memory, so unlike the
 * word counts there is no file to read: one breadth-first walk per origin,
 * cached, and every row after that is a Map lookup.
 */

/* Distinct origins to keep walks for before dropping the lot. */
const MAX_DISTANCE_ORIGINS = 8;

class LinkDistanceIndex {
	constructor(app) {
		this.app = app;
		this.walks = new Map();
		this.reverse = null;
	}

	/* Links changed, so every walk and the reverse index are worthless. */
	invalidate() {
		this.walks.clear();
		this.reverse = null;
	}

	/* target -> sources. resolvedLinks only points forward; distance is undirected. */
	reverseLinks(resolved) {
		if (this.reverse) return this.reverse;

		const map = new Map();
		for (const source in resolved) {
			if (!hasOwn(resolved, source)) continue;
			const targets = resolved[source];
			for (const target in targets) {
				if (!hasOwn(targets, target)) continue;
				let sources = map.get(target);
				if (!sources) {
					sources = new Set();
					map.set(target, sources);
				}
				sources.add(source);
			}
		}

		this.reverse = map;
		return map;
	}

	/* path -> hops, for every note reachable from origin. The origin itself is 0. */
	walk(originPath) {
		const cached = this.walks.get(originPath);
		if (cached) return cached;

		const distances = new Map();
		const resolved = this.app && this.app.metadataCache
			? this.app.metadataCache.resolvedLinks
			: null;
		if (!resolved) return distances;

		distances.set(originPath, 0);

		try {
			const reverse = this.reverseLinks(resolved);
			let frontier = [originPath];
			let hop = 0;

			while (frontier.length) {
				hop++;
				const next = [];

				for (const path of frontier) {
					const outgoing = resolved[path];
					if (outgoing) {
						for (const target in outgoing) {
							if (!hasOwn(outgoing, target) || distances.has(target)) continue;
							distances.set(target, hop);
							next.push(target);
						}
					}

					const incoming = reverse.get(path);
					if (incoming) {
						for (const source of incoming) {
							if (distances.has(source)) continue;
							distances.set(source, hop);
							next.push(source);
						}
					}
				}

				frontier = next;
			}
		} catch (e) {
			console.error('[bases-graph] could not measure link distance', e);
		}

		/* One base per origin is the normal case; a runaway cache is not worth it. */
		if (this.walks.size >= MAX_DISTANCE_ORIGINS) this.walks.clear();
		this.walks.set(originPath, distances);

		return distances;
	}

	distance(originPath, targetPath) {
		const hops = this.walk(originPath).get(targetPath);
		return hops === undefined ? null : hops;
	}
}

/*
 * A Bases function is a plain object; the base class is not exported, so this
 * duck-types one. The evaluator type-checks both parameters against `params`
 * before calling, exactly as it does for the built-in file.hasLink().
 */
class LinkDistanceFunction {
	constructor(index) {
		this.index = index;
		this.name = 'linkDistance';
		this.docString = 'Link hops to this note, counted in either direction. '
			+ 'Defaults to measuring from the active note; null when unreachable.';
		this.params = [
			{ name: 'self', type: [obsidian.FileValue] },
			{ name: 'from', type: [obsidian.FileValue], optional: true },
		];
	}

	applyWithContext(ctx, subject, from) {
		const target = subject && subject.file;
		if (!target) return obsidian.NullValue.value;

		const origin = this.resolveOrigin(ctx, from);
		if (!origin) return obsidian.NullValue.value;

		const hops = this.index.distance(origin.path, target.path);
		return hops === null ? obsidian.NullValue.value : new obsidian.NumberValue(hops);
	}

	/*
	 * An explicit argument wins; otherwise `this`, which Bases resolves to the
	 * active note for a base in the sidebar and to the containing note for an
	 * embed. Neither exists for a base opened as its own tab, and null is the
	 * honest answer there.
	 */
	resolveOrigin(ctx, from) {
		if (from && from.file) return from.file;

		try {
			const local = ctx && typeof ctx.getByIdentifier === 'function'
				? ctx.getByIdentifier('this')
				: null;
			if (local && local.file) return local.file;
		} catch (e) {
			/* No `this` in this context. */
		}

		return null;
	}

	serialize() {
		const args = Array.prototype.slice.call(arguments);
		const subject = args[0];
		const rest = args.slice(1).filter(function (arg) { return arg !== null && arg !== undefined; });
		return subject + '.' + this.name + '(' + rest.join(', ') + ')';
	}
}

class BasesGraphView extends obsidian.BasesView {
	constructor(controller, containerEl, owner) {
		super(controller);

		this.type = VIEW_TYPE;
		this.owner = owner || null;

		// BasesView stores this as `queryController`; `controller` is what the docs
		// call it and what the rest of this file assumed. Keeping both means the
		// query context is actually reachable — without it every lookup through
		// this.controller silently yielded undefined.
		this.controller = controller;

		this.paths = new Set();
		this.rowPaths = new Set();
		this.rowEntries = [];
		this.foldedData = null;
		this.graphView = null;
		this.engine = null;
		this.originalRender = null;
		this.observer = null;
		this.buildFailed = false;
		this.restoringOptions = false;
		this.leafCache = null;
		this.leafCacheTime = 0;
		this.hostLeaf = null;
		this.saveOptions = obsidian.debounce(this.writeOptions.bind(this), 800, true);

		this.propertyModel = [];
		this.originalSetData = null;
		this.panelEl = null;
		this.labelsRetained = false;

		this.sortRanks = new Map();
		// How many steps the normalised ranks were divided by — see computeSortRanks.
		this.rankScale = 0;
		this.groupColors = new Map();
		this.nativeColors = new Map();
		this.nativeMatches = new Map();
		this.groupLabels = new Map();
		this.tooltipEl = null;
		// The hovered node the label is anchored above, and the size it was measured
		// at — see placeTooltip.
		this.tooltipId = null;
		this.tooltipVisible = false;
		this.tooltipSize = null;
		this.neighbourPaths = new Map();
		this.entryByPath = new Map();
		this.linkedEntries = [];
		this.reverseCache = null;
		this.mutedCache = null;
		this.noneCache = null;
		this.legendModel = [];
		this.nativeLegend = [];
		this.nativeLegendKey = '';
		this.nativeLabels = new Map();
		this.legendEl = null;
		this.legendTitle = 'Groups';
		this.paletteCache = null;
		this.ringsEl = null;
		this.ringLayerEl = null;
		this.ringPool = new Map();
		this.ringFrame = 0;
		this.ringThreshold = -1;
		this.ringFailures = 0;
		this.frameCount = 0;
		this.graphTime = 0;
		this.ringTime = 0;
		this.ringsDrawn = 0;
		this.timings = null;
		this.rendererRestores = [];

		this.hostEl = containerEl.createDiv('bases-graph-host');
		this.messageEl = null;
	}

	// ---------------------------------------------------------------- lifecycle

	settings() {
		return (this.owner && this.owner.settings) || DEFAULT_SETTINGS;
	}

	/* Chrome that is toggled by CSS rather than rebuilt. */
	applyChrome() {
		this.hostEl.toggleClass('is-hiding-animate', this.settings().hideAnimate !== false);
	}

	/* The plugin calls this on every live view when a setting changes. */
	onSettingsChanged() {
		this.applyChrome();
		this.closePanel();
		this.recompute();
		this.requestRender();
	}

	onload() {
		if (this.owner && this.owner.views) this.owner.views.add(this);

		// The graph cannot be built yet: the controller assigns this.config only
		// *after* addChild() has already run onload, and the container has no size
		// until layout has happened. Both are true by the time the observer or the
		// first data update fires, so the build is deferred to whichever comes first.
		if (typeof ResizeObserver !== 'undefined') {
			this.observer = new ResizeObserver(this.onContainerResize.bind(this));
			this.observer.observe(this.hostEl);
		}

		// Clicking away dismisses the property panel. pointerdown lands before the
		// renderer's click, so clicking straight from one node to another closes
		// and reopens rather than leaving the old panel up.
		this.registerDomEvent(this.hostEl, 'pointerdown', (event) => {
			if (!this.panelEl || this.panelEl.contains(event.target)) return;
			this.closePanel();
		});

		// Backstop: leaving a node fires onNodeUnhover, but leaving the pane in one
		// motion should not be able to strand the label on screen.
		this.registerDomEvent(this.hostEl, 'pointerleave', () => this.hideTooltip());

		// The palette is resolved from the theme's own variables, so it has to be
		// re-read when the theme changes.
		const app = this.app || (this.controller && this.controller.app);
		if (app && app.workspace) {
			this.registerEvent(app.workspace.on('css-change', () => {
				this.paletteCache = null;
				this.mutedCache = null;
				this.noneCache = null;
				this.computeGroupColors();
				this.requestRender();
			}));
		}

		// The reverse link index is only valid for the link structure it was built
		// from. Debounced because 'resolved' fires freely while editing.
		if (app && app.metadataCache) {
			const onResolved = obsidian.debounce(() => {
				this.reverseCache = null;
				if (!this.neighbourDepth()) return;
				// A different set of linked notes means different rows, so the whole
				// pass has to run, not just the walk.
				this.recompute();
				this.requestRender();
			}, 500, true);
			this.registerEvent(app.metadataCache.on('resolved', onResolved));
		}
	}

	onunload() {
		if (this.owner && this.owner.views) this.owner.views.delete(this);
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		this.destroyGraph();
		this.hostEl.empty();
	}

	onDataUpdated() {
		this.recompute();
		this.closePanel();
		if (!this.graphView) {
			this.tryBuild();
			return;
		}
		this.requestRender();
	}

	onResize() {
		if (this.graphView) {
			try {
				this.graphView.onResize();
			} catch (e) {
				console.error('[bases-graph] resize failed', e);
			}
		}
	}

	focus() {
		if (this.graphView) this.graphView.contentEl.focus({ preventScroll: true });
	}

	// The controller calls these when switching between views of the same base.
	getEphemeralState() { return {}; }
	setEphemeralState() {}

	onContainerResize() {
		if (this.graphView) {
			this.onResize();
			return;
		}
		this.tryBuild();
	}

	// ------------------------------------------------------------------- build

	tryBuild() {
		if (this.graphView || this.buildFailed || !this._loaded) return;
		if (this.hostEl.clientWidth < 1 || this.hostEl.clientHeight < 1) return;
		this.build();
	}

	build() {
		const app = this.app || (this.controller && this.controller.app);
		if (!app) return;

		const registry = app.viewRegistry;
		const creator = registry && registry.getViewCreatorByType
			? registry.getViewCreatorByType(GRAPH_VIEW_TYPE)
			: null;

		if (typeof creator !== 'function') {
			this.buildFailed = true;
			this.showMessage('Turn on the core "Graph view" plugin to use this view.');
			return;
		}

		const hostLeaf = this.hostLeaf = this.createHostLeaf(app);

		let graphView;
		try {
			graphView = creator(hostLeaf);
			if (!graphView || !graphView.renderer || !graphView.dataEngine) {
				throw new Error('the graph view has an unexpected shape');
			}
		} catch (e) {
			console.error('[bases-graph] could not create the graph view', e);
			this.buildFailed = true;
			this.showMessage('Could not create the graph: ' + (e && e.message ? e.message : e));
			return;
		}

		hostLeaf.view = graphView;

		this.clearMessage();
		this.graphView = graphView;
		this.engine = graphView.dataEngine;

		// Point the engine at the leaf the base is actually displayed in, so
		// keyboard panning and the right-click file menu behave normally.
		const self = this;
		try {
			Object.defineProperty(graphView, 'leaf', {
				configurable: true,
				get: function () { return self.resolveLeaf(); },
			});
		} catch (e) {
			console.error('[bases-graph] could not install the leaf accessor', e);
		}

		// Graph settings belong to this base view, not to the global graph.
		graphView.onOptionsChange = function () { self.saveOptions(); };

		this.installFilter();
		this.installPropertyNodes();
		this.installRings();
		retainLabels();
		this.labelsRetained = true;

		try {
			graphView.load();
		} catch (e) {
			console.error('[bases-graph] the graph view failed to load', e);
			this.buildFailed = true;
			this.destroyGraph();
			this.showMessage('The graph failed to load: ' + (e && e.message ? e.message : e));
			return;
		}

		this.publish(app, graphView);
		this.applyChrome();

		this.recompute();
		this.restoreOptions();
		this.onResize();
		this.requestRender();
	}

	/*
	 * This graph is deliberately not in a workspace leaf, so anything that finds
	 * graph panes with iterateAllLeaves cannot see it — Graph Focus, for one.
	 * app.__extraGraphViews is the shared list of graph views that live outside
	 * the workspace. Entries are objects with a `renderer`; readers must tolerate
	 * the list being absent, and stale entries whose renderer has been destroyed.
	 */
	publish(app, graphView) {
		try {
			const registry = app.__extraGraphViews || (app.__extraGraphViews = []);
			if (registry.indexOf(graphView) === -1) registry.push(graphView);
			app.workspace.trigger('extra-graph-views-changed');
		} catch (e) {
			console.error('[bases-graph] could not publish the graph view', e);
		}
	}

	unpublish(graphView) {
		try {
			const app = this.app || (this.controller && this.controller.app);
			const registry = app && app.__extraGraphViews;
			if (!Array.isArray(registry)) return;
			const at = registry.indexOf(graphView);
			if (at !== -1) registry.splice(at, 1);
			app.workspace.trigger('extra-graph-views-changed');
		} catch (e) {
			console.error('[bases-graph] could not unpublish the graph view', e);
		}
	}

	destroyGraph() {
		const graphView = this.graphView;
		this.closePanel();
		if (this.labelsRetained) {
			this.labelsRetained = false;
			releaseLabels();
		}
		this.graphView = null;
		this.engine = null;
		this.originalRender = null;
		this.originalSetData = null;
		this.leafCache = null;
		this.hostLeaf = null;
		if (!graphView) return;

		// Before the renderer is destroyed, so nothing can pick it up in between.
		this.unpublish(graphView);
		this.destroyRings();

		try { graphView.unload(); } catch (e) { console.error('[bases-graph]', e); }
		try { graphView.renderer.destroy(); } catch (e) { console.error('[bases-graph]', e); }
		try { graphView.containerEl.detach(); } catch (e) { console.error('[bases-graph]', e); }
	}

	// ------------------------------------------------------------------ filter

	installFilter() {
		const engine = this.engine;
		const self = this;
		const original = engine.render.bind(engine);
		this.originalRender = original;

		engine.render = function () {
			let filter;
			try {
				filter = self.buildFileFilter(engine.fileFilter, engine.hasFilter);
			} catch (e) {
				// Never break the render loop over a filtering bug — fall back to
				// the unscoped graph rather than to a blank pane.
				console.error('[bases-graph] could not build the file filter', e);
				return original();
			}

			const savedFilter = engine.fileFilter;
			const savedHasFilter = engine.hasFilter;
			const savedQueries = engine.searchQueries;

			engine.fileFilter = filter;
			engine.hasFilter = true;
			engine.searchQueries = (savedQueries || []).concat([PASS_ALL_QUERY]);

			try {
				return original();
			} finally {
				engine.fileFilter = savedFilter;
				engine.hasFilter = savedHasFilter;
				engine.searchQueries = savedQueries;
			}
		};
	}

	/*
	 * The base's rows, intersected with whatever the graph's own search box and
	 * colour groups produced. A colour-group match stores a colour rather than
	 * `true`, and the node builder reads that value straight into node.color, so
	 * passing it through keeps colour groups working inside a scoped graph.
	 */
	buildFileFilter(nativeFilter, nativeHasFilter) {
		const native = nativeFilter && typeof nativeFilter === 'object' ? nativeFilter : {};
		const out = {};

		const groupColors = this.groupColors;
		// Two maps, because they answer different questions: what colour a node is
		// actually wearing (the tooltip), and which notes a colour group caught at
		// all (the legend, which has to keep listing a group the base outranked).
		const overrides = this.nativeColors = new Map();
		const matches = this.nativeMatches = new Map();
		const passes = function (path) {
			if (hasOwn(native, path)) return native[path];
			return nativeHasFilter ? false : true;
		};

		/*
		 * One pass now that linked notes are rows. They already carry a group colour
		 * like anything else; the setting only decides whether to keep it, replace
		 * it with the muted colour, or drop it for the plain node colour.
		 */
		const mode = this.settings().neighbourColor;
		const muted = mode === NEIGHBOUR_DIM ? this.mutedColor() : null;
		const linked = this.neighbourPaths;
		const nativeWins = this.settings().colorGroupsOverride !== false;

		this.paths.forEach(function (path) {
			const value = passes(path);
			if (!value) return;

			/*
			 * A colour group in the graph's own controls stores its colour here
			 * instead of `true`, so a non-boolean value *is* a colour-group match.
			 * Which of the two wins is the "Colour groups take precedence" setting;
			 * see colorGroupsOverride for why the default is the one it is.
			 */
			const nativeColor = typeof value === 'boolean' ? null : value;
			if (nativeColor) matches.set(path, nativeColor);

			if (nativeColor && nativeWins) {
				out[path] = nativeColor;
				overrides.set(path, nativeColor);
				return;
			}

			const ours = linked.has(path)
				? (mode === NEIGHBOUR_GROUP ? groupColors.get(path) : muted)
				: groupColors.get(path);

			out[path] = ours || value;

			// Nothing of ours painted it, so a colour group is what is on screen
			// after all — true in either precedence, and the tooltip has to know.
			if (!ours && nativeColor) overrides.set(path, nativeColor);
		});

		this.syncNativeLegend(matches, overrides);
		return out;
	}

	/*
	 * The graph's own colour groups, merged by colour.
	 *
	 * Merged, because fileFilter records a colour and not which query produced it,
	 * and two colour groups are allowed to share one. A shared colour can only ever
	 * be named by both queries at once; attributing it to one of them, or splitting
	 * a count between them, would be inventing a division the data does not have.
	 */
	readColorGroups() {
		let groups = null;
		try {
			const options = this.engine && this.engine.getOptions ? this.engine.getOptions() : null;
			groups = options && Array.isArray(options.colorGroups) ? options.colorGroups : null;
		} catch (e) {
			return [];
		}
		if (!groups || !groups.length) return [];

		const merged = [];
		const byKey = new Map();

		for (const group of groups) {
			if (!group || !group.color) continue;

			const key = colorKey(group.color);
			const label = String(group.query === undefined || group.query === null ? '' : group.query).trim();
			const existing = byKey.get(key);
			if (existing) {
				if (label) existing.label = existing.label ? existing.label + ' / ' + label : label;
				continue;
			}

			const row = { key: key, label: label, color: group.color };
			byKey.set(key, row);
			merged.push(row);
		}

		return merged;
	}

	/*
	 * Those colour groups as legend rows.
	 *
	 * Counted from the colours that actually reached the nodes, not by running the
	 * queries: a colour group's query is evaluated asynchronously by the search
	 * queue, over file contents as well as paths, so what the engine wrote into
	 * fileFilter is the only record of which notes it caught that this plugin can
	 * read. A group matching nothing in this base gets no row.
	 *
	 * `matches` decides which groups are listed and `inEffect` how many notes are
	 * actually wearing the colour. The two differ wherever the base's own colouring
	 * outranks a colour group, and the row says so: a group disappearing from the
	 * legend the moment the precedence is flipped would read as the feature being
	 * broken rather than as the precedence doing its job.
	 */
	buildNativeLegend(groups, matches, inEffect) {
		if (this.settings().legendColorGroups === false) return [];
		if (!groups.length || !matches.size) return [];

		const tally = function (source) {
			const counts = new Map();
			source.forEach(function (color) {
				const key = colorKey(color);
				counts.set(key, (counts.get(key) || 0) + 1);
			});
			return counts;
		};

		const matched = tally(matches);
		const worn = tally(inEffect);
		const rows = [];

		for (const group of groups) {
			const count = matched.get(group.key);
			if (!count) continue;

			const shown = worn.get(group.key) || 0;
			rows.push({
				label: group.label || '(no query)',
				color: group.color,
				// "3 of 12" only when the two disagree; a bare number otherwise.
				count: shown === count ? count : shown + ' of ' + count,
				outranked: shown === 0,
				colorGroup: true,
			});
		}

		return rows;
	}

	/*
	 * The base's own legend rows are built once per update, but these are only
	 * known once the engine has run its searches, which happens on a render. So
	 * the legend is redrawn from here — guarded by a signature, because a render
	 * is much more frequent than an actual change to the colour groups.
	 */
	syncNativeLegend(matches, inEffect) {
		let rows = [];
		try {
			const groups = this.readColorGroups();

			// Kept whichever way the legend setting is set: the hover tooltip names a
			// colour group from this map too, and it has a switch of its own.
			const labels = new Map();
			for (const group of groups) labels.set(group.key, group.label);
			this.nativeLabels = labels;

			rows = this.buildNativeLegend(groups, matches, inEffect);
		} catch (e) {
			console.error('[bases-graph] could not read the graph\'s colour groups', e);
		}

		const key = rows.map(function (row) {
			return row.label + ' ' + colorKey(row.color) + ' ' + row.count;
		}).join('');

		if (key === this.nativeLegendKey) return;
		this.nativeLegendKey = key;
		this.nativeLegend = rows;
		this.updateLegend();
	}

	// --------------------------------------------------------- property nodes

	/*
	 * The properties shown in this view — exactly what the Bases Properties panel
	 * controls. It writes the visible set to the view config's `order` via
	 * setOrder(), so reading getOrder() means the panel drives the graph with no
	 * separate list to keep in sync.
	 *
	 * Entries are passed to getValue() untouched, since the order may hold either
	 * property-id objects or their string form depending on how it was loaded;
	 * their string form is only used for node ids and labels.
	 */
	readVisibleProperties() {
		const config = this.config;
		const out = [];
		if (!config) return out;
		if (!this.settings().propertyNodes) return out;

		let order = null;
		try {
			if (config.getOrder) order = config.getOrder();
		} catch (e) {
			console.error('[bases-graph] could not read the visible properties', e);
		}
		if (!Array.isArray(order)) return out;

		for (const entry of order) {
			if (entry === null || entry === undefined) continue;

			let raw;
			try {
				raw = String(entry.toString ? entry.toString() : entry);
			} catch (e) {
				continue;
			}
			if (!raw || SKIP_PROPERTY_IDS.has(raw)) continue;

			let label = propertyLabel(raw);
			try {
				if (config.getDisplayName) label = config.getDisplayName(entry) || label;
			} catch (e) {
				// keep the derived label
			}

			out.push({ raw: raw, id: entry, label: label });
		}

		return out;
	}

	/*
	 * property -> value -> the notes carrying it. Values are capped: pointing this
	 * at something near-unique per note (a date, a title) would otherwise add a
	 * node per row and drown the graph.
	 */
	computePropertyModel() {
		const model = [];

		try {
			const props = this.readVisibleProperties();
			const data = this.data;
			const entries = data && Array.isArray(data.data) ? data.data : [];
			const hideEmpty = this.settings().hideEmptyValues !== false;

			for (const prop of props) {
				const values = new Map();
				const allPaths = new Set();

				for (const entry of entries) {
					const file = entry && entry.file;
					const path = file && file.path;
					if (!path) continue;

					let value;
					try {
						value = entry.getValue(prop.id);
					} catch (e) {
						continue;
					}

					for (const text of valueStrings(value, hideEmpty)) {
						let paths = values.get(text);
						if (!paths) {
							paths = new Set();
							values.set(text, paths);
						}
						paths.add(path);
						allPaths.add(path);
					}
				}

				if (!values.size) continue;

				// The cap applies only to how many value *nodes* are drawn. `values`
				// and `allPaths` stay complete, so the panel always lists everything
				// and flat mode links every note that has the property, however rare
				// its value.
				let nodeValues = values;
				let truncated = 0;
				if (values.size > MAX_VALUES_PER_PROPERTY) {
					const ranked = Array.from(values.entries())
						.sort((a, b) => b[1].size - a[1].size)
						.slice(0, MAX_VALUES_PER_PROPERTY);
					truncated = values.size - ranked.length;
					nodeValues = new Map(ranked);
				}

				model.push({
					prop: prop,
					values: values,
					nodeValues: nodeValues,
					truncated: truncated,
					allPaths: allPaths,
				});
			}
		} catch (e) {
			console.error('[bases-graph] could not read the property values', e);
		}

		this.propertyModel = model;
	}

	installPropertyNodes() {
		const renderer = this.graphView.renderer;
		const self = this;

		const originalSetData = renderer.setData.bind(renderer);
		this.originalSetData = originalSetData;

		renderer.setData = function (data) {
			try {
				self.pruneOrphanAttachments(data);
			} catch (e) {
				console.error('[bases-graph] could not prune the orphaned attachments', e);
			}

			try {
				self.injectPropertyNodes(data);
			} catch (e) {
				// A bad property must not cost the whole graph.
				console.error('[bases-graph] could not add the property nodes', e);
			}

			const result = originalSetData(data);

			try {
				ensureLabelWrap(renderer.nodes && renderer.nodes[0]);
			} catch (e) {
				console.error('[bases-graph] could not install the label wrapper', e);
			}

			return result;
		};

		this.installNodeHandlers(renderer);
	}

	/*
	 * Synthetic nodes are not files, so the engine's own handlers must not see
	 * them: it would try openLinkText on a value, or a tag search on a property.
	 */
	installNodeHandlers(renderer) {
		const self = this;

		const originalClick = renderer.onNodeClick;
		renderer.onNodeClick = function (event, id, type) {
			if (isSyntheticId(id)) {
				self.openPanel(id);
				return;
			}
			if (originalClick) return originalClick.call(this, event, id, type);
		};

		const originalRightClick = renderer.onNodeRightClick;
		renderer.onNodeRightClick = function (event, id, type) {
			if (isSyntheticId(id)) {
				self.openPanel(id);
				return;
			}
			if (originalRightClick) return originalRightClick.call(this, event, id, type);
		};

		const originalHover = renderer.onNodeHover;
		renderer.onNodeHover = function (event, id, type) {
			if (isSyntheticId(id)) {
				self.hideTooltip();
				return;
			}
			self.showTooltip(event, id);
			if (originalHover) return originalHover.call(this, event, id, type);
		};

		const originalUnhover = renderer.onNodeUnhover;
		renderer.onNodeUnhover = function () {
			self.hideTooltip();
			if (originalUnhover) return originalUnhover.apply(this, arguments);
		};
	}

	/*
	 * Which group the node under the cursor belongs to. The legend says what the
	 * colours mean; this says what a particular node is, without crossing the pane
	 * to read it.
	 */
	showTooltip(event, id) {
		const settings = this.settings();
		const parts = [];
		// Which node the label belongs to, so it can be kept above that node as the
		// simulation moves it.
		this.tooltipId = id;

		if (settings.groupTooltip !== false) {
			/*
			 * Two sources of colour, one switch: both lines or neither. A note can be in
			 * one of the base's groups *and* caught by a colour group, and the colour
			 * group goes first because when both apply it is the colour on the node.
			 */
			const native = this.nativeColors.get(id);
			if (native) {
				const query = this.nativeLabels ? this.nativeLabels.get(colorKey(native)) : '';
				parts.push({ text: query || 'Colour group', color: native, mono: !!query });
			}

			const base = this.baseGroupPart(id, settings);
			if (base) parts.push(base);
		}

		// Last: the group lines say what colours the node, this says what sized it.
		if (settings.sortTooltip !== false) {
			const sorted = this.sortValuePart(id);
			if (sorted) parts.push(sorted);
		}

		if (!parts.length) {
			this.hideTooltip();
			return;
		}

		this.showTooltipParts(event, parts);
	}

	/*
	 * The base's own group-by, as one line of the tooltip. Gated by the caller.
	 *
	 * Its swatch is the group's own palette colour — the one the legend uses —
	 * even where a colour group outranked it on screen, because that case draws
	 * the colour-group line above and two lines with one swatch say nothing twice.
	 */
	baseGroupPart(id, settings) {
		const own = this.groupColors.get(id);
		let label = this.groupLabels.get(id);

		// A note from the depth walk is not in any group; say what it is instead of
		// nothing, since it has a colour of its own on screen.
		if (label === undefined && this.neighbourPaths.has(id)) {
			return { text: 'Linked note', color: this.mutedColor(), muted: true };
		}

		// undefined, not falsy: "(empty)" is a group, "" would have been one too.
		if (label === undefined) {
			// No label can mean three different things. Only one of them is worth
			// saying: a row of this base, under an active grouping, with no value for
			// the property. A linked note from the depth walk is not a row at all,
			// and without a grouping there is nothing to report.
			if (settings.tooltipEmptyGroup === false || !this.groupingActive || !this.paths.has(id)) return null;
			label = EMPTY_GROUP_LABEL;
		}

		return {
			text: this.legendTitle ? this.legendTitle + ': ' + label : label,
			// Falls back to the default fill for exactly the rows left uncoloured, so
			// the swatch always matches something real.
			color: own || this.defaultNodeColor(),
			muted: label === EMPTY_GROUP_LABEL,
		};
	}

	/*
	 * The note's value for the property the base sorts by — what the ring around it
	 * was drawn from — as one line of the tooltip. Gated by the caller.
	 *
	 * Read live from the entry rather than kept in a map beside the ranks: the rings
	 * store a rank, not a value, and one `getValue` per hover is cheaper than a
	 * parallel index that has to be kept honest. It also means the line works with
	 * the rings switched off, which is right — the sort is the base's, not the
	 * rings'.
	 */
	sortValuePart(id) {
		let property = null;
		let config = null;
		try {
			config = this.config;
			const sort = config && config.getSort ? config.getSort() : null;
			if (sort && sort.length) property = sort[0].property;
		} catch (e) {
			property = null;
		}
		// No sort, nothing to report — the same test that gates the rings themselves.
		if (property === null || property === undefined) return null;

		let name = propertyLabel(property);
		try {
			if (config.getDisplayName) name = config.getDisplayName(property) || name;
		} catch (e) {
			// Keep the id-derived name.
		}

		const text = this.valueText(id, property);
		if (text === null) {
			/*
			 * Nothing in the property. Worth saying for a row of this base — it is why
			 * the note has no ring — but not for a note the depth walk pulled in, which
			 * is not part of the sort at all. Same distinction baseGroupPart draws, and
			 * it needs no switch of its own: with no value there is no value to hide.
			 */
			if (!this.paths || !this.paths.has(id)) return null;
			return { text: name + ': ' + EMPTY_GROUP_LABEL, muted: true, sorted: true };
		}

		return { text: name + ': ' + text, sorted: true };
	}

	/*
	 * No guard on the event any more: the label is placed against the *node*, and
	 * the cursor is only the fallback for when that cannot be worked out — so an
	 * event without coordinates is no longer a reason to show nothing.
	 */
	showTooltipParts(event, parts) {
		const host = this.hostEl;
		const el = this.tooltipEl || (this.tooltipEl = host.createDiv('bases-graph-tooltip'));
		el.empty();

		/*
		 * The marker in front of a line says which thing on screen that line is
		 * about: a filled dot for the colours, a hollow ring for the sorted value —
		 * that being the property the ring around the node is sized from. Both are
		 * switchable, so `marker` is worked out once per line rather than assumed.
		 */
		const settings = this.settings();
		const showSwatch = settings.tooltipSwatch !== false;
		const showRing = settings.tooltipRing !== false;
		const markerOf = function (part) {
			if (part.sorted) return showRing ? 'ring' : null;
			return part.color && showSwatch ? 'swatch' : null;
		};

		/*
		 * With one marker turned off and the other on, the lines would otherwise
		 * start in two different places. So a line with no marker keeps the column —
		 * but only while something in this label is actually filling it, since with
		 * both switched off there is nothing to line up against and the indent would
		 * just be a gap.
		 */
		const anyMarker = parts.some(function (part) { return !!markerOf(part); });

		for (const part of parts) {
			const line = el.createDiv('bases-graph-tooltip-line');
			line.toggleClass('is-empty-group', !!part.muted);
			// A colour group's label is its search query, which reads as code.
			line.toggleClass('is-color-group', !!part.mono);

			const marker = markerOf(part);
			line.toggleClass('is-unmarked', !marker && anyMarker);

			if (marker === 'ring') {
				line.createDiv('bases-graph-tooltip-ring');
			} else if (marker === 'swatch') {
				const swatch = line.createDiv('bases-graph-legend-swatch');
				swatch.style.backgroundColor = rgbToCss(part.color.rgb);
			}
			line.createSpan({ text: part.text });
		}

		el.addClass('is-visible');
		this.tooltipVisible = true;

		/*
		 * Measured once, here, and reused by every reposition: offsetWidth forces a
		 * layout, and the label is repositioned every frame while a node is hovered.
		 * The content cannot change without coming back through this method.
		 */
		this.tooltipSize = { width: el.offsetWidth, height: el.offsetHeight };
		this.placeTooltip(event);
	}

	/*
	 * Above the node, centred on it — not offset from the cursor, which is where it
	 * sat until v1.43.0. The label describes a particular node, so it belongs in a
	 * predictable place against that node rather than wherever the pointer entered
	 * it.
	 *
	 * `event` is only a fallback: it is used when the node's position cannot be
	 * worked out, and is absent entirely on the per-frame follow.
	 */
	placeTooltip(event) {
		const el = this.tooltipEl;
		const size = this.tooltipSize;
		if (!el || !size) return;

		const host = this.hostEl;
		const rect = host.getBoundingClientRect();
		const anchor = this.nodeAnchor(this.tooltipId);

		let centre;
		let bottom;
		if (anchor) {
			centre = anchor.x;
			bottom = anchor.top;
		} else if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
			centre = event.clientX - rect.left;
			bottom = event.clientY - rect.top;
		} else {
			return;
		}

		let left = centre - size.width / 2;
		let top = bottom - size.height - TOOLTIP_GAP;

		// Inside the pane horizontally, so a node near an edge does not push its
		// label off it.
		const limit = rect.width - size.width - 4;
		left = limit < 4 ? 4 : Math.max(4, Math.min(left, limit));
		/*
		 * Never below the node: with the label pinned above, "at the top edge" is a
		 * better answer for a node right under the ceiling than flipping underneath
		 * it, which would put the label in a different place for a handful of nodes
		 * and defeat the point of anchoring it at all.
		 */
		if (top < 4) top = 4;

		el.style.left = Math.round(left) + 'px';
		el.style.top = Math.round(top) + 'px';
	}

	/*
	 * Where a node sits in the pane, in CSS pixels, or null if it cannot be found.
	 *
	 * `screen = world * scale + pan` in *device* pixels — the relation `resetPan()`
	 * uses when it centres the origin, recorded in the Graph Focus notes — so the
	 * ratio divides back out to the CSS pixels the tooltip is positioned in. The
	 * anchor is the top of the circle rather than its centre, so the label clears
	 * the node whatever size it is.
	 */
	nodeAnchor(id) {
		if (id === null || id === undefined) return null;

		const renderer = this.graphView && this.graphView.renderer;
		if (!renderer) return null;

		const scale = renderer.scale;
		if (typeof scale !== 'number' || !isFinite(scale)) return null;

		let node = null;
		const nodes = renderer.nodes || [];
		for (const candidate of nodes) {
			if (candidate && candidate.id === id) {
				node = candidate;
				break;
			}
		}
		if (!node || typeof node.x !== 'number' || typeof node.y !== 'number') return null;

		const dpr = window.devicePixelRatio || 1;
		const x = (node.x * scale + renderer.panX) / dpr;
		const y = (node.y * scale + renderer.panY) / dpr;
		if (!isFinite(x) || !isFinite(y)) return null;

		const size = typeof node.getSize === 'function' ? node.getSize() : 0;
		const radius = size * (renderer.nodeScale || 1) * scale / dpr;
		return { x: x, top: y - (isFinite(radius) ? radius : 0) };
	}

	/*
	 * The simulation keeps moving the node under a stationary cursor, and a label
	 * anchored to a node that has since moved is worse than one anchored to the
	 * pointer. So it is re-placed each frame while visible — from the cached size,
	 * which is what keeps that off the layout path.
	 */
	trackTooltip() {
		if (!this.tooltipVisible || this.tooltipId === null) return;
		this.placeTooltip(null);
	}

	hideTooltip() {
		this.tooltipVisible = false;
		this.tooltipId = null;
		if (this.tooltipEl) this.tooltipEl.removeClass('is-visible');
	}

	/*
	 * Nodes are only added for values that actually reach a note present in this
	 * frame's data — the graph's own search box can remove notes underneath us,
	 * and a value node with nothing attached is noise.
	 */
	/*
	 * With "Show attachments" on, the graph adds a node for every attachment the
	 * filter lets through — and the pass-all stub that makes the base scoping work
	 * lets all of them through, since it is asked about a path with no way to know
	 * what links to it. The result is the whole attachments folder floating loose.
	 *
	 * Obsidian's own "Show orphans" would clear them, but it would take the
	 * orphaned *notes* with it, and in a base those are usually the point. So
	 * orphaned attachments are dropped here instead, leaving the ones a note in
	 * the graph actually references.
	 */
	pruneOrphanAttachments(data) {
		if (!this.settings().hideOrphanAttachments) return;
		if (!data || !data.nodes) return;

		const nodes = data.nodes;
		const referenced = new Set();

		for (const id in nodes) {
			if (!hasOwn(nodes, id)) continue;
			const links = nodes[id].links;
			for (const target in links) {
				if (hasOwn(links, target)) referenced.add(target);
			}
		}

		for (const id in nodes) {
			if (!hasOwn(nodes, id)) continue;
			if (nodes[id].type !== 'attachment') continue;
			if (referenced.has(id)) continue;

			// An attachment has no outgoing links of its own in practice, but check
			// rather than assume it.
			let outbound = false;
			const links = nodes[id].links;
			for (const target in links) {
				if (hasOwn(links, target) && hasOwn(nodes, target)) {
					outbound = true;
					break;
				}
			}

			if (!outbound) delete nodes[id];
		}
	}

	injectPropertyNodes(data) {
		if (!data || !data.nodes || !this.propertyModel.length) return;
		const nodes = data.nodes;
		const flat = this.settings().propertyMode === MODE_FLAT;

		for (const group of this.propertyModel) {
			const keyId = KEY_PREFIX + group.prop.raw;
			let keyUsed = false;

			if (flat) {
				// The property itself joins to every note that has it; the values
				// exist only in the panel.
				group.allPaths.forEach(function (path) {
					const node = nodes[path];
					if (!node || !node.links) return;
					node.links[keyId] = true;
					keyUsed = true;
				});
			} else {
				group.nodeValues.forEach(function (paths, text) {
					const valueId = VALUE_PREFIX + group.prop.raw + NUL + text;
					let linked = false;

					paths.forEach(function (path) {
						const node = nodes[path];
						if (!node || !node.links) return;
						node.links[valueId] = true;
						linked = true;
					});

					if (!linked) return;

					if (!nodes[valueId]) nodes[valueId] = { type: 'tag', links: {} };
					nodes[valueId].links[keyId] = true;
					LABELS.set(valueId, text);
					keyUsed = true;
				});
			}

			if (!keyUsed) continue;
			if (!nodes[keyId]) nodes[keyId] = { type: 'tag', links: {} };
			LABELS.set(keyId, group.prop.label);
		}
	}

	// ------------------------------------------------------------- neighbours

	/*
	 * target -> sources, built once from resolvedLinks and thrown away whenever
	 * the link structure changes. resolvedLinks is only forward, and a local graph
	 * has to walk both ways.
	 */
	reverseLinks(resolved) {
		if (this.reverseCache) return this.reverseCache;

		const map = new Map();
		for (const source in resolved) {
			if (!hasOwn(resolved, source)) continue;
			const targets = resolved[source];
			for (const target in targets) {
				if (!hasOwn(targets, target)) continue;
				let sources = map.get(target);
				if (!sources) {
					sources = new Set();
					map.set(target, sources);
				}
				sources.add(source);
			}
		}

		this.reverseCache = map;
		return map;
	}

	/*
	 * Breadth-first out from the base's rows, both directions, to the configured
	 * depth. This is the part a Bases filter cannot express: `hasLink` gives one
	 * hop and the filter language has no transitive closure, so anything past
	 * depth 1 has to be walked here.
	 */
	/* Per view, from the base's own settings pane. */
	ringSpread() {
		const config = this.config;
		let raw = null;
		try {
			raw = config && config.get ? config.get(RING_SPREAD_KEY) : null;
		} catch (e) {
			raw = null;
		}
		// 0 is meaningful (every ring flush), so an unset value is the only case
		// that falls back to the default.
		if (raw === null || raw === undefined || raw === '') return DEFAULT_RING_SPREAD;
		const spread = Number(raw);
		if (!isFinite(spread) || spread < 0) return DEFAULT_RING_SPREAD;
		return Math.min(spread, MAX_RING_SPREAD);
	}

	/* Per view, from the base's own settings pane. */
	ringUncapped() {
		const config = this.config;
		let raw = null;
		try {
			raw = config && config.get ? config.get(RING_UNCAPPED_KEY) : null;
		} catch (e) {
			raw = null;
		}
		return raw === true;
	}

	/* Per view, from the base's own settings pane. The dial, 0–100. */
	ringSpeed() {
		const config = this.config;
		let raw = null;
		try {
			raw = config && config.get ? config.get(RING_SPEED_KEY) : null;
		} catch (e) {
			raw = null;
		}
		// 0 is meaningful (every ring flush), so an unset value is the only case
		// that falls back to the default.
		if (raw === null || raw === undefined || raw === '') return DEFAULT_RING_SPEED;
		const speed = Number(raw);
		if (!isFinite(speed) || speed < 0) return DEFAULT_RING_SPEED;
		return Math.min(speed, MAX_RING_SPEED);
	}

	/* The dial in RING_UNITs per step of the sort — see RING_SPEED_KEY. */
	ringGrowth() {
		const dial = this.ringSpeed() / MAX_RING_SPEED;
		return dial * dial * dial * RING_GROWTH_CEILING;
	}

	/*
	 * What a rank of 1 is worth, in world units. The two ring modes differ here
	 * and nowhere else: capped multiplies the rank by a fixed spread, uncapped
	 * multiplies it back up by the number of steps it was divided by and lets the
	 * result be as large as the base makes it.
	 */
	ringSpan(nodeScale) {
		if (!this.ringUncapped()) return this.ringSpread() * RING_UNIT * nodeScale;
		const scale = typeof this.rankScale === 'number' && isFinite(this.rankScale) && this.rankScale > 0
			? this.rankScale
			: 1;
		return this.ringGrowth() * scale * RING_UNIT * nodeScale;
	}

	/* Per view, from the base's own settings pane. */
	ringRank() {
		const config = this.config;
		let raw = null;
		try {
			raw = config && config.get ? config.get(RING_RANK_KEY) : null;
		} catch (e) {
			raw = null;
		}
		if (raw === RANK_VALUE || raw === RANK_PROPORTIONAL || raw === RANK_LOG) return raw;
		return RANK_POSITION;
	}

	/* Per view, from the base's own settings pane. */
	neighbourDepth() {
		const config = this.config;
		let raw = null;
		try {
			raw = config && config.get ? config.get(NEIGHBOUR_DEPTH_KEY) : null;
		} catch (e) {
			raw = null;
		}
		const depth = Math.round(Number(raw) || 0);
		if (depth < 1) return 0;
		return Math.min(depth, MAX_NEIGHBOUR_DEPTH);
	}

	computeNeighbours() {
		this.neighbourPaths = new Map();

		// Seeded from the base's own rows only — folding the previous walk's results
		// back in as seeds would grow the graph a hop further on every update.
		const depth = this.neighbourDepth();
		if (depth < 1 || !this.rowPaths.size) return;

		const app = this.app || (this.controller && this.controller.app);
		const resolved = app && app.metadataCache && app.metadataCache.resolvedLinks;
		if (!resolved) return;

		try {
			const reverse = this.reverseLinks(resolved);
			const seen = new Set(this.rowPaths);
			let frontier = Array.from(this.rowPaths);

			for (let hop = 1; hop <= depth; hop++) {
				const next = [];

				for (const path of frontier) {
					const outgoing = resolved[path];
					if (outgoing) {
						for (const target in outgoing) {
							if (!hasOwn(outgoing, target) || seen.has(target)) continue;
							seen.add(target);
							this.neighbourPaths.set(target, hop);
							next.push(target);
						}
					}

					const incoming = reverse.get(path);
					if (incoming) {
						for (const source of incoming) {
							if (seen.has(source)) continue;
							seen.add(source);
							this.neighbourPaths.set(source, hop);
							next.push(source);
						}
					}
				}

				if (!next.length) break;
				frontier = next;
			}
		} catch (e) {
			console.error('[bases-graph] could not walk the linked notes', e);
			this.neighbourPaths = new Map();
		}
	}

	// ------------------------------------------------------------- population

	/*
	 * Every note in the graph, with something that can evaluate the base's
	 * properties for it — rows carry their own BasesEntry, linked notes get one
	 * built against the same query context the rows were evaluated against.
	 *
	 * This exists because the two used to be separate populations: rows had
	 * evaluated properties and linked notes had none, so anything derived from a
	 * property (rings, colours, labels) had to either skip them or grow a special
	 * case. One map instead means a linked note is an ordinary participant, and
	 * the only thing that still distinguishes it is that it came from the walk.
	 */
	computeEntries() {
		const entries = new Map();
		this.entryByPath = entries;
		this.linkedEntries = [];

		for (const entry of this.rowEntries) {
			const file = entry && entry.file;
			if (file && file.path) entries.set(file.path, entry);
		}

		if (!this.neighbourPaths.size) return;
		if (typeof obsidian.BasesEntry !== 'function') return;

		const controller = this.queryController || this.controller;
		const ctx = controller && controller.ctx;
		const app = this.app || (controller && controller.app);
		if (!ctx || !app) return;

		// Closed over rather than reached through `this`: the callback used to say
		// `self.linkedEntries` with no `self` in scope, and the catch below swallowed
		// the ReferenceError as though it were a bad note. Every linked note failed,
		// silently, and the fold never happened.
		const linked = this.linkedEntries;
		let failures = 0;

		this.neighbourPaths.forEach(function (hop, path) {
			if (entries.has(path)) return;

			let file = null;
			try {
				file = app.vault.getFileByPath
					? app.vault.getFileByPath(path)
					: app.vault.getAbstractFileByPath(path);
			} catch (e) {
				file = null;
			}
			if (!file) return;

			let entry = null;
			try {
				entry = new obsidian.BasesEntry(ctx, file);
			} catch (e) {
				if (!failures) console.error('[bases-graph] could not build an entry for a linked note', e);
				failures++;
				return;
			}

			// Outside the catch: this cannot fail for data reasons, so if it ever
			// throws it is a bug and should be seen rather than counted.
			entries.set(path, entry);
			linked.push(entry);
		});
	}

	/*
	 * Make the linked notes actual rows.
	 *
	 * They cannot come from the query: rows are whatever the base's filter matches,
	 * and the filter language has no transitive closure, so `hasLink` reaches one
	 * hop and stops. But rows do not have to come from the filter — BasesQueryResult
	 * is exported, and its constructor applies the view's sort and limit while
	 * groupedData applies its group-by. So handing it the rows plus the linked
	 * entries produces exactly what the controller would have produced if the
	 * filter had matched them in the first place.
	 *
	 * Everything downstream then stops caring which is which: ranks, colours,
	 * labels and property nodes all just read rows. The only thing that still
	 * knows the difference is how they are painted.
	 */
	rebuildData() {
		// Cleared first: if nothing is folded this pass, this.data is the
		// controller's again and must be recognised as rows next time.
		this.foldedData = null;
		if (!this.linkedEntries.length) return;
		if (typeof obsidian.BasesQueryResult !== 'function') return;

		const app = this.app || (this.queryController && this.queryController.app);
		const config = this.config;
		if (!app || !config) return;

		try {
			let linked = this.linkedEntries;

			// The base's own rows were already filtered by the search box upstream;
			// these have not been, so they get the same treatment rather than
			// stubbornly staying visible through a search.
			const controller = this.queryController || this.controller;
			if (controller && typeof controller.applySearchQuery === 'function') {
				linked = controller.applySearchQuery(linked, config.getOrder());
			}

			// Remembered so collectRows() can tell our data from the controller's.
			this.foldedData = new obsidian.BasesQueryResult(
				app, config, this.allProperties || [], this.rowEntries.concat(linked));
			this.data = this.foldedData;
		} catch (e) {
			console.error('[bases-graph] could not fold the linked notes into the rows', e);
		}
	}

	/* The value of a property for any note in the graph, as displayable text. */
	valueText(path, property) {
		const entry = this.entryByPath.get(path);
		if (!entry) return null;
		try {
			const value = entry.getValue(property);
			const text = value === null || value === undefined ? '' : String(value);
			return isEmptyValue(value, text) ? null : text;
		} catch (e) {
			return null;
		}
	}

	// ------------------------------------------------------ sort rings, groups

	/*
	 * Rank by the base's own sort, 1 for the top row down to 0 for the last. Only
	 * meaningful when the base actually sorts: without a sort, data.data is in
	 * whatever order the vault scan produced and a ring would say nothing.
	 */
	computeSortRanks() {
		const ranks = new Map();
		this.sortRanks = ranks;
		/*
		 * The divisor the normalised rank came out of, kept so the uncapped mode can
		 * multiply it back: the count of steps in the ordering modes, the span of the
		 * property itself in the proportional ones. Only that mode reads it — the
		 * ranks stay 0–1 either way, so the cut-off and every comparison below are
		 * untouched by it.
		 */
		this.rankScale = 0;
		if (!this.settings().sortRings) return;

		let property = null;
		let descending = false;
		try {
			const config = this.config;
			const sort = config && config.getSort ? config.getSort() : null;
			if (sort && sort.length) {
				property = sort[0].property;
				descending = String(sort[0].direction).toUpperCase() === 'DESC';
			}
		} catch (e) {
			property = null;
		}
		if (!property) return;
		if (this.entryByPath.size < 2) return;

		/*
		 * Rank is the note's *position* in the sort, not a step per distinct value —
		 * so the spacing reflects how many notes sit above a value, not merely how
		 * many different values exist. Ties share the position of the first note
		 * holding that value, so equal values draw identical rings.
		 *
		 * Notes with no value are not ranked at all, and are left out of the count
		 * as well: they are not part of the ordering, so they must not stretch it.
		 *
		 * data.data is already in the base's sort order, so one walk does it.
		 */
		const mode = this.ringRank();
		const valueOfPath = new Map();
		const countOfValue = new Map();

		// Every note in the graph, rows and linked notes alike.
		this.entryByPath.forEach((entry, path) => {
			const text = this.valueText(path, property);
			if (text === null) return;
			valueOfPath.set(path, text);
			countOfValue.set(text, (countOfValue.get(text) || 0) + 1);
		});

		// Nothing to rank against: one value, or one note holding one.
		if (valueOfPath.size < 2 || countOfValue.size < 2) return;

		/*
		 * The values are ordered here rather than read off the row order, because a
		 * linked note has no row and so no position in it. Numeric whenever every
		 * value parses as a number, which is the case that matters for a rating.
		 */
		const texts = Array.from(countOfValue.keys());
		const numeric = texts.every(function (text) { return isFinite(Number(text)); });
		texts.sort(numeric
			? function (a, b) { return Number(a) - Number(b); }
			: function (a, b) { return a.localeCompare(b); });

		/*
		 * Proportional reads the number itself, so it ignores the sort direction
		 * entirely: the highest value always draws the largest ring. It needs every
		 * value numeric; anything else falls through to the ordering modes rather
		 * than drawing something meaningless.
		 */
		if ((mode === RANK_PROPORTIONAL || mode === RANK_LOG) && numeric) {
			// log1p keeps 0 usable and is undefined below it, so a property with
			// negative values falls through to the ordering modes.
			const usable = mode !== RANK_LOG || Number(texts[0]) >= 0;
			const scale = mode === RANK_LOG
				? function (n) { return Math.log1p(n); }
				: function (n) { return n; };

			const min = scale(Number(texts[0]));
			const max = scale(Number(texts[texts.length - 1]));

			if (usable && max > min) {
				const span = max - min;
				// A step here is one unit of the property — one point of a rating, one
				// e-fold on the log scale — rather than one row.
				this.rankScale = span;
				valueOfPath.forEach(function (text, path) {
					ranks.set(path, (scale(Number(text)) - min) / span);
				});
				return;
			}
		}

		// Ascending so far; the base's sort decides which end gets the full ring.
		if (descending) texts.reverse();

		const rankOfValue = new Map();
		const byValue = mode === RANK_VALUE;
		let position = 0;

		for (const text of texts) {
			// The only difference between the two ordering styles: what a value
			// records — how many values precede it, or how many notes do.
			rankOfValue.set(text, byValue ? rankOfValue.size : position);
			position += countOfValue.get(text);
		}

		const last = (byValue ? rankOfValue.size : position) - 1;
		if (last < 1) return;
		this.rankScale = last;

		valueOfPath.forEach(function (text, path) {
			ranks.set(path, 1 - rankOfValue.get(text) / last);
		});

		this.applyRingLimit();
	}

	/*
	 * The cut-off is worked out here, once per update, rather than in the paint —
	 * sorting a few thousand ranks per frame would cost more than the rings it
	 * saves. paintRings then only has to compare against a number.
	 */
	applyRingLimit() {
		this.ringThreshold = -1;

		const raw = this.settings().maxRings;
		const max = typeof raw === 'number' && isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
		if (!max || this.sortRanks.size <= max) return;

		const values = Array.from(this.sortRanks.values());
		values.sort(function (a, b) { return b - a; });
		this.ringThreshold = values[max - 1];
	}

	/* One palette colour per group of the base's own group-by. */
	computeGroupColors() {
		this.groupColors = new Map();
		this.groupLabels = new Map();
		this.groupingActive = false;
		this.legendModel = [];
		this.hideTooltip();

		try {
			this.buildGroupColors();
		} catch (e) {
			console.error('[bases-graph] could not colour the groups', e);
		}

		this.updateLegend();
	}

	buildGroupColors() {
		/*
		 * Labels belong to the hover tooltip, colours to the nodes and the legend,
		 * and the two have separate switches — so this runs when either is wanted
		 * and only assigns colours for the one that asked. Without the split,
		 * turning group colouring off would silently take the group's *name* away
		 * from a tooltip that is still switched on.
		 */
		const settings = this.settings();
		const coloring = settings.groupColors !== false;
		if (!coloring && settings.groupTooltip === false) return;

		const config = this.config;
		if (!config || !config.groupBy) return;

		const groups = this.data && this.data.groupedData;
		if (!Array.isArray(groups)) return;

		// The base groups and we are reading that grouping — so a row with no label
		// is a row with no value, a different thing from there being no grouping.
		this.groupingActive = true;

		const colors = this.groupColors;
		const labels = this.groupLabels;
		const showEmpty = settings.colorEmptyGroup !== false;
		let emptyCount = 0;
		let index = 0;

		for (const group of groups) {
			if (!group || typeof group.hasKey !== 'function') continue;

			let label = '';
			try {
				label = group.key === null || group.key === undefined ? '' : String(group.key);
			} catch (e) {
				label = '';
			}

			/*
			 * "No value" arrives in several shapes: a keyless group, a key that
			 * stringifies to nothing, and — the one that kept slipping through — a
			 * key that is a NullValue reached by a route where hasKey() does not
			 * catch it, whose toString is the word "null" rather than "".
			 *
			 * isEmptyValue is the same test the property nodes use, checking the
			 * value's own class before falling back to its text. One definition of
			 * "empty" for the whole plugin, rather than a different guess per site.
			 */
			if (!group.hasKey() || isEmptyValue(group.key, label)) {
				for (const entry of group.entries || []) {
					const file = entry && entry.file;
					if (!file || !file.path) continue;
					labels.set(file.path, EMPTY_GROUP_LABEL);
					emptyCount++;
				}
				continue;
			}

			// The palette index only advances for groups that take a colour, so the
			// colours are the same whether or not the tooltip is what asked for this.
			const color = coloring ? this.paletteColor(index++) : null;
			let counted = 0;

			for (const entry of group.entries || []) {
				const file = entry && entry.file;
				if (file && file.path) {
					if (color) colors.set(file.path, color);
					labels.set(file.path, label);
					counted++;
				}
			}

			if (color) this.legendModel.push({ label: label, color: color, count: counted });
		}

		// Last, so it sits under the real values rather than among them.
		if (emptyCount && showEmpty && coloring) {
			this.legendModel.push({
				label: EMPTY_GROUP_LABEL,
				color: this.defaultNodeColor(),
				count: emptyCount,
				empty: true,
			});
		}

		// Name the legend after whatever the base groups by.
		try {
			this.legendTitle = config.getDisplayName
				? (config.getDisplayName(config.groupBy.property) || 'Groups')
				: 'Groups';
		} catch (e) {
			this.legendTitle = 'Groups';
		}
	}

	/*
	 * Collapsed state is a plugin setting rather than per view, so it stays where
	 * he left it. It only rebuilds the legends, not the whole model — a collapse
	 * click has no business re-reading every property in the base.
	 */
	toggleLegend() {
		const owner = this.owner;
		if (!owner || !owner.settings) return;

		owner.settings.legendCollapsed = !owner.settings.legendCollapsed;
		owner.views.forEach(function (view) {
			try {
				view.updateLegend();
			} catch (e) {
				console.error('[bases-graph] could not redraw a legend', e);
			}
		});
		owner.persistSettings();
	}

	/* Which colour is which group. Bottom-left, opposite the graph's controls. */
	updateLegend() {
		if (this.legendEl) {
			this.legendEl.detach();
			this.legendEl = null;
		}

		const settings = this.settings();
		if (settings.groupLegend === false) return;

		/*
		 * Notes from the depth walk are the other colour on screen. They are not a
		 * group — they are here because something linked to them, not because they
		 * have or lack a value — so they get their own row rather than being folded
		 * into "(none)", which would claim something false about them.
		 */
		const model = settings.groupColors ? (this.legendModel || []).slice() : [];
		// Only alongside real groups: a legend headed by the grouped property, whose
		// single row is "Linked notes", would be describing the wrong thing.
		if (model.length && this.neighbourPaths.size && settings.neighbourColor === NEIGHBOUR_DIM) {
			model.push({
				label: 'Linked notes',
				color: this.mutedColor(),
				count: this.neighbourPaths.size,
				linked: true,
			});
		}

		/*
		 * The graph's own colour groups are a second source of colour with its own
		 * name, so they get their own section rather than being listed under a
		 * heading that names the base's grouped property. With no grouping at all
		 * they are the whole legend, and the heading says so.
		 */
		const native = (this.nativeLegend || []).slice();
		if (!model.length && !native.length) return;

		const rows = model.slice();
		if (native.length) {
			if (model.length) rows.push({ heading: 'Colour groups' });
			for (const row of native) rows.push(row);
		}

		const collapsed = settings.legendCollapsed === true;
		const legend = this.legendEl = this.hostEl.createDiv('bases-graph-legend');
		legend.toggleClass('is-collapsed', collapsed);

		const header = legend.createDiv('bases-graph-legend-header');
		const icon = header.createDiv('collapse-icon');
		icon.toggleClass('is-collapsed', collapsed);
		if (obsidian.setIcon) obsidian.setIcon(icon, 'right-triangle');
		header.createSpan({
			cls: 'bases-graph-legend-title',
			text: model.length ? (this.legendTitle || 'Groups') : 'Colour groups',
		});
		header.createSpan({
			cls: 'bases-graph-legend-count',
			text: String(model.length + native.length),
		});
		header.addEventListener('click', this.toggleLegend.bind(this));

		if (collapsed) return;

		const list = legend.createDiv('bases-graph-legend-list');
		let drawn = 0;

		for (let i = 0; i < rows.length && drawn < MAX_LEGEND_ROWS; i++) {
			const row = rows[i];

			// A separator carries no colour and does not count towards the cap.
			if (row.heading) {
				list.createDiv({ cls: 'bases-graph-legend-heading', text: row.heading });
				continue;
			}

			drawn++;
			const rowEl = list.createDiv('bases-graph-legend-row');
			rowEl.toggleClass('is-empty-group', !!row.empty || !!row.linked);
			rowEl.toggleClass('is-color-group', !!row.colorGroup);
			// Listed, but nothing on screen is wearing it — the base's colouring won.
			rowEl.toggleClass('is-outranked', !!row.outranked);
			const swatch = rowEl.createDiv('bases-graph-legend-swatch');
			swatch.style.backgroundColor = rgbToCss(row.color.rgb);
			rowEl.createSpan({
				cls: 'bases-graph-legend-label',
				text: row.label,
			});
			rowEl.createSpan({
				cls: 'bases-graph-legend-count',
				text: String(row.count),
			});
		}

		const total = model.length + native.length;
		if (total > MAX_LEGEND_ROWS) {
			legend.createDiv({
				cls: 'bases-graph-legend-note',
				text: (total - MAX_LEGEND_ROWS) + ' more groups.',
			});
		}
	}

	paletteColor(index) {
		if (!this.paletteCache) this.paletteCache = this.readPalette();
		const palette = this.paletteCache;
		if (index < palette.length) return { a: 1, rgb: palette[index] };

		const hue = ((index - palette.length + 1) * GOLDEN_ANGLE) % 360;
		return { a: 1, rgb: hslToRgbInt(hue, 0.6, 0.55) };
	}

	/*
	 * Resolved through a probe element rather than read from the variables
	 * directly, so whatever form the theme wrote them in comes back as rgb().
	 */
	readCssColors(names) {
		const out = [];
		const probe = this.hostEl.createDiv();
		probe.style.position = 'absolute';
		probe.style.visibility = 'hidden';
		probe.style.pointerEvents = 'none';

		try {
			const win = probe.win || window;
			for (const name of names) {
				probe.style.color = 'var(' + name + ')';
				out.push(parseRgbInt(win.getComputedStyle(probe).color));
			}
		} catch (e) {
			console.error('[bases-graph] could not read the theme colours', e);
		} finally {
			probe.detach();
		}

		return out;
	}

	readPalette() {
		return this.readCssColors(PALETTE_VARS).filter(function (rgb) { return rgb !== null; });
	}

	/* The colour for notes that are context rather than results. */
	mutedColor() {
		if (!this.mutedCache) {
			const read = this.readCssColors(['--text-faint'])[0];
			this.mutedCache = { a: 1, rgb: read === null || read === undefined ? 0x888888 : read };
		}
		return this.mutedCache;
	}

	/*
	 * What the graph paints an uncoloured node. Rows with no value are left alone
	 * rather than recoloured, so the legend has to report the renderer's own fill
	 * colour — any other swatch would match nothing on screen.
	 */
	defaultNodeColor() {
		const renderer = this.graphView && this.graphView.renderer;
		const fill = renderer && renderer.colors && renderer.colors.fill;
		if (fill && typeof fill.rgb === 'number') return { a: 1, rgb: fill.rgb };
		return this.noneColor();
	}

	/* Fallback only, for before the renderer exists. */
	noneColor() {
		if (!this.noneCache) {
			const read = this.readCssColors(['--text-muted'])[0];
			this.noneCache = { a: 1, rgb: read === null || read === undefined ? 0xbbbbbb : read };
		}
		return this.noneCache;
	}

	// ------------------------------------------------------------------ rings

	/*
	 * Replace a renderer property with a wrapper that survives reassignment:
	 * initGraphics() rebuilds renderCallback whenever the canvas is recreated.
	 */
	wrapRendererProperty(renderer, name, makeWrapper) {
		let raw = renderer[name];
		let wrapped = typeof raw === 'function' ? makeWrapper(raw) : raw;

		Object.defineProperty(renderer, name, {
			configurable: true,
			enumerable: true,
			get: function () { return wrapped; },
			set: function (value) {
				raw = value;
				wrapped = typeof value === 'function' ? makeWrapper(value) : value;
			},
		});

		this.rendererRestores.push(function () {
			delete renderer[name];
			renderer[name] = raw;
		});
	}

	installRings() {
		const renderer = this.graphView.renderer;
		const self = this;

		// After the original: the rings are drawn on top of the frame it produced.
		this.wrapRendererProperty(renderer, 'renderCallback', function (original) {
			return function () {
				/*
				 * The original is timed too. Without it there is no way to tell a slow
				 * ring pass from a graph that is simply expensive to draw — and those
				 * have entirely different answers.
				 */
				const clock = typeof performance !== 'undefined' && performance.now
					? performance
					: Date;

				/*
				 * A/B: hide the ring layer for alternating stretches and compare the
				 * graph's own render time with and without it in the scene.
				 *
				 * This exists because ringMs measures only the JS that builds the
				 * geometry — PIXI renders the objects afterwards, inside the graph's
				 * own pass, so the cost of *having* 1600 extra display objects lands
				 * in graphMs and looked like Obsidian being slow.
				 */
				const bench = self.ringBench;
				if (bench && self.ringLayerEl && !self.ringLayerEl.destroyed) {
					self.ringLayerEl.visible = bench.phase === 'on';
				}

				const beforeGraph = clock.now();
				const result = original.apply(this, arguments);
				const afterGraph = clock.now();

				if (bench) self.sampleRingBench(afterGraph - beforeGraph);

				try {
					self.paintRings(renderer);
				} catch (e) {
					self.onRingFailure(e);
				}

				/*
				 * Its own catch: a label that cannot be placed must not take the rings
				 * down with it, and it is not worth the failure counter either — there
				 * is nothing to give up on, since it does nothing at all unless a node
				 * is hovered.
				 */
				try {
					self.trackTooltip();
				} catch (e) {
					// Placing it is best-effort; the label simply stays where it was.
				}

				const afterRings = clock.now();
				self.frameCount++;
				self.graphTime += afterGraph - beforeGraph;
				self.ringTime += afterRings - afterGraph;

				return result;
			};
		});
	}

	/*
	 * Alternate 60-frame stretches with the ring layer shown and hidden, six times
	 * each way, and average the graph's own render time in both. Interleaving
	 * rather than measuring one then the other keeps the comparison honest if the
	 * simulation is settling while it runs.
	 */
	startRingBenchmark() {
		this.ringBench = {
			phase: 'on',
			frames: 0,
			cycles: 0,
			on: { total: 0, count: 0 },
			off: { total: 0, count: 0 },
		};
		return this.ringBench;
	}

	sampleRingBench(ms) {
		const bench = this.ringBench;
		if (!bench) return;

		const slot = bench.phase === 'on' ? bench.on : bench.off;
		slot.total += ms;
		slot.count++;

		if (++bench.frames < RING_BENCH_FRAMES) return;
		bench.frames = 0;
		bench.phase = bench.phase === 'on' ? 'off' : 'on';
		bench.cycles++;

		if (bench.cycles < RING_BENCH_CYCLES) return;

		this.ringBench = null;
		if (this.ringLayerEl && !this.ringLayerEl.destroyed) this.ringLayerEl.visible = true;

		const withRings = bench.on.count ? bench.on.total / bench.on.count : 0;
		const without = bench.off.count ? bench.off.total / bench.off.count : 0;
		this.ringBenchResult = {
			graphMsWithRings: Math.round(withRings * 1000) / 1000,
			graphMsWithoutRings: Math.round(without * 1000) / 1000,
			costOfRingsMs: Math.round((withRings - without) * 1000) / 1000,
			ringsDrawn: this.ringsDrawn,
			framesEach: bench.on.count,
		};

		console.log('[bases-graph] ring cost', this.ringBenchResult);
		new obsidian.Notice('Ring cost: ' + this.ringBenchResult.costOfRingsMs
			+ ' ms/frame of ' + this.ringBenchResult.graphMsWithRings
			+ ' ms (' + this.ringBenchResult.ringsDrawn + ' rings)');
	}

	/* Give up rather than log once per frame for the life of the pane. */
	onRingFailure(error) {
		this.ringFailures++;
		if (this.ringFailures > RING_FAILURE_LIMIT) return;
		console.error('[bases-graph] could not draw the sort rings', error);
		if (this.ringFailures === RING_FAILURE_LIMIT) {
			console.error('[bases-graph] giving up on the sort rings for this pane.');
		}
		// Force a rebuild next frame in case the graphics were disposed under us.
		this.ringsEl = null;
	}

	/*
	 * One Graphics for every ring, redrawn each frame. Cheaper than a PIXI object
	 * per node, and there is only one thing to recreate when the renderer throws
	 * its graphics away — which it does on resize and on theme change.
	 */
	ringGraphics(renderer) {
		const hanger = renderer.hanger;
		if (!hanger) return null;

		const existing = this.ringsEl;
		if (existing && !existing.destroyed && existing.parent === hanger) return existing;

		// Any node that has been drawn will do — the first one in the list may not
		// have had initGraphics() run on it yet.
		let circle = null;
		const nodes = renderer.nodes || [];
		for (const node of nodes) {
			if (node && node.circle) {
				circle = node.circle;
				break;
			}
		}
		if (!circle) return null;

		// node.circle is itself a PIXI.Graphics, so the class is reachable from any
		// drawn node. PIXI is bundle-local, there is no global to ask.
		const Graphics = Object.getPrototypeOf(circle).constructor;
		if (typeof Graphics !== 'function') return null;

		const graphics = new Graphics();
		graphics.eventMode = 'none';
		hanger.addChild(graphics);
		this.ringsEl = graphics;
		return graphics;
	}

	/* The PIXI class, reachable only through an object the renderer already made. */
	graphicsClass(renderer) {
		const nodes = renderer.nodes || [];
		for (const node of nodes) {
			if (node && node.circle) {
				const ctor = Object.getPrototypeOf(node.circle).constructor;
				return typeof ctor === 'function' ? ctor : null;
			}
		}
		return null;
	}

	/*
	 * A container of its own for the pooled rings. Draw order is insertion order
	 * here (zIndex is inert), so one layer kept last is the whole ordering
	 * problem solved — rather than shuffling hundreds of children every frame.
	 */
	ringLayer(renderer) {
		const hanger = renderer.hanger;
		if (!hanger) return null;

		let layer = this.ringLayerEl;
		if (!layer || layer.destroyed || layer.parent !== hanger) {
			const Container = Object.getPrototypeOf(hanger).constructor;
			if (typeof Container !== 'function') return null;
			this.dropRingPool();
			layer = this.ringLayerEl = new Container();
			layer.eventMode = 'none';
			hanger.addChild(layer);
		}

		const children = hanger.children;
		if (children && children[children.length - 1] !== layer) hanger.addChild(layer);
		return layer;
	}

	dropRingPool() {
		const pool = this.ringPool;
		this.ringPool = new Map();
		if (!pool) return;
		pool.forEach(function (entry) {
			try {
				if (entry.gfx && !entry.gfx.destroyed) {
					if (entry.gfx.parent) entry.gfx.parent.removeChild(entry.gfx);
					entry.gfx.destroy();
				}
			} catch (e) {
				console.error('[bases-graph] could not dispose a ring', e);
			}
		});
	}

	paintRings(renderer) {
		if (this.ringFailures >= RING_FAILURE_LIMIT) return;
		const active = this.settings().sortRings && this.sortRanks.size > 0;

		if (!active) {
			const existing = this.ringsEl;
			if (existing && !existing.destroyed) existing.clear();
			if (this.ringPool && this.ringPool.size) this.dropRingPool();
			return;
		}

		if (this.settings().ringDraw !== 'immediate') {
			// The immediate path's geometry persists until cleared, so switching to
			// pooled while it holds a frame would leave those rings drawn underneath.
			const stale = this.ringsEl;
			if (stale && !stale.destroyed) stale.clear();
			this.paintRingsPooled(renderer);
			return;
		}
		if (this.ringPool && this.ringPool.size) this.dropRingPool();

		const graphics = this.ringGraphics(renderer);
		if (!graphics) return;

		/*
		 * zIndex is inert in this graph: PIXI only honours it when a container has
		 * sortableChildren, and Obsidian never turns it on — the zIndex values it
		 * sets on circles, labels and arrows do nothing. Draw order is purely the
		 * order children were added, and links are added lazily as the graph
		 * renders, so the only way to stay above them is to be the last child.
		 */
		const hanger = renderer.hanger;
		const children = hanger.children;
		if (children && children[children.length - 1] !== graphics) hanger.addChild(graphics);

		graphics.clear();

		const nodeScale = renderer.nodeScale;
		// Matches how the renderer sizes its own highlight ring: a hairline on
		// screen however far the graph is zoomed out.
		const width = Math.max(nodeScale, 1 / renderer.scale);
		// Measured against the smallest node the renderer will draw, so the setting
		// means the same thing regardless of how connected any particular note is.
		const spread = this.ringSpan(nodeScale);
		const nodes = renderer.nodes || [];
		const viewScale = renderer.scale || 1;
		/*
		 * The floor is in screen pixels, so it means the same thing at any zoom —
		 * hence the divide by the view scale to get world units. 0 is a legitimate
		 * setting (draw everything), so an unset or nonsense value is the only case
		 * that falls back to the default.
		 */
		const rawGap = this.settings().ringMinGap;
		const gapPx = typeof rawGap === 'number' && isFinite(rawGap) && rawGap >= 0
			? rawGap
			: DEFAULT_SETTINGS.ringMinGap;
		const minGap = gapPx / viewScale;

		/*
		 * lineStyle() closes the current batch and opens a new one, so calling it
		 * per node stops PIXI merging any of the rings — the single biggest cost
		 * here after the tessellation itself. Alpha is quantised so that nodes
		 * fading by imperceptible amounts do not each start their own batch.
		 */
		let lastRgb = -1;
		let lastAlpha = -1;
		const cull = this.settings().cullRings !== false;
		const threshold = typeof this.ringThreshold === 'number' ? this.ringThreshold : -1;

		for (const node of nodes) {
			if (!node || !node.rendered) continue;
			if (node.x === null || node.y === null) continue;

			/*
			 * The renderer has already decided whether this node is on screen, in
			 * node.render(), so culling costs nothing to check and skips almost
			 * everything when zoomed in. It is optional because the verdict is about
			 * the *node*: a ring is wider than the node it surrounds, so a large one
			 * belonging to a node just past the edge is dropped even though part of
			 * it would have been visible.
			 */
			if (cull) {
				const circle = node.circle;
				if (!circle || !circle.visible) continue;
			}

			const rank = this.sortRanks.get(node.id);
			if (rank === undefined) continue;
			// Below the cut-off worked out in applyRingLimit(), if there is one.
			if (rank < threshold) continue;

			/*
			 * The gap is added to the node's radius, not multiplied by it. Scaling it
			 * by node size made a well-connected note draw a big ring whatever its
			 * rank, so ring size read as link count rather than as sort position —
			 * the two signals the graph is meant to keep separate. Now the ring sits
			 * on the node's border at rank 0 and stands the same distance off it for
			 * a given rank, however big the node is.
			 */
			const gap = rank * spread;
			if (gap < minGap) continue;

			const color = node.color || renderer.colors.circle;
			const raw = (color && typeof color.a === 'number' ? color.a : 1) * node.fadeAlpha;
			if (raw <= 0.02) continue;
			const alpha = Math.round(raw * 50) / 50;

			if (color.rgb !== lastRgb || alpha !== lastAlpha) {
				graphics.lineStyle(width, color.rgb, alpha);
				lastRgb = color.rgb;
				lastAlpha = alpha;
			}

			graphics.drawCircle(node.x, node.y, node.getSize() * nodeScale + gap);
		}
	}

	/*
	 * One Graphics per ringed note, kept alive between frames.
	 *
	 * The expensive part of the immediate version is not drawing — it is
	 * *tessellating*: clear() throws the geometry away and every drawCircle
	 * rebuilds it, for every ring, every frame. But a ring's radius only changes
	 * when the zoom or the note's weight changes. Positions change constantly;
	 * radii almost never do. So the geometry is rebuilt only when the radius or
	 * line width actually differs, and an ordinary frame writes nothing but x, y,
	 * tint, alpha — the same handful of properties Obsidian sets on its own nodes,
	 * which is why its graph stays cheap with thousands of them.
	 *
	 * Colour rides on `tint` rather than the stroke, so recolouring a group needs
	 * no rebuild either. The ring is stroked white and tinted, exactly as the
	 * renderer does with node circles.
	 */
	paintRingsPooled(renderer) {
		const layer = this.ringLayer(renderer);
		if (!layer) return;

		const Graphics = this.graphicsClass(renderer);
		if (!Graphics) return;

		const nodeScale = renderer.nodeScale;
		const viewScale = renderer.scale || 1;
		const width = Math.max(nodeScale, 1 / viewScale);
		const spread = this.ringSpan(nodeScale);

		const rawGap = this.settings().ringMinGap;
		const gapPx = typeof rawGap === 'number' && isFinite(rawGap) && rawGap >= 0
			? rawGap
			: DEFAULT_SETTINGS.ringMinGap;
		const minGap = gapPx / viewScale;

		const cull = this.settings().cullRings !== false;
		const threshold = typeof this.ringThreshold === 'number' ? this.ringThreshold : -1;
		const pool = this.ringPool;
		const frame = ++this.ringFrame;
		const nodes = renderer.nodes || [];
		let drawn = 0;

		for (const node of nodes) {
			if (!node || !node.rendered) continue;
			if (node.x === null || node.y === null) continue;

			if (cull) {
				const circle = node.circle;
				if (!circle || !circle.visible) continue;
			}

			const rank = this.sortRanks.get(node.id);
			if (rank === undefined) continue;
			// Below the cut-off worked out in applyRingLimit(), if there is one.
			if (rank < threshold) continue;

			const gap = rank * spread;
			if (gap < minGap) continue;

			const color = node.color || renderer.colors.circle;
			const alpha = (color && typeof color.a === 'number' ? color.a : 1) * node.fadeAlpha;
			if (alpha <= 0.02) continue;

			let entry = pool.get(node.id);
			if (!entry) {
				const gfx = new Graphics();
				gfx.eventMode = 'none';
				layer.addChild(gfx);
				entry = { gfx: gfx, radius: -1, width: -1, frame: 0 };
				pool.set(node.id, entry);
			}

			const gfx = entry.gfx;
			const radius = node.getSize() * nodeScale + gap;

			// The one line this whole method exists for.
			if (entry.radius !== radius || entry.width !== width) {
				gfx.clear();
				gfx.lineStyle(width, 0xffffff, 1);
				gfx.drawCircle(0, 0, radius);
				entry.radius = radius;
				entry.width = width;
			}

			gfx.x = node.x;
			gfx.y = node.y;
			gfx.tint = color.rgb;
			gfx.alpha = alpha;
			gfx.visible = true;
			entry.frame = frame;
			drawn++;
		}

		this.ringsDrawn = drawn;
		if (pool.size === drawn) return;

		/*
		 * Anything not touched this frame is hidden rather than destroyed — a note
		 * scrolling past the edge of the viewport would otherwise be created and
		 * disposed on every pan. Disposal waits until the pool is much larger than
		 * what is actually being drawn.
		 */
		const sweep = pool.size > drawn * 2 + 64;
		pool.forEach(function (entry, id) {
			if (entry.frame === frame) return;
			entry.gfx.visible = false;
			if (!sweep) return;
			try {
				if (entry.gfx.parent) entry.gfx.parent.removeChild(entry.gfx);
				entry.gfx.destroy();
			} catch (e) {
				console.error('[bases-graph] could not dispose a ring', e);
			}
			pool.delete(id);
		});
	}

	destroyRings() {
		const restores = this.rendererRestores;
		this.rendererRestores = [];
		for (const restore of restores) {
			try { restore(); } catch (e) { console.error('[bases-graph]', e); }
		}

		this.dropRingPool();
		const layer = this.ringLayerEl;
		this.ringLayerEl = null;
		if (layer) {
			try {
				if (!layer.destroyed) {
					if (layer.parent) layer.parent.removeChild(layer);
					layer.destroy();
				}
			} catch (e) {
				console.error('[bases-graph] could not dispose the ring layer', e);
			}
		}

		const graphics = this.ringsEl;
		this.ringsEl = null;
		if (!graphics) return;

		try {
			if (!graphics.destroyed) {
				if (graphics.parent) graphics.parent.removeChild(graphics);
				graphics.destroy();
			}
		} catch (e) {
			console.error('[bases-graph] could not dispose the ring graphics', e);
		}
	}

	// ----------------------------------------------------------------- panel

	/* Split a synthetic id back into what it describes. */
	parseSyntheticId(id) {
		const parts = String(id).split(NUL);
		if (parts[1] === 'K') return { kind: 'key', raw: parts[2] };
		if (parts[1] === 'V') return { kind: 'value', raw: parts[2], text: parts.slice(3).join(NUL) };
		return null;
	}

	findGroup(raw) {
		for (const group of this.propertyModel) {
			if (group.prop.raw === raw) return group;
		}
		return null;
	}

	openPanel(id) {
		this.closePanel();

		const parsed = this.parseSyntheticId(id);
		if (!parsed) return;
		const group = this.findGroup(parsed.raw);
		if (!group) return;

		const panel = this.panelEl = this.hostEl.createDiv('bases-graph-panel');
		const header = panel.createDiv('bases-graph-panel-header');
		const titleEl = header.createDiv('bases-graph-panel-title');
		const closeEl = header.createDiv('clickable-icon bases-graph-panel-close');
		if (obsidian.setIcon) obsidian.setIcon(closeEl, 'lucide-x');
		closeEl.addEventListener('click', this.closePanel.bind(this));

		if (parsed.kind === 'key') this.fillKeyPanel(panel, titleEl, group);
		else this.fillValuePanel(panel, titleEl, group, parsed.text);
	}

	fillKeyPanel(panel, titleEl, group) {
		const self = this;

		titleEl.setText(group.prop.label);
		panel.createDiv({
			cls: 'bases-graph-panel-subtitle',
			text: group.values.size + ' values across ' + group.allPaths.size + ' notes',
		});

		const rows = Array.from(group.values.entries())
			.sort(function (a, b) { return b[1].size - a[1].size; })
			.slice(0, MAX_PANEL_ROWS);

		const list = panel.createDiv('bases-graph-panel-list');
		for (const row of rows) {
			const text = row[0];
			const rowEl = list.createDiv('bases-graph-panel-row is-clickable');
			rowEl.createSpan({ cls: 'bases-graph-panel-row-label', text: text });
			rowEl.createSpan({ cls: 'bases-graph-panel-row-count', text: String(row[1].size) });
			rowEl.addEventListener('click', function () {
				self.openPanel(VALUE_PREFIX + group.prop.raw + NUL + text);
			});
		}

		if (group.truncated && this.settings().propertyMode !== MODE_FLAT) {
			panel.createDiv({
				cls: 'bases-graph-panel-note',
				text: 'The ' + group.truncated + ' rarest values have no node of their own.',
			});
		}
	}

	fillValuePanel(panel, titleEl, group, text) {
		const self = this;
		const paths = group.values.get(text);

		titleEl.setText(text);
		panel.createDiv({
			cls: 'bases-graph-panel-subtitle',
			text: group.prop.label + ' · ' + (paths ? paths.size : 0) + ' notes',
		});

		if (!paths) return;

		const noteName = function (path) {
			return path.split('/').pop().replace(/\.md$/, '');
		};
		const names = Array.from(paths).sort(function (a, b) {
			return noteName(a).localeCompare(noteName(b));
		});
		const list = panel.createDiv('bases-graph-panel-list');

		for (let i = 0; i < names.length && i < MAX_PANEL_ROWS; i++) {
			const path = names[i];
			const rowEl = list.createDiv('bases-graph-panel-row is-clickable');
			rowEl.createSpan({
				cls: 'bases-graph-panel-row-label',
				text: noteName(path),
			});
			rowEl.addEventListener('click', function (event) {
				const app = self.app || (self.controller && self.controller.app);
				if (!app) return;
				app.workspace.openLinkText(path, '', obsidian.Keymap.isModEvent(event));
			});
		}

		if (names.length > MAX_PANEL_ROWS) {
			panel.createDiv({
				cls: 'bases-graph-panel-note',
				text: (names.length - MAX_PANEL_ROWS) + ' more not shown.',
			});
		}
	}

	closePanel() {
		if (!this.panelEl) return;
		this.panelEl.detach();
		this.panelEl = null;
	}

	/*
	 * Capture the base's own rows before anything is folded in. These are the
	 * seeds the link walk starts from, and rebuildData() rebuilds from them — so
	 * recomputing never compounds on a previous fold.
	 */
	collectRows() {
		/*
		 * Only the controller's own data counts as rows. After rebuildData() this.data
		 * is the folded set — ours — and re-reading it would seed the next walk from
		 * the last one's results, so the graph would gain a hop on every settings
		 * change or metadata refresh. onDataUpdated gets fresh data from the
		 * controller and so passes this check; nothing else does.
		 */
		if (this.data && this.data === this.foldedData) return;

		const data = this.data;
		const entries = data && Array.isArray(data.data) ? data.data : [];
		const paths = new Set();

		this.rowEntries = entries.slice();
		for (const entry of entries) {
			const file = entry && entry.file;
			if (file && typeof file.path === 'string') paths.add(file.path);
		}
		this.rowPaths = paths;
	}

	/* Everything in the graph, after the linked notes have been folded in. */
	collectPaths() {
		const paths = new Set();
		const data = this.data;
		const entries = data && Array.isArray(data.data) ? data.data : [];

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const file = entry && entry.file;
			if (file && typeof file.path === 'string') paths.add(file.path);
		}

		this.paths = paths;
	}

	/* One pass: rows in, links walked and folded, everything derived from rows. */
	recompute() {
		/*
		 * Timed per stage. "It feels slow" cannot distinguish a cost paid once per
		 * update from one paid every frame, and the two want completely different
		 * fixes — so the diagnostics report both rather than inviting another guess.
		 */
		const clock = typeof performance !== 'undefined' && performance.now
			? function () { return performance.now(); }
			: function () { return Date.now(); };
		const timings = this.timings = {};
		let mark = clock();
		const step = (name, fn) => {
			fn.call(this);
			const now = clock();
			timings[name] = Math.round((now - mark) * 100) / 100;
			mark = now;
		};

		step('collectRows', this.collectRows);
		step('neighbours', this.computeNeighbours);
		step('entries', this.computeEntries);
		step('rebuildData', this.rebuildData);
		step('collectPaths', this.collectPaths);
		step('propertyNodes', this.computePropertyModel);
		step('sortRanks', this.computeSortRanks);
		step('groupColours', this.computeGroupColors);
	}

	requestRender() {
		if (!this.engine) return;
		try {
			this.engine.render();
		} catch (e) {
			console.error('[bases-graph] render failed', e);
		}
	}

	// ----------------------------------------------------------------- options

	restoreOptions() {
		const engine = this.engine;
		if (!engine) return;

		this.restoringOptions = true;
		try {
			const saved = this.config ? this.config.get(OPTIONS_KEY) : null;
			if (saved && typeof saved === 'object') engine.setOptions(saved);
			if (engine.requestUpdateSearch) engine.requestUpdateSearch.run();
		} catch (e) {
			console.error('[bases-graph] could not restore the saved graph options', e);
		} finally {
			this.restoringOptions = false;
		}
	}

	writeOptions() {
		if (this.restoringOptions || !this.engine || !this.config) return;
		try {
			const next = this.engine.getOptions();
			// config.set() writes the .base file. Restoring options makes the engine
			// report a change it did not really have, so without this guard simply
			// opening a base would rewrite the file — noise in the git history.
			if (JSON.stringify(this.config.get(OPTIONS_KEY)) === JSON.stringify(next)) return;
			this.config.set(OPTIONS_KEY, next);
		} catch (e) {
			console.error('[bases-graph] could not save the graph options', e);
		}
	}

	// ------------------------------------------------------------------- misc

	/*
	 * A graph view is an ItemView, and an ItemView expects a real leaf: its
	 * constructor ends in updateNavButtons(), which reads `leaf.history`, and its
	 * load() registers events on the leaf. So the stand-in is built on Events —
	 * that gives `on`/`offref` with the EventRef shape Component.registerEvent
	 * needs — with the handful of other members those two paths touch.
	 */
	createHostLeaf(app) {
		const leaf = new obsidian.Events();
		leaf.app = app;
		leaf.containerEl = this.hostEl;
		leaf.history = { backHistory: [], forwardHistory: [] };
		leaf.view = null;
		leaf.getRoot = function () { return leaf; };
		leaf.getContainer = function () { return null; };
		leaf.handleDrop = function () { return null; };
		return leaf;
	}

	/*
	 * Which workspace leaf is this base being displayed in? The engine compares it
	 * against workspace.activeLeaf for keyboard panning and hands it to the
	 * file-menu trigger. Read on every keydown, so a miss is throttled rather than
	 * rescanning the workspace each time — and it never returns null, because the
	 * ItemView paths above would fall over on one.
	 */
	resolveLeaf() {
		const cached = this.leafCache;
		if (cached && cached.view && cached.view.containerEl && cached.view.containerEl.contains(this.hostEl)) {
			return cached;
		}

		const now = Date.now();
		if (!cached && now - this.leafCacheTime < 1000) return this.hostLeaf;
		this.leafCacheTime = now;

		const app = this.app || (this.controller && this.controller.app);
		let found = null;
		const hostEl = this.hostEl;

		if (app && app.workspace && app.workspace.iterateAllLeaves) {
			app.workspace.iterateAllLeaves(function (leaf) {
				if (found) return;
				const view = leaf.view;
				if (view && view.containerEl && view.containerEl.contains(hostEl)) found = leaf;
			});
		}

		this.leafCache = found;
		return found || this.hostLeaf;
	}

	showMessage(text) {
		this.hostEl.empty();
		this.messageEl = this.hostEl.createDiv({ cls: 'bases-graph-message', text: text });
	}

	clearMessage() {
		if (this.messageEl) {
			this.messageEl.detach();
			this.messageEl = null;
		}
	}
}

class BasesGraphSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const containerEl = this.containerEl;
		const plugin = this.plugin;
		containerEl.empty();

		new obsidian.Setting(containerEl)
			.setName('Show properties as nodes')
			.setDesc('Properties shown in a base\'s Properties panel appear in its graph as nodes, the way tags do. '
				+ 'Which properties those are stays up to each base.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.propertyNodes !== false)
				.onChange(async (value) => {
					plugin.settings.propertyNodes = value;
					await plugin.saveSettings();
					// Redraw so the shape setting appears or disappears with it.
					this.display();
				}));

		if (plugin.settings.propertyNodes !== false) this.addShapeSetting(containerEl);

		if (plugin.settings.propertyNodes !== false) {
			new obsidian.Setting(containerEl)
				.setName('Hide empty values')
				.setDesc('Leave out notes that have nothing in a property, instead of collecting them '
					+ 'all under a "null" node.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.hideEmptyValues !== false)
					.onChange(async (value) => {
						plugin.settings.hideEmptyValues = value;
						await plugin.saveSettings();
					}));
		}

		// How far out to look belongs to a particular base, so it lives in that
		// view's own settings pane. This is only how the results are drawn.
		new obsidian.Setting(containerEl)
			.setName('Linked note colour')
			.setDesc('Applies to notes brought in by a view\'s "Linked notes to include". Dimmed '
				+ 'keeps the base\'s own results legible. By group evaluates the base\'s group-by on '
				+ 'them as well, so they take their real group\'s colour — or the no-value colour if '
				+ 'they have none.')
			.addDropdown((dropdown) => dropdown
				.addOption(NEIGHBOUR_DIM, 'Dimmed')
				.addOption(NEIGHBOUR_GROUP, 'By group')
				.addOption(NEIGHBOUR_NONE, 'Default node colour')
				.setValue(plugin.settings.neighbourColor || NEIGHBOUR_DIM)
				.onChange(async (value) => {
					plugin.settings.neighbourColor = value;
					await plugin.saveSettings();
				}));

		new obsidian.Setting(containerEl)
			.setName('Hide the animate button')
			.setDesc('The graph\'s timelapse button replays the whole vault\'s history, which says '
				+ 'nothing about the notes a base selected. Hidden in Bases graphs only — the real '
				+ 'graph view keeps its own.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.hideAnimate !== false)
				.onChange(async (value) => {
					plugin.settings.hideAnimate = value;
					await plugin.saveSettings();
				}));

		new obsidian.Setting(containerEl)
			.setName('Ring notes by sort order')
			.setDesc('Draw a ring around each note by where its value falls in the base\'s sort. '
				+ 'Notes with no value get no ring, and only bases that sort get any. How the rings '
				+ 'are spaced and how far they reach are set per view, in Configure view.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.sortRings !== false)
				.onChange(async (value) => {
					plugin.settings.sortRings = value;
					await plugin.saveSettings();
					this.display();
				}));

		if (plugin.settings.sortRings !== false) {
			new obsidian.Setting(containerEl)
				.setName('Skip rings that are off screen')
				.setDesc('Much cheaper with many notes, since the graph then draws only the rings it '
					+ 'can see. The cost: a large ring on a note just past the edge of the pane is '
					+ 'dropped as well, because the graph judges what is visible by the note\'s own '
					+ 'size rather than its ring\'s. Turn off if rings pop in and out at the edges.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.cullRings !== false)
					.onChange(async (value) => {
						plugin.settings.cullRings = value;
						await plugin.saveSettings();
					}));

			new obsidian.Setting(containerEl)
				.setName('Ring drawing')
				.setDesc('Reuse keeps one shape per ringed note and only rebuilds it when the ring\'s '
					+ 'size actually changes, so ordinary frames just move them — much faster with '
					+ 'many notes. Rebuild each frame is the simpler, slower method with no shapes '
					+ 'kept alive; switch to it if the rings ever misbehave.')
				.addDropdown((dropdown) => dropdown
					.addOption('pooled', 'Reuse shapes (fast)')
					.addOption('immediate', 'Rebuild each frame (safe)')
					.setValue(plugin.settings.ringDraw === 'immediate' ? 'immediate' : 'pooled')
					.onChange(async (value) => {
						plugin.settings.ringDraw = value === 'immediate' ? 'immediate' : 'pooled';
						await plugin.saveSettings();
					}));

			new obsidian.Setting(containerEl)
				.setName('Maximum rings')
				.setDesc('Draw at most this many rings, keeping the highest ranked notes. 0 draws them '
					+ 'all. This is the setting that actually controls the cost: a few hundred rings '
					+ 'is cheap however they are drawn, and a few thousand is not.')
				.addSlider((slider) => slider
					.setLimits(0, 2000, 50)
					.setValue(typeof plugin.settings.maxRings === 'number' ? plugin.settings.maxRings : 0)
					.setDynamicTooltip()
					.onChange(async (value) => {
						plugin.settings.maxRings = value;
						await plugin.saveSettings();
					}));

			new obsidian.Setting(containerEl)
				.setName('Smallest ring to draw')
				.setDesc('Rings standing less than this many pixels off their note\'s edge are skipped. '
					+ 'The default of 0.5 only drops rings that would be inside the note anyway. '
					+ 'Raising it does less drawing work and clears the low end of the sort, at the '
					+ 'cost of those notes losing their rings entirely.')
				.addSlider((slider) => slider
					.setLimits(0, 20, 0.5)
					.setValue(typeof plugin.settings.ringMinGap === 'number'
						? plugin.settings.ringMinGap
						: DEFAULT_SETTINGS.ringMinGap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						plugin.settings.ringMinGap = value;
						await plugin.saveSettings();
					}));
		}

		new obsidian.Setting(containerEl)
			.setName('Colour notes by group')
			.setDesc('Give each of the base\'s groups a colour from Obsidian\'s palette. '
				+ 'Only applies to bases that group.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.groupColors !== false)
				.onChange(async (value) => {
					plugin.settings.groupColors = value;
					await plugin.saveSettings();
					this.display();
				}));

		/*
		 * Outside the group-colours block on purpose: the muted linked-note colour
		 * is the plugin's too, and it applies whether or not the base is grouped.
		 */
		new obsidian.Setting(containerEl)
			.setName('Colour groups take precedence')
			.setDesc('A colour group added in the graph\'s own controls overrides the colours '
				+ 'this plugin gives a note — its group colour, or the dimming of a linked note. '
				+ 'Turn this off to have the base\'s own colouring win instead.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.colorGroupsOverride !== false)
				.onChange(async (value) => {
					plugin.settings.colorGroupsOverride = value;
					await plugin.saveSettings();
				}));

		/*
		 * Also outside the block, since v1.37.0: the legend can now consist of
		 * nothing but the graph's own colour groups, which a base that does not
		 * group still has.
		 */
		new obsidian.Setting(containerEl)
			.setName('Show a group legend')
			.setDesc('List which colour belongs to which group in the corner of the graph.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.groupLegend !== false)
				.onChange(async (value) => {
					plugin.settings.groupLegend = value;
					await plugin.saveSettings();
					this.display();
				}));

		if (plugin.settings.groupLegend !== false) {
			new obsidian.Setting(containerEl)
				.setName('List the graph\'s colour groups')
				.setDesc('Give the colour groups set in the graph\'s own controls their own section '
					+ 'of the legend, with the query and how many notes it caught. Groups that match '
					+ 'nothing in this base are left out.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.legendColorGroups !== false)
					.onChange(async (value) => {
						plugin.settings.legendColorGroups = value;
						await plugin.saveSettings();
					}));
		}

		/*
		 * One switch for the hover label, and not conditional on group colouring:
		 * the label covers the graph's colour groups too, which a base that does
		 * not group still has.
		 */
		new obsidian.Setting(containerEl)
			.setName('Name a note\'s groups on hover')
			.setDesc('Show what colours the note under the cursor: the base\'s group, and the '
				+ 'query of any colour group from the graph\'s own controls that caught it. A note '
				+ 'in both gets a line for each, so the legend does not have to be read across '
				+ 'the pane.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.groupTooltip !== false)
				.onChange(async (value) => {
					plugin.settings.groupTooltip = value;
					await plugin.saveSettings();
					this.display();
				}));

		if (plugin.settings.groupTooltip !== false) {
			new obsidian.Setting(containerEl)
				.setName('Say when a note has no group')
				.setDesc('A note with no value for the property the base groups by reads "(none)" '
					+ 'on hover, instead of showing nothing at all.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.tooltipEmptyGroup !== false)
					.onChange(async (value) => {
						plugin.settings.tooltipEmptyGroup = value;
						await plugin.saveSettings();
					}));

			/*
			 * Nested, unlike the group switch itself: the dot decorates a line that
			 * only exists while that switch is on, so this is a detail of the feature
			 * above rather than a switch hidden behind an unrelated one.
			 */
			new obsidian.Setting(containerEl)
				.setName('Show a colour dot beside each group')
				.setDesc('Put the group\'s own colour in front of its line, the same swatch the '
					+ 'legend uses, so the label says which colour on screen it is talking about.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.tooltipSwatch !== false)
					.onChange(async (value) => {
						plugin.settings.tooltipSwatch = value;
						await plugin.saveSettings();
					}));
		}

		/*
		 * Its own switch, and not nested under the group label: a base can sort
		 * without grouping, and someone who wants the number may not want the group
		 * name. Not conditional on the rings either — the value is the base's sort,
		 * which is there whether or not it is being drawn.
		 */
		new obsidian.Setting(containerEl)
			.setName('Show the sorted value on hover')
			.setDesc('Show the note\'s value for the property the base sorts by — the number the '
				+ 'ring around it is drawn from — as a line of the hover label. Rows with nothing '
				+ 'in the property read "(none)", which is why they have no ring.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.sortTooltip !== false)
				.onChange(async (value) => {
					plugin.settings.sortTooltip = value;
					await plugin.saveSettings();
					this.display();
				}));

		if (plugin.settings.sortTooltip !== false) {
			new obsidian.Setting(containerEl)
				.setName('Show a ring beside the sorted value')
				.setDesc('Put a hollow ring in front of that line, so it is obvious the value is '
					+ 'what the rings around the nodes are sized from.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.tooltipRing !== false)
					.onChange(async (value) => {
						plugin.settings.tooltipRing = value;
						await plugin.saveSettings();
					}));
		}

		if (plugin.settings.groupColors !== false) {
			new obsidian.Setting(containerEl)
				.setName('List notes with no value')
				.setDesc('Notes with nothing in the grouped property keep the graph\'s default node '
					+ 'colour. This adds a legend row for that colour so it is accounted for.')
				.addToggle((toggle) => toggle
					.setValue(plugin.settings.colorEmptyGroup !== false)
					.onChange(async (value) => {
						plugin.settings.colorEmptyGroup = value;
						await plugin.saveSettings();
					}));
		}

		new obsidian.Setting(containerEl)
			.setName('Hide orphaned attachments')
			.setDesc('With the graph\'s own "Show attachments" turned on, only show attachments that a note '
				+ 'in the graph links to. Orphaned notes are kept either way.')
			.addToggle((toggle) => toggle
				.setValue(plugin.settings.hideOrphanAttachments !== false)
				.onChange(async (value) => {
					plugin.settings.hideOrphanAttachments = value;
					await plugin.saveSettings();
				}));
	}

	addShapeSetting(containerEl) {
		const plugin = this.plugin;

		new obsidian.Setting(containerEl)
			.setName('Property node shape')
			.setDesc('Two levels puts a node between the property and its notes for each distinct value, '
				+ 'so notes cluster around the values they share. One level joins the property straight '
				+ 'to its notes and lists the values only when you click it.')
			.addDropdown((dropdown) => dropdown
				.addOption(MODE_LEVELS, 'Property → value → notes')
				.addOption(MODE_FLAT, 'Property → notes')
				.setValue(plugin.settings.propertyMode === MODE_FLAT ? MODE_FLAT : MODE_LEVELS)
				.onChange(async (value) => {
					plugin.settings.propertyMode = value === MODE_FLAT ? MODE_FLAT : MODE_LEVELS;
					await plugin.saveSettings();
				}));
	}
}

module.exports = class BasesGraphPlugin extends obsidian.Plugin {
	async onload() {
		if (typeof obsidian.BasesView !== 'function') {
			new obsidian.Notice('Bases Graph View needs Obsidian 1.10 or later.');
			return;
		}

		this.views = new Set();

		const saved = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		// The linked-note colour was a boolean before it was a choice of three.
		if (saved.neighbourColor === undefined && saved.dimNeighbours === false) {
			this.settings.neighbourColor = NEIGHBOUR_NONE;
		}

		this.registerLinkDistance();

		const self = this;
		const registered = this.registerBasesView(VIEW_TYPE, {
			name: 'Graph',
			icon: 'lucide-git-fork',
			factory: function (controller, containerEl) {
				return new BasesGraphView(controller, containerEl, self);
			},
			// Per view, because how far out to look is a property of this base and
			// not of the plugin. Rendered by Bases in the view's own settings pane
			// and stored in the .base file.
			/*
			 * Called with the view's config, and re-consulted through shouldHide on
			 * every change to any of these controls — so the two ring sliders can take
			 * turns rather than both sitting there with one of them inert.
			 */
			options: function (config) {
				const spacing = {};
				const uncapped = function () {
					try {
						return config && config.get ? config.get(RING_UNCAPPED_KEY) === true : false;
					} catch (e) {
						return false;
					}
				};
				spacing[RANK_POSITION] = 'By position';
				spacing[RANK_VALUE] = 'By distinct value';
				spacing[RANK_PROPORTIONAL] = 'Proportional to the value';
				spacing[RANK_LOG] = 'Proportional (logarithmic)';

				return [
					{
						/* Superseded by file.linkDistance() in a filter, which picks
						 * rows instead of appending nodes the filter never saw.
						 * Kept, and kept working, for bases that already set it. */
						displayName: 'Linked notes to include (legacy)',
						type: 'slider',
						key: NEIGHBOUR_DEPTH_KEY,
						min: 0,
						max: MAX_NEIGHBOUR_DEPTH,
						step: 1,
						default: 0,
					},
					{
						displayName: 'Ring spacing',
						type: 'dropdown',
						key: RING_RANK_KEY,
						options: spacing,
						default: RANK_POSITION,
					},
					{
						/* The one question: is the largest ring a size you set, or
						 * whatever the base's own size adds up to. */
						displayName: 'No largest ring',
						type: 'toggle',
						key: RING_UNCAPPED_KEY,
						default: false,
					},
					{
						displayName: 'Ring spread',
						type: 'slider',
						key: RING_SPREAD_KEY,
						min: 0,
						max: MAX_RING_SPREAD,
						step: 0.5,
						default: DEFAULT_RING_SPREAD,
						shouldHide: uncapped,
					},
					{
						displayName: 'Ring growth speed',
						type: 'slider',
						key: RING_SPEED_KEY,
						min: 0,
						max: MAX_RING_SPEED,
						step: 1,
						default: DEFAULT_RING_SPEED,
						shouldHide: function () { return !uncapped(); },
					},
				];
			},
		});

		this.addSettingTab(new BasesGraphSettingTab(this.app, this));

		this.addCommand({
			id: 'copy-diagnostics',
			name: 'Copy graph diagnostics to clipboard',
			callback: () => this.copyDiagnostics(),
		});

		this.addCommand({
			id: 'measure-ring-cost',
			name: 'Measure what the rings cost',
			callback: () => {
				let started = 0;
				this.views.forEach((view) => {
					if (!view.graphView) return;
					view.startRingBenchmark();
					started++;
				});
				new obsidian.Notice(started
					? 'Measuring — keep the graph moving for a few seconds.'
					: 'Open a base using the Graph layout first.');
			},
		});

		if (!registered) {
			new obsidian.Notice('Bases Graph View needs the core Bases plugin to be enabled.');
			return;
		}

		// So a stale copy of this file is obvious at a glance in the console.
		console.log('[bases-graph] v' + this.manifest.version
			+ ' registered the "' + VIEW_TYPE + '" Bases view.');
	}

	/*
	 * What every open graph currently thinks its groups are. Reported from inside
	 * the plugin rather than asked for through the developer console, because the
	 * console is a bad place to send someone who is trying to use their notes.
	 */
	async copyDiagnostics() {
		const report = {
			version: this.manifest.version,
			settings: this.settings,
			views: [],
		};

		this.views.forEach((view) => {
			const entry = { groupBy: null, rows: 0, groups: [] };

			try {
				const config = view.config;
				entry.groupBy = config && config.groupBy ? String(config.groupBy.property) : null;
				entry.neighbours = view.neighbourPaths ? view.neighbourPaths.size : 0;
				entry.neighboursColoured = view.groupColors
					? Array.from(view.neighbourPaths.keys()).filter((p) => view.groupColors.has(p)).length
					: 0;
				// How many notes a colour group in the graph's own controls took over
				// from the base's grouping — otherwise "my group colours are wrong"
				// and "a colour group is winning" look identical.
				entry.nativeColorOverrides = view.nativeColors ? view.nativeColors.size : 0;
				entry.colourGroupRows = view.nativeLegend ? view.nativeLegend.length : 0;
				entry.hasController = !!(view.queryController || view.controller);
				entry.hasContext = !!((view.queryController || view.controller) || {}).ctx;

				// Everything the rings depend on, so "no rings" can be read off
				// rather than guessed at.
				const sort = config && config.getSort ? config.getSort() : [];
				const ranks = view.sortRanks || new Map();
				const values = Array.from(ranks.values());
				const renderer = view.graphView && view.graphView.renderer;
				const nodeScale = renderer ? renderer.nodeScale : null;
				const spread = view.ringSpread ? view.ringSpread() : null;

				/*
				 * The whole point: graphMs is Obsidian drawing its own graph, ringMs is
				 * this plugin drawing on top of it. If ringMs is a rounding error next
				 * to graphMs, the rings are not what is slow and no amount of
				 * optimising them will be felt.
				 */
				const frames = view.frameCount || 0;
				entry.perFrame = {
					frames: frames,
					graphMs: frames ? Math.round((view.graphTime / frames) * 1000) / 1000 : null,
					ringMs: frames ? Math.round((view.ringTime / frames) * 1000) / 1000 : null,
					ringShare: frames && view.graphTime + view.ringTime > 0
						? Math.round((view.ringTime / (view.graphTime + view.ringTime)) * 100) + '%'
						: null,
					ringsDrawn: view.ringsDrawn || 0,
					nodesInGraph: renderer && renderer.nodes ? renderer.nodes.length : null,
					linksInGraph: renderer && renderer.links ? renderer.links.length : null,
				};
				entry.perUpdateMs = view.timings || null;
				entry.ringBenchmark = view.ringBenchResult || null;

				// Sampling restarts, so running the command twice measures the interval
				// between the two runs rather than the whole life of the pane.
				view.frameCount = 0;
				view.graphTime = 0;
				view.ringTime = 0;

				entry.rings = {
					enabled: this.settings.sortRings !== false,
					sortBy: sort.length ? String(sort[0].property) : null,
					direction: sort.length ? sort[0].direction : null,
					mode: view.ringRank ? view.ringRank() : null,
					spreadSetting: spread,
					ranked: values.length,
					rankMin: values.length ? Math.min.apply(null, values) : null,
					rankMax: values.length ? Math.max.apply(null, values) : null,
					nodeScale: nodeScale,
					// What the largest ring actually adds to a node, in the same units
					// as the node's own radius.
					widestRingAdds: (spread !== null && nodeScale !== null && values.length)
						? Math.max.apply(null, values) * spread * 8 * nodeScale
						: null,
					sampleNodeRadius: (renderer && renderer.nodes && renderer.nodes[0]
						&& typeof renderer.nodes[0].getSize === 'function')
						? renderer.nodes[0].getSize() * nodeScale
						: null,
				};

				const data = view.data;
				entry.rows = data && Array.isArray(data.data) ? data.data.length : 0;

				const groups = (data && data.groupedData) || [];
				for (const group of groups) {
					const key = group ? group.key : undefined;
					const ctor = key === null || key === undefined ? null : key.constructor;
					entry.groups.push({
						key: key === null || key === undefined ? null : String(key),
						cls: ctor ? (ctor.type || ctor.name || null) : null,
						hasKey: group && typeof group.hasKey === 'function' ? group.hasKey() : null,
						count: group && group.entries ? group.entries.length : 0,
						sample: group && group.entries && group.entries[0] && group.entries[0].file
							? group.entries[0].file.name
							: null,
					});
				}
			} catch (e) {
				entry.error = String(e && e.message ? e.message : e);
			}

			report.views.push(entry);
		});

		const text = JSON.stringify(report, null, 2);

		try {
			await navigator.clipboard.writeText(text);
			new obsidian.Notice('Bases Graph View: diagnostics copied to the clipboard');
		} catch (e) {
			console.log(text);
			new obsidian.Notice('Bases Graph View: could not copy — the report is in the console');
		}
	}

	/*
	 * file.linkDistance() for every base, not only the ones showing a graph.
	 * registerInstanceFunc deregisters itself on unload.
	 */
	registerLinkDistance() {
		this.linkIndex = new LinkDistanceIndex(this.app);

		if (typeof this.registerInstanceFunc !== 'function' || !obsidian.FileValue) {
			console.warn('[bases-graph] this Obsidian version has no Bases function registry; '
				+ 'file.linkDistance() is unavailable.');
			return;
		}

		this.registerInstanceFunc(obsidian.FileValue, new LinkDistanceFunction(this.linkIndex));

		const refresh = obsidian.debounce(this.refreshBases.bind(this), 400, true);
		const onLinksChanged = () => {
			this.linkIndex.invalidate();
			refresh();
		};

		/* "resolve" is per file and lands after Bases has already re-queried, so
		 * invalidating alone would leave the old distance on screen for a cycle. */
		this.registerEvent(this.app.metadataCache.on('resolve', onLinksChanged));
		this.registerEvent(this.app.metadataCache.on('resolved', onLinksChanged));
	}

	/*
	 * A distance is not part of the string QueryController compares to decide
	 * whether to re-run, and BasesEntry caches formula outputs per entry, so the
	 * cache has to be dropped with the entries. Clearing queryState forces the
	 * full runQuery path. Every Bases surface adds its controller as a child
	 * component, so the walk finds embeds and code blocks too.
	 */
	refreshBases() {
		const controllers = new Set();

		const visit = (component, depth) => {
			if (!component || depth > 8) return;
			if (typeof component.queryState === 'string' && typeof component.update === 'function') {
				controllers.add(component);
			}
			const children = component._children;
			if (Array.isArray(children)) {
				for (const child of children) visit(child, depth + 1);
			}
		};

		this.app.workspace.iterateAllLeaves(function (leaf) { visit(leaf.view, 0); });

		for (const controller of controllers) {
			try {
				controller.queryState = '';
				controller.update();
			} catch (e) {
				console.error('[bases-graph] could not refresh a base', e);
			}
		}
	}

	/* Persist without asking every view to rebuild its model. */
	async persistSettings() {
		try {
			await this.saveData(this.settings);
		} catch (e) {
			console.error('[bases-graph] could not save the settings', e);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.views.forEach(function (view) {
			try {
				view.onSettingsChanged();
			} catch (e) {
				console.error('[bases-graph] a view could not apply the new settings', e);
			}
		});
	}
};
