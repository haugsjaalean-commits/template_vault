/*
 * Bases Table Kanban — written entirely by Claude for Leander.
 * Nothing in this folder is Leander's code, so the usual per-line "# Claude"
 * marking does not apply; the whole file is mine.
 *
 * Called OOF Drag and Drop until 2026-08-30, when he asked for the `+ new`
 * button and named the result. The folder id stays `bases-drag-drop` so his
 * settings survive the rename.
 *
 * From his notes `Obsidian/Notes/Bases drag and drop.md` and the conversation
 * that followed it.
 *
 * What it does
 *   Drag a note from one group of a base to another and the property the base
 *   groups by is written for you. Drop it between two rows instead and the
 *   sort properties that would put it there are written too. Press the base's
 *   own `+ new` and the note is made with the base's template, offered for
 *   renaming, and then dropped where you click. The point is not the gesture:
 *   it is being able to delete the `status` column and still set status
 *   without opening the note.
 *
 * The `+ new` button (2026-08-30, from `dealing with `+ new` button in bases.md`)
 *   Obsidian's own button creates a note that has none of the properties its
 *   base is filtering on — it derives them from a fixed list of filter shapes,
 *   and `file.isA("Improvement")` is not one of them, so a note made in a class
 *   base is filtered out of it on the spot. Its `newItemTemplate` would fix
 *   that, except that it copies a template's frontmatter and nothing else.
 *
 *   His three steps: make the note with the template, offer to change the name
 *   Templater gave it, then let it be clicked into place "exactly like as if
 *   they had grabbed the file". So no menu appears and nothing is asked before
 *   the note exists — which means the placement is the ordinary drag walk over
 *   an ordinary row, driven from mousemove and click. See "the new note" and
 *   `DragLayer.beginPlacement`, below.
 *
 * The one idea worth keeping in your head
 *   A base has no manual order. A row's position is a *consequence* of its
 *   values under the view's sort. So this plugin never moves anything —
 *
 *       the drag edits the note, and the position follows.
 *
 *   Which is why some drops are impossible, why the insertion bar snaps, and
 *   why the label says what will change instead of just showing an arrow.
 *
 * How a drop is decided (see planRowDrop)
 *   Sort keys are walked in order. Keys where the two neighbouring rows *agree*
 *   are forced — the note must take those values or it is not in that stretch
 *   of the table at all. The first key where they *differ* decides, and it has
 *   three possible answers: a value strictly between them (then nothing else
 *   matters), or tie with the row above, or tie with the row below.
 *
 *   Only `note.*` properties can be written. `file.name`, `file.mtime` and
 *   `formula.*` cannot, so the sort keys are truncated at the first unwritable
 *   one: everything after it is unreachable by definition. If the *first* sort
 *   key is unwritable there is no row-level control at all in that view, and
 *   the plugin says so rather than pretending.
 *
 *   Whatever it decides, the landing position is then *simulated* against the
 *   full sort — including the unwritable keys — so the bar is drawn where the
 *   note will actually end up, not where the pointer was. That is the whole of
 *   his "show the different options for moving based on these constraints":
 *   the bar only ever stands in a reachable place.
 *
 * Groups that hold nothing (his ask, 2026-08-30)
 *   A base only has the groups its notes put there, so a value nothing carries
 *   yet has no heading — and you cannot drop a note into a group that is not on
 *   the screen. So a group is drawn for every value the characteristic lists
 *   under `possible values`, empty ones included.
 *
 *   This is the plugin's own idea read backwards. Everywhere else a POSITION is
 *   a consequence of a note's values; here a GROUP is a consequence of the
 *   values the characteristic declares. Same field, same classifier: words give
 *   a list, an interval is a shape and a class is a type, and neither of those
 *   two is enumerated.
 *
 *   They are drawn collapsed and faint — his condition, and the right one. An
 *   empty group is furniture until a drag is in flight, and it comes up to full
 *   strength then, which is exactly when it is a target.
 *
 * What Obsidian already provides, and why this plugin is small
 *   - `BasesView.createTransaction` records the frontmatter before and after and
 *     pushes it onto the view's own undo stack, so a drop is one Ctrl+Z. Every
 *     write goes through it, in ONE transaction, or taking back a three-property
 *     move would cost three undos.
 *   - `dragManager.handleDrop` gives the hover class and, better, an `action`
 *     label drawn beside the drag ghost — which is where "tell me what will
 *     change" goes, for no screen space at all.
 *   - `.table-drag-target.mod-row` is already in Obsidian's stylesheet.
 *   - Cards are already draggable (they carry a link payload naming the file).
 *     Table and list rows are not, so they get a floating grip.
 *
 * Three traps, each of which cost time
 *   - Rows are virtualised AND recycled, and `virtualize()` calls
 *     `setChildrenInPlace` on the row element — so anything appended to a row is
 *     silently removed on the next scroll. Hence ONE floating grip that follows
 *     the pointer, not a grip per row.
 *   - Making a whole table row draggable would kill the table's click-drag cell
 *     selection... except it would not: `onTableSelectionStart` begins with
 *     `if (evt.shiftKey || !evt.targetNode.draggable)`, so Obsidian's own
 *     selection stands aside for draggable targets. The guard was already there.
 *   - `getSort()` can report a direction of DECLARED — that is OOF Class Manager
 *     folding in its `declaredOrder:` marker, not an Obsidian value. Positions
 *     are read off `data.groupedData`, which is already sorted, so that never
 *     matters for *where* things are; it matters only for asking whether a value
 *     exists between two others, which is what readDomain is for.
 */

'use strict';

/*
 * `BasesEntryGroup` and `StringValue` are exported like any other class, which
 * is what lets an empty group be a REAL group rather than an object shaped like
 * one — Obsidian calls `key.renderTo()` on it to draw the heading and OOF
 * Declared Order calls `hasKey()` on it to rank it.
 */
const {
	Plugin, PluginSettingTab, Setting, Modal, Menu, Notice, BasesEntryGroup, StringValue,
	getFrontMatterInfo, parseYaml,
} = require('obsidian');

/* ------------------------------------------------------------------ settings */

const DEFAULT_SETTINGS = {
	/* Drop a note on a group heading, or on a group's empty space. */
	groupDrops: true,
	/* Drop a note between two rows. Needs a writable first sort key. */
	rowDrops: true,
	/*
	 * Move the file between folders — but only where the folder is what the view
	 * groups or sorts by, which falls out for free: the plugin never writes a key
	 * the view is not organised by. His ask, with his boundary — the folder may
	 * change, the file NAME never does.
	 *
	 * Unlike every other write here a move cannot join the base's transaction, so
	 * Ctrl+Z will not bring it back. That is the whole reason it is a switch.
	 */
	folderMoves: true,
	/*
	 * "There should be an option to always be told what will change with the
	 * move" — his note. On, because it costs nothing: the label lives beside the
	 * drag ghost and exists only while the mouse is down.
	 */
	showChanges: true,
	/*
	 * "They should also be allowed to only accept certain changes in the move
	 * but not others." That is the review dialog. It is reachable on any drop by
	 * holding the modifier; this setting makes it the default for every drop.
	 *
	 * Off by default, and deliberately against my usual rule that a setting he
	 * asked for ships on: his note opens with "without the user having to do any
	 * dirty work", and a dialog on every drag is exactly that work.
	 */
	reviewEveryMove: false,
	reviewModifier: 'alt',
	/* The grip that makes a table or list row draggable at all. */
	showGrip: true,
	/* Draw the insertion bar for row drops. */
	showIndicator: true,
	/*
	 * Flash the row where the note ended up, once the base has re-sorted itself.
	 * The write is instant and silent, so without this the only evidence a drop
	 * did anything is that the table looks slightly different — his ask.
	 */
	flashOnDrop: true,
	/*
	 * Draw every place in the group the note could go, not only the one under the
	 * pointer — his ask, after finding that a single bar made the choices
	 * invisible until he had already hovered them.
	 */
	showOptions: true,
	/*
	 * A group for every value the characteristic declares, so a value nothing uses
	 * yet still has somewhere to drop into. His ask, and on by default — with the
	 * empty ones drawn collapsed, which was his condition: they are furniture until
	 * a drag is in flight, and furniture should be quiet.
	 */
	emptyGroups: true,
	/*
	 * "There should be an option to hide the `+ New` button." Off, because the
	 * button is the feature: hiding it is for a base where making notes by hand
	 * is not what you do.
	 */
	hideNewButton: false,
	/*
	 * His step 2 — the window offering to change the name Templater gave the note.
	 * That window is Obsidian's own; off, it is closed again as soon as it opens.
	 */
	newNoteName: true,
	/*
	 * His step 3 — click where the note should go, exactly as if it had been
	 * dragged there. Off, the note is simply made, template and all.
	 */
	newNotePlacement: true,
	/* Ask which subclass, where the base's class has any. */
	newNoteSubclass: true,
};

const MODIFIERS = {
	alt: { label: 'Alt', test: (e) => e.altKey },
	shift: { label: 'Shift', test: (e) => e.shiftKey },
	ctrl: { label: 'Ctrl', test: (e) => e.ctrlKey || e.metaKey },
};

/*
 * Per layout: the element that is one group, the element that is one item, and
 * where a group's items live. Read off the 1.13.7 bundle — table groups are one
 * `.bases-table` each holding [heading, summary row, tbody], which is why "on
 * the heading" and "between rows" are two different elements and his N.B. costs
 * nothing to honour.
 */
const LAYOUTS = {
	table: {
		groupSel: '.bases-table',
		itemSel: '.bases-tr',
		groupEl: (g) => g.tableEl,
		/*
		 * The table and the list parent the heading inside the group; the cards view
		 * makes it a SIBLING of the group's container, so it cannot be reached by a
		 * descendant selector and each layout has to say where its own is.
		 */
		headingEl: (g) => g.tableEl.querySelector(':scope > .bases-group-heading'),
		itemsEl: (g) => g.tbodyEl,
		items: (view) => view.rows || [],
		horizontal: false,
	},
	cards: {
		groupSel: '.bases-cards-group',
		itemSel: '.bases-cards-item',
		groupEl: (g) => g.containerEl,
		/*
		 * Measured on 1.13.7: a cards group carries `view`, `containerEl` and
		 * `groupHeadingEl`, and that last one is `undefined` — the heading is a
		 * SIBLING of the group container inside `.bases-cards-container`, put
		 * there before it. So it is read off the DOM, and only when the element
		 * before really is one; reading the property gave null for every group and
		 * quietly took the empty-group marking out of the cards view.
		 */
		headingEl: (g) => {
			if (g.groupHeadingEl) return g.groupHeadingEl;
			const prev = g.containerEl && g.containerEl.previousElementSibling;
			return prev && prev.matches('.bases-group-heading') ? prev : null;
		},
		itemsEl: (g) => g.containerEl,
		items: (view) => view.items || [],
		horizontal: true,
	},
	list: {
		groupSel: '.bases-list-group',
		itemSel: '.bases-list-item',
		groupEl: (g) => g.containerEl,
		headingEl: (g) => g.groupHeadingEl || null,
		itemsEl: (g) => g.listEl,
		items: (view) => (view.groups || []).flatMap((g) => g.rows || []),
		horizontal: false,
	},
};

/* ------------------------------------------------------------- value helpers */

const TAG = '[bases-table-kanban]';

/*
 * Our mark on the NewItemMenu prototype. `Symbol.for` so that a reload of this
 * plugin recognises the patch its previous instance left, rather than laying a
 * second one on top of it.
 */
const NEW_ITEM_HOOK = Symbol.for('basesTableKanban.newItemMenu');

const NOTE_PREFIX = 'note.';
const FOLDER_KEY = 'file.folder';
const DATE_TYPES = new Set(['date', 'datetime']);

/*
 * Two kinds of writable, and the difference matters at every level.
 *
 * A `note.*` key is frontmatter: written inside the base's own transaction, so
 * one Ctrl+Z takes it back. `file.folder` is the filesystem: written by moving
 * the file, which cannot join that transaction. Everything else about a file —
 * its name, its path, its dates — stays untouchable. **The note's name is never
 * changed**, which is what makes a folder move safe to offer at all: the note
 * keeps its identity and only its shelf changes.
 */
function isFolderKey(prop) {
	return prop === FOLDER_KEY;
}

let folderMovesEnabled = false;

function isWritable(prop) {
	if (typeof prop !== 'string') return false;
	if (prop.startsWith(NOTE_PREFIX)) return true;
	return folderMovesEnabled && isFolderKey(prop);
}

function propName(prop) {
	return isWritable(prop) ? prop.slice(NOTE_PREFIX.length) : prop;
}

/*
 * Everything downstream compares *cells*, not Obsidian Value objects: one shape
 * for a value read off an entry and for a value we are proposing to write, so
 * the simulation of where a note will land uses one comparator throughout.
 */
function cellOfValue(v) {
	if (v === undefined || v === null) return { empty: true, str: '', num: null };
	let str;
	try { str = String(v); } catch (e) { str = ''; }
	if (str === '' || str === 'null' || str === 'undefined') return { empty: true, str: '', num: null };
	const num = numberOf(v && v.data !== undefined ? v.data : str);
	return { empty: false, str, num };
}

function cellOfLiteral(v) {
	if (v === undefined || v === null || v === '') return { empty: true, str: '', num: null };
	if (Array.isArray(v)) return { empty: v.length === 0, str: v.join(', '), num: null };
	const str = String(v);
	return { empty: false, str, num: numberOf(v) };
}

function numberOf(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string') return null;
	const t = v.trim();
	if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

function readCell(entry, prop) {
	try { return cellOfValue(entry.getValue(prop)); } catch (e) { return { empty: true, str: '', num: null }; }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/*
 * Mirrors Obsidian's own sort comparator closely enough to predict a landing
 * position. The one part that is not a matter of taste: empty values sort last
 * in BOTH directions, because Obsidian returns from the null branch before the
 * direction is applied.
 */
function compareCells(a, b, direction, ordered) {
	if (a.empty && b.empty) return 0;
	if (a.empty) return 1;
	if (b.empty) return -1;

	let u;
	if (ordered) {
		const ia = ordered.indexOf(a.str);
		const ib = ordered.indexOf(b.str);
		if (ia !== -1 && ib !== -1) return ia - ib;   /* already in view order */
		if (ia !== -1) return -1;
		if (ib !== -1) return 1;
		u = collator.compare(a.str, b.str);
	} else if (a.num !== null && b.num !== null) {
		u = a.num - b.num;
	} else {
		u = collator.compare(a.str, b.str);
	}
	return direction === 'DESC' ? -u : u;
}

/* ------------------------------------------------------------------- domains */

/*
 * What values a property is allowed to take, and in what order they appear in
 * this view. Read from the characteristic note his OOF Class Manager model already
 * keeps — `possible values` holds words, or an interval like `[0, 10]`, or a
 * link to a class. Only the first two give a domain we can pick a value out of;
 * a link to a class means "any instance of it", which is not something a drag
 * should invent.
 *
 * Read directly rather than through OOF Class Manager: `possible values` is a
 * frontmatter field in his vault, not that plugin's private state, so this one
 * keeps working with OOF disabled. The two settings it does borrow (where
 * characteristics live and what prefixes their file names) are read from OOF
 * when it is there, and defaulted when it is not.
 */
class Domains {
	constructor(app) {
		this.app = app;
		this.cache = new Map();
		this.dateCache = new Map();
	}

	oofSettings() {
		const p = this.app.plugins && this.app.plugins.plugins['oof-objects'];
		return (p && p.settings) || null;
	}

	characteristicFile(name) {
		const s = this.oofSettings();
		const folder = (s && s.characteristicsFolder) || 'Obsidian/Characteristics';
		/*
		 * `(s && s.x) !== undefined` reads as a null guard and is not one: with no
		 * OOF Class Manager installed `s` is null, `(null) !== undefined` is true, and the
		 * next line throws. The plugin is supposed to work without that plugin, and
		 * this line was the reason it did not.
		 */
		const prefix = s && s.characteristicPrefix !== undefined ? s.characteristicPrefix : '∘ ';
		const tries = [
			`${folder}/${prefix}${name}.md`,
			`${folder}/${name}.md`,
		];
		for (const path of tries) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f) return f;
		}
		return null;
	}

	/*
	 * A date is never written. His call, and the right one: a date on a note is
	 * usually a fact about the thing — when it was created, when someone was born
	 * — not a dial to turn, and a drag that quietly rewrote `created` would be
	 * doing real damage for a cosmetic reason. The plugin could only ever COPY one
	 * anyway (there is no sensible value "between" two dates), so nothing of value
	 * is lost by refusing outright.
	 *
	 * Two sources, because either alone has a hole: the characteristic note's
	 * `property type`, and Obsidian's own type manager, which knows about
	 * properties his model has no note for.
	 */
	isDate(prop) {
		if (!isWritable(prop) || isFolderKey(prop)) return false;
		if (this.dateCache.has(prop)) return this.dateCache.get(prop);
		const answer = this.readIsDate(propName(prop));
		this.dateCache.set(prop, answer);
		return answer;
	}

	readIsDate(name) {
		const file = this.characteristicFile(name);
		if (file) {
			const cache = this.app.metadataCache.getFileCache(file);
			const declared = cache && cache.frontmatter && cache.frontmatter['property type'];
			if (DATE_TYPES.has(String(declared || '').toLowerCase())) return true;
		}
		try {
			const info = this.app.metadataTypeManager.getTypeInfo(name);
			const type = (info && ((info.expected && info.expected.type) || (info.inferred && info.inferred.type))) || '';
			if (DATE_TYPES.has(String(type).toLowerCase())) return true;
		} catch (e) { /* no type manager: fall through */ }
		return false;
	}

	/* { kind: 'words', words: [...] } | { kind: 'number', min, max } | null */
	forProperty(prop) {
		if (!isWritable(prop)) return null;
		if (this.cache.has(prop)) return this.cache.get(prop);
		const out = this.read(propName(prop));
		this.cache.set(prop, out);
		return out;
	}

	read(name) {
		const file = this.characteristicFile(name);
		if (!file) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		if (!fm) return null;

		const raw = fm['possible values'];
		const entries = raw === undefined || raw === null ? []
			: Array.isArray(raw) ? raw : [raw];

		const words = [];
		let interval = null;
		for (const e of entries) {
			const text = String(e).trim();
			const m = text.match(/^\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]$/);
			if (m) { interval = { min: Number(m[1]), max: Number(m[2]) }; continue; }
			if (/^\[\[.*\]\]$/.test(text)) continue;     /* a class link: no usable domain */
			if (text) words.push(text);
		}

		if (interval) return { kind: 'number', min: interval.min, max: interval.max };
		if (words.length) return { kind: 'words', words };
		if (String(fm['property type'] || '').toLowerCase() === 'number') {
			return { kind: 'number', min: null, max: null };
		}
		return null;
	}

	/*
	 * The domain in the order this view puts it in. DECLARED is OOF Class Manager'
	 * direction and means "the order `possible values` lists them in", which is
	 * the whole reason that feature exists; ASC and DESC re-sort it.
	 */
	orderedWords(prop, direction) {
		const d = this.forProperty(prop);
		if (!d || d.kind !== 'words') return null;
		if (direction === 'DECLARED') return d.words.slice();
		const sorted = d.words.slice().sort((a, b) => collator.compare(a, b));
		return direction === 'DESC' ? sorted.reverse() : sorted;
	}
}

