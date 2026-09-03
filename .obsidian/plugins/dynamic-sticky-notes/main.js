/*
 * Dynamic Sticky Notes — written entirely by Claude for Leander.
 * Nothing in this folder is Leander's code, so the usual per-line "# Claude"
 * marking does not apply; the whole file is mine.
 *
 * Built 2026-09-01 from his note `Obsidian/Notes/Dynamic Sticky Notes.md`.
 *
 * WHAT IT IS
 *   A right-sidebar panel of sticky notes that follows the note you are in. Its
 *   purpose is his sentence: *note first, organize later*. You are reading
 *   something, a thought arrives, you write it on the blank sticky note already
 *   waiting in the panel, and a real note is created and stuck to the file you
 *   were in — without you having decided anything about where it goes.
 *
 * THE DIRECTION OF THE LINK IS THE DESIGN, and it is his correction of himself:
 *
 *   > I previously said that I thought that each file should have a field
 *   > through which it could link to a notepad, but this is obviously the wrong
 *   > conception. It is undoubtedly better for the notepads themselves to link
 *   > to files.
 *
 *   So there is no `notepad:` key on a note, and this plugin never writes into
 *   the file you are reading. A sticky note carries `file:` naming what it is
 *   stuck to — none, one, or several — and everything the panel shows is read
 *   off that one property. Backlinks make the relation visible from the other
 *   end for free, which is why nothing is written there.
 *
 * THE THREE VIEWS, from his spec
 *   1. Notes  — a grid of the open sticky notes. Every sticky note of the active
 *               file enters it automatically and is highlighted; anything not
 *               pinned and not of that file is cleared when you move on, into
 *               the trash view. If the active file has no sticky note there is a
 *               blank one waiting, and writing in it creates the real note.
 *   2. Base   — his `Sticky Note Base.base`, drawn inside the panel itself.
 *   3. Trash  — what was just cleared, with a check circle per card and one
 *               button to put the selected ones back.
 *
 * WHAT IT WRITES, and where
 *   New sticky notes, in the folder the settings name, from his
 *   `Sticky Note Template.md` where there is one. On an existing sticky note it
 *   writes exactly two frontmatter keys, `file:` and `color:`, through
 *   `processFrontMatter` — never a body, never another note's frontmatter. The
 *   bodies are written by Obsidian's own editor, because a card **is** one (see
 *   below), so this plugin never touches the text you type.
 *
 *   The one destructive act is garbage collection, and it is deliberately the
 *   narrowest thing that satisfies his sentence — "not linked to by any other
 *   note and it contains no text". Six conditions have to hold at once, it goes
 *   through `fileManager.trashFile` so it obeys his own *Deleted files* setting,
 *   and it can be switched off.
 *
 * A CARD IS A REAL OBSIDIAN EDITOR
 *   Not a textarea with markdown-coloured CSS. `app.embedRegistry
 *   .embedByExtension.md` returns **two different classes**, and which one you
 *   get is decided by one field of the context object: with `displayMode: true`
 *   you get the read-only preview embed (`loadFile`, `path`, and nothing else);
 *   without it you get the file-backed editor canvas uses for its note cards —
 *   `showEditor`, `save`, `onFileChanged`, a real CodeMirror, `[[` completion,
 *   every editor command. Measured live in his own app before a line was written.
 *
 *   So a card owns one of those, bound to the sticky note's file, with
 *   `editable = true`. Two consequences run through the whole file:
 *
 *   - **Cards are never rebuilt, only added, removed and reordered.** A render
 *     that emptied the grid and drew it again would destroy a CodeMirror the
 *     user is typing into. `renderNotes` reconciles against a `Map` of live
 *     cards and reorders only when the order actually differs.
 *   - **`workspace.activeEditor` is set on focus**, which is what makes the
 *     app's own commands and the link suggester address the card you are in.
 *     Obsidian's hover-popover editor does exactly this; the asar says so.
 *
 *   If that unofficial pair of classes ever changes shape, `Card.mount` falls
 *   back to a plain textarea bound to the same file. The panel keeps working;
 *   only the niceties go.
 *
 * WHAT IT READS OF HIS SCHEMA, AND WHAT IT DOES NOT DEPEND ON
 *   A sticky note is a note whose `is a` names the class `Sticky Note`; it is
 *   stuck to whatever its `file` property links to; its colour is in `color`.
 *   All four names are settings, and all four are read straight out of the
 *   frontmatter. **`oof-objects` is not required and is never called** — this is
 *   the rule his OOF Declared Order extraction settled: `is a` is a convention
 *   in his notes, not state in a plugin, so any plugin may read it.
 */

'use strict';

const obsidian = require('obsidian');
const {
	Plugin, ItemView, PluginSettingTab, Setting, Menu, Notice,
	TFile, TFolder, setIcon, getFrontMatterInfo, normalizePath,
} = obsidian;

const VIEW_TYPE = 'dynamic-sticky-notes';

/*
 * The palette. Paper colours rather than screen colours — his Stenopaper note is
 * about the marriage of the digital and the analogue, and a sticky note is the
 * most analogue object in the vault.
 *
 * Each entry carries both themes, because a colour that reads as paper in light
 * mode is a headlight in dark mode. The name is what goes in the frontmatter;
 * the hexes never do.
 */
const DEFAULT_PALETTE = [
	{ name: 'Paper', light: '#faf6ea', dark: '#2b2823' },
	{ name: 'Yellow', light: '#fdf1c4', dark: '#4a3f13' },
	{ name: 'Orange', light: '#fbe1c9', dark: '#4d3418' },
	{ name: 'Pink', light: '#fadbe6', dark: '#4a2030' },
	{ name: 'Purple', light: '#e6dcfa', dark: '#332a55' },
	{ name: 'Blue', light: '#d9e6fa', dark: '#1f3450' },
	{ name: 'Cyan', light: '#d4eff0', dark: '#143f44' },
	{ name: 'Green', light: '#dbf0d5', dark: '#1e4023' },
	{ name: 'Grey', light: '#e9e7e2', dark: '#343330' },
];

const RANDOM = '__random__';

/* What a card may be dragged to. Small enough to be a note, tall enough to be a page. */
const MIN_CARD_HEIGHT = 70;
const MAX_CARD_HEIGHT = 1200;

/*
 * How long a sticky note is left alone after it was last written to. It stops a
 * sweep racing a note being made — and it is why collection needs a trigger that
 * comes back later, since a card leaves the view well inside it.
 */
const COLLECT_GRACE = 10000;

/* At most one background sweep this often, driven by moving between notes. */
const SWEEP_INTERVAL = 60000;

/* One definition, used by both grips — the card's and the blank card's. */
function clampHeight(px) {
	if (!Number.isFinite(px)) return MIN_CARD_HEIGHT;
	return Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, Math.round(px)));
}

const DEFAULT_SETTINGS = {
	/* the schema, read off his notes — see the header */
	isAProperty: 'is a',
	stickyClass: 'Sticky Note',
	fileProperty: 'file',
	colorProperty: 'color',

	/* where things are */
	templatePath: 'Obsidian/Templates/Sticky Note Template.md',
	basePath: 'Obsidian/Bases/Class Bases/Sticky Note Base.base',
	folder: 'Obsidian/Notes',
	nameFormat: 'YYYY-MM-DD dddd — HH.mm.ss',

	/* the notes view */
	columns: 1,
	cardHeight: 190,
	blankCard: true,
	highlightStuck: true,

	/* colour */
	newColour: RANDOM,
	palette: DEFAULT_PALETTE.map((c) => Object.assign({}, c)),

	/* housekeeping */
	collectGarbage: true,
	/*
	 * Whether being stuck to a file is enough to keep an empty sticky note.
	 *
	 * **Off**, and it is the one setting here that ships off, because his own
	 * sentence is ambiguous in a way that matters: "not linked to by any other
	 * note" is about links *coming in*, and a sticky note's `file:` is a link
	 * *going out* — so the literal rule would collect an empty attached note,
	 * while the design ("a sticky note is stuck to something") says being
	 * attached is being wanted. Both readings are defensible, which is exactly
	 * when the answer is his rather than mine, and the default is the one that
	 * deletes less.
	 */
	collectAttached: false,
	trashLimit: 40,

	/* state, not preferences — see `saveState` */
	state: { open: [], pinned: [], trash: [], heights: {} },
};

/* ------------------------------------------------------------------ helpers */

/* A frontmatter value as a list. Absent, null and '' are all "nothing there". */
function toList(v) {
	if (v === null || v === undefined || v === '') return [];
	if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== '');
	return [v];
}

/*
 * The name inside a frontmatter entry, whether it is a wikilink or a bare word.
 * `"[[Obsidian/Notes/Sticky Note|note]]"` and `Sticky Note` both come back as
 * `Sticky Note` — the path and the alias are noise for a name comparison.
 */
