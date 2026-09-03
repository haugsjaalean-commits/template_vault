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
 * The functions a function box may hold. One so far — OOF Class Manager's
 * `file.views()` — matched by name rather than parsed, because Obsidian exports
 * no formula parser and one function needs no grammar. A second joins by adding
 * a row here.
 */
const FUNCTIONS = [
	{
		name: 'file.views()',
		test: /^file\s*\.\s*views\s*\(\s*\)$/i,
		describe: 'The bases this note is looked at through, from OOF Class Manager.',
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
	 * Where the band goes: **inside the note's own scroll area, directly under the
	 * properties**, so it moves with the note the way an embed does.
	 *
	 * It used to sit between the tab header and `contentEl` — outside the scroller,
	 * so it ate the same strip of every note for ever, which is what he asked to be
	 * rid of. This is the more literal reading of his original *"at the top of the
	 * note"*, and it is CodeMirror's DOM, so everything below is about surviving in
	 * someone else's tree.
	 *
	 * Both modes are in the document at once — `.markdown-source-view` and
	 * `.markdown-reading-view` are siblings with one hidden — so the band follows
	 * whichever the view says it is in, and only ever one base query is live per
	 * note. The paths are `:scope >` chains rather than a loose `querySelector`,
	 * or an embedded note inside this one would offer its own sizer first.
	 */
	anchorFor() {
		const view = this.view;
		if (!view || !view.contentEl) return null;

		const reading = typeof view.getMode === 'function' && view.getMode() === 'preview';
		const root = view.contentEl.querySelector(reading
			? ':scope > .markdown-reading-view'
			: ':scope > .markdown-source-view');
		if (!root) return null;

		const sizer = root.querySelector(reading
			? ':scope > .markdown-preview-view > .markdown-preview-sizer'
			: ':scope > .cm-editor > .cm-scroller > .cm-sizer');
		if (!sizer) return null;

		/*
		 * The properties are a direct child of the sizer in live preview and are
		 * wrapped in `.mod-header` in reading mode, so the anchor is *whichever
		 * child of the sizer contains them* rather than the container itself.
		 */
		const childHolding = (selector) => {
			let node = sizer.querySelector(selector);
			while (node && node.parentElement !== sizer) node = node.parentElement;
			return node;
		};

		return {
			sizer: sizer,
			after: childHolding('.metadata-container')
				|| childHolding('.inline-title')
				|| null,
		};
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

		this.watch(spot.sizer);

		const here = spot.after ? spot.after.nextElementSibling : spot.sizer.firstElementChild;
		if (here === this.el) return true;

		if (spot.after) spot.after.insertAdjacentElement('afterend', this.el);
		else spot.sizer.prepend(this.el);
		return true;
	}

	/*
	 * The sizer's children are not ours. CodeMirror rebuilds them, and reading mode
	 * renders its sections as you scroll — either can carry the band away without
	 * any workspace event firing. So the sizer is watched, and anything that
	 * changes its children re-runs the idempotent mount.
	 */
	watch(sizer) {
		if (this.watched === sizer) return;

		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		this.watched = sizer || null;
		if (!sizer) return;

		this.observer = new MutationObserver(() => {
			if (this.remounting) return;
			this.remounting = true;
			window.requestAnimationFrame(() => {
				this.remounting = false;
				if (this.el && !this.stale()) this.mount();
			});
		});
		this.observer.observe(sizer, { childList: true });
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
			if (live) this.plugin.openMenu(live, event);
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
				text: 'OOF Class Manager is not enabled, so file.views() answers nothing. '
					+ 'Links typed by hand still work.',
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

		/* path -> the dynamic view read out of that file. */
		this.views = new Map();

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
		return Array.from(this.views.values())
			.sort((a, b) => a.name.localeCompare(b.name));
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
	openMenu(dynamic, event) {
		const menu = new Menu();

		menu.addItem((item) => item
			.setTitle('Open the dynamic views pane')
			.setIcon('panel-right')
			.onClick(() => this.openPane()));

		const openable = dynamic && dynamic.file instanceof TFile;
		menu.addItem((item) => item
			.setTitle(openable ? 'Open in a new tab' : 'Open in a new tab — no file')
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

		const oof = this.app.plugins.plugins['oof-objects'];
		if (!oof || typeof oof.viewsFor !== 'function') {
			containerEl.createEl('p', {
				cls: 'dynamic-viewer-warning',
				text: 'OOF Class Manager is not enabled, so file.views() answers nothing. '
					+ 'Links typed by hand still work.',
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
			for (const dynamic of all) this.drawRow(containerEl, dynamic);
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
	drawRow(containerEl, dynamic) {
		const boxes = dynamic.boxes.length;
		const where = [];
		if (dynamic.embed) where.push('at the top of every note');
		if (dynamic.stacked) where.push('stacked');

		new Setting(containerEl)
			.setName(dynamic.name)
			.setDesc(boxes + (boxes === 1 ? ' box' : ' boxes')
				+ (where.length ? ' — ' + where.join(', ') : '')
				+ ' — ' + dynamic.path)
			.addExtraButton((button) => button
				.setIcon('file-symlink')
				.setTooltip('Open it, and everything it can be changed by')
				.onClick(() => this.plugin.openDynamicView(dynamic)));
	}
}

module.exports = DynamicViewerPlugin;