/* ----------------------------------------------------------------- placement */

const START = Symbol('start');
const END = Symbol('end');
/*
 * A neighbouring row that HAS no value, as opposed to there being no
 * neighbouring row. Both sort last, so for ordering they behave alike — but only
 * one of them leaves room: any number at all sorts before a blank, while nothing
 * sorts past the end of the list. Collapsing the two lost that.
 */
const BLANK = Symbol('blank');

/*
 * The simplest number strictly between two others: the one with the fewest
 * decimal places, and among those the smallest.
 *
 * The midpoint is the obvious answer and it is the wrong one, because a drag is
 * not a single event — it is done over and over on the same rows. Bisecting
 * 5 and 4.875 gives 4.9375, then 4.90625, and every drop buries the value a
 * digit deeper until a rating he assigns by judgement reads 4.9688 and means
 * nothing. Between 4.875 and 4.9375 the answer here is 4.9.
 *
 * Any value in the open interval is equally correct for ordering, so the one to
 * pick is the one a person could have typed. Bisection survives only as the
 * fallback for an interval too narrow to hold a short decimal.
 */
function simplestBetween(lo, hi, target) {
	const aim = target === undefined ? (lo + hi) / 2 : target;
	for (let p = 0; p <= 6; p++) {
		const step = Math.pow(10, -p);
		const k = Math.round(aim / step);
		/* Outwards from whichever multiple of this step is nearest what we aim at. */
		for (const n of [k, k - 1, k + 1]) {
			const v = Math.round(n * step * 1e6) / 1e6;
			if (v > lo && v < hi) return v;
		}
	}
	return (lo + hi) / 2;
}

/*
 * A value strictly between two neighbours, or null when the domain has no room.
 * `above`/`below` are cells, START, or END.
 *
 * Words: pick the middle of whatever the domain offers between them. Between
 * `started` and `attained` there is nothing, so that gap is genuinely closed
 * and the caller falls back to joining a run.
 *
 * Numbers: the midpoint, refused when it would round onto one of the ends.
 *
 * Anything else — free text, dates, links, lists — returns null on purpose.
 * Inventing a string that sorts between "apple" and "banana" is not a service.
 */
function betweenValue(domains, prop, direction, above, below) {
	const words = domains.orderedWords(prop, direction);
	if (words) {
		const ia = above === START ? -1
			: (above === END || above === BLANK) ? words.length
				: words.indexOf(above.str);
		const ib = (below === END || below === BLANK) ? words.length
			: below === START ? -1
				: words.indexOf(below.str);
		if (ia === -1 && above !== START) return null;
		if (ib === -1 && below !== END) return null;
		const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
		const room = [];
		for (let i = lo + 1; i < hi; i++) room.push(words[i]);
		if (!room.length) return null;
		return room[Math.floor((room.length - 1) / 2)];
	}

	/*
	 * No characteristic note behind the property is not the same as no room. If
	 * both neighbours hold numbers, a number between them is meaningful whatever
	 * the vault does or does not declare — and his `priority` sort key has no
	 * characteristic note at all (the one he wrote is called `active priority`),
	 * so without this that key could never separate anything.
	 */
	const d = domains.forProperty(prop) || { kind: 'number', min: null, max: null, inferred: true };
	if (d.kind !== 'number') return null;
	const aBlank = above === BLANK, bBlank = below === BLANK;
	const an = (above === START || above === END || aBlank) ? null : above.num;
	const bn = (below === START || below === END || bBlank) ? null : below.num;

	let value;
	if (an !== null && bn !== null) {
		value = simplestBetween(Math.min(an, bn), Math.max(an, bn));
	} else if (bn !== null) {
		value = direction === 'DESC'
			? (d.max !== null ? simplestBetween(bn, d.max, bn) : bn + 1)
			: (d.min !== null ? simplestBetween(d.min, bn, bn) : bn - 1);
	} else if (an !== null) {
		value = direction === 'DESC'
			? (d.min !== null ? simplestBetween(d.min, an, an) : an - 1)
			: (d.max !== null ? simplestBetween(an, d.max, an) : an + 1);
	} else if (d.inferred) {
		return null;                      /* nothing declared: no end to reach for */
	} else if (bBlank && !aBlank && d.min !== null && d.max !== null) {
		/* The row below simply has no value, so any number in the domain beats it. */
		value = (d.min + d.max) / 2;
	} else {
		return null;
	}

	value = Math.round(value * 1e4) / 1e4;
	if (d.min !== null && value < d.min) return null;
	if (d.max !== null && value > d.max) return null;
	if (value === an || value === bn) return null;   /* adjacent integers: no room */
	return value;
}

/*
 * The sort keys a drop can actually act on: the leading run of writable ones.
 * Everything from the first `file.*` or `formula.*` onwards is unreachable, and
 * so are the keys after it, since that one decides first.
 */
function canWrite(prop, domains) {
	if (!isWritable(prop)) return false;
	return !(domains && domains.isDate && domains.isDate(prop));
}

function effectiveKeys(sort, domains) {
	const keys = [];
	for (const s of sort) {
		if (!canWrite(s.property, domains)) break;
		keys.push(s);
	}
	return keys;
}

function firstBlockingKey(sort, domains) {
	for (const s of sort) if (!canWrite(s.property, domains)) return s;
	return null;
}

/*
 * Where a note carrying `overrides` would land among `entries`, under the full
 * sort — unwritable keys included, which is how the bar can be drawn where the
 * note will really end up rather than where the pointer was.
 *
 * It is a RANGE, not an index, and that distinction is the whole honesty of the
 * feature. Rows the sort cannot tell apart have no defined order between them:
 * Obsidian's sort is stable, so they keep whatever order the query happened to
 * return, which is not something a drop can choose. Seventeen of his `attained`
 * improvements share a status, an empty priority AND an identical mtime — every
 * key ties — so a bar drawn at one exact spot inside that block would be a lie.
 *
 *   from === to   the position is settled; draw the bar there
 *   from <  to    it lands somewhere in [from, to); highlight that block instead
 */
function landingRange(entries, entry, overrides, sort, domains) {
	let from = 0;
	while (from < entries.length
		&& compareEntry(entry, overrides, entries[from], sort, domains) > 0) from++;
	let to = from;
	while (to < entries.length
		&& compareEntry(entry, overrides, entries[to], sort, domains) === 0) to++;
	return { from, to };
}

/* The first position of that range. Kept because it is the useful scalar. */
function landingIndex(entries, entry, overrides, sort, domains) {
	return landingRange(entries, entry, overrides, sort, domains).from;
}

function compareEntry(entry, overrides, other, sort, domains) {
	for (const s of sort) {
		const mine = Object.prototype.hasOwnProperty.call(overrides, s.property)
			? cellOfLiteral(overrides[s.property])
			: readCell(entry, s.property);
		const theirs = readCell(other, s.property);
		const ordered = domains.orderedWords(s.property, s.direction);
		const c = compareCells(mine, theirs, s.direction, ordered);
		if (c !== 0) return c;
	}
	return 0;
}


/*
 * Which gap the pointer is in, given the row it is over and how far through that
 * row it sits. Pure index arithmetic, kept out of the DOM so it can be tested —
 * it is where the worst bug in this plugin lived.
 *
 * The dragged note's own row is the case that matters. The pointer is over it
 * constantly: that is where the gesture starts, and the row stays put while you
 * drag. It is missing from the list the gap is measured against, so `indexOf`
 * answers -1 — and answering "the end of the group" to that, as this used to,
 * meant every hover over your own row planned a move to the bottom, wrote
 * whatever value sorts last, and pinned the insertion bar to one spot for the
 * whole drag. Its two boundaries collapse into one once it is taken out of the
 * list, and that one is where it already sits.
 */
function gapAt(all, hovered, dragged, bias) {
	const entries = all.filter((e) => e !== dragged);
	const at = entries.indexOf(hovered);
	if (at !== -1) return { gap: bias < 0.5 ? at : at + 1, bias };

	const here = all.indexOf(hovered);
	if (here === -1) return { gap: entries.length, bias: 1 };
	return { gap: Math.min(here, entries.length), bias: 0.5 };
}

/*
 * Whether a view has any order at all for a note to be placed in: a writable
 * group-by, or a writable first sort key. Neither means a card's position is
 * whatever order the query returned, which is not something a drop can choose.
 */
function canPlaceIn(view, domains) {
	const config = view && view.config;
	if (!config) return false;
	const groupBy = config.groupBy;
	if (groupBy && canWrite(groupBy.property, domains)) return true;
	const sort = config.getSort ? config.getSort() : [];
	return effectiveKeys(sort, domains).length > 0;
}

/*
 * The plan for dropping `entry` on the group `groupIdx`, without deciding a
 * position — his N.B.: "If the user wants to only regroup a note and not decide
 * its position, then they can drop it in the heading of the group."
 */
function planGroupDrop(ctx, groupIdx) {
	const { view, entry, domains } = ctx;
	const groupBy = view.config && view.config.groupBy;
	if (!groupBy) return { ok: false, why: 'This view is not grouped.' };
	if (!canWrite(groupBy.property, domains)) {
		const why = domains && domains.isDate && domains.isDate(groupBy.property)
			? `Grouped by ${displayName(view, groupBy.property)}, and dates are never changed by a drag.`
			: `Grouped by ${displayName(view, groupBy.property)}, which cannot be written.`;
		return { ok: false, why };
	}

	const group = view.data.groupedData[groupIdx];
	const value = groupValue(group, groupBy.property);
	if (value === undefined) {
		return { ok: false, why: 'This group\'s value cannot be written from a drag.' };
	}

	const changes = [];
	const now = readCell(entry, groupBy.property);
	const want = cellOfLiteral(value);
	if (now.str !== want.str) changes.push({ prop: groupBy.property, value });

	if (!changes.length) return { ok: false, why: 'Already in this group.' };
	return { ok: true, kind: 'group', changes, exact: true, groupIdx, domains };
}

/*
 * An empty value sorts last in both directions, so as a *bound* it behaves
 * exactly like the end of the list. Without this, "put it before the row whose
 * priority is blank" finds no room, when in truth any number at all would do.
 */
function asBound(cell) {
	if (cell === START || cell === END || cell === BLANK) return cell;
	return cell && cell.empty ? BLANK : cell;
}

/*
 * The note now shares `anchor`'s value on the deciding key, so it sits inside
 * that neighbour's block. The keys below can still separate the two: for each in
 * turn, look for a value strictly past the anchor's — after it when the note
 * belongs below the anchor, before it when above. Failing that, match the anchor
 * exactly (anything else would sort the note away from it) and try the next key
 * down.
 *
 * Nothing can overshoot: the anchor is the last row of its block on the deciding
 * key and the row on the other side differs there, so there is nothing between
 * them to jump over.
 *
 * Returns whether the note ended up genuinely separated from the anchor.
 */
function refineAgainst(ctx, changes, keys, anchor, goAfter) {
	const { domains, entry } = ctx;
	for (const k of keys) {
		const raw = readCell(anchor, k.property);
		const av = asBound(raw);
		const room = goAfter
			? betweenValue(domains, k.property, k.direction, av, END)
			: betweenValue(domains, k.property, k.direction, START, av);
		if (room !== null) {
			setChange(changes, k.property, room);
			return true;
		}
		/*
		 * Match the anchor — but only record it when it is actually a change. Both
		 * being blank is the common case in his vault, and writing
		 * `priority → empty` onto a note whose priority is already empty made the
		 * label claim an edit that would not happen.
		 */
		const ordered = domains.orderedWords(k.property, k.direction);
		if (compareCells(readCell(entry, k.property), raw, k.direction, ordered) !== 0) {
			setChange(changes, k.property, literalOf(anchor, k.property));
		}
	}
	return false;
}

/*
 * The plan for dropping `entry` into the gap `rawGap` of a group. Walks the
 * writable sort keys: agreed keys are forced, the first disagreeing key decides,
 * and the keys under it refine that decision.
 */
/*
 * A gap has to mean ONE thing. The walk used to consult the pointer's half of the
 * row whenever the deciding key had no room, so the boundary between two rows
 * produced different writes depending on whether you approached it from above or
 * below — the bar sat still while the label changed under it, which is what made
 * the highlighting feel arbitrary.
 *
 * So both routes are computed and the better one wins on its merits: landing
 * where asked beats not, one definite place beats a block, fewer writes beat
 * more, and a dead heat always resolves the same way. The pointer's half chooses
 * WHICH gap (see gapFor) and nothing else.
 */
function planRowDrop(ctx, groupIdx, rawGap, pointerBias) {
	const above = planAtGap(ctx, groupIdx, rawGap, true);
	const below = planAtGap(ctx, groupIdx, rawGap, false);
	if (!above.ok || !below.ok) return above.ok ? above : below;
	return betterPlan(above, below) ? above : below;
}

/*
 * True when `a` should be preferred over `b`.
 *
 * The last line is the point: on a dead heat the route through the row ABOVE
 * always wins, rather than whichever half of a row the pointer happens to be in.
 * Both routes reach the same boundary and write the same number of properties, so
 * letting the pointer choose only meant the label changed as you crossed a row's
 * midpoint while the bar stood still — which is exactly what made the feedback
 * look arbitrary. A gap means one thing.
 */
function betterPlan(a, b) {
	if (a.exact !== b.exact) return a.exact;
	if (a.settled !== b.settled) return a.settled;
	if (a.changes.length !== b.changes.length) return a.changes.length < b.changes.length;
	return true;
}

function planAtGap(ctx, groupIdx, rawGap, preferAbove) {
	const { view, entry, domains } = ctx;
	const sort = view.config.getSort ? view.config.getSort() : [];
	const keys = effectiveKeys(sort, domains);

	const base = planGroupDropOrEmpty(ctx, groupIdx);
	/*
	 * `hard` IS the refusal — returning its wrapper handed back an object with no
	 * `ok` and no `why`, so a view grouped by something unwritable (a folder, a
	 * date) refused every row drop silently, with a blank label. The one place the
	 * plugin has to explain itself is where it says no.
	 */
	if (base.hard) return base.hard;
	const changes = base.changes.slice();

	if (!keys.length) {
		const blocking = firstBlockingKey(sort, domains);
		if (!changes.length) {
			return {
				ok: false,
				why: blocking
					? `Sorted by ${displayName(view, blocking.property)} first, which cannot be written — rows here have no order to set.`
					: 'This view has no sort to write.',
			};
		}
		return {
			ok: true, kind: 'group', changes, exact: false, groupIdx, domains,
			note: blocking ? `position set by ${displayName(view, blocking.property)}` : null,
		};
	}

	/* The group as it will be with the dragged note taken out of it. */
	const entries = view.data.groupedData[groupIdx].entries.filter((e) => e !== entry);
	const gap = Math.max(0, Math.min(rawGap, entries.length));
	const above = gap > 0 ? entries[gap - 1] : null;
	const below = gap < entries.length ? entries[gap] : null;

	/* Did the walk separate the note from its neighbours with values WE wrote? */
	let chosen = true;
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		const ordered = domains.orderedWords(k.property, k.direction);
		const av = above ? readCell(above, k.property) : START;
		const bv = below ? readCell(below, k.property) : END;

		const same = above && below
			&& compareCells(av, bv, k.direction, ordered) === 0;

		if (same) {
			/* Forced: the note must carry this or it is not in this stretch. */
			const mine = readCell(entry, k.property);
			if (compareCells(mine, av, k.direction, ordered) !== 0) {
				setChange(changes, k.property, literalOf(above, k.property));
			}
			continue;
		}

		/*
		 * The deciding key — but first: the note may ALREADY hold a value that puts
		 * it here. Asking for a fresh one and writing it would be a write that moves
		 * nothing, and on a numeric key it drags the value a step deeper into
		 * invented precision every single time, which is how a rating becomes
		 * 4.9688. Dropping a note back where it already is must cost nothing.
		 */
		const held = readCell(entry, k.property);
		const pastAbove = !above || compareCells(held, av, k.direction, ordered) > 0;
		const beforeBelow = !below || compareCells(held, bv, k.direction, ordered) < 0;
		if (!held.empty && pastAbove && beforeBelow) { chosen = true; break; }

		const between = betweenValue(domains, k.property, k.direction, asBound(av), asBound(bv));
		if (between !== null) {
			setChange(changes, k.property, between);
			chosen = true;
			break;
		}

		/*
		 * No room at this key — which is NOT the end of the precision available.
		 * Taking a neighbour's value puts the note in that neighbour's block, and
		 * every key BELOW this one can still separate the two. Walking them is what
		 * "as much precision as possible" means; stopping here was the plugin's
		 * first and much blunter answer, and it made every sort key after the first
		 * look ignored.
		 */
		const anchor = (preferAbove ? above : below) || below || above;
		if (!anchor) { chosen = false; break; }
		setChange(changes, k.property, literalOf(anchor, k.property));
		chosen = refineAgainst(ctx, changes, keys.slice(i + 1), anchor, anchor === above);
		break;
	}

	if (!changes.length) return { ok: false, why: 'Already there — nothing to change.' };

	const overrides = {};
	for (const c of changes) overrides[c.prop] = c.value;
	const range = landingRange(entries, entry, overrides, sort, domains);
	const tied = range.to - range.from;

	/*
	 * TWO different questions, and conflating them was a real bug: the walk's own
	 * opinion of whether it had split the neighbours was reported as `exact`, and
	 * it could be true while the note landed somewhere else entirely. Dropping
	 * between two rows that agree on every writable key forces the note to match
	 * them, after which `file.mtime` decides where among them it goes — a single
	 * definite spot, nothing tied, and not the spot that was asked for. 90 of the
	 * 644 plans his own base can produce were exact-and-wrong that way, which is
	 * why the bar kept appearing a row below the pointer.
	 *
	 * So both are read off the OUTCOME, never off the walk:
	 *   settled — it lands in one definite place rather than anywhere in a block
	 *   exact   — that place is the one it was asked for
	 */
	const settled = tied === 0;
	const exact = settled && range.from === gap;
	const blocking = firstBlockingKey(sort, domains);

	/*
	 * Three states, and they are three different sentences:
	 *   not settled  it goes somewhere in a block nothing can order
	 *   not exact    it goes to one definite place, but not the one asked for
	 *   not chosen   it goes exactly where asked — but an unwritable key, not us,
	 *                is what put it on that side of its neighbour. His original
	 *                note is about precisely this: rename the file and it moves.
	 */
	let note = null;
	if (!settled) {
		note = `lands among ${tied + 1} rows the sort can’t tell apart`;
	} else if (!exact) {
		note = blocking
			? `can’t go between those two — ${displayName(view, blocking.property)} decides`
			: 'can’t go between those two';
	} else if (!chosen && blocking) {
		note = `order among equals set by ${displayName(view, blocking.property)}`;
	}

	return {
		ok: true, kind: 'row', changes, exact, settled, chosen, groupIdx,
		landing: range.from, landingTo: range.to, entries, note, domains,
	};
}

