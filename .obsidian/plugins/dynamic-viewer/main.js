'use strict';

/*
 * Dynamic Viewer
 * ==============
 *
 * From his note `Obsidian/Notes/Dynamic Viewer.md`, which is the second half of
 * `Using dynamic bases.md`:
 *
 *   "This plugin takes a list of bases or bases views as input. It then allows
 *    the user to switch from base to base like switching through tabs. The input
 *    can except simple text links, but it should also be able to accept
 *    functions or formulas (whichever is better for this scenario).
 *
 *    This plugin will allow the creation of mlutiple different *dynamic views*.
 *    Each dynamic view is differentiated by the list of bases which it is fed.
 *    There should be an option right next to each dynamic view to imbed it in
 *    each file. If imbedding is turned on, then each file will have an imbedded
 *    dynamic view at the top of the note. The view will not actually be text in
 *    the file, it will just be a modification of the view. The imbedded dynamic
 *    view will act exactly as if it were in the sidebar. This means that the
 *    active file will be considered as such. I also still want to be able to
 *    edit the bases from this view."
 *
 * The whole plugin rests on one thing Obsidian already does, found by reading the
 * app rather than guessing: `app.embedRegistry.embedByExtension['base']` is the
 * factory behind `![[Some Base.base#a view]]`, and it takes the embedding note's
 * path as `sourcePath`. That path is what `this` resolves to inside the base. So
 * "show me this base as though the note I am reading were the one embedding it"
 * is not something to reimplement - it is the argument.
 *
 *   creator({ app, containerEl, sourcePath, ... }, baseFile, '#view name')
 *
 * The embed it returns owns a real `QueryController`, which is what makes every
 * remaining requirement fall out for nothing:
 *
 *   - the full toolbar (views, filter, properties, sort, search, + New);
 *   - `controller.requestSave` writing back to the `.base` file, which is his
 *     "I also still want to be able to edit the bases from this view";
 *   - `controller.updateCurrentFile(file)`, so following the active note is a
 *     one-line re-query rather than a rebuild;
 *   - `controller.selectView(name)`, so two tabs over one base cost one embed.
 *
 * The one thing that is ours is *which* bases. An entry is either a link written
 * by hand or the call `file.views()` - the function OOF Class Manager gained the
 * same day, which answers "what is this note looked at through" by climbing the
 * note's `is a` and then the `type of` chain above it. His note asked for
 * "functions or formulas (whichever is better)": a function it is, recognised by
 * name rather than parsed, because Obsidian exports no formula parser and one
 * function does not need a grammar. A second one can join it without one either.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, ItemView, FileView, Component, Modal, Menu,
	TFile, Notice, setIcon } = obsidian;

/* ------------------------------------------------- the band as a real embed */

/*
 * CodeMirror, if this build of Obsidian hands it over. Everything that uses it is
 * optional: without it, *In the note's layout* is the only attachment there is,
 * which is what the plugin did before this existed.
 */
let cmView = null;
let cmState = null;
try {
	cmView = require('@codemirror/view');
	cmState = require('@codemirror/state');
} catch (e) {
	cmView = null;
	cmState = null;
}

/*
 * A band drawn the way Obsidian draws `![[Some Base.base]]`: a **block widget
 * decoration**, so it is part of the document rather than a foreign element
 * standing above it - with nothing written into the file.
 *
 * This is the root cause addressed rather than compensated for, which was his
 * reading (2026-09-03) and the measurements agree. Attached this way the band's
 * height is in CodeMirror's height map and `contentDOM.offsetTop` does not grow,
 * so every scroll position corresponds to a real document position and Obsidian's
 * own untouched `getScroll`/`applyScroll` are accurate. Measured on his vault:
 * `offsetTop` 2159 -> 1073, `docHeight` 408 -> 1539, and the round trip
 * 1165/850/535/115px out -> 79/0/0/0, where 79px is what a note with properties
 * and no band does anyway.
 *
 * **A block decoration must come from a StateField, never a ViewPlugin** -
 * CodeMirror throws *"Block decorations may not be specified via plugins"* - and
 * that rule is why this works: heights have to be known to the state before the
 * view renders, which is the very property that makes the height map account for
 * the band, and it is also what removes the race with Obsidian's scroll restoring.
 */
function bandExtension(plugin) {
	if (!cmView || !cmState) return [];
	const { Decoration, WidgetType, EditorView } = cmView;
	const { StateField } = cmState;

	class BandWidget extends WidgetType {
		constructor(generation) { super(); this.generation = generation; }

		/*
		 * There is one band per note and it never becomes a different band, so
		 * widgets compare equal and CodeMirror keeps the DOM it already has -
		 * rebuilding would tear down a live base query on every keystroke.
		 *
		 * The generation is the one thing that can make them differ, and it is
		 * bumped only when the band has been carried off somewhere else (reading
		 * mode owns it between switches) and has to be adopted back.
		 */
		eq(other) { return other.generation === this.generation; }

		/*
		 * The band itself, never a copy: it carries live base queries.
		 *
		 * **Unless the view is in reading mode**, and that exception is the whole
		 * of a bug he found: there is one band element per note, reading mode needs
		 * it inside `.mod-header`, and a widget that hands it over keeps taking it
		 * back every time CodeMirror renders - so the band ended up in the hidden
		 * editor's `.cm-content` at zero height and reading mode had none. The
		 * editor only owns it while the editor is the one being looked at.
		 */
		toDOM(view) {
			const band = plugin.bandForEditor(view);
			const owner = band && band.view;
			const reading = owner && typeof owner.getMode === 'function'
				&& owner.getMode() === 'preview';
			if (band && band.el && !reading) return band.el;
			/* No band for this note, or reading mode has it: a nothing, not a gap. */
			return createDiv({ cls: 'dynamic-viewer-band-placeholder' });
		}

		/*
		 * CodeMirror owns where the element sits, not whether it lives. The band
		 * is a Component owned by the plugin and outlives any number of renders.
		 */
		destroy() {}

		/* The base inside owns its toolbar, menus, search field and drags. */
		ignoreEvent() { return true; }

		/*
		 * What lets the layout be right before the band has ever been measured,
		 * which is what the DOM attachment could not offer: there, the height only
		 * existed once the element had been moved into place, and Obsidian
		 * restored the scroll before that happened.
		 */
		get estimatedHeight() { return plugin.bandHeightHint(); }
	}

	/*
	 * The first line of the body, read from the document rather than from the
	 * metadata cache so that the field stays a pure function of the state.
	 */
	const bodyStart = (doc) => {
		if (doc.lines >= 2 && doc.line(1).text.trim() === '---') {
			for (let i = 2; i <= doc.lines; i++) {
				if (doc.line(i).text.trim() === '---') return Math.min(i + 1, doc.lines);
			}
		}
		return 1;
	};

	/*
	 * Where the band hangs. *Under the properties* is the start of the first body
	 * line, because the title and the properties are not in the document at all -
	 * which is also why *above the file name* cannot be said this way and falls
	 * back to here. *After the body text* is the end of the last line.
	 */
	const build = (state) => {
		if (plugin.settings.editAttach !== 'embed') return Decoration.none;
		const doc = state.doc;
		const bottom = plugin.settings.editPosition === 'bottom';
		const pos = bottom ? doc.line(doc.lines).to : doc.line(bodyStart(doc)).from;
		return Decoration.set([
			Decoration.widget({
				widget: new BandWidget(plugin.bandGeneration),
				block: true,
				side: bottom ? 1 : -1,
			}).range(pos),
		]);
	};

	/*
	 * Recomputed on every transaction rather than only on `docChanged`, because
	 * the answer also depends on a setting and on the generation - and an empty
	 * transaction is how both are announced. It is one range, and `eq()` keeps
	 * CodeMirror from touching the DOM when nothing has really changed.
	 */
	return StateField.define({
		create: (state) => build(state),
		update: (deco, tr) => build(tr.state),
		provide: (field) => EditorView.decorations.from(field),
	});
}

const VIEW_TYPE = 'dynamic-viewer';
/* A dynamic view is a file, and this is what one is called. */
const EXTENSION = 'dview';
/* And the view that opens one in the main window, like `.base` opens `bases`. */
const FILE_VIEW_TYPE = 'dynamic-viewer-file';

/* What the pane is called, and the mark it wears. */
const PANE_NAME = 'Dynamic views';
/*
 * `orbit` rather than a grid: a centre with something going round it is what a
 * dynamic view *is* - the bases turn around whatever note you are standing on.
 * A dashboard glyph says "panels", which is the one thing here that is not the
 * point, and it is also what half the sidebar already looks like.
 */
const PANE_ICON = 'orbit';


/* Below this a base embed has no room to be a table at all. */
const MIN_HEIGHT = 140;

const DEFAULT_SETTINGS = {
	/*
	 * A dynamic view is a `.dview` file, so the settings hold only what a
	 * file must not: which one the pane is showing, and where you left the
	 * furniture. New ones are made here.
	 */
	folder: 'Obsidian/Dynamic Views',
	/* The path of the dynamic view the sidebar is showing. */
	activeView: '',
	/* path -> { collapsed, height }. Never in the file: it would churn on a drag. */
	state: {},
	/*
	 * The paths of the dynamic views, in the order they are drawn.
	 *
	 * Here rather than as an `order:` number in each `.dview`, which was the first
	 * design and was his to correct: a number per file can collide, and two files
	 * both claiming to be second is a state with no right answer. The deeper
	 * reason is the same one in a different form - **an order is a property of the
	 * collection, not of any member**. "Which comes first" is not a fact about
	 * `Base.dview`; a number inside it would be that file making a claim about an
	 * arrangement it cannot see. One list, one place, and no two entries can
	 * disagree.
	 *
	 * The cost, and it is real: the order does not travel with the files the way
	 * `boxes` and the three switches do. A dynamic view this list has never heard
	 * of simply goes at the end, so a copied-in file is placed rather than lost.
	 */
	order: [],
	/*
	 * Where a band sits in the note, one answer per mode: 'title' (above the file
	 * name), 'properties' (under them) or 'bottom' (after the body text).
	 *
	 * Two settings rather than one because the two modes are two different DOMs
	 * with different rules about what may live where, and he reads in one and
	 * writes in the other.
	 */
	editPosition: 'properties',
	readPosition: 'properties',
	/*
	 * How a band is attached in editing mode: 'layout' puts it in the note's
	 * layout beside the properties, 'embed' makes it a block widget inside the
	 * document, the way an `![[...]]` embed is.
	 *
	 * A separate question from *where* it sits, so a separate setting.
	 */
	editAttach: 'embed',
};

/* ------------------------------------------------------------------ helpers */

function makeId() {
	return 'dv-' + Math.random().toString(36).slice(2, 9);
}

/*
 * An entry reduced to the link it names, with the subpath kept - the `#` half is
 * the view inside the base, and dropping it names a different thing to look at.
 * Deliberately the same reduction OOF Class Manager's `viewLink` does, so a link
 * written in a class note and one typed into these settings mean the same.
 */
function viewLink(value) {
	if (value === null || value === undefined) return null;

	let text = String(value).trim();
	if (!text) return null;

	const wikilink = text.match(/^!?\[\[(.+)\]\]$/);
	if (wikilink) text = wikilink[1];

	const pipe = text.indexOf('|');
	if (pipe !== -1) text = text.slice(0, pipe);

	text = text.trim();
	return text || null;
}

/* Where to hang a menu opened from an element rather than from a click. */
function anchorPosition(el) {
	const box = el.getBoundingClientRect();
	return { x: box.left, y: box.bottom + 2 };
}

/*
 * The functions a function box may hold, matched by name rather than parsed:
 * Obsidian exports no formula parser, and a table needs no grammar. A third
 * joins by adding a row here and a branch to `callFunction`.
 *
 * Both are OOF Class Manager's, and they answer two different questions about
 * one note. `file.views()` is what a class *chose* for its instances - a list,
 * possibly empty. `file.classBase()` is the generated base that actually
 * *holds* the note - one base, or none, and it needs nothing written anywhere
 * to be true, which is why it is worth a box of its own: a dynamic view built
 * on it shows the right dashboard for whatever you are standing on.
 */
const FUNCTIONS = [
	{
		name: 'file.views()',
		test: /^file\s*\.\s*views\s*\(\s*\)$/i,
		describe: 'The bases this note is looked at through, from OOF Class Manager.',
	},
	{
		name: 'file.classBase()',
		test: /^file\s*\.\s*classBase\s*\(\s*\)$/i,
		describe: 'The generated base of this note’s class, from OOF Class Manager.',
	},
];

function functionFor(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed) return null;
	return FUNCTIONS.find((fn) => fn.test.test(trimmed)) || null;
}

/*
 * A list box, read.
 *
 * **Two spellings, because this system produces two, and they have to mean the
 * same thing.** Typed by hand or written by the base picker, a list is one entry
 * per line — the way a list property looks in Obsidian's own property editor.
 * Printed by a function, it is what `ListValue.toString()` gives:
 *
 *     [[Improvement Base.base#dynamic project]], [[Backlink Base.base]]
 *
 * — because that method joins with ", " and a `LinkValue` prints itself in
 * brackets (both read off the app's own source). So pasting the output of
 * `file.views()` straight into a list box has to work verbatim, which is his
 * N.B. Both spellings parse to the same list.
 *
 * **A comma only separates outside `[[ ]]`.** A base called `Books, read.base`
 * is a legal file name, and splitting on every comma would cut it in half.
 *
 * A leading `- ` is dropped too, so a YAML list pasted out of frontmatter works.
 */
function parseList(text) {
	const raw = String(text || '');
	const out = [];

	let depth = 0;
	let piece = '';

	const flush = () => {
		const entry = piece.trim().replace(/^[-*]\s+/, '').trim();
		piece = '';
		if (entry) out.push(entry);
	};

	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === '[' && raw[i + 1] === '[') {
			depth++;
			piece += '[[';
			i++;
			continue;
		}
		if (raw[i] === ']' && raw[i + 1] === ']') {
			depth = Math.max(0, depth - 1);
			piece += ']]';
			i++;
			continue;
		}
		if (depth === 0 && (raw[i] === '\n' || raw[i] === ',')) {
			flush();
			continue;
		}
		piece += raw[i];
	}
	flush();

	return out;
}

