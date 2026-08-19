'use strict';

/*
 * Bases Formulas
 * --------------
 * A right-sidebar panel over the formulas of every base in the vault. There is
 * one list of formulas, and it is shared: a formula written once is defined in
 * every base, so it shows up in every base's column picker, filter menu and
 * sort menu without being retyped.
 *
 * The three things the panel does
 * -------------------------------
 *   add       a formula written here is pushed into every base
 *   subtract  a formula removed here is taken out of every base
 *   view      every formula, its expression, and which bases carry it
 *
 * and one qualifier: a formula can be limited to chosen bases - `Only` those
 * listed, or every base `Except` those listed.
 *
 * The list is not stored in a note
 * --------------------------------
 * It lives in this plugin's data.json. The bases are the copies; data.json is
 * the original. That is what makes "adding a formula to one base adds it to
 * all" possible at all - there has to be somewhere that holds the union.
 *
 * Both directions
 * ---------------
 * He will not always come here first. Obsidian's own base UI can add a formula
 * too, and when it does, the plugin adopts it: an unknown formula found in a
 * base is added to the shared list and propagated to the others. So "adding a
 * formula to one base adds it to all bases" holds whichever way it was added.
 *
 * Which way an edit travels is decided by a snapshot of what was last written
 * to each base:
 *
 *     base differs from the snapshot   -> he edited the base, the base wins
 *     base matches the snapshot        -> the list changed, the list wins
 *
 * A formula deleted from a base through the base UI is put back. Removing one
 * for good is what the panel's x is for - otherwise a formula shared by twelve
 * bases could be destroyed by tidying one of them. A formula deliberately kept
 * out of a base is what `Except` is for.
 *
 * Writing into his files
 * ----------------------
 * This plugin edits `.base` files, so it edits by *surgery*, not by
 * re-serialising: it replaces the `formulas:` block, the `formula.*` entries
 * under `properties:`, and nothing else. Every other line of the file - views,
 * filters, column widths, the graph state Obsidian churns - comes out byte for
 * byte identical. Re-emitting a parsed file would reformat all of it and lose
 * anything the parser did not model.
 *
 * `Sync now` shows a plan of every file and every line that would change, and
 * writes only once it is confirmed. Auto-sync does the same work without the
 * confirmation, which is the point of it; turn it off in the settings and
 * nothing is ever written except through the plan.
 *
 * One thing it will not do unasked
 * --------------------------------
 * Defining a formula in a base does not make it a visible column - a column
 * appears when a view's `order:` names it. Adding columns to every view of
 * every base on its own would rearrange tables he built by hand, so it is a
 * button per formula instead ("Add as column"), and even then only views that
 * already have an `order:` list are touched. A view with no `order:` is
 * showing Obsidian's default columns; giving it a one-item `order:` would hide
 * the rest.
 */

const obsidian = require('obsidian');

const { Plugin, PluginSettingTab, Setting, ItemView, Modal, Notice, parseYaml, setIcon } = obsidian;

const VIEW_TYPE = 'bases-formulas-panel';

const DEFAULT_SETTINGS = {
	/* Write to the bases as soon as anything changes, without a plan. */
	autoSync: true,
	/* Pick up formulas written through Obsidian's own base UI. */
	adoptFromBases: true,
	/* Manage the `displayName` under `properties:` as well as the expression. */
	manageDisplayNames: true,
	/* '' means the whole vault. */
	basesFolder: '',
	/* How long to wait after a base changes before syncing, in milliseconds. */
	syncDelay: 900,
};

/* --------------------------------------------------------------- the model */

/*
 * scope: 'all'    - every base
 *        'only'   - the bases listed
 *        'except' - every base but the ones listed
 */
function newFormula(name, expression) {
	return {
		name: name,
		expression: expression || '',
		displayName: '',
		scope: 'all',
		bases: [],
	};
}

function appliesTo(formula, path) {
	if (formula.scope === 'only') return formula.bases.indexOf(path) !== -1;
	if (formula.scope === 'except') return formula.bases.indexOf(path) === -1;
	return true;
}

/* ------------------------------------------------------------ yaml writing */