/*
 * Every distinct place in a group this note could be put — his ask, because one
 * bar that only appears where the pointer already is tells you nothing about
 * where else you could aim.
 *
 * Both tie directions are tried at each gap because the pointer's half decides
 * which neighbour an unreachable gap falls back to, and those are two different
 * outcomes. Results are deduped on landing *and* on what would be written: two
 * gaps that produce the same edit are one option, not two.
 */
function rowOptions(ctx, groupIdx) {
	const group = ctx.view.data.groupedData[groupIdx];
	if (!group) return [];
	const entries = group.entries.filter((e) => e !== ctx.entry);
	const seen = new Map();
	for (let gap = 0; gap <= entries.length; gap++) {
		{
			const plan = planRowDrop(ctx, groupIdx, gap, 0.5);
			if (!plan.ok || plan.kind !== 'row') continue;
			/*
			 * Keyed on the PLACE, not on the edit. Several different edits can land
			 * a note in the same spot, and drawing a mark for each would stack lines
			 * on one boundary and say the same thing twice. Where they collide the
			 * settled one wins, then the one that writes least.
			 */
			const sig = plan.landing + ':' + plan.landingTo;
			const held = seen.get(sig);
			if (!held
				|| (plan.settled && !held.settled)
				|| (plan.settled === held.settled && plan.changes.length < held.changes.length)) {
				seen.set(sig, plan);
			}
		}
	}
	return [...seen.values()];
}

/* The group part of a row drop: being over a group at all forces the group-by. */
function planGroupDropOrEmpty(ctx, groupIdx) {
	const plan = planGroupDrop(ctx, groupIdx);
	if (plan.ok) return { changes: plan.changes, hard: null };
	/* "Already in this group" is fine here — it just contributes no change. */
	if (plan.why === 'Already in this group.') return { changes: [], hard: null };
	if (plan.why === 'This view is not grouped.') return { changes: [], hard: null };
	return { changes: [], hard: plan };
}

function setChange(changes, prop, value) {
	const at = changes.findIndex((c) => c.prop === prop);
	if (at === -1) changes.push({ prop, value });
	else changes[at] = { prop, value };
}

/*
 * The value to write so that a note matches `entry` on `prop`. Taken from the
 * note's own frontmatter rather than from the rendered value, so a link stays
 * `[[Name]]` and a list stays a list.
 */
function literalOf(entry, prop) {
	if (isFolderKey(prop)) return folderOf(entry);
	const name = propName(prop);
	const fm = entry && entry.frontmatter;
	if (fm && Object.prototype.hasOwnProperty.call(fm, name)) return fm[name];
	const cell = readCell(entry, prop);
	return cell.empty ? null : cell.str;
}

/*
 * The value to write so a note joins this group — taken from a note ALREADY in
 * it, rather than from the group's rendered heading.
 *
 * His Table view groups by `project`, which is a list: notes hold
 * `project: ["[[Class Manager]]"]`. Reading the heading gave the string
 * `"[[Class Manager]]"`, which flattens the list on every drop — and for the
 * group of notes in two projects it gave `"[[Class Manager]], [[Graph Focus]]"`,
 * one string that is neither a list nor a link. Copying the raw frontmatter of a
 * member is exact for lists, links, numbers and text alike, and needs no guessing
 * about YAML shape.
 */
function groupValue(group, prop) {
	if (!group) return undefined;
	if (isFolderKey(prop)) {
		const member = group.entries && group.entries[0];
		return member ? folderOf(member) : String(group.key || '');
	}
	if (groupKeyValue(group) === null) return null;
	const member = group.entries && group.entries[0];
	if (member) {
		const raw = literalOf(member, prop);
		if (raw !== null && raw !== undefined) return raw;
	}
	return groupKeyValue(group);
}

/* The folder a note sits in, as the base reports it — '' at the vault root. */
function folderOf(entry) {
	const path = entry && entry.file && entry.file.path;
	if (!path) return '';
	const cut = path.lastIndexOf('/');
	return cut === -1 ? '' : path.slice(0, cut);
}

function groupKeyValue(group) {
	const key = group && group.key;
	if (key === undefined || key === null) return null;
	const data = key.data;
	if (data === undefined) {
		const str = String(key);
		return str === '' ? null : str;
	}
	if (data === null) return null;
	if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') return data;
	/* Lists and links: keep the rendered form, which is what the note carries. */
	const str = String(key);
	return str === '' ? null : str;
}


/* ------------------------------------------------------------ empty groups */

/*
 * A group for every value the characteristic names, including the ones nothing
 * in the base carries. His ask, and it fixes the one thing a drag could not do:
 * you cannot drop a note into a group that is not on the screen.
 *
 * It is the rest of this plugin read backwards. Everywhere else a POSITION is a
 * consequence of a note's values; here a GROUP is a consequence of the values
 * the characteristic declares, whether or not any note has got round to using
 * one. `possible values` already says which those are — the same field
 * `betweenValue` picks a value out of — so nothing new is read from his vault.
 *
 * Only words, and that is the same classifier as everywhere else: an interval
 * is a shape rather than a list, and a class is a type, so grouping by `project`
 * would grow a heading for each of eighty-four notes instead of the eight values
 * in use. Enumerating a type is not answering the question the base asked.
 */
const PHANTOM = 'oofEmptyGroup';

function groupText(group) {
	return cellOfLiteral(groupKeyValue(group)).str.trim();
}

/*
 * The declared values this view has no group for. Phantoms already in the array
 * count as groups, which is what makes the whole thing idempotent: running it
 * twice over the same data adds nothing the second time.
 */
function missingGroupValues(view, domains) {
	const groupBy = view && view.config && view.config.groupBy;
	if (!groupBy || !canWrite(groupBy.property, domains)) return [];
	const domain = domains.forProperty(groupBy.property);
	if (!domain || domain.kind !== 'words') return [];

	const groups = (view.data && view.data.groupedData) || [];
	const taken = new Set();
	for (const group of groups) {
		const text = groupText(group).toLowerCase();
		if (text) taken.add(text);
	}

	const out = [];
	for (const word of domain.words) {
		const key = String(word).trim().toLowerCase();
		/* A word listed twice is one group, not two. */
		if (!key || taken.has(key)) continue;
		taken.add(key);
		out.push(word);
	}
	return out;
}

/*
 * Where the phantom belongs among the groups that are already there.
 *
 * Obsidian sorts groups with `new Intl.Collator(undefined, {sensitivity: 'base',
 * numeric: true})` — the collator at the top of this file, read off the bundle —
 * and moves the group with no value to the end. So a phantom is inserted into
 * its place rather than the array being re-sorted underneath whatever else has
 * arranged it.
 *
 * A direction that is neither ASC nor DESC is OOF Declared Order's DECLARED, and
 * there the order IS the `possible values` list — the list being walked. That
 * plugin re-sorts on every read of `groupedData` anyway, so this branch only
 * keeps the two from disagreeing for a frame; it is written out because the
 * direction is plain ASC whenever that plugin is off, and then nothing else
 * would put the phantom right.
 */
function phantomIndex(groups, word, direction, words) {
	if (direction !== 'ASC' && direction !== 'DESC') {
		const rank = new Map();
		words.forEach((w, i) => rank.set(String(w).trim().toLowerCase(), i));
		const mine = rank.has(String(word).trim().toLowerCase())
			? rank.get(String(word).trim().toLowerCase()) : Infinity;
		for (let i = 0; i < groups.length; i++) {
			const text = groupText(groups[i]).toLowerCase();
			const theirs = text && rank.has(text) ? rank.get(text) : Infinity;
			if (theirs > mine) return i;
		}
		return groups.length;
	}

	const sign = direction === 'DESC' ? -1 : 1;
	for (let i = 0; i < groups.length; i++) {
		const text = groupText(groups[i]);
		if (!text) return i;               /* the no-value group is last in both directions */
		if (collator.compare(text, word) * sign > 0) return i;
	}
	return groups.length;
}

/*
 * `BasesEntryGroup` and `StringValue` are both exported by the `obsidian`
 * module, so the group is a real one rather than an object shaped like one —
 * which matters because OOF Declared Order calls `hasKey()` on it and Obsidian
 * calls `key.renderTo()` to draw the heading.
 */
function makePhantomGroup(word) {
	if (!BasesEntryGroup || !StringValue) return null;
	const group = new BasesEntryGroup([], new StringValue(String(word)));
	group[PHANTOM] = true;
	return group;
}

function isPhantom(group) {
	return !!(group && group[PHANTOM]);
}

function displayName(view, prop) {
	try {
		if (view.config && view.config.getDisplayName) return view.config.getDisplayName(prop);
	} catch (e) { /* fall through */ }
	return propName(prop);
}

function displayValue(v) {
	if (v === null || v === undefined || v === '') return 'empty';
	if (Array.isArray(v)) return v.join(', ');
	return String(v);
}

function describeChanges(view, changes) {
	return changes
		.map((c) => `${displayName(view, c.prop)} → ${isFolderKey(c.prop)
			? (c.value || 'the vault root') : displayValue(c.value)}`)
		.join(' · ');
}

/* --------------------------------------------------------------- the writing */

/*
 * One drop is ONE transaction. Obsidian's own `updateProperty` opens a
 * transaction per property, so three calls would cost three Ctrl+Z; this
 * reproduces its body inside a single one. The shape of what is pushed matters:
 * `undoTransaction` restores by `Object.assign(fm, change.start)` after checking
 * `JSON.stringify(fm) === JSON.stringify(change.end)`, so `start` must be a
 * snapshot taken before the edit and `end` must be the live object.
 */
async function applyChanges(view, file, changes) {
	if (!changes.length) return;

	/*
	 * A folder change is not frontmatter and cannot go in the transaction, so it
	 * is done separately and AFTER it — if the move fails (a name already taken in
	 * the target folder), the property edit still stands and is still undoable,
	 * which is the better half to keep.
	 *
	 * The file's NAME is never part of this: the new path is the target folder
	 * plus the name it already has.
	 */
	const folderChange = changes.find((c) => isFolderKey(c.prop));
	const props = changes.filter((c) => !isFolderKey(c.prop));

	if (props.length) await writeFrontmatter(view, file, props);
	if (folderChange) await moveToFolder(view.app, file, folderChange.value);
}

/*
 * The vault sits in Dropbox, which holds a brief lock on a file it is syncing —
 * so a move can come back EBUSY through no fault of the drop. Three tries with a
 * short backoff clears it in practice; the same escalation the git work here
 * needs. A collision is NOT retried: that one will never resolve itself.
 */
async function moveToFolder(app, file, folder) {
	const target = folder ? `${folder}/${file.name}` : file.name;
	if (target === file.path) return;
	if (app.vault.getAbstractFileByPath(target)) {
		throw new Error(`${file.name} already exists in ${folder || 'the vault root'}`);
	}
	let wait = 120;
	for (let attempt = 1; ; attempt++) {
		try {
			await app.fileManager.renameFile(file, target);
			return;
		} catch (e) {
			const busy = /EBUSY|EPERM|locked/i.test(e && e.message ? e.message : '');
			if (!busy || attempt >= 3) throw e;
			await new Promise((r) => window.setTimeout(r, wait));
			wait *= 2;
		}
	}
}

async function writeFrontmatter(view, file, changes) {
	await view.createTransaction(async (record) => {
		await view.app.fileManager.processFrontMatter(file, (fm) => {
			record.push({ file, start: JSON.parse(JSON.stringify(fm)), end: fm });
			for (const c of changes) {
				const key = resolveKey(fm, propName(c.prop));
				if (!Object.prototype.hasOwnProperty.call(fm, key) && c.value === null) continue;
				fm[key] = c.value;
			}
		});
	});
}

/* Frontmatter keys are matched case-insensitively, the way Obsidian does. */
function resolveKey(fm, name) {
	if (Object.prototype.hasOwnProperty.call(fm, name)) return name;
	const lower = name.toLowerCase();
	for (const k of Object.keys(fm)) if (k.toLowerCase() === lower) return k;
	return name;
}

/* ---------------------------------------------------------------- the review */

/*
 * "They should also be allowed to only accept certain changes in the move but
 * not others." Unticking one is allowed to make the note land somewhere other
 * than where it was dropped, and the dialog says so rather than pretending
 * otherwise.
 */
class ReviewModal extends Modal {
	constructor(app, view, file, changes, onApply) {
		super(app);
		this.view = view;
		this.file = file;
		this.changes = changes.map((c) => ({ ...c, accepted: true }));
		this.onApply = onApply;
	}

	onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText('Move ' + this.file.basename);
		contentEl.addClass('bases-dnd-review');

		for (const c of this.changes) {
			new Setting(contentEl)
				.setName(displayName(this.view, c.prop))
				.setDesc(`${displayValue(currentValue(this.view, this.file, c.prop))} → ${displayValue(c.value)}`)
				.addToggle((t) => t.setValue(true).onChange((v) => { c.accepted = v; this.refreshNote(); }));
		}

		this.noteEl = contentEl.createDiv({ cls: 'bases-dnd-review-note' });
		this.refreshNote();

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText('Move').setCta().onClick(() => {
				const accepted = this.changes.filter((c) => c.accepted).map(({ prop, value }) => ({ prop, value }));
				this.close();
				this.onApply(accepted);
			}));
	}

	refreshNote() {
		const dropped = this.changes.filter((c) => !c.accepted).length;
		this.noteEl.setText(dropped
			? 'With some changes left out, the note lands wherever the remaining ones put it — not where you dropped it.'
			: '');
	}

	onClose() { this.contentEl.empty(); }
}

function currentValue(view, file, prop) {
	const cache = view.app.metadataCache.getFileCache(file);
	const fm = cache && cache.frontmatter;
	if (!fm) return null;
	return fm[resolveKey(fm, propName(prop))];
}

/* ------------------------------------------------------------- the new note */

/*
 * The base's own `+ new` button, taken over. From his note
 * `dealing with `+ new` button in bases.md`, whose numbered list is the design:
 *
 *   1. the note is created in the base, with the base's template
 *   2. a window offers to change the name Templater gave it
 *   3. clicking out of that window arms the placement, which "will look exactly
 *      like as if they had grabbed the file, except instead of releasing to
 *      drop, they simply click where they want to drop"
 *
 * "The button should bring up no menu" is the other half of the specification,
 * and it is the half that shapes the code. Nothing is asked before the note
 * exists — so there is no draft to reason about, no dialog to read, and the
 * placement is the ordinary drag walk over an ordinary row. Step 3 is
 * `DragLayer.beginPlacement`, and it drives the very same `onDrop` a drag does,
 * from mousemove and click instead of dragover and drop.
 *
 * Why the button needs taking over at all
 *   Obsidian derives a new note's properties from the base's filters, but it
 *   understands a fixed list of filter shapes — `note.x == v`, `.isEmpty()`,
 *   `startsWith`/`contains`/…, `file.hasTag`, `file.inFolder`, `file.folder ==`,
 *   `file.hasProperty` — and skips negated rules outright. `file.isA("Improvement")`
 *   matches none of them and is dropped in silence, so a note made in a class
 *   base is born carrying no `is a` at all and is filtered straight out of the
 *   base it was made in. Obsidian even ships the message for that. Its
 *   `newItemTemplate` would fix it, except that it copies a template's
 *   frontmatter and nothing else: no body, and no Templater, so a class
 *   template's unique-file-name block never runs and step 2 has no name to
 *   offer. `pourTemplate` is that missing half.
 *
 * The three switches are his: hide the button entirely, ask for the name, ask
 * for the position. With both prompts off the button still gets the template,
 * which is the part that is a defect rather than a preference.
 */

/*
 * The frontmatter a file actually has on disk, which after a pour is the
 * template's own values with its Templater expressions already evaluated.
 *
 * Read from the file rather than from the template's cache entry, because a
 * template's `created:` is `<% tp.date.now(...) %>` in the cache and a real date
 * in the note. Restoring the cached text would write the expression back as a
 * literal.
 */
async function frontmatterOf(app, file) {
	try {
		const raw = await app.vault.read(file);
		const info = getFrontMatterInfo(raw);
		if (!info || !info.frontmatter) return null;
		const parsed = parseYaml(info.frontmatter);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (e) {
		return null;
	}
}

/*
 * The name inside a wikilink, or the text as written.
 *
 * `type of` may hold `"[[Effort]]"` or a bare `Effort`; both name the same class,
 * and an alias after a pipe is a display name rather than a name.
 */
function linkName(value) {
	const text = String(value === null || value === undefined ? '' : value).trim();
	const m = /^\[\[([^\]]+)\]\]$/.exec(text);
	const inner = m ? m[1] : text;
	const bar = inner.indexOf('|');
	return (bar === -1 ? inner : inner.slice(0, bar)).trim();
}

/* Nothing there to lose: null, undefined, '' or an empty list. */
function isBlank(v) {
	if (v === null || v === undefined || v === '') return true;
	return Array.isArray(v) && v.length === 0;
}

