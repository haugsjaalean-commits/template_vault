'use strict';

/*
 * OOF Classes
 * -----------
 * The plugin described in OOF 0.3: a panel over the *classes* of the vault -
 * the notes that act as classes - where each class's name, characteristics and
 * parents can be edited in one place, and one Update pushes the consequences
 * out to the ordinary notes, the templates and the characteristic notes.
 *
 * The model, read off template_vault_2
 * ------------------------------------
 *   class           Obsidian/Notes/            #class, `characteristics`, `type of`
 *   characteristic  Obsidian/Characteristics/  `characteristic meaning`, `property type`
 *   template        Obsidian/Templates/        `is a: [[Class]]` + one key per characteristic
 *   instance        anywhere                   `is a: [[Class]]` + the same keys, filled in
 *
 * Person declares children/location/relation to me; Artist inherits Person and
 * adds domain; so Artist's template carries all four. Producing that flattening
 * by hand is the chore OOF 0.3 exists to remove.
 *
 * Two rules from the OOF 0.3 N.B.s
 * --------------------------------
 * 1. There is no global-vs-inherited split. *Everything* is inherited, and
 *    every class ultimately inherits from a root object (`Note`), which is
 *    where the base characteristics live.
 * 2. Parents are `inherits from` links, not `is a` - the same distinction the
 *    same distinction file.isA() draws. `is a` means instantiation, so it is what an
 *    *instance* uses to name its class; `inherits from` is subclassing, so it
 *    is what a class uses to name its parent class.
 *
 * Nothing is written until Update is pressed
 * ------------------------------------------
 * The panel is a view over the vault; editing it changes only in-memory drafts.
 * Update builds a plan, shows every action and every conflict, and writes only
 * once that plan is confirmed. Writes go through `fileManager.processFrontMatter`,
 * so note bodies are never touched.
 *
 * Data is never destroyed: a property that has fallen out of a class's
 * characteristics is removed from an instance only when it is *empty*. If it
 * holds a value, that is reported as a conflict and left exactly as it is, for
 * him to resolve.
 */

const obsidian = require('obsidian');

const { Plugin, PluginSettingTab, Setting, ItemView, Modal, TFile, Notice, setIcon } = obsidian;

const VIEW_TYPE = 'oof-objects-panel';

/*
 * The ignore list as it shipped in 2.3.0, kept only so a stored copy of it can be
 * recognised and replaced. See `loadSettings`.
 */
const RETIRED_IGNORED_DEFAULT = ['tags', 'aliases', 'cssclasses', 'cssclass',
	'publish', 'permalink', 'created', 'updated'];

/* The discrepancy card is expanded like a class, under a name no class can take. */
const DISCREPANCY_CARD = '::discrepancies';

const DEFAULT_SETTINGS = {
	notesFolder: 'Obsidian/Notes',
	characteristicsFolder: 'Obsidian/Characteristics',
	templatesFolder: 'Obsidian/Templates',
	/* Subclassing, and instantiation. Both the panel and file.isA() read these. */
	inheritsProperty: 'type of',
	isAProperty: 'is a',
	/* The property on a class listing what its instances carry. */
	characteristicsProperty: 'characteristics',
	/*
	 * A characteristic note's file name begins with this; the characteristic's
	 * name, and so the property key, never does. Emptying it turns the whole
	 * convention off.
	 */
	characteristicPrefix: '∘ ',
	/*
	 * Properties Obsidian itself owns, so an unclaimed-field check must not sweep
	 * them up. Anything else a note carries that its class does not declare is
	 * reported, which is the whole point of the check.
	 *
	 * `created` was on this list for a day and he took it off: *"created should
	 * not be hidden I don't think."* He is right, and it is his own model that
	 * says so - a property every note carries is a characteristic of Note, so
	 * hiding it would be hiding an incomplete model rather than a nuisance. The
	 * honest fix is to declare it, not to silence it.
	 */
	ignoredProperties: ['tags', 'aliases', 'cssclasses', 'cssclass', 'publish',
		'permalink'],
	/* The tag that flags a note as a class. */
	classTag: 'class',
	/*
	 * How the panel orders its classes. 'descent' puts a class below everything
	 * it descends from, then sorts alphabetically within a generation; 'name'
	 * is plain alphabetical.
	 */
	sortClasses: 'name',
	/* Whether the panel follows whatever note is open. */
	followActiveNote: true,
	/*
	 * Is Artist an Artist? Off, because a class is not one of its own
	 * instances. Used by file.isA() and file.inheritsFrom().
	 */
	classIsItsOwnInstance: false,
	/*
	 * Characteristic notes no class lists any more. Sent to Obsidian's trash on
	 * Update, never hard-deleted, and only once nothing at all still refers to
	 * them.
	 */
	deleteUnusedCharacteristics: true,
	/*
	 * The base characteristics: the properties the system itself reasons with,
	 * as opposed to the ones that merely describe a subject. Every class shows
	 * one editable row per entry, and the list is his to extend. The three
	 * anchors above say which of these carry meaning to the engine; any other
	 * entry is stored and edited faithfully but inherits nothing.
	 */
	logicProperties: ['is a', 'characteristics', 'type of'],
	/*
	 * Base characteristics he has since removed from the list. Kept so Update
	 * can clear them off the classes that still carry them - otherwise dropping
	 * one would silently leave an orphan key in every class note.
	 */
	retiredLogicProperties: [],
	/* `<Class> Template.md`, his rename of "architype". */
	templateSuffix: ' Template',

	/* One .base per class, listing its instances. */
	createBases: true,
	basesFolder: 'Obsidian/Bases',
	baseSuffix: ' Base',
	/*
	 * Which characteristics become columns: 'all' is everything an instance
	 * actually carries, inherited included; 'own' is only what the class adds.
	 */
	baseColumns: 'all',
};

const MAX_DEPTH = 64;

/* ------------------------------------------------------------------ helpers */

