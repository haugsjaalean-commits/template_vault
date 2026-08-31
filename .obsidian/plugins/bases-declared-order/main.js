/*
 * OOF Declared Order — written entirely by Claude for Leander.
 * Nothing in this folder is Leander's code, so the usual per-line "# Claude"
 * marking does not apply; the whole file is mine.
 *
 * A third sort direction for Bases: **As listed** — the order a characteristic
 * note gives its values in, under `possible values`. Beside A → Z and Z → A, in
 * the toolbar's Sort and Group by rows and on a table column's right-click menu.
 *
 * Extracted from OOF Class Manager on 2026-08-30, at his ask, on his own reasoning:
 *
 *   > so it's not the classes plugin that it interprets but the OOF rules
 *   > themselves. I like this, because it feels quite elegant.
 *
 * That is exactly why this can stand alone. `possible values` is a convention he
 * invented in OOF 0.3 and wrote into his notes; OOF Class Manager is one reader of it
 * and this is another. Nothing here needs that plugin — with it uninstalled this
 * still sorts, because the characteristic notes are still there.
 *
 * WHAT IT WRITES
 *   Nothing of his, ever. It only writes the `declaredOrder:` and
 *   `declaredGroupOrder:` keys on a base's own view, which is where the choice
 *   lives — see "the marker" below.
 *
 * THE MARKER, and why the direction is not simply saved
 *   Obsidian's view parser keeps a sort row only when its direction is exactly
 *   ASC or DESC and drops it in silence otherwise. So the file keeps
 *   `direction: ASC` and a `declaredOrder:` line on the view says which rows are
 *   declared — an unrecognised view key, which Obsidian preserves the way it
 *   preserves `graphOptions` and `columnSize`.
 *
 *   Two things follow, both better than a third direction would have been: the
 *   ASC in the file is the truth rather than a placeholder, and **with this
 *   plugin disabled a base still sorts**, A → Z, instead of losing its sort.
 *
 * WHAT IS NOT REIMPLEMENTED, on purpose
 *   Neither the comparator nor the grouping. For the sort, the keys are applied
 *   one at a time, **last first**, each with a stable sort — which leaves exactly
 *   the order one comparator with tie-breaking would give — so every key
 *   Obsidian understands is handed back to its own `applySort`. For the groups,
 *   only the order of the array is replaced; Obsidian still decides which values
 *   are the same value and where the empty one goes.
 *
 * HOW THE CLASSES ARE REACHED — and the bug this extraction fixes
 *   None of the three classes is exported, and the `bases` internal plugin hands
 *   out view factories and nothing else. OOF reached them by walking the open
 *   leaves whenever a base was on screen. **That misses a deferred leaf**: a base
 *   in a background tab has no `controller.view` to take a prototype off, and
 *   nothing re-ran the pass when that tab was later opened — so declared order
 *   silently reverted to A → Z until something else happened to trigger it.
 *   Measured on his vault at the time: `declaredSortPatches: 1`, with the config
 *   prototype unpatched.
 *
 *   The hook is `plugin.getViewFactory(type)`, which the controller calls as a
 *   plain function to build every base view — so we are there when a view is
 *   constructed, deferred or not.
 *
 *   **That alone was not enough, and the first attempt at this fix failed the
 *   same way the old one did.** A view is constructed EMPTY: `view.data`, which
 *   carries the sort, the grouping and the config — three of the four prototypes
 *   — only arrives on the first `onDataUpdated`. Patching at construction
 *   installed exactly one of the four and the base still sorted A → Z. So the
 *   view's own `onDataUpdated` is wrapped as well; that is the moment the data
 *   exists, and it fires for a tab opened an hour later just the same.
 *
 *   A view whose first render already happened is then redrawn, because a sort is
 *   not re-run merely because a prototype changed. The leaf walk stays as a
 *   second chance for anything already on screen when this loads, and everything
 *   is re-tried until all four are in, since the sort popover's rows are built
 *   later than the rest.
 */

'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Menu } = obsidian;

/* The direction, and the two view keys it is stored as. Kept byte-identical to
 * what OOF Class Manager wrote, so his existing bases keep their sort across the move. */