/*
 * The template's BODY, poured into the file the instant it exists.
 *
 * `write_template_to_file` parses the template — running its commands,
 * `tp.file.rename` included, which is where step 2's "automatic name assigned by
 * Templater" comes from — then merges its frontmatter into the file's and
 * appends its body.
 *
 * It has to happen BEFORE Obsidian writes the frontmatter, not after. Templater
 * merges a list-valued property by concatenating, so a template key left empty
 * would append a null to a list already there; pouring first leaves Obsidian's
 * `processFrontMatter` — plain assignment — with the last word.
 *
 * Templater's own folder trigger stands aside while this runs: it waits 300ms
 * and then skips any file with a pending Templater task, which this registers
 * synchronously. Where it does still fire afterwards it finds a body that is no
 * longer empty, so it re-runs commands rather than applying a second template.
 */
async function pourTemplate(app, template, file) {
	const tp = app.plugins && app.plugins.plugins['templater-obsidian'];
	const templater = tp && tp.templater;
	if (templater && typeof templater.write_template_to_file === 'function') {
		await templater.write_template_to_file(template, file);
		return;
	}
	/* No Templater: the body verbatim. Obsidian is already copying the properties. */
	const raw = await app.vault.read(template);
	const info = getFrontMatterInfo(raw);
	const body = raw.slice(info.contentStart);
	if (body.trim()) await app.vault.process(file, (c) => c + body);
}

/*
 * The name of a note that already exists.
 *
 * Only ever shown when Obsidian's own rename popover could not be built, which is
 * every base drawn as an embed. It offers exactly what the popover offers - the
 * name, selected - and renames through `fileManager`, so links are rewritten.
 */
class RenameNoteModal extends Modal {
	constructor(app, file, onDone) {
		super(app);
		this.file = file;
		this.onDone = onDone;
		this.done = false;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('bases-dnd-rename');
		contentEl.createEl('h3', { text: 'Name the new note' });

		const input = contentEl.createEl('input', { attr: { type: 'text' } });
		input.value = this.file.basename;
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') { event.preventDefault(); this.commit(input.value); }
			if (event.key === 'Escape') { event.preventDefault(); this.close(); }
		});

		const row = contentEl.createDiv({ cls: 'modal-button-container' });
		const ok = row.createEl('button', { cls: 'mod-cta', text: 'Rename' });
		ok.addEventListener('click', () => this.commit(input.value));
		const keep = row.createEl('button', { text: 'Keep this name' });
		keep.addEventListener('click', () => this.close());

		window.setTimeout(() => { input.focus(); input.select(); }, 0);
	}

	async commit(value) {
		const clean = String(value || '').trim();
		this.done = true;
		if (clean && clean !== this.file.basename) {
			const folder = this.file.parent && this.file.parent.path !== '/'
				? this.file.parent.path + '/' : '';
			try {
				await this.app.fileManager.renameFile(this.file, folder + clean + '.md');
			} catch (e) {
				console.error(TAG, e);
				new Notice('Could not rename to ' + clean + '.');
			}
		}
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		/* Placement is armed however the name was settled - his "once the user
		 * clicks out of that window". */
		if (this.onDone) this.onDone();
	}
}

/* ------------------------------------------------------------- the drag layer */

/*
 * One of these per base view. Owns the grip, the insertion bar, and the drop
 * handling for that view's groups.
 */
class DragLayer {
	constructor(plugin, view, type) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.view = view;
		this.type = type;
		this.layout = LAYOUTS[type];
		this.domains = plugin.domains;
		this.plan = null;
		this.gripEntry = null;
		this.disposers = [];

		if (!this.root) return;

		/*
		 * `.mod-row` and `.mod-col` are Obsidian's own two insertion bars, and they
		 * are exactly symmetric — one bleeds its `::after` vertically out of a
		 * zero-height box, the other horizontally out of a zero-width one. So a
		 * grid gets the app's vertical bar for free, in both themes, the same way
		 * a list gets its horizontal one.
		 */
		this.indicatorEl = createDiv('table-drag-target bases-dnd-indicator '
			+ (this.layout.horizontal ? 'mod-col' : 'mod-row'));
		this.indicatorEl.hide();