function toArray(value) {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/* Reduce a frontmatter entry to the note name it refers to. */
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

function asLink(name) {
	return '[[' + name + ']]';
}

/*
 * A discrepancy's identity, for remembering that he has dismissed one. Kind plus
 * subject rather than the label, so rewording a message later does not quietly
 * resurrect everything he has already dealt with.
 */
function discrepancyId(discrepancy) {
	return discrepancy.kind + '::' + (discrepancy.subject || discrepancy.path || '');
}

/*
 * Characteristic notes carry a prefix character in their **file name** - his
 * convention, the way `• Violet` marks a name and `‣ snag` a word. The
 * characteristic's own name never includes it.
 *
 * This matters more than it looks: a characteristic's name IS the property key
 * written into every note that carries it. Leaving the prefix on would turn
 * `domain:` into `∘ domain:` in his frontmatter everywhere. So it goes on when a
 * file is named or linked, and comes straight off again when a name is read.
 */
function stripPrefix(name, prefix) {
	if (!prefix) return String(name);

	const text = String(name).trim();
	if (text.startsWith(prefix)) return text.slice(prefix.length).trim();

	/* Tolerate a missing space after the character. */
	const bare = prefix.trim();
	if (bare && text.startsWith(bare)) return text.slice(bare.length).trim();

	/*
	 * Some *other* symbol: he changed the character, or named a note by hand with
	 * a • from another convention. Strip that too, so changing the setting
	 * migrates the names instead of producing "◈ ∘ domain". Letters and digits are
	 * safe from this — `état` keeps its é.
	 */
	const other = text.match(/^[^\p{L}\p{N}\s]\s*(.+)$/u);
	return other ? other[1].trim() : text;
}

function addPrefix(name, prefix) {
	const text = String(name).trim();
	if (!prefix || !text) return text;
	const bare = prefix.trim();
	if (text.startsWith(prefix) || (bare && text.startsWith(bare))) return text;
	return prefix + text;
}

/* Frontmatter counts as empty when there is nothing a reader would call a value. */
function isEmptyValue(value) {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/*
 * A Templater expression, not a value: `created: <% tp.date.now() %>`.
 *
 * This is the one thing in a template's frontmatter that is neither a
 * characteristic nor a mistake, and it is self-evidently deliberate - nobody
 * types `<%` by accident. Recognising it by shape is what lets everything *else*
 * unaccounted for be treated as an inconsistency, which is the whole point of
 * checking templates at all.
 */
function isTemplaterExpression(value) {
	if (Array.isArray(value)) return value.some(isTemplaterExpression);
	return typeof value === 'string' && value.indexOf('<%') !== -1;
}

/* Was this `possible values` entry written as a link, rather than as a word? */
function isWikiLink(entry) {
	return typeof entry === 'string' && /^\s*!?\[\[.+\]\]\s*$/.test(entry.trim());
}

/*
 * An interval bound: a number, or an unbounded side written as nothing at all,
 * `inf`, or `∞`. Returns null for anything that is not one, so the caller knows
 * the entry is not an interval after all.
 */
function intervalBound(text, unbounded) {
	const clean = String(text).trim().replace(/^\+/, '');
	if (clean === '') return unbounded;
	if (/^-?(inf|infinity|∞)$/i.test(clean)) return /^-/.test(clean) ? -Infinity : Infinity;
	const number = Number(clean);
	return isFinite(number) ? number : null;
}

const INTERVAL = /^([[\]])\s*([^,;[\]]*?)\s*[,;]\s*([^,;[\]]*?)\s*([[\]])$/;

/*
 * `[0, 10]`, `]0, 10]`, `[1, 3[` — his notation, where a bracket turned away
 * from the number excludes it.
 *
 * Also accepts a two-item list, because `possible values: [0, 10]` is a YAML
 * flow sequence: the parser turns it into the numbers 0 and 10 long before this
 * code sees it, and there are no brackets left to read. Taken as closed, which
 * is why a half-open interval has to be quoted — `"[1, 3["`.
 */
function parseInterval(entry) {
	if (Array.isArray(entry)) {
		if (entry.length !== 2) return null;
		const lower = intervalBound(entry[0], -Infinity);
		const upper = intervalBound(entry[1], Infinity);
		if (lower === null || upper === null) return null;
		return {
			lower: lower, upper: upper, lowerOpen: false, upperOpen: false,
			text: '[' + entry[0] + ', ' + entry[1] + ']',
		};
	}

	if (typeof entry !== 'string') return null;
	const match = INTERVAL.exec(entry.trim());
	if (!match) return null;

	const lower = intervalBound(match[2], -Infinity);
	const upper = intervalBound(match[3], Infinity);
	if (lower === null || upper === null) return null;

	return {
		lower: lower,
		upper: upper,
		lowerOpen: match[1] === ']',
		upperOpen: match[4] === '[',
		text: entry.trim(),
	};
}

/* Is this value a number the interval contains? */
function intervalAdmits(interval, value) {
	if (typeof value !== 'number' && typeof value !== 'string') return false;
	const number = Number(String(value).trim());
	if (String(value).trim() === '' || !isFinite(number)) return false;
	if (interval.lowerOpen ? number <= interval.lower : number < interval.lower) return false;
	if (interval.upperOpen ? number >= interval.upper : number > interval.upper) return false;
	return true;
}

/*
 * Property names are ordinary words in practice ("relation to me"), but a colon
 * or a leading indicator character would break the YAML, so quote when needed.
 */
function yamlScalar(value) {
	if (/^[A-Za-z0-9][A-Za-z0-9 _\-.]*$/.test(value)) return value;
	return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function sameNameList(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/* ----- the Bases formula functions -------------------------------------- */

/*
 * Node identity for the inheritance walk. Two entries mean the same ancestor
 * when they resolve to the same note, or - for parents with no note behind them
 * - when their names match case-insensitively.
 */
function nodeKey(file, name) {
	return file ? 'f:' + file.path : 'n:' + String(name).toLowerCase();
}

/*
 * One Bases function. `applyWithContext` is what the evaluator calls;
 * `serialize` is what the filter builder writes back into a .base file.
 *
 * Obsidian's own boolean functions extend an internal class that is not
 * exported, so these duck-type the interface and build the Value themselves.
 * The cost: they do not appear in the visual filter builder's operator
 * dropdown, which only lists instances of that class.
 */
class BasesFunction {
	constructor(plugin, name, docString, params, compute) {
		this.plugin = plugin;
		this.name = name;
		this.docString = docString;
		this.params = params;
		this.compute = compute;
	}

	applyWithContext(ctx, subject) {
		const args = Array.prototype.slice.call(arguments, 2);
		const file = subject && subject.file;
		if (!(file instanceof TFile) || file.extension !== 'md') return obsidian.NullValue.value;

		try {
			return this.compute(file, args);
		} catch (error) {
			console.error('oof-classes: ' + this.name + '() failed on ' + file.path, error);
			return obsidian.NullValue.value;
		}
	}

	serialize() {
		const args = Array.prototype.slice.call(arguments);
		return args[0] + '.' + this.name + '(' + args.slice(1).join(', ') + ')';
	}
}

/* ------------------------------------------------------------------- plugin */

class OofClassesPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS);
		/* name -> draft { characteristics: [], parents: [] }. Filled by loadSettings. */
		this.drafts = new Map();
		/*
		 * Classes whose base he has asked to be regenerated. A base is created
		 * once and then his, so overwriting one is only ever done on request.
		 */
		this.baseRefreshes = new Set();
		/*
		 * Which class cards are open. Closed is the default, so the panel is a
		 * scannable list of classes; opening one is remembered across restarts,
		 * because which class you are working on outlasts a session.
		 */
		this.expanded = new Set();
		/*
		 * Insolvable discrepancies he has seen and chosen to live with. Without
		 * this the update gate would be a trap: one thing he cannot fix - a case
		 * clash he wants, a value he means - would block every future update.
		 */
		this.dismissed = new Set();
		this.pictureCache = null;

		/* What Obsidian currently thinks each property's type is. */
		this.registeredTypes = {};
		/* Memoised inheritance walks, for the Bases formula functions. */
		this.invalidateClosures();

		await this.loadSettings();
		/*
		 * A migration that never reaches disk runs again next time, and this one
		 * overrules a setting - so it is written out immediately, before he has a
		 * chance to change it back and have it changed for him a second time.
		 */
		if (this.migrationPending) {
			this.migrationPending = false;
			await this.persist();
		}
		await this.loadRegisteredTypes();

		/* file.isA() and friends, for bases and formulas. */
		this.registerBasesFunctions();

		/*
		 * Any change to the vault can change what inherits from what, so the
		 * closures go. The picture goes too, but only for the three folders it
		 * describes - a change to a journal entry cannot alter it, and rebuilding
		 * on every keystroke anywhere would undo the point of caching it.
		 */
		const touched = (file) => {
			this.invalidateClosures();
			if (this.inPictureFolders(file)) this.invalidatePicture();
		};

		this.registerEvent(this.app.metadataCache.on('changed', (file) => { touched(file); }));
		this.registerEvent(this.app.vault.on('create', (file) => { touched(file); }));
		this.registerEvent(this.app.vault.on('delete', (file) => { touched(file); }));
		/*
		 * A rename can move a note *out* of a watched folder, so the old path
		 * matters as much as the new one.
		 */
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.invalidateClosures();
			const wasWatched = typeof oldPath === 'string'
				&& [this.settings.notesFolder, this.settings.templatesFolder,
					this.settings.characteristicsFolder]
					.some((folder) => oldPath.indexOf(folder + '/') === 0);
			if (wasWatched || this.inPictureFolders(file)) this.invalidatePicture();
		}));

		this.registerView(VIEW_TYPE, (leaf) => new ClassesView(leaf, this));

		this.addRibbonIcon('boxes', 'OOF Classes', () => { this.activateView(); });

		this.addCommand({
			id: 'open-classes-panel',
			name: 'Open the classes panel',
			callback: () => { this.activateView(); },
		});

		/*
		 * The same pair as the header buttons, so folding the whole panel can be
		 * bound to a key. They act on the panel's state, not on the panel itself,
		 * so they work whether or not it is open.
		 */
		this.addCommand({
			id: 'unfold-all-classes',
			name: 'Unfold all classes',
			callback: () => { this.setAllClassesExpanded(true); },
		});

		this.addCommand({
			id: 'fold-all-classes',
			name: 'Fold all classes',
			callback: () => { this.setAllClassesExpanded(false); },
		});

		this.addSettingTab(new OofClassesSettingTab(this.app, this));
	}

	async activateView() {
		/* Obsidian may have changed a type since we last looked. */
		await this.loadRegisteredTypes();

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

	/* ------------------------------------------------------------- scanning */

	frontmatterOf(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		return (cache && cache.frontmatter) || null;
	}

	inFolder(file, folder) {
		if (!folder) return true;
		return file.path === folder + '/' + file.name || file.path.startsWith(folder + '/');
	}

	filesIn(folder) {
		return this.app.vault.getMarkdownFiles().filter((f) => this.inFolder(f, folder));
	}

	/* ----- the base characteristics -------------------------------------- */

	emptyLogicValues() {
		const values = {};
		for (const property of this.settings.logicProperties) values[property] = [];
		return values;
	}

	/*
	 * The tag that says "this note is a class". Read through metadataCache's own
	 * tag list, so `tags:` in frontmatter and `#class` in the body both count.
	 */
	hasClassTag(file) {
		const tag = this.settings.classTag;
		if (!tag) return false;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return false;

		const wanted = '#' + tag.replace(/^#/, '');
		for (const entry of toArray(cache.tags)) {
			if (entry && entry.tag === wanted) return true;
		}

		const frontmatter = cache.frontmatter || {};
		for (const entry of toArray(frontmatter.tags).concat(toArray(frontmatter.tag))) {
			if (typeof entry === 'string' && '#' + entry.replace(/^#/, '') === wanted) return true;
		}
		return false;
	}

	/*
	 * Obsidian resolves links case-insensitively, so `[[note]]` and `[[Note]]`
	 * are the same note to him. Names are therefore normalised to whatever the
	 * file actually calls itself before anything is keyed on them - otherwise a
	 * lowercase link conjures a second, empty class beside the real one.
	 */
	canonicalName(name) {
		if (!name) return name;

		const cache = this.app.metadataCache;
		if (!cache || typeof cache.getFirstLinkpathDest !== 'function') return name;

		const dest = cache.getFirstLinkpathDest(name, '');
		return dest && dest.basename ? dest.basename : name;
	}

	/* Read every base characteristic off one note's frontmatter. */
	readLogicValues(frontmatter) {
		const values = this.emptyLogicValues();
		for (const property of this.settings.logicProperties) {
			const isCharacteristic = property === this.settings.characteristicsProperty;
			values[property] = toArray(frontmatter[property])
				.map(linkName)
				.filter(Boolean)
				.map((name) => this.canonicalName(name))
				/* `[[∘ domain]]` names the characteristic `domain`. */
				.map((name) => (isCharacteristic
					? stripPrefix(name, this.settings.characteristicPrefix) : name));
		}
		return values;
	}

	/* The file name a characteristic's note has, or should have. */
	characteristicFileName(name) {
		return addPrefix(name, this.settings.characteristicPrefix);
	}

	characteristicPath(name) {
		return this.settings.characteristicsFolder + '/'
			+ this.characteristicFileName(name) + '.md';
	}

	/*
	 * A characteristic is a note in the characteristics folder. Its frontmatter
	 * says what it means and what shape its value takes.
	 */
	scanCharacteristics() {
		const map = new Map();
		for (const file of this.filesIn(this.settings.characteristicsFolder)) {
			const fm = this.frontmatterOf(file) || {};
			/* `∘ domain.md` is the characteristic `domain`, and the property `domain`. */
			const name = stripPrefix(file.basename, this.settings.characteristicPrefix);
			map.set(name, {
				name: name,
				file: file,
				meaning: fm['characteristic meaning'] || '',
				propertyType: fm['property type'] || '',
				/*
				 * An explicit constraint, when he has given one. Empty means
				 * "any value of the right shape" rather than "no values".
				 *
				 * Kept **raw** as well, because reducing each entry to a note
				 * name throws away the two things that decide what kind of
				 * constraint it is: whether it was written as a link, and its
				 * brackets. See `constraintsFor`.
				 */
				possibleValuesRaw: toArray(fm['possible values']),
				possibleValues: toArray(fm['possible values'])
					.map(linkName).filter(Boolean)
					.map((name) => this.canonicalName(name)),
			});
		}
		return map;
	}

	/*
	 * A class is a note that carries the class tag, lists characteristics,
	 * names a parent, or is named as a parent by something else. The root object
	 * counts even when it does not exist yet, so the panel can offer to make it.
	 */
	scanClasses() {
		const objects = new Map();
		const notes = this.filesIn(this.settings.notesFolder);

		const byName = new Map();
		for (const file of notes) byName.set(file.basename, file);

		const record = (name) => {
			if (!objects.has(name)) {
				objects.set(name, {
					name: name, file: null, frontmatter: null,
					values: this.emptyLogicValues(), characteristics: [], parents: [],
					/* Every key the note carries, base characteristic or not. */
					keys: new Set(),
					present: new Set(),
				});
			}
			return objects.get(name);
		};

		/*
		 * 1. A note is a class when it carries the class tag, or declares
		 * characteristics or a parent. Deliberately not "has any base
		 * characteristic": every *instance* carries `is a`, and instances are
		 * not classes.
		 */
		for (const file of notes) {
			const fm = this.frontmatterOf(file);
			if (!fm) continue;

			const values = this.readLogicValues(fm);
			const characteristics = values[this.settings.characteristicsProperty] || [];
			const parents = values[this.settings.inheritsProperty] || [];
			const tagged = this.hasClassTag(file);

			if (!tagged && characteristics.length === 0 && parents.length === 0) continue;

			record(file.basename);
			/* A named parent is a class too, even with no note of its own yet. */
			for (const parent of parents) record(parent);
		}

		/*
		 * 2. Anything an instance calls itself is a class, so it belongs in the
		 * panel even when it declares nothing of its own yet - which is how a
		 * bare `Note` shows up once notes start saying `is a: "[[Note]]"`.
		 */
		for (const file of notes) {
			const fm = this.frontmatterOf(file);
			if (!fm) continue;
			for (const raw of toArray(fm[this.settings.isAProperty]).map(linkName)) {
				if (!raw) continue;
				const className = this.canonicalName(raw);
				if (className === file.basename) continue;
				/*
				 * Only if a note for it actually exists. An `is a` pointing at
				 * nothing is a typo, not a class, and inventing one from it puts
				 * a permanently empty card in the panel.
				 */
				if (!byName.has(className)) continue;
				record(className);
			}
		}

		/*
		 * 3. Read every class's real frontmatter, once, here. Reading it in
		 * step 1 meant a class discovered only in step 2 kept empty values -
		 * and the planner would then have written those emptied values straight
		 * back over the note.
		 */
		for (const [name, object] of objects) {
			const file = byName.get(name);
			if (!file) continue;

			const fm = this.frontmatterOf(file) || {};
			object.file = file;
			object.frontmatter = fm;
			object.values = this.readLogicValues(fm);
			object.characteristics = object.values[this.settings.characteristicsProperty] || [];
			object.parents = object.values[this.settings.inheritsProperty] || [];
			object.keys = new Set(Object.keys(fm));
			object.tagged = this.hasClassTag(file);
			/*
			 * An absent key and an empty one both read as [], so presence is
			 * tracked separately: it is the difference between a class that
			 * complies with the base characteristics and one that does not.
			 */
			object.present = new Set(
				this.settings.logicProperties.filter((property) => property in fm));
		}

		return objects;
	}

	/*
	 * Instances are notes that name a class through `is a`. They are what the
	 * retroactive half of Update acts on.
	 */
	scanInstances(objects) {
		const instances = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.frontmatterOf(file);
			if (!fm) continue;

			const classes = toArray(fm[this.settings.isAProperty])
				.map(linkName).filter(Boolean).map((name) => this.canonicalName(name));
			const known = classes.filter((name) => objects.has(name));
			if (known.length === 0) continue;
			/* A template names its class too; it is regenerated, not patched. */
			if (this.inFolder(file, this.settings.templatesFolder)) continue;
			if (objects.has(file.basename) && objects.get(file.basename).file === file) continue;

			instances.push({ file: file, classes: known, frontmatter: fm });
		}
		return instances;
	}

	/* ---------------------------------------------------------- the model -- */

	/*
	 * The draft view of a class: what the panel currently shows, which is the
	 * vault's state plus any unsaved edit.
	 */
	draftOf(object) {
		const edit = this.drafts.get(object.name);
		const stored = object.values || this.emptyLogicValues();

		const values = {};
		for (const property of this.settings.logicProperties) {
			const edited = edit && edit.values && edit.values[property];
			values[property] = edited ? edited.slice() : (stored[property] || []).slice();
		}

		return {
			name: object.name,
			file: object.file,
			values: values,
			/* Named aliases for the two the engine reasons with. */
			characteristics: values[this.settings.characteristicsProperty] || [],
			parents: values[this.settings.inheritsProperty] || [],
			isNew: !object.file,
		};
	}

	/* Does this draft say anything the vault does not already say? */
	draftDiffers(draft, object) {
		const stored = (object && object.values) || this.emptyLogicValues();
		for (const property of this.settings.logicProperties) {
			if (!sameNameList(draft.values[property] || [], stored[property] || [])) return true;
		}
		return false;
	}

	/*
	 * Every class the panel should show: the ones in the vault, plus any that
	 * exist only as a draft. Without the second half a newly added class would
	 * be invisible and would never make it into a plan.
	 */
	allDrafts(objects) {
		const drafts = new Map();
		for (const [name, object] of objects) drafts.set(name, this.draftOf(object));

		for (const name of this.drafts.keys()) {
			if (drafts.has(name)) continue;
			drafts.set(name, this.draftOf({
				name: name, file: null, characteristics: [], parents: [],
			}));
		}
		return drafts;
	}

	/*
	 * Which classes a note is about: itself, if it is a class; otherwise the
	 * classes its `is a` names. Used to follow the active note in the panel —
	 * open an artist and the Artist card lights up.
	 */
	classesForFile(file, classes) {
		if (!file) return [];

		/* By path, not identity: the same note can arrive as a different object. */
		const own = classes.get(file.basename);
		if (own && own.file && own.file.path === file.path) return [file.basename];

		const frontmatter = this.frontmatterOf(file);
		if (!frontmatter) return [];

		return toArray(frontmatter[this.settings.isAProperty])
			.map(linkName).filter(Boolean)
			.map((name) => this.canonicalName(name))
			.filter((name) => classes.has(name));
	}

	/*
	 * How many generations of `type of` sit above this class. A class with no
	 * parent is 0, its children 1. `ancestorsOf` de-duplicates and caps its own
	 * depth, so a cycle cannot run away here.
	 */
	classDepth(name, objects, drafts) {
		return this.ancestorsOf(name, objects, drafts).length;
	}

	/*
	 * The panel's order: everything a class descends from sits above it, and
	 * within one generation the names run alphabetically.
	 */
	sortedClassNames(objects, drafts) {
		const names = Array.from(drafts.keys());

		if (this.settings.sortClasses !== 'descent') {
			return names.sort((a, b) => a.localeCompare(b));
		}

		const depth = new Map();
		for (const name of names) depth.set(name, this.classDepth(name, objects, drafts));

		return names.sort((a, b) => {
			const byDepth = depth.get(a) - depth.get(b);
			return byDepth !== 0 ? byDepth : a.localeCompare(b);
		});
	}

	/* A class that exists only as a draft has no vault state to compare to. */
	vaultStateOf(name, objects) {
		return objects.get(name) || {
			name: name, file: null,
			values: this.emptyLogicValues(), characteristics: [], parents: [],
		};
	}

	/*
	 * Are there edits the vault has not been told about yet? Note the name: this
	 * is *pending*, not *unsaved*. Drafts are always saved; what they are not
	 * yet is applied. Conflating the two is what made the old badge read
	 * "unsaved" forever, since a draft that matches the vault is not a draft.
	 */
	isDirty(objects) {
		if (this.baseRefreshes.size > 0) return true;

		for (const name of this.drafts.keys()) {
			const object = objects.get(name);
			if (!object || !object.file) return true;
			if (this.draftDiffers(this.draftOf(object), object)) return true;
		}
		return false;
	}

	/* Drop drafts that no longer say anything the vault does not already say. */
	pruneDrafts(objects) {
		for (const name of Array.from(this.drafts.keys())) {
			const object = objects.get(name);
			if (!object || !object.file) continue;
			if (!this.draftDiffers(this.draftOf(object), object)) this.drafts.delete(name);
		}
	}

	/*
	 * Every class above this one, by `type of` and nothing else. There is
	 * no implicit root: a class inherits exactly what its notes say it does, so
	 * the files are the whole truth and file.isA() cannot disagree with the panel.
	 */
	ancestorsOf(name, objects, drafts) {
		const seen = new Set([name]);
		const chain = [];

		let frontier = (drafts.get(name) || { parents: [] }).parents.slice();
		let depth = 0;

		while (frontier.length > 0 && depth < MAX_DEPTH) {
			const next = [];
			for (const parent of frontier) {
				if (seen.has(parent)) continue;
				seen.add(parent);
				chain.push(parent);
				const parentDraft = drafts.get(parent);
				if (parentDraft) next.push.apply(next, parentDraft.parents);
			}
			frontier = next;
			depth++;
		}

		return chain;
	}

	/*
	 * What an instance of this class carries: its own characteristics and every
	 * ancestor's, nearest first, de-duplicated.
	 */
	effectiveCharacteristics(name, objects, drafts) {
		const out = [];
		const seen = new Set();

		const add = (list) => {
			for (const characteristic of list) {
				if (seen.has(characteristic)) continue;
				seen.add(characteristic);
				out.push(characteristic);
			}
		};

		const self = drafts.get(name);
		if (self) add(self.characteristics);

		for (const ancestor of this.ancestorsOf(name, objects, drafts)) {
			const draft = drafts.get(ancestor);
			if (draft) add(draft.characteristics);
		}

		return out;
	}

	/* ----- the Bases formula functions -------------------------------------- */

	/*
	 * `file.isA()` and friends, folded in from the separate Bases Is A plugin
	 * 2026-08-16. Keeping them apart meant two plugins each with its own
	 * configurable `is a` and `type of` names, free to disagree about the very
	 * hierarchy they both describe — and the bases this plugin generates depend
	 * on `file.isA()` working.
	 *
	 * The walk deliberately reads frontmatter directly rather than going through
	 * `scanClasses()`: a formula may be asked about **any** note in the vault,
	 * not only the ones in the classes folder.
	 */
	registerBasesFunctions() {
		const missing = typeof this.registerInstanceFunc !== 'function'
			|| !obsidian.FileValue || !obsidian.BooleanValue || !obsidian.ListValue;

		if (missing) {
			new Notice('OOF Classes: this Obsidian version does not expose the Bases function '
				+ 'registry, so file.isA() is unavailable.', 8000);
			console.error('oof-classes: registerInstanceFunc or a Value class is missing.');
			return false;
		}

		const self = { name: 'self', type: [obsidian.FileValue] };
		const target = { name: 'type', type: [obsidian.StringValue, obsidian.LinkValue] };

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'isA',
			'True when the note is an instance of the given class, following "is a" and '
				+ 'then the "type of" chain above it.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return new obsidian.BooleanValue(false);
				if (this.matchesSelf(file, key)) return new obsidian.BooleanValue(true);
				return new obsidian.BooleanValue(this.isAClosure(file).distance.has(key));
			},
		));

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'inheritsFrom',
			'True when the note is a subclass of the given class, following "type of" only.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return new obsidian.BooleanValue(false);
				if (this.matchesSelf(file, key)) return new obsidian.BooleanValue(true);
				return new obsidian.BooleanValue(this.inheritsClosure(file).distance.has(key));
			},
		));

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'ancestors',
			'Everything above this note by either relation, nearest first.',
			[self],
			(file) => new obsidian.ListValue(this.allAncestors(file)),
		));

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'isADistance',
			'How many hops away the given class is along the "is a" chain, or null.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return obsidian.NullValue.value;
				if (this.matchesSelf(file, key)) return new obsidian.NumberValue(0);
				const distance = this.isAClosure(file).distance.get(key);
				return distance === undefined
					? obsidian.NullValue.value : new obsidian.NumberValue(distance);
			},
		));

		return true;
	}

	/* The parents named by one property of one note, resolved where possible. */
	linkedParents(file, property) {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = (cache && cache.frontmatter) || null;
		if (!frontmatter) return [];

		const parents = [];
		for (const entry of toArray(frontmatter[property])) {
			const name = linkName(entry);
			if (!name) continue;
			const dest = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
			parents.push({
				file: dest instanceof TFile ? dest : null,
				name: dest instanceof TFile ? dest.basename : name,
			});
		}
		return parents;
	}

	/*
	 * Seeds sit at distance 1; from there the walk climbs `property` only.
	 * Breadth-first, so an ancestor reachable two ways gets the shorter
	 * distance. A visited set makes cycles safe, with a depth cap behind it.
	 */
	climb(file, seeds, property) {
		const distance = new Map();
		const names = new Map();
		const seen = new Set([nodeKey(file, file.basename)]);

		let frontier = [];
		for (const seed of seeds) {
			const key = nodeKey(seed.file, seed.name);
			if (seen.has(key)) continue;
			seen.add(key);
			distance.set(key, 1);
			names.set(key, seed.name);
			frontier.push(seed);
		}

		let depth = 1;
		while (frontier.length > 0 && depth < MAX_DEPTH) {
			const next = [];
			for (const node of frontier) {
				if (!node.file) continue;
				for (const parent of this.linkedParents(node.file, property)) {
					const key = nodeKey(parent.file, parent.name);
					if (seen.has(key)) continue;
					seen.add(key);
					distance.set(key, depth + 1);
					names.set(key, parent.name);
					next.push(parent);
				}
			}
			frontier = next;
			depth++;
		}

		return { distance: distance, name: names };
	}

	/*
	 * Instantiation composed with inheritance: the note's `is a` targets, plus
	 * every class those are a type of. This is what "an artist is a person"
	 * means — and why `is a` does not chain through itself.
	 */
	isAClosure(file) {
		const hit = this.isACache.get(file.path);
		if (hit) return hit;
		const closure = this.climb(file,
			this.linkedParents(file, this.settings.isAProperty),
			this.settings.inheritsProperty);
		this.isACache.set(file.path, closure);
		return closure;
	}

	/* Pure subclassing: the `type of` chain starting at the note itself. */
	inheritsClosure(file) {
		const hit = this.inheritsCache.get(file.path);
		if (hit) return hit;
		const closure = this.climb(file,
			this.linkedParents(file, this.settings.inheritsProperty),
			this.settings.inheritsProperty);
		this.inheritsCache.set(file.path, closure);
		return closure;
	}

	/* Everything above a note by either route, nearest first. */
	allAncestors(file) {
		const merged = new Map();
		const names = new Map();

		for (const closure of [this.isAClosure(file), this.inheritsClosure(file)]) {
			for (const [key, hops] of closure.distance) {
				const known = merged.get(key);
				if (known === undefined || hops < known) merged.set(key, hops);
				if (!names.has(key)) names.set(key, closure.name.get(key));
			}
		}

		return Array.from(merged.keys())
			.sort((a, b) => merged.get(a) - merged.get(b))
			.map((key) => names.get(key));
	}

	/* Is Artist an Artist? Only when the setting says so. */
	matchesSelf(file, targetKey) {
		return this.settings.classIsItsOwnInstance
			&& nodeKey(file, file.basename) === targetKey;
	}

	/* A target written "Person", "[[Person]]" or as a link all compare equal. */
	targetKey(value, sourcePath) {
		if (!value) return null;

		if (obsidian.LinkValue && value instanceof obsidian.LinkValue) {
			const resolved = typeof value.resolve === 'function' ? value.resolve() : null;
			if (resolved instanceof TFile) return 'f:' + resolved.path;
		}

		const name = linkName(typeof value.data === 'string' ? value.data : String(value.data));
		if (!name) return null;

		return this.keyForName(name, sourcePath);
	}

	/* The same rule, for a name the plugin already holds as a plain string. */
	keyForName(name, sourcePath) {
		const dest = this.app.metadataCache.getFirstLinkpathDest(name, sourcePath || '');
		return dest instanceof TFile ? 'f:' + dest.path : 'n:' + String(name).toLowerCase();
	}

	/* The walks are memoised; any edit to the hierarchy drops the lot. */
	invalidateClosures() {
		this.isACache = new Map();
		this.inheritsCache = new Map();
	}

	/* ----- Obsidian's own property-type registry ---------------------------- */

	/*
	 * Obsidian records a type per property name in `.obsidian/types.json`, in
	 * its own vocabulary. A characteristic note records the same fact as
	 * `property type`. Two places, one truth — and **the characteristic note is
	 * the truth**, so the registry is made to follow it.
	 *
	 * It is not a note, so it is read through the adapter rather than the vault,
	 * and cached: buildPlan is synchronous and stays that way.
	 */
	typesPath() {
		return (this.app.vault.configDir || '.obsidian') + '/types.json';
	}

	async loadRegisteredTypes() {
		this.registeredTypes = {};
		try {
			const raw = await this.app.vault.adapter.read(this.typesPath());
			const parsed = JSON.parse(raw);
			if (parsed && parsed.types) this.registeredTypes = parsed.types;
		} catch (error) {
			/* No registry yet; Obsidian writes one the first time it needs to. */
		}
	}

	/* `list` is his word for what Obsidian calls `multitext`; the rest agree. */
	registryTypeFor(propertyType) {
		const type = String(propertyType || '').toLowerCase();
		if (!type) return null;
		return type === 'list' ? 'multitext' : type;
	}

	/*
	 * Where the registry disagrees with a characteristic note, or has never
	 * heard of it. A characteristic that has not declared a type says nothing,
	 * so nothing is changed on its behalf.
	 */
	registryDisagreements(characteristics) {
		const registered = this.registeredTypes || {};
		const changes = [];

		for (const [name, characteristic] of characteristics) {
			const wanted = this.registryTypeFor(characteristic.propertyType);
			if (!wanted) continue;
			if (registered[name] === wanted) continue;

			changes.push({
				property: name,
				from: registered[name] || null,
				to: wanted,
			});
		}
		return changes;
	}

	/* ----- the picture ------------------------------------------------------ */

	/*
	 * One object describing the whole system as data: the characteristics and
	 * what they may hold, the classes and what they inherit, the instances and
	 * what they actually carry. His words: "describing the objects as code
	 * instead of as markdown files linked to each other".
	 *
	 * It is **derived and disposable** - the vault and `drafts` are the only
	 * authorities - so rebuilding it is always safe. And it is **synchronous**:
	 * everything it needs is in metadataCache already.
	 */
	/*
	 * The picture, cached. Rebuilt when a note in one of the three folders
	 * changes and not otherwise - his instruction, and the reason it is worth
	 * holding rather than deriving on the spot: the discrepancy pass walks it
	 * several times over, and the panel reads it on every repaint.
	 *
	 * Still derived and still disposable. `invalidatePicture()` may be called at
	 * any moment without losing anything, because nothing is authoritative here
	 * except the vault and his unapplied edits.
	 */
	picture() {
		if (!this.pictureCache) this.pictureCache = this.buildPicture();
		return this.pictureCache;
	}

	invalidatePicture() {
		this.pictureCache = null;
	}

	/*
	 * Do we care that this file changed? Three folders, which is wider than the
	 * set of things that become objects: only notes are objects, but editing a
	 * characteristic or a template still changes what the picture says.
	 */
	inPictureFolders(file) {
		if (!file || file.extension !== 'md') return false;
		return this.inFolder(file, this.settings.notesFolder)
			|| this.inFolder(file, this.settings.templatesFolder)
			|| this.inFolder(file, this.settings.characteristicsFolder);
	}

	buildPicture() {
		const characteristics = this.scanCharacteristics();

		const classes = this.scanClasses();
		const drafts = this.allDrafts(classes);

		for (const [name, klass] of classes) {
			/*
			 * Canonical order here, not the nearest-first order the walk
			 * returns: the picture describes how things *are*, and how they are
			 * laid out is by type then name, the same everywhere.
			 */
			klass.effective = this.canonicalOrder(
				this.effectiveCharacteristics(name, classes, drafts), characteristics);
			klass.instances = [];
		}

		const instances = new Map();
		for (const found of this.scanInstances(classes)) {
			const expected = [];
			const seen = new Set();
			for (const className of found.classes) {
				const klass = classes.get(className);
				if (klass) klass.instances.push(found.file.basename);
				for (const characteristic of this.effectiveCharacteristics(className, classes, drafts)) {
					if (seen.has(characteristic)) continue;
					seen.add(characteristic);
					expected.push(characteristic);
				}
			}

			instances.set(found.file.path, {
				name: found.file.basename,
				file: found.file,
				classes: found.classes,
				expected: this.canonicalOrder(expected, characteristics),
				values: found.frontmatter,
				keys: new Set(Object.keys(found.frontmatter)),
			});
		}

		/*
		 * "All notes are objects, even if they are not a class" - and only notes.
		 * A template and a characteristic note *describe* the system; they are
		 * not subjects of it, so neither gets a proxy here. They still belong to
		 * the picture through `characteristics` above and through the templates
		 * the plan writes, and a change to either still rebuilds it.
		 *
		 * Roles rather than one `kind`, because a note can be several at once: a
		 * class may also be an instance of something. Naming one primary would be
		 * a taxonomy the vault does not actually have.
		 */
		const notes = new Map();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.inFolder(file, this.settings.notesFolder)) continue;
			/* Excluded explicitly, so a folder nested inside Notes stays out too. */
			if (this.inFolder(file, this.settings.templatesFolder)) continue;
			if (this.inFolder(file, this.settings.characteristicsFolder)) continue;

			const frontmatter = this.frontmatterOf(file) || {};
			const values = this.readLogicValues(frontmatter);
			const klass = classes.get(file.basename);

			notes.set(file.path, {
				name: file.basename,
				file: file,
				frontmatter: frontmatter,
				keys: new Set(Object.keys(frontmatter)),
				/* What it says about itself. */
				classes: values[this.settings.isAProperty] || [],
				parents: values[this.settings.inheritsProperty] || [],
				own: values[this.settings.characteristicsProperty] || [],
				/* The roles it plays. */
				isClass: !!(klass && klass.file && klass.file.path === file.path),
				isInstance: instances.has(file.path),
				tagged: this.hasClassTag(file),
			});
		}

		return {
			notes: notes,
			characteristics: characteristics,
			classes: classes,
			instances: instances,
			drafts: drafts,
			edits: this.drafts,
		};
	}

	/*
	 * Every value on a note that its characteristic does not permit.
	 *
	 * Two constraints, both optional and both from the characteristic's own
	 * note: `property type` says what *shape* a value may take, `possible
	 * values` enumerates the values themselves. Silence on either means "no
	 * constraint" rather than "nothing allowed" - which matters, because
	 * nothing in his vault carries a `possible values` yet.
	 *
	 * Never auto-fixed. A value he typed is his; the plugin's job is to say
	 * it does not fit, not to choose a different one.
	 */
	valueDiscrepancies(picture) {
		const found = [];

		const check = (file, keys, values) => {
			for (const key of keys) {
				const characteristic = picture.characteristics.get(key);
				if (!characteristic) continue;

				const value = values[key];
				if (isEmptyValue(value)) continue;
				/* Machinery, not data: it is not a date yet, it is the code for one. */
				if (isTemplaterExpression(value)) continue;

				const shape = this.shapeComplaint(characteristic, value);
				if (shape) {
					found.push({ file: file, property: key, value: value, reason: shape });
					continue;
				}

				const complaint = this.valueComplaint(
					characteristic, value, picture, file ? file.path : '');
				if (complaint) {
					found.push({ file: file, property: key, value: value, reason: complaint });
				}
			}
		};

		for (const instance of picture.instances.values()) {
			check(instance.file, Array.from(instance.keys), instance.values);
		}
		for (const klass of picture.classes.values()) {
			if (!klass.file || !klass.frontmatter) continue;
			check(klass.file, Array.from(klass.keys), klass.frontmatter);
		}

		/*
		 * Templates too. A default written into one - `domain: visual` on every
		 * Visual Artist - is a real value that reaches every instance made from
		 * it, so it has to satisfy the same characteristic as any other.
		 */
		for (const name of picture.classes.keys()) {
			const template = this.app.vault.getFileByPath(this.templatePathFor(name));
			if (!(template instanceof TFile)) continue;
			const frontmatter = this.frontmatterOf(template);
			if (!frontmatter) continue;
			check(template, Object.keys(frontmatter), frontmatter);
		}

		return found;
	}

	/* Does the value's shape contradict `property type`? */
	shapeComplaint(characteristic, value) {
		const type = String(characteristic.propertyType || '').toLowerCase();
		if (!type) return null;

		if (type === 'list' || type === 'multitext') {
			return Array.isArray(value) ? null
				: 'holds a single value, but ' + characteristic.name + ' is a list.';
		}
		if (type === 'number') {
			if (Array.isArray(value)) return 'holds a list, but ' + characteristic.name + ' is a number.';
			return isFinite(Number(value)) ? null
				: 'is not a number, but ' + characteristic.name + ' is.';
		}
		if (type === 'checkbox') {
			return (value === true || value === false) ? null
				: 'is not true or false, but ' + characteristic.name + ' is a checkbox.';
		}
		if (type === 'date' || type === 'datetime') {
			if (Array.isArray(value)) return 'holds a list, but ' + characteristic.name + ' is a date.';
			return isNaN(Date.parse(String(value)))
				? 'is not a date, but ' + characteristic.name + ' is.' : null;
		}
		return null;
	}

	/*
	 * What one `possible values` field actually demands. Three kinds, decided
	 * **per entry** — so they mix, and a value passes when *any* entry admits it,
	 * which is what "possible values" says:
	 *
	 *   [[Genre]]   a link to a class  ->  a link to an instance of that class
	 *   oil, ink    words              ->  one of those words
	 *   [0, 10]     an interval        ->  a number inside it
	 *
	 * A link is a class constraint only when it really points at a class. A link
	 * to an ordinary note stays a literal, which is what it always was.
	 */
	constraintsFor(characteristic, picture) {
		const raw = characteristic.possibleValuesRaw
			|| toArray(characteristic.possibleValues);

		const constraints = [];
		for (const entry of raw) {
			const interval = parseInterval(entry);
			if (interval) {
				constraints.push({ kind: 'interval', interval: interval, text: interval.text });
				continue;
			}

			const name = linkName(typeof entry === 'string' ? entry : String(entry));
			if (!name) continue;
			const canonical = this.canonicalName(name);

			if (picture && picture.classes && isWikiLink(entry) && picture.classes.has(canonical)) {
				constraints.push({
					kind: 'class', name: canonical, text: 'instances of ' + canonical,
				});
				continue;
			}

			constraints.push({ kind: 'literal', name: canonical, text: canonical });
		}
		return constraints;
	}

	/* Does this one constraint admit this one value? */
	admits(constraint, entry, sourcePath) {
		if (constraint.kind === 'interval') return intervalAdmits(constraint.interval, entry);

		const name = linkName(typeof entry === 'string' ? entry : String(entry));
		if (!name) return false;

		if (constraint.kind === 'literal') {
			const wanted = String(constraint.name).toLowerCase();
			return String(this.canonicalName(name)).toLowerCase() === wanted
				|| String(name).toLowerCase() === wanted;
		}

		/*
		 * A class: the value has to name a note, and that note has to be an
		 * instance of the class — through `is a` and the `type of` chain above it,
		 * the same walk `file.isA()` does. So a base and this check can never
		 * disagree about what counts as a Genre.
		 */
		const dest = this.app.metadataCache.getFirstLinkpathDest(name, sourcePath || '');
		if (!(dest instanceof TFile)) return false;
		const key = this.keyForName(constraint.name, sourcePath);
		return this.matchesSelf(dest, key) || this.isAClosure(dest).distance.has(key);
	}

	/* Everything in this value that no constraint admits, said in one sentence. */
	valueComplaint(characteristic, value, picture, sourcePath) {
		const constraints = this.constraintsFor(characteristic, picture);
		if (constraints.length === 0) return null;

		const wantsClass = constraints.some((c) => c.kind === 'class');
		const offenders = [];

		for (const entry of toArray(value)) {
			if (isEmptyValue(entry)) continue;
			if (constraints.some((c) => this.admits(c, entry, sourcePath))) continue;

			const name = linkName(typeof entry === 'string' ? entry : String(entry));
			const shown = name || String(entry);
			/* Naming a note that does not exist is a different mistake. */
			const missing = wantsClass && name
				&& !(this.app.metadataCache.getFirstLinkpathDest(name, sourcePath || '') instanceof TFile);
			offenders.push(missing ? shown + ' (no such note)' : shown);
		}

		if (offenders.length === 0) return null;

		return offenders.join(', ') + ' — not permitted by the possible values for '
			+ characteristic.name + ' (' + constraints.map((c) => c.text).join(', ') + ').';
	}

	/* ----- the canonical property order ------------------------------------ */

	propertyTypeOf(name, characteristics) {
		const characteristic = characteristics.get(name);
		return characteristic && characteristic.propertyType
			? String(characteristic.propertyType)
			: '';
	}

	/*
	 * Properties are laid out by **property type first, then alphabetically**,
	 * whatever order they were added in. A property with no type known - no
	 * characteristic note, or one that has not said - sorts last, so untyped
	 * things do not wedge themselves between the typed groups.
	 */
	canonicalOrder(names, characteristics) {
		return names.slice().sort((a, b) => {
			const typeA = this.propertyTypeOf(a, characteristics);
			const typeB = this.propertyTypeOf(b, characteristics);

			if (typeA !== typeB) {
				if (!typeA) return 1;
				if (!typeB) return -1;
				return typeA.localeCompare(typeB);
			}
			return a.localeCompare(b);
		});
	}

	/* Ours to order: base characteristics, and anything with a characteristic note. */
	isManagedProperty(key, characteristics) {
		return characteristics.has(key) || this.settings.logicProperties.includes(key);
	}

	templatePathFor(name) {
		return this.settings.templatesFolder + '/' + name + this.settings.templateSuffix + '.md';
	}

	/* ----- generated bases ------------------------------------------------- */

	basePathFor(name) {
		return this.settings.basesFolder + '/' + name + this.settings.baseSuffix + '.base';
	}

	/*
	 * Build the .base file for one class. Deliberately plain text rather than a
	 * YAML library: the shape is fixed, and this way the output reads exactly
	 * like the bases he writes by hand.
	 */
	baseColumnsFor(name, objects, drafts) {
		return this.settings.baseColumns === 'own'
			? ((drafts.get(name) || { characteristics: [] }).characteristics || [])
			: this.effectiveCharacteristics(name, objects, drafts);
	}

	baseContentFor(name, objects, drafts) {
		const columns = this.baseColumnsFor(name, objects, drafts);

		const lines = [];
		lines.push('filters:');
		lines.push('  and:');
		/* Instances of this class, inheritance included. */
		lines.push('    - file.isA("' + name + '")');
		/* A template names its class too, so it would otherwise show up here. */
		lines.push('    - \'!file.inFolder("' + this.settings.templatesFolder + '")\'');
		lines.push('views:');
		lines.push('  - type: table');
		lines.push('    name: Table');
		lines.push('    order:');
		lines.push('      - file.name');
		for (const column of columns) lines.push('      - ' + yamlScalar(column));

		return lines.join('\n') + '\n';
	}

	/*
	 * No cache is needed to decide whether to write a base: existence is the
	 * whole test, and .base contents are never compared, because an existing
	 * base is never rewritten.
	 */

	/* ------------------------------------------------------------ the plan -- */

	/*
	 * Compare the vault against the drafts and return everything that would have
	 * to change, plus everything that cannot be changed safely. Pure: this
	 * touches nothing.
	 */
	buildPlan() {
		const objects = this.scanClasses();
		const characteristics = this.scanCharacteristics();

		/* Drafts for every class, so inheritance is computed on edited values. */
		const drafts = this.allDrafts(objects);

		const instances = this.scanInstances(objects);

		const actions = [];
		const conflicts = [];

		/* 1. characteristic notes that are needed but do not exist yet */
		const referencedBy = new Map();
		for (const [className, draft] of drafts) {
			for (const characteristic of draft.characteristics) {
				if (!referencedBy.has(characteristic)) referencedBy.set(characteristic, []);
				referencedBy.get(characteristic).push(className);
			}
		}

		/*
		 * The base characteristics need notes of their own too. They are not
		 * listed in anyone's `characteristics`, but they are characteristics all
		 * the same - and their note is where `property type` lives, which is
		 * what puts them in the right place in the property order.
		 */
		const needed = new Set(this.settings.logicProperties);
		for (const name of referencedBy.keys()) needed.add(name);

		for (const name of needed) {
			const isBase = this.settings.logicProperties.includes(name);

			if (characteristics.has(name)) {
				/*
				 * A base characteristic whose note says nothing about its shape
				 * sorts last, because an unknown type sorts last - which reads
				 * as the ordering being broken. We know these are lists of
				 * links, so say so rather than leaving it blank.
				 */
				if (!isBase) continue;

				const characteristic = characteristics.get(name);
				const fm = this.frontmatterOf(characteristic.file) || {};
				const needsType = isEmptyValue(fm['property type']);
				/* YAML may hand this back as a boolean or as the word. */
				const flag = fm['is base characteristic'];
				const needsFlag = !(flag === true || flag === 'true');
				if (!needsType && !needsFlag) continue;

				const detail = [];
				if (needsType) {
					detail.push('property type — empty, so ' + name + ' counts as untyped and '
						+ 'sorts after everything else. Set to list.');
				}
				if (needsFlag) {
					detail.push('is base characteristic — set to true.');
				}

				actions.push({
					kind: 'describe-characteristic',
					label: 'Describe base characteristic "' + name + '" — '
						+ [needsType ? 'property type' : null, needsFlag ? 'is base characteristic' : null]
							.filter(Boolean).join(', '),
					file: characteristic.file,
					setType: needsType ? 'list' : null,
					setBaseFlag: needsFlag,
					detail: detail,
				});
				continue;
			}

			const byClasses = referencedBy.get(name) || [];
			const reason = isBase
				? 'A base characteristic, but it has no note of its own'
					+ (byClasses.length > 0 ? '; also listed by ' + byClasses.join(', ') : '') + '.'
				: 'Listed as a characteristic of ' + byClasses.join(', ')
					+ ', but has no note of its own.';

			actions.push({
				kind: 'create-characteristic',
				label: 'Create characteristic note "' + name + '"',
				path: this.characteristicPath(name),
				name: name,
				/* A base characteristic is a list of links; anything else is his to say. */
				propertyType: isBase ? 'list' : '',
				isBase: isBase,
				detail: [
					reason,
					isBase
						? 'Created with property type: list, since the base characteristics '
							+ 'hold links. Ready for a meaning.'
						: 'Created empty, ready for a meaning and a property type.',
				],
			});
		}

		/*
		 * 1a. Characteristic notes whose file name is missing the prefix.
		 *
		 * Renamed through `fileManager.renameFile`, so **Obsidian** rewrites every
		 * `[[domain]]` pointing at it - the class notes that list it, and anything
		 * of his own that happens to link to one. Nothing here edits a link.
		 */
		/*
		 * Two notes in the folder whose names reduce to one characteristic -
		 * `domain.md` beside `∘ domain.md`, a migration stopped halfway. Only one
		 * of them is ever used, so this is reported before anything is renamed
		 * over the other.
		 */
		const claims = new Map();
		for (const file of this.filesIn(this.settings.characteristicsFolder)) {
			const name = stripPrefix(file.basename, this.settings.characteristicPrefix);
			if (!claims.has(name)) claims.set(name, []);
			claims.get(name).push(file);
		}
		for (const [name, files] of claims) {
			if (files.length < 2) continue;
			const names = files.map((f) => f.basename);
			conflicts.push({
				file: files[0],
				property: name,
				value: names.join(', '),
				reason: names.join(' and ') + ' both describe the characteristic "' + name
					+ '". Only one of them is used — keep one, or give them different names.',
			});
		}

		for (const characteristic of characteristics.values()) {
			if (!characteristic.file) continue;
			const wanted = this.characteristicFileName(characteristic.name);
			if (characteristic.file.basename === wanted) continue;

			const target = this.settings.characteristicsFolder + '/' + wanted + '.md';
			/* Reported just above as a duplicate; renaming would destroy the other. */
			if (this.fileAt(target)) continue;

			const links = this.linksTo(characteristic.file);
			actions.push({
				kind: 'rename-characteristic',
				label: 'Rename characteristic "' + characteristic.file.basename
					+ '" → "' + wanted + '"',
				file: characteristic.file,
				path: characteristic.file.path,
				target: target,
				name: characteristic.name,
				detail: [
					'The prefix "' + String(this.settings.characteristicPrefix).trim()
						+ '" marks a characteristic note, the way • marks a name.',
					links === 0
						? 'Nothing links to it yet.'
						: 'Obsidian rewrites the ' + links + ' link'
							+ (links === 1 ? '' : 's') + ' to it.',
					'The property stays "' + characteristic.name
						+ '" — the prefix belongs to the file name, not to the property.',
				],
			});
		}

		/* 1b. Obsidian's property-type registry, made to follow the notes */
		const typeChanges = this.registryDisagreements(characteristics);
		if (typeChanges.length > 0) {
			actions.push({
				kind: 'register-types',
				label: 'Register property types — ' + typeChanges.length + ' propert'
					+ (typeChanges.length === 1 ? 'y' : 'ies'),
				path: this.typesPath(),
				changes: typeChanges,
				detail: [
					'Obsidian keeps its own type per property; the characteristic notes '
						+ 'are the truth, so the registry is brought into line.',
				].concat(typeChanges.map((change) => change.property + ' — '
					+ (change.from ? change.from + '  →  ' + change.to
						: 'not registered, set to ' + change.to))),
			});
		}

		/* 1b. characteristic notes nothing refers to any more */
		if (this.settings.deleteUnusedCharacteristics) {
			for (const action of this.unusedCharacteristicActions(characteristics, drafts)) {
				actions.push(action);
			}
		}

		/* 2. the class notes themselves */
		for (const [name, draft] of drafts) {
			const object = this.vaultStateOf(name, objects);

			/*
			 * What each base characteristic should say once written: exactly
			 * what the panel shows, with nothing added on his behalf.
			 */
			const wanted = {};
			for (const property of this.settings.logicProperties) {
				wanted[property] = (draft.values[property] || []).slice();
			}

			if (!object.file) {
				/*
				 * A class with no note is one of two very different things, and
				 * they used to be treated alike:
				 *
				 *   he asked for it in the panel   -> a draft; create the note
				 *   only a `type of` names it      -> a dangling link, very likely
				 *                                     a typo; NOT his to guess
				 *
				 * Creating the second silently turns `type of: "[[Persson]]"` into
				 * a real class called Persson. It is an insolvable discrepancy now
				 * instead — see `structuralDiscrepancies`.
				 */
				if (!this.drafts.has(name)) continue;

				const declared = this.settings.logicProperties
					.filter((property) => wanted[property].length > 0)
					.map((property) => property + ': ' + wanted[property].join(', '));

				actions.push({
					kind: 'create-class',
					label: 'Create class note "' + name + '"',
					path: this.settings.notesFolder + '/' + name + '.md',
					name: name,
					values: wanted,
					write: this.settings.logicProperties.slice(),
					addTag: this.settings.classTag,
					detail: [
						'Named as a class, but no note exists for it yet.',
						'Tagged #' + this.settings.classTag + '.',
					].concat(declared.length > 0
						? declared
						: ['Created with the base characteristics, all empty.']),
				});
				continue;
			}

			const stored = object.values || this.emptyLogicValues();
			const present = object.present || new Set();

			/*
			 * A class is brought into line when a value has changed *or* when
			 * it is missing a base characteristic altogether - the panel says
			 * every class carries all of them, so a note that does not is out
			 * of step even if nobody edited it.
			 */
			const missing = this.settings.logicProperties.filter((p) => !present.has(p));
			const changed = this.settings.logicProperties.filter(
				(property) => present.has(property)
					&& !sameNameList(wanted[property], stored[property] || []));

			const write = this.settings.logicProperties.filter(
				(property) => missing.includes(property) || changed.includes(property));

			/*
			 * A base characteristic he has removed from the list leaves an orphan
			 * key behind. Same rule as an instance: an empty one goes, one with a
			 * value is reported rather than deleted.
			 */
			const retired = toArray(this.settings.retiredLogicProperties)
				.filter((property) => object.keys.has(property));
			const dropped = retired.filter(
				(property) => isEmptyValue(object.frontmatter[property]));

			for (const property of retired) {
				if (dropped.includes(property)) continue;
				conflicts.push({
					file: object.file,
					property: property,
					value: object.frontmatter[property],
					reason: 'No longer a base characteristic, but it holds a value. '
						+ 'Left untouched.',
				});
			}

			/*
			 * What a class note itself should carry, by inheritance: the base
			 * characteristics, plus the characteristics of whatever its own
			 * `is a` names. Its `characteristics` list describes what its
			 * *instances* carry - those properties do not belong on the class.
			 *
			 * Most classes have an empty `is a`, so most of them should carry no
			 * ordinary characteristics at all. The ones they do carry are
			 * leftovers from when templates put every property everywhere.
			 */
			const ownClasses = (draft.values[this.settings.isAProperty] || [])
				.filter((className) => drafts.has(className));
			const inherited = [];
			const seenInherited = new Set();
			for (const className of ownClasses) {
				for (const characteristic of this.effectiveCharacteristics(className, objects, drafts)) {
					if (seenInherited.has(characteristic)) continue;
					seenInherited.add(characteristic);
					inherited.push(characteristic);
				}
			}

			const foreignToClass = Array.from(object.keys).filter((key) => {
				if (this.settings.logicProperties.includes(key)) return false;
				if (retired.includes(key)) return false;
				if (!characteristics.has(key)) return false;
				return !seenInherited.has(key);
			});

			/*
			 * And keys nothing accounts for at all - not a characteristic of
			 * anything, anywhere. `foreignToClass` above catches a real
			 * characteristic on the wrong note; this catches a field that simply
			 * should not exist.
			 */
			const unclaimed = this.unclaimedKeys(
				object.frontmatter, inherited, characteristics);

			const shedEmpty = foreignToClass.concat(unclaimed).filter(
				(key) => isEmptyValue(object.frontmatter[key]));

			for (const key of unclaimed) {
				if (shedEmpty.includes(key)) continue;
				conflicts.push({
					file: object.file,
					property: key,
					value: object.frontmatter[key],
					reason: 'Nothing declares this: no characteristic note defines it and '
						+ name + ' does not carry it. It holds a value, so it is left '
						+ 'alone — give it a characteristic note, or remove it.',
				});
			}

			for (const key of foreignToClass) {
				if (shedEmpty.includes(key)) continue;
				conflicts.push({
					file: object.file,
					property: key,
					value: object.frontmatter[key],
					reason: 'A characteristic of ' + name + '\'s instances, not of ' + name
						+ ' itself, but it holds a value here. Left untouched.',
				});
			}

			const gained = inherited.filter((key) => !object.keys.has(key));

			/*
			 * The order the properties end up in is part of complying, not a
			 * cosmetic afterthought - so it is checked here like everything else.
			 */
			const keysAfter = Array.from(object.keys)
				.filter((key) => !dropped.includes(key) && !shedEmpty.includes(key))
				.concat(missing.filter((key) => !object.keys.has(key)))
				.concat(gained);
			const managedAfter = keysAfter.filter(
				(key) => this.isManagedProperty(key, characteristics));
			const canonical = this.canonicalOrder(managedAfter, characteristics);
			const misordered = !sameNameList(managedAfter, canonical);

			/* Every class says so with the tag. */
			const needsTag = !!this.settings.classTag && !object.tagged;

			if (write.length > 0 || dropped.length > 0 || misordered || needsTag
				|| shedEmpty.length > 0 || gained.length > 0) {
				const described = write.map(
					(property) => (missing.includes(property) ? property + ' (missing)' : property));

				const show = (list) => (list.length > 0 ? list.join(', ') : 'empty');
				const detail = write.map((property) => {
					if (missing.includes(property)) {
						return property + ' — the note does not have this property; added, '
							+ (wanted[property].length > 0
								? 'set to ' + wanted[property].join(', ')
								: 'left empty');
					}
					return property + ' — ' + show(stored[property] || [])
						+ '  →  ' + show(wanted[property]);
				});

				for (const property of dropped) {
					described.push(property + ' (retired)');
					detail.push(property + ' — no longer a base characteristic, and empty '
						+ 'here, so the property is removed.');
				}

				const shedUnclaimed = shedEmpty.filter((key) => unclaimed.includes(key));
				if (shedUnclaimed.length > 0) {
					detail.push('Remove: ' + shedUnclaimed.join(', ')
						+ ' — nothing declares this, and it is empty here.');
				}

				if (shedEmpty.length > 0) {
					described.push(shedEmpty.length + ' not inherited');
					detail.push('Remove: ' + shedEmpty.join(', ')
						+ ' — ' + (ownClasses.length > 0
							? 'not carried by ' + ownClasses.join(', ') + ', which is what '
								+ name + ' is a'
							: name + ' is not an instance of anything, so it inherits no '
								+ 'characteristics') + '. These belong to its instances, and '
						+ 'are empty here.');
				}

				if (gained.length > 0) {
					described.push(gained.length + ' inherited');
					detail.push('Add, empty: ' + gained.join(', ')
						+ ' — carried by ' + ownClasses.join(', ') + '.');
				}

				if (needsTag) {
					described.push('#' + this.settings.classTag);
					detail.push('Tagged #' + this.settings.classTag
						+ ' — this note is a class, and says so.');
				}

				if (misordered) {
					described.push('order');
					detail.push('Properties reordered by type then name: ' + canonical.join(', '));
				}

				actions.push({
					kind: 'update-class',
					label: 'Update class "' + name + '" — ' + described.join(', '),
					file: object.file,
					values: wanted,
					write: write,
					remove: dropped.concat(shedEmpty),
					add: gained,
					missing: missing,
					addTag: needsTag ? this.settings.classTag : null,
					order: misordered ? canonical : null,
					managed: managedAfter,
					detail: detail,
				});
			}
		}

		/* 3. one template per class, carrying the flattened characteristics */
		for (const [name, draft] of drafts) {
			const expected = this.effectiveCharacteristics(name, objects, drafts);
			const path = this.templatePathFor(name);
			const file = this.app.vault.getFileByPath(path);
			const current = file instanceof TFile ? this.frontmatterOf(file) : null;

			/*
			 * A base characteristic belongs in a template only when it is being
			 * given a value. For an instance template that is `is a`, and
			 * nothing else: a new note is not a class, so `characteristics` and
			 * `type of` would be blank, and blank base characteristics are not
			 * written. The ordinary characteristics follow, empty, ready to fill.
			 */
			const wantedKeys = this.canonicalOrder(
				[this.settings.isAProperty].concat(
					expected.filter((c) => c !== this.settings.isAProperty)),
				characteristics);

			/*
			 * Only keys with a characteristic note behind them, or that are base
			 * characteristics, are ours. Anything else in a template - his
			 * Templater `created:` line, say - is his, so it is neither compared
			 * against nor overwritten.
			 */
			const managed = (key) => characteristics.has(key)
				|| wantedKeys.includes(key);
			const currentKeys = current
				? Object.keys(current).filter(managed)
				: null;

			/*
			 * Everything else the template carries. This used to be filtered away
			 * and forgotten, which meant any field at all could be added to a
			 * template and nothing would ever say so - the one place in the vault
			 * the plugin was not actually checking.
			 *
			 * A template is the shape of an instance, and its shape is the class's
			 * to decide, so a key no characteristic claims does not belong. Same
			 * rule as everywhere else about *how* it goes: empty is removed, and
			 * anything holding a value is reported rather than touched.
			 */
			const stray = current
				? Object.keys(current).filter((key) =>
					!managed(key) && !isTemplaterExpression(current[key]))
				: [];
			const strayEmpty = stray.filter((key) => isEmptyValue(current[key]));
			const strayFilled = stray.filter((key) => !isEmptyValue(current[key]));

			for (const key of strayFilled) {
				conflicts.push({
					file: file,
					property: key,
					value: current[key],
					reason: 'Not a characteristic of ' + name + ', and not a Templater '
						+ 'expression, but it holds a value. Left untouched — give it a '
						+ 'characteristic note, or remove it.',
				});
			}

			if (currentKeys && sameNameList(wantedKeys, currentKeys)
				&& strayEmpty.length === 0
				&& toArray(current[this.settings.isAProperty]).map(linkName)[0] === name) {
				continue;
			}

			const detail = [
				'Gives a new ' + name + ' every property an instance of it carries.',
				'Properties, by type then name: ' + wantedKeys.join(', '),
				'Only ' + this.settings.isAProperty + ' is carried over from the base '
					+ 'characteristics, because it is the only one with a value here.',
			];
			if (file) {
				detail.push('A Templater expression already in this template is left '
					+ 'exactly as it is.');
			}
			if (strayEmpty.length > 0) {
				detail.push('Remove: ' + strayEmpty.join(', ') + ' — not a characteristic of '
					+ name + ', and empty here.');
			}

			actions.push({
				kind: 'write-template',
				label: (file ? 'Rewrite' : 'Create') + ' template for "' + name + '"',
				path: path,
				file: file instanceof TFile ? file : null,
				object: name,
				properties: wantedKeys,
				/* What apply() is allowed to clear before laying the properties out. */
				managed: Array.from(characteristics.keys()).concat(wantedKeys),
				/* Keys that belong to nothing, and are empty, so nothing is lost. */
				remove: strayEmpty,
				types: expected.map((c) => (characteristics.get(c) || {}).propertyType || ''),
				detail: detail,
			});
		}

		/*
		 * 3b. one .base per class, listing its instances.
		 *
		 * Created once and then left alone - unlike templates, which are
		 * regenerated to stay in step. A base is a starting point he goes on to
		 * edit (adding views, sorts, group-bys), so rewriting it would throw
		 * that work away. An existing base is never touched, however stale.
		 */
		if (this.settings.createBases) {
			for (const name of drafts.keys()) {
				const path = this.basePathFor(name);
				const exists = !!this.app.vault.getFileByPath(path);
				const requested = this.baseRefreshes.has(name);

				/* Existing and not asked about: his, and left alone. */
				if (exists && !requested) continue;

				const columns = this.baseColumnsFor(name, objects, drafts);
				const detail = [];
				if (exists) {
					detail.push('You asked for this base to be refreshed, so it is rebuilt '
						+ 'from scratch. Any views, sorts or filters you added are lost.');
				}
				detail.push('Table of everything that is a ' + name
					+ ', templates excluded.');
				detail.push(columns.length > 0
					? 'Columns: file.name, ' + columns.join(', ')
					: 'Only file.name, since ' + name + ' has no characteristics yet.');
				if (!exists) {
					detail.push('Created once — from then on it is yours, and Update leaves it alone.');
				}

				actions.push({
					kind: 'write-base',
					label: exists
						? 'Rewrite base for "' + name + '" — replaces your edits'
						: 'Create base for "' + name + '"',
					path: path,
					object: name,
					content: this.baseContentFor(name, objects, drafts),
					/* Only a refresh he asked for may overwrite. */
					overwrite: exists && requested,
					detail: detail,
				});
			}
		}

		/* 4. existing instances, brought in line retroactively */
		for (const instance of instances) {
			const expected = [];
			const seen = new Set();
			for (const className of instance.classes) {
				for (const characteristic of this.effectiveCharacteristics(className, objects, drafts)) {
					if (seen.has(characteristic)) continue;
					seen.add(characteristic);
					expected.push(characteristic);
				}
			}

			const present = Object.keys(instance.frontmatter);
			const missing = expected.filter((key) => !present.includes(key));

			/* Anything the class no longer declares, that this note still has. */
			const managed = new Set(expected);
			const stale = present.filter((key) => {
				if (managed.has(key)) return false;
				if (key === this.settings.isAProperty) return false;
				if (key === this.settings.inheritsProperty) return false;
				return this.isManagedElsewhere(key, characteristics);
			});

			/*
			 * A note that is not a class carries a base characteristic only when
			 * it has something to say with it. Blank ones are cleared out.
			 */
			const blankBase = this.settings.logicProperties.filter(
				(property) => (property in instance.frontmatter)
					&& isEmptyValue(instance.frontmatter[property]));

			/*
			 * Fields nothing accounts for. Empty ones join the removals; ones
			 * holding a value are reported instead, the same rule as everywhere
			 * else - a value he typed is his, even when it belongs nowhere.
			 */
			const unclaimed = this.unclaimedKeys(instance.frontmatter, expected, characteristics);
			for (const key of unclaimed.filter((k) => !isEmptyValue(instance.frontmatter[k]))) {
				conflicts.push({
					file: instance.file,
					property: key,
					value: instance.frontmatter[key],
					reason: 'Nothing declares this: ' + instance.classes.join(', ')
						+ ' does not carry it, and no characteristic note defines it. It '
						+ 'holds a value, so it is left alone — add it to '
						+ instance.classes.join(' or ') + ', or remove it.',
				});
			}

			const removable = stale.filter((key) => isEmptyValue(instance.frontmatter[key]))
				.concat(unclaimed.filter((key) => isEmptyValue(instance.frontmatter[key])))
				.concat(blankBase.filter((key) => !stale.includes(key)));
			const populated = stale.filter((key) => !isEmptyValue(instance.frontmatter[key]));

			for (const key of populated) {
				conflicts.push({
					file: instance.file,
					property: key,
					value: instance.frontmatter[key],
					reason: 'No longer a characteristic of ' + instance.classes.join(', ')
						+ ', but it holds a value. Left untouched.',
				});
			}

			/* Same check as for objects: the layout is part of being in step. */
			const keysAfter = present
				.filter((key) => !removable.includes(key))
				.concat(missing.filter((key) => !present.includes(key)));
			const managedAfter = keysAfter.filter(
				(key) => this.isManagedProperty(key, characteristics));
			const canonical = this.canonicalOrder(managedAfter, characteristics);
			const misordered = !sameNameList(managedAfter, canonical);

			if (missing.length === 0 && removable.length === 0 && !misordered) continue;

			const detail = [];
			if (missing.length > 0) {
				detail.push('Add, empty: ' + missing.join(', ')
					+ ' — carried by ' + instance.classes.join(', ') + '.');
			}
			if (removable.length > 0) {
				const base = removable.filter((key) => blankBase.includes(key));
				const stray = removable.filter((key) => unclaimed.includes(key));
				const rest = removable.filter(
					(key) => !blankBase.includes(key) && !unclaimed.includes(key));
				if (rest.length > 0) {
					detail.push('Remove: ' + rest.join(', ')
						+ ' — no longer a characteristic of ' + instance.classes.join(', ')
						+ ', and empty here.');
				}
				/* Never a characteristic at all, which is a different sentence. */
				if (stray.length > 0) {
					detail.push('Remove: ' + stray.join(', ')
						+ ' — nothing declares this, and it is empty here.');
				}
				if (base.length > 0) {
					detail.push('Remove: ' + base.join(', ')
						+ ' — a blank base characteristic on a note that is not a class.');
				}
			}

			if (misordered) {
				detail.push('Properties reordered by type then name: ' + canonical.join(', '));
			}

			actions.push({
				kind: 'update-instance',
				label: 'Update instance "' + instance.file.basename + '"'
					+ (missing.length ? ' (+' + missing.length + ')' : '')
					+ (removable.length ? ' (−' + removable.length + ')' : '')
					+ (misordered ? ' (order)' : ''),
				file: instance.file,
				add: missing,
				remove: removable,
				order: misordered ? canonical : null,
				managed: managedAfter,
				detail: detail,
			});
		}

		/*
		 * Values a characteristic does not permit. Reported, never fixed - the
		 * plugin has no business choosing a different value than the one he
		 * typed.
		 */
		for (const complaint of this.valueDiscrepancies({
			characteristics: characteristics,
			classes: objects,
			instances: new Map(instances.map((i) => [i.file.path, {
				file: i.file, keys: new Set(Object.keys(i.frontmatter)), values: i.frontmatter,
			}])),
		})) {
			conflicts.push(complaint);
		}

		return { actions: actions, conflicts: conflicts, objects: objects, characteristics: characteristics };
	}

	/*
	 * Characteristic notes that nothing refers to any more.
	 *
	 * This is the only thing the plugin removes a whole file for, so "unused"
	 * is deliberately strict. A characteristic is still in use if:
	 *
	 *   - it is a base characteristic, or one being retired
	 *   - any class lists it (drafts included, so an edit counts before Update)
	 *   - any note still carries it as a property **with a value** - the class
	 *     may have dropped it while the data is still there
	 *   - anything links to it from outside the characteristics folder
	 *
	 * Only when all four are false is it offered for the trash.
	 */
	unusedCharacteristicActions(characteristics, drafts) {
		const used = new Set();

		for (const property of this.settings.logicProperties) used.add(property);
		for (const property of toArray(this.settings.retiredLogicProperties)) used.add(property);
		for (const draft of drafts.values()) {
			for (const characteristic of draft.characteristics) used.add(characteristic);
		}

		/* Still carried, with a value, by some note somewhere. */
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.inFolder(file, this.settings.characteristicsFolder)) continue;
			const fm = this.frontmatterOf(file);
			if (!fm) continue;
			for (const key of Object.keys(fm)) {
				if (!isEmptyValue(fm[key])) used.add(key);
			}
		}

		const linkedFrom = this.charactisticBacklinks();

		const actions = [];
		for (const [name, characteristic] of characteristics) {
			if (used.has(name)) continue;

			const sources = linkedFrom.get(characteristic.file.path) || [];
			if (sources.length > 0) {
				/* Something points at it. Say so rather than deleting quietly. */
				actions.push({
					kind: 'keep-characteristic',
					label: 'Keep "' + name + '" — unused, but still linked',
					file: characteristic.file,
					path: characteristic.file.path,
					detail: [
						'No class lists it, but ' + sources.length + ' note'
							+ (sources.length === 1 ? '' : 's') + ' still link'
							+ (sources.length === 1 ? 's' : '') + ' to it: '
							+ sources.slice(0, 3).join(', ')
							+ (sources.length > 3 ? ', …' : '') + '.',
						'Left alone. Remove those links if you want it gone.',
					],
				});
				continue;
			}

			actions.push({
				kind: 'trash-characteristic',
				label: 'Trash characteristic note "' + name + '"',
				file: characteristic.file,
				path: characteristic.file.path,
				detail: [
					'No class lists it, no note carries it as a property, and nothing '
						+ 'links to it.',
					'Sent to Obsidian\'s trash, not deleted outright — recoverable if '
						+ 'this is wrong.',
				],
			});
		}

		return actions;
	}

	/*
	 * Which notes link to each characteristic, ignoring the classes that list
	 * them (those are the usage we already account for) and the characteristics
	 * folder itself.
	 */
	/* Anything at all at this path — a note, or a folder. */
	fileAt(path) {
		if (typeof this.app.vault.getAbstractFileByPath === 'function') {
			return this.app.vault.getAbstractFileByPath(path) || null;
		}
		return this.app.vault.getFileByPath(path) || null;
	}

	/* How many notes link to this file — for saying what a rename will touch. */
	linksTo(file) {
		const resolved = this.app.metadataCache && this.app.metadataCache.resolvedLinks;
		if (!resolved) return 0;

		let count = 0;
		for (const source of Object.keys(resolved)) {
			if (source === file.path) continue;
			if ((resolved[source] || {})[file.path]) count += 1;
		}
		return count;
	}

	charactisticBacklinks() {
		const links = new Map();
		const resolved = this.app.metadataCache && this.app.metadataCache.resolvedLinks;
		if (!resolved) return links;

		for (const source of Object.keys(resolved)) {
			if (this.inFolder({ path: source, name: source.split('/').pop() },
				this.settings.characteristicsFolder)) continue;

			const file = this.app.vault.getFileByPath(source);
			if (file && this.isClassNote(file)) continue;

			for (const target of Object.keys(resolved[source] || {})) {
				if (!links.has(target)) links.set(target, []);
				links.get(target).push(source);
			}
		}
		return links;
	}

	/* Does this note behave like a class? Used to discount a class's own links. */
	isClassNote(file) {
		if (this.hasClassTag(file)) return true;
		const fm = this.frontmatterOf(file);
		if (!fm) return false;
		const values = this.readLogicValues(fm);
		return (values[this.settings.characteristicsProperty] || []).length > 0
			|| (values[this.settings.inheritsProperty] || []).length > 0;
	}

	/*
	 * A property is ours to tidy only when a characteristic note exists for it;
	 * anything else in an instance's frontmatter belongs to him, not the plugin.
	 */
	isManagedElsewhere(key, characteristics) {
		return characteristics.has(key);
	}

	/*
	 * A property the class system has no opinion about: Obsidian's own, his
	 * template machinery, or anything he has added to the ignore list. Never
	 * flagged, never removed.
	 */
	isIgnoredProperty(key) {
		/*
		 * A list in `data.json`, but a comma-separated string once he has edited
		 * it in the settings tab, because that field is a text box. Both shapes
		 * are read, so editing it cannot quietly turn the whole list into one
		 * entry that matches nothing.
		 */
		const raw = this.settings.ignoredProperties;
		const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
		const wanted = String(key).toLowerCase();
		return list.some((ignored) => String(ignored).trim().toLowerCase() === wanted);
	}

	/*
	 * Keys on a note that nothing accounts for: not declared by its classes, not
	 * a base characteristic, not a characteristic note anywhere, not ignored, and
	 * not a Templater expression.
	 *
	 * This is the same hole templates had. `isManagedElsewhere` answers "does a
	 * characteristic note claim this?", and a key nothing claims used to fall
	 * straight through every filter - so any field at all could be added to a
	 * note and nothing would say so.
	 */
	unclaimedKeys(frontmatter, expected, characteristics) {
		const declared = new Set(toArray(expected));
		return Object.keys(frontmatter).filter((key) => {
			if (declared.has(key)) return false;
			if (this.settings.logicProperties.includes(key)) return false;
			if (toArray(this.settings.retiredLogicProperties).includes(key)) return false;
			if (this.isIgnoredProperty(key)) return false;
			if (isTemplaterExpression(frontmatter[key])) return false;
			/*
			 * A key some characteristic note *does* define is a different problem -
			 * the class dropped it, or it belongs to another class - and the pass
			 * that handles that already owns it. Counting it here as well put it
			 * in the removal list twice.
			 */
			if (characteristics && characteristics.has(key)) return false;
			return true;
		});
	}

	/* ----------------------------------------------------------- applying -- */

	/* ----- discrepancies ----------------------------------------------------
	 *
	 * His three steps: build the picture, handle the discrepancies, then update.
	 * This is step two, and it is deliberately the *only* description of what
	 * "wrong" means - step three works by making an edit and then letting this
	 * pass clean up after it.
	 *
	 * Two severities, his words:
	 *
	 *   solvable    the plugin knows the fix and will apply it
	 *   insolvable  it needs him; the plugin only names it
	 *
	 * `buildPlan()` is left as the engine underneath rather than rewritten,
	 * because its actions and conflicts already *are* those two sets - an action
	 * is a discrepancy with a fix attached, a conflict is one without. What is
	 * new is that they are named as one thing, surfaced in the panel, and that
	 * updating is gated on them.
	 */
	findDiscrepancies() {
		const plan = this.buildPlan();
		const found = [];

		for (const action of plan.actions) {
			found.push({
				severity: 'solvable',
				kind: action.kind,
				subject: action.object || action.name
					|| (action.file && action.file.basename) || action.path || '',
				label: action.label,
				file: action.file || null,
				path: action.path || (action.file && action.file.path) || '',
				detail: action.detail || [],
				fix: action,
			});
		}

		for (const conflict of plan.conflicts) {
			found.push({
				severity: 'insolvable',
				kind: 'conflict',
				subject: conflict.file ? conflict.file.basename : '',
				label: (conflict.file ? conflict.file.basename + ' · ' : '') + conflict.property,
				file: conflict.file || null,
				path: conflict.file ? conflict.file.path : '',
				detail: [conflict.reason],
				fix: null,
			});
		}

		for (const structural of this.structuralDiscrepancies()) found.push(structural);

		const dismissed = this.dismissed;
		const live = found.filter((d) => !dismissed.has(discrepancyId(d)));

		return {
			all: found,
			solvable: live.filter((d) => d.severity === 'solvable'),
			insolvable: live.filter((d) => d.severity === 'insolvable'),
			dismissed: found.filter((d) => dismissed.has(discrepancyId(d))),
			plan: plan,
		};
	}

	/*
	 * The ones that are about the shape of the graph rather than about any one
	 * note's frontmatter, and that `buildPlan` has no reason to look for because
	 * none of them has a fix. All insolvable: every one of them is a question
	 * only he can answer.
	 */
	structuralDiscrepancies() {
		const picture = this.picture();
		const found = [];

		/* A link naming nothing. Silently ignored before, which hid typos. */
		for (const note of picture.notes.values()) {
			for (const target of note.classes) {
				if (picture.classes.has(target)) continue;
				found.push({
					severity: 'insolvable',
					kind: 'dangling-is-a',
					subject: note.name,
					label: '"' + note.name + '" is a "' + target + '", which does not exist',
					file: note.file,
					path: note.file.path,
					detail: [
						'Nothing in the vault is named "' + target + '", so this note '
							+ 'inherits nothing from it.',
						'Either create it as a class, or correct the link — the plugin will '
							+ 'not invent a class from a name.',
					],
					fix: null,
				});
			}

			for (const target of note.parents) {
				const known = picture.classes.get(target);
				/* A class he drafted has no note *yet*, which is not the same thing. */
				if (known && (known.file || this.drafts.has(target))) continue;
				found.push({
					severity: 'insolvable',
					kind: 'dangling-type-of',
					subject: note.name,
					label: '"' + note.name + '" is a type of "' + target + '", which does not exist',
					file: note.file,
					path: note.file.path,
					detail: [
						'Nothing in the vault is named "' + target + '", so this class '
							+ 'inherits no characteristics through it.',
						'Either create it as a class, or correct the link.',
					],
					fix: null,
				});
			}
		}

		/* A class that is its own ancestor: inheritance would never terminate. */
		for (const name of this.parentCycles(picture)) {
			found.push({
				severity: 'insolvable',
				kind: 'type-of-cycle',
				subject: name,
				label: '"' + name + '" is a type of itself, through its parents',
				file: (picture.classes.get(name) || {}).file || null,
				path: ((picture.classes.get(name) || {}).file || {}).path || '',
				detail: [
					'Following `' + this.settings.inheritsProperty + '` from "' + name
						+ '" leads back to "' + name + '".',
					'Nothing can be inherited safely around a cycle, so this is left '
						+ 'alone. Break the loop by removing one parent.',
				],
				fix: null,
			});
		}

		/* Obsidian resolves links case-insensitively, so these are one name to it. */
		const byLower = new Map();
		for (const name of picture.classes.keys()) {
			const key = String(name).toLowerCase();
			if (!byLower.has(key)) byLower.set(key, []);
			byLower.get(key).push(name);
		}
		for (const [, names] of byLower) {
			if (names.length < 2) continue;
			found.push({
				severity: 'insolvable',
				kind: 'case-clash',
				subject: names[0],
				label: names.join(' and ') + ' differ only by case',
				file: (picture.classes.get(names[0]) || {}).file || null,
				path: ((picture.classes.get(names[0]) || {}).file || {}).path || '',
				detail: [
					'Obsidian resolves links case-insensitively, so a `[['
						+ names[0] + ']]` may reach either of them.',
					'Rename one of them.',
				],
				fix: null,
			});
		}

		return found;
	}

	/* Which classes sit on a `type of` cycle. */
	parentCycles(picture) {
		const onCycle = new Set();

		for (const start of picture.classes.keys()) {
			const seen = new Set([start]);
			let frontier = [start];
			let depth = 0;

			while (frontier.length > 0 && depth < MAX_DEPTH) {
				const next = [];
				for (const name of frontier) {
					const klass = picture.classes.get(name);
					if (!klass) continue;
					for (const parent of klass.parents || []) {
						if (parent === start) { onCycle.add(start); frontier = []; break; }
						if (seen.has(parent)) continue;
						seen.add(parent);
						next.push(parent);
					}
					if (onCycle.has(start)) break;
				}
				if (onCycle.has(start)) break;
				frontier = next;
				depth += 1;
			}
		}

		return Array.from(onCycle);
	}

	/* An insolvable one he has looked at and chosen to live with. */
	async toggleDismissed(discrepancy) {
		const id = discrepancyId(discrepancy);
		if (this.dismissed.has(id)) this.dismissed.delete(id);
		else this.dismissed.add(id);
		await this.persist();
	}

	async applyPlan(plan) {
		let written = 0;

		for (const action of plan.actions) {
			try {
				await this.applyAction(action);
				written++;
			} catch (error) {
				console.error('oof-classes: failed to apply', action, error);
				new Notice('OOF Classes: "' + action.label + '" failed — see the console.', 8000);
			}
		}

		/* Applied intentions are no longer pending, on disk as well as in memory. */
		this.drafts.clear();
		this.baseRefreshes.clear();
		await this.persist();
		return written;
	}

	/*
	 * Step three, his way: make the edit, then let step two clean up after it.
	 *
	 * The first pass writes his intentions onto the class notes *and* everything
	 * that already followed from them. Later passes exist because a fix can
	 * create work of its own - creating a characteristic note makes a note whose
	 * `property type` is then missing; creating a class note makes a class whose
	 * template does not exist yet. Repeating until nothing is left is what makes
	 * "the vault is correct" mean "no solvable discrepancies remain", rather
	 * than "the last plan was applied".
	 *
	 * Capped, because a fix that recreates its own discrepancy would otherwise
	 * spin. Hitting the cap is a bug in a fix, and says so out loud.
	 */
	async converge(limit) {
		const passes = [];
		const cap = limit || 5;

		for (let pass = 0; pass < cap; pass += 1) {
			this.invalidatePicture();
			const found = this.findDiscrepancies();
			if (found.solvable.length === 0) {
				return { passes: passes, settled: true, applied: passes.flat() };
			}

			const applied = [];
			for (const discrepancy of found.solvable) {
				try {
					await this.applyAction(discrepancy.fix);
					applied.push(discrepancy);
				} catch (error) {
					console.error('oof-classes: failed to apply', discrepancy.fix, error);
					new Notice('OOF Classes: "' + discrepancy.label + '" failed — see the console.',
						8000);
				}
			}
			passes.push(applied);

			/* Nothing applied, but some remain: they cannot be applied at all. */
			if (applied.length === 0) break;
		}

		this.invalidatePicture();
		const remaining = this.findDiscrepancies().solvable.length;
		if (remaining > 0) {
			new Notice('OOF Classes: ' + remaining + ' discrepanc'
				+ (remaining === 1 ? 'y' : 'ies') + ' would not settle after ' + cap
				+ ' passes. Nothing further was written — see the console.', 10000);
			console.error('oof-classes: convergence did not settle',
				this.findDiscrepancies().solvable);
		}

		return { passes: passes, settled: remaining === 0, applied: passes.flat() };
	}

	/*
	 * What Update does now: write the intent and converge, in one go. The drafts
	 * are cleared once, at the end - they are spent whether the first pass or the
	 * third was the one that wrote them.
	 */
	async applyUpdate() {
		const result = await this.converge();
		this.drafts.clear();
		this.baseRefreshes.clear();
		this.invalidatePicture();
		await this.persist();
		return result;
	}

	async applyAction(action) {
		/*
		 * Obsidian's own events will invalidate this too, but not before the next
		 * line of the convergence loop runs. It must see what was just written.
		 */
		this.invalidatePicture();

		if (action.kind === 'create-characteristic') {
			await this.ensureFolder(this.settings.characteristicsFolder);
			/* The same four fields his Characteristic Template writes. */
			await this.app.vault.create(action.path,
				'---\ncharacteristic meaning: \nproperty type: ' + (action.propertyType || '')
				+ '\nis base characteristic: ' + (action.isBase ? 'true' : 'false')
				+ '\npossible values: \n---\n');
			return;
		}

		if (action.kind === 'rename-characteristic') {
			/*
			 * Through the file manager, never the adapter: this is the one call that
			 * rewrites every link pointing at the note, and doing it by hand is how
			 * links get broken.
			 */
			if (this.fileAt(action.target)) {
				new Notice('OOF Classes: "' + action.target + '" already exists, so "'
					+ action.file.basename + '" was left alone.', 8000);
				return;
			}
			await this.app.fileManager.renameFile(action.file, action.target);
			return;
		}

		if (action.kind === 'describe-characteristic') {
			await this.app.fileManager.processFrontMatter(action.file, (fm) => {
				if (action.setType) fm['property type'] = action.setType;
				if (action.setBaseFlag) fm['is base characteristic'] = true;
			});
			return;
		}

		if (action.kind === 'register-types') {
			/*
			 * Merge rather than replace: the registry also holds properties that
			 * are nothing to do with this plugin - `aliases`, `tags`, his own
			 * `created` - and those are not ours to drop.
			 */
			let current = {};
			try {
				const raw = await this.app.vault.adapter.read(action.path);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.types) current = parsed.types;
			} catch (error) {
				/* No registry yet. */
			}

			for (const change of action.changes) current[change.property] = change.to;

			await this.app.vault.adapter.write(action.path,
				JSON.stringify({ types: current }, null, 2));
			this.registeredTypes = current;
			return;
		}

		if (action.kind === 'keep-characteristic') {
			/* Reported in the plan so he can see it; nothing to do. */
			return;
		}

		if (action.kind === 'trash-characteristic') {
			/*
			 * Trash, never delete. `trashFile` honours his "Deleted files"
			 * setting, so it lands wherever he has told Obsidian to put things.
			 */
			const manager = this.app.fileManager;
			if (manager && typeof manager.trashFile === 'function') {
				await manager.trashFile(action.file);
			} else {
				await this.app.vault.trash(action.file, true);
			}
			return;
		}

		if (action.kind === 'create-class') {
			await this.ensureFolder(this.settings.notesFolder);
			const file = await this.app.vault.create(action.path, '---\n---\n');
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				this.writeLogicValues(fm, action);
				this.addTag(fm, action.addTag);
			});
			return;
		}

		if (action.kind === 'update-class') {
			await this.app.fileManager.processFrontMatter(action.file, (fm) => {
				this.writeLogicValues(fm, action);
				this.addTag(fm, action.addTag);
				this.applyOrder(fm, action);
			});
			return;
		}

		if (action.kind === 'write-template') {
			await this.ensureFolder(this.settings.templatesFolder);
			let file = action.file;
			if (!file) file = await this.app.vault.create(action.path, '---\n---\n');

			const managed = new Set(action.managed || []);
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				/*
				 * Drop only the keys we manage, then lay them out in inheritance
				 * order. Anything else in the template is his and stays put -
				 * a Templater expression in the frontmatter, most of all.
				 */
				const stray = new Set(action.remove || []);
				for (const key of Object.keys(fm)) {
					if (key === this.settings.isAProperty || managed.has(key)) delete fm[key];
					/* Empty, claimed by nothing, and not a Templater expression. */
					else if (stray.has(key) && !isTemplaterExpression(fm[key])) delete fm[key];
				}
				/* `properties` already opens with the base characteristics, in order. */
				for (const property of action.properties) {
					fm[property] = property === this.settings.isAProperty
						? [asLink(action.object)]
						: null;
				}
			});
			return;
		}

		if (action.kind === 'write-base') {
			const existing = this.app.vault.getFileByPath(action.path);

			/* An existing base is his; only a refresh he asked for replaces it. */
			if (existing && !action.overwrite) return;

			if (existing) {
				await this.app.vault.modify(existing, action.content);
			} else {
				await this.ensureFolder(this.settings.basesFolder);
				await this.app.vault.create(action.path, action.content);
			}

			this.baseRefreshes.delete(action.object);
			return;
		}

		if (action.kind === 'update-instance') {
			await this.app.fileManager.processFrontMatter(action.file, (fm) => {
				for (const key of action.add) if (!(key in fm)) fm[key] = null;
				for (const key of action.remove) delete fm[key];
				this.applyOrder(fm, action);
			});
			return;
		}
	}

	/*
	 * An empty base characteristic is written as an empty key rather than as
	 * `[]`, matching how his notes already look and keeping the diff quiet.
	 */
	writeLogicValues(frontmatter, action) {
		for (const property of action.write || []) {
			const values = action.values[property] || [];
			/* A characteristic is linked by its file name, prefix and all. */
			const link = property === this.settings.characteristicsProperty
				? (name) => asLink(this.characteristicFileName(name))
				: asLink;
			frontmatter[property] = values.length > 0 ? values.map(link) : null;
		}
		/* Characteristics this note inherits but does not yet carry. */
		for (const property of action.add || []) {
			if (!(property in frontmatter)) frontmatter[property] = null;
		}
		/* Retired base characteristics and uninherited ones — empty only. */
		for (const property of action.remove || []) delete frontmatter[property];
	}

	/*
	 * Rewrite a frontmatter object so its managed properties sit together in
	 * canonical order. Keys we do not manage keep their existing order and stay
	 * in front, so his own fields - a Templater `created:` line, `cover image` -
	 * are never shuffled around by us.
	 */
	/*
	 * Append the class tag to `tags`, whatever shape it is already in, without
	 * disturbing the tags he has put there himself.
	 */
	addTag(frontmatter, tag) {
		if (!tag) return;

		const bare = tag.replace(/^#/, '');
		const existing = toArray(frontmatter.tags)
			.filter((entry) => typeof entry === 'string');

		for (const entry of existing) {
			if (entry.replace(/^#/, '') === bare) return;
		}

		frontmatter.tags = existing.concat([bare]);
	}

	applyOrder(frontmatter, action) {
		if (!action.order) return;
		this.reorderFrontMatter(frontmatter, action.order, new Set(action.managed || action.order));
	}

	reorderFrontMatter(frontmatter, order, managed) {
		const snapshot = {};
		for (const key of Object.keys(frontmatter)) snapshot[key] = frontmatter[key];

		for (const key of Object.keys(frontmatter)) delete frontmatter[key];

		for (const key of Object.keys(snapshot)) {
			if (!managed.has(key)) frontmatter[key] = snapshot[key];
		}
		for (const key of order) {
			if (key in snapshot) frontmatter[key] = snapshot[key];
		}
	}

	async ensureFolder(path) {
		if (!path) return;
		if (this.app.vault.getFolderByPath(path)) return;
		try {
			await this.app.vault.createFolder(path);
		} catch (error) {
			/* Already there, or created by a parallel action. */
		}
	}

	/* ------------------------------------------------------------ renaming -- */

	/*
	 * Rename a class: its note, its generated template, its generated base, and
	 * any unapplied edits keyed by the old name.
	 *
	 * Every link in the vault is Obsidian's job, not ours — `renameFile` rewrites
	 * `[[Artist]]` everywhere it appears, which is exactly the hard part and the
	 * reason this is worth doing through the API rather than by hand. So a child
	 * class's `type of`, an instance's `is a` and the template's own `is a` all
	 * follow along without this plugin touching them.
	 *
	 * Unlike everything else here it happens immediately rather than through an
	 * Update plan: it is not destructive, Obsidian's own rename is immediate, and
	 * a rename left pending would leave the panel showing a name the vault does
	 * not have.
	 */
	async renameClass(oldName, newName) {
		const name = String(newName || '').trim();
		if (!name || name === oldName) return { ok: false, reason: 'unchanged' };

		if (/[\\/:]/.test(name)) {
			return { ok: false, reason: 'A name cannot contain \\ / or :.' };
		}

		const classes = this.scanClasses();
		if (classes.has(name) || this.drafts.has(name)) {
			return { ok: false, reason: 'There is already a class called "' + name + '".' };
		}

		const renamed = [];
		const klass = classes.get(oldName);

		if (klass && klass.file) {
			const target = this.settings.notesFolder + '/' + name + '.md';
			if (this.app.vault.getFileByPath(target)) {
				return { ok: false, reason: 'A note called "' + name + '" already exists.' };
			}
			await this.app.fileManager.renameFile(klass.file, target);
			renamed.push(target);
		}

		/* The generated files carry the class's name, so they follow it. */
		const template = this.app.vault.getFileByPath(this.templatePathFor(oldName));
		if (template) {
			const target = this.templatePathFor(name);
			if (!this.app.vault.getFileByPath(target)) {
				await this.app.fileManager.renameFile(template, target);
				renamed.push(target);
			}
		}

		const base = this.app.vault.getFileByPath(this.basePathFor(oldName));
		if (base) {
			const target = this.basePathFor(name);
			if (!this.app.vault.getFileByPath(target)) {
				await this.app.fileManager.renameFile(base, target);
				renamed.push(target);
			}
		}

		/* Carry any unapplied edits across, so a rename does not discard them. */
		if (this.drafts.has(oldName)) {
			this.drafts.set(name, this.drafts.get(oldName));
			this.drafts.delete(oldName);
		}
		if (this.baseRefreshes.has(oldName)) {
			this.baseRefreshes.delete(oldName);
			this.baseRefreshes.add(name);
		}
		await this.persist();

		return { ok: true, renamed: renamed };
	}

	/* What a rename would touch, for the confirmation. */
	renameTargets(name) {
		const targets = [];
		const klass = this.scanClasses().get(name);
		if (klass && klass.file) targets.push(klass.file.path);
		if (this.app.vault.getFileByPath(this.templatePathFor(name))) {
			targets.push(this.templatePathFor(name));
		}
		if (this.app.vault.getFileByPath(this.basePathFor(name))) {
			targets.push(this.basePathFor(name));
		}
		return targets;
	}

	/* --------------------------------------------------- creating instances */

	/*
	 * Templater owns note creation from a template. Its API has moved before, so
	 * a plain copy of the template's frontmatter is the fallback - the template
	 * is already correct by then, which is the point of the plugin.
	 */
	async createInstance(objectName, noteName, folder) {
		const templatePath = this.templatePathFor(objectName);
		const template = this.app.vault.getFileByPath(templatePath);
		if (!(template instanceof TFile)) {
			new Notice('OOF Classes: no template for "' + objectName + '" yet. Press Update first.', 6000);
			return null;
		}

		const targetFolder = folder || this.settings.notesFolder;
		await this.ensureFolder(targetFolder);

		const templater = this.app.plugins.plugins['templater-obsidian'];
		const engine = templater && templater.templater;
		if (engine && typeof engine.create_new_note_from_template === 'function') {
			try {
				const folderObject = this.app.vault.getFolderByPath(targetFolder);
				return await engine.create_new_note_from_template(template, folderObject, noteName, true);
			} catch (error) {
				console.error('oof-classes: Templater refused, copying the template instead', error);
			}
		}

		const path = targetFolder + '/' + noteName + '.md';
		const content = await this.app.vault.read(template);
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf(true).openFile(file);
		return file;
	}

	/* ------------------------------------------------------------ settings -- */

	/*
	 * Drafts are saved separately from the vault: "save" keeps the panel's edits
	 * across a restart, "Update" is what writes them into notes. Losing an
	 * afternoon of edits to a reload is not an acceptable failure mode, and the
	 * two ideas are genuinely different - one is a scratchpad, one is a commit.
	 */
	async loadSettings() {
		this.migrations = new Set();
		const data = await this.loadData();
		/* A fresh install starts with the current defaults, so nothing to migrate. */
		if (!data) {
			this.migrations.add('sort-alphabetical');
			return;
		}

		if (data.settings) {
			const stored = Object.assign({}, data.settings);
			/* There is no root object any more; a stale key would only confuse. */
			delete stored.rootObject;

			/*
			 * `inherits from` was renamed `type of`. Only the *setting* is
			 * migrated - his notes still say the old thing, and rewriting those
			 * behind his back is not mine to do.
			 */
			if (stored.inheritsProperty === 'inherits from') {
				stored.inheritsProperty = DEFAULT_SETTINGS.inheritsProperty;
			}
			if (Array.isArray(stored.logicProperties)) {
				stored.logicProperties = stored.logicProperties.map(
					(property) => (property === 'inherits from'
						? DEFAULT_SETTINGS.inheritsProperty
						: property));
			}

			/*
			 * `created` and `updated` were on the shipped ignore list for one
			 * version, and he took them off. A stored copy of that old default
			 * would go on hiding them for ever - settings are merged over the
			 * defaults, so a value saved once outranks every default that follows.
			 *
			 * Only an *untouched* list is migrated: if it matches the old default
			 * exactly he never chose it, and the new default is what he asked for.
			 * If he has edited it at all, it is his and stays as it is.
			 */
			if (sameNameList(toArray(stored.ignoredProperties), RETIRED_IGNORED_DEFAULT)) {
				stored.ignoredProperties = DEFAULT_SETTINGS.ignoredProperties.slice();
			}

			/*
			 * One-shot migrations, recorded by name so each runs exactly once.
			 *
			 * The list above can be recognised as an untouched default and replaced
			 * safely; this one cannot - `descent` was both the old default *and* a
			 * legitimate choice, so rewriting it on every load would overrule him
			 * for ever. Running it once and remembering that it ran leaves him free
			 * to set it straight back.
			 */
			this.migrations = new Set(toArray(data.migrations));
			if (!this.migrations.has('sort-alphabetical')) {
				stored.sortClasses = 'name';
				this.migrations.add('sort-alphabetical');
				this.migrationPending = true;
			}

			Object.assign(this.settings, stored);
		}

		if (data.drafts) {
			for (const name of Object.keys(data.drafts)) {
				const draft = data.drafts[name];
				if (!draft) continue;

				/* Before base characteristics were a list, a draft was two fields. */
				const values = draft.values || {};
				if (!draft.values) {
					values[this.settings.characteristicsProperty] = toArray(draft.characteristics);
					values[this.settings.inheritsProperty] = toArray(draft.parents);
				}

				this.drafts.set(name, { values: values });
			}
		}

		for (const name of toArray(data.baseRefreshes)) this.baseRefreshes.add(name);
		for (const name of toArray(data.expanded)) this.expanded.add(name);
		for (const id of toArray(data.dismissed)) this.dismissed.add(id);
	}

	/* Everything the plugin owns goes out together, so neither half is clobbered. */
	async persist() {
		const drafts = {};
		for (const [name, draft] of this.drafts) drafts[name] = draft;
		await this.saveData({
			settings: this.settings,
			drafts: drafts,
			baseRefreshes: Array.from(this.baseRefreshes),
			expanded: Array.from(this.expanded),
			dismissed: Array.from(this.dismissed),
			migrations: Array.from(this.migrations || []),
		});
	}

	/* Open or close one class card. Not an edit, so it never marks work pending. */
	async toggleExpanded(name) {
		if (this.expanded.has(name)) this.expanded.delete(name);
		else this.expanded.add(name);
		await this.persist();
	}

	async setAllExpanded(names, open) {
		this.expanded.clear();
		if (open) for (const name of names) this.expanded.add(name);
		await this.persist();
	}

	/*
	 * Fold or unfold every class at once, whatever the panel is currently
	 * showing - so the search filter narrows what is *listed*, never what this
	 * acts on. Called from the header buttons and from the command palette,
	 * which is why it works out the names itself.
	 */
	async setAllClassesExpanded(open) {
		const objects = this.scanClasses();
		const names = Array.from(this.allDrafts(objects).keys());
		await this.setAllExpanded(names, open);
		this.refreshViews();
	}

	async saveSettings() {
		await this.persist();
		this.refreshViews();
	}

	/*
	 * Keep the panel's edits without touching a single note. Called as edits are
	 * made rather than from a button: there is no state where an edit exists
	 * only in memory, so nothing can be lost by closing Obsidian.
	 */
	async saveDrafts() {
		this.pruneDrafts(this.scanClasses());
		this.invalidatePicture();
		await this.persist();
		return this.drafts.size;
	}

	async discardDrafts() {
		this.drafts.clear();
		this.baseRefreshes.clear();
		await this.persist();
	}

	/* Queue or unqueue one class's base for regeneration on the next Update. */
	async toggleBaseRefresh(name) {
		if (this.baseRefreshes.has(name)) this.baseRefreshes.delete(name);
		else this.baseRefreshes.add(name);
		await this.persist();
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
		}
	}
}

/* --------------------------------------------------------------- the panel */

class ClassesView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Classes'; }
	getIcon() { return 'boxes'; }

	async onOpen() {
		/* Frontmatter edited outside the panel should show up here. */
		this.registerEvent(this.app.metadataCache.on('changed', () => { this.queueRender(); }));

		/* Follow whatever note he is looking at. */
		this.registerEvent(this.app.workspace.on('file-open', () => { this.queueRender(); }));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => { this.queueRender(); }));

		this.render();
	}

	queueRender() {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.setTimeout(() => { this.renderQueued = false; this.render(); }, 300);
	}

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('oof-objects');

		const plugin = this.plugin;
		const objects = plugin.scanClasses();
		const characteristics = plugin.scanCharacteristics();

		const drafts = plugin.allDrafts(objects);

		const filter = String(this.filter || '').trim().toLowerCase();

		/*
		 * The names are worked out before the header is drawn, because the header
		 * shows the count - and while searching, how many of how many.
		 */
		let names = plugin.sortedClassNames(objects, drafts);
		const total = names.length;
		if (filter) {
			names = names.filter((name) => name.toLowerCase().indexOf(filter) !== -1);
		}

		this.renderHeader(container, drafts, objects, { shown: names.length, total });

		/* When he is hunting for a class, the rest of the panel is noise. */
		if (!filter) {
			this.renderDiscrepancies(container);
			this.renderBaseCharacteristics(container, characteristics);
		}

		/*
		 * The classes the active note is about — itself if it is a class, else
		 * whatever its `is a` names.
		 */
		const activeFile = plugin.settings.followActiveNote
			? this.app.workspace.getActiveFile()
			: null;
		this.active = new Set(plugin.classesForFile(activeFile, objects));

		/*
		 * Scroll to it only when he has actually moved to another note. Doing it
		 * on every render would yank the panel around while he edits chips.
		 */
		const activePath = activeFile ? activeFile.path : null;
		const moved = activePath !== this.lastActivePath;
		this.lastActivePath = activePath;

		for (const name of names) {
			this.renderObject(container, drafts.get(name), objects, drafts, characteristics);
		}

		if (moved && this.active.size > 0) {
			const card = container.querySelector('.oof-object-active');
			if (card && typeof card.scrollIntoView === 'function') {
				card.scrollIntoView({ block: 'nearest' });
			}
		}

		if (names.length === 0) {
			container.createEl('p', {
				text: filter
					? 'No class matches "' + this.filter + '".'
					: 'No classes yet. A class is a note tagged #class, or one that lists '
						+ 'characteristics or names a parent.',
				cls: 'oof-empty',
			});
		}

		this.watchScroll();
		this.syncStuckHeader();
	}

	/*
	 * The header is see-through until something scrolls under it, and frosted
	 * after — the transparency he asked for, without the text of a scrolling card
	 * showing through the title. CSS cannot ask whether a sticky element is
	 * currently stuck, so the view says so.
	 */
	syncStuckHeader() {
		const scroller = this.containerEl.children[1];
		if (!scroller || typeof scroller.querySelector !== 'function') return;
		const header = scroller.querySelector('.oof-header');
		if (header) header.classList.toggle('is-scrolled', scroller.scrollTop > 2);
	}

	/*
	 * Registered against the scroll container, which survives a render, and only
	 * once - the panel redraws on every metadata change and every chip edit, so
	 * doing this per render would stack up listeners.
	 */
	watchScroll() {
		const scroller = this.containerEl.children[1];
		if (!scroller || !scroller.dataset || scroller.dataset.oofScroll) return;
		scroller.dataset.oofScroll = 'on';
		const sync = () => this.syncStuckHeader();
		if (typeof this.registerDomEvent === 'function') this.registerDomEvent(scroller, 'scroll', sync);
		else scroller.addEventListener('scroll', sync);
	}

	renderHeader(container, drafts, objects, counts) {
		const plugin = this.plugin;
		const header = container.createDiv({ cls: 'oof-header' });

		const title = header.createDiv({ cls: 'oof-header-title' });

		/*
		 * Shaped like the Calendar plugin's title - a plain element rather than an
		 * `h3`, so the theme's heading style does not decide how this looks, with
		 * the count in the accent colour the way Calendar sets its year apart.
		 */
		const heading = title.createDiv({ cls: 'oof-title' });
		heading.createSpan({ text: 'Classes', cls: 'oof-title-name' });
		heading.createSpan({
			cls: 'oof-title-count',
			text: counts.shown === counts.total
				? String(counts.total)
				: counts.shown + '/' + counts.total,
		});

		/*
		 * Adding a class, against the count of them - the plus reads as "one more
		 * of these", which is what it does, and it puts the one action that makes
		 * a class beside the number of classes rather than at the end of a row of
		 * words. A bare `plus`, not `square-plus`: that shape is taken by Unfold
		 * all at the other end of the same row.
		 */
		this.headerIcon(title, 'plus', '+', {
			cls: 'oof-new-class',
			label: 'New class',
			onClick: () => {
				new NewObjectModal(this.app, this.plugin, (name) => {
					if (!name || drafts.has(name)) return;
					this.plugin.drafts.set(name, { values: this.plugin.emptyLogicValues() });
					this.plugin.persist().then(() => { this.render(); });
				}).open();
			},
		});

		/*
		 * *pending*, not *unsaved*: edits are kept the moment they are made, so
		 * what this marks is work the vault has not been told about yet. Update
		 * is what tells it.
		 */
		const pending = plugin.isDirty(objects);
		if (pending) title.createSpan({ text: 'pending', cls: 'oof-badge oof-badge-dirty' });

		const buttons = header.createDiv({ cls: 'oof-header-buttons' });

		const discard = buttons.createEl('button', { text: 'Discard' });
		if (!pending) discard.setAttribute('disabled', 'true');
		discard.onclick = async () => {
			await plugin.discardDrafts();
			new Notice('OOF Classes: pending edits discarded. Your notes were never touched.');
			this.render();
		};

		/*
		 * The gate, his rule: updating is only possible once the discrepancies are
		 * handled. Only the insolvable ones block - the solvable ones are exactly
		 * what Update is for, so blocking on those would lock the door and hide
		 * the key.
		 */
		const found = plugin.findDiscrepancies();
		const blocked = found.insolvable.length > 0;

		const update = buttons.createEl('button', {
			text: 'Update',
			cls: !blocked && pending ? 'mod-cta' : '',
		});
		if (blocked) {
			update.setAttribute('disabled', 'true');
			update.setAttribute('title', found.insolvable.length + ' discrepanc'
				+ (found.insolvable.length === 1 ? 'y needs' : 'ies need')
				+ ' you first — see the list below.');
		}
		update.onclick = () => {
			if (blocked) return;
			new UpdateModal(this.app, this.plugin, this).open();
		};

		/*
		 * Filtering the list. Re-rendering rebuilds this input, so focus and the
		 * caret are put back afterwards - otherwise every keystroke would drop
		 * him out of the box.
		 */
		const search = header.createEl('input', {
			cls: 'oof-search',
			attr: { type: 'search', placeholder: 'Find a class…' },
		});
		search.value = this.filter || '';
		search.oninput = () => {
			this.filter = search.value;
			this.render();
			const next = this.containerEl.children[1].querySelector('.oof-search');
			if (!next) return;
			next.focus();
			next.setSelectionRange(next.value.length, next.value.length);
		};
		search.onkeydown = (event) => {
			if (event.key !== 'Escape' || !this.filter) return;
			this.filter = '';
			this.render();
			const next = this.containerEl.children[1].querySelector('.oof-search');
			if (next) next.focus();
		};

		/*
		 * Cards are closed by default, so this is the way back to seeing everything
		 * at once - and the way out of having opened twenty of them.
		 *
		 * Two buttons rather than one label that flips: a single toggle reading
		 * "Fold all" whenever *one* card happens to be open makes unfolding a
		 * two-click affair, and which of the two you are about to get depends on
		 * state you would have to read off the list first. Each is greyed out when
		 * it would do nothing, so the pair still says which way there is to go.
		 */
		const names = Array.from(drafts.keys());
		const openCount = names.filter((name) => plugin.expanded.has(name)).length;

		/*
		 * These go on the title row, not in with Discard and Update - which is
		 * where VS Code puts them too. Two reasons beyond the resemblance: they act
		 * on the whole list rather than on the vault, and in a 300px sidebar a
		 * third item wraps that row onto a second line, spending a whole row on
		 * two icons.
		 */
		const folding = title.createDiv({ cls: 'oof-fold-buttons' });
		this.headerIcon(folding, 'square-plus', '+', {
			label: 'Unfold all classes',
			disabled: openCount === names.length,
			onClick: async () => {
				await plugin.setAllClassesExpanded(true);
				this.render();
			},
		});
		this.headerIcon(folding, 'square-minus', '−', {
			label: 'Fold all classes',
			disabled: openCount === 0,
			onClick: async () => {
				await plugin.setAllClassesExpanded(false);
				this.render();
			},
		});
	}

	/*
	 * An icon on the title row. VS Code's expand-all / collapse-all pair are
	 * Lucide's `square-plus` and `square-minus` - a square with a plus, a square
	 * with a minus - and both, along with the bare `plus`, are in Obsidian's icon
	 * set.
	 *
	 * A <button> rather than the `iconButton` anchor used inside the cards,
	 * because these need `disabled` - an anchor cannot be disabled, and the grey
	 * is half of what the fold pair says. `glyph` is the fallback if `setIcon` is
	 * missing, so a failed icon leaves a button you can still see and press.
	 */
	headerIcon(parent, icon, glyph, options) {
		const button = parent.createEl('button', {
			cls: ('oof-header-icon clickable-icon ' + (options.cls || '')).trim(),
			attr: { 'aria-label': options.label, title: options.label },
		});
		if (typeof setIcon === 'function') setIcon(button, icon);
		else button.textContent = glyph;
		if (options.disabled) button.setAttribute('disabled', 'true');
		button.onclick = options.onClick;
		return button;
	}

	/*
	 * Step two, in the panel. Both kinds under one caution symbol, his layout -
	 * because from where he is sitting they are one question ("what is wrong?"),
	 * and only the answer to "who fixes it?" differs.
	 *
	 * It is a card like the others and collapses like the others, closed by
	 * default when everything is solvable and open when something is not: a
	 * discrepancy that blocks Update should not need a click to be found.
	 */
	renderDiscrepancies(container) {
		const plugin = this.plugin;
		const found = plugin.findDiscrepancies();
		const total = found.solvable.length + found.insolvable.length;
		if (total === 0 && found.dismissed.length === 0) return;

		const open = plugin.expanded.has(DISCREPANCY_CARD);
		const card = container.createDiv({
			cls: 'oof-object oof-discrepancies'
				+ (found.insolvable.length > 0 ? ' oof-discrepancies-blocking' : '')
				+ (open ? ' is-open' : ' is-closed'),
		});

		const title = card.createDiv({ cls: 'oof-object-title' });
		title.onclick = async () => {
			await plugin.toggleExpanded(DISCREPANCY_CARD);
			this.render();
		};

		const twisty = title.createSpan({ cls: 'oof-twisty' });
		if (typeof setIcon === 'function') setIcon(twisty, 'chevron-right');

		const caution = title.createSpan({ cls: 'oof-caution' });
		if (typeof setIcon === 'function') setIcon(caution, 'alert-triangle');

		title.createSpan({ text: 'Discrepancies', cls: 'oof-object-name' });

		/* Two counts, because they mean different things to him. */
		if (found.solvable.length > 0) {
			title.createSpan({
				text: found.solvable.length + ' solvable',
				cls: 'oof-badge oof-badge-solvable',
			});
		}
		if (found.insolvable.length > 0) {
			title.createSpan({
				text: found.insolvable.length + ' for you',
				cls: 'oof-badge oof-badge-insolvable',
			});
		}

		if (!open) return;
		const body = card.createDiv({ cls: 'oof-object-body' });

		if (found.insolvable.length > 0) {
			body.createEl('p', {
				cls: 'oof-base-note',
				text: 'These need you. Update stays disabled until each one is either '
					+ 'fixed in the vault or dismissed here.',
			});
			this.renderDiscrepancyList(body, found.insolvable, true);
		}

		if (found.solvable.length > 0) {
			body.createEl('p', {
				cls: 'oof-base-note',
				text: 'These the plugin can fix itself, and will, when you press Update.',
			});
			this.renderDiscrepancyList(body, found.solvable, false);
		}

		if (found.dismissed.length > 0) {
			body.createEl('p', {
				cls: 'oof-base-note',
				text: 'Dismissed — still true, no longer blocking.',
			});
			this.renderDiscrepancyList(body, found.dismissed, true);
		}
	}

	renderDiscrepancyList(body, discrepancies, dismissable) {
		const plugin = this.plugin;
		const list = body.createEl('ul', { cls: 'oof-discrepancy-list' });

		for (const discrepancy of discrepancies) {
			const item = list.createEl('li', {
				cls: discrepancy.severity === 'insolvable'
					? 'oof-discrepancy oof-discrepancy-insolvable'
					: 'oof-discrepancy',
			});

			const head = item.createDiv({ cls: 'oof-discrepancy-head' });
			head.createSpan({ text: discrepancy.label, cls: 'oof-discrepancy-label' });

			if (discrepancy.file) {
				this.iconButton(head, 'file-text', {
					label: 'Open ' + discrepancy.file.basename,
					tooltip: discrepancy.file.path,
					onClick: () => {
						this.app.workspace.getLeaf(false).openFile(discrepancy.file);
					},
				});
			}

			if (dismissable) {
				const isDismissed = plugin.dismissed.has(discrepancyId(discrepancy));
				this.iconButton(head, isDismissed ? 'undo-2' : 'bell-off', {
					label: isDismissed ? 'Bring this back' : 'Dismiss',
					tooltip: isDismissed
						? 'Start blocking Update on this again.'
						: 'Leave this as it is. It stays listed, but stops blocking Update.',
					onClick: async () => {
						await plugin.toggleDismissed(discrepancy);
						this.render();
					},
				});
			}

			for (const line of discrepancy.detail || []) {
				item.createSpan({ text: line, cls: 'oof-discrepancy-detail' });
			}
		}
	}

	/*
	 * The base characteristics: the properties the system reasons with, sitting
	 * above the objects because they apply to all of them. Editing this list
	 * adds or removes a row on every class card.
	 */
	renderBaseCharacteristics(container, characteristics) {
		const plugin = this.plugin;
		const card = container.createDiv({ cls: 'oof-object oof-base' });

		/* No dropdown on this one: it is one short list, and it applies to all. */
		const title = card.createDiv({ cls: 'oof-object-title oof-title-static' });
		title.createSpan({ text: 'Base characteristics', cls: 'oof-object-name' });
		title.createSpan({ text: 'logic', cls: 'oof-badge oof-badge-root' });

		const body = card.createDiv({ cls: 'oof-object-body' });
		body.createEl('p', {
			text: 'The properties the system reasons with. Every class below gets one row per entry.',
			cls: 'oof-base-note',
		});

		this.renderChipRow(body, 'properties', plugin.settings.logicProperties, {
			suggestions: Array.from(characteristics.keys()),
			onChange: async (next) => {
				/* Never let the three the engine depends on be removed. */
				const anchors = [
					plugin.settings.isAProperty,
					plugin.settings.characteristicsProperty,
					plugin.settings.inheritsProperty,
				];
				const missing = anchors.filter((a) => !next.includes(a));
				if (missing.length > 0) {
					new Notice('OOF Classes: "' + missing.join('", "')
						+ '" is used by the engine and cannot be removed.', 6000);
					return;
				}
				/*
				 * Remember what was dropped, so Update can clear the orphan key
				 * off the objects that still carry it. Anything added back stops
				 * being retired.
				 */
				const removed = plugin.settings.logicProperties.filter((p) => !next.includes(p));
				const retired = toArray(plugin.settings.retiredLogicProperties)
					.concat(removed)
					.filter((p) => !next.includes(p));

				plugin.settings.logicProperties = next;
				plugin.settings.retiredLogicProperties = Array.from(new Set(retired));
				await plugin.saveSettings();
				this.render();
			},
			onOpen: (name) => {
				const characteristic = characteristics.get(name);
				if (characteristic) {
					this.app.workspace.getLeaf(false).openFile(characteristic.file);
					return;
				}
				new Notice('No note for "' + name + '" yet — Update creates it.', 4000);
			},
			tooltip: (name) => {
				const characteristic = characteristics.get(name);
				const meaning = characteristic && characteristic.meaning ? characteristic.meaning : null;
				const anchored = name === plugin.settings.isAProperty
					|| name === plugin.settings.characteristicsProperty
					|| name === plugin.settings.inheritsProperty;
				const parts = [];
				if (meaning) parts.push(meaning);
				parts.push(anchored ? 'used by the engine' : 'stored and editable, no inheritance');
				if (!characteristic) parts.push('no note yet');
				return parts.join(' — ');
			},
			missing: (name) => !characteristics.has(name),
		});
	}

	renderObject(container, draft, objects, drafts, characteristics) {
		const plugin = this.plugin;
		const isActive = this.active && this.active.has(draft.name);
		const open = plugin.expanded.has(draft.name);

		const card = container.createDiv({
			cls: 'oof-object' + (isActive ? ' oof-object-active' : '')
				+ (open ? ' is-open' : ' is-closed'),
		});

		const templateFile = this.app.vault.getFileByPath(plugin.templatePathFor(draft.name));
		const baseFile = this.app.vault.getFileByPath(plugin.basePathFor(draft.name));

		/*
		 * --- 1. one row per class: the name and everything that acts on it ---
		 *
		 * The row is the dropdown's handle, so a click anywhere on it that is not
		 * an icon opens or closes the card.
		 */
		const title = card.createDiv({ cls: 'oof-object-title' });
		title.onclick = async () => {
			await plugin.toggleExpanded(draft.name);
			this.render();
		};

		const twisty = title.createSpan({ cls: 'oof-twisty' });
		if (typeof setIcon === 'function') setIcon(twisty, 'chevron-right');

		title.createSpan({ text: draft.name, cls: 'oof-object-name' });

		/* Rename belongs to the name, so it stays beside it rather than joining
		 * the file links: those open a file, this one changes one. */
		this.iconButton(title, 'pencil', {
			cls: 'oof-rename',
			label: 'Rename',
			tooltip: 'Rename this class',
			onClick: () => {
				new RenameClassModal(this.app, plugin, draft.name, async (next) => {
					const result = await plugin.renameClass(draft.name, next);
					if (!result.ok) {
						if (result.reason !== 'unchanged') new Notice('OOF Classes: ' + result.reason, 6000);
						return;
					}
					new Notice('OOF Classes: renamed to "' + next + '". Obsidian updated the links.');
					this.render();
				}).open();
			},
		});

		if (draft.isNew) title.createSpan({ text: 'new', cls: 'oof-badge' });
		if (isActive) {
			const active = this.app.workspace.getActiveFile();
			const itself = active && active.basename === draft.name;

			/*
			 * Two halves, deliberately: "active note" is prose about which note you
			 * are reading, so it is only coloured, while `is a` is the property
			 * that actually connects the note to this class - and it is chipped
			 * because it is a property name, like the rows below.
			 */
			title.createSpan({ text: itself ? 'active' : 'active note', cls: 'oof-active-label' });
			if (!itself) title.createSpan({ text: 'is a', cls: 'oof-badge oof-badge-active' });
		}

		/*
		 * The three files a class has, as icons on the same row - they used to be
		 * words on a row of their own beneath it. A file that does not exist yet
		 * keeps its place, faint, and says why when clicked: the row would jump
		 * about as templates and bases came into being otherwise.
		 */
		const actions = title.createDiv({ cls: 'oof-object-actions' });

		if (draft.file) {
			this.iconButton(actions, 'file-text', {
				label: 'Open note',
				tooltip: draft.file.path,
				onClick: () => { this.app.workspace.getLeaf(false).openFile(draft.file); },
			});
		}

		this.iconButton(actions, 'layout-template', {
			cls: templateFile instanceof TFile ? '' : 'oof-icon-pending',
			label: 'Open template',
			tooltip: templateFile instanceof TFile
				? templateFile.path
				: 'No template yet — Update creates it.',
			onClick: () => {
				if (templateFile instanceof TFile) {
					this.app.workspace.getLeaf(false).openFile(templateFile);
					return;
				}
				new Notice('No template for "' + draft.name + '" yet — Update creates it.', 4000);
			},
		});

		if (plugin.settings.createBases) {
			this.iconButton(actions, 'table-2', {
				cls: baseFile ? '' : 'oof-icon-pending',
				label: 'Open base',
				tooltip: baseFile ? baseFile.path : 'No base yet — Update creates it.',
				onClick: () => {
					if (baseFile) {
						this.app.workspace.getLeaf(false).openFile(baseFile);
						return;
					}
					new Notice('No base for "' + draft.name + '" yet — Update creates it.', 4000);
				},
			});

			/*
			 * A base is created once and then his. Regenerating one is an explicit
			 * request, queued like any other edit so it shows up in the Update plan
			 * before anything is overwritten.
			 */
			if (baseFile) {
				const queued = plugin.baseRefreshes.has(draft.name);

				/*
				 * The one control here that destroys work of his that nothing else
				 * holds a copy of - the views, sorts and filters he built on a base
				 * by hand. So it asks for a typed code first.
				 *
				 * It looks like its neighbours, though. It was red for a while and
				 * he took the colour back off: the code is the protection, and a
				 * red icon on every class card is a warning worn down by being
				 * always there. The alarm belongs at the moment of the act.
				 *
				 * Only *arming* it asks. Cancelling a queued reset is the safe
				 * direction, and putting a gate in front of the way out would be
				 * safety theatre rather than safety.
				 */
				this.iconButton(actions, queued ? 'rotate-ccw' : 'refresh-cw', {
					cls: queued ? 'oof-icon-warning' : '',
					label: queued ? 'Cancel the queued base reset' : 'Reset base',
					tooltip: queued
						? 'Queued. Update will regenerate this base, replacing your edits. '
							+ 'Click to cancel.'
						: 'Reset this base to what the plugin would generate — replacing any '
							+ 'views, sorts and filters you added. Asks for a code first.',
					onClick: async () => {
						if (queued) {
							await plugin.toggleBaseRefresh(draft.name);
							this.render();
							return;
						}

						new ConfirmCodeModal(this.app, {
							title: 'Reset the base for "' + draft.name + '"?',
							lines: [
								baseFile.path + ' will be rebuilt from scratch on the next '
									+ 'Update, exactly as the plugin would generate it today.',
								'Any views, sorts, group-bys and filters you added to it are '
									+ 'lost. Nothing else keeps a copy of them.',
								'Nothing is written yet — this queues it, and the Update plan '
									+ 'will show it once more before it happens.',
							],
							confirmText: 'Queue the reset',
							onConfirm: async () => {
								await plugin.toggleBaseRefresh(draft.name);
								this.render();
							},
						}).open();
					},
				});
			}
		}

		/*
		 * Making an instance is what a class is *for*, so it ends the row and gets
		 * the biggest glyph. Obsidian's own "new note" icon, because that is what
		 * it does. Only where there is a template to make one from.
		 */
		if (templateFile instanceof TFile) {
			this.iconButton(actions, 'file-plus', {
				cls: 'oof-new-instance',
				label: 'New ' + draft.name,
				tooltip: 'New ' + draft.name + ', from its template',
				onClick: () => {
					new NewInstanceModal(this.app, draft.name, (noteName) => {
						plugin.createInstance(draft.name, noteName);
					}).open();
				},
			});
		}

		/* --- 2. the body, which is what the dropdown hides --- */
		if (!open) return;
		const body = card.createDiv({ cls: 'oof-object-body' });

		/* Which ancestor declares each inherited characteristic, for the tooltip. */
		const provenance = new Map();
		for (const ancestor of plugin.ancestorsOf(draft.name, objects, drafts)) {
			const ancestorDraft = drafts.get(ancestor);
			if (!ancestorDraft) continue;
			for (const name of ancestorDraft.characteristics) {
				if (!provenance.has(name)) provenance.set(name, ancestor);
			}
		}

		const openCharacteristic = (name) => {
			const characteristic = characteristics.get(name);
			if (characteristic) {
				this.app.workspace.getLeaf(false).openFile(characteristic.file);
				return;
			}
			new Notice('No note for "' + name + '" yet — Update creates it.', 4000);
		};

		const characteristicTooltip = (name) => {
			const characteristic = characteristics.get(name);
			const meaning = characteristic && characteristic.meaning ? characteristic.meaning : null;
			const from = provenance.get(name);
			const parts = [];
			if (meaning) parts.push(meaning);
			if (from && from !== draft.name) parts.push('from ' + from);
			if (!characteristic) parts.push('no note yet');
			return parts.length > 0 ? parts.join(' — ') : name;
		};

		/* Opening whichever note a value refers to, whatever kind it is. */
		const openObject = (name) => {
			const object = objects.get(name);
			if (object && object.file) {
				this.app.workspace.getLeaf(false).openFile(object.file);
				return;
			}
			const characteristic = characteristics.get(name);
			if (characteristic) {
				this.app.workspace.getLeaf(false).openFile(characteristic.file);
				return;
			}
			new Notice('No note for "' + name + '" yet — Update creates it.', 4000);
		};

		const objectNames = Array.from(drafts.keys()).filter((n) => n !== draft.name);

		/*
		 * --- 2 and 3. one row per base characteristic, in the order he lists
		 * them. `characteristics` takes note names from the characteristics
		 * folder; everything else points at objects.
		 */
		for (const property of plugin.settings.logicProperties) {
			const isCharacteristics = property === plugin.settings.characteristicsProperty;

			this.renderChipRow(body, property, draft.values[property] || [], {
				suggestions: isCharacteristics ? Array.from(characteristics.keys()) : objectNames,
				onChange: (next) => { this.setDraftValue(draft, property, next); },
				onOpen: isCharacteristics ? openCharacteristic : openObject,
				tooltip: isCharacteristics ? characteristicTooltip : (name) => {
					const object = objects.get(name);
					return object && object.file ? name : name + ' — no note yet';
				},
				missing: isCharacteristics
					? (name) => !characteristics.has(name)
					: (name) => {
						const object = objects.get(name);
						return (!object || !object.file) && !characteristics.has(name);
					},
			});

			/*
			 * Inherited characteristics cannot be edited here - they belong to
			 * the parent - but they still open their note, which is half the
			 * reason to look at them. Shown directly under the row they extend.
			 */
			if (!isCharacteristics) continue;

			const own = new Set(draft.characteristics);
			const inherited = plugin.effectiveCharacteristics(draft.name, objects, drafts)
				.filter((c) => !own.has(c));
			if (inherited.length === 0) continue;

			this.renderChipRow(body, 'inherited', inherited, {
				onOpen: openCharacteristic,
				tooltip: characteristicTooltip,
				missing: (name) => !characteristics.has(name),
				muted: true,
			});
		}
	}

	/*
	 * An icon that does something. `stopPropagation` is the important part: these
	 * sit on the row that opens and closes the card, and clicking one should act
	 * rather than toggle.
	 */
	iconButton(parent, icon, options) {
		const button = parent.createEl('a', {
			cls: ('oof-icon ' + (options.cls || '')).trim(),
			attr: {
				'aria-label': options.label,
				title: options.tooltip || options.label,
			},
		});
		if (typeof setIcon === 'function') setIcon(button, icon);
		button.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			options.onClick();
		};
		return button;
	}

	/*
	 * A chip per value. Each chip is an anchor, so it reads as a link and opens
	 * the note behind it - the whole chip is the target, not just the glyphs.
	 * With `onChange` the chips gain a remove button and the row gains an input
	 * to add one; without it the row is read-only, which is what `inherited` is.
	 */
	renderChipRow(card, label, values, options) {
		const onChange = options.onChange || null;
		const row = card.createDiv({ cls: options.muted ? 'oof-row oof-row-muted' : 'oof-row' });
		row.createSpan({ text: label, cls: 'oof-row-label' });

		const chips = row.createDiv({ cls: 'oof-chips' });

		for (const value of values) {
			let cls = 'oof-chip';
			if (options.muted) cls += ' oof-chip-muted';
			if (options.missing && options.missing(value)) cls += ' oof-chip-missing';
			const chip = chips.createSpan({ cls: cls });

			const text = chip.createEl('a', { text: value, cls: 'oof-chip-text' });
			text.setAttribute('title', options.tooltip(value));

			/*
			 * stopPropagation keeps the chip-level handler from firing a second
			 * time for the same click.
			 */
			const open = (event) => {
				event.preventDefault();
				event.stopPropagation();
				options.onOpen(value);
			};
			text.onclick = open;
			/* The padding around the text is a click target too. */
			chip.onclick = open;

			if (!onChange) continue;

			const remove = chip.createSpan({ text: '×', cls: 'oof-chip-remove' });
			remove.setAttribute('aria-label', 'Remove ' + value);
			remove.onclick = (event) => {
				event.stopPropagation();
				onChange(values.filter((v) => v !== value));
			};
		}

		if (!onChange) return;

		const input = chips.createEl('input', { cls: 'oof-add', attr: { placeholder: '+' } });
		const listId = 'oof-list-' + Math.random().toString(36).slice(2);
		input.setAttribute('list', listId);

		const datalist = chips.createEl('datalist');
		datalist.id = listId;
		for (const suggestion of options.suggestions || []) {
			if (values.includes(suggestion)) continue;
			datalist.createEl('option', { value: suggestion });
		}

		input.onkeydown = (event) => {
			if (event.key !== 'Enter') return;
			const value = input.value.trim();
			if (!value || values.includes(value)) return;
			onChange(values.concat([value]));
		};
	}

	/*
	 * Seed the draft from everything currently shown, then change the one
	 * property being edited - so editing `is a` cannot silently drop an
	 * unsaved edit to `characteristics`.
	 */
	setDraftValue(draft, property, next) {
		const existing = this.plugin.drafts.get(draft.name);
		const values = existing && existing.values
			? Object.assign({}, existing.values)
			: Object.assign({}, draft.values);

		values[property] = next;
		this.plugin.drafts.set(draft.name, { values: values });
		/* Kept immediately - there is no Save button to press. */
		this.plugin.saveDrafts().then(() => { this.render(); });
	}
}