function linkName(value) {
	let s = String(value == null ? '' : value).trim();
	const m = s.match(/^\[\[([^\]]+)\]\]$/);
	if (m) s = m[1];
	const bar = s.indexOf('|');
	if (bar >= 0) s = s.slice(0, bar);
	const slash = s.lastIndexOf('/');
	if (slash >= 0) s = s.slice(slash + 1);
	return s.replace(/\.md$/i, '').trim();
}

/* The link target of a frontmatter entry, kept whole so it can be resolved. */
function linkPath(value) {
	let s = String(value == null ? '' : value).trim();
	const m = s.match(/^\[\[([^\]]+)\]\]$/);
	if (m) s = m[1];
	const bar = s.indexOf('|');
	if (bar >= 0) s = s.slice(0, bar);
	const hash = s.indexOf('#');
	if (hash >= 0) s = s.slice(0, hash);
	return s.trim();
}

function eq(a, b) {
	return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function sameList(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/*
 * The rule of the notes view, as arithmetic — extracted so it can be tested
 * without a workspace, because it is the one piece of this plugin that is a
 * *rule* rather than a rendering.
 *
 * Everything stuck to the file you have just entered comes in, in its own
 * order, and is first; a pinned card that is not of this file stays, behind
 * them; everything else is cleared. `cleared` is what the trash view is given.
 */
function planActiveChange(open, pinnedSet, stuck) {
	const stuckSet = new Set(stuck);
	const kept = open.filter((p) => pinnedSet.has(p) || stuckSet.has(p));
	const cleared = open.filter((p) => kept.indexOf(p) < 0);
	const next = stuck.concat(kept.filter((p) => !stuckSet.has(p)));
	return { open: next, cleared };
}

/* "It contains no text": the body, once the frontmatter is taken off. */
function bodyIsEmpty(raw) {
	const info = getFrontMatterInfo(raw);
	return raw.slice(info.contentStart).trim() === '';
}

/*
 * The template's body, poured into the file the instant it exists.
 *
 * Obsidian's own template copying takes the frontmatter and nothing else, so a
 * Templater block in the template — his class templates all carry the unique
 * file name one — would never run. This is the same helper Bases Table Kanban
 * uses, for the same reason, and the ordering matters there too: pour first,
 * then write frontmatter, because Templater merges a list-valued key by
 * concatenating and would otherwise append a null to a list just written.
 */
async function pourTemplate(app, template, file) {
	const tp = app.plugins && app.plugins.plugins['templater-obsidian'];
	const templater = tp && tp.templater;
	if (templater && typeof templater.write_template_to_file === 'function') {
		await templater.write_template_to_file(template, file);
		return;
	}
	const raw = await app.vault.read(template);
	const info = getFrontMatterInfo(raw);
	const body = raw.slice(info.contentStart);
	if (body.trim()) await app.vault.process(file, (c) => c + body);
}

/* ------------------------------------------------------------------- index */

/*
 * Which notes are sticky notes, and what each one is stuck to.
 *
 * Rebuilt lazily behind a dirty flag rather than maintained incrementally: the
 * whole answer is a walk of the frontmatter Obsidian already holds in memory,
 * which is microseconds on a vault this size, and an incremental index is a
 * second copy of the truth waiting to disagree with the first.
 */
class Index {
	constructor(plugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.dirty = true;
		this.notes = new Map(); /* path -> { file, targets: string[] } */
	}

	invalidate() {
		this.dirty = true;
	}

	get settings() {
		return this.plugin.settings;
	}

	build() {
		this.notes = new Map();
		const s = this.settings;
		const templateFolder = s.templatePath ? s.templatePath.replace(/[^/]*$/, '') : '';
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.path === s.templatePath) continue;
			/*
			 * The template of a class is an instance of it by every test that
			 * reads frontmatter — his own base says `!file.inFolder("Obsidian/
			 * Templates")` for exactly this reason, and so does this.
			 */
			if (templateFolder && file.path.startsWith(templateFolder)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache && cache.frontmatter;
			if (!fm) continue;
			const isa = toList(fm[s.isAProperty]);
			if (!isa.some((v) => eq(linkName(v), s.stickyClass))) continue;
			this.notes.set(file.path, { file, targets: this.targetsOf(file, fm) });
		}
		this.dirty = false;
	}

	ensure() {
		if (this.dirty) this.build();
	}

	/* The paths of the files a sticky note is stuck to, resolved. */
	targetsOf(file, fm) {
		const key = this.settings.fileProperty;
		const out = [];
		for (const entry of toList(fm[key])) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(linkPath(entry), file.path);
			if (dest) out.push(dest.path);
		}
		return out;
	}

	all() {
		this.ensure();
		return Array.from(this.notes.values()).map((r) => r.file);
	}

	has(path) {
		this.ensure();
		return this.notes.has(path);
	}

	fileAt(path) {
		this.ensure();
		const rec = this.notes.get(path);
		return rec ? rec.file : null;
	}

	targetsFor(path) {
		this.ensure();
		const rec = this.notes.get(path);
		return rec ? rec.targets : [];
	}

	/* Every sticky note stuck to this file, newest first. */
	stickiesFor(file) {
		this.ensure();
		if (!file) return [];
		const out = [];
		for (const rec of this.notes.values()) {
			if (rec.targets.indexOf(file.path) >= 0) out.push(rec.file);
		}
		out.sort((a, b) => b.stat.mtime - a.stat.mtime);
		return out;
	}
}

/* -------------------------------------------------------------------- card */

/*
 * One sticky note on the screen.
 *
 * Owns its editor and its element, and is destroyed only when the note actually
 * leaves the view — never on a redraw. Everything the header shows is read at
 * `refresh()` time so a card can be updated in place.
 */
class Card {
	constructor(view, file) {
		this.view = view;
		this.plugin = view.plugin;
		this.app = view.app;
		this.file = file;
		this.embed = null;
		this.fallback = null;
		this.el = createDiv('dsn-card');
		this.build();
	}

	get path() {
		return this.file.path;
	}