/*
 * A `.dview` file, read.
 *
 * The file holds what the dynamic view *is*; `data.json` holds where you left
 * the furniture (collapsed, height) keyed by path. That split is the lesson from
 * his own vault: `.base` and `.canvas` are untracked there because Obsidian
 * rewrites `columnSize` and node positions from merely looking at them, and a
 * height dragged once a day must not rewrite a file.
 *
 * Two spellings of a box are read and one is written, the same rule as a list
 * box's contents:
 *
 *     boxes:                          boxes:
 *       - function: file.views()        - kind: function
 *       - list: |-                        value: file.views()
 *           [[A.base#x]]
 *
 * The short one is what `stringifyYaml` gives back, so a file this plugin wrote
 * round-trips exactly; the long one is the shape the settings used to hold, so a
 * file pasted together from an export still loads.
 */
function parseDynamicView(text) {
	let data = null;
	try {
		data = obsidian.parseYaml(text);
	} catch (error) {
		return null;
	}
	if (!data || typeof data !== 'object') data = {};

	const boxes = [];
	for (const entry of (Array.isArray(data.boxes) ? data.boxes : [])) {
		if (!entry || typeof entry !== 'object') continue;

		if (typeof entry.list === 'string') { boxes.push(makeBox('list', entry.list)); continue; }
		if (typeof entry['function'] === 'string') {
			boxes.push(makeBox('function', entry['function']));
			continue;
		}
		if (typeof entry.value === 'string') {
			boxes.push(makeBox(entry.kind === 'function' ? 'function' : 'list', entry.value));
		}
	}

	return {
		boxes: boxes,
		embed: !!data.embed,
		stacked: !!data.stacked,
		/* `!== false`, so a file written before this key existed gets the default. */
		hideEmpty: data.hideEmpty !== false,
	};
}

/* And written. The short spelling, and nothing that belongs in `data.json`. */
function serialiseDynamicView(dynamic) {
	return obsidian.stringifyYaml({
		boxes: dynamic.boxes.map((box) => (box.kind === 'function'
			? { 'function': box.value }
			: { list: box.value })),
		embed: !!dynamic.embed,
		stacked: !!dynamic.stacked,
		hideEmpty: !!dynamic.hideEmpty,
	});
}

/* What a list box is written back as: one entry per line, the property spelling. */
function writeList(entries) {
	return entries.join('\n');
}

function makeBox(kind, value) {
	return { id: makeId(), kind: kind === 'function' ? 'function' : 'list', value: value || '' };
}

/*
 * A dynamic view's boxes, whatever shape the stored one is in.
 *
 * Before v1.4 a dynamic view was one flat `entries` array with function calls
 * mixed in among the links. That converts by walking it once: runs of links
 * become a list box, each function becomes its own function box, and the order
 * is preserved — which is the order the tabs come out in.
 */
function boxesOf(dynamic) {
	if (Array.isArray(dynamic.boxes)) {
		return dynamic.boxes
			.filter((box) => box && typeof box === 'object')
			.map((box) => ({
				id: box.id || makeId(),
				kind: box.kind === 'function' ? 'function' : 'list',
				value: typeof box.value === 'string' ? box.value : '',
			}));
	}

	const boxes = [];
	let list = null;

	for (const entry of (Array.isArray(dynamic.entries) ? dynamic.entries : [])) {
		const text = String(entry || '').trim();
		if (!text) continue;

		if (functionFor(text)) {
			boxes.push(makeBox('function', text));
			list = null;
			continue;
		}

		if (!list) {
			list = makeBox('list', '');
			boxes.push(list);
		}
		list.value = list.value ? list.value + '\n' + text : text;
	}

	return boxes;
}

/* `Improvement Base.base#dynamic project` in its two halves. */
function splitViewLink(text) {
	const hash = String(text).indexOf('#');
	return hash === -1
		? { target: String(text).trim(), view: '' }
		: {
			target: String(text).slice(0, hash).trim(),
			view: String(text).slice(hash + 1).trim(),
		};
}

/*
 * A name, asked for. Used to make a dynamic view and to rename one — the two
 * places a dynamic view's identity is decided, and a dynamic view's identity is
 * its name.
 */
class PromptModal extends Modal {
	constructor(app, title, value, cta, onSubmit) {
		super(app);
		this.promptTitle = title;
		this.value = value;
		this.cta = cta;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.titleEl.setText(this.promptTitle);

		const input = this.contentEl.createEl('input', {
			cls: 'dynamic-viewer-prompt-input',
			attr: { type: 'text', placeholder: 'Name' },
		});
		input.value = this.value || '';

		const submit = () => {
			const name = input.value.trim();
			if (!name) return;
			this.close();
			this.onSubmit(name);
		};

		input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			submit();
		});

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(this.cta).setCta().onClick(submit))
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));

		window.setTimeout(() => { input.focus(); input.select(); }, 0);
	}

	onClose() { this.contentEl.empty(); }
}

/*
 * The one destructive thing in this plugin. A dynamic view is only a list of
 * links, but it is a list you assembled, and a setting has no undo.
 */
class ConfirmModal extends Modal {
	constructor(app, title, message, cta, onConfirm) {
		super(app);
		this.promptTitle = title;
		this.message = message;
		this.cta = cta;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		this.titleEl.setText(this.promptTitle);
		this.contentEl.createEl('p', { text: this.message });

		new Setting(this.contentEl)
			.addButton((button) => button
				.setButtonText(this.cta)
				.setWarning()
				.onClick(() => { this.close(); this.onConfirm(); }))
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------- panel */

/*
 * One dynamic view, drawn: a strip of tabs over one live base embed.
 *
 * It is a Component rather than a view so that the sidebar and every embedded
 * band can be the same object. His note says the embedded one "will act exactly
 * as if it were in the sidebar" - the cheapest way to keep that promise is for
 * there to be only one thing that draws.
 */
class DynamicPanel extends Component {
	constructor(plugin, containerEl) {
		super();
		this.plugin = plugin;
		this.containerEl = containerEl;

		this.dynamic = null;
		this.file = null;

		this.entries = [];
		this.signature = null;
		this.selected = '';

		/* Every base embed currently mounted: one with tabs, all of them stacked. */
		this.embeds = [];
		this.token = null;
	}

	onload() {
		this.containerEl.addClass('dynamic-viewer');
		this.tabsEl = this.containerEl.createDiv({ cls: 'dynamic-viewer-tabs' });
		this.bodyEl = this.containerEl.createDiv({ cls: 'dynamic-viewer-body' });
	}

	onunload() {
		this.dropEmbeds();
		this.containerEl.empty();
		this.containerEl.removeClass('dynamic-viewer');
	}

	/* Which dynamic view, and which note it is being asked about. */
	setSource(dynamic, file) {
		const changed = !this.dynamic || !dynamic || this.dynamic.id !== dynamic.id;
		this.dynamic = dynamic || null;
		this.file = file instanceof TFile ? file : null;
		if (changed) {
			this.signature = null;
			this.selected = '';
		}
		this.refresh();
	}

	setFile(file) {
		const next = file instanceof TFile ? file : null;
		if (next === this.file) return;
		this.file = next;
		this.refresh();
	}

	/*
	 * The list is re-resolved every time, because `file.views()` is a different
	 * answer for every note - which is the whole point of a *dynamic* view.
	 *
	 * When the answer has not changed, the embeds are kept and only told which
	 * note they are now about: `updateCurrentFile` re-runs the query in place,
	 * where a rebuild would throw away scroll position, sort and search on every
	 * click.
	 */
	refresh() {
		const entries = this.dynamic
			? this.plugin.resolveBoxes(this.dynamic, this.file)
			: [];

		/*
		 * The layout is part of the signature. Switching between tabs and a stack
		 * is a different set of embeds over the same list, so it has to count as a
		 * change even when not one link moved.
		 */
		const signature = (this.stacked() ? 'stack|' : 'tabs|')
			+ (this.dynamic && this.dynamic.hideEmpty ? 'hide|' : 'show|')
			+ entries.map((entry) => entry.link).join(' ');

		if (signature === this.signature) {
			this.entries = entries;
			this.reaim();
			return;
		}

		this.signature = signature;
		this.entries = entries;

		if (this.stacked()) {
			this.drawTabs();
			this.drawStack();
			return;
		}

		/* Keep the tab he was on when it survived the change of note. */
		if (!entries.some((entry) => entry.link === this.selected)) {
			this.selected = entries.length > 0 ? entries[0].link : '';
		}

		this.drawTabs();
		this.show(this.entryFor(this.selected));
	}

	/* Every dynamic view is one or the other; nothing here is global. */
	stacked() {
		return !!(this.dynamic && this.dynamic.stacked);
	}

	/* Tell whatever is mounted which note it is now about. */
	reaim() {
		for (const mounted of this.embeds) {
			if (mounted.embed && mounted.embed.controller) {
				mounted.embed.controller.updateCurrentFile(this.file);
			}
		}
	}

	entryFor(link) {
		return this.entries.find((entry) => entry.link === link) || null;
	}

	/*
	 * The bases actually on the screen, each with the name its tab carries.
	 *
	 * Tabbed, that is the one being looked at; stacked, it is all of them - the
	 * same question answered by the same code, because "the current base" in a
	 * stack is every base, and a menu with three of them is honest where a menu
	 * with one guessed one is not.
	 */
	basesOn() {
		const list = this.stacked()
			? this.entries.slice()
			: [this.entryFor(this.selected) || this.entries[0]].filter(Boolean);
		return list.map((entry) => ({ entry: entry, label: this.labelFor(entry) }));
	}

	/*
	 * One tab per entry, and nothing else.
	 *
	 * **There is no `+` here** (2026-09-02, his ask): *"the point is to give
	 * information and not to make changes."* A tab strip that also offers to edit
	 * the thing it describes is clutter in the one place that should be quiet, and
	 * a band drawn on every note repeats that clutter on every note. Changing a
	 * dynamic view happens in the pane's menu and in the settings, which the button
	 * at the top right of each surface leads to.
	 *
	 * So the strip is hidden outright when it has no tabs to hold - stacked, where
	 * every base is already on the screen, or empty.
	 */
	drawTabs() {
		this.tabsEl.empty();
		this.tabsEl.toggleClass('is-stacked', this.stacked());
		this.tabsEl.toggleClass('is-empty',
			!this.dynamic || this.stacked() || this.entries.length === 0);
		if (!this.dynamic) return;

		if (!this.stacked()) {
			for (const entry of this.entries) {
				const tab = this.tabsEl.createDiv({ cls: 'dynamic-viewer-tab' });
				tab.toggleClass('is-active', entry.link === this.selected);
				tab.toggleClass('is-missing', !entry.file);

				setIcon(tab.createSpan({ cls: 'dynamic-viewer-tab-icon' }),
					entry.file ? 'layout-list' : 'file-question');
				tab.createSpan({ cls: 'dynamic-viewer-tab-label', text: this.labelFor(entry) });

				tab.setAttribute('aria-label', entry.link);

				tab.addEventListener('click', () => {
					if (this.selected === entry.link) return;
					this.selected = entry.link;
					this.drawTabs();
					this.show(entry);
				});
			}
		}

	}

	/*
	 * A tab is named by the view it points at, because that is the half he chose
	 * when he wrote the link; a bare base falls back to the base's own name.
	 */
	labelFor(entry) {
		if (entry.view) return entry.view;
		return entry.file ? entry.file.basename : entry.target;
	}

	/*
	 * Every base at once, one under another, each named by the same label its tab
	 * would have carried.
	 *
	 * A base embed has no height of its own - it fills whatever it is given - so
	 * each one is given `dynamic.height`, the same number the band already uses,
	 * and dragging any of them sets it for all of them. **One height per dynamic
	 * view rather than one per base**: they are a set being read together, and a
	 * stack of different heights reads as a mistake rather than as a choice.
	 */
	drawStack() {
		this.dropEmbeds();
		this.bodyEl.addClass('is-stacked');

		if (this.entries.length === 0) {
			this.drawEmpty();
			return;
		}

		const height = Math.max(MIN_HEIGHT,
			Number(this.dynamic && this.dynamic.height) || 320);

		for (const entry of this.entries) {
			const item = this.bodyEl.createDiv({ cls: 'dynamic-viewer-stack-item' });

			const head = item.createDiv({ cls: 'dynamic-viewer-stack-head' });
			setIcon(head.createSpan({ cls: 'dynamic-viewer-tab-icon' }),
				entry.file ? 'layout-list' : 'file-question');
			head.createSpan({ cls: 'dynamic-viewer-stack-name', text: this.labelFor(entry) });
			head.setAttribute('aria-label', entry.link);
			head.toggleClass('is-missing', !entry.file);

			const host = item.createDiv({ cls: 'dynamic-viewer-embed' });
			host.style.height = height + 'px';

			if (!entry.file) {
				host.createDiv({
					cls: 'dynamic-viewer-notice',
					text: 'No base called "' + entry.target + '" was found.',
				});
				continue;
			}

			const embed = this.createEmbed(host, entry);
			if (embed) this.plugin.watchHeight(host, this.dynamic);
		}
	}

	show(entry) {
		if (!entry) {
			this.dropEmbeds();
			this.drawEmpty();
			return;
		}

		if (!entry.file) {
			this.dropEmbeds();
			this.drawMissing(entry);
			return;
		}

		/*
		 * Two tabs over one base is one embed: the controller can change view on
		 * its own, and rebuilding would drop everything the view remembers.
		 *
		 * **Only when the body is already one embed**, which is read off the class
		 * `drawStack` and `dropEmbeds` maintain rather than off a flag beside it.
		 * Coming back from a stack, `embeds[0]` is the first *stacked* base and its
		 * file matches the first tab, so the reuse branch was taken and the other
		 * two were left mounted underneath.
		 */
		const single = this.embeds.length === 1
			&& !this.bodyEl.classList.contains('is-stacked');
		const live = single ? this.embeds[0] : null;
		if (live && live.file === entry.file && live.embed && live.embed.controller) {
			live.embed.controller.updateCurrentFile(this.file);
			live.embed.controller.selectView(entry.view || this.firstViewName(live.embed));
			return;
		}

		this.dropEmbeds();
		const host = this.bodyEl.createDiv({ cls: 'dynamic-viewer-embed' });
		this.createEmbed(host, entry);
	}

	firstViewName(embed) {
		const controller = embed && embed.controller;
		if (!controller || typeof controller.getQueryViewNames !== 'function') return '';
		const names = controller.getQueryViewNames();
		return names.length > 0 ? names[0] : '';
	}

	/*
	 * One base embed in one container - the whole surface with tabs, one of a
	 * stack without them. Everything about building one is here so the two
	 * layouts cannot come to disagree about how a base is opened.
	 */
	createEmbed(host, entry) {
		const creator = this.plugin.baseEmbedFactory();
		if (!creator) {
			host.createDiv({
				cls: 'dynamic-viewer-notice',
				text: 'This Obsidian version does not expose the base embed factory, '
					+ 'so a base cannot be shown here.',
			});
			return null;
		}

		let embed;
		try {
			embed = creator({
				app: this.plugin.app,
				containerEl: host,
				sourcePath: this.file ? this.file.path : '',
				linktext: entry.link,
				depth: 0,
				showInline: false,
				displayMode: true,
			}, entry.file, entry.view ? '#' + entry.view : '');
		} catch (error) {
			console.error('dynamic-viewer: could not build the embed for ' + entry.link, error);
			host.empty();
			host.createDiv({
				cls: 'dynamic-viewer-notice',
				text: 'Could not open ' + entry.link + '.',
			});
			return null;
		}

		const mounted = { link: entry.link, file: entry.file, embed: embed };
		this.embeds.push(mounted);
		this.addChild(embed);

		const token = this.token;
		Promise.resolve(embed.loadFile()).catch((error) => {
			console.error('dynamic-viewer: ' + entry.link + ' failed to load', error);
		}).then(() => {
			/* Something drawn while this was in flight owns the body now. */
			if (token !== this.token) return;
			if (entry.view && embed.controller) embed.controller.selectView(entry.view);
		});

		return embed;
	}

	dropEmbeds() {
		this.token = {};
		for (const mounted of this.embeds) {
			if (mounted.embed) this.removeChild(mounted.embed);
		}
		this.embeds = [];
		if (this.bodyEl) {
			this.bodyEl.empty();
			this.bodyEl.removeClass('is-stacked');
		}
	}

	/*
	 * Nothing to draw.
	 *
	 * **With *Hide it when there is nothing to show* on, that is drawn as nothing
	 * at all** (2026-09-01, his ask): a dynamic view fed by `file.views()` is empty
	 * on most notes, so a band at the top of every note was offering him a purple
	 * button on every note that is not a Project. The band skips the section
	 * entirely; here in the pane the body is simply left blank.
	 *
	 * The way in does not go with it: the `+` on the strip above **takes a label**
	 * whenever there are no tabs, so an empty pane still says *Add a base* - just
	 * in the row where adding one already lives, rather than in the middle of the
	 * pane where it was in the way.
	 *
	 * It says nothing about *why* the list came back empty either. Where the list
	 * came from - typed by hand, or answered by a function belonging to another
	 * plugin - is not this pane's story to tell.
	 */
	drawEmpty() {
		if (!this.dynamic) {
			this.bodyEl.createDiv({
				cls: 'dynamic-viewer-empty',
			}).createDiv({
				cls: 'dynamic-viewer-notice',
				text: 'No dynamic view is selected.',
			});
			return;
		}

		if (this.dynamic.hideEmpty) return;

		this.bodyEl.createDiv({ cls: 'dynamic-viewer-empty' })
			.createDiv({
				cls: 'dynamic-viewer-notice',
				text: 'No bases in this dynamic view yet.',
			});
	}

	drawMissing(entry) {
		this.bodyEl.createDiv({
			cls: 'dynamic-viewer-notice',
			text: 'No base called "' + entry.target + '" was found.',
		});
	}
}

/* ------------------------------------------------------------ the side pane */

class DynamicViewerPane extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getIcon() { return PANE_ICON; }

	/*
	 * The pane's name, not the current dynamic view's. A pane is named for what it
	 * is; *which* dynamic view is showing is what the pills above it say - and they
	 * appear exactly when there is more than one, which is the only time the
	 * question comes up.
	 */
	getDisplayText() { return PANE_NAME; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('dynamic-viewer-pane');

		this.pickerEl = root.createDiv({ cls: 'dynamic-viewer-picker' });
		this.panel = new DynamicPanel(this.plugin, root.createDiv({ cls: 'dynamic-viewer-host' }));
		this.addChild(this.panel);

		/*
		 * The way to change anything, in the one place Obsidian puts a pane's own
		 * controls. Nothing in the body of this pane edits: it reports.
		 */
		this.addAction('settings', 'Dynamic Viewer settings',
			() => this.plugin.openSettings());

		this.drawPicker();
		this.panel.setSource(this.plugin.activeDynamic(), this.plugin.noteFile);

		/*
		 * Both events, guarded on the leaf - the lesson Graph Focus learnt and OOF
		 * Class Manager reuses. Clicking back into a note already open fires no
		 * `file-open`, and this pane's own leaf becoming active must never be
		 * mistaken for a note.
		 */
		this.registerEvent(this.app.workspace.on('file-open', () => this.follow()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
	}

	follow() {
		if (this.panel) this.panel.setFile(this.plugin.noteFile);
	}

	/* Redrawn from the settings tab, and when a dynamic view is renamed. */
	rebuild() {
		if (!this.panel) return;
		this.drawPicker();
		this.panel.setSource(this.plugin.activeDynamic(), this.plugin.noteFile);
	}

	/*
	 * The dynamic views themselves — the level above the tabs. A dynamic view is a
	 * list of base views, so this row is the list of lists, and it carries its own
	 * `+`.
	 *
	 * It is drawn even for a single dynamic view, so the pane always says which one
	 * it is showing. **It carries no `+`**: making a dynamic view is a change, and
	 * changes live in the menu on a pill and in the settings, which the gear in the
	 * pane's own header opens.
	 */
	drawPicker() {
		this.pickerEl.empty();

		for (const dynamic of this.plugin.dynamicViews()) {
			const active = dynamic.id === this.plugin.settings.activeView;
			const pill = this.pickerEl.createDiv({ cls: 'dynamic-viewer-pill' });
			pill.toggleClass('is-active', active);

			pill.createSpan({
				cls: 'dynamic-viewer-pill-label',
				text: dynamic.name || 'Untitled',
			});

			/* A mark for one that is also drawn at the top of every note. */
			if (dynamic.embed) {
				setIcon(pill.createSpan({ cls: 'dynamic-viewer-pill-mark' }), 'pin');
			}

			pill.setAttribute('aria-label', this.plugin.describeBoxes(dynamic));

			pill.addEventListener('click', () => {
				if (active) {
					/* Already on it, so the click is asking what else it can do. */
					this.plugin.dynamicMenu(dynamic, pill);
					return;
				}
				this.plugin.settings.activeView = dynamic.path;
				this.plugin.saveSettings();
				this.rebuild();
			});

			/*
			 * One menu with two ways in — right-click any pill, or click the one you
			 * are already on. Two menus over one dynamic view would be two places to
			 * add the next item to, and the one you forget is the one he opens.
			 */
			pill.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				this.plugin.dynamicMenu(dynamic, event);
			});
		}

	}
}

/* -------------------------------------------------------- the embedded band */

/*
 * The band inside one note: every dynamic view whose *embed* switch is on, one
 * section each, collapsible.
 *
 * It sits **under the properties, inside the note's own scroll area**, so it
 * moves with the note instead of taking a strip off the top of the pane for ever
 * - his ask, and the more literal reading of his original note's "at the top of
 * the note". Nothing is written into the file; this is only a decoration.
 *
 * That means living in CodeMirror's DOM, which is rebuilt underneath anything
 * put there. `anchorFor` reads the tree live every time, `mount` is idempotent,
 * and a MutationObserver on the sizer puts the band back if it is carried away.
 */
class EmbedBand extends Component {
	constructor(plugin, leaf) {
		super();
		this.plugin = plugin;
		this.leaf = leaf;
		this.panels = new Map();
		/* id -> the chrome of that section, kept across syncs. */
		this.sections = new Map();
		this.el = null;
		this.observer = null;
		this.watched = null;
		this.remounting = false;
		/* The ids of the sections currently drawn, so a file change can tell. */
		this.drawn = null;
	}

