'use strict';

/*
 * Bases Sharing
 * ------------
 * Two right-sidebar tabs over what every base in the vault has in common, and
 * one Sync behind both:
 *
 *   Formulas  one list of formulas, shared by every base
 *   Views     one list of views, shared by every base
 *
 * They are two halves of one plugin rather than two plugins because they write
 * the same lines of the same files. A shared view's `order:` and `sort:` name
 * `formula.*` columns, so whatever writes views has to know which formulas each
 * base carries; two plugins would be two owners of one file, disagreeing.
 *
 * The views half is further down, under "views: the shared ones" and "the views
 * tab". What follows is the formulas half.
 *
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
const VIEWS_VIEW_TYPE = 'bases-shared-views-panel';

/*
 * The keys a shared view keeps per base. Everything here is something Obsidian
 * rewrites from looking at a view rather than from a decision he made, so
 * sharing them would mean one pan of one graph rewriting every base.
 */
const DEFAULT_LOCAL_VIEW_KEYS = [
	'columnSize',
	'graphOptions.scale',
	'graphOptions.close',
	'graphOptions.collapse-filter',
	'graphOptions.collapse-color-groups',
	'graphOptions.collapse-display',
	'graphOptions.collapse-forces',
];

const DEFAULT_SETTINGS = {
	/* Write to the bases as soon as anything changes, without a plan. */
	autoSync: true,
	/* Pick up formulas written through Obsidian's own base UI. */
	adoptFromBases: true,
	/* Carry an edit made to a shared view in one base back to the others. */
	adoptViewEdits: true,
	/* Manage the `displayName` under `properties:` as well as the expression. */
	manageDisplayNames: true,
	/* '' means the whole vault. */
	basesFolder: '',
	/* How long to wait after a base changes before syncing, in milliseconds. */
	syncDelay: 900,
	/* Per-base keys of a shared view. One per line in the settings tab. */
	localViewKeys: DEFAULT_LOCAL_VIEW_KEYS.slice(),
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

/*
 * A shared view. `body` is the view's YAML minus `name:`, `type:` and the
 * per-base keys; the scope is the same three-valued thing a formula has, so
 * `Only…` and `All except…` mean here exactly what they mean there.
 */
function newView(name, type, body) {
	return {
		name: name,
		type: type || 'table',
		body: Array.isArray(body) ? body.slice() : [],
		scope: 'all',
		bases: [],
	};
}

/* Formulas and views are scoped the same way, so this reads both. */
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

/*
 * Taking the last entry out of a list leaves the key that held it standing with
 * nothing under it, and `sort:` followed by nothing is not an empty sort - it is
 * a null, and the view reads it as a broken one. So a key emptied by a removal
 * goes with its last child.
 *
 * Only a key that *had* children is considered, so a key he wrote empty himself
 * is left alone, and only one occurrence at a time: two views can both have a
 * `sort:`, and one of them keeping its entries says nothing about the other.
 */
function dropEmptied(before, after) {
	const hadChildren = new Set();
	for (let i = 0; i < before.length; i++) {
		const m = before[i].trim() ? /^(\s*)([^:]+):\s*$/.exec(before[i]) : null;
		if (m && deeperEnd(before, i, m[1].length) > i) hadChildren.add(before[i]);
	}
	if (!hadChildren.size) return after;

	let out = after;
	/* A key emptied by dropping an emptied child needs another pass. */
	for (let round = 0; round < 4; round++) {
		const next = [];
		for (let i = 0; i < out.length; i++) {
			const m = out[i].trim() ? /^(\s*)([^:]+):\s*$/.exec(out[i]) : null;
			if (m && hadChildren.has(out[i]) && deeperEnd(out, i, m[1].length) === i) continue;
			next.push(out[i]);
		}
		if (next.length === out.length) return out;
		out = next;
	}
	return out;
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
		return dropEmptied(body, out);
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
 *
 * Shared views are skipped here and handled in the list instead - a column
 * appended to a shared view in fifteen bases would come back as fifteen
 * simultaneous edits to the same view, one of which would win.
 */
function addToViewOrders(lines, names, skipNames) {
	if (names.length === 0) return lines;
	const block = blockFor(lines, 'views');
	if (!block) return lines;

	const parsed = parseViews(lines, block);
	const skip = new Set(skipNames || []);
	const blockLines = ['views:'];

	for (const entry of parsed.entries) {
		const entryLines = entry.lines.slice();
		if (!entry.name || !skip.has(entry.name)) {
			const keyIndent = entry.indent + 2;
			for (const name of names) {
				const ref = '- ' + formulaRef(name);
				const lv = entryLines.map((l, i) => (i === 0 ? l.replace(/^(\s*)-\s?/, '$1  ') : l));
				for (let i = 0; i < lv.length; i++) {
					if (!lv[i].trim() || indentOf(lv[i]) !== keyIndent) continue;
					if (keyOf(lv[i]) !== 'order') continue;

					const end = deeperEnd(lv, i, keyIndent);
					let present = false;
					let childIndent = keyIndent + 2;
					for (let j = i + 1; j <= end; j++) {
						if (!lv[j].trim()) continue;
						childIndent = Math.min(childIndent, indentOf(lv[j]));
						if (lv[j].trim() === ref) present = true;
					}
					if (!present) entryLines.splice(end + 1, 0, ' '.repeat(childIndent) + ref);
					break;
				}
			}
		}
		for (const line of entryLines) blockLines.push(line);
	}

	while (blockLines.length > 1 && !blockLines[blockLines.length - 1].trim()) blockLines.pop();
	return replaceBlock(lines, block, blockLines);
}

/* ----- views: the shared ones ---------------------------------------------- */

/*
 * A shared view is kept as *lines*, not as a parsed object. A view is a nested
 * map whose keys nothing here models - `graphOptions`, `ringSpread`, whatever
 * Bases grows next - and re-emitting a parsed one would quietly drop the parts
 * I did not think of. So the panel keeps the YAML it captured and writes that
 * same YAML into the other bases, re-indented.
 *
 * Some keys are deliberately not shared:
 *
 *   scale, close, collapse-*   the graph camera, and which sections of the
 *                              graph settings are folded. Obsidian rewrites
 *                              these from merely looking at a view, so sharing
 *                              them would rewrite every base every time he pans
 *                              one graph.
 *   columnSize                 column widths, dragged per base.
 *
 * They are stripped when a view is captured, and put back from each base's own
 * copy when it is written, so every base keeps its own.
 *
 * A view's `filters:` sits inside the view and travels with it. The base's
 * top-level `filters:` is a different block and is never touched - which is
 * what makes a shared view usable at all: one local filter over each base's own
 * global one.
 */

/* The last line of the run that hangs under `lines[i]`. */
function deeperEnd(lines, i, indent) {
	let end = i;
	for (let j = i + 1; j < lines.length; j++) {
		if (!lines[j].trim()) continue;
		if (indentOf(lines[j]) <= indent) break;
		end = j;
	}
	return end;
}

function keyOf(line) {
	const m = /^\s*([^:]+):(\s|$)/.exec(line);
	if (!m) return null;
	const key = m[1].trim();
	if (key.indexOf('- ') === 0) return null;
	return key.replace(/^["']|["']$/g, '');
}

/*
 * The entries of `views:`, which is a sequence, not a map. Each entry keeps its
 * lines verbatim; an entry not in the shared list is put back exactly as found.
 */
function parseViews(lines, block) {
	const entries = [];
	let dashIndent = -1;
	let current = null;

	for (let i = block.start + 1; i < block.end; i++) {
		const line = lines[i];
		if (!line.trim()) { if (current) current.lines.push(line); continue; }
		const indent = indentOf(line);
		const isItem = /^\s*-(\s|$)/.test(line);

		if (isItem && (dashIndent === -1 || indent === dashIndent)) {
			if (dashIndent === -1) dashIndent = indent;
			current = { indent: indent, lines: [line] };
			entries.push(current);
		} else if (current) {
			current.lines.push(line);
		}
	}
	for (const entry of entries) Object.assign(entry, viewParts(entry));
	return { entries: entries, indent: dashIndent === -1 ? 2 : dashIndent };
}

/* The entry's own lines with the `- ` turned into indent, so every key of the
 * view sits at one column and the body can be read like an ordinary map. */
function levelled(entry) {
	return entry.lines.map((line, i) => (i === 0 ? line.replace(/^(\s*)-\s?/, '$1  ') : line));
}

/*
 * name and type - the identity of a view - and the body, which is every other
 * key, dedented to column zero. `name` is how a shared view is matched across
 * bases, so it is held apart from the body rather than written from it.
 */
function viewParts(entry) {
	const keyIndent = entry.indent + 2;
	const lines = levelled(entry);
	const body = [];
	let name = '';
	let type = '';

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) { if (body.length) body.push(''); continue; }
		if (indentOf(line) !== keyIndent) continue;

		const key = keyOf(line);
		const end = deeperEnd(lines, i, keyIndent);

		if (key === 'name' || key === 'type') {
			const m = /^\s*[^:]+:\s*(.*)$/.exec(line);
			const value = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
			if (key === 'name') name = value; else type = value;
		} else {
			for (let j = i; j <= end; j++) body.push(lines[j].slice(keyIndent));
		}
		i = end;
	}
	while (body.length && !body[body.length - 1].trim()) body.pop();
	return { name: name, type: type, body: body };
}

/* 'columnSize' or 'graphOptions.scale', split into the two shapes that need
 * different handling. Only one level of nesting: that is all the churning keys
 * need, and a deeper path would be a guess about a schema I do not control. */
function splitLocalKeys(keys) {
	const top = new Set();
	const nested = new Map();
	for (const key of keys) {
		const at = key.indexOf('.');
		if (at === -1) { top.add(key); continue; }
		const parent = key.slice(0, at);
		if (!nested.has(parent)) nested.set(parent, new Set());
		nested.get(parent).add(key.slice(at + 1));
	}
	return { top: top, nested: nested };
}

function stripLocalKeys(body, keys) {
	const { top, nested } = splitLocalKeys(keys);
	const out = [];

	for (let i = 0; i < body.length; i++) {
		const line = body[i];
		if (!line.trim()) { out.push(line); continue; }
		if (indentOf(line) !== 0) { out.push(line); continue; }

		const key = keyOf(line);
		const end = deeperEnd(body, i, 0);

		if (key !== null && top.has(key)) { i = end; continue; }

		if (key !== null && nested.has(key)) {
			const children = nested.get(key);
			out.push(line);
			let childIndent = -1;
			for (let j = i + 1; j <= end; j++) {
				if (!body[j].trim()) { out.push(body[j]); continue; }
				const indent = indentOf(body[j]);
				if (childIndent === -1) childIndent = indent;
				if (indent === childIndent) {
					const child = keyOf(body[j]);
					if (child !== null && children.has(child)) { j = deeperEnd(body, j, indent); continue; }
				}
				out.push(body[j]);
			}
			i = end;
			continue;
		}

		out.push(line);
	}
	while (out.length && !out[out.length - 1].trim()) out.pop();
	return out;
}

/*
 * The other direction: what this base keeps for itself, dedented, each with the
 * sibling it followed.
 *
 * The anchor is the point. Obsidian writes graphOptions in its own order, with
 * `scale` after `linkDistance` and the `collapse-` keys scattered through the
 * block - so putting them back at the end would move them, Obsidian would move
 * them back at the next save, and the two of us would rewrite the file at each
 * other forever. Put back where they were, nothing moves and nothing churns.
 */
function pickLocalKeys(body, keys) {
	const { top, nested } = splitLocalKeys(keys);
	const picked = new Map();
	let previousTop = null;

	for (let i = 0; i < body.length; i++) {
		const line = body[i];
		if (!line.trim() || indentOf(line) !== 0) continue;
		const key = keyOf(line);
		if (key === null) continue;
		const end = deeperEnd(body, i, 0);

		if (top.has(key)) {
			picked.set(key, { lines: body.slice(i, end + 1), after: previousTop });
		} else if (nested.has(key)) {
			const children = nested.get(key);
			let childIndent = -1;
			let previousChild = null;
			for (let j = i + 1; j <= end; j++) {
				if (!body[j].trim()) continue;
				const indent = indentOf(body[j]);
				if (childIndent === -1) childIndent = indent;
				if (indent !== childIndent) continue;
				const child = keyOf(body[j]);
				if (child === null) continue;
				const childEnd = deeperEnd(body, j, indent);
				if (children.has(child)) {
					picked.set(key + '.' + child, {
						lines: body.slice(j, childEnd + 1).map((l) => l.slice(indent)),
						after: previousChild,
					});
				}
				previousChild = child;
				j = childEnd;
			}
		}
		previousTop = key;
		i = end;
	}
	return picked;
}

function insertAfterTop(body, after, lines) {
	if (after === null) return lines.concat(body);
	for (let i = 0; i < body.length; i++) {
		if (!body[i].trim() || indentOf(body[i]) !== 0) continue;
		if (keyOf(body[i]) !== after) continue;
		const end = deeperEnd(body, i, 0) + 1;
		return body.slice(0, end).concat(lines, body.slice(end));
	}
	return body.concat(lines);
}

/*
 * Walked in the order they were found, so that a local key anchored on another
 * local key - `close` follows `scale`, and both are local - finds its anchor
 * already back in place.
 */
function injectLocalKeys(body, picked) {
	let out = body.slice();

	for (const [key, held] of picked) {
		if (!held.lines.length) continue;

		const at = key.indexOf('.');
		if (at === -1) { out = insertAfterTop(out, held.after, held.lines); continue; }

		/* A nested one goes back inside its parent, at the parent's own child
		 * indent - and only if the parent is in the shared body at all. */
		const parent = key.slice(0, at);
		let start = -1;
		for (let i = 0; i < out.length; i++) {
			if (out[i].trim() && indentOf(out[i]) === 0 && keyOf(out[i]) === parent) { start = i; break; }
		}
		if (start === -1) continue;

		const end = deeperEnd(out, start, 0);
		let childIndent = 2;
		for (let i = start + 1; i <= end; i++) {
			if (out[i].trim()) { childIndent = indentOf(out[i]); break; }
		}
		const pad = ' '.repeat(childIndent);
		const lines = held.lines.map((l) => (l ? pad + l : ''));

		let insertAt = start + 1;
		if (held.after !== null) {
			insertAt = end + 1;
			for (let i = start + 1; i <= end; i++) {
				if (!out[i].trim() || indentOf(out[i]) !== childIndent) continue;
				if (keyOf(out[i]) !== held.after) continue;
				insertAt = deeperEnd(out, i, childIndent) + 1;
				break;
			}
		}
		out = out.slice(0, insertAt).concat(lines, out.slice(insertAt));
	}
	return out;
}

/* Everything the base's `views:` holds, keyed by name, with the local keys
 * taken out - which is the form a shared view is compared and stored in. */
function viewsIn(lines, localKeys) {
	const block = blockFor(lines, 'views');
	const out = new Map();
	if (!block) return out;
	for (const entry of parseViews(lines, block).entries) {
		if (!entry.name) continue;
		out.set(entry.name, {
			type: entry.type,
			body: stripLocalKeys(entry.body, localKeys),
			local: pickLocalKeys(entry.body, localKeys),
		});
	}
	return out;
}

/* One string per view, so "did this base change" is a string comparison. */
function viewFingerprint(type, body) {
	return String(type || '') + '\n' + body.join('\n');
}

function viewEntryLines(view, body, indent) {
	const pad = ' '.repeat(indent);
	const keyPad = ' '.repeat(indent + 2);
	const out = [pad + '- type: ' + yamlValue(view.type || 'table')];
	out.push(keyPad + 'name: ' + yamlValue(view.name));
	for (const line of body) out.push(line ? keyPad + line : '');
	while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
	return out;
}

/*
 * upserts: [{ match, view, body }] - `match` is the name to look for, which is
 * the old one when the view has just been renamed.
 * removals: names to take out.
 * Entries the list knows nothing about are copied across untouched.
 */
function setSharedViews(lines, upserts, removals) {
	if (!upserts.length && !removals.length) return lines;

	const block = blockFor(lines, 'views');
	const parsed = block ? parseViews(lines, block) : { entries: [], indent: 2 };
	const indent = parsed.indent;
	const gone = new Set(removals);

	const kept = [];
	const done = new Set();

	for (const entry of parsed.entries) {
		if (entry.name && gone.has(entry.name)) continue;

		let hit = null;
		for (const upsert of upserts) {
			if (entry.name && entry.name === upsert.match) { hit = upsert; break; }
		}
		if (!hit) { kept.push(entry.lines); continue; }
		kept.push(viewEntryLines(hit.view, hit.body, indent));
		done.add(hit.view.name);
	}

	for (const upsert of upserts) {
		if (done.has(upsert.view.name)) continue;
		kept.push(viewEntryLines(upsert.view, upsert.body, indent));
	}

	if (!kept.length) return block ? removeBlock(lines, block) : lines;

	const blockLines = ['views:'];
	for (const entry of kept) for (const line of entry) blockLines.push(line);
	while (blockLines.length > 1 && !blockLines[blockLines.length - 1].trim()) blockLines.pop();

	return block ? replaceBlock(lines, block, blockLines) : insertTopLevel(lines, 'views', blockLines);
}

/* ----- a shared view's own body, corrected for formulas -------------------- */

/* The same three shapes as in a base, applied to a body held in the list. A
 * shared view can name a formula that is scoped out of the base it is being
 * written into, and a column pointing at a formula that is not there is a
 * broken column. */
function removeRefsInBody(body, names) {
	if (!names.length) return body;
	const out = [];
	for (let i = 0; i < body.length; i++) {
		if (!referencesIn(body[i], names)) { out.push(body[i]); continue; }
		i = deeperEnd(body, i, indentOf(body[i]));
	}
	return dropEmptied(body, out);
}

function renameRefsInBody(body, from, to) {
	const oldRef = formulaRef(from);
	const newRef = formulaRef(to);
	return body.map((line) => {
		const trimmed = line.trim();
		if (trimmed === '- ' + oldRef) return line.replace(oldRef, newRef);
		if (trimmed === '- property: ' + oldRef) return line.replace(oldRef, newRef);
		if (trimmed.indexOf(oldRef + ':') === 0) return line.replace(oldRef + ':', newRef + ':');
		return line;
	});
}

/* `Add as column` reaching a shared view means the column joins the shared
 * body, so every base gets it - rather than being appended per base and then
 * read back as fifteen simultaneous edits. */
function addRefToBodyOrder(body, name) {
	const ref = '- ' + formulaRef(name);
	for (let i = 0; i < body.length; i++) {
		if (!body[i].trim() || indentOf(body[i]) !== 0) continue;
		if (keyOf(body[i]) !== 'order') continue;
		const end = deeperEnd(body, i, 0);
		for (let j = i + 1; j <= end; j++) if (body[j].trim() === ref) return body;
		let childIndent = 2;
		for (let j = i + 1; j <= end; j++) { if (body[j].trim()) { childIndent = indentOf(body[j]); break; } }
		return body.slice(0, end + 1).concat([' '.repeat(childIndent) + ref], body.slice(end + 1));
	}
	return body;
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

		/* The other half: the shared list of views. */
		this.views = [];
		/* path -> { name: fingerprint }, what was last agreed with that base. */
		this.viewSnapshots = {};
		this.pendingViewDeletes = [];
		this.pendingViewRenames = [];

		await this.loadState();

		this.registerView(VIEW_TYPE, (leaf) => new FormulasView(leaf, this));
		this.registerView(VIEWS_VIEW_TYPE, (leaf) => new SharedViewsView(leaf, this));

		this.addRibbonIcon('sigma', 'Bases Formulas', () => { this.activateView(); });
		this.addRibbonIcon('layout-grid', 'Bases Views', () => { this.activateView(VIEWS_VIEW_TYPE); });

		this.addCommand({
			id: 'open-formulas-panel',
			name: 'Open the formulas panel',
			callback: () => { this.activateView(); },
		});

		this.addCommand({
			id: 'open-views-panel',
			name: 'Open the views panel',
			callback: () => { this.activateView(VIEWS_VIEW_TYPE); },
		});

		this.addCommand({
			id: 'sync-formulas',
			name: 'Sync formulas and views to every base',
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

	async activateView(type) {
		const wanted = type || VIEW_TYPE;
		const existing = this.app.workspace.getLeavesOfType(wanted);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: wanted, active: true });
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

		this.views = [];
		for (const raw of data.views || []) {
			if (!raw || !raw.name) continue;
			const view = newView(String(raw.name), String(raw.type || 'table'),
				Array.isArray(raw.body) ? raw.body.map(String) : []);
			view.scope = raw.scope === 'only' || raw.scope === 'except' ? raw.scope : 'all';
			view.bases = Array.isArray(raw.bases) ? raw.bases.map(String) : [];
			this.views.push(view);
		}

		this.snapshots = data.snapshots && typeof data.snapshots === 'object' ? data.snapshots : {};
		this.viewSnapshots = data.viewSnapshots && typeof data.viewSnapshots === 'object'
			? data.viewSnapshots : {};
		this.pendingDeletes = Array.isArray(data.pendingDeletes) ? data.pendingDeletes : [];
		this.pendingRenames = Array.isArray(data.pendingRenames) ? data.pendingRenames : [];
		this.pendingColumns = Array.isArray(data.pendingColumns) ? data.pendingColumns : [];
		this.pendingViewDeletes = Array.isArray(data.pendingViewDeletes) ? data.pendingViewDeletes : [];
		this.pendingViewRenames = Array.isArray(data.pendingViewRenames) ? data.pendingViewRenames : [];
	}

	async saveState() {
		await this.saveData({
			settings: this.settings,
			formulas: this.formulas,
			views: this.views,
			snapshots: this.snapshots,
			viewSnapshots: this.viewSnapshots,
			pendingDeletes: this.pendingDeletes,
			pendingRenames: this.pendingRenames,
			pendingColumns: this.pendingColumns,
			pendingViewDeletes: this.pendingViewDeletes,
			pendingViewRenames: this.pendingViewRenames,
		});
	}

	formulaNamed(name) {
		for (const formula of this.formulas) if (formula.name === name) return formula;
		return null;
	}

	viewNamed(name) {
		for (const view of this.views) if (view.name === name) return view;
		return null;
	}

	localViewKeys() {
		const keys = this.settings.localViewKeys;
		return Array.isArray(keys) ? keys.filter((k) => k && k.trim()).map((k) => k.trim()) : [];
	}

	refreshPanel() {
		for (const type of [VIEW_TYPE, VIEWS_VIEW_TYPE]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
			}
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
			views: this.views.map((v) => Object.assign({}, v, {
				bases: v.bases.slice(),
				body: v.body.slice(),
			})),
			adoptions: [],
			expressionUpdates: [],
			scopeExtensions: [],
			renames: this.pendingRenames.slice(),
			viewUpdates: [],
			viewScopeExtensions: [],
			viewRenames: this.pendingViewRenames.slice(),
			viewPrints: {},
			files: [],
			errors: [],
		};

		const deleted = new Set(this.pendingDeletes);
		const renamedFrom = new Map();
		for (const rename of this.pendingRenames) renamedFrom.set(rename.from, rename.to);

		const named = new Map();
		for (const formula of plan.formulas) named.set(formula.name, formula);

		const localKeys = this.localViewKeys();
		const viewNames = new Set(plan.views.map((v) => v.name));
		const viewDeleted = new Set(this.pendingViewDeletes);
		const viewRenamedFrom = new Set(this.pendingViewRenames.map((r) => r.from));

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
			const baseViews = viewsIn(text.split('\n'), localKeys);
			contents.set(file.path, { text: text, found: found, views: baseViews });

			/*
			 * A shared view he tuned in one base. The snapshot decides, exactly as
			 * it does for a formula: what we last wrote is what "unchanged" means,
			 * so anything else is his hand, and his hand wins.
			 *
			 * The per-base keys are already out of both sides of this comparison,
			 * which is what stops a pan of one graph from looking like an edit.
			 */
			if (this.settings.adoptViewEdits) {
				const viewSnapshot = this.viewSnapshots[file.path] || {};

				for (const view of plan.views) {
					const key = baseViews.has(view.name)
						? view.name
						: this.renameSourceForView(view.name, baseViews);
					if (!key) continue;

					const entry = baseViews.get(key);
					const print = viewFingerprint(entry.type, entry.body);

					/*
					 * Only a base we have already written this view to can have
					 * edited it. Without that, sharing a view would lose the moment
					 * it started: two bases can hold different views under one name
					 * - `Graph` is in nearly all of his - and every one of them
					 * would look like an edit, so the last base in path order would
					 * overwrite the one he actually picked. A base with no snapshot
					 * for this view has never agreed anything about it, so it gets
					 * the shared one.
					 */
					if (key in viewSnapshot
						&& print !== viewSnapshot[key]
						&& print !== viewFingerprint(view.type, view.body)) {
						view.type = entry.type;
						view.body = entry.body.slice();
						plan.viewUpdates.push({ name: view.name, path: file.path });
					}

					/* Present in a base it is scoped out of, and we did not put it
					 * there - so he did, and that is a request to include it. */
					if (!appliesTo(view, file.path) && !(key in viewSnapshot)) {
						if (view.scope === 'only') view.bases.push(file.path);
						else view.bases = view.bases.filter((p) => p !== file.path);
						plan.viewScopeExtensions.push({ name: view.name, path: file.path });
					}
				}
			}

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

		/*
		 * Between the passes: a shared body is corrected once, in the list, not
		 * fifteen times in fifteen files. A formula renamed, removed, or queued
		 * as a column reaches every base through the view it is named in.
		 */
		for (const view of plan.views) {
			for (const rename of this.pendingRenames) {
				view.body = renameRefsInBody(view.body, rename.from, rename.to);
			}
			view.body = removeRefsInBody(view.body, [...deleted]);
			for (const name of this.pendingColumns) {
				if (named.has(name)) view.body = addRefToBodyOrder(view.body, name);
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
				viewsAdded: [],
				viewsChanged: [],
				viewsRemoved: [],
				viewsRenamed: [],
				viewsEmptied: false,
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

			/*
			 * The views half. Composed first, so that everything below - the
			 * formula renames, the removals, the queued columns - runs over the
			 * text as it will be, not as it was.
			 */
			const baseViews = entry.views;
			const applicableViews = plan.views.filter((v) => appliesTo(v, file.path));
			const applicableViewNames = new Set(applicableViews.map((v) => v.name));
			/* Formulas this base does not carry. A column pointing at one of them
			 * is a broken column, so a shared view arrives here without it. */
			const absent = plan.formulas.filter((f) => !appliesTo(f, file.path)).map((f) => f.name);

			const upserts = [];
			const prints = {};

			for (const view of applicableViews) {
				const match = baseViews.has(view.name)
					? view.name
					: (this.renameSourceForView(view.name, baseViews) || view.name);
				const existing = baseViews.get(match);

				const shared = removeRefsInBody(view.body, absent);
				const body = injectLocalKeys(shared, existing ? existing.local : new Map());

				if (!existing) change.viewsAdded.push(view.name);
				else if (match !== view.name) change.viewsRenamed.push({ from: match, to: view.name });
				else if (viewFingerprint(view.type, shared) !== viewFingerprint(existing.type, existing.body)) {
					change.viewsChanged.push(view.name);
				}

				prints[view.name] = viewFingerprint(view.type, shared);
				upserts.push({ match: match, view: view, body: body });
			}

			const matched = new Set(upserts.map((u) => u.match));
			for (const name of baseViews.keys()) {
				if (applicableViewNames.has(name) || matched.has(name)) continue;
				if (viewRenamedFrom.has(name)) continue;
				if (!viewNames.has(name) && !viewDeleted.has(name)) continue;
				change.viewsRemoved.push(name);
			}
			plan.viewPrints[file.path] = prints;

			let lines = entry.text.split('\n');

			if (upserts.length || change.viewsRemoved.length) {
				/* A base whose only view was a shared one that just left keeps no
				 * `views:` block at all, and Obsidian gives it a default view. */
				change.viewsEmptied = baseViews.size > 0
					&& !upserts.length
					&& change.viewsRemoved.length === baseViews.size;
				lines = setSharedViews(lines, upserts, change.viewsRemoved);
			}

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
			lines = addToViewOrders(lines, change.columns, [...applicableViewNames]);

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

	/* A shared view shows a pending rename as the old name still sitting there. */
	renameSourceForView(name, found) {
		for (const rename of this.pendingViewRenames) {
			if (rename.to === name && found.has(rename.from)) return rename.from;
		}
		return null;
	}

	planIsEmpty(plan) {
		return plan.files.length === 0
			&& plan.adoptions.length === 0
			&& plan.expressionUpdates.length === 0
			&& plan.scopeExtensions.length === 0
			&& plan.viewUpdates.length === 0
			&& plan.viewScopeExtensions.length === 0;
	}

	async applyPlan(plan) {
		this.formulas = plan.formulas;
		this.views = plan.views;

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

		/* Views cannot be rebuilt from the list the same way: what each base got
		 * depends on which formulas it carries, so the plan records it per base
		 * as it composes. */
		this.viewSnapshots = plan.viewPrints;

		this.pendingDeletes = [];
		this.pendingRenames = [];
		this.pendingColumns = [];
		this.pendingViewDeletes = [];
		this.pendingViewRenames = [];

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
		if (!(file.path in this.snapshots) && !(file.path in this.viewSnapshots)) return;
		delete this.snapshots[file.path];
		delete this.viewSnapshots[file.path];
		this.forgetBase(file.path);
		await this.saveState();
		this.refreshPanel();
	}

	async onBaseRenamed(file, oldPath) {
		if (!file || file.extension !== 'base') return;
		for (const snapshots of [this.snapshots, this.viewSnapshots]) {
			if (!(oldPath in snapshots)) continue;
			snapshots[file.path] = snapshots[oldPath];
			delete snapshots[oldPath];
		}
		/* A scope names bases by path, so a rename has to follow. */
		let touched = false;
		for (const scoped of this.formulas.concat(this.views)) {
			const at = scoped.bases.indexOf(oldPath);
			if (at === -1) continue;
			scoped.bases[at] = file.path;
			touched = true;
		}
		await this.saveState();
		if (touched) this.refreshPanel();
	}

	forgetBase(path) {
		for (const scoped of this.formulas.concat(this.views)) {
			scoped.bases = scoped.bases.filter((p) => p !== path);
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
				this.views = plan.views;
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
		if (plan.viewUpdates.length) {
			const names = [...new Set(plan.viewUpdates.map((u) => u.name))];
			parts.push('followed ' + names.map((n) => '"' + n + '"').join(', '));
		}
		if (plan.files.length) {
			parts.push('updated ' + plan.files.length + ' base' + (plan.files.length === 1 ? '' : 's'));
		}
		if (parts.length) new Notice('Bases Sharing: ' + parts.join(', ') + '.');
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

	/* ------------------------------------------------------- views editing -- */

	/*
	 * Every view of every base, so one can be picked to share. Sharing is
	 * opt-in: a view nobody put in this list is never read and never written,
	 * which is what keeps a one-off table in one base a one-off table.
	 */
	async candidateViews() {
		const out = [];
		const localKeys = this.localViewKeys();
		for (const file of this.listBases()) {
			let text;
			try {
				text = await this.app.vault.read(file);
			} catch (error) {
				continue;
			}
			for (const [name, entry] of viewsIn(text.split('\n'), localKeys)) {
				out.push({ path: file.path, name: name, type: entry.type, body: entry.body });
			}
		}
		return out;
	}

	/* Sharing starts from a view that already exists: its YAML is captured as
	 * it stands in that base, and that becomes the shared one. */
	async shareView(candidate) {
		const view = newView(candidate.name, candidate.type, candidate.body);
		this.views.push(view);
		this.pendingViewDeletes = this.pendingViewDeletes.filter((n) => n !== candidate.name);
		await this.saveState();
		this.afterEdit();
		return view;
	}

	async removeView(name) {
		this.views = this.views.filter((v) => v.name !== name);
		if (this.pendingViewDeletes.indexOf(name) === -1) this.pendingViewDeletes.push(name);
		this.pendingViewRenames = this.pendingViewRenames.filter((r) => r.to !== name);
		await this.saveState();
		this.afterEdit();
	}

	/* Stopping sharing without touching a single base: every copy stays where
	 * it is, and from now on they drift apart on their own. */
	async unshareView(name) {
		this.views = this.views.filter((v) => v.name !== name);
		for (const path of Object.keys(this.viewSnapshots)) delete this.viewSnapshots[path][name];
		await this.saveState();
		this.afterEdit();
	}

	async renameView(view, to) {
		const from = view.name;
		if (from === to) return;
		view.name = to;
		const existing = this.pendingViewRenames.filter((r) => r.to === from);
		if (existing.length) for (const rename of existing) rename.to = to;
		else this.pendingViewRenames.push({ from: from, to: to });
		await this.saveState();
		this.afterEdit();
	}

	pending() {
		return this.pendingDeletes.length > 0
			|| this.pendingRenames.length > 0
			|| this.pendingColumns.length > 0
			|| this.pendingViewDeletes.length > 0
			|| this.pendingViewRenames.length > 0;
	}

	afterEdit() {
		this.refreshPanel();
		if (this.settings.autoSync) this.queueSync();
	}
}

/* -------------------------------------------------------------- the panels */

/*
 * What the two panels have in common: the header, the sticky-frost bookkeeping
 * under it, the scope row, and the fold at the bottom saying what each base
 * ends up carrying. Formulas and views differ in what a card holds and in
 * nothing else, so the chrome is written once - which is also what keeps the
 * two tabs looking like one plugin.
 */
class PanelView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.filter = '';
	}

	async onOpen() {
		this.render();
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

	renderHeader(container, options) {
		const plugin = this.plugin;
		const header = container.createDiv({ cls: 'bf-header' });

		const title = header.createDiv({ cls: 'bf-header-title' });

		/* Shaped like the Classes panel's title, which took it from Calendar - a
		 * plain element rather than an `h3`, so the theme's heading style does
		 * not decide how this looks, with the count in the accent colour. */
		const heading = title.createDiv({ cls: 'bf-title' });
		heading.createSpan({ text: options.title, cls: 'bf-title-name' });
		heading.createSpan({
			cls: 'bf-title-count',
			text: options.shown === options.total
				? String(options.total)
				: options.shown + '/' + options.total,
		});

		/*
		 * *pending*, not *unsaved*: list edits are kept the moment they are made,
		 * so what this marks is work the bases have not been told about yet. With
		 * auto-sync on it clears itself within the second. It reads both halves,
		 * because one Sync writes both.
		 */
		const pending = plugin.pending();
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
			attr: { type: 'search', placeholder: options.searchPlaceholder },
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

		const add = buttons.createEl('button', { text: options.addLabel });
		add.onclick = () => { options.onAdd(); };
	}

	/* `Every base`, `Only…`, `All except…` - a formula and a view are scoped the
	 * same way, so this row is the same row. */
	renderScope(card, item, bases) {
		const plugin = this.plugin;

		const row = card.createDiv({ cls: 'bf-row' });
		row.createSpan({ text: 'In', cls: 'bf-row-label' });

		const select = row.createEl('select', { cls: 'bf-select' });
		for (const [value, label] of [['all', 'Every base'], ['only', 'Only…'], ['except', 'All except…']]) {
			const option = select.createEl('option', { text: label });
			option.value = value;
			if (item.scope === value) option.selected = true;
		}
		select.onchange = async () => {
			item.scope = select.value;
			await plugin.saveState();
			plugin.afterEdit();
			this.render();
		};

		if (item.scope === 'all') return;

		const chips = card.createDiv({ cls: 'bf-chips' });
		for (const path of item.bases) {
			const chip = chips.createSpan({ cls: 'bf-chip' });
			chip.createSpan({ text: baseName(path), cls: 'bf-chip-text' });
			const x = chip.createSpan({ text: '×', cls: 'bf-chip-remove' });
			x.onclick = async () => {
				item.bases = item.bases.filter((p) => p !== path);
				await plugin.saveState();
				plugin.afterEdit();
				this.render();
			};
		}

		const remaining = bases.filter((f) => item.bases.indexOf(f.path) === -1);
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
			item.bases.push(adder.value);
			await plugin.saveState();
			plugin.afterEdit();
			this.render();
		};
	}

	/* The other way round: what each base ends up carrying. */
	renderBases(container, bases, describe) {
		const details = container.createEl('details', { cls: 'bf-bases' });
		if (this.basesOpen) details.setAttribute('open', 'true');
		details.ontoggle = () => { this.basesOpen = details.hasAttribute('open'); };
		details.createEl('summary', { text: 'Bases (' + bases.length + ')' });

		for (const file of bases) {
			const row = details.createDiv({ cls: 'bf-base-row' });
			const link = row.createSpan({ text: baseName(file.path), cls: 'bf-base-name' });
			link.onclick = () => { this.app.workspace.getLeaf(false).openFile(file); };

			const carried = describe(file.path);
			row.createSpan({
				text: carried.length ? carried.join(', ') : 'none',
				cls: 'bf-base-formulas' + (carried.length ? '' : ' bf-muted'),
			});
		}

		if (bases.length === 0) {
			details.createEl('p', { text: 'No .base files found.', cls: 'bf-empty' });
		}
	}
}

class FormulasView extends PanelView {
	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Formulas'; }
	getIcon() { return 'sigma'; }

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

		this.renderHeader(container, {
			title: 'Formulas',
			shown: shown.length,
			total: plugin.formulas.length,
			searchPlaceholder: 'Find a formula…',
			addLabel: 'New formula',
			onAdd: () => {
				new NameModal(this.app, 'New formula', '', async (name) => {
					if (plugin.formulaNamed(name)) {
						new Notice('Bases Sharing: "' + name + '" already exists.');
						return;
					}
					await plugin.addFormula(name, '');
					this.render();
				}).open();
			},
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

		if (!filter) {
			this.renderBases(container, bases, (path) => plugin.formulas
				.filter((f) => appliesTo(f, path))
				.map((f) => f.name));
		}

		this.watchScroll();
		this.syncStuckHeader();
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
					new Notice('Bases Sharing: "' + to + '" already exists.');
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

}

/* ------------------------------------------------------------ the views tab */

/*
 * The second half, and the second tab. Same list, same scopes, same Sync - the
 * thing being shared is a view instead of a formula.
 *
 * Sharing is opt-in, unlike formulas: a formula found in a base is picked up
 * because a formula is small and duplicating it is always a mistake, whereas a
 * one-off table in one base is an ordinary thing to want. So a view joins the
 * list only when he picks it, and from then on it is kept in step everywhere.
 */
class SharedViewsView extends PanelView {
	getViewType() { return VIEWS_VIEW_TYPE; }
	getDisplayText() { return 'Views'; }
	getIcon() { return 'layout-grid'; }

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('bases-formulas');

		const plugin = this.plugin;
		const bases = plugin.listBases();

		const filter = String(this.filter || '').trim().toLowerCase();
		const shown = filter
			? plugin.views.filter((v) => v.name.toLowerCase().indexOf(filter) !== -1
				|| v.type.toLowerCase().indexOf(filter) !== -1)
			: plugin.views;

		this.renderHeader(container, {
			title: 'Views',
			shown: shown.length,
			total: plugin.views.length,
			searchPlaceholder: 'Find a view…',
			addLabel: 'Share a view',
			onAdd: () => { this.pickView(); },
		});

		for (const view of shown) this.renderView(container, view, bases);

		if (shown.length === 0) {
			container.createEl('p', {
				text: filter
					? 'No view matches "' + this.filter + '".'
					: 'No shared views yet. Build a view in one base — its layout, its sort, '
						+ 'its own filter — then share it here, and every other base gets the '
						+ 'same one. Each base keeps its own global filter.',
				cls: 'bf-empty',
			});
		}

		if (!filter) {
			this.renderBases(container, bases, (path) => plugin.views
				.filter((v) => appliesTo(v, path))
				.map((v) => v.name));
		}

		this.watchScroll();
		this.syncStuckHeader();
	}

	async pickView() {
		const plugin = this.plugin;
		const candidates = (await plugin.candidateViews())
			.filter((c) => !plugin.viewNamed(c.name));

		if (!candidates.length) {
			new Notice('Bases Sharing: every view in every base is already shared.');
			return;
		}
		new PickViewModal(this.app, candidates, async (candidate) => {
			await plugin.shareView(candidate);
			this.render();
		}).open();
	}

	renderView(container, view, bases) {
		const plugin = this.plugin;
		const card = container.createDiv({ cls: 'bf-formula' });

		const head = card.createDiv({ cls: 'bf-formula-head' });
		const name = head.createSpan({ text: view.name, cls: 'bf-formula-name' });
		name.title = 'Click to rename. The view is renamed in every base that carries it — '
			+ 'an embed written as ![[Base.base#' + view.name + ']] would have to be '
			+ 'updated by hand.';
		name.onclick = () => {
			new NameModal(this.app, 'Rename view', view.name, async (to) => {
				if (to !== view.name && plugin.viewNamed(to)) {
					new Notice('Bases Sharing: "' + to + '" already exists.');
					return;
				}
				await plugin.renameView(view, to);
				this.render();
			}).open();
		};

		head.createSpan({ text: view.type, cls: 'bf-badge bf-badge-type' });

		const carrying = bases.filter((f) => appliesTo(view, f.path)).length;
		head.createSpan({
			text: carrying + '/' + bases.length,
			cls: 'bf-badge' + (carrying === bases.length ? ' bf-badge-all' : ''),
		});

		const remove = head.createSpan({ cls: 'bf-remove' });
		setIcon(remove, 'x');
		remove.title = 'Remove this view from every base';
		remove.onclick = async () => {
			await plugin.removeView(view.name);
			this.render();
		};

		/*
		 * The YAML itself, editable. Folded by default - a graph view is forty
		 * lines of forces and colour groups, and the usual way to change one is
		 * in a base, not here.
		 */
		const details = card.createEl('details', { cls: 'bf-view-yaml' });
		details.createEl('summary', { text: view.body.length + ' lines of settings' });

		const body = details.createEl('textarea', { cls: 'bf-expression bf-view-body' });
		body.value = view.body.join('\n');
		body.rows = Math.min(20, Math.max(3, view.body.length));
		body.onchange = async () => {
			const lines = body.value.replace(/\s+$/, '').split('\n');
			/* Written by hand, so it has to parse - otherwise it would be written
			 * into every base and break all of them at once. */
			try {
				parseYaml(lines.join('\n'));
			} catch (error) {
				new Notice('Bases Sharing: that is not valid YAML, so it was not kept.');
				this.render();
				return;
			}
			view.body = lines;
			await plugin.saveState();
			plugin.afterEdit();
		};

		/* Seven key names is four wrapped lines of grey text on every card in a
		 * 340px sidebar, so the count is the line and the list is the tooltip. */
		const local = plugin.localViewKeys();
		if (local.length) {
			const note = card.createEl('p', {
				text: local.length + (local.length === 1 ? ' key is' : ' keys are') + ' kept per base',
				cls: 'bf-local-note',
			});
			note.title = local.join('\n');
		}

		this.renderScope(card, view, bases);

		const actions = card.createDiv({ cls: 'bf-actions' });
		const stop = actions.createEl('button', { text: 'Stop sharing', cls: 'bf-small' });
		stop.title = 'Take this view off the list without touching a single base. Every copy '
			+ 'stays where it is, and they drift apart from now on.';
		stop.onclick = async () => {
			await plugin.unshareView(view.name);
			this.render();
		};
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
 * Every view of every base that is not shared yet, grouped by the base it is
 * in. Picking one captures its YAML as it stands there - so the way to share a
 * view is to build it once, properly, in one base, and then point at it.
 *
 * Two bases can hold two different views under one name. Only the one picked is
 * captured; the others become copies of it at the next sync, which is the whole
 * point, and the modal says so.
 */
class PickViewModal extends Modal {
	constructor(app, candidates, onPick) {
		super(app);
		this.candidates = candidates;
		this.onPick = onPick;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Share a view' });
		contentEl.createEl('p', {
			text: 'The view is captured as it stands in the base you pick, and every other '
				+ 'base gets that one. Its own filter travels with it; each base keeps its '
				+ 'global filter, its column widths and its graph position.',
			cls: 'bf-modal-lede',
		});

		const byBase = new Map();
		for (const candidate of this.candidates) {
			if (!byBase.has(candidate.path)) byBase.set(candidate.path, []);
			byBase.get(candidate.path).push(candidate);
		}

		const seen = new Map();
		for (const candidate of this.candidates) {
			seen.set(candidate.name, (seen.get(candidate.name) || 0) + 1);
		}

		const list = contentEl.createEl('div', { cls: 'bf-pick' });
		for (const [path, candidates] of byBase) {
			list.createEl('div', { text: baseName(path), cls: 'bf-pick-base' });
			for (const candidate of candidates) {
				const row = list.createEl('button', { cls: 'bf-pick-row' });
				row.createSpan({ text: candidate.name, cls: 'bf-pick-name' });
				row.createSpan({ text: candidate.type, cls: 'bf-badge bf-badge-type' });
				row.createSpan({
					text: candidate.body.length + ' lines',
					cls: 'bf-pick-detail',
				});
				if (seen.get(candidate.name) > 1) {
					row.createSpan({
						text: 'also in ' + (seen.get(candidate.name) - 1) + ' other base'
							+ (seen.get(candidate.name) === 2 ? '' : 's') + ', which this replaces',
						cls: 'bf-pick-warn',
					});
				}
				row.onclick = async () => {
					this.close();
					await this.onPick(candidate);
				};
			}
		}

		const buttons = contentEl.createDiv({ cls: 'bf-modal-buttons' });
		buttons.createEl('button', { text: 'Cancel' }).onclick = () => { this.close(); };
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

		contentEl.createEl('h3', { text: 'Sync formulas and views' });

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

		if (plan.viewUpdates.length) {
			contentEl.createEl('h4', { text: 'Tuned in a base' });
			const list = contentEl.createEl('ul', { cls: 'bf-plan' });
			for (const update of plan.viewUpdates) {
				const item = list.createEl('li');
				item.createSpan({ text: update.name, cls: 'bf-plan-label' });
				item.createSpan({ text: 'changed in ' + baseName(update.path)
					+ ' — that version becomes the shared one', cls: 'bf-plan-detail' });
			}
		}

		if (plan.viewScopeExtensions.length) {
			contentEl.createEl('h4', { text: 'Put back by hand' });
			const list = contentEl.createEl('ul', { cls: 'bf-plan' });
			for (const extension of plan.viewScopeExtensions) {
				const item = list.createEl('li');
				item.createSpan({ text: extension.name, cls: 'bf-plan-label' });
				item.createSpan({ text: 'found in ' + baseName(extension.path)
					+ ', which it was scoped out of — that base is included again',
					cls: 'bf-plan-detail' });
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
				for (const rename of change.viewsRenamed) {
					item.createSpan({ text: 'rename the ' + rename.from + ' view → ' + rename.to,
						cls: 'bf-plan-detail' });
				}
				for (const name of change.viewsAdded) {
					item.createSpan({ text: 'add the ' + name + ' view', cls: 'bf-plan-detail' });
				}
				for (const name of change.viewsChanged) {
					item.createSpan({ text: 'update the ' + name + ' view', cls: 'bf-plan-detail' });
				}
				for (const name of change.viewsRemoved) {
					item.createSpan({ text: 'remove the ' + name + ' view',
						cls: 'bf-plan-detail bf-plan-cut' });
				}
				if (change.viewsEmptied) {
					item.createSpan({ text: 'this base has no other view, so it will show '
						+ "Obsidian's default one", cls: 'bf-plan-detail bf-plan-cut' });
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
			new Notice('Bases Sharing: ' + plan.files.length + ' base'
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
			.setName('Follow view edits made in a base')
			.setDesc('A shared view tuned in one base becomes the shared one, and the other '
				+ 'bases follow. Off, a shared view is only ever changed from this panel — '
				+ 'and a base edited by hand is put back at the next sync.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.adoptViewEdits)
				.onChange(async (value) => {
					this.plugin.settings.adoptViewEdits = value;
					await this.plugin.saveState();
				}));

		new Setting(containerEl)
			.setName('Kept per base')
			.setDesc('Keys of a shared view that every base keeps its own copy of, one per '
				+ 'line. These are the ones Obsidian rewrites from merely looking at a view — '
				+ 'sharing them would rewrite every base each time you pan one graph. '
				+ 'A nested key is written parent.child.')
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text.inputEl.addClass('bf-settings-area');
				text.setValue(this.plugin.localViewKeys().join('\n'));
				text.setPlaceholder(DEFAULT_LOCAL_VIEW_KEYS.join('\n'));
				text.onChange(async (value) => {
					this.plugin.settings.localViewKeys = value
						.split('\n')
						.map((line) => line.trim())
						.filter((line) => line);
					await this.plugin.saveState();
				});
			});

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