/* --------------------------------------------------------------- the modals */

/*
 * Update never writes straight away: it shows the whole plan first, with the
 * conflicts it refuses to resolve on its own listed alongside.
 */
class UpdateModal extends Modal {
	constructor(app, plugin, view) {
		super(app);
		this.plugin = plugin;
		this.view = view;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-update-modal');
		contentEl.createEl('h3', { text: 'Update' });

		this.renderPlan(contentEl);
	}

	renderPlan(contentEl) {
		const plan = this.plugin.buildPlan();


		if (plan.actions.length === 0 && plan.conflicts.length === 0) {
			contentEl.createEl('p', { text: 'Everything is already in step. Nothing to write.' });
			const close = contentEl.createEl('button', { text: 'Close' });
			close.onclick = () => this.close();
			return;
		}

		if (plan.actions.length > 0) {
			const trashing = plan.actions.filter((a) => a.kind === 'trash-characteristic').length;

			contentEl.createEl('p', {
				text: plan.actions.length + ' change' + (plan.actions.length === 1 ? '' : 's')
					+ ' will be written to frontmatter. Note bodies are not touched.',
				cls: 'oof-modal-lede',
			});

			if (trashing > 0) {
				contentEl.createEl('p', {
					text: trashing + ' characteristic note' + (trashing === 1 ? '' : 's')
						+ ' will be sent to the trash — the only whole file'
						+ (trashing === 1 ? '' : 's') + ' this touches. Recoverable from '
						+ 'wherever your "Deleted files" setting puts them.',
					cls: 'oof-modal-warning',
				});
			}

			const list = contentEl.createEl('ul', { cls: 'oof-plan' });
			for (const action of plan.actions) {
				const item = list.createEl('li',
					action.kind === 'trash-characteristic' ? { cls: 'oof-plan-destructive' } : {});
				item.createSpan({ text: action.label, cls: 'oof-plan-label' });

				const path = action.path || (action.file && action.file.path);
				if (path) item.createSpan({ text: path, cls: 'oof-plan-path' });

				/* Every file gets its own account of what is about to happen to it. */
				for (const line of action.detail || []) {
					item.createSpan({ text: line, cls: 'oof-plan-detail' });
				}
			}
		}

		if (plan.conflicts.length > 0) {
			contentEl.createEl('h4', { text: 'Conflicts — left for you to resolve' });
			const list = contentEl.createEl('ul', { cls: 'oof-conflicts' });
			for (const conflict of plan.conflicts) {
				const item = list.createEl('li');
				item.createSpan({ text: conflict.file.basename + ' · ' + conflict.property, cls: 'oof-conflict-name' });
				item.createSpan({ text: conflict.reason, cls: 'oof-conflict-reason' });
				const open = item.createEl('a', { text: 'open', cls: 'oof-link' });
				open.onclick = (event) => {
					event.preventDefault();
					this.app.workspace.getLeaf(false).openFile(conflict.file);
					this.close();
				};
			}
		}

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });

		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();

		if (plan.actions.length > 0) {
			const apply = buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' });
			apply.onclick = async () => {
				apply.setAttribute('disabled', 'true');

				/*
				 * Converge rather than apply once: the plan above is the first
				 * pass, and anything it creates - a characteristic note that then
				 * wants a `property type`, a class note that then wants a template
				 * - is settled in the passes after it, by the same handler.
				 */
				const result = await this.plugin.applyUpdate();
				const written = result.applied.length;
				const rounds = result.passes.length;

				new Notice('OOF Classes: ' + written + ' change'
					+ (written === 1 ? '' : 's') + ' written'
					+ (rounds > 1 ? ', over ' + rounds + ' passes' : '')
					+ (result.settled ? '.' : ' — and it did not settle, see the console.'));

				this.close();
				this.view.render();
			};
		}
	}

	onClose() { this.contentEl.empty(); }
}