	get view() { return this.leaf && this.leaf.view; }

	onload() {
		this.el = createDiv({ cls: 'dynamic-viewer-band' });
		this.mount();
		this.sync();
	}

	onunload() {
		for (const panel of this.panels.values()) this.removeChild(panel);
		this.panels.clear();
		this.sections.clear();
		this.watch(null);
		if (this.el) this.el.remove();
		this.el = null;
	}

	/*
	 * Where the band goes, per mode, from `editPosition` / `readPosition`.
	 *
	 * Three places, and they are the same three in both modes (his ask,
	 * 2026-09-03): above the file name, under the properties, or after the body
	 * text. They are two settings rather than one because the two modes are two
	 * different DOMs with different rules, and he reads in one and writes in the
	 * other.
	 *
	 * `after the body text` is worth knowing about beyond taste: in editing mode
	 * it is the only one of the three that does not sit between the top of the
	 * scroller and the first line, and Obsidian's own scroll <-> line mapping
	 * cannot represent positions in that stretch. Measured on his vault, the
	 * round-trip drift is 1165px above the text and 79px below it - and 79px is
	 * what a note with properties and no band does anyway.
	 */
	anchorFor() {
		const view = this.view;
		if (!view || !view.contentEl) return null;

		const reading = typeof view.getMode === 'function' && view.getMode() === 'preview';
		const root = view.contentEl.querySelector(reading
			? ':scope > .markdown-reading-view'
			: ':scope > .markdown-source-view');
		if (!root) return null;

		return reading ? this.readingAnchor(root) : this.editingAnchor(root);
	}

	/*
	 * Editing and live preview: `.cm-sizer`, whose children CodeMirror leaves
	 * alone - it virtualises inside `.cm-content`, not here - so all three places
	 * are ordinary siblings and none of them is ever carried away.
	 */
	editingAnchor(root) {
		/*
		 * Attached as an embed, the band's place is CodeMirror's to decide - it is
		 * a block widget inside the document, so there is nothing to insert here.
		 */
		if (this.plugin.settings.editAttach === 'embed' && cmView && cmState) {
			return { widget: true };
		}

		const sizer = root.querySelector(':scope > .cm-editor > .cm-scroller > .cm-sizer');
		if (!sizer) return null;

		/*
		 * The properties are wrapped, so the anchor is *whichever child of the
		 * sizer contains them* rather than the container itself.
		 */
		const childHolding = (selector) => {
			let node = sizer.querySelector(selector);
			while (node && node.parentElement !== sizer) node = node.parentElement;
			return node === this.el ? null : node;
		};

		const where = this.plugin.settings.editPosition;
		if (where === 'title') return { parent: sizer, after: null };
		if (where === 'bottom') {
			const body = childHolding('.cm-contentContainer');
			return body ? { parent: sizer, after: body } : { parent: sizer, append: true };
		}
		return {
			parent: sizer,
			after: childHolding('.metadata-container') || childHolding('.inline-title') || null,
		};
	}

	/*
	 * Reading mode, where the rule is one sentence: **never a direct child of
	 * `.markdown-preview-sizer`.**
	 *
	 * Those children are the preview renderer's own sections and it virtualises
	 * them, taking them out of the document as they scroll off. Measured on his
	 * vault: a band placed as a sibling of `.mod-header` in there was detached at
	 * 7 of 7 scroll positions, and only our MutationObserver ever put it back -
	 * 85 re-mounts in 7 seconds, each moving the scroll by the band's own height,
	 * which is the jitter he reported.
	 *
	 * So each place is either outside the sizer entirely, or *inside* one of the
	 * renderer's own elements rather than beside it:
	 *
	 * - above the file name -> first child of `.markdown-preview-view`, the
	 *   scroller, which belongs to nobody. 0 detachments over 7 stops.
	 * - under the properties -> **inside** `.mod-header`, which the renderer keeps
	 *   in the document throughout (present at 13 of 13 stops) and measures live,
	 *   so it accounts for our height instead of fighting it. 0 detachments.
	 * - after the body text -> last child of the scroller. **This lands below the
	 *   backlinks**, not between them and the text, because that gap is inside the
	 *   sizer: a band inside `.mod-footer` was detached at 11 of 13 stops, and the
	 *   footer itself was only in the document at 2 of them.
	 */
	readingAnchor(root) {
		const scroller = root.querySelector(':scope > .markdown-preview-view');
		if (!scroller) return null;

		const where = this.plugin.settings.readPosition;
		if (where === 'title') return { parent: scroller, after: null };
		if (where === 'bottom') return { parent: scroller, append: true };

		/*
		 * The header has been there every time it was looked for; the fallback is
		 * here so that a band never simply vanishes if it one day is not.
		 */
		const header = scroller.querySelector('.markdown-preview-sizer > .mod-header');
		return header ? { parent: header, append: true } : { parent: scroller, after: null };
	}
	/*
	 * Read the container live and mount on use: a view's DOM is Obsidian's, and it
	 * is rebuilt often enough that a remembered parent goes quietly dead.
	 *
	 * Idempotent by construction rather than by a flag — already being in the right
	 * place is the common case, checked on every sync and on every mutation of the
	 * sizer, and a flag saying "I am painting" would be cleared before a
	 * MutationObserver record ever arrived.
	 */
	mount() {
		const spot = this.anchorFor();
		if (!spot) return false;

		/*
		 * CodeMirror is holding it. Nothing to insert and nothing to watch - but
		 * reading mode takes the element away between mode switches, and the
		 * decoration still compares equal, so the editor has to be told to ask for
		 * it again.
		 */
		if (spot.widget) {
			this.watch(null);
			const view = this.view;
			const cm = view && view.editor && view.editor.cm;
			if (cm && !cm.contentDOM.contains(this.el)) {
				this.plugin.reclaimBands();
				/*
				 * Arriving back from reading mode, which is the one moment the two
				 * modes disagree about the band: reading counts it as header, above
				 * the first line, while the editor counts it as document. That makes
				 * one scroll value mean two different places, and Obsidian carries a
				 * scroll value across. So the same repair the other attachment needs
				 * on every switch is needed here on this one.
				 */
				this.restoreScroll();
			}
			return true;
		}

		/*
		 * Coming back from the editor's own hands. In reading mode the band belongs
		 * in `.mod-header`, but a CodeMirror widget may still be holding it and
		 * would re-adopt it on its next render; asking for the widgets to be built
		 * again is what makes it let go, because `toDOM` declines while the view is
		 * in reading mode.
		 */
		const held = this.view && this.view.editor && this.view.editor.cm;
		if (held && held.contentDOM.contains(this.el)) this.plugin.reclaimBands();

		this.watch(spot.parent);

		/* Already in the right place is the common case, and the cheapest test of
		 * it is what would be beside us if we were. */
		const here = spot.append ? spot.parent.lastElementChild
			: (spot.after ? spot.after.nextElementSibling : spot.parent.firstElementChild);
		if (here === this.el) return true;

		/* Where it was, so that a *move* can be told from a first appearance. */
		const from = this.el.parentElement;

		if (spot.append) spot.parent.appendChild(this.el);
		else if (spot.after) spot.after.insertAdjacentElement('afterend', this.el);
		else spot.parent.prepend(this.el);

		if (from && from !== spot.parent) this.restoreScroll();
		return true;
	}