	build() {
		const head = this.el.createDiv('dsn-card-head');
		this.titleEl = head.createDiv('dsn-card-title');
		this.titleEl.addEventListener('click', () => this.openNote(false));
		this.actionsEl = head.createDiv('dsn-card-actions');
		this.bodyEl = this.el.createDiv('dsn-card-body');

		/*
		 * The check circle of the trash view. It is drawn for every card and
		 * shown by CSS only inside the trash, because a card is one thing in both
		 * views — his spec says the trash shows them "in the same manner" — and a
		 * second card class would be a second place to fix everything.
		 */
		/*
		 * The resize grip, bottom right.
		 *
		 * **A resized sticky note is remembered per note, not per panel**, because
		 * that is what the gesture says: you drag *this* card because *this*
		 * thought is longer than the others. The settings' *Sticky note height* is
		 * the height of a card nobody has dragged yet.
		 *
		 * It is kept in `data.json` beside the open list and the pins, and not in
		 * the note's frontmatter — a card's height on this screen is not a fact
		 * about the note, there is no `∘ height` characteristic behind it, and
		 * writing frontmatter with no characteristic behind it is the one thing
		 * every plugin of mine refuses to do.
		 *
		 * Vertical only, so the cursor says `ns-resize` rather than `nwse-resize`:
		 * the width of a card is the grid's, and a corner that offers a width you
		 * cannot change is a corner that lies.
		 */
		this.gripEl = this.el.createDiv('dsn-card-grip');
		this.gripEl.setAttribute('aria-label', 'Drag to resize');
		this.gripEl.addEventListener('pointerdown', (e) => this.startResize(e));
		this.gripEl.addEventListener('dblclick', (e) => {
			e.preventDefault();
			this.view.setHeight(this.path, null);
		});

		this.checkEl = this.el.createDiv('dsn-card-check');
		setIcon(this.checkEl, 'check');
		this.checkEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.view.toggleSelected(this.path);
		});

		this.el.addEventListener('contextmenu', (e) => {
			if (e.target.closest('.dsn-card-body')) return; /* Obsidian's own */
			e.preventDefault();
			this.menu(e);
		});

		this.buildActions();
		this.refresh();
		this.mount();
	}

	buildActions() {
		const add = (icon, cls, tip, fn) => {
			const b = this.actionsEl.createDiv('clickable-icon dsn-card-button ' + cls);
			setIcon(b, icon);
			b.setAttribute('aria-label', tip);
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				fn(e);
			});
			return b;
		};
		this.pinEl = add('pin', 'dsn-pin', 'Pin', () => this.view.togglePin(this.path));
		this.colourEl = add('palette', 'dsn-colour', 'Colour', (e) => this.colourMenu(e));
		add('more-vertical', 'dsn-more', 'More', (e) => this.menu(e));
		add('x', 'dsn-close', 'Clear', () => this.view.clearCard(this.path));
	}

	/*
	 * The header says what the note is stuck to, not what it is called.
	 *
	 * A sticky note is named after the second it was made, so its own name tells
	 * you nothing — while "what is this stuck to" is the only thing that
	 * distinguishes the pinned card of another file from the card of the one you
	 * are reading. The name is still there, as the tooltip, and clicking opens it.
	 */
	refresh() {
		const targets = this.plugin.index.targetsFor(this.path)
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter(Boolean)
			.map((f) => f.basename);
		this.titleEl.setText(targets.length ? targets.join(', ') : this.file.basename);
		this.titleEl.toggleClass('is-loose', targets.length === 0);
		this.titleEl.setAttribute('aria-label', this.file.path);

		const pinned = this.view.pinned.has(this.path);
		this.el.toggleClass('is-pinned', pinned);
		setIcon(this.pinEl, pinned ? 'pin-off' : 'pin');
		this.pinEl.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');

		this.applyHeight(this.view.heightOf(this.path));

		const stuck = this.view.stuckPaths.has(this.path);
		this.el.toggleClass('is-stuck', stuck && this.plugin.settings.highlightStuck);
		this.el.toggleClass('is-selected', this.view.selected.has(this.path));

		this.paint();
	}

	/*
	 * A card's own height, or none — in which case it inherits the grid's, which
	 * is the settings' default. An inline custom property beats the inherited one
	 * without a specificity fight, which is why the height is a variable rather
	 * than a `height:` rule.
	 */
	applyHeight(px) {
		if (px) this.el.style.setProperty('--dsn-card-height', px + 'px');
		else this.el.style.removeProperty('--dsn-card-height');
		this.el.toggleClass('is-resized', !!px);
	}

	/*
	 * The drag itself. Pointer capture on the grip, so the move and the release
	 * arrive here even when the pointer leaves the card — which it does at once,
	 * since the card is what is being made taller.
	 */
	startResize(evt) {
		evt.preventDefault();
		evt.stopPropagation();
		const startY = evt.clientY;
		const startH = this.el.getBoundingClientRect().height;

		this.view.resizing = true;
		this.el.addClass('is-resizing');
		document.body.addClass('dsn-resizing');
		try {
			this.gripEl.setPointerCapture(evt.pointerId);
		} catch (e) { /* a mouse without capture still works through the listeners */ }

		let height = clampHeight(startH);
		const move = (ev) => {
			height = clampHeight(startH + (ev.clientY - startY));
			this.el.style.setProperty('--dsn-card-height', height + 'px');
		};
		const done = (ev) => {
			this.gripEl.removeEventListener('pointermove', move);
			try {
				this.gripEl.releasePointerCapture(ev.pointerId);
			} catch (e) { /* never captured */ }
			this.view.resizing = false;
			this.el.removeClass('is-resizing');
			document.body.removeClass('dsn-resizing');
			this.view.setHeight(this.path, height);
		};
		this.gripEl.addEventListener('pointermove', move);
		this.gripEl.addEventListener('pointerup', done, { once: true });
		this.gripEl.addEventListener('pointercancel', done, { once: true });
	}

	/* The colour is a name in the frontmatter; the hexes never leave the settings. */
	paint() {
		const cache = this.app.metadataCache.getFileCache(this.file);
		const fm = cache && cache.frontmatter;
		const name = fm ? String(fm[this.plugin.settings.colorProperty] || '') : '';
		const entry = this.plugin.colourNamed(name);
		if (entry) {
			this.el.style.setProperty('--dsn-light', entry.light);
			this.el.style.setProperty('--dsn-dark', entry.dark);
			this.el.addClass('has-colour');
		} else {
			this.el.style.removeProperty('--dsn-light');
			this.el.style.removeProperty('--dsn-dark');
			this.el.removeClass('has-colour');
		}
	}

	/* ---------------------------------------------------------- the editor */

	mount() {
		if (this.mountEmbed()) return;
		this.mountFallback();
	}

	mountEmbed() {
		const registry = this.app.embedRegistry;
		const creator = registry && registry.embedByExtension && registry.embedByExtension.md;
		if (typeof creator !== 'function') return false;
		try {
			/*
			 * No `displayMode` in the context — that field is the whole switch
			 * between the read-only preview embed and this one, the file-backed
			 * editor canvas puts in its note cards.
			 */
			const embed = creator({
				app: this.app,
				containerEl: this.bodyEl,
				depth: 0,
				linktext: this.file.path,
				sourcePath: this.file.path,
			}, this.file, '');
			if (!embed || typeof embed.showEditor !== 'function') return false;
			embed.editable = true;
			this.view.addChild(embed);
			this.embed = embed;
			Promise.resolve(embed.loadFile && embed.loadFile()).then(() => {
				try {
					embed.showEditor();
				} catch (e) { /* stays in preview; still readable */ }
			}).catch(() => {});
			/*
			 * What makes the app's own commands and the `[[` suggester address
			 * this card rather than whatever note was last open. Obsidian's hover
			 * popover editor does the same on focus.
			 */
			this.bodyEl.addEventListener('focusin', () => {
				this.app.workspace.activeEditor = embed;
			});
			return true;
		} catch (e) {
			console.error('Dynamic Sticky Notes: embedded editor unavailable', e);
			return false;
		}
	}

	/*
	 * The insurance. Two undocumented classes hold the card up; if either ever
	 * changes shape the panel still writes to the same file, through a textarea.
	 */
	mountFallback() {
		const ta = this.bodyEl.createEl('textarea', { cls: 'dsn-fallback' });
		this.fallback = ta;
		this.app.vault.read(this.file).then((raw) => {
			const info = getFrontMatterInfo(raw);
			ta.value = raw.slice(info.contentStart).replace(/^\n+/, '');
			this.fallbackBody = ta.value;
		});
		let timer = null;
		ta.addEventListener('input', () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => this.saveFallback(), 600);
		});
		ta.addEventListener('blur', () => this.saveFallback());
	}

	async saveFallback() {
		if (!this.fallback) return;
		const body = this.fallback.value;
		if (body === this.fallbackBody) return;
		this.fallbackBody = body;
		await this.app.vault.process(this.file, (raw) => {
			const info = getFrontMatterInfo(raw);
			return raw.slice(0, info.contentStart) + body;
		});
	}

	focusEnd() {
		if (this.embed && this.embed.editor) {
			const ed = this.embed.editor;
			try {
				ed.focus();
				const last = ed.lastLine();
				ed.setCursor({ line: last, ch: ed.getLine(last).length });
			} catch (e) { /* focus is a nicety */ }
			return;
		}
		if (this.fallback) {
			this.fallback.focus();
			this.fallback.setSelectionRange(this.fallback.value.length, this.fallback.value.length);
		}
	}

	/* ----------------------------------------------------------- the menus */

	colourMenu(evt) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Random').setIcon('dices')
			.onClick(() => this.plugin.setColour(this.file, this.plugin.randomColour().name)));
		menu.addSeparator();
		for (const c of this.plugin.settings.palette) {
			menu.addItem((i) => {
				i.setTitle(c.name);
				i.onClick(() => this.plugin.setColour(this.file, c.name));
				/*
				 * The swatch is drawn into the icon slot rather than described in
				 * the label: a colour menu whose items are words is a colour menu
				 * you have to already know the answer to.
				 */
				const dot = createDiv('dsn-swatch');
				dot.style.setProperty('--dsn-light', c.light);
				dot.style.setProperty('--dsn-dark', c.dark);
				const iconEl = i.iconEl || (i.dom && i.dom.querySelector('.menu-item-icon'));
				if (iconEl) {
					iconEl.empty();
					iconEl.appendChild(dot);
				}
			});
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle('No colour').setIcon('ban')
			.onClick(() => this.plugin.setColour(this.file, '')));
		menu.showAtMouseEvent(evt);
	}

	menu(evt) {
		const menu = new Menu();
		const active = this.plugin.currentFile();
		const stuck = this.plugin.index.targetsFor(this.path);

		menu.addItem((i) => i.setTitle('Open sticky note').setIcon('file')
			.onClick(() => this.openNote(false)));
		menu.addItem((i) => i.setTitle('Open in a new tab').setIcon('file-plus')
			.onClick(() => this.openNote(true)));
		menu.addSeparator();

		if (active && active.path !== this.path) {
			const already = stuck.indexOf(active.path) >= 0;
			menu.addItem((i) => i
				.setTitle(already ? `Unstick from ${active.basename}` : `Stick to ${active.basename}`)
				.setIcon(already ? 'unlink' : 'link')
				.onClick(() => this.plugin.setStuck(this.file, active, !already)));
		}
		const pinned = this.view.pinned.has(this.path);
		menu.addItem((i) => i.setTitle(pinned ? 'Unpin' : 'Pin').setIcon(pinned ? 'pin-off' : 'pin')
			.onClick(() => this.view.togglePin(this.path)));
		menu.addItem((i) => i.setTitle('Colour…').setIcon('palette')
			.onClick(() => this.colourMenu(evt)));
		if (this.view.heightOf(this.path)) {
			menu.addItem((i) => i.setTitle('Reset the height').setIcon('chevrons-down-up')
				.onClick(() => this.view.setHeight(this.path, null)));
		}
		menu.addSeparator();

		if (this.view.tab === 'trash') {
			menu.addItem((i) => i.setTitle('Put back in the notes view').setIcon('undo-2')
				.onClick(() => this.view.restore([this.path])));
			menu.addItem((i) => i.setTitle('Forget').setIcon('x')
				.onClick(() => this.view.forget([this.path])));
		} else {
			menu.addItem((i) => i.setTitle('Clear from the view').setIcon('x')
				.onClick(() => this.view.clearCard(this.path)));
		}
		menu.addItem((i) => i.setTitle('Delete the note').setIcon('trash-2')
			.onClick(() => this.plugin.deleteSticky(this.file)));
		menu.showAtMouseEvent(evt);
	}

	openNote(newTab) {
		const leaf = this.app.workspace.getLeaf(newTab ? 'tab' : false);
		leaf.openFile(this.file);
	}

	destroy() {
		if (this.embed) {
			try {
				if (this.app.workspace.activeEditor === this.embed) this.app.workspace.activeEditor = null;
				this.view.removeChild(this.embed);
			} catch (e) { /* already gone */ }
			this.embed = null;
		}
		if (this.fallback) this.saveFallback();
		this.el.detach();
	}
}