class NewObjectModal extends Modal {
	constructor(app, plugin, onSubmit) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'New class' });

		let name = '';
		new Setting(contentEl)
			.setName('Name')
			.setDesc('The class note to create, e.g. "Artist".')
			.addText((text) => {
				text.onChange((value) => { name = value.trim(); });
				window.setTimeout(() => text.inputEl.focus(), 0);
				text.inputEl.onkeydown = (event) => {
					if (event.key === 'Enter' && name) { this.onSubmit(name); this.close(); }
				};
			});

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
		const create = buttons.createEl('button', { text: 'Add', cls: 'mod-cta' });
		create.onclick = () => { if (name) { this.onSubmit(name); this.close(); } };
	}

	onClose() { this.contentEl.empty(); }
}

/*
 * Renaming a class. Confirmed here rather than through the Update plan, because
 * it happens at once — so the modal says plainly which files move and who
 * updates the links.
 */
class RenameClassModal extends Modal {
	constructor(app, plugin, name, onSubmit) {
		super(app);
		this.plugin = plugin;
		this.name = name;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'Rename "' + this.name + '"' });

		let next = this.name;
		new Setting(contentEl)
			.setName('New name')
			.addText((text) => {
				text.setValue(this.name);
				text.onChange((value) => { next = value; });
				window.setTimeout(() => {
					text.inputEl.focus();
					text.inputEl.select();
				}, 0);
				text.inputEl.onkeydown = (event) => {
					if (event.key === 'Enter') { this.onSubmit(next); this.close(); }
				};
			});

		const targets = this.plugin.renameTargets(this.name);
		const list = contentEl.createEl('ul', { cls: 'oof-plan' });
		for (const path of targets) {
			list.createEl('li').createSpan({ text: path, cls: 'oof-plan-path' });
		}
		if (targets.length === 0) {
			contentEl.createEl('p', {
				text: 'This class has no note yet, so only the panel changes.',
				cls: 'oof-modal-lede',
			});
		}

		contentEl.createEl('p', {
			text: 'Obsidian renames these and updates every link to them across the vault — '
				+ 'the `type of` on its children, the `is a` on its instances, and its own '
				+ 'template. This happens straight away, not on Update.',
			cls: 'oof-modal-lede',
		});

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
		const rename = buttons.createEl('button', { text: 'Rename', cls: 'mod-cta' });
		rename.onclick = () => { this.onSubmit(next); this.close(); };
	}

	onClose() { this.contentEl.empty(); }
}

