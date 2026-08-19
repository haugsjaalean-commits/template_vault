'use strict';

/*
 * Bases Word Count
 * ----------------
 * Adds three functions to the Bases formula language:
 *
 *     file.wordCount()     words in the note body
 *     file.charCount()     characters in the note body
 *     file.readingTime()   minutes, at the configured words-per-minute
 *
 * They work anywhere a Bases expression works: formulas, filters, sorts.
 *
 * How it hooks in
 * ---------------
 * Obsidian keeps one registry of Bases functions, and Plugin.prototype exposes
 * two methods that write to it:
 *
 *     registerGlobalFunc(fn)          -> now(), today(), if(), ...
 *     registerInstanceFunc(Type, fn)  -> file.hasTag(), file.inFolder(), ...
 *
 * Both deregister themselves when the plugin unloads. A function is a plain
 * object: { name, params, docString, applyWithContext(ctx, ...args) }. The
 * evaluator type-checks each argument against params[i].type by instanceof
 * before calling, so ours are checked exactly like the built-ins, and the
 * formula editor's autocomplete lists them from the same registry.
 *
 * Why there is an index
 * ---------------------
 * Formula evaluation is synchronous - the engine calls applyWithContext and
 * expects a Value back immediately - but reading a file is not. So counts live
 * in an in-memory Map (path -> {words, chars}), persisted to data.json and
 * validated against mtime+size, and the functions are pure lookups.
 *
 * Keeping the view honest
 * -----------------------
 * BasesEntry caches formula outputs per entry (formulaResults.cachedFormulaOutputs),
 * so nudging a view to re-render is not enough - the cache has to be thrown away
 * with the entries. Clearing controller.queryState forces controller.update()
 * down the runQuery path, which rebuilds every entry. That is what refreshBases()
 * does, debounced, whenever a count actually changes.
 */

const obsidian = require('obsidian');

const { Plugin, PluginSettingTab, Setting, TFile, Notice } = obsidian;

const DATA_VERSION = 1;

const DEFAULT_SETTINGS = {
	includeFrontmatter: false,
	includeCodeBlocks: true,
	includeComments: false,
	includeLinkTargets: false,
	wordsPerMinute: 200,
};

/* Files read per batch before yielding back to the UI thread. */
const SCAN_BATCH = 100;

/*
 * CJK and Hangul are counted one character per word, the way most word counters
 * treat them; everything else is counted as runs of letters/digits.
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu;

const FENCED_CODE_RE = /^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const OBSIDIAN_COMMENT_RE = /%%[\s\S]*?%%/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
/* Embeds show someone else's words (or an image), so they count for nothing. */
const EMBED_WIKI_RE = /!\[\[[^\n]*?\]\]/g;
const EMBED_MARKDOWN_RE = /!\[[^\][]*\]\([^()\s]*\)/g;
const WIKILINK_RE = /\[\[([^\n]*?)\]\]/g;
const MARKDOWN_LINK_RE = /\[([^\][]*)\]\([^()\s]*\)/g;