function quoted(value) {
	/* Single quotes: expressions are full of double quotes, and his own bases
	 * already quote this way (`'!file.inFolder("...")'`). */
	return "'" + String(value).replace(/'/g, "''") + "'";
}

function yamlKey(name) {
	if (/^[A-Za-z0-9][A-Za-z0-9 _\-.()]*$/.test(name)) return name;
	return quoted(name);
}

function yamlValue(value) {
	const v = String(value);
	if (v === '') return '""';
	if (/^\s|\s$/.test(v)) return quoted(v);
	if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return quoted(v);
	if (/:\s/.test(v) || /\s#/.test(v) || /:$/.test(v)) return quoted(v);
	return v;
}

/* Formula names are used as `formula.<name>` wherever a view refers to one. */
function formulaRef(name) {
	return 'formula.' + name;
}

/* ---------------------------------------------------------- text surgery -- */

function indentOf(line) {
	const m = /^(\s*)/.exec(line);
	return m[1].length;
}

/*
 * The top-level keys of a .base file, in the order they appear, each with the
 * range of lines belonging to it. A .base is a map at the top level, so a line
 * at indent 0 that is not blank and not a comment starts a new key.
 */
function scanTopLevel(lines) {
	const blocks = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		if (/^\s/.test(line)) continue;
		if (line.startsWith('#') || line.startsWith('-')) continue;
		const m = /^([^:]+):/.exec(line);
		if (!m) continue;
		blocks.push({
			key: m[1].trim().replace(/^["']|["']$/g, ''),
			start: i,
			end: lines.length,
		});
	}
	for (let i = 0; i < blocks.length - 1; i++) blocks[i].end = blocks[i + 1].start;
	return blocks;
}

function blockFor(lines, key) {
	const blocks = scanTopLevel(lines);
	for (const block of blocks) if (block.key === key) return block;
	return null;
}

/* Blank lines sit at the end of a block; keep them when the block is rewritten. */
function trailingBlanks(lines, block) {
	let count = 0;
	for (let i = block.end - 1; i > block.start && !lines[i].trim(); i--) count++;
	return count;
}

/* Where a key belongs, if it is not there yet. Bases read filters, formulas,
 * properties, views - so a new block goes in front of the first one that
 * should follow it. */
const TOP_LEVEL_ORDER = ['filters', 'formulas', 'properties', 'views'];

function insertTopLevel(lines, key, blockLines) {
	const rank = TOP_LEVEL_ORDER.indexOf(key);
	const blocks = scanTopLevel(lines);

	let at = lines.length;
	for (const block of blocks) {
		const other = TOP_LEVEL_ORDER.indexOf(block.key);
		if (other !== -1 && rank !== -1 && other > rank) { at = block.start; break; }
	}
	/* Appending: put it before any trailing blank lines, not after them. */
	if (at === lines.length) {
		while (at > 0 && !lines[at - 1].trim()) at--;
	}

	const out = lines.slice(0, at).concat(blockLines, lines.slice(at));
	return out;
}

function replaceBlock(lines, block, blockLines) {
	const blanks = trailingBlanks(lines, block);
	const tail = [];
	for (let i = 0; i < blanks; i++) tail.push('');
	return lines.slice(0, block.start).concat(blockLines, tail, lines.slice(block.end));
}

function removeBlock(lines, block) {
	return lines.slice(0, block.start).concat(lines.slice(block.end));
}

/* ----- formulas: ----------------------------------------------------------- */

function formulasBlockLines(entries) {
	const out = ['formulas:'];
	for (const entry of entries) {
		const key = '  ' + yamlKey(entry.name) + ':';
		const expression = String(entry.expression == null ? '' : entry.expression);
		if (expression.indexOf('\n') !== -1) {
			/* A block scalar, the way Obsidian writes a multi-line formula. */
			out.push(key + ' |');
			const body = expression.replace(/\n+$/, '').split('\n');
			for (const line of body) out.push(line ? '    ' + line : '');
		} else {
			out.push(key + ' ' + yamlValue(expression));
		}
	}
	return out;
}

function setFormulas(lines, entries) {
	const block = blockFor(lines, 'formulas');
	if (entries.length === 0) return block ? removeBlock(lines, block) : lines;
	const blockLines = formulasBlockLines(entries);
	return block ? replaceBlock(lines, block, blockLines) : insertTopLevel(lines, 'formulas', blockLines);
}

/* ----- properties: --------------------------------------------------------- */

/*
 * The entries of a mapping block, split by the indent of its first child, each
 * carrying its own lines verbatim. Anything that is not ours is put back
 * untouched, which is the whole reason for going line by line.
 */
function parseEntries(lines, block) {
	let entryIndent = -1;
	const entries = [];
	let current = null;

	for (let i = block.start + 1; i < block.end; i++) {
		const line = lines[i];
		if (!line.trim()) { if (current) current.lines.push(line); continue; }
		const indent = indentOf(line);
		if (entryIndent === -1) entryIndent = indent;

		if (indent === entryIndent) {
			const m = /^\s*(.+?):\s*(.*)$/.exec(line);
			current = {
				key: m ? m[1].trim().replace(/^["']|["']$/g, '') : line.trim(),
				indent: indent,
				lines: [line],
			};
			entries.push(current);
		} else if (current) {
			current.lines.push(line);
		}
	}
	return { entries: entries, indent: entryIndent === -1 ? 2 : entryIndent };
}

function setDisplayName(entry, displayName) {
	const childIndent = entry.indent + 2;
	const pad = ' '.repeat(childIndent);

	let found = -1;
	for (let i = 1; i < entry.lines.length; i++) {
		if (/^\s*displayName\s*:/.test(entry.lines[i])) { found = i; break; }
	}

	if (!displayName) {
		if (found !== -1) entry.lines.splice(found, 1);
		return;
	}
	const line = pad + 'displayName: ' + yamlValue(displayName);
	if (found !== -1) entry.lines[found] = line;
	else entry.lines.splice(1, 0, line);
}

/*
 * `properties:` holds display names, one entry per `formula.<name>`. Entries
 * for other properties are his and are never read, only carried across.
 */
function setFormulaProperties(lines, applicable, removedNames, manageDisplayNames) {
	const block = blockFor(lines, 'properties');
	const removed = new Set(removedNames);

	const wanted = new Map();
	for (const formula of applicable) wanted.set(formulaRef(formula.name), formula);

	let parsed = block ? parseEntries(lines, block) : { entries: [], indent: 2 };
	const kept = [];

	for (const entry of parsed.entries) {
		if (entry.key.indexOf('formula.') !== 0) { kept.push(entry); continue; }

		const name = entry.key.slice('formula.'.length);
		if (removed.has(name)) continue;

		const formula = wanted.get(entry.key);
		if (!formula) { kept.push(entry); continue; }

		if (manageDisplayNames) setDisplayName(entry, formula.displayName);
		/* An entry whose only reason to exist was a display name it no longer
		 * has is dropped rather than left as an empty key. */
		if (entry.lines.filter((l) => l.trim()).length > 1) kept.push(entry);
		wanted.delete(entry.key);
	}

	if (manageDisplayNames) {
		for (const [key, formula] of wanted) {
			if (!formula.displayName) continue;
			const pad = ' '.repeat(parsed.indent);
			const entry = { key: key, indent: parsed.indent, lines: [pad + yamlKey(key) + ':'] };
			setDisplayName(entry, formula.displayName);
			kept.push(entry);
		}
	}

	if (kept.length === 0) return block ? removeBlock(lines, block) : lines;

	const blockLines = ['properties:'];
	for (const entry of kept) for (const line of entry.lines) blockLines.push(line);
	while (blockLines.length > 1 && !blockLines[blockLines.length - 1].trim()) blockLines.pop();

	return block ? replaceBlock(lines, block, blockLines) : insertTopLevel(lines, 'properties', blockLines);
}

/* ----- views: -------------------------------------------------------------- */

/*
 * Every way a view can name a formula:
 *
 *     - formula.x                 an entry in `order:`
 *     - property: formula.x       an entry in `sort:`, with a `direction:` under it
 *     formula.x: 379              a key in `columnSize:` or `summaries:`
 *
 * A reference left behind after the formula is gone shows as a broken column,
 * so removing a formula removes its references too - and the lines belonging
 * to the entry, which are the ones indented under it.
 */
function referencesIn(line, names) {
	const trimmed = line.trim();
	for (const name of names) {
		const ref = formulaRef(name);
		if (trimmed === '- ' + ref) return name;
		if (trimmed === '- property: ' + ref) return name;
		if (trimmed.indexOf(ref + ':') === 0) return name;
	}
	return null;
}

function editViews(lines, edit) {
	const block = blockFor(lines, 'views');
	if (!block) return lines;
	const body = lines.slice(block.start, block.end);
	const edited = edit(body);
	return lines.slice(0, block.start).concat(edited, lines.slice(block.end));
}

function removeFormulaReferences(lines, names) {
	if (names.length === 0) return lines;
	return editViews(lines, (body) => {
		const out = [];
		for (let i = 0; i < body.length; i++) {
			const hit = referencesIn(body[i], names);
			if (!hit) { out.push(body[i]); continue; }
			const indent = indentOf(body[i]);
			/* Whatever hangs under the entry goes with it - the `direction:` of
			 * a sort entry, say. A blank line ends it, and so does a sibling. */
			while (i + 1 < body.length && body[i + 1].trim() && indentOf(body[i + 1]) > indent) i++;
		}
		return out;
	});
}

function renameFormulaReferences(lines, from, to) {
	return editViews(lines, (body) => body.map((line) => {
		const trimmed = line.trim();
		const oldRef = formulaRef(from);
		const newRef = formulaRef(to);
		if (trimmed === '- ' + oldRef) return line.replace(oldRef, newRef);
		if (trimmed === '- property: ' + oldRef) return line.replace(oldRef, newRef);
		if (trimmed.indexOf(oldRef + ':') === 0) return line.replace(oldRef + ':', newRef + ':');
		return line;
	}));
}

/*
 * Append the formula to every `order:` list that does not have it. Views
 * without an `order:` are left alone: they are showing default columns, and a
 * one-item `order:` would hide them.
 */
function addToViewOrders(lines, names) {
	if (names.length === 0) return lines;
	return editViews(lines, (body) => {
		let out = body.slice();
		for (const name of names) {
			const ref = '- ' + formulaRef(name);
			const next = [];
			for (let i = 0; i < out.length; i++) {
				next.push(out[i]);
				const m = /^(\s+)order:\s*$/.exec(out[i]);
				if (!m) continue;

				const keyIndent = m[1].length;
				let end = i + 1;
				let present = false;
				while (end < out.length) {
					const line = out[end];
					if (!line.trim()) break;
					if (indentOf(line) <= keyIndent) break;
					if (line.trim() === ref) present = true;
					next.push(line);
					end++;
				}
				if (!present) next.push(' '.repeat(keyIndent + 2) + ref);
				i = end - 1;
			}
			out = next;
		}
		return out;
	});
}

/* ------------------------------------------------------------------- plugin */

class BasesFormulasPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS);
		/* The shared list. Order here is the order written into every base. */
		this.formulas = [];
		/* path -> { name: expression }, what was last agreed with that base. */
		this.snapshots = {};
		/* Names removed here but perhaps still present in a base - so that the
		 * next scan does not adopt them straight back. */
		this.pendingDeletes = [];
		/* [{ from, to }] - a rename still to be carried into the bases. */
		this.pendingRenames = [];
		/* Names he asked to be added as a column, once. */
		this.pendingColumns = [];

		await this.loadState();

		this.registerView(VIEW_TYPE, (leaf) => new FormulasView(leaf, this));

		this.addRibbonIcon('sigma', 'Bases Formulas', () => { this.activateView(); });

		this.addCommand({
			id: 'open-formulas-panel',
			name: 'Open the formulas panel',
			callback: () => { this.activateView(); },
		});

		this.addCommand({
			id: 'sync-formulas',
			name: 'Sync formulas to every base',
			callback: () => { this.openPlan(); },
		});

		this.addSettingTab(new BasesFormulasSettingTab(this.app, this));

		/* A base he edited is the other half of the two-way sync. */
		this.registerEvent(this.app.vault.on('modify', (file) => { this.onBaseTouched(file); }));
		this.registerEvent(this.app.vault.on('create', (file) => { this.onBaseTouched(file); }));
		this.registerEvent(this.app.vault.on('delete', (file) => { this.onBaseGone(file); }));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.onBaseRenamed(file, oldPath);
		}));

		this.app.workspace.onLayoutReady(() => { this.queueSync(); });
	}

	onunload() {
		if (this.syncTimer) window.clearTimeout(this.syncTimer);
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	/* ---------------------------------------------------------------- state */

	async loadState() {
		const data = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});

		this.formulas = [];
		for (const raw of data.formulas || []) {
			if (!raw || !raw.name) continue;
			const formula = newFormula(String(raw.name), String(raw.expression || ''));
			formula.displayName = String(raw.displayName || '');
			formula.scope = raw.scope === 'only' || raw.scope === 'except' ? raw.scope : 'all';
			formula.bases = Array.isArray(raw.bases) ? raw.bases.map(String) : [];
			this.formulas.push(formula);
		}

		this.snapshots = data.snapshots && typeof data.snapshots === 'object' ? data.snapshots : {};
		this.pendingDeletes = Array.isArray(data.pendingDeletes) ? data.pendingDeletes : [];
		this.pendingRenames = Array.isArray(data.pendingRenames) ? data.pendingRenames : [];
		this.pendingColumns = Array.isArray(data.pendingColumns) ? data.pendingColumns : [];
	}

	async saveState() {
		await this.saveData({
			settings: this.settings,
			formulas: this.formulas,
			snapshots: this.snapshots,
			pendingDeletes: this.pendingDeletes,
			pendingRenames: this.pendingRenames,
			pendingColumns: this.pendingColumns,
		});
	}

	formulaNamed(name) {
		for (const formula of this.formulas) if (formula.name === name) return formula;
		return null;
	}

	refreshPanel() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
		}
	}

	/* ----------------------------------------------------------- the bases */

	inFolder(file, folder) {
		if (!folder) return true;
		return file.path.startsWith(folder + '/');
	}

	listBases() {
		return this.app.vault.getFiles()
			.filter((f) => f.extension === 'base' && this.inFolder(f, this.settings.basesFolder))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	isManagedBase(file) {
		return !!file && file.extension === 'base' && this.inFolder(file, this.settings.basesFolder);
	}

	basesFor(formula) {
		return this.listBases().filter((f) => appliesTo(formula, f.path));
	}

	/* Bases carry a formula through `formulas:`, a plain map of name to
	 * expression. Everything else in the file is somebody else's business. */
	formulasIn(text) {
		const parsed = parseYaml(text);
		const raw = parsed && parsed.formulas;
		const out = new Map();
		if (!raw || typeof raw !== 'object') return out;
		for (const name of Object.keys(raw)) {
			const value = raw[name];
			out.set(name, value == null ? '' : String(value).replace(/\n+$/, ''));
		}
		return out;
	}

	/* ------------------------------------------------------------- the plan */

	/*
	 * Everything that would change, and nothing changed. The adoptions are
	 * applied to a working copy of the list, because the files have to be built
	 * from the list as it will be, not as it is.
	 */
	async buildPlan() {
		const plan = {
			formulas: this.formulas.map((f) => Object.assign({}, f, { bases: f.bases.slice() })),
			adoptions: [],
			expressionUpdates: [],
			scopeExtensions: [],
			renames: this.pendingRenames.slice(),
			files: [],
			errors: [],
		};

		const deleted = new Set(this.pendingDeletes);
		const renamedFrom = new Map();
		for (const rename of this.pendingRenames) renamedFrom.set(rename.from, rename.to);

		const named = new Map();
		for (const formula of plan.formulas) named.set(formula.name, formula);

		const bases = this.listBases();
		const contents = new Map();

		/* Pass one: read every base, and let the bases teach the list. */
		for (const file of bases) {
			let text;
			try {
				text = await this.app.vault.read(file);
			} catch (error) {
				plan.errors.push({ path: file.path, message: 'could not be read: ' + error.message });
				continue;
			}

			let found;
			try {
				found = this.formulasIn(text);
			} catch (error) {
				plan.errors.push({ path: file.path, message: 'is not valid YAML, so it was skipped' });
				continue;
			}
			contents.set(file.path, { text: text, found: found });

			if (!this.settings.adoptFromBases) continue;

			const snapshot = this.snapshots[file.path] || {};

			for (const [name, expression] of found) {
				/* A rename in flight: the old name is the new one, not a stranger. */
				if (renamedFrom.has(name)) continue;
				if (deleted.has(name)) continue;

				const formula = named.get(name);
				if (!formula) {
					const adopted = newFormula(name, expression);
					plan.formulas.push(adopted);
					named.set(name, adopted);
					plan.adoptions.push({ name: name, path: file.path });
					continue;
				}

				/* The base disagrees with the list. Whoever moved last wins, and
				 * the snapshot is what says who moved. */
				if (expression !== formula.expression && expression !== snapshot[name]) {
					plan.expressionUpdates.push({
						name: name,
						from: formula.expression,
						to: expression,
						path: file.path,
					});
					formula.expression = expression;
				}

				/* Present in a base it is scoped out of. If we never put it
				 * there, he did, and that is a request to include this base. */
				if (!appliesTo(formula, file.path) && !(name in snapshot)) {
					if (formula.scope === 'only') formula.bases.push(file.path);
					else formula.bases = formula.bases.filter((p) => p !== file.path);
					plan.scopeExtensions.push({ name: name, path: file.path });
				}
			}
		}

		/* Pass two: build the text each base should have. */
		for (const file of bases) {
			const entry = contents.get(file.path);
			if (!entry) continue;

			const applicable = plan.formulas.filter((f) => appliesTo(f, file.path));
			const applicableNames = new Set(applicable.map((f) => f.name));

			const change = {
				file: file,
				path: file.path,
				before: entry.text,
				after: entry.text,
				added: [],
				changed: [],
				removed: [],
				renamed: [],
				columns: [],
			};

			/* Anything in the base that the list does not know about is his -
			 * left where it is, with its expression untouched. */
			const unknown = [];
			for (const [name, expression] of entry.found) {
				if (renamedFrom.has(name)) continue;
				if (applicableNames.has(name)) continue;
				if (named.has(name) || deleted.has(name)) {
					change.removed.push(name);
					continue;
				}
				unknown.push({ name: name, expression: expression });
			}

			for (const formula of applicable) {
				const was = renamedFrom.has(formula.name) ? undefined : entry.found.get(formula.name);
				const oldName = this.renameSourceFor(formula.name, entry.found);
				if (oldName) change.renamed.push({ from: oldName, to: formula.name });
				else if (was === undefined) change.added.push(formula.name);
				else if (was !== formula.expression) change.changed.push(formula.name);
			}

			for (const name of this.pendingColumns) {
				if (applicableNames.has(name)) change.columns.push(name);
			}

			let lines = entry.text.split('\n');

			for (const rename of this.pendingRenames) {
				if (!entry.found.has(rename.from)) continue;
				lines = renameFormulaReferences(lines, rename.from, rename.to);
			}

			lines = removeFormulaReferences(lines, change.removed);
			lines = setFormulas(lines, applicable
				.map((f) => ({ name: f.name, expression: f.expression }))
				.concat(unknown));
			lines = setFormulaProperties(lines, applicable, change.removed,
				this.settings.manageDisplayNames);
			lines = addToViewOrders(lines, change.columns);

			let after = lines.join('\n');
			if (after && !after.endsWith('\n')) after += '\n';
			change.after = after;

			if (change.after !== change.before) plan.files.push(change);
		}

		return plan;
	}

	/* A rename shows in a base as the old name still sitting there. */
	renameSourceFor(name, found) {
		for (const rename of this.pendingRenames) {
			if (rename.to === name && found.has(rename.from)) return rename.from;
		}
		return null;
	}

	planIsEmpty(plan) {
		return plan.files.length === 0
			&& plan.adoptions.length === 0
			&& plan.expressionUpdates.length === 0
			&& plan.scopeExtensions.length === 0;
	}

	async applyPlan(plan) {
		this.formulas = plan.formulas;

		for (const change of plan.files) {
			this.writing.add(change.path);
			try {
				await this.app.vault.modify(change.file, change.after);
			} catch (error) {
				new Notice('Bases Formulas: could not write ' + change.path + ' - ' + error.message);
			}
		}
		/* The modify events for our own writes arrive after this returns. */
		window.setTimeout(() => { this.writing.clear(); }, 1500);

		/* What every base now holds, so the next scan can tell his edits from
		 * ours. Rebuilt from the list rather than from the files, which is the
		 * same thing and cheaper. */
		const snapshots = {};
		for (const file of this.listBases()) {
			const map = {};
			for (const formula of this.formulas) {
				if (appliesTo(formula, file.path)) map[formula.name] = formula.expression;
			}
			snapshots[file.path] = map;
		}
		this.snapshots = snapshots;

		this.pendingDeletes = [];
		this.pendingRenames = [];
		this.pendingColumns = [];

		await this.saveState();
		this.refreshPanel();
	}

	/* --------------------------------------------------------- syncing ----- */

	get writing() {
		if (!this._writing) this._writing = new Set();
		return this._writing;
	}

	onBaseTouched(file) {
		if (!this.isManagedBase(file)) return;
		if (this.writing.has(file.path)) return;
		this.queueSync();
	}

	async onBaseGone(file) {
		if (!file || file.extension !== 'base') return;
		if (!(file.path in this.snapshots)) return;
		delete this.snapshots[file.path];
		this.forgetBase(file.path);
		await this.saveState();
		this.refreshPanel();
	}

	async onBaseRenamed(file, oldPath) {
		if (!file || file.extension !== 'base') return;
		if (oldPath in this.snapshots) {
			this.snapshots[file.path] = this.snapshots[oldPath];
			delete this.snapshots[oldPath];
		}
		/* A scope names bases by path, so a rename has to follow. */
		let touched = false;
		for (const formula of this.formulas) {
			const at = formula.bases.indexOf(oldPath);
			if (at === -1) continue;
			formula.bases[at] = file.path;
			touched = true;
		}
		await this.saveState();
		if (touched) this.refreshPanel();
	}

	forgetBase(path) {
		for (const formula of this.formulas) {
			formula.bases = formula.bases.filter((p) => p !== path);
		}
	}

	queueSync() {
		if (this.syncTimer) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			this.syncNow();
		}, this.settings.syncDelay);
	}

	/* Auto-sync: the same work, without the plan in front of it. */
	async syncNow() {
		if (this.syncing) { this.queueSync(); return; }
		this.syncing = true;
		try {
			const plan = await this.buildPlan();
			for (const error of plan.errors) {
				console.warn('Bases Formulas: ' + error.path + ' ' + error.message);
			}
			if (this.planIsEmpty(plan)) return;

			if (!this.settings.autoSync) {
				/* Adoptions are list edits, not vault edits, so they are safe to
				 * keep even with writing switched off - they are what makes the
				 * panel show what the bases actually contain. */
				this.formulas = plan.formulas;
				await this.saveState();
				this.refreshPanel();
				return;
			}

			await this.applyPlan(plan);
			this.announce(plan);
		} finally {
			this.syncing = false;
		}
	}

	announce(plan) {
		const parts = [];
		if (plan.adoptions.length) {
			const names = [...new Set(plan.adoptions.map((a) => a.name))];
			parts.push('picked up ' + names.map((n) => '"' + n + '"').join(', '));
		}
		if (plan.files.length) {
			parts.push('updated ' + plan.files.length + ' base' + (plan.files.length === 1 ? '' : 's'));
		}
		if (parts.length) new Notice('Bases Formulas: ' + parts.join(', ') + '.');
	}

	async openPlan() {
		const plan = await this.buildPlan();
		new SyncModal(this.app, this, plan).open();
	}

	/* ----------------------------------------------------- list editing ---- */

	async addFormula(name, expression) {
		this.formulas.push(newFormula(name, expression));
		this.pendingDeletes = this.pendingDeletes.filter((n) => n !== name);
		await this.saveState();
		this.afterEdit();
	}

	async removeFormula(name) {
		this.formulas = this.formulas.filter((f) => f.name !== name);
		if (this.pendingDeletes.indexOf(name) === -1) this.pendingDeletes.push(name);
		this.pendingColumns = this.pendingColumns.filter((n) => n !== name);
		this.pendingRenames = this.pendingRenames.filter((r) => r.to !== name);
		await this.saveState();
		this.afterEdit();
	}

	async renameFormula(formula, to) {
		const from = formula.name;
		if (from === to) return;
		formula.name = to;
		/* Chained renames collapse: a -> b -> c is a -> c. */
		const existing = this.pendingRenames.filter((r) => r.to === from);
		if (existing.length) for (const rename of existing) rename.to = to;
		else this.pendingRenames.push({ from: from, to: to });

		const at = this.pendingColumns.indexOf(from);
		if (at !== -1) this.pendingColumns[at] = to;

		await this.saveState();
		this.afterEdit();
	}

	async requestColumn(name) {
		if (this.pendingColumns.indexOf(name) === -1) this.pendingColumns.push(name);
		await this.saveState();
		this.afterEdit();
	}

	afterEdit() {
		this.refreshPanel();
		if (this.settings.autoSync) this.queueSync();
	}
}