/*
 * A typed code before something destructive happens.
 *
 * The code is random and shown on screen rather than being the thing's own name:
 * a name is muscle memory - he has typed "Artist" a hundred times - while five
 * characters he has never seen cannot be typed without reading the sentence
 * above them, which is the entire point of the gate.
 *
 * No 0/O or 1/I/L, so nothing turns on a glyph he cannot tell apart.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function confirmationCode(length) {
	let code = '';
	for (let i = 0; i < (length || 5); i += 1) {
		code += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
	}
	return code;
}

class ConfirmCodeModal extends Modal {
	constructor(app, options) {
		super(app);
		this.options = options;
		this.code = confirmationCode(5);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-danger-modal');

		contentEl.createEl('h3', { text: this.options.title });

		for (const line of this.options.lines || []) {
			contentEl.createEl('p', { text: line, cls: 'oof-danger-line' });
		}

		contentEl.createEl('p', {
			cls: 'oof-modal-lede',
			text: 'Type this code to confirm:',
		});
		contentEl.createEl('div', { text: this.code, cls: 'oof-code' });

		let typed = '';
		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });

		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();

		const confirm = buttons.createEl('button', {
			text: this.options.confirmText || 'Confirm',
			cls: 'mod-warning oof-danger-button',
		});
		confirm.setAttribute('disabled', 'true');

		const matches = () => typed.trim().toUpperCase() === this.code;
		const sync = () => {
			if (matches()) confirm.removeAttribute('disabled');
			else confirm.setAttribute('disabled', 'true');
		};

		const input = contentEl.createEl('input', {
			cls: 'oof-code-input',
			attr: { type: 'text', placeholder: this.code.length + ' characters', spellcheck: 'false' },
		});
		/* Above the buttons, whatever order the elements were created in. */
		contentEl.insertBefore(input, buttons);
		window.setTimeout(() => input.focus(), 0);

		input.oninput = () => { typed = input.value; sync(); };
		input.onkeydown = (event) => {
			if (event.key !== 'Enter' || !matches()) return;
			this.options.onConfirm();
			this.close();
		};

		confirm.onclick = () => {
			if (!matches()) return;
			this.options.onConfirm();
			this.close();
		};
	}

	onClose() { this.contentEl.empty(); }
}