const DECLARED = 'DECLARED';
const DECLARED_KEY = 'declaredOrder';
const DECLARED_GROUP_KEY = 'declaredGroupOrder';
const DECLARED_LABEL = 'As listed';
const DECLARED_MENU_LABEL = 'Sort as listed';

/* Values the characteristic names, then values it does not, then the empty. */
const UNNAMED_TIER = 1e9;
const EMPTY_TIER = 2e9;

const DEFAULT_SETTINGS = {
	characteristicsFolder: 'Obsidian/Characteristics',
	characteristicPrefix: '∘ ',
};

/* ------------------------------------------------------------------ helpers */

function toArray(value) {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function linkName(value) {
	if (typeof value !== 'string') return null;
	let text = value.trim();
	if (!text) return null;
	const wikilink = text.match(/^!?\[\[(.+)\]\]$/);
	if (wikilink) text = wikilink[1];
	const pipe = text.indexOf('|');
	if (pipe !== -1) text = text.slice(0, pipe);
	text = text.split('#')[0].trim();
	if (!text) return null;
	return text.split('/').pop();
}

function propertyId(name) {
	if (name.startsWith('note.') || name.startsWith('formula.')
		|| name.startsWith('file.')) return name;
	return name === 'file' ? 'file.file' : 'note.' + name;
}

/*
 * Only a `note.` property can be a characteristic: `file.` and `formula.` are
 * not, whatever they are named.
 */
function characteristicOfProperty(id) {
	if (typeof id !== 'string' || !id.startsWith('note.')) return null;
	const name = id.slice(5);
	return name && name.indexOf('.') === -1 ? name : null;
}

function basesValueEntries(value) {
	if (value === null || value === undefined) return [];
	/*
	 * A missing property is not a value spelled "null". Bases hands out a
	 * singleton for it whose `toString` is that word, so without this an empty
	 * cell would rank as a value the characteristic simply does not name, and sort
	 * alphabetically among them instead of last.
	 */
	if (obsidian.NullValue && value instanceof obsidian.NullValue) return [];

	const data = value.data;
	if (Array.isArray(data)) {
		return data
			.map((entry) => (entry === null || entry === undefined ? '' : String(entry)))
			.filter((entry) => entry.trim() !== '');
	}
	const text = String(value);
	return text.trim() === '' ? [] : [text];
}

function rankCells(cells, values) {
	let tier = EMPTY_TIER;
	let text = '';
	for (const cell of cells) {
		const name = (linkName(cell) || cell).toLowerCase();
		if (!text) text = name;
		const at = values.indexOf(name);
		if (at !== -1 && at < tier) tier = at;
		else if (tier === EMPTY_TIER) tier = UNNAMED_TIER;
	}
	return { tier, text };
}

function declaredRank(entry, property, values) {
	let cells = [];
	try { cells = basesValueEntries(entry.getValue(property)); } catch (e) { cells = []; }
	return rankCells(cells, values);
}

function declaredGroupRank(group, values) {
	if (!group || typeof group.hasKey !== 'function' || !group.hasKey()) {
		return { tier: EMPTY_TIER, text: '' };
	}
	return rankCells(basesValueEntries(group.key), values);
}

function byTier(a, b) {
	if (a.tier !== b.tier) return a.tier - b.tier;
	if (a.tier !== UNNAMED_TIER) return 0;
	return a.text.localeCompare(b.text);
}

/*
 * Ours belongs with Obsidian's own sort items, above the warning-coloured
 * "clear sort" that ends that section — appended, then moved into place.
 */
function placeAmongSortItems(menu) {
	const items = menu && menu.items;
	if (!Array.isArray(items) || items.length < 2) return;
	const ours = items[items.length - 1];
	for (let i = 0; i < items.length - 1; i++) {
		const item = items[i];
		if (item.section !== 'sort') continue;
		if (!item.dom || !item.dom.classList.contains('is-warning')) continue;
		items.pop();
		items.splice(i, 0, ours);
		return;
	}
}

/* --------------------------------------------------------- declared values */

/*
 * The ordered values a characteristic names, read straight from its note.
 *
 * OOF Class Manager answered this through its whole class picture. That was incidental
 * — the question is only "what does `possible values` list, in order" — so here
 * it is a direct read, which is what lets this plugin stand without that one.
 *
 * Only the **words** count. `possible values: "[0, 10]"` is an interval and
 * `possible values: [[Genre]]` is a class; neither is a list of values in an
 * order, and for those the option is simply not offered.
 */
class DeclaredValues {
	constructor(plugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.cache = new Map();
	}

	clear() { this.cache.clear(); }

	/* OOF's own settings when it is installed, so one vault has one answer. */
	folderAndPrefix() {
		const oof = this.app.plugins && this.app.plugins.plugins['oof-objects'];
		const s = oof && oof.settings;
		return {
			folder: (s && s.characteristicsFolder) || this.plugin.settings.characteristicsFolder,
			prefix: s && s.characteristicPrefix !== undefined
				? s.characteristicPrefix : this.plugin.settings.characteristicPrefix,
		};
	}

	characteristicFile(name) {
		const { folder, prefix } = this.folderAndPrefix();
		for (const path of [`${folder}/${prefix}${name}.md`, `${folder}/${name}.md`]) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file) return file;
		}
		return null;
	}

	forName(name) {
		if (this.cache.has(name)) return this.cache.get(name);
		const answer = this.read(name);
		this.cache.set(name, answer);
		return answer;
	}

	read(name) {
		const file = this.characteristicFile(name);
		if (!file) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		if (!fm) return null;

		const values = [];
		for (const entry of toArray(fm['possible values'])) {
			const text = String(entry).trim();
			if (!text) continue;
			if (/^\[\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\]$/.test(text)) continue;   /* an interval */
			if (/^!?\[\[.*\]\]$/.test(text)) continue;                        /* a class */
			values.push(text.toLowerCase());
		}
		return values.length > 0 ? values : null;
	}

	/* Can this sort property be put in declared order at all? */
	forProperty(property) {
		const name = characteristicOfProperty(property);
		if (!name) return null;
		let values = null;
		try { values = this.forName(name); } catch (e) {
			console.error('bases-declared-order: values for ' + name, e);
			return null;
		}
		return values ? { name, values } : null;
	}
}