function sleep(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/*
 * Reduce a note to the text that should be counted. Everything switched off in
 * settings is replaced with a space rather than deleted, so removing a code
 * block can never glue two words together.
 */
function extractCountableText(content, settings) {
	let text = content;

	if (!settings.includeFrontmatter) {
		const info = obsidian.getFrontMatterInfo(text);
		if (info && info.exists) text = text.slice(info.contentStart);
	}

	if (!settings.includeComments) {
		text = text.replace(OBSIDIAN_COMMENT_RE, ' ').replace(HTML_COMMENT_RE, ' ');
	}

	if (!settings.includeCodeBlocks) {
		text = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');
	}

	if (!settings.includeLinkTargets) {
		text = text.replace(EMBED_WIKI_RE, ' ').replace(EMBED_MARKDOWN_RE, ' ');
		/* A link keeps only the text a reader actually sees. */
		text = text.replace(WIKILINK_RE, function (match, inner) {
			return ' ' + wikilinkDisplay(inner) + ' ';
		});
		text = text.replace(MARKDOWN_LINK_RE, ' $1 ');
	}

	return text;
}

/*
 * What Obsidian renders for [[...]]: the alias if there is one, otherwise the
 * heading or the file name, never the folders in between.
 */
function wikilinkDisplay(inner) {
	const pipe = inner.lastIndexOf('|');
	if (pipe !== -1) return inner.slice(pipe + 1);
	return inner.split('#').pop().split('/').pop();
}

function countWords(text) {
	let words = 0;

	const cjk = text.match(CJK_RE);
	if (cjk) {
		words += cjk.length;
		text = text.replace(CJK_RE, ' ');
	}

	const rest = text.match(WORD_RE);
	if (rest) words += rest.length;

	return words;
}

function countChars(text) {
	return text.trim().length;
}

/*
 * One Bases function. The engine calls applyWithContext(ctx, subject) after
 * checking the subject against params[0].type; serialize() is what the filter
 * builder writes back into the .base file.
 */
class FileStatFunction {
	constructor(plugin, name, docString, compute) {
		this.plugin = plugin;
		this.name = name;
		this.docString = docString;
		this.compute = compute;
		this.params = [{ name: 'self', type: [obsidian.FileValue] }];
	}

	applyWithContext(ctx, subject) {
		return this.apply(subject);
	}

	apply(subject) {
		const file = subject && subject.file;
		if (!file || file.extension !== 'md') return obsidian.NullValue.value;

		const entry = this.plugin.index.get(file.path);
		if (!entry) {
			/* Not indexed yet (new file, or the first scan is still running). */
			this.plugin.requestIndex(file);
			return obsidian.NullValue.value;
		}

		return new obsidian.NumberValue(this.compute(entry, this.plugin.settings));
	}

	serialize() {
		const args = Array.prototype.slice.call(arguments);
		return args[0] + '.' + this.name + '()';
	}
}

class BasesWordCountPlugin extends Plugin {
	async onload() {
		this.index = new Map();
		this.settings = Object.assign({}, DEFAULT_SETTINGS);
		this.pending = new Set();
		this.scanning = false;

		await this.loadState();

		this.requestRefresh = obsidian.debounce(this.refreshBases.bind(this), 400, true);
		this.requestSave = obsidian.debounce(this.saveState.bind(this), 2000, true);
		this.flushPending = obsidian.debounce(this.indexPending.bind(this), 200, true);

		if (!this.registerFunctions()) return;

		this.addSettingTab(new BasesWordCountSettingTab(this.app, this));

		this.addCommand({
			id: 'recount-all',
			name: 'Recount all notes',
			callback: () => { this.scanVault(true); },
		});

		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			this.onFileChanged(file);
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (this.index.delete(file.path)) this.requestSave();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			const entry = this.index.get(oldPath);
			if (!entry) return;
			this.index.delete(oldPath);
			this.index.set(file.path, entry);
			this.requestSave();
		}));

		this.app.workspace.onLayoutReady(() => { this.scanVault(false); });
	}

	onunload() {
		/* registerInstanceFunc deregisters itself; just make sure state is on disk. */
		this.saveState();
	}

	/*
	 * These APIs arrived with Bases. Fail loudly rather than silently doing
	 * nothing if a future version moves them.
	 */
	registerFunctions() {
		if (typeof this.registerInstanceFunc !== 'function' || !obsidian.FileValue) {
			new Notice('Bases Word Count: this Obsidian version does not expose the Bases function registry.', 8000);
			console.error('bases-word-count: Plugin.registerInstanceFunc or FileValue is missing.');
			return false;
		}

		this.registerInstanceFunc(obsidian.FileValue, new FileStatFunction(
			this, 'wordCount', 'Number of words in the note body.',
			(entry) => entry.words,
		));
		this.registerInstanceFunc(obsidian.FileValue, new FileStatFunction(
			this, 'charCount', 'Number of characters in the note body.',
			(entry) => entry.chars,
		));
		this.registerInstanceFunc(obsidian.FileValue, new FileStatFunction(
			this, 'readingTime', 'Estimated reading time in minutes.',
			(entry, settings) => {
				const wpm = Math.max(1, settings.wordsPerMinute);
				return Math.round((entry.words / wpm) * 10) / 10;
			},
		));

		return true;
	}

	/* ----- the index ------------------------------------------------------ */

	/*
	 * Returns true when the stored numbers changed, which is the only case that
	 * warrants redrawing a base.
	 */
	async indexFile(file, force) {
		const previous = this.index.get(file.path);
		if (!force && previous && previous.mtime === file.stat.mtime && previous.size === file.stat.size) {
			return false;
		}

		let content;
		try {
			content = await this.app.vault.cachedRead(file);
		} catch (error) {
			console.error('bases-word-count: could not read ' + file.path, error);
			return false;
		}

		const text = extractCountableText(content, this.settings);
		const entry = {
			words: countWords(text),
			chars: countChars(text),
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		this.index.set(file.path, entry);

		return !previous || previous.words !== entry.words || previous.chars !== entry.chars;
	}

	async scanVault(force) {
		if (this.scanning) return;
		this.scanning = true;

		try {
			const files = this.app.vault.getMarkdownFiles();
			const seen = new Set();
			let changed = 0;

			for (let i = 0; i < files.length; i++) {
				seen.add(files[i].path);
				if (await this.indexFile(files[i], force)) changed++;
				if (i % SCAN_BATCH === SCAN_BATCH - 1) await sleep(0);
			}

			/* Drop notes that vanished while the plugin was not running. */
			for (const path of Array.from(this.index.keys())) {
				if (!seen.has(path)) {
					this.index.delete(path);
					changed++;
				}
			}

			if (changed > 0) {
				this.saveState();
				this.refreshBases();
			}
		} finally {
			this.scanning = false;
		}
	}

	/*
	 * Bases re-runs its query on metadataCache "changed" too. Our recount is a
	 * read, so it lands a tick later - hence the explicit refresh afterwards.
	 */
	async onFileChanged(file) {
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		if (await this.indexFile(file, false)) {
			this.requestSave();
			this.requestRefresh();
		}
	}

	/* Asked for by a formula that hit an unindexed file. */
	requestIndex(file) {
		if (this.index.has(file.path)) return;
		this.pending.add(file.path);
		this.flushPending();
	}

	async indexPending() {
		const paths = Array.from(this.pending);
		this.pending.clear();

		let changed = 0;
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			if (file instanceof TFile && await this.indexFile(file, false)) changed++;
		}

		if (changed > 0) {
			this.requestSave();
			this.requestRefresh();
		}
	}

	/* ----- redrawing open bases ------------------------------------------- */

	/*
	 * Every Bases surface - the .base file view, an embed, a code block - owns a
	 * QueryController and adds it as a child component, so walking the component
	 * tree of each leaf finds all of them.
	 */
	getQueryControllers() {
		const controllers = new Set();

		const visit = (component, depth) => {
			if (!component || depth > 8) return;

			if (typeof component.queryState === 'string' && typeof component.update === 'function') {
				controllers.add(component);
			}
			if (component.controller && typeof component.controller.update === 'function'
				&& typeof component.controller.queryState === 'string') {
				controllers.add(component.controller);
			}

			const children = component._children;
			if (Array.isArray(children)) {
				for (const child of children) visit(child, depth + 1);
			}
		};

		this.app.workspace.iterateAllLeaves((leaf) => { visit(leaf.view, 0); });

		return controllers;
	}

	refreshBases() {
		for (const controller of this.getQueryControllers()) {
			try {
				/* Force update() down the runQuery path so entry formula caches go too. */
				controller.queryState = '';
				controller.update();
			} catch (error) {
				console.error('bases-word-count: failed to refresh a base', error);
			}
		}
	}

	/* ----- persistence ---------------------------------------------------- */

	async loadState() {
		const data = await this.loadData();
		if (!data) return;

		if (data.settings) Object.assign(this.settings, data.settings);

		if (data.version === DATA_VERSION && data.index) {
			for (const path of Object.keys(data.index)) {
				const entry = data.index[path];
				if (entry && typeof entry.words === 'number') this.index.set(path, entry);
			}
		}
	}

	async saveState() {
		const index = {};
		for (const [path, entry] of this.index) index[path] = entry;
		await this.saveData({ version: DATA_VERSION, settings: this.settings, index: index });
	}

	/* Counting rules changed, so every stored number is suspect. */
	async applySettings() {
		await this.saveState();
		await this.scanVault(true);
	}
}

class BasesWordCountSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: 'Use file.wordCount(), file.charCount() and file.readingTime() in any base formula, '
				+ 'filter or sort. Changing a counting rule below recounts the whole vault.',
			cls: 'setting-item-description',
		});

		this.addToggle(containerEl, 'Count frontmatter', 'Include the YAML block at the top of the note.', 'includeFrontmatter');
		this.addToggle(containerEl, 'Count code', 'Include fenced code blocks and inline code.', 'includeCodeBlocks');
		this.addToggle(containerEl, 'Count comments', 'Include %% Obsidian %% and HTML comments.', 'includeComments');
		this.addToggle(containerEl, 'Count link targets', 'Include the target of a link as well as its display text.', 'includeLinkTargets');

		new Setting(containerEl)
			.setName('Reading speed')
			.setDesc('Words per minute, used by file.readingTime().')
			.addText((text) => text
				.setValue(String(this.plugin.settings.wordsPerMinute))
				.onChange(async (value) => {
					const wpm = parseInt(value, 10);
					if (!isFinite(wpm) || wpm <= 0) return;
					this.plugin.settings.wordsPerMinute = wpm;
					/* Only the derived value changes, so no recount is needed. */
					await this.plugin.saveState();
					this.plugin.refreshBases();
				}));

		new Setting(containerEl)
			.setName('Index')
			.setDesc(this.plugin.index.size + ' notes counted.')
			.addButton((button) => button
				.setButtonText('Recount all notes')
				.onClick(async () => {
					button.setDisabled(true);
					await this.plugin.scanVault(true);
					button.setDisabled(false);
					this.display();
				}));
	}

	addToggle(containerEl, name, desc, key) {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings[key])
				.onChange(async (value) => {
					this.plugin.settings[key] = value;
					await this.plugin.applySettings();
				}));
	}
}

module.exports = BasesWordCountPlugin;