	/*
	 * Put the scroll back where the mode change meant to leave it.
	 *
	 * Obsidian restores the scroll on a mode change **before** the band has moved
	 * into the mode being switched to, so it computes against a layout that is
	 * missing the band and everything lands wrong by roughly its height. Caught
	 * frame by frame: at the moment the view reports `source` again the band is
	 * still in `mod-header` and the scroll is right (630); a few frames later the
	 * band arrives in `.cm-sizer` and it is 313.
	 *
	 * `view.scroll` is the line Obsidian carried across, and it survives both
	 * switches intact - 8.46 from beginning to end - so the repair is simply to
	 * apply it again now that the layout is the one it was meant for.
	 *
	 * Only after a *move*, never after a first mount: appearing in a note is not a
	 * mode change, and re-aiming the scroll of a note that was just opened would
	 * undo whatever opened it - a link to a heading, a search result.
	 */
	restoreScroll() {
		const view = this.view;
		const n = view && view.scroll;
		if (typeof n !== 'number' || !Number.isFinite(n)) return;

		/*
		 * Until it sticks, rather than a fixed number of goes.
		 *
		 * Obsidian's own last correction lands after the first attempt, so one is
		 * never enough; and coming back to a long note the position wanted can be
		 * past the end of a document CodeMirror is still growing, in which case the
		 * browser clamps and the attempt is silently lost - measured landing 1217
		 * and 2810px short at 70% and 90% of a long note. So it retries while the
		 * write does not take, and stops the moment it does.
		 *
		 * It also stands down if the position moved to somewhere it did not put it:
		 * that is him scrolling, and his scroll outranks this repair.
		 */
		let tries = 0;
		let mine = null;
		const put = () => {
			if (this.stale()) return;

			if (view.getMode() === 'preview') {
				/* The preview renderer's own arithmetic is exact - measured 0 drift
				 * at every position - so there is nothing to reimplement here. */
				if (view.currentMode && typeof view.currentMode.applyScroll === 'function') {
					view.currentMode.applyScroll(n);
				}
				return;
			}

			const cm = view.editor && view.editor.cm;
			const px = this.scrollPixelFor(cm, n);
			if (px === null) return;

			const scroller = cm.scrollDOM;
			if (mine !== null && Math.abs(scroller.scrollTop - mine) > 4) return;

			scroller.scrollTop = px;
			mine = scroller.scrollTop;
			if (Math.abs(scroller.scrollTop - px) > 2 && tries++ < 10) {
				window.setTimeout(put, 60);
			}
		};
		window.requestAnimationFrame(put);
		window.setTimeout(put, 60);
	}

	/*
	 * Which pixel of the editor's scroller shows line `n`.
	 *
	 * This is `MarkdownView`'s own `applyScroll` arithmetic with its gate removed.
	 * That method takes its exact path only when the target line is **already
	 * rendered**, and with a band above the text the top of the note maps onto the
	 * frontmatter, which live preview never renders - so it falls back to
	 * `scrollIntoView` and lands at "first line just visible" instead. Measured
	 * against the position it was asked for: Obsidian is 1165px out at the top of
	 * the note, 850 and 535 and 115 further down, and exact only once the text is
	 * on screen; the formula below is 0 at every one of those.
	 *
	 * The height map answers `lineBlockAt` whether or not a line is drawn, which is
	 * the whole reason this works where the gate does not.
	 */
	scrollPixelFor(cm, n) {
		if (!cm || !cm.state || !cm.contentDOM) return null;
		const doc = cm.state.doc;
		let value = n;
		if (value < 0) value = 0;
		if (value >= doc.lines) value = doc.lines - 0.99;

		const whole = Math.floor(value);
		const fraction = value - whole;
		const line = doc.line(whole + 1);
		const block = cm.lineBlockAt(line.from);
		const firstLine = doc.lineAt(block.from).number - 1;
		const lines = doc.lineAt(block.to).number - 1 - firstLine + 1;

		let top = block.top;
		let height = block.height;
		const above = cm.contentDOM.offsetTop;
		/* Everything above the first line - title, properties, us - is folded into
		 * the height of block 0, which is what makes a scroll of "line 0 and a bit"
		 * mean a position inside it. */
		if (firstLine === 0) height += above;
		else top += above;

		return top + (whole - firstLine + fraction) * (height / Math.max(1, lines));
	}


	/*
	 * The container's children are not ours: CodeMirror rebuilds the sizer's, and a
	 * mode change swaps the container outright, either without a workspace event.
	 * So whatever the band is mounted in is watched, and anything that changes its
	 * children re-runs the idempotent mount.
	 *
	 * This is a net rather than a motor. It used to be the *only* thing keeping the
	 * band on screen in reading mode, where the renderer took it out again every
	 * few frames — a loop, not a safety net. Nothing should now make it fire in a
	 * steady state; if it does, the mount point is wrong again.
	 */
	watch(parent) {
		if (this.watched === parent) return;

		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		this.watched = parent || null;
		if (!parent) return;

		this.observer = new MutationObserver(() => {
			if (this.remounting) return;
			this.remounting = true;
			window.requestAnimationFrame(() => {
				this.remounting = false;
				if (this.el && !this.stale()) this.mount();
			});
		});
		this.observer.observe(parent, { childList: true });
	}

	stale() {
		const view = this.view;
		return !view || !(view.file instanceof TFile) || !view.containerEl;
	}

	/*
	 * The dynamic views this note should carry a section for.
	 *
	 * Not simply "the embedded ones": one that hides itself when it has nothing to
	 * show has to be asked about *this* note, because a dynamic view fed by
	 * `file.views()` is empty on most notes and full on a few. Resolving the boxes
	 * costs a walk of the frontmatter and no embed at all, so it is cheap enough to
	 * ask on every file change - which is when the answer changes.
	 */
	wanted() {
		const file = this.view && this.view.file;
		return this.plugin.dynamicViews().filter((dynamic) => {
			if (!dynamic.embed) return false;
			if (!dynamic.hideEmpty) return true;
			return this.plugin.resolveBoxes(dynamic, file).length > 0;
		});
	}

	/*
	 * Reconciled, never redrawn.
	 *
	 * This used to `empty()` the band and build every section again, which tore
	 * down and rebuilt every live base embed underneath it. That was invisible
	 * until it was not: `metadataCache.on('resolved')` fires after **any** write to
	 * the vault, so creating a note or dropping one into a group rebuilt every
	 * band in the middle of the gesture that caused it. Hence the flicker he saw,
	 * the drag highlighting vanishing on drop, and — the same cause underneath —
	 * Obsidian's rename popover coming back null, because the toolbar's component
	 * tree was unloaded while it was being awaited.
	 *
	 * So a section is a thing that persists and is *updated*. Only what actually
	 * differs is touched: sections that left are removed, new ones are built, the
	 * rest have their header and their height set in place and keep their embed.
	 */
	sync() {
		if (this.stale()) return;
		if (!this.mount()) return;

		const wanted = this.wanted();
		this.drawn = wanted.map((dynamic) => dynamic.id).join(' ');
		this.el.toggleClass('is-empty', wanted.length === 0);

		const keep = new Set(wanted.map((dynamic) => dynamic.id));
		for (const [id, entry] of Array.from(this.sections)) {
			if (keep.has(id)) continue;
			this.dropPanel(id);
			entry.section.detach();
			this.sections.delete(id);
		}

		let previous = null;
		for (const dynamic of wanted) {
			let entry = this.sections.get(dynamic.id);
			if (!entry) {
				entry = this.createSection(dynamic);
				this.sections.set(dynamic.id, entry);
			}
			this.updateSection(entry, dynamic);

			/* Only moved when it is genuinely out of order: re-parenting a section
			 * carries a live base query with it. */
			const shouldBe = previous ? previous.nextElementSibling : this.el.firstElementChild;
			if (shouldBe !== entry.section) {
				if (previous) previous.insertAdjacentElement('afterend', entry.section);
				else this.el.prepend(entry.section);
			}
			previous = entry.section;
		}

		this.setFile(this.view.file);
	}

	dropPanel(id) {
		const panel = this.panels.get(id);
		if (!panel) return;
		this.removeChild(panel);
		this.panels.delete(id);
	}

	/*
	 * The chrome of one section, built once.
	 *
	 * Every listener resolves its dynamic view by path at click time rather than
	 * closing over the object: the records are replaced wholesale each time a
	 * `.dview` file is re-read, so a captured one goes stale the first time he
	 * edits it.
	 */
	createSection(dynamic) {
		const id = dynamic.id;
		const section = this.el.createDiv({ cls: 'dynamic-viewer-section' });
		const header = section.createDiv({ cls: 'dynamic-viewer-section-header' });

		const chevron = header.createSpan({ cls: 'dynamic-viewer-chevron' });
		const name = header.createSpan({ cls: 'dynamic-viewer-section-name' });

		header.addEventListener('click', () => {
			const live = this.plugin.dynamicView(id);
			if (live) this.plugin.setCollapsed(live, !live.collapsed);
		});

		/*
		 * The one control on a band, at the top right, and it changes nothing here:
		 * it is the way *out* of a surface whose rule (2026-09-02) is that it
		 * reports rather than edits.
		 *
		 * There are two ways out now, so it is a menu (his ask, 2026-09-03): the
		 * pane in the sidebar, or the dynamic view's own file in a tab. Both lead
		 * to the same panel; which one you want depends on whether you are keeping
		 * this note in front of you, and only you know that - which is exactly the
		 * shape of question a menu is for and a single button cannot ask.
		 *
		 * Three dots rather than a panel icon, because an icon that names one
		 * destination and then asks a question is worse than no icon at all.
		 *
		 * stopPropagation, or the click would also toggle the collapse it sits on.
		 */
		const open = header.createSpan({ cls: 'dynamic-viewer-section-open' });
		setIcon(open, 'more-horizontal');
		open.addEventListener('click', (event) => {
			event.stopPropagation();
			const live = this.plugin.dynamicView(id);
			if (!live) return;
			const panel = this.panels.get(id);
			this.plugin.openMenu(live, event, panel ? panel.basesOn() : []);
		});

		return { section, header, chevron, name, open, host: null, watched: false };
	}

	/* What can differ between one sync and the next, and nothing else. */
	updateSection(entry, dynamic) {
		const label = dynamic.name || 'Untitled';
		if (entry.name.textContent !== label) entry.name.setText(label);

		const icon = dynamic.collapsed ? 'chevron-right' : 'chevron-down';
		if (entry.icon !== icon) {
			entry.icon = icon;
			setIcon(entry.chevron, icon);
		}

		entry.header.setAttribute('aria-label', (dynamic.collapsed ? 'Show ' : 'Hide ')
			+ label + ' — wherever it is shown, not only in this note');
		entry.open.setAttribute('aria-label', 'Open ' + label);

		if (dynamic.collapsed) {
			this.dropPanel(dynamic.id);
			if (entry.host) {
				entry.host.detach();
				entry.host = null;
				entry.watched = false;
			}
			return;
		}

		if (!entry.host) {
			entry.host = entry.section.createDiv({ cls: 'dynamic-viewer-section-body' });
		}
		const height = Math.max(MIN_HEIGHT, Number(dynamic.height) || 320) + 'px';
		if (entry.host.style.height !== height) entry.host.style.height = height;

		/*
		 * The height is his to drag, and it sticks - a table cut off at a guessed
		 * height is a table you resize once per note otherwise. Watched once per
		 * host: a second ResizeObserver on the same element is a second save.
		 */
		if (!entry.watched) {
			entry.watched = true;
			this.plugin.watchHeight(entry.host, dynamic);
		}

		if (this.panels.has(dynamic.id)) return;

		/*
		 * A panel carries a live base query, so it is built into the host it will
		 * live in and never moved between hosts.
		 */
		const panel = new DynamicPanel(this.plugin, entry.host);
		this.panels.set(dynamic.id, panel);
		this.addChild(panel);
		panel.setSource(dynamic, this.view.file);
	}

	/*
	 * A new note can change *which* sections belong here, not only what is in
	 * them: a dynamic view that hides itself when empty appears and disappears as
	 * he moves about. So the wanted set is recomputed first, and the sections are
	 * rebuilt only when it has actually changed - otherwise every file change
	 * would throw away three live base queries to redraw the same three.
	 */
	setFile(file) {
		const wanted = this.wanted().map((dynamic) => dynamic.id).join(' ');
		if (wanted !== this.drawn) {
			this.sync();
			return;
		}

		for (const [id, panel] of this.panels) {
			const dynamic = this.plugin.dynamicView(id);
			if (dynamic) panel.setSource(dynamic, file);
		}
	}
}


/*
 * Every base in the vault, and every view inside each one, as things to add.
 *
 * The views come from parsing the `.base` file: Obsidian offers no listing of
 * them short of building a controller over each, and a base file is small YAML.
 * A base that will not parse still appears - as itself, with no views under it -
 * because being unable to read its views is no reason to hide the base.
 */
class BasePickerModal extends obsidian.FuzzySuggestModal {
	constructor(app, items, onChoose) {
		super(app);
		this.items = items;
		this.onChoose = onChoose;
		this.setPlaceholder('Pick a base, or one of its views');
	}

	getItems() { return this.items; }
	getItemText(item) { return item.label; }

	onChooseItem(item) { this.onChoose(item); }
}


/*
 * One dynamic view's definition, drawn as controls.
 *
 * This used to be a card in the plugin's settings tab, one per dynamic view, all
 * of them together (his ask, 2026-09-03: put them in the individual files). A
 * dynamic view is a file now, so its definition belongs in that file's own
 * window - the settings tab keeps only what is true of the plugin rather than of
 * any one dynamic view.
 *
 * It is a Component drawing into a container it is handed, so the file view owns
 * where it sits and this owns what is in it.
 */
class DynamicEditor extends Component {
	constructor(plugin, containerEl) {
		super();
		this.plugin = plugin;
		this.app = plugin.app;
		this.containerEl = containerEl;
		this.dynamic = null;
		this.signature = '';
	}

	onunload() { this.containerEl.empty(); }

	/*
	 * Redrawn only when the definition really differs, because a redraw destroys
	 * the field being typed in - and every keystroke in a box is a write, which
	 * comes back as a `modify` event.
	 */
	setSource(dynamic) {
		const signature = dynamic ? [
			dynamic.path,
			dynamic.embed ? 'e' : '-',
			dynamic.stacked ? 's' : '-',
			dynamic.hideEmpty ? 'h' : '-',
			JSON.stringify((dynamic.boxes || []).map((box) => [box.id, box.kind])),
		].join('|') : '';

		this.dynamic = dynamic;
		if (signature === this.signature && dynamic) return;
		this.signature = signature;
		this.display();
	}