		if (this.needsGrip()) this.installGrip();
		this.installDataHook();
		/* A view that already had its data when the plugin was enabled. */
		if (this.view.data) this.refreshGroups();
	}

	/*
	 * Read live, never cached. The first version held the element from the
	 * constructor and the grip silently ended up detached — measuring 0×0 with a
	 * null offsetParent — because a base view rebuilds its own DOM underneath a
	 * long-lived view object. Anything of mine parented into it has to be treated
	 * as something the app may throw away at any moment.
	 */
	get root() {
		return this.view.scrollEl || this.view.containerEl || null;
	}

	/*
	 * So: mount on use rather than on construction, and make it idempotent. Same
	 * discipline as the row grip — assume the app owns the tree and re-assert
	 * ourselves into it, instead of assuming a child stays where it was put.
	 */
	mount(el) {
		const root = this.root;
		if (!root) return false;
		if (el.parentElement !== root) root.appendChild(el);
		return true;
	}

	needsGrip() {
		/* Cards already carry a drag payload of their own. */
		return this.type !== 'cards';
	}

	on(el, ev, fn, opts) {
		el.addEventListener(ev, fn, opts);
		this.disposers.push(() => el.removeEventListener(ev, fn, opts));
	}


	/* --- the empty groups ----------------------------------------------- */

	/*
	 * `data` is a brand new object on every query run and `onDataUpdated` is the
	 * one call that follows it — so this is the hook, and it is installed on the
	 * view INSTANCE rather than on a prototype. Two reasons. The prototype getter
	 * for `groupedData` already has OOF Declared Order on it, and two plugins
	 * restoring one descriptor in the wrong order would reinstate a getter that
	 * had unloaded. And a per-view hook is removed by `delete`, which cannot
	 * outlive the view the way a prototype patch can.
	 */
	installDataHook() {
		const view = this.view;
		const original = view.onDataUpdated;
		if (typeof original !== 'function') return;
		/*
		 * The guard is our own flag, and it started life as `hasOwnProperty` — which
		 * looked like the same thing and was not. OOF Declared Order wraps this very
		 * method on this very object, for the very same reason (it is the moment a
		 * view's data exists), so the slot was already an own property and this hook
		 * silently declined to install: the empty groups appeared and nothing ever
		 * marked them. Sibling plugins meet at the same seams — that is the third
		 * time now — so a hook has to stack on whatever is there and ask only
		 * whether IT is already in.
		 */
		if (view.oofDragDropHooked) return;
		view.oofDragDropHooked = true;
		const had = Object.getOwnPropertyDescriptor(view, 'onDataUpdated');
		const layer = this;
		view.onDataUpdated = function (...args) {
			if (!layer.dead) {
				try { layer.syncPhantoms(); } catch (e) { console.error(TAG, e); }
			}
			const out = original.apply(this, args);
			if (!layer.dead) {
				try { layer.markPhantoms(); } catch (e) { console.error(TAG, e); }
			}
			return out;
		};
		const mine = view.onDataUpdated;
		this.disposers.push(() => {
			delete view.oofDragDropHooked;
			/*
			 * Only if the slot is still ours. Someone else stacking on top owns it
			 * now, and putting back what was there before would delete their hook as
			 * well as ours; the `dead` checks above already make ours inert.
			 */
			if (view.onDataUpdated !== mine) return;
			if (had) Object.defineProperty(view, 'onDataUpdated', had);
			else delete view.onDataUpdated;
		});
	}

	/*
	 * Add the missing groups to the array the view is about to read, or take them
	 * out again when the setting is off. Returns whether anything changed.
	 *
	 * Reading `groupedData` is what computes and caches it, and — with OOF
	 * Declared Order installed — also what folds its marker in, so the direction
	 * asked for below is the real one. The identity check is the guard that
	 * matters: pushing into the cache only reaches the view because the getter
	 * hands the cache itself back. Anything that returns a copy instead gets left
	 * alone rather than silently ignored.
	 */
	syncPhantoms() {
		const view = this.view;
		const data = view.data;
		if (!data || !view.config) return false;

		let groups;
		try { groups = data.groupedData; } catch (e) { return false; }
		if (!Array.isArray(groups) || groups !== data.groupedDataCache) return false;

		/*
		 * Rebuilt rather than topped up, and the array is emptied in place so the
		 * identity the getter cached survives. A phantom is only ever a consequence
		 * of what the characteristic declares; one whose word has since left
		 * `possible values` — or that a real group has appeared for — has to go, and
		 * the only way to be sure of that is to take them all out and ask again.
		 */
		const real = groups.filter((g) => !isPhantom(g));
		const withdrew = real.length !== groups.length;
		if (withdrew) { groups.length = 0; groups.push(...real); }

		if (!this.plugin.settings.emptyGroups) return withdrew;

		const groupBy = view.config.groupBy;
		const domain = groupBy ? this.domains.forProperty(groupBy.property) : null;
		const words = (domain && domain.words) || [];
		let added = false;
		for (const word of missingGroupValues(view, this.domains)) {
			const group = makePhantomGroup(word);
			if (!group) break;              /* an Obsidian without the two exports */
			groups.splice(phantomIndex(groups, word, groupBy.direction, words), 0, group);
			added = true;
		}
		return withdrew || added;
	}

	/*
	 * Name the empty groups in the DOM, after the view has drawn them. The table
	 * builds a fresh heading element on every render, so this cannot be done once
	 * — and the re-measure is not optional either: a group's height is read off
	 * the DOM in `updateVirtualDisplay`, which has already run by the time our
	 * class lands, so without a second pass every group below an empty one sits
	 * a few pixels wrong.
	 */
	markPhantoms() {
		const view = this.view;
		const groups = (view.data && view.data.groupedData) || [];
		const rendered = view.groups || [];
		let changed = false;
		for (let i = 0; i < rendered.length; i++) {
			const phantom = isPhantom(groups[i]);
			const el = this.layout.groupEl(rendered[i]);
			if (el && el.hasClass('bases-dnd-empty') !== phantom) {
				el.toggleClass('bases-dnd-empty', phantom);
				changed = true;
			}
			const head = this.layout.headingEl(rendered[i]);
			if (head && head.hasClass('bases-dnd-empty-heading') !== phantom) {
				head.toggleClass('bases-dnd-empty-heading', phantom);
				changed = true;
			}
		}
		if (changed && typeof view.updateVirtualDisplay === 'function') view.updateVirtualDisplay();
	}

	/* Enabling the plugin, or changing the setting, on a view that already has data. */
	refreshGroups() {
		if (this.dead) return;
		if (!this.syncPhantoms()) { this.markPhantoms(); return; }
		try { this.view.onDataUpdated(); } catch (e) { console.error(TAG, e); }
	}

	/*
	 * Taking them out again. Disabling the plugin has to leave the base exactly as
	 * Obsidian would have drawn it: a heading nothing can be dropped into is worse
	 * than no heading at all. Called only once the hook has been removed, or it
	 * would put them straight back.
	 */
	removePhantoms() {
		const data = this.view.data;
		const cache = data && data.groupedDataCache;
		if (!Array.isArray(cache) || !cache.some(isPhantom)) return;
		data.groupedDataCache = cache.filter((g) => !isPhantom(g));
		try { this.view.onDataUpdated(); } catch (e) { /* going away anyway */ }
	}

	/*
	 * An empty group is drawn faintly, because most of the time it is a row of
	 * furniture rather than content. While a drag is in flight it is a target, so
	 * it comes up to full strength — which is the whole reason it is there.
	 */
	setDragging(on) {
		const root = this.root;
		if (root) root.toggleClass('bases-dnd-dragging', !!on);
	}

	/* --- the grip ------------------------------------------------------- */

	/*
	 * ONE floating grip, not one per row. A row element's children are replaced
	 * wholesale by `virtualize()` on every scroll, so anything parented to a row
	 * disappears; and a grip per row would also mean a listener per recycled
	 * object. This one follows the pointer instead.
	 */
	installGrip() {
		/*
		 * Created detached and mounted on use. The dragstart listener is on our own
		 * element, so it survives whatever the app does to the tree around it; the
		 * pointer tracking lives on the plugin, at document level, for the same
		 * reason — a listener bound to a element the view may replace is a
		 * listener that stops firing without ever telling you.
		 */
		this.gripEl = createDiv('bases-dnd-grip');
		this.gripEl.draggable = true;
		this.gripEl.hide();
		this.gripEl.setAttribute('aria-label', 'Drag to move');
		this.on(this.gripEl, 'dragstart', (evt) => this.onGripDragStart(evt));
	}

	hideGrip() {
		if (this.gripEl) this.gripEl.hide();
	}

	positionGrip(evt) {
		if (this.dead || !this.gripEl) return;
		/*
		 * The grip is the ONLY way to start a drag from a table or list row, so it
		 * must survive *Drop between rows* being switched off — otherwise the
		 * off-switch takes group drops down with it and turns the feature off
		 * entirely rather than reducing it, which is the opposite of an escape
		 * hatch.
		 */
		const canDrag = this.plugin.settings.rowDrops || this.plugin.settings.groupDrops;
		if (!this.plugin.settings.showGrip || !canDrag) {
			this.gripEl.hide();
			return;
		}
		if (this.app.dragManager.draggable) return;      /* a drag is in flight */
		const root = this.root;
		const target = evt.target instanceof Element ? evt.target : null;

		/*
		 * The grip lies ON TOP of the row it belongs to, so the moment the pointer
		 * reaches it the event target is the grip — which is a child of the
		 * container, not of any row. Recomputing from that target finds no row and
		 * hides the grip; the pointer is then over the row again, so it reappears,
		 * and so on. That loop is what made the cursor flicker and made the grip
		 * impossible to grab: it vanished under the press.
		 *
		 * So while the pointer is on the grip, leave it exactly where it is.
		 */
		if (target && this.gripEl.contains(target)) return;

		const itemEl = target ? target.closest(this.layout.itemSel) : null;
		if (!root || !itemEl || !root.contains(itemEl)) { this.gripEl.hide(); return; }

		const found = this.entryForElement(itemEl);
		if (!found) { this.gripEl.hide(); return; }
		if (!this.mount(this.gripEl)) return;

		const rootRect = root.getBoundingClientRect();
		const rect = itemEl.getBoundingClientRect();
		this.gripEntry = found.entry;
		this.gripEl.show();
		this.gripEl.setCssStyles({
			top: `${rect.top - rootRect.top + root.scrollTop}px`,
			height: `${rect.height}px`,
			insetInlineStart: `${rect.left - rootRect.left + root.scrollLeft}px`,
		});
	}

	onGripDragStart(evt) {
		this.clearLanded();
		const entry = this.gripEntry;
		if (!entry || !entry.file) { evt.preventDefault(); return; }

		const payload = this.app.dragManager.dragLink(evt, entry.file.path, '', entry.file.basename);
		this.app.dragManager.onDragStart(evt, payload);
	}

	/* --- the drop ------------------------------------------------------- */

	onDrop(evt, draggable, isPreview) {
		if (this.dead) return null;
		const result = this.resolve(evt, draggable);
		if (!result) { this.hideIndicator(); return null; }

		const { plan, groupEl } = result;

		/*
		 * A drop this base cannot make. Claiming the event anyway — with a
		 * dropEffect of none and the reason as the label — is the point rather
		 * than an oversight: his note asks the highlighting to "explain to the
		 * user where they can and cannot put the file", and a reason read while
		 * the mouse is still down is worth more than a notice after the fact.
		 */
		if (plan.refuse) {
			this.hideIndicator();
			/*
			 * `hideIndicator` clears the option marks too — which over empty space
			 * wipes exactly the thing worth looking at. Hovering nothing in
			 * particular is the moment you most want to be shown every place the
			 * note could go, and a note that is already at the end of its group made
			 * the whole pane answer "Already there — nothing to change." with no
			 * marks at all. The spot under the pointer is unusable; the group's
			 * other places are not, so they are drawn.
			 */
			if (plan.emptySpace && plan.groupIdx !== undefined && this.plugin.settings.showOptions) {
				this.showOptions(plan, draggable);
			}
			return {
				action: this.plugin.settings.showChanges ? this.refusalLabel(plan) : null,
				dropEffect: 'none',
			};
		}

		if (!isPreview) {
			this.hideIndicator();
			this.commit(plan, result.file);
			return { action: null, dropEffect: 'move' };
		}

		if (plan.kind === 'row' && this.plugin.settings.showIndicator) {
			if (this.plugin.settings.showOptions) this.showOptions(plan, draggable);
			this.showIndicator(plan);
		} else {
			this.hideIndicator();
		}

		return {
			action: this.plugin.settings.showChanges ? this.label(plan) : null,
			dropEffect: 'move',
			hoverEl: plan.kind === 'group' ? groupEl : null,
			hoverClass: 'bases-dnd-over',
		};
	}

	/*
	 * "Already there — nothing to change." is true of the spot under the pointer
	 * and unhelpful as the answer to the whole empty pane, which is not aimed at
	 * any one spot. Where the marks are up, the label points at them.
	 */
	refusalLabel(plan) {
		if (plan.emptySpace && plan.why === 'Already there — nothing to change.') {
			return this.plugin.settings.showOptions
				? 'Already at the end — the marks show where else it can go.'
				: 'Already at the end of this group.';
		}
		return plan.why;
	}

	label(plan) {
		const text = describeChanges(this.view, plan.changes);
		return plan.note ? `${text} · ${plan.note}` : text;
	}

	/*
	 * Turn a pointer position into a plan, or null when this drop means nothing
	 * here. Everything is resolved from the element under the pointer — which is
	 * by definition one that is rendered — never from the virtualised arrays.
	 */
	resolve(evt, draggable) {
		const view = this.view;
		if (!view.data || !view.data.groupedData || !view.config) return null;

		const file = draggable && draggable.file;
		if (!file) return null;

		const entry = this.entryForFile(file);
		if (!entry) return null;      /* dragged in from outside this base */

		let target = evt.target instanceof Element ? evt.target : null;
		if (!target) return null;

		/*
		 * Our own furniture can be the element under the pointer — the grip
		 * especially, since it lies on a row and the drag begins from it. Resolving
		 * from it found no row and killed the whole drop.
		 *
		 * The first fix was `pointer-events: none` while dragging, and it was worse:
		 * the class only came off in a `dragend` handler, so one drag that ended
		 * without one left the grip permanently unpressable. **A fix that depends on
		 * cleanup can fail closed.** Hit-testing the rendered rows by rectangle
		 * cannot get stuck, because it holds no state at all.
		 */
		if (this.isOwnFurniture(target)) target = this.itemAtPoint(evt) || target;

		let groupEl = target.closest(this.layout.groupSel);
		let groupIdx = groupEl ? this.groupIndexOf(groupEl) : null;
		/* Set when the group was found by its heading's band rather than an element. */
		let headingBand = false;
		/*
		 * The empty pane below everything. There is no group element under the
		 * pointer there, and returning null meant the one large, obvious place to
		 * aim at gave no feedback at all.
		 *
		 * Only where there is exactly ONE group. In an ungrouped view that space is
		 * the tail of the only group there is, and aiming at it is unambiguous. In a
		 * grouped view it belongs to no group, and picking the nearest silently
		 * meant "move this note into whichever group happens to be last" — a
		 * regroup nobody asked for, and the thing he reported. Below the last group
		 * of a grouped view there is genuinely nothing to point at, so nothing is
		 * what it says.
		 */
		/*
		 * A heading that lives OUTSIDE its group's element. The table and the list
		 * parent the heading inside the group, so `closest(groupSel)` finds it from
		 * there; the cards view makes it a SIBLING, placed before the container. So
		 * on a cards heading there was no group, no plan and no feedback — and
		 * dropping on the heading is the one gesture his N.B. reserved for
		 * "regroup without choosing a position".
		 */
		if (groupIdx === null) {
			const headEl = target.closest('.bases-group-heading');
			if (headEl) {
				groupIdx = this.groupIndexOfHeading(headEl);
				if (groupIdx !== null) groupEl = this.layout.groupEl(this.view.groups[groupIdx]);
			}
		}
		/*
		 * Still nothing, and this is the one that mattered. A cards heading is only
		 * as WIDE AS ITS TEXT — 91px for `[[Air Monitor]]` — so the rest of that
		 * horizontal strip is bare `.bases-cards-container` belonging to no group
		 * and no heading. Recording a real drag of his over 823 pointer positions
		 * found 117 of them dead for exactly this reason, all at the y of a
		 * heading.
		 *
		 * And dead there is worse than it sounds: with no plan we never call
		 * `preventDefault` on the dragover, so the browser fires **no drop event at
		 * all**. Releasing did not "do nothing" figuratively — nothing was
		 * dispatched.
		 *
		 * So a group owns the whole horizontal BAND of its heading and of its body,
		 * not merely the boxes that happen to be painted there.
		 */
		if (groupIdx === null) {
			const band = this.bandAtPoint(evt);
			if (band) {
				groupIdx = band.groupIdx;
				groupEl = this.layout.groupEl(this.view.groups[groupIdx]);
				if (band.onHeading) headingBand = true;
			}
		}
		if (groupIdx === null) {
			const groups = this.view.groups || [];
			if (groups.length !== 1) return null;
			groupEl = this.layout.groupEl(groups[0]);
			if (!groupEl) return null;
			groupIdx = 0;
		}

		const ctx = { view, entry, domains: this.domains };
		const onHeading = headingBand || !!target.closest('.bases-group-heading');
		const itemEl = onHeading ? null : target.closest(this.layout.itemSel);

		let plan;
		let emptySpace = false;
		if (onHeading || !this.plugin.settings.rowDrops) {
			if (!this.plugin.settings.groupDrops) return null;
			plan = planGroupDrop(ctx, groupIdx);
		} else if (!itemEl) {
			/*
			 * No item under the pointer. That is not one situation but two, and
			 * treating them alike sent every one of them to the end of the group:
			 *
			 *   - the GUTTER between two cards, or the gap between two rows, which
			 *     is a perfectly ordinary place and belongs to the cards beside it
			 *   - the open pane past the last card, which really does mean the end
			 *
			 * Both are answered by the same question: which rendered item is
			 * nearest, and which side of it is the pointer on. In a gutter that is
			 * the card beside it; past the last card it is the last card, from
			 * below, which is the end. So the end is a consequence rather than a
			 * special case.
			 *
			 * It used to fall into the group branch instead, which on an ungrouped
			 * view could only answer "This view is not grouped." — a refusal over
			 * the largest target on the screen. His N.B. gave the HEADING to
			 * "regroup without choosing a position", so the empty space was never
			 * the thing that had to carry that meaning.
			 */
			const near = this.nearestSpot(evt, groupIdx, entry);
			plan = near
				? planRowDrop(ctx, groupIdx, near.gap, near.bias)
				: planRowDrop(ctx, groupIdx, Number.MAX_SAFE_INTEGER, 1);
			/* A grouped view with nothing writable to sort by can still regroup. */
			if (!plan.ok && this.plugin.settings.groupDrops) {
				const regroup = planGroupDrop(ctx, groupIdx);
				if (regroup.ok) plan = regroup;
			}
			emptySpace = true;
		} else {
			const spot = this.gapFor(itemEl, evt, groupIdx, entry);
			if (!spot) return null;
			plan = planRowDrop(ctx, groupIdx, spot.gap, spot.bias);
		}

		if (!plan.ok) {
			/*
			 * `groupIdx` rides along even on a refusal, because the marks for the
			 * whole group can still be drawn when the one spot under the pointer
			 * cannot be used.
			 */
			return { plan: { ...plan, refuse: true, groupIdx, emptySpace }, groupEl, file };
		}
		return { plan, groupEl, file };
	}

	/*
	 * Which gap the pointer is in, and how far through the hovered row it sits —
	 * the bias is what decides which side to tie to when the gap itself has no
	 * room.
	 */
	gapFor(itemEl, evt, groupIdx, dragged) {
		const found = this.entryForElement(itemEl);
		if (!found) return null;
		const all = this.view.data.groupedData[groupIdx].entries;
		const rect = itemEl.getBoundingClientRect();
		const bias = this.layout.horizontal
			? (evt.clientX - rect.left) / Math.max(1, rect.width)
			: (evt.clientY - rect.top) / Math.max(1, rect.height);
		return gapAt(all, found.entry, dragged, bias);
	}

	/*
	 * The gap nearest the pointer when it is over no item at all — the gutter
	 * between two cards, the space between two rows, or the open pane past the
	 * last of them.
	 *
	 * Distance is measured to the item's RECTANGLE rather than to its centre, so
	 * a pointer level with a card but 200px to its right is "just outside that
	 * card" and not "closer to the one diagonally below". Which side it falls on
	 * is read from the axis the layout actually flows along, except when the
	 * pointer is clear above or below the item, which settles it on its own.
	 */
	nearestSpot(evt, groupIdx, dragged) {
		const group = this.view.data && this.view.data.groupedData[groupIdx];
		if (!group || !group.entries.length) return null;
		const inGroup = new Set(group.entries);

		let best = null;
		let bestDist = Infinity;
		for (const item of this.layout.items(this.view)) {
			if (!item || !item.el || !item.entry || !inGroup.has(item.entry)) continue;
			if (!item.el.isShown()) continue;
			const r = item.el.getBoundingClientRect();
			const dx = Math.max(r.left - evt.clientX, 0, evt.clientX - r.right);
			const dy = Math.max(r.top - evt.clientY, 0, evt.clientY - r.bottom);
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d < bestDist) { bestDist = d; best = { item, rect: r }; }
		}
		if (!best) return null;

		const r = best.rect;
		let bias;
		if (evt.clientY > r.bottom) bias = 1;
		else if (evt.clientY < r.top) bias = 0;
		else if (this.layout.horizontal) bias = (evt.clientX - r.left) / Math.max(1, r.width);
		else bias = (evt.clientY - r.top) / Math.max(1, r.height);
		bias = Math.max(0, Math.min(1, bias));

		return gapAt(group.entries, best.item.entry, dragged, bias);
	}

	isOwnFurniture(el) {
		if (this.gripEl && this.gripEl.contains(el)) return true;
		if (this.indicatorEl && this.indicatorEl.contains(el)) return true;
		return (this.optionEls || []).some((o) => o.contains(el));
	}

	/* The rendered row whose rectangle holds the pointer, found without the DOM. */
	itemAtPoint(evt) {
		for (const item of this.layout.items(this.view)) {
			if (!item || !item.el || !item.el.isShown()) continue;
			const r = item.el.getBoundingClientRect();
			if (evt.clientX >= r.left && evt.clientX <= r.right
				&& evt.clientY >= r.top && evt.clientY <= r.bottom) return item.el;
		}
		return null;
	}

	/*
	 * The group whose horizontal band the pointer is in, and whether it is level
	 * with that group's heading.
	 *
	 * Bands rather than boxes because a heading is only as wide as its text, so
	 * the strip beside it belongs to nothing — which is precisely where you aim
	 * when you mean "put it in this group". Only the pointer's Y is consulted: at
	 * a given height in a grouped view there is exactly one group, whatever the
	 * horizontal position.
	 */
	bandAtPoint(evt) {
		const groups = this.view.groups || [];
		const y = evt.clientY;
		const spans = [];
		for (let i = 0; i < groups.length; i++) {
			const head = this.layout.headingEl(groups[i]);
			const body = this.layout.groupEl(groups[i]);
			const hr = head && head.isShown() ? head.getBoundingClientRect() : null;
			const br = body && body.isShown() ? body.getBoundingClientRect() : null;
			if (hr && y >= hr.top && y <= hr.bottom) return { groupIdx: i, onHeading: true };
			if (br && y >= br.top && y <= br.bottom) return { groupIdx: i, onHeading: false };
			if (hr || br) spans.push({ i, top: (hr || br).top, bottom: (br || hr).bottom, headBottom: hr ? hr.bottom : null });
		}
		if (!spans.length) return null;

		/*
		 * The few pixels of margin BETWEEN two groups belong to neither box — eight
		 * of them here, and twenty-one of his recorded pointer positions landed in
		 * exactly that seam. They go to the nearer group.
		 *
		 * Only between the first and the last, though: past the end of the last
		 * group there is genuinely nothing to point at, and handing that space to
		 * the nearest group is the v2.2.2 mistake (a silent regroup into whichever
		 * group happened to be closest).
		 */
		if (y < spans[0].top || y > spans[spans.length - 1].bottom) return null;
		let best = null;
		let bestD = Infinity;
		for (const s of spans) {
			const d = y < s.top ? s.top - y : (y > s.bottom ? y - s.bottom : 0);
			if (d < bestD) { bestD = d; best = s; }
		}
		if (!best) return null;
		return { groupIdx: best.i, onHeading: best.headBottom !== null && y <= best.headBottom };
	}

	/* The group a heading belongs to, for layouts that keep the two apart. */
	groupIndexOfHeading(headEl) {
		const groups = this.view.groups || [];
		for (let i = 0; i < groups.length; i++) {
			if (this.layout.headingEl(groups[i]) === headEl) return i;
		}
		return null;
	}

	groupIndexOf(groupEl) {
		const groups = this.view.groups || [];
		for (let i = 0; i < groups.length; i++) {
			if (this.layout.groupEl(groups[i]) === groupEl) return i;
		}
		return null;
	}

	entryForElement(el) {
		for (const item of this.layout.items(this.view)) {
			if (item && item.el === el && item.entry) return item;
		}
		return null;
	}

	entryForFile(file) {
		const all = this.view.data && this.view.data.data;
		if (!all) return null;
		for (const e of all) if (e.file === file) return e;
		return null;
	}

	/* --- the bar -------------------------------------------------------- */

	/*
	 * Drawn at the landing position, which is not always the gap the pointer is
	 * in: when the sort cannot express that gap, the note goes where its values
	 * put it and the bar follows it there. That jump IS the explanation his note
	 * asks for — you can see the constraint instead of being told about it.
	 */
	showIndicator(plan) {
		const group = this.view.groups[plan.groupIdx];
		if (!group) return this.hideIndicator();
		const host = this.layout.itemsEl(group);
		if (!host) return this.hideIndicator();

		/*
		 * A block of rows the sort cannot tell apart has no gap to point at. Say
		 * so by lighting the block rather than by inventing a line inside it.
		 */
		if (plan.landingTo > plan.landing) return this.showZone(plan);
		this.clearZone();

		const before = plan.landing > 0 ? plan.entries[plan.landing - 1] : null;
		const after = plan.landing < plan.entries.length ? plan.entries[plan.landing] : null;

		const beforeEl = before ? this.elementForEntry(before) : null;
		const afterEl = after ? this.elementForEntry(after) : null;

		const root = this.root;
		if (!root || !this.mount(this.indicatorEl)) return this.hideIndicator();

		const rootRect = root.getBoundingClientRect();
		const box = this.boundaryBox(host, rootRect, plan.entries, plan.landing, beforeEl, afterEl);
		if (!box) return this.hideIndicator();

		this.indicatorEl.show();
		this.indicatorEl.toggleClass('is-inexact', !plan.exact);
		this.placeMark(this.indicatorEl, box, root);
	}

	/* One mark, one box. Scroll is added here so no caller has to remember it. */
	placeMark(el, box, root) {
		el.setCssStyles({
			top: `${box.top + root.scrollTop}px`,
			insetInlineStart: `${box.left + root.scrollLeft}px`,
			width: `${box.width}px`,
			height: `${box.height}px`,
		});
	}

	/*
	 * The y of the boundary above `index`, in root coordinates. Resolved from
	 * whichever neighbouring row is actually rendered, so it stays correct under
	 * virtualisation; null when neither is.
	 */
	boundaryBox(host, rootRect, entries, index, beforeEl, afterEl) {
		const after = afterEl !== undefined ? afterEl
			: (index < entries.length ? this.elementForEntry(entries[index]) : null);
		const before = beforeEl !== undefined ? beforeEl
			: (index > 0 ? this.elementForEntry(entries[index - 1]) : null);
		const hostRect = host.getBoundingClientRect();

		if (!this.layout.horizontal) {
			let y = null;
			if (after) y = after.getBoundingClientRect().top;
			else if (before) y = before.getBoundingClientRect().bottom;
			else if (!entries.length || index === 0) y = hostRect.top;
			else if (index >= entries.length) y = hostRect.bottom;
			if (y === null) return null;
			return {
				top: y - rootRect.top,
				left: hostRect.left - rootRect.left,
				width: hostRect.width,
				height: 0,
			};
		}

		/*
		 * A grid. The bar goes in the GUTTER between two cards rather than on a
		 * card's own edge — measured on his vault, cards are 221px wide with an 11px
		 * gap, and a line drawn at a card's left edge lands exactly on its border,
		 * where it reads as that card being highlighted rather than as a place
		 * between two of them.
		 *
		 * Where the two neighbours are on the same visual row there is a real gutter
		 * to centre in. Across a row wrap, or at either end, there is no gutter
		 * between the two, so it steps half a gutter off the card it belongs beside.
		 */
		const GUTTER = 6;
		let box = null;
		let x = null;
		if (after && before) {
			const a = after.getBoundingClientRect();
			const b = before.getBoundingClientRect();
			box = a;
			x = Math.abs(a.top - b.top) < 1 ? (b.right + a.left) / 2 : a.left - GUTTER;
		} else if (after) {
			box = after.getBoundingClientRect();
			x = box.left - GUTTER;
		} else if (before) {
			box = before.getBoundingClientRect();
			x = box.right + GUTTER;
		} else {
			box = hostRect;
			x = index === 0 ? hostRect.left : hostRect.right;
		}
		if (x === null) return null;
		/*
		 * Short of the card's full height. A line running the exact height of the
		 * cards beside it butts against their corners and reads as one of their
		 * borders; pulled in at both ends it reads as a mark standing between them.
		 */
		const INSET = Math.min(12, box.height / 6);
		return {
			top: box.top - rootRect.top + INSET,
			left: x - rootRect.left,
			width: 0,
			height: Math.max(0, box.height - INSET * 2),
		};
	}

	/*
	 * Every place in this group the note could go, drawn faintly and all at once.
	 * His ask: one bar that only exists where the pointer already is says nothing
	 * about where else you may aim.
	 *
	 * Computed once per drag per group — the walk is O(n²) in the group's size and
	 * the answer cannot change while a drag is in flight, since nothing is written
	 * until it ends.
	 */
	showOptions(plan, draggable) {
		const root = this.root;
		const group = this.view.groups[plan.groupIdx];
		if (!root || !group) return this.clearOptions();
		const host = this.layout.itemsEl(group);
		if (!host) return this.clearOptions();

		const key = `${plan.groupIdx}:${draggable && draggable.file && draggable.file.path}`;
		if (!this.options || this.options.key !== key) {
			const entry = this.entryForFile(draggable.file);
			this.options = {
				key,
				list: entry ? rowOptions({ view: this.view, entry, domains: this.domains }, plan.groupIdx) : [],
			};
		}

		const rootRect = root.getBoundingClientRect();
		const hostRect = host.getBoundingClientRect();
		this.optionEls = this.optionEls || [];

		let n = 0;
		for (const option of this.options.list) {
			/* The live one is drawn by the indicator; two marks would just blur it. */
			if (option.landing === plan.landing && option.landingTo === plan.landingTo) continue;
			/*
			 * A block the sort cannot order has no boundary to point at — a line at
			 * its top would claim a precision that is not on offer. It is reachable
			 * by dropping anywhere inside it, and hovering there lights the block,
			 * which is the honest way to show it.
			 */
			if (option.landingTo > option.landing) continue;
			const box = this.boundaryBox(host, rootRect, option.entries, option.landing);
			if (!box) continue;

			let el = this.optionEls[n];
			if (!el) el = this.optionEls[n] = createDiv('bases-dnd-option');
			if (el.parentElement !== root) root.appendChild(el);
			el.toggleClass('is-inexact', !option.settled);
			el.toggleClass('is-vertical', !!this.layout.horizontal);
			el.setAttribute('aria-label', describeChanges(this.view, option.changes));
			el.show();
			this.placeMark(el, box, root);
			n++;
		}
		for (let i = n; i < this.optionEls.length; i++) this.optionEls[i].hide();
	}

	clearOptions() {
		for (const el of this.optionEls || []) el.hide();
	}

	/*
	 * Between drags the cached answer is stale; it is cheap to recompute.
	 *
	 * And the bar has to go. When the option marks arrived in v1.1.0 the plugin's
	 * dragend/drop sweep changed from `hideIndicator()` to `endDrag()`, and this
	 * method never hid the indicator — so every drag left its bar drawn across the
	 * table until the next one. That alone makes the whole feature look broken.
	 */
	endDrag() {
		this.options = null;
		this.setDragging(false);
		this.hideIndicator();
	}

	/* The rows it could land among, lit as one block. */
	showZone(plan) {
		if (this.indicatorEl) this.indicatorEl.hide();
		const wanted = new Set();
		for (let i = plan.landing; i < plan.landingTo; i++) {
			const el = this.elementForEntry(plan.entries[i]);
			if (el) wanted.add(el);
		}
		for (const el of this.zoneEls || []) if (!wanted.has(el)) el.removeClass('bases-dnd-landing');
		for (const el of wanted) el.addClass('bases-dnd-landing');
		this.zoneEls = wanted;
		this.showBrackets(wanted);
	}

	/*
	 * A block is bracketed top and bottom, in the same horizontal vocabulary as
	 * the insertion bar — two dashed rules meaning "anywhere between these",
	 * against one solid rule meaning "exactly here".
	 *
	 * It used to be a 2px accent stripe down the left edge of each lit row, which
	 * on contiguous rows stacked into one continuous VERTICAL line — a different
	 * kind of object entirely from every other mark this plugin draws, and he had
	 * to ask what it meant. A region and a boundary should differ in number and
	 * weight, not in axis.
	 */
	showBrackets(rows) {
		const root = this.root;
		if (!root || !rows.size) return this.clearBrackets();
		const list = [...rows];
		const top = list[0].getBoundingClientRect();
		const bottom = list[list.length - 1].getBoundingClientRect();
		const rootRect = root.getBoundingClientRect();
		this.brackets = this.brackets || [createDiv('bases-dnd-bracket'), createDiv('bases-dnd-bracket')];
		const ys = [top.top, bottom.bottom];
		for (let i = 0; i < 2; i++) {
			const el = this.brackets[i];
			if (el.parentElement !== root) root.appendChild(el);
			el.show();
			el.setCssStyles({
				top: `${ys[i] - rootRect.top + root.scrollTop}px`,
				insetInlineStart: `${top.left - rootRect.left + root.scrollLeft}px`,
				width: `${top.width}px`,
			});
		}
	}

	clearBrackets() {
		for (const el of this.brackets || []) el.hide();
	}

	clearZone() {
		for (const el of this.zoneEls || []) el.removeClass('bases-dnd-landing');
		this.zoneEls = null;
		this.clearBrackets();
	}

	elementForEntry(entry) {
		for (const item of this.layout.items(this.view)) {
			if (item && item.entry === entry && item.el && item.el.isShown()) return item.el;
		}
		return null;
	}

	hideIndicator() {
		if (this.indicatorEl) this.indicatorEl.hide();
		this.clearZone();
		this.clearOptions();
	}

	/* --- committing ------------------------------------------------------ */

	commit(plan, file) {
		const review = this.plugin.settings.reviewEveryMove || this.plugin.modifierHeld;
		const run = (changes) => {
			if (!changes.length) return;
			/* Where it is now — read BEFORE the write, since the re-query replaces it. */
			const origin = this.captureOrigin(file);
			applyChanges(this.view, file, changes)
				.then(() => { if (this.plugin.settings.flashOnDrop) this.flashLanding(file, origin); })
				.catch((e) => {
					console.error('[bases-drag-drop] write failed', e);
					new Notice('Could not write ' + file.basename + ': ' + e.message);
				});
		};
		if (review) new ReviewModal(this.app, this.view, file, plan.changes, run).open();
		else run(plan.changes);
	}

	/*
	 * Light up the row the note ended up in, once it is there.
	 *
	 * The write goes through `createTransaction`, which asks the query controller
	 * to re-run — so the row does not exist yet when the promise resolves, and the
	 * entry object is replaced by the re-query rather than moved. Hence a short
	 * poll for the row belonging to that FILE rather than a wait on any one event:
	 * it makes no assumption about which render arrives, or when.
	 */
	/*
	 * The two rows it sat between, by path. Paths rather than entries because the
	 * re-query builds new entry objects, and rows rather than an index because the
	 * whole grouping may be rebuilt around the change.
	 */
	captureOrigin(file) {
		if (!this.view.data || !this.view.data.groupedData) return null;
		for (const group of this.view.data.groupedData) {
			const i = group.entries.findIndex((e) => e.file === file);
			if (i === -1) continue;
			return {
				above: i > 0 ? group.entries[i - 1].file.path : null,
				below: i + 1 < group.entries.length ? group.entries[i + 1].file.path : null,
			};
		}
		return null;
	}

	elementForPath(path) {
		for (const item of this.layout.items(this.view)) {
			if (item && item.entry && item.entry.file && item.entry.file.path === path
				&& item.el && item.el.isShown()) return item.el;
		}
		return null;
	}

	/*
	 * Both ends of the move, and they STAY until he does something else — his ask,
	 * after the fading version showed the line it left for only a split second.
	 * So there is no animation anywhere in here: the marks are painted, remembered,
	 * and cleared by the next click, the next drag, or the plugin going away.
	 */
	flashLanding(file, origin) {
		this.clearLandedTimer();
		this.landed = { path: file.path, origin };

		/*
		 * Re-assert every FRAME while the base settles, then every 200ms after.
		 *
		 * The 200ms-only version blinked: the marks were painted as soon as the
		 * landed row appeared, the base then finished re-rendering — recycling that
		 * row and detaching the origin line from the container — and nothing put
		 * them back until the next tick, a fifth of a second later and plainly
		 * visible. A frame-by-frame re-assert closes that gap to something the eye
		 * cannot catch; the slow timer is only for the long tail, since the marks
		 * stand until dismissed.
		 */
		const settleUntil = Date.now() + 2000;
		const frame = () => {
			if (this.dead || !this.landed) return;
			if (this.paintLanded()) this.armLandedDismiss();
			if (Date.now() < settleUntil) { window.requestAnimationFrame(frame); return; }
			this.landedTimer = window.setInterval(() => {
				if (this.dead || !this.landed) { this.clearLandedTimer(); return; }
				this.paintLanded();
			}, 200);
		};
		window.requestAnimationFrame(frame);
	}

	/*
	 * Paint from the remembered move. Idempotent and re-callable, because the rows
	 * are recycled: a row element that carried the mark may be handed to a
	 * different note on the next scroll, so the mark has to be re-asserted against
	 * the file rather than left where it was put.
	 */
	paintLanded() {
		const root = this.root;
		if (!root || !this.landed) return false;
		this.watchRoot(root);
		const entry = this.entryForPathInView(this.landed.path);
		const el = entry ? this.elementForEntry(entry) : null;

		for (const other of root.querySelectorAll('.bases-dnd-landed')) {
			if (other !== el) other.removeClass('bases-dnd-landed');
		}
		if (el) el.addClass('bases-dnd-landed');
		this.showOrigin(this.landed.origin);
		return !!el;
	}

	entryForPathInView(path) {
		const all = this.view.data && this.view.data.data;
		if (!all) return null;
		for (const e of all) if (e.file && e.file.path === path) return e;
		return null;
	}

	/* The next click anywhere, or the next drag, takes the marks down. */
	armLandedDismiss() {
		if (this.dismissArmed) return;
		this.dismissArmed = true;
		const off = () => {
			document.removeEventListener('mousedown', off, true);
			document.removeEventListener('keydown', off, true);
			this.dismissArmed = false;
			this.clearLanded();
		};
		document.addEventListener('mousedown', off, true);
		document.addEventListener('keydown', off, true);
	}

	/*
	 * The base wipes `scrollEl`'s children on every re-render — measured: a probe
	 * div appended to `scrollEl` does not survive one, while the same div on
	 * `scrollEl.parentElement` does. That is what detaches the origin line, and why
	 * re-asserting once a frame still blinked: the app's render runs AFTER my
	 * rAF callback, so each frame I re-attached and it removed again before paint.
	 *
	 * A MutationObserver on the root's child list fires as a microtask — after the
	 * removal and *before* the browser paints — so the line is put back within the
	 * same frame and there is nothing to see. The frame loop and the slow timer
	 * stay as backstops for anything that changes without touching these children.
	 *
	 * No loop: `mount()` only appends when the parent is not already the root, so
	 * the steady state produces no mutations of its own.
	 */
	watchRoot(root) {
		if (this.watchedRoot === root) return;
		if (this.rootObserver) this.rootObserver.disconnect();
		this.watchedRoot = root;
		this.rootObserver = new MutationObserver(() => {
			if (this.dead || !this.landed) return;
			this.paintLanded();
		});
		this.rootObserver.observe(root, { childList: true });
	}

	unwatchRoot() {
		if (this.rootObserver) this.rootObserver.disconnect();
		this.rootObserver = null;
		this.watchedRoot = null;
	}

	clearLandedTimer() {
		if (this.landedTimer) { window.clearInterval(this.landedTimer); this.landedTimer = null; }
	}

	clearLanded() {
		this.clearLandedTimer();
		this.unwatchRoot();
		const root = this.root;
		if (root) {
			for (const el of root.querySelectorAll('.bases-dnd-landed')) el.removeClass('bases-dnd-landed');
		}
		if (this.fromEl) this.fromEl.hide();
		this.landed = null;
	}

	/*
	 * The line it left. Drawn where the note used to sit — the boundary between
	 * the two rows that have now closed over it — so a move reads as a journey
	 * rather than as one row lighting up for no visible reason.
	 *
	 * Skipped when neither neighbour is on screen, which includes the case where
	 * it was alone in its group and that group has now gone.
	 */
	showOrigin(origin) {
		const root = this.root;
		if (!root || !origin) return;
		const belowEl = origin.below ? this.elementForPath(origin.below) : null;
		const aboveEl = origin.above ? this.elementForPath(origin.above) : null;
		const ref = belowEl || aboveEl;
		/*
		 * Leave whatever is already drawn. This runs again on every scroll, and a
		 * re-render can momentarily have neither neighbour rendered — hiding on that
		 * erased the line a second or two after the drop and never brought it back,
		 * which is exactly the "seen for only a split second" he reported. A
		 * transient gap in the render is not a reason to take a mark down; only
		 * clearLanded() does that.
		 */
		if (!ref) return;

		const rootRect = root.getBoundingClientRect();
		const rect = ref.getBoundingClientRect();
		/* Same axis as the insertion bar, for the same reason. */
		const box = this.layout.horizontal
			? {
				top: rect.top - rootRect.top,
				left: (belowEl ? rect.left : rect.right) - rootRect.left,
				width: 0,
				height: rect.height,
			}
			: {
				top: (belowEl ? rect.top : rect.bottom) - rootRect.top,
				left: rect.left - rootRect.left,
				width: rect.width,
				height: 0,
			};

		const el = this.fromEl = this.fromEl || createDiv('bases-dnd-from');
		el.toggleClass('is-vertical', !!this.layout.horizontal);
		if (el.parentElement !== root) root.appendChild(el);
		el.show();
		this.placeMark(el, box, root);
	}

	/* --- placing a note that was just made ------------------------------- */

	/*
	 * His step 3: "This will look exactly like as if they had grabbed the file,
	 * except instead of releasing to drop, they simply click where they want to
	 * drop."
	 *
	 * Which is why there is almost nothing here. The mode drives `onDrop` — the
	 * same resolve, the same plan, the same bar, the same option marks, the same
	 * refusals — from mousemove and click instead of dragover and drop. A second
	 * planner for "the same thing but by clicking" would be a second answer to
	 * one question, and the two would drift.
	 *
	 * The one thing a drag gets for free and this does not is the label: during a
	 * drag `dragManager.setAction` draws it beside the ghost, and there is no
	 * ghost here. Hence `placeLabelEl`, which is the only new furniture.
	 */
	/*
	 * Is there anything to place INTO? A view with no writable group-by and no
	 * writable sort key has no order at all — a card's position in it is the order
	 * the query happened to return, which is not something a drop can choose.
	 *
	 * A drag may still be attempted in such a view, and being told "this view has
	 * no sort to write" is the right answer to a gesture somebody made. Arming the
	 * mode there is not: it is offered rather than asked for, and every place the
	 * pointer can reach refuses, so the whole thing is a red tooltip you have to
	 * dismiss. Nothing to place means the note is simply made — which is the
	 * complete outcome anyway.
	 */
	canPlace() {
		return canPlaceIn(this.view, this.domains);
	}

	async beginPlacement(file) {
		if (this.dead) return false;
		/*
		 * The note was created a moment ago and the base re-queries asynchronously,
		 * so the row does not exist yet. Waiting for the ENTRY rather than for a
		 * render event makes no assumption about which render arrives, or when —
		 * the same reasoning `flashLanding` uses after a drop.
		 */
		const entry = await this.waitForEntry(file);
		if (this.dead || !entry) return false;
		this.placing = file;
		this.setDragging(true);
		this.markPlacing();
		return true;
	}

	/*
	 * Which note is being placed. A drag has the browser's own ghost under the
	 * pointer saying what is in hand; a placement has no button held and no ghost,
	 * so without this the whole gesture is about a note that is not identified
	 * anywhere on the screen.
	 *
	 * Re-asserted on every move rather than set once: cards and rows are recycled,
	 * so a class put on an element is handed to a different note as soon as the
	 * view re-renders. Keyed on the FILE, which is what survives a re-query.
	 */
	markPlacing() {
		const file = this.placing;
		for (const item of this.layout.items(this.view)) {
			if (!item || !item.el) continue;
			const mine = !!(file && item.entry && item.entry.file === file);
			if (item.el.hasClass('bases-dnd-placing') !== mine) item.el.toggleClass('bases-dnd-placing', mine);
		}
	}

	endPlacement() {
		this.placing = null;
		try { this.markPlacing(); } catch (e) { /* the view may already be gone */ }
		this.clearPlaceHover();
		if (this.placeLabelEl) { this.placeLabelEl.detach(); this.placeLabelEl = null; }
		this.clearOptions();
		this.endDrag();
	}

	/* The pointer moving in placement mode is the drag's dragover. */
	placeMove(evt) {
		if (this.dead || !this.placing) return;
		const res = this.onDrop(evt, { file: this.placing }, true);
		this.markPlacing();
		this.paintPlaceHover(res);
		this.paintPlaceLabel(evt, res);
	}

	/*
	 * And a click is its drop. One call, not a preview followed by a commit: the
	 * walk would run twice and could in principle answer twice, and then the thing
	 * that was shown is not the thing that happened.
	 *
	 * A refusal leaves the mode armed. The click landed somewhere this base cannot
	 * put the note, and cancelling on it would throw away the placement for what
	 * is really a mis-aim — the reason is already on the label.
	 */
	placeClick(evt) {
		if (this.dead || !this.placing) return false;
		const res = this.onDrop(evt, { file: this.placing }, false);
		return !!(res && res.dropEffect !== 'none');
	}

	waitForEntry(file) {
		return new Promise((resolve) => {
			let tries = 0;
			const look = () => {
				if (this.dead) return resolve(null);
				const entry = this.entryForFile(file);
				if (entry) return resolve(entry);
				/* Two seconds. Past that the note is filtered out of this base, not late. */
				if (++tries > 40) return resolve(null);
				window.setTimeout(look, 50);
			};
			look();
		});
	}

	/*
	 * The group under the pointer, lit the way `dragManager.updateHover` lights it
	 * during a drag. Tracked so it can be put back: the class is on an element the
	 * view owns and will happily replace, so it is removed by the same code that
	 * added it rather than swept for later.
	 */
	paintPlaceHover(res) {
		const el = res && res.hoverEl ? res.hoverEl : null;
		if (this.placeHoverEl === el) return;
		this.clearPlaceHover();
		if (el) { el.addClass('bases-dnd-over'); this.placeHoverEl = el; }
	}

	clearPlaceHover() {
		if (this.placeHoverEl) {
			try { this.placeHoverEl.removeClass('bases-dnd-over'); } catch (e) { /* gone already */ }
			this.placeHoverEl = null;
		}
	}

	/* What the click will write, following the pointer since there is no ghost. */
	paintPlaceLabel(evt, res) {
		const text = res && res.action;
		if (!text) { if (this.placeLabelEl) this.placeLabelEl.hide(); return; }
		if (!this.placeLabelEl) {
			this.placeLabelEl = createDiv('bases-dnd-place-label');
			this.placeLabelEl.hide();
		}
		if (this.placeLabelEl.parentElement !== document.body) document.body.appendChild(this.placeLabelEl);
		this.placeLabelEl.setText(text);
		this.placeLabelEl.toggleClass('mod-refused', res.dropEffect === 'none');
		this.placeLabelEl.show();
		this.placeLabelEl.setCssStyles({ left: `${evt.clientX + 14}px`, top: `${evt.clientY + 18}px` });
	}

	destroy() {
		/*
		 * `dragManager.handleDrop` adds three listeners of its own and hands back
		 * no way to remove them, and a base view outlives the plugin that decorated
		 * it — so disabling the plugin has to make the handler inert rather than
		 * unbind it. Every entry point checks this first.
		 */
		this.dead = true;
		this.endPlacement();
		for (const d of this.disposers) { try { d(); } catch (e) { /* going away anyway */ } }
		this.disposers = [];
		this.removePhantoms();
		this.setDragging(false);
		this.clearLanded();
		this.unwatchRoot();
		if (this.gripEl) this.gripEl.detach();
		if (this.indicatorEl) this.indicatorEl.detach();
		for (const el of this.optionEls || []) el.detach();
		for (const el of this.brackets || []) el.detach();
		if (this.fromEl) this.fromEl.detach();
	}
}

