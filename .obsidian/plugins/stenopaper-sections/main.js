/*
 * Stenopaper Sections — written entirely by Claude for Leander.
 * Proof of concept. Nothing in this folder is Leander's code.
 *
 * The problem
 *   Obsidian's markdown DOM is flat. A heading does not wrap what follows it:
 *   in Reading view you get sibling `div.el-h2`, `div.el-p`, `div.el-ul`; in
 *   Live Preview you get sibling `.cm-line`s with `.HyperMD-header-2` on the
 *   heading line only. So there is no element to paint a section background on,
 *   and the usual CSS dodge (`h2 ~ *` for one fill, `h3 ~ *` overriding it)
 *   breaks the moment a note goes back UP a level — everything after the first
 *   h3 keeps matching `h3 ~ *` forever, and CSS has no "nearest preceding
 *   sibling" combinator to stop it.
 *
 * What this does
 *   Runs the counter CSS cannot, and writes the answer onto every block:
 *
 *     data-sp-level="1".."6"   the heading level governing this block
 *     data-sp-top              this block opens its section  (draw a top edge)
 *     data-sp-bot              this block closes its section (draw a bottom edge)
 *
 *   Sections are identified by a running index, not by level, so two H2
 *   sections in a row are two cards rather than one long one.
 *
 *   Everything visual then lives in the Stenopaper.css snippet, which is where
 *   it belongs — this file makes no styling decisions at all.
 */

'use strict';

const { Plugin } = require('obsidian');
const { ViewPlugin, Decoration } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

/*
 * Walk a document's lines once and work out, for each 1-based line number,
 * which heading level and which section it belongs to.
 *
 * Fenced code and YAML frontmatter are skipped, so a `# comment` inside a
 * python block is not mistaken for an H1.
 */
function scan(lines) {
	const n = lines.length;
	const levels = new Int8Array(n + 2);
	const sects = new Int32Array(n + 2);
	const firstLine = [0];   // per section: first non-blank line
	const lastLine = [0];    // per section: last non-blank line

	let level = 0;
	let sect = 0;
	let fence = '';
	let front = false;

	for (let i = 1; i <= n; i++) {
		const text = lines[i - 1];

		if (i === 1 && /^---\s*$/.test(text)) { front = true; continue; }
		if (front) { if (/^---\s*$/.test(text)) front = false; continue; }

		const f = text.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (f) {
			if (!fence) fence = f[1][0];
			else if (f[1][0] === fence) fence = '';
		} else if (!fence) {
			const h = text.match(/^(#{1,6})\s+\S/);
			if (h) {
				level = h[1].length;
				sect++;
				firstLine[sect] = i;
				lastLine[sect] = i;
			}
		}

		levels[i] = level;
		sects[i] = sect;
		if (sect && text.trim() !== '') lastLine[sect] = i;
	}

	return { levels, sects, firstLine, lastLine, count: n };
}

/* ---------------------------------------------------------------- Live Preview */

const editorExtension = ViewPlugin.fromClass(
	class {
		constructor(view) { this.decorations = this.build(view); }

		update(u) {
			if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
		}

		build(view) {
			const doc = view.state.doc;
			const lines = [];
			for (const t of doc.iterLines()) lines.push(t);

			const { levels, sects, count } = scan(lines);
			const b = new RangeSetBuilder();

			// Only the viewport is decorated, but the scan above had to start at
			// line 1 — a section's level is not knowable from the middle of it.
			const first = doc.lineAt(view.viewport.from).number;
			const last = doc.lineAt(view.viewport.to).number;

			for (let i = first; i <= last; i++) {
				const lv = levels[i];
				if (!lv) continue;

				const attributes = { 'data-sp-level': String(lv) };
				if (i === 1 || sects[i - 1] !== sects[i]) attributes['data-sp-top'] = '';
				if (i === count || sects[i + 1] !== sects[i]) attributes['data-sp-bot'] = '';

				const line = doc.line(i);
				b.add(line.from, line.from, Decoration.line({ attributes }));
			}

			return b.finish();
		}
	},
	{ decorations: v => v.decorations }
);

/* -------------------------------------------------------------- Reading view */

class StenopaperSections extends Plugin {
	onload() {
		this.registerEditorExtension(editorExtension);
		this.registerMarkdownPostProcessor((el, ctx) => this.mark(el, ctx));
	}

	/*
	 * Reading view calls the post-processor once per top-level block, in no
	 * guaranteed order, so a running counter across calls is not available.
	 * getSectionInfo() hands back the whole source plus this block's line
	 * range, which is enough to look the answer up — memoised, because every
	 * block of one note asks about the same source text.
	 */
	scanOf(text) {
		if (!this._memo || this._memo.text !== text) this._memo = { text, data: scan(text.split('\n')) };
		return this._memo.data;
	}

	mark(el, ctx) {
		const info = ctx.getSectionInfo(el);
		if (!info) return;   // no source behind it: an embed, a callout child, an export

		const s = this.scanOf(info.text);
		const start = info.lineStart + 1;   // getSectionInfo is 0-based, scan() is 1-based
		const end = info.lineEnd + 1;

		const level = s.levels[start];
		if (!level) return;                 // before the first heading

		const sect = s.sects[start];
		const attrs = { 'data-sp-level': String(level) };

		// Blank lines between blocks are not blocks, so the edges are decided by
		// the section's first and last non-blank line rather than by neighbours.
		if (start <= s.firstLine[sect]) attrs['data-sp-top'] = '';
		if (end >= s.lastLine[sect]) attrs['data-sp-bot'] = '';

		// Only the container: marking its child too would give the inner <h2> a
		// second card nested inside this one's border.
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	}
}

module.exports = StenopaperSections;