	display() {
		const root = this.containerEl;
		root.empty();
		const dynamic = this.dynamic;
		if (!dynamic) {
			root.createEl('p', {
				cls: 'setting-item-description',
				text: 'This file could not be read as a dynamic view.',
			});
			return;
		}

		/*
		 * The name is the file name, so this field renames the file - it does not
		 * write a name into it. Before the move to files it set `dynamic.name` and
		 * saved the settings, which by then wrote nothing anyone read back.
		 */
		new Setting(root)
			.setName('Name')
			.setDesc('The file name. Renaming it here renames the file, and Obsidian '
				+ 'rewrites any link to it.')
			.addText((text) => {
				text.setPlaceholder('Name').setValue(dynamic.name);
				const commit = () => {
					const value = text.getValue().trim();
					if (value && value !== dynamic.name) {
						this.plugin.renameDynamicView(dynamic, value);
					}
				};
				text.inputEl.addEventListener('blur', commit);
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') { event.preventDefault(); commit(); }
				});
			});

		new Setting(root)
			.setName('Show at the top of every note')
			.setDesc('A band under the properties, in every note, about that note.')
			.addToggle((toggle) => toggle
				.setValue(!!dynamic.embed)
				.onChange((value) => this.plugin.setEmbed(dynamic, value)));

		new Setting(root)
			.setName('Hide it when there is nothing to show')
			.setDesc('A dynamic view fed by a function is empty on most notes. With this '
				+ 'on it simply does not appear there - no message, and no band at the '
				+ 'top of the note.')
			.addToggle((toggle) => toggle
				.setValue(!!dynamic.hideEmpty)
				.onChange((value) => this.plugin.setHideEmpty(dynamic, value)));

		new Setting(root)
			.setName('Show every base at once')
			.setDesc('Stack them one under another instead of switching between tabs. '
				+ 'They share this dynamic view’s height, which any of them can be '
				+ 'dragged to set.')
			.addToggle((toggle) => toggle
				.setValue(!!dynamic.stacked)
				.onChange((value) => this.plugin.setStacked(dynamic, value)));

		root.createEl('div', {
			cls: 'setting-item-description dynamic-viewer-card-hint',
			text: 'Boxes are read in order, and a base named twice appears once.',
		});

		for (const box of dynamic.boxes) this.drawBox(root, dynamic, box);

		const adders = root.createDiv({ cls: 'dynamic-viewer-box-adders' });
		this.addButton(adders, 'plus', 'List', () => this.after(
			this.plugin.addBox(dynamic, 'list')));
		this.addButton(adders, 'function-square', 'Function', () => this.after(
			this.plugin.addBox(dynamic, 'function')));

		const oof = this.app.plugins.plugins['oof-objects'];
		if (!oof || typeof oof.viewsFor !== 'function') {
			root.createEl('p', {
				cls: 'dynamic-viewer-warning',
				text: 'OOF Class Manager is not enabled, so file.views() and '
					+ 'file.classBase() answer nothing. Links typed by hand still work.',
			});
		}
	}

	addButton(parent, icon, label, onClick) {
		const button = parent.createEl('button', { cls: 'dynamic-viewer-box-add' });
		setIcon(button.createSpan(), icon);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
	}

	after(promise) {
		Promise.resolve(promise).then(() => {
			this.signature = '';
			this.setSource(this.plugin.dynamicView(this.dynamic ? this.dynamic.path : ''));
		});
	}

	/*
	 * One box. A list is a textarea because a list is many lines; a function is one
	 * line because a call is one thing. Both are plain text he can edit, paste into
	 * and clear - which is what "functions like a property" asks for.
	 */
	drawBox(card, dynamic, box) {
		const wrap = card.createDiv({ cls: 'dynamic-viewer-box' });
		const head = wrap.createDiv({ cls: 'dynamic-viewer-box-head' });

		setIcon(head.createSpan({ cls: 'dynamic-viewer-box-icon' }),
			box.kind === 'function' ? 'function-square' : 'list');
		head.createSpan({
			cls: 'dynamic-viewer-box-title',
			text: box.kind === 'function' ? 'Function' : 'List',
		});

		if (box.kind === 'list') {
			const count = parseList(box.value).length;
			head.createSpan({
				cls: 'dynamic-viewer-box-count',
				text: count === 0 ? 'empty' : count + (count === 1 ? ' base' : ' bases'),
			});
		}

		const remove = head.createSpan({ cls: 'dynamic-viewer-box-remove' });
		setIcon(remove, 'x');
		remove.setAttribute('aria-label', 'Remove this box');
		remove.addEventListener('click', () => this.after(
			this.plugin.removeBox(dynamic, box)));

		if (box.kind === 'function') {
			const input = wrap.createEl('input', {
				cls: 'dynamic-viewer-box-input',
				attr: { type: 'text', placeholder: FUNCTIONS[0].name },
			});
			input.value = box.value;
			input.addEventListener('input', () => {
				box.value = input.value;
				this.plugin.queueWrite(dynamic);
				this.markFunction(hint, box.value);
			});

			const hint = wrap.createDiv({ cls: 'setting-item-description' });
			this.markFunction(hint, box.value);
			return;
		}

		const area = wrap.createEl('textarea', {
			cls: 'dynamic-viewer-box-area',
			attr: { placeholder: '[[Improvement Base.base#dynamic project]]' },
		});
		area.value = box.value;
		area.rows = Math.max(3, parseList(box.value).length + 1);
		/*
		 * Typing writes a file, so it settles first. Without the wait every
		 * keystroke tore down and rebuilt every base embed on the screen.
		 */
		area.addEventListener('input', () => {
			box.value = area.value;
			this.plugin.queueWrite(dynamic);
		});
		/* The count in the header is only true again once the field settles. */
		area.addEventListener('blur', () => { this.signature = ''; this.display(); });
	}

	/* Whether a function box holds something this plugin can run, said plainly. */
	markFunction(el, text) {
		const fn = functionFor(text);
		el.toggleClass('dynamic-viewer-warning', !fn);
		el.setText(fn
			? fn.describe
			: 'Not a function this plugin knows. It contributes nothing. '
				+ 'Known: ' + FUNCTIONS.map((each) => each.name).join(', ') + '.');
	}
}

/*
 * A `.dview` opened as a tab.
 *
 * Two halves: the dynamic view's **definition**, which lives here and nowhere
 * else, and the dynamic view itself - the same `DynamicPanel` the sidebar and the
 * band draw. Opening the file is how you see what it is and how you change it,
 * which is what a file being the thing buys.
 *
 * The dashboard half is still about the **note you were reading**, not about this
 * file: opening it makes it the active leaf, and `isNoteLeaf` refuses anything
 * that is not a markdown view, so `noteFile` does not follow you in here.
 */