/* -------------------------------------------------------------------- view */

/*
 * NOTHING HERE MAY BE CALLED `open`, `actionsEl` OR `headerEl`.
 *
 * The panel came up **completely blank** on his first look, and the cause was
 * `this.open = []`. `View.prototype.open` is the method the leaf calls to attach
 * the view and run `onOpen` — an instance field of that name shadows it, the
 * call goes nowhere, and the leaf is left holding a view that was constructed
 * and never opened: `_loaded: false`, `containerEl.parentElement: null`, an
 * empty pane and no error anywhere. `headerEl` and `actionsEl` are ItemView's
 * own (the view header and its action bar) and were shadowed too, which had not
 * broken anything yet.
 *
 * **A subclass shares one namespace with its base, and Obsidian's is
 * undocumented.** The way to check is to read `Object.keys()` off a live view of
 * another plugin and walk its prototype chain; that is what found all three.
 * Hence `openPaths`, `toolbarEl`, `topEl`.
 */
class StickyView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf, plugin.app);
		this.plugin = plugin;
		this.tab = 'notes';
		this.cards = new Map();
		this.openPaths = [];
		this.pinned = new Set();
		this.trash = [];
		this.selected = new Set();
		this.stuckPaths = new Set();
		this.heights = {};
		this.resizing = false;
		this.baseEmbed = null;
		this.draftEl = null;
		this.focusAfter = null;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Dynamic Sticky Notes'; }
	getIcon() { return 'sticky-note'; }

	async onOpen() {
		this.containerEl.addClass('dsn-panel');
		const root = this.contentEl;
		root.empty();
		root.addClass('dsn-root');
		this.topEl = root.createDiv('dsn-header');
		this.tabsEl = this.topEl.createDiv('dsn-tabs');
		this.toolbarEl = this.topEl.createDiv('dsn-actions');
		this.bodyEl = root.createDiv('dsn-body');
		/* Everything that pointed into the tree just thrown away. */
		this.destroyCards();
		this.destroyBase();
		this.gridEl = null;
		this.emptyEl = null;
		this.draftEl = null;

		this.restoreState();
		this.syncStuck();
		this.buildHeader();
		this.render();
	}

	async onClose() {
		this.destroyCards();
		this.destroyBase();
	}

	/* ------------------------------------------------------------- state */

	restoreState() {
		const st = this.plugin.settings.state || {};
		this.openPaths = (st.open || []).filter((p) => this.plugin.index.has(p));
		this.pinned = new Set((st.pinned || []).filter((p) => this.plugin.index.has(p)));
		this.trash = (st.trash || []).filter((p) => this.plugin.index.has(p));
		this.heights = {};
		for (const [path, h] of Object.entries(st.heights || {})) {
			if (this.plugin.index.has(path)) this.heights[path] = h;
		}
	}

	/* A card's own height, or 0 for "whatever the settings say". */
	heightOf(path) {
		const h = this.heights && this.heights[path];
		return typeof h === 'number' && h > 0 ? h : 0;
	}

	/* `null` forgets the override and the card goes back to the default. */
	setHeight(path, px) {
		if (!this.heights) this.heights = {};
		if (px) this.heights[path] = px;
		else delete this.heights[path];
		this.saveState();
		const card = this.cards.get(path);
		if (card) card.applyHeight(this.heightOf(path));
	}

	/*
	 * Which of the open notes belong to the file you are in. Called wherever the
	 * panel arrives at a state without having watched the file change — opening
	 * the panel, a note edited elsewhere — because `renderDraft` asks this set
	 * whether a blank sticky note is wanted, and an empty set means "none yet".
	 */
	syncStuck() {
		const stuck = this.plugin.index.stickiesFor(this.plugin.currentFile()).map((f) => f.path);
		this.stuckPaths = new Set(stuck);
		for (let i = stuck.length - 1; i >= 0; i--) {
			if (this.openPaths.indexOf(stuck[i]) < 0) this.openPaths.unshift(stuck[i]);
		}
	}

	saveState() {
		this.plugin.settings.state = {
			open: this.openPaths.slice(),
			pinned: Array.from(this.pinned),
			trash: this.trash.slice(),
			heights: Object.assign({}, this.heights),
		};
		this.plugin.queueSave();
	}

	/* ------------------------------------------------------------ header */

	buildHeader() {
		this.tabsEl.empty();
		const tab = (id, label) => {
			const el = this.tabsEl.createDiv('dsn-tab');
			el.setText(label);
			el.toggleClass('is-active', this.tab === id);
			el.addEventListener('click', () => this.setTab(id));
			return el;
		};
		tab('notes', 'Notes');
		tab('base', 'Base');
		const t = tab('trash', 'Trash');
		if (this.trash.length) t.createSpan({ cls: 'dsn-count', text: String(this.trash.length) });

		this.toolbarEl.empty();
		if (this.tab === 'trash') {
			this.trashActions();
			return;
		}
		const add = (icon, tip, fn) => {
			const b = this.toolbarEl.createDiv('clickable-icon dsn-action');
			setIcon(b, icon);
			b.setAttribute('aria-label', tip);
			b.addEventListener('click', fn);
			return b;
		};
		add('file-plus-2', 'New sticky note for the current file',
			() => this.plugin.newSticky(this.plugin.currentFile()));
		add('plus', 'New sticky note', () => this.plugin.newSticky(null));
		add('more-vertical', 'More', (e) => this.moreMenu(e));
	}

	trashActions() {
		const n = this.selected.size;
		const restore = this.toolbarEl.createEl('button', { cls: 'dsn-text-action mod-cta' });
		restore.setText(n ? `Put back (${n})` : 'Put back');
		restore.disabled = n === 0;
		restore.addEventListener('click', () => this.restore(Array.from(this.selected)));

		const all = this.toolbarEl.createEl('button', { cls: 'dsn-text-action' });
		all.setText(n === this.trash.length && n > 0 ? 'None' : 'All');
		all.addEventListener('click', () => {
			if (this.selected.size === this.trash.length) this.selected.clear();
			else this.trash.forEach((p) => this.selected.add(p));
			this.render();
		});

		const clear = this.toolbarEl.createDiv('clickable-icon dsn-action');
		setIcon(clear, 'eraser');
		clear.setAttribute('aria-label', 'Empty the trash view (the notes are not deleted)');
		clear.addEventListener('click', () => this.forget(this.trash.slice()));
	}

	moreMenu(evt) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Open the base in a new tab').setIcon('layout-list')
			.onClick(() => this.plugin.openBaseInTab()));
		menu.addItem((i) => i.setTitle('Unpin everything').setIcon('pin-off')
			.onClick(() => {
				this.pinned.clear();
				this.saveState();
				this.render();
			}));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle('Collect the empty sticky notes').setIcon('trash-2')
			.onClick(() => this.plugin.collectGarbage(false)));
		menu.showAtMouseEvent(evt);
	}

	setTab(id) {
		if (this.tab === id) return;
		if (this.tab === 'base') this.destroyBase();
		if (id !== 'trash') this.selected.clear();
		this.tab = id;
		this.render();
	}

	/* ------------------------------------------------------------ render */

	render() {
		this.buildHeader();
		this.bodyEl.toggleClass('mod-trash', this.tab === 'trash');
		if (this.tab === 'notes') {
			this.destroyBase();
			this.renderNotes();
		} else if (this.tab === 'base') {
			this.destroyCards();
			this.renderBase();
		} else {
			this.destroyBase();
			this.renderTrash();
		}
	}

	/*
	 * The notes view. Cards are reconciled, never redrawn — see the header: each
	 * one owns a live CodeMirror, and emptying the grid would destroy the editor
	 * under the cursor.
	 */
	renderNotes() {
		const grid = this.ensureGrid();
		const want = this.openPaths.filter((p) => this.plugin.index.has(p));
		if (!sameList(want, this.openPaths)) {
			this.openPaths = want;
			this.saveState();
		}

		for (const [path, card] of Array.from(this.cards)) {
			if (want.indexOf(path) < 0) {
				card.destroy();
				this.cards.delete(path);
			}
		}
		for (const path of want) {
			if (!this.cards.has(path)) {
				const file = this.plugin.index.fileAt(path);
				if (file) this.cards.set(path, new Card(this, file));
			}
		}
		for (const path of want) {
			const card = this.cards.get(path);
			if (card) card.refresh();
		}

		this.renderDraft(grid);

		/*
		 * Reorder only when the order differs. `appendChild` on a node already in
		 * place is still a remove and an insert, which blurs a focused editor.
		 */
		const els = want.map((p) => this.cards.get(p)).filter(Boolean).map((c) => c.el);
		const current = Array.from(grid.children).filter((el) => el.hasClass('dsn-card'));
		/* Never re-parent mid-drag: it would drop the pointer capture. */
		if (!this.resizing && !sameList(current, els)) els.forEach((el) => grid.appendChild(el));

		this.renderEmptyState(grid, want.length);

		if (this.focusAfter) {
			const card = this.cards.get(this.focusAfter);
			this.focusAfter = null;
			if (card) window.setTimeout(() => card.focusEnd(), 30);
		}
	}

	/*
	 * The blank sticky note. His spec: "If the active file doesn't already have a
	 * sticky note, then there will be a blank note added which will allow the
	 * user write in it. Once they do write in it, a real note is automatically
	 * created and linked to the active file."
	 *
	 * It is a textarea rather than an editor because there is no file yet to bind
	 * one to — and creating the file first, before a keystroke, is exactly the
	 * litter this plugin's garbage collection exists to clean up. The swap
	 * happens on the first input: the note is created, what has been typed so far
	 * is written into it, and the real card takes the draft's place with the
	 * cursor at the end.
	 */
	renderDraft(grid) {
		const want = this.plugin.settings.blankCard
			&& this.tab === 'notes'
			&& !!this.plugin.currentFile()
			&& this.stuckPaths.size === 0
			&& !this.creatingDraft;
		if (!want) {
			if (this.draftEl) {
				this.draftEl.detach();
				this.draftEl = null;
			}
			return;
		}
		if (this.draftEl) {
			grid.prepend(this.draftEl);
			return;
		}
		const el = createDiv('dsn-card is-draft');
		this.draftEl = el;
		if (this.draftHeight) el.style.setProperty('--dsn-card-height', this.draftHeight + 'px');
		const head = el.createDiv('dsn-card-head');
		head.createDiv('dsn-card-title is-loose').setText(this.plugin.currentFile().basename);
		const body = el.createDiv('dsn-card-body');
		const ta = body.createEl('textarea', { cls: 'dsn-fallback' });
		ta.placeholder = 'Write a thought…';
		const colour = this.plugin.colourForNew();
		if (colour) {
			el.style.setProperty('--dsn-light', colour.light);
			el.style.setProperty('--dsn-dark', colour.dark);
			el.addClass('has-colour');
		}
		ta.addEventListener('input', () => this.promoteDraft(ta, colour));

		/*
		 * The blank card resizes too, and the height it was dragged to follows the
		 * note it becomes. A card you made room in before typing should not snap
		 * back the instant your thought becomes a file.
		 */
		const grip = el.createDiv('dsn-card-grip');
		grip.setAttribute('aria-label', 'Drag to resize');
		grip.addEventListener('pointerdown', (e) => this.resizeDraft(e, el, grip));

		grid.prepend(el);
	}

	resizeDraft(evt, el, grip) {
		evt.preventDefault();
		const startY = evt.clientY;
		const startH = el.getBoundingClientRect().height;
		this.resizing = true;
		el.addClass('is-resizing');
		document.body.addClass('dsn-resizing');
		try {
			grip.setPointerCapture(evt.pointerId);
		} catch (e) { /* no capture; the listeners still fire */ }
		const move = (ev) => {
			this.draftHeight = clampHeight(startH + (ev.clientY - startY));
			el.style.setProperty('--dsn-card-height', this.draftHeight + 'px');
		};
		const done = (ev) => {
			grip.removeEventListener('pointermove', move);
			try {
				grip.releasePointerCapture(ev.pointerId);
			} catch (e) { /* never captured */ }
			this.resizing = false;
			el.removeClass('is-resizing');
			document.body.removeClass('dsn-resizing');
		};
		grip.addEventListener('pointermove', move);
		grip.addEventListener('pointerup', done, { once: true });
		grip.addEventListener('pointercancel', done, { once: true });
	}

	async promoteDraft(ta, colour) {
		if (this.creatingDraft) return;
		this.creatingDraft = true;
		const target = this.plugin.currentFile();
		try {
			const file = await this.plugin.createSticky(target, colour ? colour.name : '');
			/* Whatever else was typed while the file was being made. */
			const text = ta.value;
			if (text.trim()) {
				await this.app.vault.process(file, (raw) => {
					const info = getFrontMatterInfo(raw);
					const head = raw.slice(0, info.contentStart);
					return head + (head.endsWith('\n') ? '' : '\n') + text;
				});
			}
			this.plugin.index.invalidate();
			if (this.draftEl) {
				this.draftEl.detach();
				this.draftEl = null;
			}
			this.creatingDraft = false;
			if (this.draftHeight) {
				this.heights[file.path] = this.draftHeight;
				this.draftHeight = 0;
			}
			this.adopt(file.path);
			this.focusAfter = file.path;
			this.render();
		} catch (e) {
			this.creatingDraft = false;
			console.error('Dynamic Sticky Notes: could not create the sticky note', e);
			new Notice('Dynamic Sticky Notes: could not create the sticky note — see the console.');
		}
	}

	renderEmptyState(grid, count) {
		if (this.emptyEl) {
			this.emptyEl.detach();
			this.emptyEl = null;
		}
		if (count || this.draftEl) return;
		this.emptyEl = grid.createDiv('dsn-empty');
		this.emptyEl.setText(this.plugin.currentFile()
			? 'No sticky note here yet.'
			: 'Open a note to stick something to it.');
	}

	/*
	 * The grid is cached, so the check has to be "is it still in *this* body" —
	 * `parentElement` is not that test. A detached subtree still has parents all
	 * the way up, so after `onOpen` runs a second time and rebuilds `bodyEl`, the
	 * old grid passed the check and every card was drawn into a tree that is no
	 * longer on the screen. Caught by driving the real view over CDP; the
	 * symptom was a panel with a header and nothing under it.
	 */
	ensureGrid() {
		if (this.gridEl && this.gridEl.parentElement !== this.bodyEl) this.gridEl = null;
		if (!this.gridEl) {
			this.bodyEl.empty();
			this.emptyEl = null;
			this.gridEl = this.bodyEl.createDiv('dsn-grid');
		}
		this.gridEl.style.setProperty('--dsn-cols', String(this.plugin.settings.columns));
		this.gridEl.style.setProperty('--dsn-card-height', this.plugin.settings.cardHeight + 'px');
		return this.gridEl;
	}

	/* --------------------------------------------------------- trash view */

	renderTrash() {
		const grid = this.ensureGrid();
		const want = this.trash.filter((p) => this.plugin.index.has(p))
			.slice(0, this.plugin.settings.trashLimit);
		for (const [path, card] of Array.from(this.cards)) {
			if (want.indexOf(path) < 0) {
				card.destroy();
				this.cards.delete(path);
			}
		}
		for (const path of want) {
			if (!this.cards.has(path)) {
				const file = this.plugin.index.fileAt(path);
				if (file) this.cards.set(path, new Card(this, file));
			}
		}
		for (const path of want) {
			const card = this.cards.get(path);
			if (card) card.refresh();
		}
		if (this.draftEl) {
			this.draftEl.detach();
			this.draftEl = null;
		}
		const els = want.map((p) => this.cards.get(p)).filter(Boolean).map((c) => c.el);
		const current = Array.from(grid.children).filter((el) => el.hasClass('dsn-card'));
		/* Never re-parent mid-drag: it would drop the pointer capture. */
		if (!this.resizing && !sameList(current, els)) els.forEach((el) => grid.appendChild(el));
		this.renderEmptyState(grid, want.length);
		if (this.emptyEl) this.emptyEl.setText('Nothing has been cleared yet.');
	}

	toggleSelected(path) {
		if (this.selected.has(path)) this.selected.delete(path);
		else this.selected.add(path);
		this.render();
	}

	/*
	 * Putting a card back, and the one thing his spec leaves implicit: a restored
	 * card that is not stuck to the file you are in would be cleared again by the
	 * very next file change, which makes the button futile. So restoring pins —
	 * but only the ones that need it.
	 */
	restore(paths) {
		for (const p of paths) {
			if (this.openPaths.indexOf(p) < 0) this.openPaths.push(p);
			if (!this.stuckPaths.has(p)) this.pinned.add(p);
			const i = this.trash.indexOf(p);
			if (i >= 0) this.trash.splice(i, 1);
			this.selected.delete(p);
		}
		this.saveState();
		this.tab = 'notes';
		this.render();
	}

	forget(paths) {
		for (const p of paths) {
			const i = this.trash.indexOf(p);
			if (i >= 0) this.trash.splice(i, 1);
			this.selected.delete(p);
		}
		this.saveState();
		this.render();
	}

	/* ---------------------------------------------------------- base view */

	renderBase() {
		this.bodyEl.empty();
		this.gridEl = null;
		const path = this.plugin.settings.basePath;
		const file = path ? this.app.vault.getAbstractFileByPath(normalizePath(path)) : null;
		if (!(file instanceof TFile)) {
			const box = this.bodyEl.createDiv('dsn-empty');
			box.setText(path
				? `No base at ${path}. Name one in the settings.`
				: 'No base named in the settings.');
			return;
		}
		const holder = this.bodyEl.createDiv('dsn-base');
		try {
			const creator = this.app.embedRegistry.embedByExtension['base'];
			const embed = creator({
				app: this.app,
				containerEl: holder,
				depth: 0,
				linktext: file.path,
				sourcePath: file.path,
				displayMode: true,
			}, file, '');
			this.addChild(embed);
			this.baseEmbed = embed;
			if (embed.loadFile) Promise.resolve(embed.loadFile()).catch(() => {});
		} catch (e) {
			console.error('Dynamic Sticky Notes: could not embed the base', e);
			holder.createDiv('dsn-empty').setText('Could not draw the base here.');
		}
	}

	destroyBase() {
		if (!this.baseEmbed) return;
		try {
			this.removeChild(this.baseEmbed);
		} catch (e) { /* already gone */ }
		this.baseEmbed = null;
	}

	destroyCards() {
		for (const card of this.cards.values()) card.destroy();
		this.cards.clear();
	}

	/* ------------------------------------------------------ what the view does */

	togglePin(path) {
		if (this.pinned.has(path)) this.pinned.delete(path);
		else this.pinned.add(path);
		this.saveState();
		this.render();
	}

	/*
	 * Clearing one card by hand. It goes to the trash view — unless it is empty
	 * and stuck to nothing, in which case there is nothing to keep and it is
	 * collected, which is his garbage collection arriving at the moment it is
	 * least surprising.
	 */
	async clearCard(path) {
		const i = this.openPaths.indexOf(path);
		if (i >= 0) this.openPaths.splice(i, 1);
		this.pinned.delete(path);
		await this.sendToTrash([path]);
		this.render();
	}

	async sendToTrash(paths) {
		const keep = [];
		for (const p of paths) {
			if (await this.plugin.collectIfEmpty(p)) continue;
			keep.push(p);
		}
		for (const p of keep) {
			const i = this.trash.indexOf(p);
			if (i >= 0) this.trash.splice(i, 1);
			this.trash.unshift(p);
		}
		if (this.trash.length > this.plugin.settings.trashLimit * 2) {
			this.trash.length = this.plugin.settings.trashLimit * 2;
		}
		this.saveState();
	}

	adopt(path) {
		if (this.openPaths.indexOf(path) < 0) this.openPaths.unshift(path);
		const i = this.trash.indexOf(path);
		if (i >= 0) this.trash.splice(i, 1);
		this.saveState();
	}

	/*
	 * The rule of the notes view, and the whole reason it is called *dynamic*:
	 * every sticky note of the file you have just entered comes in, and anything
	 * that is neither pinned nor of that file goes out.
	 */
	async onActiveFileChanged() {
		const active = this.plugin.currentFile();
		const stuck = this.plugin.index.stickiesFor(active).map((f) => f.path);
		this.stuckPaths = new Set(stuck);

		const plan = planActiveChange(this.openPaths, this.pinned, stuck);
		this.openPaths = plan.open;
		if (plan.cleared.length) await this.sendToTrash(plan.cleared);
		this.saveState();
		this.render();
	}

	/*
	 * A sticky note renamed elsewhere. Everything the panel keeps is keyed by
	 * path, so without this a rename drops the card out of the view, loses its
	 * pin and forgets the height it was dragged to. The `Card` itself needs no
	 * repair — it holds the `TFile`, which Obsidian renames in place.
	 */
	renamePath(oldPath, newPath) {
		if (oldPath === newPath) return;
		const move = (arr) => {
			const i = arr.indexOf(oldPath);
			if (i >= 0) arr[i] = newPath;
		};
		move(this.openPaths);
		move(this.trash);
		if (this.pinned.has(oldPath)) {
			this.pinned.delete(oldPath);
			this.pinned.add(newPath);
		}
		if (this.selected.has(oldPath)) {
			this.selected.delete(oldPath);
			this.selected.add(newPath);
		}
		if (this.heights[oldPath]) {
			this.heights[newPath] = this.heights[oldPath];
			delete this.heights[oldPath];
		}
		const card = this.cards.get(oldPath);
		if (card) {
			this.cards.delete(oldPath);
			this.cards.set(newPath, card);
		}
		this.saveState();
	}

	/* A note changed, was renamed or was deleted somewhere else. */
	onVaultChanged() {
		this.syncStuck();
		this.openPaths = this.openPaths.filter((p) => this.plugin.index.has(p));
		this.trash = this.trash.filter((p) => this.plugin.index.has(p));
		for (const p of Array.from(this.pinned)) if (!this.plugin.index.has(p)) this.pinned.delete(p);
		this.render();
	}
}