/* ------------------------------------------------------------------ plugin */

class BasesDeclaredOrderPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.values = new DeclaredValues(this);
		this.patches = 0;

		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (file && file.path.includes(this.settings.characteristicsFolder)) this.values.clear();
		}));

		this.hookViewFactory();
		this.registerDeclaredOrderMenu();
		this.app.workspace.onLayoutReady(() => this.capture());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.capture()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.capture()));

		this.addSettingTab(new DeclaredOrderSettingTab(this.app, this));
	}

	onunload() { this.unhookViewFactory(); }

	basesInstance() {
		const p = this.app.internalPlugins && this.app.internalPlugins.plugins.bases;
		return (p && p.instance) || null;
	}

	/*
	 * The fix for the deferred-leaf bug. `getViewFactory(type)` is called as a
	 * plain function to build every base view, so wrapping it puts us exactly
	 * where a view comes into existence — including the moment a background tab is
	 * finally opened, which the leaf walk could never see.
	 */
	hookViewFactory() {
		const inst = this.basesInstance();
		if (!inst || typeof inst.getViewFactory !== 'function') return;
		const original = inst.getViewFactory;
		this.originalGetViewFactory = original;
		const plugin = this;
		inst.getViewFactory = function (type) {
			const factory = original.call(this, type);
			if (typeof factory !== 'function') return factory;
			return function (...args) {
				const view = factory.apply(this, args);
				try { plugin.watchView(view); } catch (e) {
					console.error('bases-declared-order', e);
				}
				return view;
			};
		};
	}

	unhookViewFactory() {
		const inst = this.basesInstance();
		if (inst && this.originalGetViewFactory) inst.getViewFactory = this.originalGetViewFactory;
		this.originalGetViewFactory = null;
	}

	/*
	 * A view is constructed EMPTY. `view.data` — which carries the sort, the
	 * grouping and the config, three of the four prototypes — arrives later, on
	 * the first `onDataUpdated`. Patching only at construction therefore installed
	 * exactly one of the four and left the base sorting A → Z, which is the same
	 * symptom the leaf walk had for a different reason.
	 *
	 * So the instance's own `onDataUpdated` is wrapped: it is the moment the data
	 * exists, it fires for every view including one whose tab was opened an hour
	 * later, and once everything is patched the work is a single integer compare.
	 * A view whose first render already happened is then redrawn, or it would keep
	 * the order it was built with.
	 */
	watchView(view) {
		if (!view || view.declaredOrderWatched) return;
		view.declaredOrderWatched = true;
		const plugin = this;
		const original = view.onDataUpdated;
		if (typeof original === 'function') {
			view.onDataUpdated = function (...args) {
				const result = original.apply(this, args);
				try { plugin.patchFromView(view, true); } catch (e) {
					console.error('bases-declared-order', e);
				}
				return result;
			};
		}
		this.patchFromView(view, false);
	}

	/*
	 * A view's data object may not exist at construction, so this is re-tried:
	 * from the factory, from the layout events, and again until all four patches
	 * are in. The sort popover's rows in particular are built later than the rest,
	 * so the first pass often installs some and a later one finishes the job.
	 */
	patchFromView(view, mayRedraw) {
		const was = this.patches;
		if (view && view.data) {
			this.patchApplySort(Object.getPrototypeOf(view.data));
			this.patchGroupedData(Object.getPrototypeOf(view.data));
			if (view.data.config) this.patchViewConfig(Object.getPrototypeOf(view.data.config));
		}
		const controller = view && view.queryController;
		const menu = controller && controller.sortMenu;
		const row = menu && (menu.groupByRow
			|| (Array.isArray(menu.currentSort) ? menu.currentSort[0] : null));
		if (row) this.patchSortRow(prototypeDeclaring(row, 'configureSortRow'));

		/*
		 * Anything sorted before the patches landed is in the wrong order and will
		 * stay there: the sort is not re-run just because a prototype changed.
		 */
		if (mayRedraw && this.patches > was && view.data && this.sortIsDeclared(view.data)
			&& controller && typeof controller.notifyView === 'function') {
			try { controller.notifyView(); } catch (e) {
				console.error('bases-declared-order: redraw', e);
			}
		}
		return this.patches - was;
	}

	/* Anything already on screen when this plugin loaded. */
	capture() {
		if (this.patches >= 4) return;
		const stale = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const controller = leaf && leaf.view && leaf.view.controller;
			const inner = controller && controller.view;
			if (!inner) return;
			this.patchFromView(inner, true);
			if (inner.data && this.sortIsDeclared(inner.data)) stale.push(controller);
		});
		for (const controller of stale) {
			if (typeof controller.notifyView !== 'function') continue;
			try { controller.notifyView(); } catch (e) {
				console.error('bases-declared-order: could not redraw a base', e);
			}
		}
	}

	sortIsDeclared(data) {
		try {
			const keys = this.sortKeysOf(data);
			if (keys && keys.some((key) => key.direction === DECLARED)) return true;
			const group = data.config && data.config.groupBy;
			return !!group && group.direction === DECLARED;
		} catch (e) { return false; }
	}

	/* ----- the patches ----------------------------------------------------- */

	patchApplySort(proto) {
		if (!proto || proto.declaredOrderSort) return false;
		const plugin = this;
		const original = proto.applySort;
		if (typeof original !== 'function') return false;

		proto.declaredOrderSort = true;
		this.patches += 1;
		proto.applySort = function (entries) {
			let keys = null;
			try { keys = plugin.sortKeysOf(this); } catch (e) { keys = null; }
			if (!keys || !keys.some((key) => key.direction === DECLARED)) {
				return original.call(this, entries);
			}
			try { return plugin.applyDeclaredSort(this, entries, keys, original); } catch (e) {
				console.error('bases-declared-order: sort', e);
				return original.call(this, entries);
			}
		};
		this.register(() => { proto.applySort = original; delete proto.declaredOrderSort; });
		return true;
	}

	sortKeysOf(data) {
		if (!data || !data.config || typeof data.config.getSort !== 'function') return null;
		const known = new Set(data.allProperties || []);
		return data.config.getSort().filter((key) => known.has(key.property));
	}

	applyDeclaredSort(data, entries, keys, original) {
		for (let i = keys.length - 1; i >= 0; i--) {
			const key = keys[i];
			const declared = key.direction === DECLARED
				? this.values.forProperty(key.property) : null;
			if (declared) this.sortByDeclaredOrder(entries, key.property, declared.values);
			else this.sortByOneKey(data, entries, key, original);
		}
	}

	/*
	 * One key, sorted by Obsidian's own comparator. `applySort` reads its keys back
	 * off `this.config.getSort()`, so "this one key" is a matter of answering that
	 * question differently for the length of the call — an own property on the
	 * config instance, put back afterwards whatever happens.
	 */
	sortByOneKey(data, entries, key, original) {
		const config = data.config;
		const had = Object.getOwnPropertyDescriptor(config, 'getSort');
		/*
		 * A declared key can arrive here — the values emptied since, or this plugin
		 * disabled mid-session. It falls back to A → Z, which is what the file
		 * literally says. Handing DECLARED to Obsidian's comparator would sort
		 * Z → A, since anything that is not ASC is descending to it.
		 */
		const one = key.direction === DECLARED
			? { property: key.property, direction: 'ASC' } : key;
		config.getSort = function () { return [one]; };
		try { original.call(data, entries); } finally {
			if (had) Object.defineProperty(config, 'getSort', had);
			else delete config.getSort;
		}
	}

	sortByDeclaredOrder(entries, property, values) {
		const ranks = new Map();
		for (const entry of entries) ranks.set(entry, declaredRank(entry, property, values));
		entries.sort((a, b) => byTier(ranks.get(a), ranks.get(b)));
	}

	patchGroupedData(proto) {
		if (!proto || proto.declaredOrderGroups) return false;
		const descriptor = Object.getOwnPropertyDescriptor(proto, 'groupedData');
		if (!descriptor || typeof descriptor.get !== 'function') return false;

		const plugin = this;
		const original = descriptor.get;
		proto.declaredOrderGroups = true;
		this.patches += 1;

		Object.defineProperty(proto, 'groupedData', {
			enumerable: descriptor.enumerable,
			configurable: true,
			get: function () {
				/*
				 * `groupBy` is read straight off the config in half a dozen places, so
				 * there is no read to hook the way `getSort` hooks the sort. This is
				 * the one that always runs first, and asking for the sort is what folds
				 * the marker in — for both of them.
				 */
				try {
					if (this.config && typeof this.config.getSort === 'function') this.config.getSort();
				} catch (e) { /* a broken config is Obsidian's to complain about */ }

				const group = this.config && this.config.groupBy;
				if (!group || group.direction !== DECLARED) return original.call(this);

				let declared = null;
				try { declared = plugin.values.forProperty(group.property); } catch (e) { declared = null; }

				/*
				 * A shadow of the config saying ASC, rather than writing ASC over his
				 * `groupBy` and putting it back: nothing that could reach a save ever
				 * sees a value this plugin did not mean.
				 */
				const config = this.config;
				const shadow = Object.create(config);
				shadow.groupBy = { property: group.property, direction: 'ASC' };

				let groups = null;
				this.config = shadow;
				try { groups = original.call(this); } finally { this.config = config; }

				if (declared && Array.isArray(groups)) {
					try {
						const ranks = new Map();
						for (const g of groups) ranks.set(g, declaredGroupRank(g, declared.values));
						groups.sort((a, b) => byTier(ranks.get(a), ranks.get(b)));
					} catch (e) { console.error('bases-declared-order: grouping', e); }
				}
				return groups;
			},
		});
		this.register(() => {
			Object.defineProperty(proto, 'groupedData', descriptor);
			delete proto.declaredOrderGroups;
		});
		return true;
	}

	patchViewConfig(proto) {
		if (!proto || proto.declaredOrderConfig) return false;
		const getSort = proto.getSort;
		const setSortProperty = proto.setSortProperty;
		const serialize = proto.serialize;
		if (typeof getSort !== 'function' || typeof serialize !== 'function') return false;

		proto.declaredOrderConfig = true;
		this.patches += 1;

		/*
		 * Read the marker once, into `this.sort`, and never again. A fresh config is
		 * parsed out of the file on every change, so "once" means once per config —
		 * and after that the direction in the array is the only truth, which is what
		 * lets him pick A → Z again and have it stick.
		 */
		proto.getSort = function () {
			if (!this.declaredOrderRead) {
				this.declaredOrderRead = true;
				const marked = new Set(toArray(this.data && this.data[DECLARED_KEY])
					.filter((entry) => typeof entry === 'string')
					.map(propertyId));
				if (marked.size > 0 && Array.isArray(this.sort)) {
					for (const entry of this.sort) {
						if (marked.has(entry.property)) entry.direction = DECLARED;
					}
				}
				const grouped = this.data && this.data[DECLARED_GROUP_KEY];
				if (typeof grouped === 'string' && this.groupBy
					&& this.groupBy.property === propertyId(grouped)) {
					this.groupBy.direction = DECLARED;
				}
			}
			return getSort.call(this);
		};

		if (typeof setSortProperty === 'function') {
			proto.setSortProperty = function (property, direction) {
				if (direction !== DECLARED) return setSortProperty.call(this, property, direction);
				const sort = this.getSort().filter((entry) => entry.property !== property);
				sort.unshift({ property, direction: DECLARED });
				this.sort = sort;
				this.query.save();
			};
		}

		/* The one place the two halves are written, and the only one. */
		proto.serialize = function () {
			const out = serialize.call(this);
			const marked = [];
			if (Array.isArray(out.sort)) {
				for (const entry of out.sort) {
					if (entry.direction !== DECLARED) continue;
					marked.push(entry.property);   /* already in the file's own spelling */
					entry.direction = 'ASC';
				}
			}
			if (marked.length > 0) out[DECLARED_KEY] = marked;
			/*
			 * Only a config this plugin has actually read may drop the key. One it has
			 * not still carries whatever the file said, and throwing that away because
			 * nothing had asked for it yet would lose the sort.
			 */
			else if (this.declaredOrderRead) delete out[DECLARED_KEY];

			if (out.groupBy && out.groupBy.direction === DECLARED) {
				out[DECLARED_GROUP_KEY] = out.groupBy.property;
				out.groupBy.direction = 'ASC';
			} else if (this.declaredOrderRead) delete out[DECLARED_GROUP_KEY];

			return out;
		};

		this.register(() => {
			proto.getSort = getSort;
			if (typeof setSortProperty === 'function') proto.setSortProperty = setSortProperty;
			proto.serialize = serialize;
			delete proto.declaredOrderConfig;
		});
		return true;
	}

	/*
	 * The third entry in the toolbar's direction dropdown. One patch covers both
	 * rows, because Obsidian builds the group-by row out of the same class — which
	 * is also why the two halves belong together: they sit one above the other in
	 * the same popover, and an option on one and missing from the other reads as a
	 * bug.
	 */
	patchSortRow(proto) {
		if (!proto || proto.declaredOrderRow) return false;
		const plugin = this;
		const original = proto.configureSortRow;
		if (typeof original !== 'function') return false;

		proto.declaredOrderRow = true;
		this.patches += 1;
		proto.configureSortRow = function () {
			original.call(this);
			try { plugin.offerDeclaredDirection(this); } catch (e) {
				console.error('bases-declared-order: direction', e);
			}
		};
		this.register(() => { proto.configureSortRow = original; delete proto.declaredOrderRow; });
		return true;
	}

	offerDeclaredDirection(row) {
		if (!row) return;
		const combobox = row.sortDirectionCombobox;
		if (!combobox || typeof combobox.setItems !== 'function') return;
		if (!this.values.forProperty(row.property)) return;

		const items = combobox.getItems().slice();
		if (items.some((item) => item.value === DECLARED)) return;
		items.push({ value: DECLARED, display: DECLARED_LABEL });
		combobox.setItems(items);
		/* Set again, or a row already in declared order shows an empty label. */
		combobox.setValueById(row.direction);
	}

	/*
	 * The same option where a table is actually sorted from. Obsidian builds that
	 * menu with `Menu.forEvent`, so ours joins it — in the BUBBLE phase, because
	 * its own items have to be in the menu already for ours to be placed among
	 * them.
	 */
	registerDeclaredOrderMenu() {
		this.menuHandler = (event) => {
			if (typeof Menu !== 'function' || typeof Menu.forEvent !== 'function') return;
			let column = null;
			try { column = this.tableColumnFor(event); } catch (e) {
				console.error('bases-declared-order: header menu', e);
				return;
			}
			if (!column) return;

			const menu = Menu.forEvent(event);
			const current = column.config.getSort()
				.find((entry) => entry.property === column.property);

			menu.addItem((item) => item
				.setTitle(DECLARED_MENU_LABEL)
				.setSection('sort')
				.setIcon('lucide-list-ordered')
				.setChecked(!!current && current.direction === DECLARED)
				.onClick(() => column.config.setSortProperty(column.property, DECLARED)));

			placeAmongSortItems(menu);
		};
		document.addEventListener('contextmenu', this.menuHandler);
		this.register(() => document.removeEventListener('contextmenu', this.menuHandler));
	}

	/*
	 * Which column was right-clicked. **Not** guessed from the markup: the table
	 * view keeps its header cells, each carrying its element and the property it is
	 * for, so the element the click landed in answers it exactly. The column
	 * elements carry no property attribute, and matching on the displayed name
	 * would break on two columns named the same.
	 */
	tableColumnFor(event) {
		const target = event.target;
		if (!target || typeof target.closest !== 'function') return null;
		if (!target.closest('.bases-table-header')) return null;

		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const view = leaf && leaf.view;
			const container = view && view.containerEl;
			if (!container || !container.contains(target)) return;
			const inner = view.controller && view.controller.view;
			const cells = inner && inner.header && inner.header.cells;
			if (!Array.isArray(cells) || !inner.config) return;
			const cell = cells.find((entry) => entry && entry.el && entry.el.contains(target));
			if (cell) found = { config: inner.config, property: cell.prop };
		});

		if (!found || !this.values.forProperty(found.property)) return null;
		return found;
	}

	async saveSettings() {
		this.values.clear();
		await this.saveData(this.settings);
	}
}