class DynamicViewerFileView extends FileView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.panel = null;
		this.editor = null;
		this.dynamicPath = '';
	}

	getViewType() { return FILE_VIEW_TYPE; }
	getIcon() { return PANE_ICON; }

	getDisplayText() { return this.file ? this.file.basename : PANE_NAME; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('dynamic-viewer-pane', 'dynamic-viewer-file');

		/*
		 * The definition folds away, because a dashboard opened for reading wants
		 * the height. It is not hidden behind a preference: the header is always
		 * there saying what it is, and where it was left is remembered per file
		 * alongside the other furniture.
		 */
		const box = root.createDiv({ cls: 'dynamic-viewer-definition' });
		this.defHeadEl = box.createDiv({ cls: 'dynamic-viewer-definition-head' });
		this.defChevronEl = this.defHeadEl.createSpan({ cls: 'dynamic-viewer-definition-chevron' });
		this.defHeadEl.createSpan({ cls: 'dynamic-viewer-definition-title', text: 'Definition' });
		this.defHeadEl.addEventListener('click', () => this.toggleEditor());

		this.defBodyEl = box.createDiv({ cls: 'dynamic-viewer-definition-body' });
		this.editor = new DynamicEditor(this.plugin, this.defBodyEl);
		this.addChild(this.editor);

		this.panel = new DynamicPanel(this.plugin,
			root.createDiv({ cls: 'dynamic-viewer-host' }));
		this.addChild(this.panel);

		this.addAction('settings', 'Dynamic Viewer settings',
			() => this.plugin.openSettings());

		this.registerEvent(this.app.workspace.on('file-open', () => this.follow()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
	}

	async onLoadFile(file) {
		this.dynamicPath = file.path;
		this.rebuild();
	}

	follow() {
		if (this.panel) this.panel.setFile(this.plugin.noteFile);
	}

	toggleEditor() {
		const dynamic = this.plugin.dynamicView(this.dynamicPath);
		if (!dynamic) return;
		this.plugin.setEditing(dynamic, !dynamic.editing);
	}

	rebuild() {
		if (!this.panel) return;
		const dynamic = this.plugin.dynamicView(this.dynamicPath);

		const open = !dynamic || dynamic.editing;
		this.defBodyEl.toggleClass('is-hidden', !open);
		setIcon(this.defChevronEl, open ? 'chevron-down' : 'chevron-right');
		this.defHeadEl.setAttribute('aria-label',
			(open ? 'Hide ' : 'Show ') + 'what this dynamic view is made of');

		this.editor.setSource(dynamic);
		this.panel.setSource(dynamic, this.plugin.noteFile);
	}
}

/* ------------------------------------------------------------------ plugin */

class DynamicViewerPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.bands = new Map();
		this.noteFile = null;
		this.syncQueued = false;
		/* Bumped when a band has to be adopted back into an editor. */
		this.bandGeneration = 0;


		/* path -> the dynamic view read out of that file. */
		this.views = new Map();

		/*
		 * After `views`, and that ordering is load-bearing: registering the
		 * extension reconfigures every open editor at once, the field is created
		 * on the spot and asks for `bandHeightHint()`, which reads them.
		 *
		 * Registered whether or not the setting is on - the field draws nothing
		 * while it is off - because adding or removing an extension from a live
		 * editor is the one thing that cannot be undone by disabling the plugin
		 * if it ever throws.
		 */
		this.registerEditorExtension(bandExtension(this));

		this.registerView(VIEW_TYPE, (leaf) => new DynamicViewerPane(leaf, this));
		this.registerView(FILE_VIEW_TYPE, (leaf) => new DynamicViewerFileView(leaf, this));
		/*
		 * What makes a `.dview` openable at all: the same call that maps
		 * `base` to the `bases` view. Without it Obsidian lists the file and
		 * refuses to open it.
		 */
		this.registerExtensions([EXTENSION], FILE_VIEW_TYPE);

		this.addRibbonIcon(PANE_ICON, PANE_NAME, () => this.openPane());

		this.addCommand({
			id: 'open',
			name: 'Open dynamic views',
			callback: () => this.openPane(),
		});

		this.addCommand({
			id: 'next-dynamic-view',
			name: 'Show the next dynamic view',
			callback: () => this.cycleDynamic(1),
		});

		this.addSettingTab(new DynamicViewerSettingTab(this.app, this));

		this.addCommand({
			id: 'new-dynamic-view',
			name: 'New dynamic view',
			callback: () => this.promptForDynamicView(),
		});

		/*
		 * The vault is only walkable once it is ready, and the move out of settings
		 * writes files - so both wait for it. Migration first, or the read would
		 * find nothing and the pane would come up empty before the files exist.
		 */
		this.app.workspace.onLayoutReady(async () => {
			await this.migrateToFiles();
			await this.readDynamicViews();
			this.rememberFile();
			this.queueSync();
		});

		this.registerEvent(this.app.workspace.on('file-open', () => {
			this.rememberFile();
			this.queueSync();
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.rememberFile();
			this.queueSync();
		}));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.queueSync()));

		/*
		 * A class's `views:` changing is a different list of tabs, and so is a base
		 * being renamed. Both arrive here; the panels re-resolve and keep the tab
		 * he was on when it survived.
		 */
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.queueSync(true)));

		/*
		 * A `.dview` has no frontmatter, so `metadataCache.on('changed')`
		 * never fires for one - the vault's own events are the only notice we get.
		 * `readDynamicViews` rebuilds only when something actually changed, so our
		 * own writes (memory first, then the file) come back as no-ops.
		 */
		const isOurs = (file) => file instanceof TFile && file.extension === EXTENSION;

		this.registerEvent(this.app.vault.on('create', (file) => {
			if (isOurs(file)) this.readDynamicViews().catch(() => {});
		}));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (isOurs(file)) this.readDynamicViews().catch(() => {});
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (!isOurs(file)) return;
			this.views.delete(file.path);
			if (this.settings.state) delete this.settings.state[file.path];
			this.readDynamicViews().catch(() => {});
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (isOurs(file) || String(oldPath).endsWith('.' + EXTENSION)) {
				this.views.delete(oldPath);
				this.renamePath(oldPath, file.path);
				this.saveSettings().catch(() => {});
				this.readDynamicViews().catch(() => {});
				return;
			}
			this.queueSync(true);
		}));
	}

	onunload() {
		for (const band of this.bands.values()) this.removeChild(band);
		this.bands.clear();
	}


	/*
	 * Which band belongs to this editor. The widget is one decoration shared by
	 * every note, so the view it is being drawn into is what says whose band it is.
	 */
	bandForEditor(editorView) {
		for (const band of this.bands.values()) {
			const view = band.view;
			const cm = view && view.editor && view.editor.cm;
			if (cm === editorView) return band;
		}
		return null;
	}

	/*
	 * Roughly how tall a band will be, for CodeMirror to lay out with before it has
	 * measured one. An estimate is all this is: being wrong costs a correction on
	 * first render, where having none at all costs the layout being wrong for the
	 * whole of the first paint - which is the race this attachment exists to avoid.
	 */
	bandHeightHint() {
		/* Asked during the very reconfigure that installs the field, which can be
		 * before the dynamic views have been read. */
		if (!this.views) return 0;
		let total = 0;
		for (const dynamic of this.dynamicViews()) {
			if (!dynamic.embed) continue;
			total += 26 + (dynamic.collapsed ? 0 : Math.max(MIN_HEIGHT, Number(dynamic.height) || 320));
		}
		return total;
	}

	/*
	 * Ask every editor to draw the band again.
	 *
	 * Needed because reading mode takes the element away between switches: the
	 * decoration is still there and still compares equal, so CodeMirror keeps a
	 * reference to a node that is now inside `mod-header` and never re-adopts it.
	 * Bumping the generation is what makes the widgets differ so `toDOM` is asked
	 * again.
	 */
	reclaimBands() {
		this.bandGeneration++;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			const cm = view && view.getViewType && view.getViewType() === 'markdown'
				&& view.editor && view.editor.cm;
			if (cm) cm.dispatch({});
		});
	}

	async loadSettings() {
		const stored = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
		if (!this.settings.state || typeof this.settings.state !== 'object') {
			this.settings.state = {};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* ----- the files ---------------------------------------------------------- */

	/*
	 * A dynamic view is a file (2026-09-02, his proposal), and his own argument for
	 * it is the one he made about bases: *"the `.base` files are really nothing
	 * more than flexible queries"*. A dynamic view is a **composition** of those
	 * queries, and it was the only thing in this system that was not a file - so it
	 * could not be linked, opened, hand-edited, or carried by the vault.
	 *
	 * The file name is the name. There is no `id` and no `name` inside: identity is
	 * the path, exactly as a characteristic's name is its file name.
	 */
	dynamicViewFiles() {
		return this.app.vault.getFiles()
			.filter((file) => file.extension === EXTENSION)
			.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	/*
	 * Read every one into memory, because everything that draws is synchronous -
	 * the same arrangement OOF Class Manager uses for defaults tables and for the
	 * views inside a base.
	 *
	 * A view object is **kept** across a re-read when its content has not changed,
	 * so the panels holding one are not handed a different object for the same
	 * dynamic view, and nothing rebuilds for a file that was merely touched.
	 */
	async readDynamicViews() {
		let changed = false;
		const seen = new Set();

		for (const file of this.dynamicViewFiles()) {
			seen.add(file.path);

			let text = '';
			try { text = await this.app.vault.cachedRead(file); } catch (error) { continue; }
			if (this.rememberDynamicView(file, text)) changed = true;
		}

		for (const path of Array.from(this.views.keys())) {
			if (!seen.has(path)) { this.views.delete(path); changed = true; }
		}

		if (changed) this.rebuildAll();
		return changed;
	}

	rememberDynamicView(file, text) {
		const content = parseDynamicView(text);
		if (!content) return false;

		const before = this.views.get(file.path);
		const same = before
			&& before.name === file.basename
			&& before.embed === content.embed
			&& before.stacked === content.stacked
			&& before.hideEmpty === content.hideEmpty
			&& JSON.stringify(before.boxes.map((box) => [box.kind, box.value]))
				=== JSON.stringify(content.boxes.map((box) => [box.kind, box.value]));
		if (same) return false;

		const state = this.stateFor(file.path);
		this.views.set(file.path, {
			/* `id` is the path, so everything keyed on it already works. */
			id: file.path,
			path: file.path,
			file: file,
			name: file.basename,
			boxes: content.boxes,
			embed: content.embed,
			stacked: content.stacked,
			hideEmpty: content.hideEmpty,
			collapsed: state.collapsed,
			height: state.height,
			editing: state.editing,
		});
		return true;
	}

	/* Where you left the furniture. Never in the file: it would churn on a drag. */
	stateFor(path) {
		const stored = (this.settings.state && this.settings.state[path]) || {};
		return {
			collapsed: !!stored.collapsed,
			height: Math.max(MIN_HEIGHT, Number(stored.height) || 320),
			/* Open the first time it is opened: this is the only place to edit one. */
			editing: stored.editing === undefined ? true : !!stored.editing,
		};
	}

	async saveState(dynamic) {
		if (!this.settings.state) this.settings.state = {};
		this.settings.state[dynamic.path] = {
			collapsed: !!dynamic.collapsed,
			height: Math.max(MIN_HEIGHT, Number(dynamic.height) || 320),
			editing: !!dynamic.editing,
		};
		await this.saveSettings();
	}

	/*
	 * Written from memory, and memory is updated first - so the `modify` event this
	 * causes finds nothing changed and nothing rebuilds a second time.
	 */
	async writeDynamicView(dynamic) {
		if (!(dynamic.file instanceof TFile)) return;
		try {
			await this.app.vault.modify(dynamic.file, serialiseDynamicView(dynamic));
		} catch (error) {
			console.error('dynamic-viewer: could not write ' + dynamic.path, error);
			new Notice('Could not write ' + dynamic.path + '.', 6000);
		}
	}

	/* In name order, which is file order - there is no list to keep sorted. */
	dynamicViews() {
		const order = Array.isArray(this.settings.order) ? this.settings.order : [];
		const place = new Map(order.map((path, i) => [path, i]));
		return Array.from(this.views.values()).sort((a, b) => {
			const ia = place.has(a.path) ? place.get(a.path) : Infinity;
			const ib = place.has(b.path) ? place.get(b.path) : Infinity;
			/* Anything the list has not heard of goes after what it has, and among
			 * themselves alphabetically - which is what the whole list used to be. */
			if (ia !== ib) return ia - ib;
			return a.name.localeCompare(b.name);
		});
	}

	/*
	 * Move one dynamic view up or down.
	 *
	 * The stored list is rebuilt from what is actually on screen rather than
	 * edited in place, so a list carrying a deleted path or missing a new one
	 * cannot make the move do something surprising - it is normalised by the act
	 * of reordering.
	 */
	moveDynamicView(dynamic, by) {
		const current = this.dynamicViews().map((d) => d.path);
		const from = current.indexOf(dynamic.path);
		const to = from + by;
		if (from < 0 || to < 0 || to >= current.length) return false;
		current.splice(to, 0, current.splice(from, 1)[0]);
		this.settings.order = current;
		this.saveSettings().catch(() => {});
		this.syncBands(true);
		return true;
	}

	dynamicView(path) {
		return this.views.get(path) || null;
	}

	activeDynamic() {
		return this.dynamicView(this.settings.activeView) || this.dynamicViews()[0] || null;
	}

	/*
	 * A rename moves the file, so it moves the identity: the state kept beside it
	 * and the pane's selection both follow. Without this a dragged height and a
	 * collapsed band would be stranded under a path nothing carries any more.
	 */
	renamePath(from, to) {
		if (this.settings.state && this.settings.state[from]) {
			this.settings.state[to] = this.settings.state[from];
			delete this.settings.state[from];
		}
		if (this.settings.activeView === from) this.settings.activeView = to;
		if (Array.isArray(this.settings.order)) {
			const at = this.settings.order.indexOf(from);
			if (at !== -1) this.settings.order[at] = to;
		}
	}

	/* ----- making, renaming and removing one ---------------------------------- */

	async createDynamicView(name) {
		const folder = String(this.settings.folder || '').trim();
		if (folder) {
			try { await this.app.vault.createFolder(folder); } catch (error) { /* there already */ }
		}

		const base = (folder ? folder + '/' : '') + name.replace(/[\\/:*?"<>|#^[\]]/g, '');
		let path = base + '.' + EXTENSION;
		let n = 1;
		while (this.app.vault.getAbstractFileByPath(path)) {
			n += 1;
			path = base + ' ' + n + '.' + EXTENSION;
		}

		const seed = { boxes: [makeBox('list', '')], embed: false, stacked: false, hideEmpty: true };
		let file = null;
		try {
			file = await this.app.vault.create(path, serialiseDynamicView(seed));
		} catch (error) {
			console.error('dynamic-viewer: could not create ' + path, error);
			new Notice('Could not create ' + path + '.', 6000);
			return null;
		}

		await this.readDynamicViews();
		this.settings.activeView = file.path;
		await this.saveSettings();
		this.rebuildAll();
		return file;
	}

	/*
	 * A dynamic view is a file, so it can have a whole window - which is what
	 * `registerExtensions` bought and, until now, only the file explorer knew how
	 * to spend. A new tab rather than the current one, and rather than revealing a
	 * tab that already holds it: "open in a new tab" is what the item says, and
	 * two of the same dashboard side by side is a legitimate thing to want when
	 * one of them is following a note you are about to leave.
	 */
	/*
	 * One base, in a tab of its own, at the view the tab was showing.
	 *
	 * `openLinkText` is the whole implementation: Obsidian resolves the `#view`
	 * subpath of a `.base` link itself, which is the same reading that makes
	 * `![[X.base#a view]]` work.
	 */
	async openBaseEntry(entry) {
		if (!entry || !(entry.file instanceof TFile)) return;
		await this.app.workspace.openLinkText(entry.link, entry.file.path, 'tab');
	}

	async openDynamicView(dynamic) {
		if (!(dynamic.file instanceof TFile)) return;
		await this.app.workspace.getLeaf('tab').openFile(dynamic.file);
	}

	async renameDynamicView(dynamic, name) {
		if (!(dynamic.file instanceof TFile)) return;
		const folder = dynamic.file.parent ? dynamic.file.parent.path : '';
		const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
		if (!clean || clean === dynamic.name) return;

		const path = (folder && folder !== '/' ? folder + '/' : '') + clean + '.' + EXTENSION;
		try {
			await this.app.fileManager.renameFile(dynamic.file, path);
		} catch (error) {
			console.error('dynamic-viewer: could not rename ' + dynamic.path, error);
			new Notice('Could not rename to ' + clean + '.', 6000);
		}
	}

	async trashDynamicView(dynamic) {
		if (!(dynamic.file instanceof TFile)) return;
		/* Through the file manager, so it obeys his *Deleted files* setting. */
		try {
			await this.app.fileManager.trashFile(dynamic.file);
		} catch (error) {
			console.error('dynamic-viewer: could not delete ' + dynamic.path, error);
		}
	}

	/* ----- the one-time move out of settings ---------------------------------- */

	/*
	 * Everything used to live in `data.json` as an array. Each entry becomes a
	 * file; `collapsed` and `height` stay behind in `state`, keyed by the new path.
	 *
	 * It runs once, and only while the old array is there - not behind a migration
	 * flag, because the array's own presence is the flag, and one left behind by a
	 * failed run should be finished on the next load rather than skipped.
	 */
	async migrateToFiles() {
		const stored = this.settings.dynamicViews;
		if (!Array.isArray(stored) || stored.length === 0) {
			delete this.settings.dynamicViews;
			return false;
		}

		const state = this.settings.state || {};
		let first = '';

		for (const old of stored) {
			const name = String(old.name || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').trim()
				|| 'Untitled';
			const content = {
				boxes: boxesOf(old),
				embed: !!old.embed,
				stacked: !!old.stacked,
				hideEmpty: old.hideEmpty !== false,
			};

			const folder = String(this.settings.folder || '').trim();
			if (folder) {
				try { await this.app.vault.createFolder(folder); } catch (error) { /* there */ }
			}

			let path = (folder ? folder + '/' : '') + name + '.' + EXTENSION;
			let n = 1;
			while (this.app.vault.getAbstractFileByPath(path)) {
				n += 1;
				path = (folder ? folder + '/' : '') + name + ' ' + n + '.' + EXTENSION;
			}

			try {
				await this.app.vault.create(path, serialiseDynamicView(content));
			} catch (error) {
				console.error('dynamic-viewer: could not migrate "' + name + '"', error);
				continue;
			}

			state[path] = {
				collapsed: !!old.collapsed,
				height: Math.max(MIN_HEIGHT, Number(old.height) || 320),
			};
			if (!first) first = path;
			if (this.settings.activeView === old.id) first = path;
		}

		delete this.settings.dynamicViews;
		this.settings.state = state;
		this.settings.activeView = first;
		await this.saveSettings();

		new Notice('Dynamic Viewer: moved ' + stored.length + ' dynamic view'
			+ (stored.length === 1 ? '' : 's') + ' into '
			+ (this.settings.folder || 'the vault root') + '.', 8000);
		return true;
	}

	/*
	 * One dynamic view's boxes, resolved against one note, in order.
	 *
	 * A dynamic view is a list of base views assembled out of as many boxes as he
	 * likes: a list box holds links, a function box holds a call. Both produce the
	 * same thing — links, in the same spelling — which is why they can be
	 * concatenated without either knowing about the other.
	 *
	 * Deduplicated on the link, so a base named by hand and again by a function is
	 * one tab, and it keeps the position of the box that named it first.
	 */
	resolveBoxes(dynamic, file) {
		const out = [];
		const seen = new Set();

		/*
		 * An entry carries no note of which box it came from. It used to, so a tab
		 * could say "this one came from file.views()" — which is the pane
		 * explaining another plugin's model, and there is nothing a tab does
		 * differently for knowing it.
		 */
		const add = (raw) => {
			const link = viewLink(raw);
			if (!link) return;

			const key = link.toLowerCase();
			if (seen.has(key)) return;
			seen.add(key);

			const parts = splitViewLink(link);
			out.push({
				link: link,
				target: parts.target,
				view: parts.view,
				file: this.resolveBase(parts.target, file ? file.path : ''),
			});
		};

		for (const box of (dynamic ? dynamic.boxes : []) || []) {
			if (box.kind === 'function') {
				for (const link of this.callFunction(box.value, file)) add(link);
				continue;
			}
			for (const entry of parseList(box.value)) add(entry);
		}

		return out;
	}

	/*
	 * A function box, run. An unrecognised one is silently empty here and named as
	 * unrecognised in the settings, where it can be corrected — the pane is not
	 * the place to be told about a typo in a box you cannot see from it.
	 */
	callFunction(text, file) {
		const fn = functionFor(text);
		if (!fn) return [];
		if (fn.name === 'file.views()') return this.callViews(file);
		if (fn.name === 'file.classBase()') return this.callClassBase(file);
		return [];
	}

	/*
	 * `file.views()` lives in OOF Class Manager and belongs there: it climbs `is a`
	 * and then `type of`, and the *names* of those two properties are that
	 * plugin's settings. Two plugins reading one hierarchy through two settings
	 * free to disagree is the mistake Bases Is A was folded in to end.
	 *
	 * A missing OOF is a quiet empty list rather than an error, because everything
	 * else here - a list of links typed by hand - works without it.
	 */
	callViews(file) {
		if (!(file instanceof TFile)) return [];

		const oof = this.app.plugins.plugins['oof-objects'];
		if (!oof || typeof oof.viewsFor !== 'function') return [];

		try {
			return oof.viewsFor(file) || [];
		} catch (error) {
			console.error('dynamic-viewer: file.views() failed on ' + file.path, error);
			return [];
		}
	}

	/*
	 * `file.classBase()` lives in OOF Class Manager for the same reason
	 * `file.views()` does, and one more: which `.base` a class's is depends on
	 * that plugin's Bases folder and Base suffix, so asking it is the only way
	 * the answer can follow a setting he changes there.
	 *
	 * Returned as `Person Base.base` - a one-entry list in the spelling every
	 * other entry here uses, extension included so `resolveBase` finds the base
	 * rather than a note of that name. A note with no class base is an empty
	 * list, which draws as an empty section or none at all, exactly like a note
	 * whose classes name no views.
	 */
	callClassBase(file) {
		if (!(file instanceof TFile)) return [];

		const oof = this.app.plugins.plugins['oof-objects'];
		if (!oof || typeof oof.classBaseFor !== 'function') return [];

		try {
			const base = oof.classBaseFor(file);
			return base ? [base.name] : [];
		} catch (error) {
			console.error('dynamic-viewer: file.classBase() failed on ' + file.path, error);
			return [];
		}
	}

	/*
	 * A base named with or without its extension. Obsidian resolves a bare link to
	 * `.md`, so `[[Improvement Base]]` finds the note of that name and never the
	 * base beside it - the `.base` fallback is what lets both spellings work.
	 */
	resolveBase(target, sourcePath) {
		if (!target) return null;

		const path = sourcePath || '';
		const named = this.app.metadataCache.getFirstLinkpathDest(target, path);
		if (named instanceof TFile && named.extension === 'base') return named;

		const guessed = this.app.metadataCache.getFirstLinkpathDest(target + '.base', path);
		if (guessed instanceof TFile && guessed.extension === 'base') return guessed;

		return null;
	}

	/*
	 * "Add a base" — from the + on the tab strip, from the empty pane, or from a
	 * dynamic view's menu.
	 *
	 * It lands in a **list box**, which is the point of his change: the picker is
	 * a shortcut for typing into that box, not a separate way of holding a base.
	 * The last list box takes it, so repeated adds stay together; if there is no
	 * list box yet, one is made.
	 *
	 * Everything is read before the modal opens, because `getSuggestions` is
	 * synchronous and a base's views are only knowable by reading the file.
	 */
	async promptForBase(dynamic) {
		if (!dynamic) return;

		const items = await this.baseChoices();
		if (items.length === 0) {
			new Notice('There are no .base files in this vault yet.', 5000);
			return;
		}

		new BasePickerModal(this.app, items, async (item) => {
			const box = this.listBoxFor(dynamic);
			const entries = parseList(box.value);

			if (entries.some((entry) => viewLink(entry) === viewLink(item.entry))) {
				new Notice(item.label + ' is already in "' + dynamic.name + '".', 4000);
				return;
			}

			/*
			 * Written back one per line. A box he had typed comma-separated is
			 * normalised on the way through, which is the one spelling this plugin
			 * writes even though it reads both.
			 */
			box.value = writeList(entries.concat([item.entry]));
			this.rebuildAll();
			await this.writeDynamicView(dynamic);
		}).open();
	}

	/* The box an added base goes into: the last list one, or a new one. */
	listBoxFor(dynamic) {
		for (let i = dynamic.boxes.length - 1; i >= 0; i--) {
			if (dynamic.boxes[i].kind === 'list') return dynamic.boxes[i];
		}
		const box = makeBox('list', '');
		dynamic.boxes.push(box);
		return box;
	}

	/*
	 * "Add a function" — the second way of putting bases into a dynamic view, and
	 * the reason the boxes exist at all. Pre-filled with the only function there
	 * is, so the common case is one keypress.
	 */
	promptForFunction(dynamic) {
		if (!dynamic) return;

		new PromptModal(this.app, 'Add a function', FUNCTIONS[0].name, 'Add',
			async (text) => {
				if (!functionFor(text)) {
					new Notice('"' + text + '" is not a function this plugin knows. '
						+ 'It is added anyway, and the settings will say so.', 6000);
				}
				dynamic.boxes.push(makeBox('function', text));
				this.rebuildAll();
				await this.writeDynamicView(dynamic);
			}).open();
	}

	async addBox(dynamic, kind) {
		dynamic.boxes.push(makeBox(kind, kind === 'function' ? FUNCTIONS[0].name : ''));
		this.rebuildAll();
		await this.writeDynamicView(dynamic);
	}

	async removeBox(dynamic, box) {
		const at = dynamic.boxes.indexOf(box);
		if (at === -1) return;
		dynamic.boxes.splice(at, 1);
		this.rebuildAll();
		await this.writeDynamicView(dynamic);
	}

	/*
	 * A box being typed into settles before it is written and before anything
	 * redraws: a file write per keystroke would rebuild every base embed on the
	 * screen between one letter and the next.
	 */
	queueWrite(dynamic) {
		if (!this.writeTimers) this.writeTimers = new Map();
		window.clearTimeout(this.writeTimers.get(dynamic.path));
		this.writeTimers.set(dynamic.path, window.setTimeout(() => {
			this.writeTimers.delete(dynamic.path);
			this.rebuildAll();
			this.writeDynamicView(dynamic);
		}, 600));
	}

	/* Everything a dynamic view holds, counted, for a pill's tooltip. */
	describeBoxes(dynamic) {
		const lists = dynamic.boxes.filter((box) => box.kind === 'list');
		const calls = dynamic.boxes.filter((box) => box.kind === 'function');
		const links = lists.reduce((total, box) => total + parseList(box.value).length, 0);

		const parts = [];
		if (links > 0) parts.push(links + (links === 1 ? ' base' : ' bases'));
		if (calls.length > 0) {
			parts.push(calls.length + (calls.length === 1 ? ' function' : ' functions'));
		}
		if (parts.length === 0) parts.push('Empty');
		if (dynamic.embed) parts.push('at the top of every note');
		return parts.join(' — ');
	}

	async baseChoices() {
		const files = this.app.vault.getFiles()
			.filter((file) => file.extension === 'base')
			.sort((a, b) => a.basename.localeCompare(b.basename));

		const out = [];
		for (const file of files) {
			/* Whatever a wikilink to this base would have to say to be unambiguous. */
			const link = this.app.metadataCache.fileToLinktext(file, '', false);

			out.push({ label: file.basename, entry: '[[' + link + ']]' });
			for (const name of await this.viewNamesOf(file)) {
				out.push({
					label: file.basename + '  →  ' + name,
					entry: '[[' + link + '#' + name + ']]',
				});
			}
		}
		return out;
	}

	async viewNamesOf(file) {
		try {
			const data = obsidian.parseYaml(await this.app.vault.cachedRead(file));
			const views = data && Array.isArray(data.views) ? data.views : [];
			return views
				.map((view) => (view && typeof view.name === 'string' ? view.name.trim() : ''))
				.filter((name) => name.length > 0);
		} catch (error) {
			return [];
		}
	}

	/* Obsidian's own `![[x.base]]`, as a factory. Absent, nothing here can draw. */
	baseEmbedFactory() {
		const registry = this.app.embedRegistry;
		const creator = registry && registry.embedByExtension
			&& registry.embedByExtension['base'];
		return typeof creator === 'function' ? creator : null;
	}

	/* ----- which note everything is about ----------------------------------- */

	/*
	 * The note he is looking at, which is not the same as "the active leaf's file":
	 * a sidebar leaf is active the moment he clicks a tab in one, and the panel
	 * following that would show the dashboard of nothing.
	 */
	rememberFile() {
		const leaf = this.app.workspace.activeLeaf;
		if (this.isNoteLeaf(leaf)) {
			this.noteFile = leaf.view.file;
			return;
		}
		/*
		 * The fallback exists because a sidebar leaf becoming active is ignored
		 * above, and on the very first event that guard would otherwise be the only
		 * voice - the plugin would start with no note at all. But `getActiveFile()`
		 * answers with whatever kind of file is in front, and enabling the plugin
		 * with a `.dview` open made the dashboard's own definition the note it was
		 * about. It has to pass the same test the leaf does.
		 */
		if (!this.noteFile) this.noteFile = this.firstNote();
	}

	/*
	 * A note to start on, when the first thing that ever became active was not one.
	 *
	 * `getActiveFile()` alone is not it: it answers with whatever kind of file is in
	 * front, and starting up with a `.dview` open made the dashboard's own
	 * definition the note it was about. But refusing and leaving `noteFile` null is
	 * the same guard starving the value from the other side, so when the active file
	 * is not a note the open markdown panes are asked instead.
	 */
	firstNote() {
		const active = this.app.workspace.getActiveFile();
		if (active instanceof TFile && active.extension === 'md') return active;

		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (this.isNoteLeaf(leaf)) return leaf.view.file;
		}

		/*
		 * And a tab Obsidian has not built yet holds a *deferred* placeholder, which
		 * `getLeavesOfType('markdown')` does not return at all - so at startup, with
		 * a `.dview` restored as the active tab, the loop above finds nothing and the
		 * pane comes up empty until he clicks a note. The view *state* is there
		 * whether or not the view is, and it is the only thing that is.
		 */
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const state = typeof leaf.getViewState === 'function' ? leaf.getViewState() : null;
			if (!state || state.type !== 'markdown') return;
			const path = state.state && state.state.file;
			const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
			if (file instanceof TFile && file.extension === 'md') found = file;
		});
		return found;
	}

	/*
	 * **A markdown view, in the root split.** The extra test is new with the file
	 * view: opening a `.dview` in the main window makes it the active leaf
	 * and it does carry a `TFile`, so without this the pane would decide that the
	 * dashboard's own definition was the note it should be about.
	 */
	isNoteLeaf(leaf) {
		const view = leaf && leaf.view;
		if (!view || !(view.file instanceof TFile)) return false;
		if (typeof view.getViewType === 'function' && view.getViewType() !== 'markdown') {
			return false;
		}
		if (typeof leaf.getRoot !== 'function') return true;
		return leaf.getRoot() === this.app.workspace.rootSplit;
	}

	/* ----- the bands -------------------------------------------------------- */

	queueSync(force) {
		if (force) this.syncForced = true;
		if (this.syncQueued) return;
		this.syncQueued = true;
		window.setTimeout(() => {
			this.syncQueued = false;
			const forced = this.syncForced;
			this.syncForced = false;
			this.syncBands(forced);
		}, 40);
	}

	/*
	 * One band per loaded markdown leaf. A deferred tab has no `containerEl` yet
	 * and is simply skipped - it gets its band when Obsidian gets round to
	 * building it, which is also when its query would first be worth running.
	 */
	syncBands(force) {
		const wanted = this.dynamicViews().some((dynamic) => dynamic.embed);
		const live = new Set();

		if (wanted) {
			for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
				const view = leaf.view;
				if (!view || !view.containerEl || !(view.file instanceof TFile)) continue;

				live.add(leaf);
				let band = this.bands.get(leaf);
				if (!band) {
					band = new EmbedBand(this, leaf);
					this.bands.set(leaf, band);
					this.addChild(band);
					continue;
				}

				if (force) band.sync();
				else {
					band.mount();
					band.setFile(view.file);
				}
			}
		}

		for (const [leaf, band] of Array.from(this.bands)) {
			if (live.has(leaf)) continue;
			this.removeChild(band);
			this.bands.delete(leaf);
		}

		const pane = this.pane();
		if (pane) pane.follow();
	}

	/* The band and the pane both redraw from scratch when the settings change. */
	/*
	 * `syncBands(true)` already syncs every live band, and creates and removes the
	 * bands themselves - so the loop that used to precede it was a second full
	 * rebuild of every base embed on every settings change.
	 */
	rebuildAll() {
		this.syncBands(true);
		const pane = this.pane();
		if (pane) pane.rebuild();
		for (const leaf of this.app.workspace.getLeavesOfType(FILE_VIEW_TYPE)) {
			if (leaf.view instanceof DynamicViewerFileView) leaf.view.rebuild();
		}
	}

	/*
	 * The live pane, or nothing.
	 *
	 * A leaf of our type is not proof of a view of ours: a sidebar tab Obsidian has
	 * not got round to building yet holds a *deferred* placeholder, which answers
	 * to `getViewType()` and to nothing else. Asking it to `follow()` threw. The
	 * test is the class, not the leaf.
	 */
	pane() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof DynamicViewerPane) return leaf.view;
		}
		return null;
	}

	/*
	 * `resize: vertical` gives the drag for free; this is only what remembers it.
	 * Written on settle rather than on every frame, or a drag is a hundred saves.
	 */
	watchHeight(host, dynamic) {
		let timer = 0;
		const observer = new ResizeObserver(() => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				const height = Math.round(host.getBoundingClientRect().height);
				if (!height || Math.abs(height - dynamic.height) < 2) return;
				dynamic.height = Math.max(MIN_HEIGHT, height);
				this.saveState(dynamic);
			}, 400);
		});
		observer.observe(host);
		this.register(() => {
			window.clearTimeout(timer);
			observer.disconnect();
		});
	}

	/* ----- the dynamic views themselves ------------------------------------- */

	/*
	 * Everything a dynamic view can do, in one menu, reachable by right-clicking a
	 * pill or by clicking the one already selected. The settings tab drives the
	 * same methods, so the two surfaces cannot come to disagree.
	 *
	 * The first two items are the two ways of putting bases into it, which is his
	 * framing: a list and a function are both boxes, and a dynamic view can hold
	 * as many of each as he likes.
	 */
	dynamicMenu(dynamic, anchor) {
		const menu = new Menu();

		/*
		 * First, and alone: it is the only item that takes you somewhere rather
		 * than changing something, and a missing file keeps its place with the
		 * reason in the label, because a disabled Obsidian menu item swallows its
		 * own click and cannot say anything of its own.
		 */
		const openable = dynamic.file instanceof TFile;
		menu.addItem((item) => item
			.setTitle(openable ? 'Open in a new tab' : 'Open in a new tab — no file')
			.setIcon('file-symlink')
			.setDisabled(!openable)
			.onClick(() => this.openDynamicView(dynamic)));

		menu.addSeparator();

		menu.addItem((item) => item
			.setTitle('Add a base…')
			.setIcon('plus')
			.onClick(() => this.promptForBase(dynamic)));

		menu.addItem((item) => item
			.setTitle('Add a function…')
			.setIcon('function-square')
			.onClick(() => this.promptForFunction(dynamic)));

		menu.addSeparator();

		/*
		 * Its definition lives in its own file now, so this opens that - the same
		 * place *Open in a new tab* goes, because there is only one of them.
		 */
		menu.addItem((item) => item
			.setTitle('Edit its boxes…')
			.setIcon('list')
			.setDisabled(!(dynamic.file instanceof TFile))
			.onClick(() => this.openDynamicView(dynamic)));

		menu.addItem((item) => item
			.setTitle('New dynamic view…')
			.setIcon('layers')
			.onClick(() => this.promptForDynamicView()));

		menu.addSeparator();

		menu.addItem((item) => item
			.setTitle('Rename…')
			.setIcon('pencil')
			.onClick(() => this.promptRenameDynamic(dynamic)));

		menu.addItem((item) => item
			.setTitle('Hide it when there is nothing to show')
			.setIcon('eye-off')
			.setChecked(!!dynamic.hideEmpty)
			.onClick(() => this.setHideEmpty(dynamic, !dynamic.hideEmpty)));

		menu.addItem((item) => item
			.setTitle('Show every base at once')
			.setIcon('rows-3')
			.setChecked(!!dynamic.stacked)
			.onClick(() => this.setStacked(dynamic, !dynamic.stacked)));

		menu.addItem((item) => item
			.setTitle('Show at the top of every note')
			.setIcon('pin')
			.setChecked(!!dynamic.embed)
			.onClick(() => this.setEmbed(dynamic, !dynamic.embed)));

		menu.addSeparator();

		menu.addItem((item) => item
			.setTitle('Delete')
			.setIcon('trash-2')
			.setWarning(true)
			.onClick(() => this.promptDeleteDynamic(dynamic)));

		if (anchor instanceof MouseEvent) menu.showAtMouseEvent(anchor);
		else menu.showAtPosition(anchorPosition(anchor));
	}

	/* The boxes are text, and text is edited where there is room for it. */
	openSettings() {
		const setting = this.app.setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	promptForDynamicView() {
		new PromptModal(this.app, 'New dynamic view', '', 'Create', (name) => {
			/*
			 * A file, in the folder the settings name. No base picker chained on
			 * behind it: the new one lands empty, and where to change that is the
			 * menu on its pill, not a second modal arriving unasked.
			 */
			this.createDynamicView(name);
		}).open();
	}

	/*
	 * The name is the file name, so renaming one is renaming a file - and Obsidian
	 * rewrites any link to it, which a name inside the file could never have
	 * bought.
	 */
	promptRenameDynamic(dynamic) {
		new PromptModal(this.app, 'Rename dynamic view', dynamic.name, 'Rename',
			(name) => { this.renameDynamicView(dynamic, name); }).open();
	}

	promptDeleteDynamic(dynamic) {
		const count = dynamic.boxes.length;
		new ConfirmModal(this.app,
			'Delete "' + (dynamic.name || 'Untitled') + '"?',
			count === 0
				? 'It is empty, so nothing is lost.'
				: 'Its ' + count + (count === 1 ? ' box' : ' boxes')
					+ ' will be lost. The bases themselves are untouched.',
			'Delete',
			() => { this.deleteDynamic(dynamic); }).open();
	}

	/*
	 * Tabs, or all of them at once. Per dynamic view rather than global: a list of
	 * three dashboards is read down, and a list of twelve is switched between.
	 */
	async setStacked(dynamic, stacked) {
		dynamic.stacked = !!stacked;
		this.rebuildAll();
		await this.writeDynamicView(dynamic);
	}

	/*
	 * Whether a dynamic view that resolves to nothing draws nothing, or says so.
	 *
	 * Per dynamic view, like everything else here, and **on by default**: one fed
	 * by `file.views()` is empty on most notes, and a band at the top of every note
	 * offering a button on every note that is not a Project is the complaint this
	 * exists to answer.
	 */
	/*
	 * The chevron on a band's header.
	 *
	 * It used to flip `collapsed`, save, and call `syncBands()` - which without
	 * `force` only re-mounts and re-aims the bands it already has and never
	 * redraws their sections. So the flag moved, the file was written, and nothing
	 * on the screen changed: an arrow that did nothing at all.
	 *
	 * Collapsed is a property of the dynamic view rather than of the note, like its
	 * height and its layout, so it applies wherever the band is drawn. The header
	 * says so on hover.
	 */
	/*
	 * Whether the definition is unfolded in this dynamic view's own tab. Furniture,
	 * like `collapsed` and `height`: it is where you left something, not what the
	 * dynamic view is, so it stays out of the file.
	 */
	async setEditing(dynamic, editing) {
		dynamic.editing = !!editing;
		await this.saveState(dynamic);
		this.rebuildAll();
	}

	async setCollapsed(dynamic, collapsed) {
		dynamic.collapsed = !!collapsed;
		await this.saveState(dynamic);
		this.rebuildAll();
	}

	async setHideEmpty(dynamic, hide) {
		dynamic.hideEmpty = !!hide;
		this.rebuildAll();
		await this.writeDynamicView(dynamic);
	}

	async setEmbed(dynamic, embed) {
		dynamic.embed = !!embed;
		this.rebuildAll();
		await this.writeDynamicView(dynamic);
	}

	async deleteDynamic(dynamic) {
		const all = this.dynamicViews();
		const at = all.indexOf(dynamic);

		if (this.settings.activeView === dynamic.path) {
			/* Land on the neighbour, which is where the eye already is. */
			const next = all[Math.min(at + 1, all.length - 1)] || all[at - 1] || null;
			this.settings.activeView = next && next !== dynamic ? next.path : '';
		}
		if (this.settings.state) delete this.settings.state[dynamic.path];
		await this.saveSettings();

		/* The `delete` event re-reads and rebuilds; nothing to do here after it. */
		await this.trashDynamicView(dynamic);
	}

	/* ----- commands --------------------------------------------------------- */

	/*
	 * The two ways out of a band: the sidebar pane, or this dynamic view's own file
	 * in a tab. Nothing here edits anything - both items only move you somewhere
	 * the editing lives, which is why this is not the pill's menu with the
	 * destructive half removed.
	 *
	 * A missing file keeps its place with the reason in the label, since a disabled
	 * Obsidian menu item swallows its own click.
	 */
	openMenu(dynamic, event, bases) {
		const menu = new Menu();

		/*
		 * The base he is looking at, first - his ask (2026-09-03), and the right
		 * order: a band is a way of reading one base about this note, so the thing
		 * on the screen comes before the dynamic view that assembled it.
		 *
		 * Opened by its link, subpath and all, because Obsidian resolves
		 * `X.base#a view` to that base *at that view* on its own. In its own tab it
		 * is an ordinary base again, so `this` follows the active note the way any
		 * base does - it is not pinned to the note the band was drawn on.
		 */
		for (const { entry, label } of (bases || [])) {
			const openable = entry && entry.file instanceof TFile;
			menu.addItem((item) => item
				.setTitle(openable
					? 'Open ' + label + ' in a new tab'
					: 'Open ' + label + ' — no such base')
				.setIcon('table')
				.setDisabled(!openable)
				.onClick(() => this.openBaseEntry(entry)));
		}

		if (bases && bases.length) menu.addSeparator();

		menu.addItem((item) => item
			.setTitle('Open the dynamic views pane')
			.setIcon('panel-right')
			.onClick(() => this.openPane()));

		const openable = dynamic && dynamic.file instanceof TFile;
		menu.addItem((item) => item
			.setTitle(openable
				? 'Open the dynamic view in a new tab'
				: 'Open the dynamic view — no file')
			.setIcon('file-symlink')
			.setDisabled(!openable)
			.onClick(() => this.openDynamicView(dynamic)));

		if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
		else menu.showAtPosition(anchorPosition(event));
	}

	async openPane() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async cycleDynamic(step) {
		const all = this.dynamicViews();
		if (all.length < 2) {
			new Notice('There is only one dynamic view.');
			return;
		}

		const at = all.findIndex((dynamic) => dynamic.path === this.settings.activeView);
		const next = all[((at === -1 ? 0 : at) + step + all.length) % all.length];
		this.settings.activeView = next.path;
		await this.saveSettings();

		const pane = this.pane();
		if (pane) pane.rebuild();
		else await this.openPane();
	}
}