/* ------------------------------------------------------------------- plugin */

class BasesTableKanbanPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		folderMovesEnabled = this.settings.folderMoves;
		this.domains = new Domains(this.app);
		this.layers = new Map();

		/*
		 * Every base view this plugin has ever met, so one it has let go of can be
		 * picked up again.
		 *
		 * **The reap below has to be recoverable, and it was not.** A layer whose
		 * `scrollEl` has left the document is destroyed and forgotten — which was
		 * safe only while the two ways *in* covered everything: `getViewFactory`,
		 * which fires when a view is **constructed**, and a walk over
		 * `getLeavesOfType('bases')`, which sees base files open in tabs and can
		 * never see an embed. So a view that is momentarily out of the document and
		 * then comes back is dropped for the rest of the session.
		 *
		 * A base in a Dynamic Viewer band is out of the document all the time — a
		 * tab switch, a mode switch, the CodeMirror widget handing its element to
		 * `.mod-header` and taking it back — and since that plugin stopped
		 * rebuilding its bands (2026-09-03, the flicker fix) it **keeps** its
		 * embeds, so no view is ever constructed a second time and the factory
		 * never fires again. Rebuilding used to repair this by accident; removing
		 * the churn removed the repair, which is why it looked like a new bug in a
		 * plugin nobody had touched.
		 *
		 * Held as `WeakRef`s, which is the whole reason this can be a registry at
		 * all: a view is remembered without being **kept**, so a genuinely dead one
		 * is collected and its entry drops out on the next scan. No heuristic
		 * decides whether a view is dead, because a heuristic that guessed wrong
		 * would either leak or bring the permanence back under a longer timer.
		 */
		this.seenTypes = new WeakMap();
		this.seenRefs = new Set();

		/* The coalesced scan’s two handles, cancelled on unload. */
		this.scanQueued = false;
		this.scanFrame = 0;
		this.scanTimer = 0;
		this.modifierHeld = false;
		/* The layer holding a note that is waiting to be clicked into place. */
		this.placing = null;
		this.applyNewButtonVisibility();

		/*
		 * The review modifier has to be read at dragstart-ish time: by the time
		 * `drop` fires, dataTransfer events still carry modifier flags, but the
		 * handleDrop callback is also used for the preview, so tracking it on the
		 * window is simpler and works for every layout.
		 */
		const track = (e) => {
			const mod = MODIFIERS[this.settings.reviewModifier] || MODIFIERS.alt;
			this.modifierHeld = mod.test(e);
		};
		this.registerDomEvent(window, 'dragover', track, true);
		this.registerDomEvent(window, 'keydown', track, true);
		this.registerDomEvent(window, 'keyup', track, true);

		this.installPointerHandling();

		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			/* A characteristic note edited means its domain is stale. */
			if (file && file.path.includes('Characteristic')) this.domains.cache.clear();
		}));

		/*
		 * The planner, reachable from the running app. It is how the placement is
		 * checked against his real base over the debugging port — in particular
		 * that the comparator reproduces the order Obsidian actually rendered,
		 * which no stub can tell me. Reads nothing and writes nothing.
		 */
		this.diagnostics = module.exports.__test;

		this.hookViewFactory();
		this.app.workspace.onLayoutReady(() => this.scanOpenViews());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.queueScan()));
		/*
		 * A leaf change is when a band comes back into the document, and it is not
		 * a layout change — so without this the recovery pass would only run when
		 * something else happened to move a pane.
		 */
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.queueScan()));

		this.addSettingTab(new BasesTableKanbanSettingTab(this.app, this));
	}

	onunload() {
		this.stopPlacement();
		document.body.removeClass('bases-dnd-no-new');
		for (const layer of this.layers.values()) layer.destroy();
		this.stopScans();
		this.layers.clear();
		this.seenRefs.clear();
		this.unhookViewFactory();
		this.unhookNewItemMenu();
	}

	/*
	 * All pointer and drag handling lives here, on the document, rather than on
	 * each view's element.
	 *
	 * The first version bound to `view.scrollEl` in the layer's constructor and
	 * used `dragManager.handleDrop`, which does the same. Both are wrong for the
	 * same reason: a base view rebuilds its own DOM under a long-lived view
	 * object, so a listener bound at construction can stop receiving events —
	 * and `handleDrop` hands back no way to unbind, so the listeners outlived the
	 * plugin too. One set here, removed on unload, dispatched by hit-testing the
	 * layers, has neither problem.
	 */
	installPointerHandling() {
		const dm = () => this.app.dragManager;

		this.registerDomEvent(document, 'mousemove', (evt) => {
			if (dm().draggable) return;
			/*
			 * A note is waiting to be placed, so the pointer is doing a drag's job
			 * without a button held. The grip has no business appearing under it.
			 */
			if (this.placing) {
				if (this.layerFor(evt) === this.placing) this.placing.placeMove(evt);
				for (const layer of this.layers.values()) layer.hideGrip();
				return;
			}
			const hit = this.layerFor(evt);
			for (const layer of this.layers.values()) {
				if (layer === hit) layer.positionGrip(evt);
				else layer.hideGrip();
			}
		});

		/*
		 * The body of `dragManager.handleDrop`, reproduced: ask the layer what the
		 * drop would do, then claim the event and paint what it says.
		 */
		const over = (evt) => {
			const draggable = dm().draggable;
			if (!draggable || evt.defaultPrevented) return;
			const layer = this.layerFor(evt);
			if (!layer) return;
			layer.setDragging(true);
			const res = layer.onDrop(evt, draggable, true);
			if (!res) return;
			evt.preventDefault();
			if (res.action) dm().setAction(res.action);
			if (res.dropEffect && evt.dataTransfer) evt.dataTransfer.dropEffect = res.dropEffect;
			if (res.hoverEl && res.hoverClass) dm().updateHover(res.hoverEl, res.hoverClass);
		};

		this.registerDomEvent(document, 'dragover', over, true);
		this.registerDomEvent(document, 'dragenter', over, true);

		this.registerDomEvent(document, 'drop', (evt) => {
			const draggable = dm().draggable;
			if (!draggable || evt.defaultPrevented) return;
			const layer = this.layerFor(evt);
			if (!layer) return;
			if (layer.onDrop(evt, draggable, false)) evt.preventDefault();
		}, true);

		/*
		 * Rows are recycled, so a mark left sitting on an element would be handed to
		 * a different note on the next scroll. Re-assert it against the file instead
		 * — cheap, and it also keeps the origin line pinned to the right boundary as
		 * the content moves under it.
		 */
		this.registerDomEvent(document, 'scroll', () => {
			for (const layer of this.layers.values()) if (layer.landed) layer.paintLanded();
		}, true);

		const clear = () => { for (const layer of this.layers.values()) layer.endDrag(); };
		this.registerDomEvent(document, 'dragend', clear, true);
		this.registerDomEvent(document, 'drop', clear, true);

		/*
		 * Placement mode. A click is the drop, so it must not also be whatever the
		 * click would ordinarily have been — opening the note, or starting the
		 * table's cell selection, which begins on mousedown. Both are swallowed in
		 * the capture phase, before the view sees them.
		 *
		 * A click anywhere else cancels: the mode has no ghost and no held button,
		 * so the only way out that needs no instructions is to click away from it.
		 */
		this.registerDomEvent(document, 'mousedown', (evt) => {
			if (!this.placing) return;
			if (this.layerFor(evt) !== this.placing) return;
			evt.preventDefault();
			evt.stopPropagation();
		}, true);

		this.registerDomEvent(document, 'click', (evt) => {
			if (!this.placing) return;
			if (this.layerFor(evt) !== this.placing) { this.stopPlacement(); return; }
			evt.preventDefault();
			evt.stopPropagation();
			/* A refusal keeps the mode armed — the reason is already on the label. */
			if (this.placing.placeClick(evt)) this.stopPlacement();
		}, true);

		this.registerDomEvent(document, 'keydown', (evt) => {
			if (this.placing && evt.key === 'Escape') { evt.preventDefault(); this.stopPlacement(); }
		}, true);
	}

	/* The innermost base view under the pointer, if any. */
	layerFor(evt) {
		const target = evt.target instanceof Element ? evt.target : null;
		if (!target) return null;
		let best = null;
		for (const layer of this.layers.values()) {
			const root = layer.root;
			if (root && !layer.dead && root.contains(target)) {
				if (!best || best.root.contains(root)) best = layer;
			}
		}
		return best;
	}

	basesInstance() {
		const p = this.app.internalPlugins && this.app.internalPlugins.plugins.bases;
		return (p && p.instance) || null;
	}

	/*
	 * Every base view is built through `getViewFactory(type)`, which the
	 * controller calls as `factory(controller, containerEl)` — a plain call, no
	 * `new`. Wrapping it is the one hook that catches views in leaves, in hover
	 * popovers and in markdown embeds alike.
	 */
	hookViewFactory() {
		const inst = this.basesInstance();
		if (!inst || typeof inst.getViewFactory !== 'function') return;
		const original = inst.getViewFactory;
		this.originalGetViewFactory = original;
		const plugin = this;
		inst.getViewFactory = function (type) {
			const factory = original.call(this, type);
			if (typeof factory !== 'function' || !LAYOUTS[type]) return factory;
			return function (...args) {
				const view = factory.apply(this, args);
				try { plugin.attach(view, type); } catch (e) { console.error(TAG, e); }
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
	 * A scan now, and another once the app has settled.
	 *
	 * **The event fires before the band is back.** `layout-change` and
	 * `active-leaf-change` are what tell us something moved, but Dynamic Viewer
	 * re-mounts its band *in response to* those same events, so a scan that runs
	 * synchronously inside them looks at a view still out of the document, does
	 * nothing, and nothing fires again — which is the original bug with an extra
	 * step. So it runs on the next frame, and once more after a beat, for the
	 * reason `restoreScroll` runs twice over there: whoever writes last wins, and
	 * we are not the ones moving the element.
	 *
	 * The timers are held and cleared on unload — a bare `setTimeout` outlives
	 * `onunload`, which is how Dynamic Sticky Notes left a dead instance holding a
	 * live collector.
	 */
	queueScan() {
		if (this.scanQueued) return;
		this.scanQueued = true;

		const run = () => {
			if (this._loaded === false) return;
			try { this.scanOpenViews(); } catch (e) { console.error(TAG, e); }
		};

		/*
		 * Two handles rather than one set: `cancelAnimationFrame` and
		 * `clearTimeout` are different id spaces, and a set holding both cannot say
		 * which cancel a number wants.
		 */
		this.scanFrame = window.requestAnimationFrame(() => {
			this.scanFrame = 0;
			run();
			this.scanTimer = window.setTimeout(() => {
				this.scanTimer = 0;
				this.scanQueued = false;
				run();
			}, 250);
		});
	}

	stopScans() {
		if (this.scanFrame) window.cancelAnimationFrame(this.scanFrame);
		if (this.scanTimer) window.clearTimeout(this.scanTimer);
		this.scanFrame = 0;
		this.scanTimer = 0;
		this.scanQueued = false;
	}

	/*
	 * Views that already existed when the plugin was enabled — and, since the
	 * registry, every view that has come back into the document since the last
	 * scan.
	 *
	 * Three passes, and the order is deliberate: drop what has left, pick up what
	 * has returned, and only then forget what has been collected. Reaping first
	 * means the recovery pass never looks at a layer that is about to go, and
	 * pruning last means a view that was reaped this very scan is still in the
	 * registry to be found by the next one.
	 */
	scanOpenViews() {
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			const controller = leaf.view && leaf.view.controller;
			const view = controller && controller.view;
			if (view && LAYOUTS[view.type]) this.attach(view, view.type);
		}

		for (const [view, layer] of this.layers) {
			if (!view.scrollEl || !view.scrollEl.isConnected) { layer.destroy(); this.layers.delete(view); }
		}

		for (const ref of Array.from(this.seenRefs)) {
			const view = ref.deref();
			/* Collected: the view is gone and so is any reason to hold its entry. */
			if (!view) { this.seenRefs.delete(ref); continue; }
			if (this.layers.has(view)) continue;
			const type = this.seenTypes.get(view);
			if (!type || !LAYOUTS[type]) continue;
			/*
			 * Only while it is really in the document. A view that is still out is
			 * left alone and tried again next time, which is what makes the reap a
			 * "not now" rather than a "never".
			 */
			if (!view.scrollEl || !view.scrollEl.isConnected) continue;
			this.attach(view, type);
		}
	}

	/*
	 * Write a view into the registry. Cheap and idempotent, so it can sit at the
	 * top of `attach` and cover every way in at once.
	 */
	remember(view, type) {
		if (!view || !LAYOUTS[type] || this.seenTypes.has(view)) return;
		this.seenTypes.set(view, type);
		this.seenRefs.add(new WeakRef(view));
	}

	attach(view, type) {
		/*
		 * Remembered before anything can decline, so the two ways this returns
		 * early are both recoverable: a view whose root is not there yet is tried
		 * again on the next layout change instead of being lost the way a view
		 * constructed before its container was is lost.
		 */
		this.remember(view, type);
		/* Lazy, because the NewItemMenu class is internal: a live view is the only
		 * name it has. Installs once and covers every base thereafter. */
		try { this.hookNewItemMenu(view.queryController); } catch (e) { console.error(TAG, e); }
		if (this.layers.has(view)) return;
		const layer = new DragLayer(this, view, type);
		if (!layer.root) return;
		this.layers.set(view, layer);
	}

	/*
	 * The `+ new` button, taken over.
	 *
	 * `open` is on the NewItemMenu prototype, so this patches once and reaches
	 * every base. It is reached lazily through a live controller because the class
	 * is internal and a live view is the only name it has.
	 *
	 * The guard is our OWN mark, not `hasOwnProperty(proto, 'open')` — `open` is
	 * the prototype's own method to begin with, and the lesson from the empty
	 * groups is that "is this slot occupied" answers a different question from
	 * "am I already in". What was installed is kept too, so a restore can stand
	 * aside if somebody has stacked on top since.
	 */
	hookNewItemMenu(controller) {
		if (this.newItemProto) return;
		const menu = controller && controller.newItemMenu;
		if (!menu) return;
		const proto = Object.getPrototypeOf(menu);
		if (!proto || typeof proto.open !== 'function' || proto[NEW_ITEM_HOOK]) return;

		const original = proto.open;
		const plugin = this;
		const patched = function (name, frontmatter) {
			return plugin.openNewItem(this, original, name, frontmatter);
		};
		proto.open = patched;
		proto[NEW_ITEM_HOOK] = { original, patched };
		this.newItemProto = proto;
	}

	unhookNewItemMenu() {
		const proto = this.newItemProto;
		this.newItemProto = null;
		if (!proto) return;
		const mark = proto[NEW_ITEM_HOOK];
		if (!mark) return;
		/* Somebody patched on top of ours; unwinding here would take theirs out too. */
		if (proto.open === mark.patched) proto.open = mark.original;
		delete proto[NEW_ITEM_HOOK];
	}

	/*
	 * His three steps, in his order: make it, offer the name, then arm the
	 * placement. Nothing is asked before the note exists — "the button should
	 * bring up no menu".
	 */
	async openNewItem(menu, original, name, frontmatter) {
		try {
			const controller = menu.queryController;
			const view = controller && controller.view;
			let template = this.templateFor(controller);
			let chosen = null;

			/*
			 * Which subclass — asked first, because the answer decides which
			 * template makes the note. A base that names its own template has
			 * already answered, and one candidate is not a question.
			 */
			const query = controller && controller.query;
			if (this.settings.newNoteSubclass && query && !query.newItemTemplate) {
				const cls = this.classOfBase(query);
				const choices = cls ? this.subclassChoices(cls) : [];
				if (choices.length > 1) {
					chosen = await this.askForClass(menu, choices);
					/* Dismissed without choosing: nothing is created. */
					if (!chosen) return;
					template = chosen.template;
				}
			}

			/*
			 * Obsidian's own `open` can THROW after the note exists.
			 *
			 * Its last step builds the rename popover, and in a base that is
			 * *embedded* — a Dynamic Viewer band, a `![[X.base]]` in a note — the
			 * popover factory returns null and Obsidian calls `setIsFocused` on it
			 * unguarded. The note has already been created, named and given its
			 * frontmatter by then; what is lost is the prompt and everything after
			 * it, which is why the button looked like it did nothing at all.
			 *
			 * So a throw is only a throw when there is no note. With one, the
			 * failure is Obsidian's last step and ours still have to run.
			 */
			try {
				await this.createNote(menu, original, name, frontmatter, template, chosen);
			} catch (e) {
				if (!menu.newlyCreatedFile) throw e;
				console.warn(TAG, 'Obsidian could not open its rename popover here', e);
			}

			const file = menu.newlyCreatedFile;
			if (!file) return;

			/*
			 * Step 2 is Obsidian's own popover, which already opens on the new note
			 * with its title selected — his "window with the option to change the
			 * automatic name assigned by Templater", exactly. Turning the prompt off
			 * means closing it again rather than preventing it: `open` builds it
			 * unconditionally, and reproducing the fifteen lines around it to skip
			 * one would be a second copy of Obsidian's creation to keep in step.
			 */
			const wantsName = this.settings.newNoteName;
			const popover = menu.popover;
			if (!wantsName && popover) menu.close();

			/*
			 * No popover, but he asked to be prompted: an embedded base. Obsidian
			 * has no second way of offering the name in place — its own fallback,
			 * on a phone, is to open the note in a tab, which here would navigate
			 * away from the very base he is placing the note into.
			 *
			 * So the name is asked in a modal instead, and only in this case. It is
			 * not a second copy of Obsidian's creation: nothing is created here, the
			 * note already exists and this renames it.
			 */
			if (wantsName && !popover) {
				new RenameNoteModal(this.app, file, () => {
					/*
					 * The layer is looked up when the name is settled, not now. An
					 * embedded base's `view` is not on its controller yet at the
					 * moment the note is created, so asking early answers "there is
					 * nowhere to place it" for a base that has somewhere.
					 */
					if (!this.settings.newNotePlacement) return;
					const live = menu.queryController;
					const target = live && live.view ? this.layers.get(live.view) : null;
					if (!target || !target.canPlace()) return;
					window.setTimeout(() => this.beginPlacement(target, file), 0);
				}).open();
				return;
			}

			if (!this.settings.newNotePlacement) return;
			const layer = view ? this.layers.get(view) : null;
			if (!layer) return;
			/*
			 * Asked before the popover is even waited on, because a view with no
			 * order to write has nothing to offer and the answer will not change
			 * while he is typing a name.
			 */
			if (!layer.canPlace()) return;

			/*
			 * "Once the user clicks out of that window" — the popover's own unload,
			 * which is what closing it by any route runs. Deferred a tick so the
			 * placement is armed after the click that dismissed it, not during it.
			 */
			if (wantsName && popover) {
				popover.register(() => window.setTimeout(() => this.beginPlacement(layer, file), 0));
			} else {
				window.setTimeout(() => this.beginPlacement(layer, file), 0);
			}
		} catch (e) {
			console.error(TAG, e);
			new Notice('The new note could not be set up — see the console.');
		}
	}

	/*
	 * Obsidian's own creation, with the template's body threaded through it.
	 *
	 * The body has to land BETWEEN `createNewFile` and `processFrontMatter`, and
	 * there is no argument for that — so `createNewFile` is wrapped for the length
	 * of this one call. It is a short window, it fires once, and it is put back in
	 * a `finally`, and only if it is still ours.
	 */
	async createNote(menu, original, name, frontmatter, template, chosen) {
		const app = this.app;
		const fileManager = app.fileManager;
		const owned = Object.prototype.hasOwnProperty.call(fileManager, 'createNewFile');
		const create = fileManager.createNewFile;
		let poured = false;
		let wrapper = null;
		let seeded = null;

		if (template && typeof create === 'function') {
			wrapper = async function (...args) {
				const file = await create.apply(this, args);
				if (!poured && file) {
					poured = true;
					try {
						await pourTemplate(app, template, file);
						seeded = await frontmatterOf(app, file);
					} catch (e) {
						console.error(TAG, e);
						new Notice(`Could not apply ${template.basename}: ${e.message}`);
					}
				}
				return file;
			};
			fileManager.createNewFile = wrapper;
		}

		try {
			await original.call(menu, name, (fm) => {
				/*
				 * Obsidian derives the new note's properties from the base's filters
				 * — and adds `null` for EVERY `note.*` key in the view's `order:`
				 * list. That pass runs after ours, so on his Improvement Base, whose
				 * table shows an `is a` column, it assigned `is a = null` straight
				 * over the `[[Improvement]]` the template had just written. The note
				 * was then filtered out of the base it was made in.
				 *
				 * So the template's values are put back — but only where the key is
				 * now BLANK. A value the filters genuinely derived is a fact about
				 * this base and outranks the template; a null from the column list is
				 * not a value at all.
				 *
				 * This callback is Obsidian's own last step, which is what makes it
				 * the right place: nothing of its own runs after it.
				 */
				if (seeded) {
					for (const key of Object.keys(seeded)) {
						if (isBlank(seeded[key])) continue;
						const k = resolveKey(fm, key);
						if (isBlank(fm[k])) fm[k] = seeded[key];
					}

					/*
					 * One exception to "a derived value outranks the template": the
					 * class he PICKED. Obsidian derives `is a` from the base's own
					 * `isA("X")` filter, which is the parent — writing it over the
					 * subclass would undo the choice and leave him editing the
					 * frontmatter afterwards, which is the whole thing he asked to
					 * be rid of. A subclass satisfies that filter anyway, so the
					 * base is not being lied to.
					 */
					if (chosen) {
						const isA = this.isAProperty();
						if (!isBlank(seeded[isA])) fm[resolveKey(fm, isA)] = seeded[isA];
					}
				}
				if (frontmatter) frontmatter(fm);
			});
		} finally {
			if (wrapper && fileManager.createNewFile === wrapper) {
				if (owned) fileManager.createNewFile = create;
				else delete fileManager.createNewFile;
			}
		}
	}

	/*
	 * The template the note is made from — his "created in the base with the
	 * correct template".
	 *
	 * Two sources, in this order. Obsidian's own `newItemTemplate` key wins,
	 * because it is the base saying so out loud and is settable from the base's
	 * own UI. Failing that, a base whose filter says `isA("X")` is a base of X's,
	 * and X's template is `X Template.md`.
	 *
	 * That second read is of the VAULT, not of OOF Class Manager: `is a` is a
	 * convention he invented and wrote into his notes, `isA()` is a line of text
	 * in a `.base` file on disk, and `<Class> Template.md` is a name. Nothing here
	 * asks another plugin anything, which is why this does not drag OOF back in as
	 * a dependency — his own rule, from the Declared Order split.
	 */
	templateFor(controller) {
		const query = controller && controller.query;
		if (!query) return null;

		const named = query.newItemTemplate;
		if (named && typeof named === 'string') return this.app.vault.getFileByPath(named) || null;

		const cls = this.classOfBase(query);
		return cls ? this.templateNamed(cls) : null;
	}

	/*
	 * The one class this base is about, read off its top-level filters.
	 *
	 * Only the top-level block: a view's own filters narrow the base, they do not
	 * say what it is of. Negated rules are skipped for the reason Obsidian skips
	 * them in its own derivation — a rule about what the base excludes says
	 * nothing about what a new note should be.
	 *
	 * And only when there is exactly one. A base filtering on two classes is a
	 * base about two things, and picking one of them would be a guess made
	 * silently; no template at all is the honest answer, and the base can still
	 * name one explicitly.
	 */
	classOfBase(query) {
		let text;
		try { text = query.toString(); } catch (e) { return null; }
		if (typeof text !== 'string') return null;

		const found = [];
		let inFilters = false;
		for (const line of text.split('\n')) {
			/* A line in column zero is a new top-level key. */
			if (line && !/^\s/.test(line)) { inFilters = line.startsWith('filters:'); continue; }
			if (!inFilters || line.includes('!')) continue;
			const m = /\bisA\(\s*["']([^"']+)["']\s*\)/.exec(line);
			if (m && !found.includes(m[1])) found.push(m[1]);
		}
		return found.length === 1 ? found[0] : null;
	}

	/*
	 * The classes a new note in this base could be — its class, and everything
	 * below it.
	 *
	 * His ask (2026-09-03): a `+ New` in Improvement Base makes an Improvement, and
	 * he then edits the frontmatter to say Project. A Project is a `type of` Effort
	 * is a `type of` Improvement, so it satisfies the base's own filter and belongs
	 * there — the class is the one thing about a new note that cannot be settled
	 * afterwards without work, and it is the one thing the button was deciding for
	 * him.
	 *
	 * This reads `type of` out of the notes, which is his OOF convention and not
	 * OOF Class Manager's private state — the same licence OOF Declared Order has
	 * to read `possible values`. The property *name* is taken from that plugin when
	 * it is loaded, because a name he can change in one place must not be spelled
	 * differently in another.
	 */
	isAProperty() {
		const oof = this.app.plugins.plugins['oof-objects'];
		const named = oof && oof.settings && oof.settings.isAProperty;
		return (typeof named === 'string' && named.trim()) || 'is a';
	}

	inheritsProperty() {
		const oof = this.app.plugins.plugins['oof-objects'];
		const named = oof && oof.settings && oof.settings.inheritsProperty;
		return (typeof named === 'string' && named.trim()) || 'type of';
	}

	/*
	 * `X`, then every class that reaches X by `type of`, breadth first — so the
	 * order on the menu is the order of the tree, nearest first. A class is listed
	 * once even where two parents lead to it, at the shallower depth, and only if
	 * it has a template: without one there is nothing to create it from.
	 */
	subclassChoices(cls) {
		const property = this.inheritsProperty();
		const key = (name) => String(name || '').trim().toLowerCase();

		/* parent -> children, built once from the whole vault. */
		const children = new Map();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const raw = cache && cache.frontmatter ? cache.frontmatter[property] : null;
			const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
			for (const entry of list) {
				const parent = key(linkName(entry));
				if (!parent) continue;
				if (!children.has(parent)) children.set(parent, []);
				children.get(parent).push(file.basename);
			}
		}

		const out = [];
		const seen = new Set();
		let level = [cls];
		let depth = 0;
		while (level.length && depth < 12) {
			const next = [];
			for (const name of level.sort((a, b) => a.localeCompare(b))) {
				if (seen.has(key(name))) continue;
				seen.add(key(name));
				const template = this.templateNamed(name);
				if (template) out.push({ name, template, depth, symbol: this.symbolOf(name) });
				for (const child of (children.get(key(name)) || [])) next.push(child);
			}
			level = next;
			depth++;
		}
		return out;
	}

	/* A class's `symbol:`, but only a Lucide one — a menu item's icon is an id. */
	symbolOf(name) {
		const file = this.classNoteNamed(name);
		const cache = file ? this.app.metadataCache.getFileCache(file) : null;
		const symbol = cache && cache.frontmatter ? cache.frontmatter.symbol : null;
		const text = typeof symbol === 'string' ? symbol.trim() : '';
		return text.startsWith('lucide:') ? text.slice(7) : null;
	}

	classNoteNamed(name) {
		const wanted = String(name || '').toLowerCase();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.basename.toLowerCase() === wanted) return file;
		}
		return null;
	}

	/*
	 * Which subclass, asked before anything is created.
	 *
	 * This is the one question that has to come first, and it does not contradict
	 * his "the button should bring up no menu" — that was about *placement*, which
	 * had to be asked against a fiction of a note that did not exist yet. A class
	 * is not a fiction: the classes are notes in the vault, and the answer decides
	 * which template makes the note. Ask it afterwards and the answer is a rewrite
	 * rather than a choice, which is the work he is trying to be rid of.
	 *
	 * Shown only where there is something to choose. One candidate is not a
	 * question, so a base whose class has no subclasses behaves exactly as before.
	 */
	askForClass(menu, choices) {
		return new Promise((resolve) => {
			const list = new Menu();
			let answered = false;
			const answer = (choice) => {
				if (answered) return;
				answered = true;
				resolve(choice);
			};

			for (const choice of choices) {
				list.addItem((item) => {
					/* Indented by depth: the menu is the tree, read downwards. */
					item.setTitle('  '.repeat(choice.depth) + choice.name);
					if (choice.symbol) item.setIcon(choice.symbol);
					item.onClick(() => answer(choice));
				});
			}

			list.onHide(() => window.setTimeout(() => answer(null), 0));

			/*
			 * Shown a tick late, on purpose. We are still inside the dispatch of the
			 * click on `+ New`, and a menu opened during that click is closed again
			 * by the same click reaching the document - it appears for no frames at
			 * all and answers `null`, which reads exactly like the button doing
			 * nothing. Obsidian's own menus dodge this by taking the event
			 * (`showAtMouseEvent`); there is no event to hand down here.
			 */
			const rect = menu.buttonEl.getBoundingClientRect();
			window.setTimeout(() => {
				list.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
			}, 0);
		});
	}

	/*
	 * `X` -> `X Template.md`, wherever it lives, and only if it is unambiguous.
	 *
	 * Matched without regard to case, because that is how Obsidian resolves a
	 * name: the class note a filter names as `bug` may well be `Bug.md`, and its
	 * template `Bug Template.md`. Which makes two notes differing only in case
	 * ambiguous, and ambiguous means none.
	 */
	templateNamed(cls) {
		const wanted = (cls + ' Template').toLowerCase();
		let hit = null;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.basename.toLowerCase() !== wanted) continue;
			if (hit) return null;
			hit = file;
		}
		return hit;
	}

	/*
	 * Arm the placement on one layer at a time. A second `+ new` while the first
	 * is still armed replaces it: two notes waiting to be placed would mean two
	 * sets of marks over one table and a click that answers for both.
	 */
	async beginPlacement(layer, file) {
		this.stopPlacement();
		const armed = await layer.beginPlacement(file);
		if (!armed) {
			new Notice(`${file.basename} isn’t in this base, so there is nowhere to place it.`);
			return;
		}
		this.placing = layer;
	}

	stopPlacement() {
		const layer = this.placing;
		this.placing = null;
		if (layer) { try { layer.endPlacement(); } catch (e) { console.error(TAG, e); } }
	}

	/*
	 * His first line: "There should be an option to hide the `+ New` button."
	 *
	 * A body class rather than hiding the element. The toolbar is Obsidian's and
	 * it rebuilds it — an element hidden by hand comes back visible on the next
	 * render, and holding a reference to it to re-hide it is the mistake of
	 * caching an element the app owns. A rule keyed on the body applies to every
	 * base that has ever been drawn, including the ones drawn later.
	 */
	applyNewButtonVisibility() {
		document.body.toggleClass('bases-dnd-no-new', !!this.settings.hideNewButton);
	}

	async saveSettings() {
		folderMovesEnabled = this.settings.folderMoves;
		this.applyNewButtonVisibility();
		await this.saveData(this.settings);
		/*
		 * Every other setting here only changes what happens during a drag, so it
		 * takes effect on the next one. This one changes what is on the screen, and
		 * waiting for the next query to show it would read as the switch not working.
		 */
		for (const layer of this.layers.values()) {
			try { layer.refreshGroups(); } catch (e) { console.error(TAG, e); }
		}
	}
}