/* ---------------------------------------------------------------- settings */

class StickySettingsTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('The notes view').setHeading();

		new Setting(containerEl)
			.setName('Columns')
			.setDesc('How many sticky notes sit side by side in the grid.')
			.addSlider((s) => s.setLimits(1, 4, 1).setValue(this.plugin.settings.columns).setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.columns = v;
					await this.plugin.saveSettings();
					this.plugin.eachView((view) => view.render());
				}));

		new Setting(containerEl)
			.setName('Sticky note height')
			.setDesc('In pixels, for a card nobody has dragged yet — the corner grip resizes one '
				+ 'card on its own, and double-clicking the grip gives it back to this.')
			.addSlider((s) => s.setLimits(100, 500, 10).setValue(this.plugin.settings.cardHeight).setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.cardHeight = v;
					await this.plugin.saveSettings();
					this.plugin.eachView((view) => view.render());
				}));

		new Setting(containerEl)
			.setName('A blank sticky note when there is none')
			.setDesc('A file with no sticky note gets an empty one waiting in the view. Writing in it '
				+ 'creates the note and sticks it to that file — nothing is created until you do.')
			.addToggle((t) => t.setValue(this.plugin.settings.blankCard).onChange(async (v) => {
				this.plugin.settings.blankCard = v;
				await this.plugin.saveSettings();
				this.plugin.eachView((view) => view.render());
			}));

		new Setting(containerEl)
			.setName("Highlight the active file's sticky notes")
			.addToggle((t) => t.setValue(this.plugin.settings.highlightStuck).onChange(async (v) => {
				this.plugin.settings.highlightStuck = v;
				await this.plugin.saveSettings();
				this.plugin.eachView((view) => view.render());
			}));

		new Setting(containerEl).setName('Colour').setHeading();

		new Setting(containerEl)
			.setName('Colour of a new sticky note')
			.addDropdown((d) => {
				d.addOption(RANDOM, 'Random');
				d.addOption('', 'No colour');
				for (const c of this.plugin.settings.palette) d.addOption(c.name, c.name);
				d.setValue(this.plugin.settings.newColour);
				d.onChange(async (v) => {
					this.plugin.settings.newColour = v;
					await this.plugin.saveSettings();
				});
			});

		const pal = containerEl.createDiv('dsn-palette-settings');
		this.plugin.settings.palette.forEach((c, idx) => {
			const row = new Setting(pal).setClass('dsn-palette-row');
			row.addText((t) => t.setPlaceholder('Name').setValue(c.name).onChange(async (v) => {
				c.name = v;
				await this.plugin.saveSettings();
			}));
			row.addColorPicker((p) => p.setValue(c.light).onChange(async (v) => {
				c.light = v;
				await this.plugin.saveSettings();
				this.plugin.eachView((view) => view.render());
			}));
			row.addColorPicker((p) => p.setValue(c.dark).onChange(async (v) => {
				c.dark = v;
				await this.plugin.saveSettings();
				this.plugin.eachView((view) => view.render());
			}));
			row.addExtraButton((b) => b.setIcon('trash-2').setTooltip('Remove').onClick(async () => {
				this.plugin.settings.palette.splice(idx, 1);
				await this.plugin.saveSettings();
				this.display();
			}));
		});
		new Setting(pal).addButton((b) => b.setButtonText('Add a colour').onClick(async () => {
			this.plugin.settings.palette.push({ name: 'New', light: '#eeeeee', dark: '#333333' });
			await this.plugin.saveSettings();
			this.display();
		}));
		pal.createDiv('setting-item-description').setText(
			'The name is what goes in the frontmatter — the two swatches are the light and the dark '
			+ 'theme. Adding these names under `possible values` on your ∘ color note is what makes '
			+ 'them offered when you type the property by hand; this plugin never writes there.');

		new Setting(containerEl).setName('Housekeeping').setHeading();

		new Setting(containerEl)
			.setName('Collect the empty sticky notes')
			.setDesc('A sticky note with no text, stuck to nothing and linked to by nothing is deleted '
				+ 'when it leaves the view. It goes to your usual deleted-files destination, never '
				+ 'straight to nowhere.')
			.addToggle((t) => t.setValue(this.plugin.settings.collectGarbage).onChange(async (v) => {
				this.plugin.settings.collectGarbage = v;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Collect them even when they are stuck to a file')
			.setDesc('Off, an empty sticky note is kept for ever once it is stuck to something — being '
				+ 'attached counts as being wanted. On, only the text matters: press New and walk away '
				+ 'without writing, and it goes within the minute.')
			.addToggle((t) => t.setValue(this.plugin.settings.collectAttached).onChange(async (v) => {
				this.plugin.settings.collectAttached = v;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Sticky notes kept in the trash view')
			.addSlider((s) => s.setLimits(5, 100, 5).setValue(this.plugin.settings.trashLimit).setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.trashLimit = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Where things are').setHeading();

		const text = (name, desc, key, ph) => new Setting(containerEl).setName(name).setDesc(desc)
			.addText((t) => t.setPlaceholder(ph || '').setValue(this.plugin.settings[key])
				.onChange(async (v) => {
					this.plugin.settings[key] = v.trim();
					this.plugin.index.invalidate();
					await this.plugin.saveSettings();
				}));

		text('Folder for new sticky notes', 'Left empty, they go to the vault root.', 'folder');
		text('Template', 'Poured into every new sticky note, Templater commands included.', 'templatePath');
		text('Base', 'What the Base view shows.', 'basePath');
		text('Name format', 'A Moment format. New sticky notes are named after the moment they were made.',
			'nameFormat');

		new Setting(containerEl).setName('The schema').setHeading();
		containerEl.createDiv('setting-item-description').setText(
			'What this plugin reads out of your notes. These are the OOF names, and nothing here '
			+ 'depends on the OOF plugins being installed.');

		text('Class property', 'The property naming a note\'s class.', 'isAProperty', 'is a');
		text('Sticky note class', 'The class a sticky note is an instance of.', 'stickyClass', 'Sticky Note');
		text('Stuck-to property', 'The property on a sticky note linking to what it is stuck to.',
			'fileProperty', 'file');
		text('Colour property', 'Where the colour name is kept.', 'colorProperty', 'color');
	}
}

/* ------------------------------------------------------------------ plugin */

module.exports = class DynamicStickyNotesPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.index = new Index(this);
		this.activeFile = this.app.workspace.getActiveFile();

		this.registerView(VIEW_TYPE, (leaf) => new StickyView(leaf, this));
		this.addSettingTab(new StickySettingsTab(this.app, this));

		this.addRibbonIcon('sticky-note', 'Dynamic Sticky Notes', () => this.activateView());

		this.addCommand({
			id: 'open-panel',
			name: 'Open the panel',
			callback: () => this.activateView(),
		});
		this.addCommand({
			id: 'new-for-current-file',
			name: 'New sticky note for the current file',
			callback: () => this.newSticky(this.app.workspace.getActiveFile()),
		});
		this.addCommand({
			id: 'new-sticky',
			name: 'New sticky note',
			callback: () => this.newSticky(null),
		});
		this.addCommand({
			id: 'collect-garbage',
			name: 'Collect the empty sticky notes',
			callback: () => this.collectGarbage(false),
		});

		/*
		 * Two events, one guard. Clicking back into a note you already have open
		 * fires no `file-open` — only the leaf changed — and that is exactly when
		 * the panel should come home. Graph Focus met this first; the guard is
		 * what makes listening to both safe, and this panel's own leaf fails both
		 * of its tests, so nothing done inside the panel can move the active file.
		 */
		this.registerEvent(this.app.workspace.on('file-open', () => this.onActiveChanged()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			if (this.isNoteLeaf(leaf)) this.onActiveChanged();
		}));

		this.registerEvent(this.app.metadataCache.on('changed', (file) => this.onVaultChanged(file)));
		this.registerEvent(this.app.vault.on('delete', () => this.onVaultChanged(null)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.eachView((view) => view.renamePath(oldPath, file.path));
			this.onVaultChanged(null);
		}));
		this.registerEvent(this.app.vault.on('create', () => this.index.invalidate()));

		this.app.workspace.onLayoutReady(() => {
			this.index.invalidate();
			this.onActiveChanged();
			/*
			 * A sweep at rest, once the vault is indexed and nothing is mid-write.
			 *
			 * Registered and guarded, because this one deletes files: a bare
			 * `setTimeout` outlives `onunload`, so disabling the plugin inside the
			 * six seconds left a dead instance still holding a timer that would
			 * fire and collect. Found while checking whether collection worked —
			 * a note had gone, and it took a minute to be sure which instance had
			 * taken it.
			 */
			this.registerInterval(window.setTimeout(() => {
				if (this._loaded) this.collectGarbage(true);
			}, 6000));
		});
	}

	onunload() {
		/* The views' own `onClose` unloads the editors; nothing else is installed. */
		window.clearTimeout(this.saveTimer);
		window.clearTimeout(this.changeTimer);
	}

	/* ------------------------------------------------------------ settings */

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
		this.settings.state = Object.assign({ open: [], pinned: [], trash: [] },
			(data && data.state) || {});
		if (!Array.isArray(this.settings.palette) || !this.settings.palette.length) {
			this.settings.palette = DEFAULT_PALETTE.map((c) => Object.assign({}, c));
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* State changes are frequent and worth nothing individually. */
	queueSave() {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.saveSettings(), 500);
	}

	/* ---------------------------------------------------------------- view */

	eachView(fn) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof StickyView) fn(leaf.view);
		}
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return existing[0].view;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
		return leaf.view;
	}

	/*
	 * The file the panel is about.
	 *
	 * `onActiveChanged` deliberately ignores a null active file — revealing this
	 * very panel makes a sidebar leaf active and fires `file-open` with nothing,
	 * and that is not you leaving the note. That rule is right once the panel
	 * knows a note and wrong before it knows any: enabling the plugin while a
	 * sidebar leaf has focus left `activeFile` null for good, and the panel sat
	 * there with no blank card and no way to get one. So a null is filled in
	 * once, from whatever the workspace last had. Found by driving the real
	 * panel over CDP.
	 */
	currentFile() {
		if (!this.activeFile) this.activeFile = this.app.workspace.getActiveFile();
		return this.activeFile;
	}

	isNoteLeaf(leaf) {
		const view = leaf && leaf.view;
		if (!view || !(view.file instanceof TFile)) return false;
		if (typeof leaf.getRoot !== 'function') return true;
		return leaf.getRoot() === this.app.workspace.rootSplit;
	}

	onActiveChanged() {
		/*
		 * Before the two early returns below, not after: the sweep is not about
		 * *which* file is now active, only that you moved. Placed after them,
		 * walking into a sticky note — which is one of the returns — skipped it.
		 */
		this.sweepSoon();
		const file = this.app.workspace.getActiveFile();
		/*
		 * No active file is not "you have left the note". `file-open` also fires
		 * when a **sidebar** leaf becomes active, and at that instant there is no
		 * active file — so revealing this very panel made it forget the note it
		 * was about, and the blank card went with it. The `isNoteLeaf` guard is
		 * on the other event; this is the same rule for this one.
		 */
		if (!file) return;
		/*
		 * A sticky note opened in the main area is a note like any other, but
		 * treating it as "the file you are in" would make the panel try to stick
		 * things to a sticky note. It stays on the file it came from.
		 */
		if (this.index.has(file.path)) return;
		this.activeFile = file;
		this.eachView((view) => view.onActiveFileChanged());
	}

	onVaultChanged(file) {
		this.index.invalidate();
		window.clearTimeout(this.changeTimer);
		this.changeTimer = window.setTimeout(() => {
			this.eachView((view) => view.onVaultChanged());
		}, 120);
	}

	/* -------------------------------------------------------------- colour */

	colourNamed(name) {
		if (!name) return null;
		return this.settings.palette.find((c) => eq(c.name, linkName(name))) || null;
	}

	randomColour() {
		const p = this.settings.palette;
		return p[Math.floor(Math.random() * p.length)];
	}

	/* What a note being made right now should be painted. */
	colourForNew() {
		const choice = this.settings.newColour;
		if (choice === RANDOM) return this.randomColour();
		if (!choice) return null;
		return this.colourNamed(choice);
	}

	async setColour(file, name) {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			if (name) fm[this.settings.colorProperty] = name;
			else delete fm[this.settings.colorProperty];
		});
		this.index.invalidate();
		this.eachView((view) => view.render());
	}

	/* --------------------------------------------------- creating and linking */

	async ensureFolder(path) {
		if (!path) return;
		const p = normalizePath(path);
		if (this.app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
		try {
			await this.app.vault.createFolder(p);
		} catch (e) { /* raced, or exists */ }
	}

	uniqueName() {
		const fmt = this.settings.nameFormat || 'YYYY-MM-DD HH.mm.ss';
		const stamp = window.moment().format(fmt);
		const folder = this.settings.folder ? normalizePath(this.settings.folder) + '/' : '';
		let name = stamp;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(folder + name + '.md')) name = stamp + ' ' + (n++);
		return folder + name + '.md';
	}

	/*
	 * A sticky note, made. The order is the one Bases Table Kanban settled:
	 * create, pour the template (so its Templater commands run), then write the
	 * two keys that are ours — because Templater merges a list-valued key by
	 * concatenating and would append a null to a list already written.
	 */
	async createSticky(target, colourName) {
		await this.ensureFolder(this.settings.folder);
		const path = this.uniqueName();
		const file = await this.app.vault.create(path, '');

		const tplPath = this.settings.templatePath;
		const tpl = tplPath ? this.app.vault.getAbstractFileByPath(normalizePath(tplPath)) : null;
		if (tpl instanceof TFile) {
			try {
				await pourTemplate(this.app, tpl, file);
			} catch (e) {
				console.error('Dynamic Sticky Notes: the template could not be poured', e);
			}
		}

		const s = this.settings;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			const isa = toList(fm[s.isAProperty]);
			if (!isa.some((v) => eq(linkName(v), s.stickyClass))) {
				isa.push(`[[${s.stickyClass}]]`);
				fm[s.isAProperty] = isa;
			}
			if (target) {
				const link = this.app.metadataCache.fileToLinktext(target, file.path);
				const list = toList(fm[s.fileProperty]);
				if (!list.some((v) => eq(linkName(v), target.basename))) list.push(`[[${link}]]`);
				fm[s.fileProperty] = list;
			}
			if (colourName) fm[s.colorProperty] = colourName;
		});
		this.index.invalidate();
		return file;
	}

	/* The button and the command: make one, and put it in the view. */
	async newSticky(target) {
		const colour = this.colourForNew();
		let file;
		try {
			file = await this.createSticky(target, colour ? colour.name : '');
		} catch (e) {
			console.error('Dynamic Sticky Notes: could not create the sticky note', e);
			new Notice('Dynamic Sticky Notes: could not create the sticky note — see the console.');
			return;
		}
		await this.activateView();
		this.index.invalidate();
		this.eachView((v) => {
			v.tab = 'notes';
			v.adopt(file.path);
			v.stuckPaths = new Set(this.index.stickiesFor(this.currentFile()).map((f) => f.path));
			v.focusAfter = file.path;
			v.render();
		});
		return file;
	}

	/* Adding or removing one link in the `file` property. */
	async setStuck(sticky, target, stick) {
		const s = this.settings;
		await this.app.fileManager.processFrontMatter(sticky, (fm) => {
			let list = toList(fm[s.fileProperty]);
			if (stick) {
				const link = this.app.metadataCache.fileToLinktext(target, sticky.path);
				if (!list.some((v) => eq(linkName(v), target.basename))) list.push(`[[${link}]]`);
			} else {
				list = list.filter((v) => !eq(linkName(v), target.basename));
			}
			fm[s.fileProperty] = list;
		});
		this.index.invalidate();
		this.eachView((view) => view.onVaultChanged());
	}

	async deleteSticky(file) {
		await this.app.fileManager.trashFile(file);
		this.index.invalidate();
		this.eachView((view) => view.onVaultChanged());
	}

	/* ------------------------------------------------------------ the base */

	openBaseInTab() {
		const path = this.settings.basePath;
		const file = path ? this.app.vault.getAbstractFileByPath(normalizePath(path)) : null;
		if (!(file instanceof TFile)) {
			new Notice(`Dynamic Sticky Notes: no base at ${path || '(nothing named)'}.`);
			return;
		}
		this.app.workspace.getLeaf('tab').openFile(file);
	}

	/* ------------------------------------------------- garbage collection */

	/*
	 * His sentence: "If a notepad is not linked to by any other note and it
	 * contains no text, then the garbage collection of the plugin will delete
	 * it."
	 *
	 * Six conditions, because this is the only thing here that destroys
	 * anything. It must be a sticky note; its body must be empty; it must be
	 * stuck to nothing; nothing may link to it; it must not be on the screen, in
	 * the panel or in a pane; and it must not have been touched in the last ten
	 * seconds, which is what keeps a sweep from racing a note being made.
	 */
	/*
	 * Every path something in the vault links to, built once.
	 *
	 * It used to be a walk of the whole `resolvedLinks` table **per candidate**,
	 * which is fine for one note and quadratic for a sweep. One pass, one set.
	 */
	incomingSet() {
		const resolved = this.app.metadataCache.resolvedLinks || {};
		const to = new Set();
		for (const from of Object.keys(resolved)) {
			const links = resolved[from];
			if (!links) continue;
			for (const target of Object.keys(links)) {
				if (target !== from) to.add(target);
			}
		}
		return to;
	}

	async collectable(path, incoming) {
		if (!this.settings.collectGarbage) return false;
		const file = this.index.fileAt(path);
		if (!file) return false;
		if (Date.now() - file.stat.mtime < COLLECT_GRACE) return false;
		if (!this.settings.collectAttached && this.index.targetsFor(path).length) return false;
		if ((incoming || this.incomingSet()).has(path)) return false;

		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view && leaf.view.file && leaf.view.file.path === path) return false;
		}
		let onScreen = false;
		this.eachView((view) => {
			if (view.openPaths.indexOf(path) >= 0 || view.pinned.has(path)) onScreen = true;
		});
		if (onScreen) return false;

		const raw = await this.app.vault.cachedRead(file);
		return bodyIsEmpty(raw);
	}

	/*
	 * Tried at the moment a card leaves the view, so nothing empty piles up.
	 *
	 * It is only a *try*: at that moment the note is usually seconds old, so the
	 * grace period refuses it and it goes to the trash view instead. `sweepSoon`
	 * is what comes back for it later — see there.
	 */
	async collectIfEmpty(path) {
		const file = this.index.fileAt(path);
		if (!file) return false;
		if (!(await this.collectable(path))) return false;
		await this.app.fileManager.trashFile(file);
		this.index.invalidate();
		return true;
	}

	/*
	 * The recurring trigger, and the fix for a real gap he found by asking whether
	 * any of this worked.
	 *
	 * Collection used to happen in exactly two places: once, six seconds after
	 * the vault was ready, and at the moment a card left the view. **The second
	 * one can almost never succeed**, because a sticky note leaves the view when
	 * you walk into another file — which is normally seconds after you made it,
	 * inside the grace period. So the note went to the trash view and nothing
	 * ever came back for it: measured on his vault, one empty unlinked sticky
	 * note sat collectable and uncollected until a restart.
	 *
	 * So a sweep also rides his navigation, throttled — the panel is driven by
	 * moving between notes anyway, and something that deletes files should run on
	 * a rhythm you can see rather than on a timer of its own. It says what it
	 * did: a file removed behind your back with no word is the difference between
	 * tidying up and losing a note.
	 */
	sweepSoon() {
		if (!this.settings.collectGarbage) return;
		const now = Date.now();
		if (now - (this.lastSweep || 0) < SWEEP_INTERVAL) return;
		this.lastSweep = now;
		this.registerInterval(window.setTimeout(() => {
			if (this._loaded) this.collectGarbage(true, true);
		}, 400));
	}

	async collectGarbage(silent, announce) {
		if (!this.settings.collectGarbage) {
			if (!silent) new Notice('Dynamic Sticky Notes: collection is switched off in the settings.');
			return 0;
		}
		this.index.invalidate();
		const paths = this.index.all().map((f) => f.path);
		const incoming = this.incomingSet();
		let n = 0;
		for (const p of paths) {
			if (await this.collectable(p, incoming)) {
				const file = this.index.fileAt(p);
				if (file) {
					await this.app.fileManager.trashFile(file);
					n++;
				}
			}
		}
		if (n) {
			this.index.invalidate();
			this.eachView((view) => view.onVaultChanged());
		}
		if (!silent) {
			new Notice(n
				? `Dynamic Sticky Notes: ${n} empty sticky note${n === 1 ? '' : 's'} collected.`
				: 'Dynamic Sticky Notes: nothing to collect.');
		} else if (announce && n) {
			new Notice(`Dynamic Sticky Notes: ${n} empty sticky note${n === 1 ? '' : 's'} collected.`);
		}
		return n;
	}
};

/*
 * Exposed for the test harness in `claude_vault/tools/dsn-tests/`. Obsidian
 * never looks at this; it is here so the rules above can be asserted against
 * without a running app.
 */
module.exports.__test = {
	toList, linkName, linkPath, eq, sameList, planActiveChange, bodyIsEmpty,
	clampHeight, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT,
	Index, DEFAULT_SETTINGS, DEFAULT_PALETTE, RANDOM, VIEW_TYPE,
};