/* ---------------------------------------------------------------- settings */

class DynamicViewerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('dynamic-viewer-settings');

		new Setting(containerEl)
			.setName('Folder for new dynamic views')
			.setDesc('Where "New dynamic view" puts the .dview file. An existing one '
				+ 'is found wherever it lives, like a .base.')
			.addText((text) => text
				.setPlaceholder('Obsidian/Dynamic Views')
				.setValue(this.plugin.settings.folder)
				.onChange(async (value) => {
					this.plugin.settings.folder = value.trim();
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			/*
			 * What an entry may *be*, which is this plugin's business. What
			 * file.views() answers, and why, is OOF Class Manager's - naming the
			 * function is enough here, and reciting its rules would be this plugin
			 * teaching a model it does not own.
			 */
			text: 'A dynamic view is a list of bases shown as tabs, always about the note '
				+ 'you are reading. An entry is either a link - [[Improvement Base.base'
				+ '#dynamic project]] - or the call file.views(), answered by OOF Class '
				+ 'Manager. One entry per line, and the + on the tab strip adds one for you.',
		});

		/*
		 * Where a band sits, asked once per mode (his ask, 2026-09-03).
		 *
		 * The two modes get their own answer because they are two different DOMs:
		 * in editing mode all three places are ordinary siblings in `.cm-sizer`,
		 * while in reading mode the sizer's children belong to the preview
		 * renderer and each place had to be found somewhere it is left alone.
		 */
		new Setting(containerEl).setName('Where a band sits in the note').setHeading();

		const places = {
			title: 'Above the file name',
			properties: 'Under the properties',
			bottom: 'After the body text',
		};
		/*
		 * An embed cannot say *above the file name* - the title and the properties
		 * are not in the document - so that answer is left out of the list while it
		 * is on, rather than being offered and quietly ignored. The stored value is
		 * not touched, so switching back to the layout gives him his choice back;
		 * until then the dropdown shows what the band is really doing.
		 */
		const positionSetting = (name, desc, key, without) => {
			const gone = without || [];
			const chosen = gone.includes(this.plugin.settings[key])
				? 'properties'
				: this.plugin.settings[key];
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addDropdown((drop) => {
					for (const value of Object.keys(places)) {
						if (!gone.includes(value)) drop.addOption(value, places[value]);
					}
					drop
						.setValue(chosen)
						.onChange(async (value) => {
							this.plugin.settings[key] = value;
							await this.plugin.saveSettings();
							/* Every band moves at once: the anchor is read live, so a
							 * forced sync is the whole of it. */
							this.plugin.syncBands(true);
						});
				});
		};

		const embedded = this.plugin.settings.editAttach === 'embed';

		positionSetting('Editing and live preview',
			embedded
				? 'An embed is a block in the document, so it can only sit where the text '
					+ 'does. Above the file name is not one of its answers, because the '
					+ 'title and the properties are not part of the document at all.'
				: 'After the body text is the only one of the three that leaves Obsidian’s '
					+ 'own scroll restoring alone. Above the text, a band the height of a '
					+ 'screen puts the start of the note somewhere Obsidian cannot scroll '
					+ 'back to, so switching modes lands you elsewhere in the file.',
			'editPosition',
			embedded ? ['title'] : []);

		new Setting(containerEl)
			.setName('How a band is attached in editing mode')
			.setDesc('In the note’s layout puts it beside the properties, as a piece of the '
				+ 'pane. As an embed makes it a block inside the document, exactly the way '
				+ '![[a base]] is drawn — with nothing written into the file. The embed is '
				+ 'the tidier of the two: the band’s height belongs to the editor rather '
				+ 'than sitting above it, so scrolling and mode switches need no correcting. '
				+ 'It cannot offer Above the file name, because the title and the properties '
				+ 'are not part of the document. Reading mode is unaffected either way.')
			.addDropdown((drop) => {
				drop.addOption('layout', 'In the note’s layout');
				drop.addOption('embed', 'As an embed in the document');
				drop
					.setValue(this.plugin.settings.editAttach)
					.onChange(async (value) => {
						this.plugin.settings.editAttach = value;
						await this.plugin.saveSettings();
						/* Both, and in this order: the field has to be asked again
						 * before the bands are told where they now live. */
						this.plugin.reclaimBands();
						this.plugin.syncBands(true);
						/* Which positions exist depends on this answer, and the
						 * dropdown that offers them is drawn above this one. */
						this.display();
					});
			});

		positionSetting('Reading',
			'After the body text lands below the backlinks here, not between them and the '
			+ 'text: that gap belongs to Obsidian’s preview renderer, which takes anything '
			+ 'foreign back out of it as you scroll.',
			'readPosition');

		const oof = this.app.plugins.plugins['oof-objects'];
		if (!oof || typeof oof.viewsFor !== 'function') {
			containerEl.createEl('p', {
				cls: 'dynamic-viewer-warning',
				text: 'OOF Class Manager is not enabled, so file.views() and '
					+ 'file.classBase() answer nothing. Links typed by hand still work.',
			});
		}

		/*
		 * What exists, and the way to each one - not what each one is. A dynamic
		 * view's definition lives in its own file, so this lists them and gets out
		 * of the way; a settings tab holding every dynamic view's boxes was the
		 * definition living somewhere the file could not see (his ask, 2026-09-03).
		 */
		const all = this.plugin.dynamicViews();
		if (all.length) {
			new Setting(containerEl).setName('Dynamic views').setHeading();
			all.forEach((dynamic, i) => this.drawRow(containerEl, dynamic, i, all.length));
		}

		new Setting(containerEl)
			.addButton((button) => button
				.setButtonText('Add a dynamic view')
				.setCta()
				.onClick(() => this.plugin.promptForDynamicView()));
	}

	/*
	 * One line per dynamic view: what it holds, and a button that opens it. Every
	 * control that changes one is in that file's own window.
	 */
	drawRow(containerEl, dynamic, index, total) {
		const boxes = dynamic.boxes.length;
		const where = [];
		if (dynamic.embed) where.push('at the top of every note');
		if (dynamic.stacked) where.push('stacked');

		/*
		 * The order lives here rather than on a pill or in the file: it is a fact
		 * about the collection, not about any one dynamic view, and the pane and
		 * the band both report rather than edit (his rule, 2026-09-02).
		 *
		 * The ends keep their buttons, greyed, so the rows do not change width as
		 * they move - a control that disappears is one you hunt for.
		 */
		const setting = new Setting(containerEl)
			.setName(dynamic.name)
			.setDesc(boxes + (boxes === 1 ? ' box' : ' boxes')
				+ (where.length ? ' — ' + where.join(', ') : '')
				+ ' — ' + dynamic.path);

		const move = (icon, by, at) => setting.addExtraButton((button) => {
			button
				.setIcon(icon)
				.setTooltip(at ? 'Already ' + (by < 0 ? 'first' : 'last')
					: 'Move ' + (by < 0 ? 'up' : 'down') + ' — the order a note draws them in')
				.onClick(() => {
					if (at) return;
					this.plugin.moveDynamicView(dynamic, by);
					this.display();
				});
			button.extraSettingsEl.toggleClass('is-disabled', at);
		});

		move('chevron-up', -1, index === 0);
		move('chevron-down', 1, index === total - 1);

		setting.addExtraButton((button) => button
			.setIcon('file-symlink')
			.setTooltip('Open it, and everything it can be changed by')
			.onClick(() => this.plugin.openDynamicView(dynamic)));
	}
}

module.exports = DynamicViewerPlugin;