/* ----------------------------------------------------------------- settings */

class BasesTableKanbanSettingTab extends PluginSettingTab {
	constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'A base has no manual order — a row’s position is a consequence of its values. '
				+ 'So a drop does not move the note: it writes the properties that put it there, and the position follows.',
		});

		new Setting(containerEl)
			.setName('Drop on a group')
			.setDesc('Dropping a note on a group, or on its heading, sets the property the view groups by and nothing else.')
			.addToggle((t) => t.setValue(this.plugin.settings.groupDrops)
				.onChange(async (v) => { this.plugin.settings.groupDrops = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Drop between rows')
			.setDesc('Dropping a note between two rows also sets the sort properties, so it lands in that exact place. '
				+ 'Switch this off to keep dragging between groups — setting status and nothing else — which is the simple half of the feature. '
				+ 'Row drops need the first sort key to be a note property: file name, dates and formulas cannot be written.')
			.addToggle((t) => t.setValue(this.plugin.settings.rowDrops)
				.onChange(async (v) => { this.plugin.settings.rowDrops = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Move between folders')
			.setDesc('When a view is grouped or sorted by folder, dropping a note moves the file. '
				+ 'Its name is never changed — only which folder it sits in. '
				+ 'A move cannot join the base’s transaction, so Ctrl+Z will not bring it back; dragging it back will.')
			.addToggle((t) => t.setValue(this.plugin.settings.folderMoves)
				.onChange(async (v) => { this.plugin.settings.folderMoves = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Say what will change')
			.setDesc('While dragging, name every property the drop would write, beside the pointer.')
			.addToggle((t) => t.setValue(this.plugin.settings.showChanges)
				.onChange(async (v) => { this.plugin.settings.showChanges = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Show the insertion bar')
			.setDesc('Draw a line where the note will land. It sits where the note will really end up, which is not always where the pointer is.')
			.addToggle((t) => t.setValue(this.plugin.settings.showIndicator)
				.onChange(async (v) => { this.plugin.settings.showIndicator = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Show the move')
			.setDesc('After a drop, outline the row the note ended up in and draw a line where it left from, so the whole journey is visible. '
				+ 'They stay until your next click or keypress. The write is instant and silent, so this is otherwise the only sign the drag did anything.')
			.addToggle((t) => t.setValue(this.plugin.settings.flashOnDrop)
				.onChange(async (v) => { this.plugin.settings.flashOnDrop = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Show the drag grip')
			.setDesc('A handle at the start of the row under the pointer. Cards are draggable on their own; table and list rows are not.')
			.addToggle((t) => t.setValue(this.plugin.settings.showGrip)
				.onChange(async (v) => { this.plugin.settings.showGrip = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Show every possible group')
			.setDesc('When a view groups by a characteristic that lists its `possible values`, draw a group for each value, '
				+ 'including the ones no note carries yet — so there is somewhere to drop a note to give it that value. '
				+ 'The empty ones are drawn collapsed and faint, and come up to full strength while a drag is in flight. '
				+ 'Values from an interval or a class are never enumerated.')
			.addToggle((t) => t.setValue(this.plugin.settings.emptyGroups)
				.onChange(async (v) => { this.plugin.settings.emptyGroups = v; await this.plugin.saveSettings(); }));

		containerEl.createEl('h3', { text: 'The + New button' });

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Press + New and the note is made with the base\u2019s template, offered for renaming, '
				+ 'and then dropped where you click \u2014 exactly as if you had dragged it there. '
				+ 'The template is the one named under the base\u2019s own New item template file setting; '
				+ 'unlike Obsidian, this pours in its body and runs its Templater commands, which is where the name comes from.',
		});

		new Setting(containerEl)
			.setName('Hide the + New button')
			.setDesc('For a base where notes are not made by hand. Everything below applies only while it is shown.')
			.addToggle((t) => t.setValue(this.plugin.settings.hideNewButton)
				.onChange(async (v) => { this.plugin.settings.hideNewButton = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Ask which subclass')
			.setDesc('Before the note is made, where the base’s class has classes under it: '
				+ 'its own class and every `type of` beneath it, so an Improvement Base can make a '
				+ 'Project without editing the frontmatter afterwards. Shown only where there is '
				+ 'something to choose, and never when the base names its own template.')
			.addToggle((t) => t.setValue(this.plugin.settings.newNoteSubclass)
				.onChange(async (v) => { this.plugin.settings.newNoteSubclass = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Ask for the name')
			.setDesc('The window Obsidian opens on the new note, with its title selected, so the automatic name can be changed. '
				+ 'Closing it is what starts the placement.')
			.addToggle((t) => t.setValue(this.plugin.settings.newNoteName)
				.onChange(async (v) => { this.plugin.settings.newNoteName = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Ask where it goes')
			.setDesc('After the name, the base lights up with every place the note could go and a click puts it there \u2014 '
				+ 'the same marks, bars and refusals a drag gives. Escape or a click outside leaves the note where it was made.')
			.addToggle((t) => t.setValue(this.plugin.settings.newNotePlacement)
				.onChange(async (v) => { this.plugin.settings.newNotePlacement = v; await this.plugin.saveSettings(); }));

		const mod = MODIFIERS[this.plugin.settings.reviewModifier] || MODIFIERS.alt;
		new Setting(containerEl)
			.setName('Review every move')
			.setDesc(`Ask before writing, with one switch per change, so some can be left out. Off, ${mod.label}-drop still opens it.`)
			.addToggle((t) => t.setValue(this.plugin.settings.reviewEveryMove)
				.onChange(async (v) => { this.plugin.settings.reviewEveryMove = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Review modifier')
			.setDesc('Held during a drop, this opens the review even when the setting above is off.')
			.addDropdown((d) => {
				for (const [k, v] of Object.entries(MODIFIERS)) d.addOption(k, v.label);
				d.setValue(this.plugin.settings.reviewModifier)
					.onChange(async (v) => { this.plugin.settings.reviewModifier = v; await this.plugin.saveSettings(); this.display(); });
			});

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'A move is one transaction, so Ctrl+Z in the base takes back the whole thing at once.',
		});
	}
}

module.exports = BasesTableKanbanPlugin;

/*
 * The placement logic is pure — it takes a view-shaped object and returns a
 * plan — so it is tested off-app against a stubbed `obsidian`. Exported for
 * `claude_vault/tools/bases-dnd-tests/`; nothing in the plugin reads this.
 */
module.exports.__test = {
	planRowDrop, planGroupDrop, betweenValue, effectiveKeys, firstBlockingKey,
	landingIndex, landingRange, compareCells, canWrite, cellOfValue, cellOfLiteral, describeChanges,
	Domains, resolveKey, groupKeyValue, groupValue, literalOf, folderOf, isFolderKey,
	setFolderMoves: (v) => { folderMovesEnabled = v; }, applyChanges, START, END,
	DEFAULT_SETTINGS,
	rowOptions, refineAgainst, asBound, BLANK, planAtGap, betterPlan, gapAt,
	canPlaceIn, simplestBetween,
	missingGroupValues, phantomIndex, groupText, isPhantom, makePhantomGroup, PHANTOM,
};