/* --------------------------------------------------------------- the panel */

class FormulasView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.filter = '';
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Formulas'; }
	getIcon() { return 'sigma'; }

	async onOpen() {
		this.render();
	}

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('bases-formulas');

		const plugin = this.plugin;
		const bases = plugin.listBases();

		const filter = String(this.filter || '').trim().toLowerCase();
		const shown = filter
			? plugin.formulas.filter((f) => f.name.toLowerCase().indexOf(filter) !== -1
				|| f.expression.toLowerCase().indexOf(filter) !== -1)
			: plugin.formulas;

		this.renderHeader(container, bases, {
			shown: shown.length,
			total: plugin.formulas.length,
		});

		for (const formula of shown) this.renderFormula(container, formula, bases);

		if (shown.length === 0) {
			container.createEl('p', {
				text: filter
					? 'No formula matches "' + this.filter + '".'
					: 'No formulas yet. Add one here, or write one in any base - a formula '
						+ 'found in a base is picked up and shared with the others.',
				cls: 'bf-empty',
			});
		}

		if (!filter) this.renderBases(container, bases);

		this.watchScroll();
		this.syncStuckHeader();
	}

	/*
	 * The header paints nothing until something scrolls under it, and frosts
	 * after — transparent over the theme's own sidebar at rest, readable once a
	 * card is behind it. CSS cannot ask whether a sticky element is currently
	 * stuck, so the view says so.
	 */
	syncStuckHeader() {
		const scroller = this.containerEl.children[1];
		if (!scroller || typeof scroller.querySelector !== 'function') return;
		const header = scroller.querySelector('.bf-header');
		if (header) header.classList.toggle('is-scrolled', scroller.scrollTop > 2);
	}

	/*
	 * Registered against the scroll container, which survives a render, and only
	 * once - the panel redraws on every edit, so doing this per render would
	 * stack up listeners.
	 */
	watchScroll() {
		const scroller = this.containerEl.children[1];
		if (!scroller || !scroller.dataset || scroller.dataset.bfScroll) return;
		scroller.dataset.bfScroll = 'on';
		const sync = () => this.syncStuckHeader();
		if (typeof this.registerDomEvent === 'function') this.registerDomEvent(scroller, 'scroll', sync);
		else scroller.addEventListener('scroll', sync);
	}

	renderHeader(container, bases, counts) {
		const plugin = this.plugin;
		const header = container.createDiv({ cls: 'bf-header' });

		const title = header.createDiv({ cls: 'bf-header-title' });

		/* Shaped like the Classes panel's title, which took it from Calendar - a
		 * plain element rather than an `h3`, so the theme's heading style does
		 * not decide how this looks, with the count in the accent colour. */
		const heading = title.createDiv({ cls: 'bf-title' });
		heading.createSpan({ text: 'Formulas', cls: 'bf-title-name' });
		heading.createSpan({
			cls: 'bf-title-count',
			text: counts.shown === counts.total
				? String(counts.total)
				: counts.shown + '/' + counts.total,
		});

		/*
		 * *pending*, not *unsaved*: list edits are kept the moment they are made,
		 * so what this marks is work the bases have not been told about yet. With
		 * auto-sync on it clears itself within the second.
		 */
		const pending = plugin.pendingDeletes.length > 0
			|| plugin.pendingRenames.length > 0
			|| plugin.pendingColumns.length > 0;
		if (pending) title.createSpan({ text: 'pending', cls: 'bf-badge bf-badge-dirty' });
		else if (!plugin.settings.autoSync) {
			title.createSpan({ text: 'manual', cls: 'bf-badge bf-badge-dirty' });
		}

		const buttons = header.createDiv({ cls: 'bf-header-buttons' });

		/* Sync is the only one of these that writes to the vault. */
		const sync = buttons.createEl('button', {
			text: 'Sync now',
			cls: pending ? 'mod-cta' : '',
		});
		sync.onclick = () => { plugin.openPlan(); };

		/*
		 * Filtering the list. Re-rendering rebuilds this input, so focus and the
		 * caret are put back afterwards - otherwise every keystroke would drop
		 * him out of the box.
		 */
		const search = header.createEl('input', {
			cls: 'bf-search',
			attr: { type: 'search', placeholder: 'Find a formula…' },
		});
		search.value = this.filter || '';
		search.oninput = () => {
			this.filter = search.value;
			this.render();
			const next = this.containerEl.children[1].querySelector('.bf-search');
			if (!next) return;
			next.focus();
			next.setSelectionRange(next.value.length, next.value.length);
		};
		search.onkeydown = (event) => {
			if (event.key !== 'Escape' || !this.filter) return;
			this.filter = '';
			this.render();
			const next = this.containerEl.children[1].querySelector('.bf-search');
			if (next) next.focus();
		};

		const add = buttons.createEl('button', { text: 'New formula' });
		add.onclick = () => {
			new NameModal(this.app, 'New formula', '', async (name) => {
				if (plugin.formulaNamed(name)) {
					new Notice('Bases Formulas: "' + name + '" already exists.');
					return;
				}
				await plugin.addFormula(name, '');
				this.render();
			}).open();
		};
	}

	renderFormula(container, formula, bases) {
		const plugin = this.plugin;
		const card = container.createDiv({ cls: 'bf-formula' });

		const head = card.createDiv({ cls: 'bf-formula-head' });
		const name = head.createSpan({ text: formula.name, cls: 'bf-formula-name' });
		name.title = 'Click to rename. References in every base follow the new name.';
		name.onclick = () => {
			new NameModal(this.app, 'Rename formula', formula.name, async (to) => {
				if (to !== formula.name && plugin.formulaNamed(to)) {
					new Notice('Bases Formulas: "' + to + '" already exists.');
					return;
				}
				await plugin.renameFormula(formula, to);
				this.render();
			}).open();
		};

		const carrying = bases.filter((f) => appliesTo(formula, f.path)).length;
		head.createSpan({
			text: carrying + '/' + bases.length,
			cls: 'bf-badge' + (carrying === bases.length ? ' bf-badge-all' : ''),
		});

		const remove = head.createSpan({ cls: 'bf-remove' });
		setIcon(remove, 'x');
		remove.title = 'Remove this formula from every base';
		remove.onclick = async () => {
			await plugin.removeFormula(formula.name);
			this.render();
		};

		const expression = card.createEl('textarea', { cls: 'bf-expression' });
		expression.value = formula.expression;
		expression.placeholder = 'file.wordCount()';
		expression.rows = Math.min(6, Math.max(1, formula.expression.split('\n').length));
		expression.onchange = async () => {
			formula.expression = expression.value.replace(/\s+$/, '');
			await plugin.saveState();
			plugin.afterEdit();
		};

		const display = card.createDiv({ cls: 'bf-row' });
		display.createSpan({ text: 'Shown as', cls: 'bf-row-label' });
		const displayInput = display.createEl('input', { cls: 'bf-input', type: 'text' });
		displayInput.value = formula.displayName;
		displayInput.placeholder = formula.name;
		displayInput.onchange = async () => {
			formula.displayName = displayInput.value.trim();
			await plugin.saveState();
			plugin.afterEdit();
		};

		this.renderScope(card, formula, bases);

		const actions = card.createDiv({ cls: 'bf-actions' });
		const queued = plugin.pendingColumns.indexOf(formula.name) !== -1;
		const column = actions.createEl('button', {
			text: queued ? 'Column queued' : 'Add as column',
			cls: 'bf-small',
		});
		column.title = 'Append this formula to the columns of every view that has a '
			+ 'column list. Views showing the default columns are left alone.';
		if (queued) column.setAttribute('disabled', 'true');
		column.onclick = async () => {
			await plugin.requestColumn(formula.name);
			this.render();
		};
	}

	renderScope(card, formula, bases) {
		const plugin = this.plugin;

		const row = card.createDiv({ cls: 'bf-row' });
		row.createSpan({ text: 'In', cls: 'bf-row-label' });

		const select = row.createEl('select', { cls: 'bf-select' });
		for (const [value, label] of [['all', 'Every base'], ['only', 'Only…'], ['except', 'All except…']]) {
			const option = select.createEl('option', { text: label });
			option.value = value;
			if (formula.scope === value) option.selected = true;
		}
		select.onchange = async () => {
			formula.scope = select.value;
			await plugin.saveState();
			plugin.afterEdit();
			this.render();
		};

		if (formula.scope === 'all') return;

		const chips = card.createDiv({ cls: 'bf-chips' });
		for (const path of formula.bases) {
			const chip = chips.createSpan({ cls: 'bf-chip' });
			chip.createSpan({ text: baseName(path), cls: 'bf-chip-text' });
			const x = chip.createSpan({ text: '×', cls: 'bf-chip-remove' });
			x.onclick = async () => {
				formula.bases = formula.bases.filter((p) => p !== path);
				await plugin.saveState();
				plugin.afterEdit();
				this.render();
			};
		}

		const remaining = bases.filter((f) => formula.bases.indexOf(f.path) === -1);
		if (remaining.length === 0) return;

		const adder = chips.createEl('select', { cls: 'bf-select bf-adder' });
		const first = adder.createEl('option', { text: '+ base' });
		first.value = '';
		for (const file of remaining) {
			const option = adder.createEl('option', { text: baseName(file.path) });
			option.value = file.path;
		}
		adder.onchange = async () => {
			if (!adder.value) return;
			formula.bases.push(adder.value);
			await plugin.saveState();
			plugin.afterEdit();
			this.render();
		};
	}

	/* The other way round: what each base ends up carrying. */
	renderBases(container, bases) {
		const plugin = this.plugin;
		const details = container.createEl('details', { cls: 'bf-bases' });
		if (this.basesOpen) details.setAttribute('open', 'true');
		details.ontoggle = () => { this.basesOpen = details.hasAttribute('open'); };
		details.createEl('summary', { text: 'Bases (' + bases.length + ')' });

		for (const file of bases) {
			const row = details.createDiv({ cls: 'bf-base-row' });
			const link = row.createSpan({ text: baseName(file.path), cls: 'bf-base-name' });
			link.onclick = () => { this.app.workspace.getLeaf(false).openFile(file); };

			const carried = plugin.formulas.filter((f) => appliesTo(f, file.path));
			row.createSpan({
				text: carried.length ? carried.map((f) => f.name).join(', ') : 'none',
				cls: 'bf-base-formulas' + (carried.length ? '' : ' bf-muted'),
			});
		}

		if (bases.length === 0) {
			details.createEl('p', { text: 'No .base files found.', cls: 'bf-empty' });
		}
	}
}