class NewInstanceModal extends Modal {
	constructor(app, objectName, onSubmit) {
		super(app);
		this.objectName = objectName;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'New ' + this.objectName });

		let name = '';
		new Setting(contentEl)
			.setName('Note name')
			.setDesc('Created from the "' + this.objectName + '" template.')
			.addText((text) => {
				text.onChange((value) => { name = value.trim(); });
				window.setTimeout(() => text.inputEl.focus(), 0);
				text.inputEl.onkeydown = (event) => {
					if (event.key === 'Enter' && name) { this.onSubmit(name); this.close(); }
				};
			});

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
		const create = buttons.createEl('button', { text: 'Create', cls: 'mod-cta' });
		create.onclick = () => { if (name) { this.onSubmit(name); this.close(); } };
	}

	onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------- the settings */

class OofClassesSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: 'The classes panel edits the classes of the vault — their characteristics '
				+ 'and their parents — and pushes the consequences to the notes, the templates '
				+ 'and the characteristic notes when you press Update.',
			cls: 'setting-item-description',
		});

		this.addText(containerEl, 'Notes folder', 'Where class notes live.', 'notesFolder');
		this.addText(containerEl, 'Characteristics folder', 'Where characteristic notes live.', 'characteristicsFolder');
		this.addText(containerEl, 'Templates folder', 'Where the generated templates go.', 'templatesFolder');
		this.addText(containerEl, 'Template suffix', 'Appended to a class name to name its template.', 'templateSuffix');
		this.addText(containerEl, 'Ignored properties',
			'Comma-separated properties the class system has no opinion about, so they '
				+ 'are never flagged as unaccounted for on a note: the ones Obsidian '
				+ 'owns (tags, aliases, cssclasses) and the ones your templates write '
				+ '(created). Everything else a note carries that its class does not '
				+ 'declare is reported.',
			'ignoredProperties');

		this.addText(containerEl, 'Characteristic prefix',
			'Begins the file name of every characteristic note, the way • begins a name. '
				+ 'The property it defines is never prefixed. Update renames any that lack it; '
				+ 'leave this empty to turn the convention off.',
			'characteristicPrefix');

		new Setting(containerEl)
			.setName('Follow the active note')
			.setDesc('Highlight the class the active note is about — itself if it is a class, '
				+ 'otherwise whatever its `is a` names — and scroll to it.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.followActiveNote)
				.onChange(async (value) => {
					this.plugin.settings.followActiveNote = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Order in the panel')
			.setDesc('How the classes are listed. Alphabetical by default; by descent '
				+ 'groups each generation together, alphabetically within it.')
			.addDropdown((dropdown) => dropdown
				.addOption('name', 'Alphabetical')
				.addOption('descent', 'By descent, then name — children below their parents')
				.setValue(this.plugin.settings.sortClasses)
				.onChange(async (value) => {
					this.plugin.settings.sortClasses = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Trash unused characteristics')
			.setDesc('On Update, send a characteristic note to the trash once no class lists it, '
				+ 'no note carries it as a property, and nothing links to it. Trashed, never '
				+ 'deleted outright.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.deleteUnusedCharacteristics)
				.onChange(async (value) => {
					this.plugin.settings.deleteUnusedCharacteristics = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h4', { text: 'Bases' });

		new Setting(containerEl)
			.setName('Create a base for each class')
			.setDesc('Writes <Object> Base.base listing that object\'s instances, once. An existing '
				+ 'base is never rewritten, so your own edits to it are safe. Templates are always '
				+ 'excluded. Filtering uses file.isA(), which this plugin provides.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.createBases)
				.onChange(async (value) => {
					this.plugin.settings.createBases = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.createBases) {
			this.addText(containerEl, 'Bases folder', 'Where the generated bases go.', 'basesFolder');
			this.addText(containerEl, 'Base suffix', 'Appended to a class name to name its base.', 'baseSuffix');

			new Setting(containerEl)
				.setName('Columns')
				.setDesc('Which characteristics become table columns.')
				.addDropdown((dropdown) => dropdown
					.addOption('all', 'Everything an instance carries, inherited included')
					.addOption('own', 'Only what the class itself adds')
					.setValue(this.plugin.settings.baseColumns)
					.onChange(async (value) => {
						this.plugin.settings.baseColumns = value;
						await this.plugin.saveSettings();
					}));
		}

		containerEl.createEl('h4', { text: 'Base queries' });

		containerEl.createEl('p', {
			text: 'file.isA("Person"), file.inheritsFrom("Person"), file.ancestors() and '
				+ 'file.isADistance("Person") are available in any base formula, filter or sort. '
				+ 'They read the same properties as the panel, so they can never disagree with it.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('A class is an instance of itself')
			.setDesc('When on, file.isA("Artist") is also true for the Artist note itself.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.classIsItsOwnInstance)
				.onChange(async (value) => {
					this.plugin.settings.classIsItsOwnInstance = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h4', { text: 'Properties' });
		this.addText(containerEl, 'Inheritance property', 'Subclassing: a class names its parent class.', 'inheritsProperty');
		this.addText(containerEl, 'Instance property', 'Instantiation: a note names its class.', 'isAProperty');
		this.addText(containerEl, 'Characteristics property', 'Lists what an object\'s instances carry.', 'characteristicsProperty');
	}

	addText(containerEl, name, desc, key) {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => text
				.setValue(this.plugin.settings[key])
				.onChange(async (value) => {
					this.plugin.settings[key] = value.trim();
					await this.plugin.saveSettings();
				}));
	}
}

module.exports = OofClassesPlugin;