/* The prototype in the chain that actually declares `name`. */
function prototypeDeclaring(object, name) {
	let proto = object && Object.getPrototypeOf(object);
	while (proto) {
		if (Object.prototype.hasOwnProperty.call(proto, name)) return proto;
		proto = Object.getPrototypeOf(proto);
	}
	return null;
}

/* ---------------------------------------------------------------- settings */

class DeclaredOrderSettingTab extends PluginSettingTab {
	constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Adds “As listed” beside A → Z and Z → A, sorting by the order a characteristic '
				+ 'note gives its values in under “possible values”. Offered only where those values '
				+ 'are words — an interval or a class has no order to be in.',
		});

		const oof = this.app.plugins.plugins['oof-objects'];
		if (oof) {
			containerEl.createEl('p', {
				cls: 'setting-item-description',
				text: 'OOF Class Manager is installed, so its own characteristics folder and prefix are used '
					+ 'and the two settings below are ignored. One vault, one answer.',
			});
		}

		new Setting(containerEl)
			.setName('Characteristics folder')
			.setDesc('Where characteristic notes live, when OOF Class Manager is not installed.')
			.addText((t) => t.setValue(this.plugin.settings.characteristicsFolder)
				.onChange(async (v) => {
					this.plugin.settings.characteristicsFolder = v.trim() || DEFAULT_SETTINGS.characteristicsFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Characteristic prefix')
			.setDesc('The prefix on a characteristic note’s file name — the characteristic itself is the rest.')
			.addText((t) => t.setValue(this.plugin.settings.characteristicPrefix)
				.onChange(async (v) => {
					this.plugin.settings.characteristicPrefix = v;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'A base stores the choice as a “declaredOrder” line beside an ordinary ASC, so with '
				+ 'this plugin disabled it still sorts A → Z rather than losing its sort.',
		});
	}
}

module.exports = BasesDeclaredOrderPlugin;

/* Exported for the off-app tests; nothing in the plugin reads this. */
module.exports.__test = {
	toArray, linkName, propertyId, characteristicOfProperty, basesValueEntries,
	rankCells, declaredRank, declaredGroupRank, byTier, placeAmongSortItems,
	DeclaredValues, prototypeDeclaring,
	DECLARED, DECLARED_KEY, DECLARED_GROUP_KEY, UNNAMED_TIER, EMPTY_TIER, DEFAULT_SETTINGS,
};