function baseName(path) {
	const file = path.split('/').pop();
	return file.replace(/\.base$/, '');
}

/* --------------------------------------------------------------- the modals */

class NameModal extends Modal {
	constructor(app, title, value, onSubmit) {
		super(app);
		this.title = title;
		this.value = value;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });

		const input = contentEl.createEl('input', { type: 'text', cls: 'bf-modal-input' });
		input.value = this.value;
		input.placeholder = 'word count';
		input.focus();
		input.select();

		const submit = async () => {
			const name = input.value.trim();
			if (!name) return;
			this.close();
			await this.onSubmit(name);
		};

		input.onkeydown = (event) => {
			if (event.key === 'Enter') { event.preventDefault(); submit(); }
		};

		const buttons = contentEl.createDiv({ cls: 'bf-modal-buttons' });
		buttons.createEl('button', { text: 'Cancel' }).onclick = () => { this.close(); };
		buttons.createEl('button', { text: 'OK', cls: 'mod-cta' }).onclick = submit;
	}

	onClose() { this.contentEl.empty(); }
}

/*
 * Every file that would be written and every line in it that would change.
 * Nothing has been written when this opens.
 */
class SyncModal extends Modal {
	constructor(app, plugin, plan) {
		super(app);
		this.plugin = plugin;
		this.plan = plan;
	}

	onOpen() {
		const { contentEl } = this;
		const plan = this.plan;

		contentEl.createEl('h3', { text: 'Sync formulas' });

		if (this.plugin.planIsEmpty(plan)) {
			contentEl.createEl('p', {
				text: 'Every base already matches the list. Nothing to write.',
				cls: 'bf-modal-lede',
			});
			const buttons = contentEl.createDiv({ cls: 'bf-modal-buttons' });
			buttons.createEl('button', { text: 'Close', cls: 'mod-cta' })
				.onclick = () => { this.close(); };
			return;
		}

		contentEl.createEl('p', {
			text: 'Nothing has been written yet. Only the lines listed below change; '
				+ 'the rest of each file is left exactly as it is.',
			cls: 'bf-modal-lede',
		});

		if (plan.adoptions.length) {
			contentEl.createEl('h4', { text: 'Picked up from the bases' });
			const list = contentEl.createEl('ul', { cls: 'bf-plan' });
			for (const adoption of plan.adoptions) {
				const item = list.createEl('li');
				item.createSpan({ text: adoption.name, cls: 'bf-plan-label' });
				item.createSpan({ text: 'found in ' + baseName(adoption.path)
					+ ', and shared with the others', cls: 'bf-plan-detail' });
			}
		}

		if (plan.expressionUpdates.length) {
			contentEl.createEl('h4', { text: 'Changed in a base' });
			const list = contentEl.createEl('ul', { cls: 'bf-plan' });
			for (const update of plan.expressionUpdates) {
				const item = list.createEl('li');
				item.createSpan({ text: update.name, cls: 'bf-plan-label' });
				item.createSpan({ text: 'edited in ' + baseName(update.path)
					+ ' — that expression becomes the shared one', cls: 'bf-plan-detail' });
				item.createSpan({ text: update.to, cls: 'bf-plan-code' });
			}
		}

		if (plan.files.length) {
			contentEl.createEl('h4', { text: 'Files to write (' + plan.files.length + ')' });
			const list = contentEl.createEl('ul', { cls: 'bf-plan' });
			for (const change of plan.files) {
				const item = list.createEl('li');
				item.createSpan({ text: baseName(change.path), cls: 'bf-plan-label' });
				item.createSpan({ text: change.path, cls: 'bf-plan-path' });
				for (const rename of change.renamed) {
					item.createSpan({ text: 'rename ' + rename.from + ' → ' + rename.to,
						cls: 'bf-plan-detail' });
				}
				for (const name of change.added) {
					item.createSpan({ text: 'add ' + name, cls: 'bf-plan-detail' });
				}
				for (const name of change.changed) {
					item.createSpan({ text: 'update ' + name, cls: 'bf-plan-detail' });
				}
				for (const name of change.removed) {
					item.createSpan({ text: 'remove ' + name + ', and any column or sort using it',
						cls: 'bf-plan-detail bf-plan-cut' });
				}
				for (const name of change.columns) {
					item.createSpan({ text: 'show ' + name + ' as a column',
						cls: 'bf-plan-detail' });
				}
			}
		}

		if (plan.errors.length) {
			contentEl.createEl('h4', { text: 'Skipped' });
			const list = contentEl.createEl('ul', { cls: 'bf-plan' });
			for (const error of plan.errors) {
				const item = list.createEl('li', { cls: 'bf-plan-error' });
				item.createSpan({ text: baseName(error.path), cls: 'bf-plan-label' });
				item.createSpan({ text: error.message, cls: 'bf-plan-detail' });
			}
		}

		const buttons = contentEl.createDiv({ cls: 'bf-modal-buttons' });
		buttons.createEl('button', { text: 'Cancel' }).onclick = () => { this.close(); };
		const write = buttons.createEl('button', { text: 'Write', cls: 'mod-cta' });
		write.onclick = async () => {
			this.close();
			await this.plugin.applyPlan(plan);
			new Notice('Bases Formulas: ' + plan.files.length + ' base'
				+ (plan.files.length === 1 ? '' : 's') + ' updated.');
		};
	}

	onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------- the settings */

class BasesFormulasSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Sync automatically')
			.setDesc('Write to the bases as soon as the list or a base changes. Off, nothing is '
				+ 'written until Sync now is confirmed — the panel still keeps up with what the '
				+ 'bases contain.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveState();
					this.plugin.refreshPanel();
				}));

		new Setting(containerEl)
			.setName('Pick up formulas from bases')
			.setDesc('A formula written through Obsidian\'s own base UI joins the shared list and '
				+ 'is passed to the other bases. Off, the list is only ever edited here.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.adoptFromBases)
				.onChange(async (value) => {
					this.plugin.settings.adoptFromBases = value;
					await this.plugin.saveState();
				}));

		new Setting(containerEl)
			.setName('Manage display names')
			.setDesc('Also write each formula\'s "Shown as" name into the base\'s properties block. '
				+ 'Off, display names are left to each base.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.manageDisplayNames)
				.onChange(async (value) => {
					this.plugin.settings.manageDisplayNames = value;
					await this.plugin.saveState();
				}));

		new Setting(containerEl)
			.setName('Bases folder')
			.setDesc('Only bases under this folder are managed. Empty means the whole vault.')
			.addText((text) => text
				.setPlaceholder('Obsidian/Bases')
				.setValue(this.plugin.settings.basesFolder)
				.onChange(async (value) => {
					this.plugin.settings.basesFolder = value.trim().replace(/\/+$/, '');
					await this.plugin.saveState();
					this.plugin.refreshPanel();
				}));
	}
}

module.exports = BasesFormulasPlugin;
