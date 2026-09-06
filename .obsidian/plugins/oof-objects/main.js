'use strict';

/*
 * OOF Class Manager
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

const { Plugin, PluginSettingTab, Setting, ItemView, Modal, FuzzySuggestModal, TFile,
	Notice, setIcon, SearchComponent } = obsidian;
/*
 * Two the harness does not stub, and neither is load-bearing: without `Menu` the
 * pencil opens the rename dialog directly, as it did before there was anything
 * else on it, and without `getIconIds` the picker simply has no icons tab.
 */
const Menu = obsidian.Menu;
const getIconIds = obsidian.getIconIds;

const VIEW_TYPE = 'oof-objects-panel';

/*
 * The class diagram's own tab. A second view type rather than a second panel:
 * the panel is a list you edit down the side, and a diagram is a thing you look
 * at across a screen, so it opens in the main area like a note does.
 */
const UML_VIEW_TYPE = 'oof-uml-diagram';

/*
 * The diagram's geometry, in the one place a change to it is one edit. Every
 * number here is in the SVG's own units, which the view then pans and zooms —
 * so nothing below ever asks how big the pane is.
 *
 * `charWidth` is the one estimate. There is no measuring pass: a box is sized
 * from its longest line before anything is drawn, which is what lets the layout
 * be a pure function the test suite can run with no DOM at all. It is set for
 * the interface font at `fontSize`, and generously — a box a few pixels wide of
 * its text reads as a box, where one a few pixels short reads as a bug.
 */
const UML = {
	minWidth: 168,
	maxWidth: 320,
	charWidth: 6.7,
	fontSize: 11.5,
	padX: 11,
	headerHeight: 30,
	rowHeight: 17,
	compartmentPad: 6,
	footerHeight: 16,
	hGap: 34,
	vGap: 76,
	margin: 40,
	/*
	 * A class's Lucide symbol, drawn beside its name. 14 rather than the 12.5 of
	 * the title text: an outline icon reads a size smaller than a letterform of
	 * the same box, which is why Obsidian's own toolbars set icons above their
	 * label size too.
	 */
	iconSize: 14,
	iconGap: 5,
};

/*
 * The ignore list as it shipped in 2.3.0, kept only so a stored copy of it can be
 * recognised and replaced. See `loadSettings`.
 */
const RETIRED_IGNORED_DEFAULT = ['tags', 'aliases', 'cssclasses', 'cssclass',
	'publish', 'permalink', 'created', 'updated'];

/*
 * And the one before `cover image` joined them, for the same reason: a stored
 * copy of it was never chosen, so it can be replaced with the current default.
 * One that differs by so much as an entry was edited, and is his.
 */
const PREVIOUS_IGNORED_DEFAULT = ['tags', 'aliases', 'cssclasses', 'cssclass',
	'publish', 'permalink'];

/* The discrepancy card is expanded like a class, under a name no class can take. */
const DISCREPANCY_CARD = '::discrepancies';

/* The dismissed list folds separately: kept, but not in the way. */
const DISMISSED_SECTION = '::dismissed';

/* The actions that remove a whole file, and are shown in red because of it. */
const TRASH_KINDS = ['trash-characteristic', 'trash-template', 'trash-base'];

/*
 * The base characteristics: the properties the system itself reasons with, as
 * opposed to the ones that merely describe a subject. Every class card shows one
 * editable row per entry.
 *
 * **This list is the plugin's, not his** (2026-09-01, from his note `The user
 * should not be able to add or delete base characteristics`): *"All base
 * characteristics should be added in the backend."* Adding one is an edit to this
 * line and nothing else; `loadSettings` overwrites whatever a stored copy says,
 * and the panel draws the row with no × and no +.
 *
 * The three anchors carry meaning to the engine and are named by settings of
 * their own (`isAProperty`, `characteristicsProperty`, `inheritsProperty`);
 * `views` and `class views` are read by `file.views()` through `viewsProperty`
 * and `classViewsProperty`, and `component fields` by `file.hasA()` through
 * `componentsProperty`. Any entry here that no setting names would be stored and
 * edited faithfully but inherit nothing.
 */
const BASE_CHARACTERISTICS = ['is a', 'characteristics', 'type of', 'views',
	'class views', 'component fields'];

/*
 * The three streams a class base can be read through - his note
 * `Improvements to Class Bases`, 2026-09-05.
 *
 *   is a     an instance of the class, or of any class below it
 *   has a    a note naming the class in one of its component fields
 *   type of  the class itself and every class below it
 *
 * A table rather than three branches, for the reason `FUNCTIONS` is one in
 * Dynamic Viewer: a fourth stream would join by adding a row. The order here is
 * the order they are written in and the order they are drawn in, so a reading
 * has one spelling and two bases carrying the same one are byte-identical.
 *
 * `fn` names the base function each stream already had. **No stream needed a new
 * one**, and only `inheritsFromDistance` had to be added for the exact reading -
 * which is `isADistance` and `hasADistance`'s own definition applied to the
 * third relation, not a new idea.
 */
const BASE_STREAMS = [
	{ id: 'is a', fn: 'isA', label: 'is a', icon: 'git-branch' },
	{ id: 'has a', fn: 'hasA', label: 'has a', icon: 'git-branch-plus' },
	{ id: 'type of', fn: 'inheritsFrom', label: 'type of', icon: 'git-merge' },
];

/*
 * A YAML scalar in single quotes, which is what a generated base already uses
 * for `'!file.inFolder("...")'` - a leading `!` is a tag indicator, and single
 * quotes leave the double quotes inside the expression alone.
 */
function yamlSingleQuoted(value) {
	return "'" + String(value === null || value === undefined ? '' : value)
		.replace(/'/g, "''") + "'";
}

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
	 * The property naming the bases a class's **instances** are looked at through.
	 * A base characteristic like the three above: inherited by the walk and never
	 * written into an instance. Emptying it turns this half of file.views() off.
	 */
	viewsProperty: 'views',
	/*
	 * The other half: the bases a class's **subtypes** are looked at through.
	 *
	 * The two-stream split (2026-09-05, his note `Class inheritance vs instance
	 * inheritance`, second proposal): *"If a view is given in `dviews` then the
	 * instances of this class will have that view in the `views` field; similarly,
	 * if a view is given in `class dviews`, then any sub type of that class will
	 * have that view."* Two audiences, two lists — the same decision as
	 * `characteristics` against `component fields`, and as `isA` against `hasA`:
	 * one declaration list per stream, never one list with a flag on each entry.
	 *
	 * His two reasons, both of which need the split rather than a cleverer walk:
	 * *"I want to avoid classes containing views that are only meant for their
	 * instances, and I want to be able to give special views to classes that won't
	 * appear in anything instantiating that class."*
	 *
	 * **He decided against renaming `views`** ("do the two stream split, but leave
	 * out the rename"), so the instance stream keeps the name it had — which also
	 * means the 3 notes already carrying one stay exactly where they are.
	 */
	classViewsProperty: 'class views',
	/*
	 * Which end of the inheritance chain `file.views()` answers with first.
	 *
	 * On: the furthest class first, so a note's own `views:` and its nearest class
	 * come last. Off: nearest first, which is the order it always had.
	 *
	 * It lives here rather than in Dynamic Viewer, and that is his correction
	 * (2026-09-03): a dynamic view shows the list the function gives it, in the
	 * order it gives it, and does not sort. What is being ordered is this
	 * function's answer, so the choice belongs to whoever answers.
	 */
	viewsFurthestFirst: true,
	/*
	 * The property listing a class's **component fields**.
	 *
	 * A base characteristic like the four above, and the same *shape* as
	 * `characteristics`: a list of characteristic links, `[[∘ type]]`. The
	 * difference is what a value in one of those fields means. An ordinary
	 * characteristic holds a subject — a word, a number, a date. A component field
	 * holds a **class**, and the note carrying it takes on that class's
	 * characteristics.
	 *
	 * From his note `Components` (2026-09-03): *"is a is no longer the only way in
	 * which a note's metadata can be changed … I am opening the door for `is a`
	 * relationships going through different streams."* A component field is that
	 * stream, and it is named — `type: [[Effort]]` says which door the
	 * characteristics came through, where a second `is a` would not.
	 *
	 * Emptying this turns file.hasA() off.
	 */
	componentsProperty: 'component fields',
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
	/*
	 * `cover image` joined them 2026-08-24, at his ask and "for later purpose".
	 * It is the first entry that Obsidian does **not** own, and the first the
	 * model would otherwise have an opinion about — the README argues, correctly
	 * under this model, that a property every Artist carries *is* a characteristic
	 * of Artist. He has decided it is not one, which is exactly what this setting
	 * is for.
	 */
	ignoredProperties: ['tags', 'aliases', 'cssclasses', 'cssclass', 'publish',
		'permalink', 'cover image'],
	/*
	 * The two tags a class note wears, exactly one of them — his note
	 * `Difference between classes and components`, 2026-09-05: *"a new tag be
	 * added, `#component`, and that this tag be used for all components."*
	 *
	 * A component is a class in every respect but one: it is never instantiated,
	 * so it has no template. Both tags therefore make a note a class note, and
	 * which one it wears is **derived, not read** — the same rule as
	 * `#characteristic` / `#componentfield` a day earlier, for the same reason.
	 * A class is a component because a component field permits it; the tag
	 * reports that. Read the other way round it would be a second declaration,
	 * free to disagree with the field that declares it.
	 *
	 * Emptying either turns that half of the enforcement off.
	 */
	classTag: 'class',
	componentTag: 'component',
	/*
	 * The tags on a characteristic note, which are the whole of what distinguishes
	 * the two kinds — his sentence, 2026-09-04: *"at the base component fields and
	 * characteristics are treated and created in the same way besides the tags."*
	 *
	 * So a characteristic note carries exactly one of them, and which one is not
	 * written on the note by hand: it is decided by whether some class lists it
	 * under `component fields`, and Update swaps it when that changes. **Reading
	 * them the other way round would be the mistake** — the tag would then be a
	 * second place a component field is declared, free to disagree with the class
	 * that declares it.
	 *
	 * Emptying one turns that half of the enforcement off.
	 */
	characteristicTag: 'characteristic',
	componentFieldTag: 'componentfield',
	/*
	 * How the panel orders its classes. 'descent' puts a class below everything
	 * it descends from, then sorts alphabetically within a generation; 'name'
	 * is plain alphabetical.
	 */
	sortClasses: 'name',

	/*
	 * How the panel lays the classes out.
	 *
	 *   'list'        one after another, sorted — what it has always done
	 *   'brackets'    every node in one column, a lane per connexion
	 *   'compressed'  the same, with the wires out of one class sharing a lane
	 *   'tree'        a git graph of the `type of` chains, one class per row
	 */
	classLayout: 'list',

	/*
	 * Which side of the cards the tree's rails run down. Left by default, the way
	 * a commit graph is drawn — but the panel usually lives in the right sidebar,
	 * where the other side puts the rails against the window edge and lets the
	 * name be the first thing read.
	 */
	treeRailSide: 'left',

	/*
	 * How strongly a node stands out when it is not on the highlighted line.
	 *
	 *   'line'    the same colour as the rails, so the graph reads as one drawing
	 *   'strong'  the muted text colour, a shade darker than the rails
	 *
	 * 'line' by default: the dots and the lines are one picture, and a node that
	 * is louder than the line running into it competes with the highlight, which
	 * is the only thing in the panel that should be shouting.
	 */
	treeDotTone: 'line',

	/*
	 * What is inside a node.
	 *
	 *   'transparent'  nothing — the rail shows through, and the node is a ring
	 *   'solid'        the panel colour, so the node sits over the line
	 *
	 * Only the hollow ones are affected, and only two nodes are: the class the
	 * open note is about and the class under the pointer, whose fill is the whole
	 * of what marks them. The root empties with the rest — its accent ring says
	 * what it is — and so does a class with two parents, whose second wire says
	 * what it is.
	 */
	treeDotFill: 'transparent',

	/* Whether a connexion turns in a curve or in a right angle. */
	treeCorners: 'rounded',

	/*
	 * What a row does when it holds more than fits across the panel — both a row
	 * of chips and the card's own top row.
	 *
	 *   'scroll'  each row scrolls on its own, one line at a time
	 *   'panel'   every row keeps its full width and one bar at the bottom of the
	 *             panel moves everything together
	 *   'wrap'    the chips wrap onto more lines and the card is only as wide as
	 *             its top line needs
	 *   'fit'     nothing is wider than the panel: the chips wrap, and so does the
	 *             top line — between its items, never inside one
	 *
	 * No item is ever squeezed under any of them. A badge reading IS over A is the
	 * row breaking a word; a badge moved whole onto a second line is the row
	 * breaking where it is allowed to, and only 'fit' does that.
	 *
	 * Wrapping shows everything at once and is why it was the only behaviour for
	 * a long time; the cost is that a class with a dozen characteristics makes a
	 * card taller than the panel, and the rows below it are then off screen.
	 */
	cardOverflow: 'scroll',

	/*
	 * Where a class's actions live — his ask, `Moving options for classes.md`.
	 *
	 *   'card'     an icon per action on every card's top line, which is what the
	 *              panel has always done
	 *   'toolbar'  one row of them above all the classes, acting on the class the
	 *              active note is about
	 *
	 * The toolbar is one row instead of one per class, so the top line is left to
	 * say what the class *is* — its symbol, its name, its rating, its badges —
	 * rather than what can be done to it. The cost is that it only ever acts on
	 * the highlighted class: with nothing highlighted there is nothing to act on,
	 * and the row says so instead of offering buttons that would have no subject.
	 *
	 * Two things move with it, because they are the same question. The note icon
	 * goes, and the class **name** opens the note instead — the toolbar is where
	 * the file buttons live now, and one of them opening the note you are already
	 * looking at the row of would be the odd one out. And the three-dot menu goes
	 * to the far right of the card, into the space the icons left.
	 */
	classActions: 'card',

	/*
	 * What the base button does when several classes are selected at once — his
	 * `Moving options for classes.md`, under *The future of this idea*.
	 *
	 *   'static'   the button greys out. Two bases cannot be opened at once, and
	 *              this is the answer that writes nothing.
	 *   'dynamic'  one base, `<Bases>/Dynamic Base.base`, is rewritten to show the
	 *              instances of whichever classes are selected, and opened.
	 *
	 * Static by default because the other one writes a file. The dynamic base is
	 * the single exception to *nothing is written until an Update plan is
	 * confirmed*: it exists only to be regenerated, holds nothing that is not
	 * derived from the selection, and is refused outright if a file of that name
	 * turns up that this plugin did not create.
	 */
	multiClassBase: 'static',

	/*
	 * Whether opening a note resets the selection to that note's own classes, his
	 * ask 2026-08-27 — on by default.
	 *
	 * Off is what `Moving options for classes.md` first described: the set is kept
	 * when the panel hands itself back to active-note tracking, so the mode button
	 * returns you to exactly what you had picked. On, the selection instead
	 * follows you — whichever note you open becomes the selection, so switching to
	 * it always starts from where you are standing and ctrl-click extends outward
	 * from there.
	 *
	 * The trigger is the same one either way: the **active file changing**. It is
	 * not a click on the note you already have open, because clicking a dot in the
	 * sidebar makes that leaf active and a click-anywhere trigger would undo the
	 * very click that selected.
	 */
	resetSelectionOnNote: true,

	/*
	 * Whether unselecting every class is a state the panel will sit in, his ask
	 * 2026-08-27 — on by default.
	 *
	 * On: emptying the selection, with the × or by ctrl-clicking the last one off,
	 * leaves **nothing** highlighted, and it stays that way until he clicks back
	 * into a note. *"It should only be selected if the user clicks on it again."*
	 * The last selected class is not special — it can be unselected like any
	 * other, which is his N.B.
	 *
	 * Off: the panel hands itself straight back to the active note the moment the
	 * set is empty, so something is always highlighted while the note he is
	 * reading is about a class. That was the only behaviour until now, on the
	 * grounds that nothing selected is not a state worth being in — which is true
	 * of a state you land in by accident and false of one you asked for.
	 */
	emptySelectionStands: true,

	/*
	 * Whether the wire to a second parent is dashed. Dashed says which of a
	 * class's two parents the rows are ordered by; solid says the two parentages
	 * are the same kind of thing, which they are — `type of` is `type of`, and
	 * which one the layout hangs the class from is the drawing's business, not
	 * the vault's. Both readings are defensible, so it is a setting.
	 */
	treeWireDash: 'dashed',

	/*
	 * How far the highlight follows. `all` lights every wire leading to the
	 * highlighted class — both parents of a class that has two, and their parents
	 * in turn; `descent` lights only the single line the rows are ordered by,
	 * which is what the panel did before there were wires to follow.
	 */
	treeLitPaths: 'all',

	/*
	 * Characteristic notes he has renamed, waiting to be carried through to the
	 * property key on every note that holds one: `[{ from, to }]`.
	 *
	 * Kept in settings rather than in memory because the work outlives the
	 * session — he can rename a note today and press Update tomorrow, and a
	 * rename the plugin has forgotten leaves the old key stranded with its value
	 * and the new one arriving empty beside it.
	 */
	pendingPropertyRenames: [],
	/*
	 * Values he has renamed, waiting to be carried through to every note that
	 * holds one: `[{ characteristic, from, to }]`.
	 *
	 * The same shape as the renames above and kept for the same reason — the work
	 * outlives the session. One level down, though: the **key stays** and what is
	 * written under it moves, scoped to the one characteristic. That scope is the
	 * whole difference between this and a search and replace — renaming
	 * `status: implemented` must not touch `category: implemented`, and must not
	 * touch the word `implemented` in a sentence.
	 */
	pendingValueRenames: [],
	/*
	 * Right-click a property's value in a note to rename it there.
	 *
	 * On, because the note is where you notice a value needs renaming and the
	 * panel is a detour from it. A switch rather than always-on because it does
	 * take over a right-click Electron would otherwise answer, and taking over
	 * one of the app's own gestures is a real choice, not an implementation
	 * detail. The key half of the row is never touched either way.
	 */
	renameValueFromProperties: true,

	/*
	 * Whether a property's value field offers what its characteristic permits,
	 * rather than what the vault happens to hold already. On, because a
	 * characteristic that has said what its values are has answered the question
	 * the field is asking. See registerValueSuggestions.
	 */
	suggestPossibleValues: true,

	/*
	 * And whether a characteristic naming a *class* offers that class's
	 * instances as well. **Off**, and his call (2026-08-30) — it was on for a few
	 * hours, and on his own vault `∘ project.md` naming `[[Project]]` filled the
	 * field with 84 notes where the vault holds 8 values under `project`. The
	 * eight were all there and all buried, which for a list you pick from is the
	 * same thing.
	 *
	 * It is a separate switch rather than part of the one above because it is a
	 * separate question. The one above asks whether a *listed* value beats what
	 * the vault happens to hold; this asks whether a *type* should be enumerated
	 * at all, and the answer differs by how many instances a class has — which is
	 * something only he can weigh, class by class and vault by vault.
	 */
	suggestClassInstances: false,
	/* Whether the panel follows whatever note is open. */
	followActiveNote: true,
	/*
	 * Is Artist an Artist? Off, because a class is not one of its own
	 * instances. Used by file.isA() and file.inheritsFrom().
	 */
	classIsItsOwnInstance: false,
	/*
	 * Off: `is a` gives characteristics to the note that declares it and stops
	 * there, so passing them further down needs `type of`. On: an instance also
	 * receives whatever its class carries through its own `is a`, so a chain of
	 * `is a` links hands characteristics down without `type of` at every step.
	 *
	 * **He chose off, 2026-08-19**, and it is the better default for the reason he
	 * gave: it is what a programming language does.
	 *
	 *     class Dog extends Animal   // type of — Dog's instances get Animal's
	 *     Dog rex = new Dog()        // is a    — rex is a leaf
	 *
	 * An instance is terminal. No language lets `instanceof` act as an inheritance
	 * edge, because an object is not a type. Turning this on makes `is a` do
	 * exactly that - which happens to give the right answer in an Obsidian vault
	 * only because the class notes are themselves notes.
	 */
	inheritCarried: false,
	/*
	 * A class every note belongs to without saying so. Empty turns it off.
	 *
	 * This existed once and he had me remove it (2026-08-16), for a good reason
	 * that is worth not repeating: the implicit edge lived in the panel and not in
	 * `file.isA()`, so a base disagreed with the card beside it. It is safe to
	 * offer again only because there is now ONE place that answers "what is above
	 * this note" - `rootAbove()` - and every walk asks it.
	 *
	 * The point is that no file mentions it. Nothing is written, nothing is
	 * linked, and the root's characteristics simply reach everything.
	 */
	rootClass: '',
	/*
	 * Characteristic notes no class lists any more. Sent to Obsidian's trash on
	 * Update, never hard-deleted, and only once nothing at all still refers to
	 * them.
	 */
	deleteUnusedCharacteristics: true,
	/* BASE_CHARACTERISTICS, above. Not a choice: see the comment there. */
	logicProperties: BASE_CHARACTERISTICS.slice(),
	/*
	 * Base characteristics the plugin no longer names, and stray ones a stored
	 * settings file still carried. Kept so Update can clear them off the classes
	 * that still carry them - otherwise dropping one would silently leave an
	 * orphan key in every class note.
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

	/*
	 * The **Class base** button in Obsidian's own base toolbar, on a base this
	 * plugin generated: what a class base is, the three streams that say which
	 * notes it holds and which classes each one drops, *exact matches only*, and
	 * the reset.
	 *
	 * On, because it is the feature. A switch rather than always-on for the same
	 * reason the value rename has one: this puts a control of ours inside one of
	 * the app's own toolbars, and adding to someone else's UI is a real choice
	 * rather than an implementation detail.
	 */
	classBaseToolbar: true,

	/*
	 * His option, in his own words: *there should be an option in the settings to
	 * make it so that only one can be on at a time*.
	 *
	 * **Off**, which is the one place a setting of his ships disabled, and it is
	 * because he said so: the sentence the note spends its first paragraph on is
	 * *they can all be on at once*, and this is named as the restriction on top of
	 * it. On, turning a stream on turns the others off, so the three read as a
	 * choice of one rather than as three switches.
	 *
	 * Either way a base keeps **at least one** stream: the last one on cannot be
	 * turned off. A reading with no streams is not a base about nothing - it is a
	 * clause this plugin can no longer recognise, and the way back would be the
	 * reset.
	 */
	oneStreamAtATime: false,

	/*
	 * A third sort direction in any base: the order a characteristic note lists
	 * its values in, beside A → Z and Z → A.
	 *
	 * On, because it is the feature. A switch for the same reason the Class base
	 * button has one — it adds an entry to two of Obsidian's own menus, and it
	 * changes how a base sorts — and because turning it off has to leave every
	 * base still working, which it does: the file says `direction: ASC`, so a base
	 * in declared order falls back to A → Z rather than losing its sort.
	 */

	/*
	 * How the properties of a note are laid out.
	 *
	 *   'type'  by property type, then alphabetically — one flat run
	 *   'class' grouped by the class each characteristic was inherited from,
	 *           nearest first, and by type then name inside each group
	 *
	 * 'type' is the default because it is what every note in the vault is
	 * already in, and changing it retroactively rewrites all of them.
	 */
	propertyOrder: 'type',

	/*
	 * Which property groups are folded away, by class name. Global rather than
	 * per note on purpose: a group is folded because that whole class is
	 * boilerplate you do not want to look at — the root's six housekeeping
	 * properties, most often — and wanting that on one note means wanting it on
	 * all of them.
	 */
	collapsedGroups: [],

	/*
	 * Hide Obsidian's "Add property" button and reach the same thing by hotkey
	 * instead. Off by default: taking away a button is not something to do to
	 * someone who has not asked for it.
	 */
	hideAddProperty: false,

	/*
	 * Whether a class's section reads "Person characteristics" or just "Person".
	 * On, because the heading is over the properties a Person carries rather than
	 * over a Person — but it is his wording to keep or drop.
	 */
	nameSectionsAsCharacteristics: true,

	/*
	 * Every note carries every base characteristic, empty or not. Off by default,
	 * which is the behaviour that has always been: a note that is not a class
	 * carries `type of` only when it has something to say with it, and blank ones
	 * are cleared out. On, that clearing stops and the missing ones are added.
	 */
	allNotesCarryBase: false,

	/*
	 * The `+N` on each class's row: how many characteristics it declares that
	 * nothing above it already does. On, because it is what he asked for; a
	 * setting because it is one more thing on a row that is already busy.
	 */
	showClassNovelty: true,

	/*
	 * The property a class's symbol lives in, on the class note itself. The
	 * symbol shows before the name in the panel and before the class's section in
	 * the properties view, and it is **inherited** — a class with none shows the
	 * nearest one above it.
	 *
	 * Emptying this turns the whole convention off, the way emptying
	 * `characteristicPrefix` does.
	 *
	 * `symbol` rather than his `unique character` from master_vault: that one is a
	 * property of a *note* (• before a name, ‣ before a word), and this is a
	 * property of a class. Anyone who wants them to be the same thing can say so
	 * here.
	 */
	symbolProperty: 'symbol',

	/*
	 * Write an inherited symbol onto the class that inherits it, rather than only
	 * resolving it when something asks.
	 *
	 * His call, 2026-08-24: *"I want the symbol to follow inheritance… maybe you
	 * should automatically add the symbol to the child classes."* The walk already
	 * looked back through every generation; this puts the answer in the file, so a
	 * class's symbol is a fact about that class's note rather than something only
	 * the plugin knows.
	 *
	 * The copies are **remembered** (`symbolWrites` in `data.json`) so they stay
	 * copies: one the plugin wrote is updated when the ancestor's changes and
	 * removed when the ancestor's goes, while one you set yourself is never
	 * touched. Without that record a materialised value is indistinguishable from a
	 * deliberate one — which is the flattening trap `OOF 0.1` fell into, and the
	 * reason this is the only place in the plugin that keeps a note of what it
	 * wrote.
	 */
	writeInheritedSymbols: true,


	/*
	 * *Strict defaults also override differing values* was here until 2026-08-30.
	 * It answered, once for the whole vault, what a strict default should do to a
	 * value that is neither empty nor the strict one — fill only, or replace.
	 *
	 * His five columns answer it per row instead: **None replacement** fills an
	 * empty value and nothing else, **Value must be** replaces anything that is
	 * not it. A switch that says what a column says is the duplication this plugin
	 * spent the day removing, so it went with the column it qualified.
	 */

	/*
	 * Every characteristic note carries the defaults table.
	 *
	 * **On** — his call, 2026-08-24: *"can you make it so that this table is added
	 * automatically to all characteristic notes"*. `Default values.md` says the
	 * same thing in the first line of the design: *each* characteristic has one,
	 * so a characteristic without one is out of step exactly the way a note
	 * missing a property is, and Update's job is to say so.
	 *
	 * It stays a setting because it is the only thing in the plugin that writes
	 * into a note's **body**, and someone may reasonably want that never to
	 * happen. Off, existing notes are left alone and only the ones Update creates
	 * carry a table.
	 *
	 * On or off, nothing is written without a confirmed plan, and the write is an
	 * append — see `add-defaults-table`.
	 */
	seedDefaultsTable: true,

	/*
	 * The name a new note is given, as a Moment format string. The plugin writes
	 * a Templater block carrying it into every class template, and Templater does
	 * the renaming when the template is applied — his call, 2026-08-24: *"the
	 * chosen format will be added to every template via Templater"*.
	 *
	 * The time rather than a counter, because the name has to be unique and a
	 * counter would have to read the vault to know where it was up to. Seconds are
	 * finer than a person can create notes, but the block still checks for a
	 * collision and suffixes rather than letting the rename throw.
	 *
	 * Emptying it turns the convention off the way emptying `characteristicPrefix`
	 * does, and Update then takes the blocks back out again.
	 */
	uniqueNameFormat: 'YYYY-MM-DD dddd — HH.mm.ss',

	/*
	 * What the class diagram draws. Five flat keys rather than one nested object,
	 * because `loadSettings` merges with `Object.assign`: a stored object would
	 * replace this one wholesale, and a key added later would arrive already
	 * missing from every vault that had ever opened the tab.
	 *
	 * The defaults are what the diagram is *for*. Inherited rows and component
	 * edges are on because a class you cannot see the consequences of is a name in
	 * a box; the implicit root edge is off because it is true of every class at
	 * once and drawing it says nothing; following is off because the tab opens to
	 * the whole vault, which is the view you asked for by opening it.
	 */
	umlShowInherited: true,
	umlShowComponents: true,
	umlShowCounts: true,
	umlShowRoot: false,
	umlFollowActiveNote: false,
};

const MAX_DEPTH = 64;

/*
 * The three headings that name something other than a class.
 *
 * `NO_CLASS` and `NATIVE` are deliberately not near-synonyms: the first is a
 * real characteristic that no class in the chain hands down — something to look
 * at — and the second is a field Obsidian itself owns, which the class system
 * has no opinion about at all. His word for that second one is "native", which
 * is better than what I had: it says where the property comes *from* rather
 * than only what it is not.
 */
const BASE_LABEL = 'Base characteristics';
const NO_CLASS_LABEL = 'Not from a class';
const NATIVE_LABEL = 'Native attributes';

/* What the section was called for one version, so a fold survives the rename. */
const RETIRED_NATIVE_LABEL = 'Nothing to do with classes';

/* ------------------------------------------------------------------ helpers */

function toArray(value) {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/*
 * One row of a class box: `name : type`, which is UML's own spelling of an
 * attribute, with the type left off when the characteristic note does not give
 * one — an empty `property type` means "no constraint", so `name :` would be
 * asserting something the vault does not say.
 *
 * The diamond is what tells a component field from a characteristic inside the
 * compartment. It is the same mark the composition edge carries, so a field with
 * no `possible values` — a row with no edge — still reads as the same kind of
 * thing as one that has them.
 */
function umlRowText(row) {
	const lead = row.kind === 'component' ? '◆ ' : '';
	return lead + row.name + (row.type ? ' : ' + row.type : '');
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

/*
 * A `views:` entry, reduced to the link it names - and, unlike `linkName`, the
 * subpath is kept. `[[Improvement Base.base#dynamic project]]` names one view
 * of one base, and dropping the `#` half would name the base's default view
 * instead, which is a different thing to look at.
 */
function viewLink(value) {
	if (value === null || value === undefined) return null;

	let text = typeof value === 'string' ? value : String(value);
	text = text.trim();
	if (!text) return null;

	const wikilink = text.match(/^!?\[\[(.+)\]\]$/);
	if (wikilink) text = wikilink[1];

	const pipe = text.indexOf('|');
	if (pipe !== -1) text = text.slice(0, pipe);

	text = text.trim();
	return text || null;
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

/* A `.base`, whose views a `views` row offers. */
function isBaseFile(file) {
	return file instanceof TFile && file.extension === 'base';
}

function asLink(name) {
	return '[[' + name + ']]';
}

/*
 * A discrepancy's identity, for remembering that he has dismissed one.
 *
 * Not the label: rewording a message later would resurrect everything he had
 * already dealt with. But kind plus subject alone is not enough either - two
 * properties on one note gave `conflict::Base Formulas Plugin` twice, so
 * dismissing one silently dismissed the other, and bringing one back brought
 * both. The property and the path are what tell those apart, and neither
 * changes when the wording does.
 */
function discrepancyId(discrepancy) {
	return [
		discrepancy.kind,
		discrepancy.subject || '',
		discrepancy.property || '',
		discrepancy.path || '',
	].join('::');
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

/*
 * The moment format his Templater expression asks for, so a back-filled value is
 * written the same way Templater would have written it.
 */
function templaterDateFormat(expression) {
    var match = /tp\.date\.now\(\s*["']([^"']+)["']/.exec(String(expression || ''));
    return match ? match[1] : 'YYYY-MM-DD HH:mm';
}

/* Enough of moment's vocabulary for the formats a `created` field uses. */
function formatMoment(date, format) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return String(format)
        .replace(/YYYY/g, String(date.getFullYear()))
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/DD/g, pad(date.getDate()))
        .replace(/HH/g, pad(date.getHours()))
        .replace(/mm/g, pad(date.getMinutes()))
        .replace(/ss/g, pad(date.getSeconds()));
}

/* Was this `possible values` entry written as a link, rather than as a word? */
function isWikiLink(entry) {
	return typeof entry === 'string' && /^\s*!?\[\[.+\]\]\s*$/.test(entry.trim());
}

/*
 * One entry of a property with `from` replaced by `to`, or null when this entry
 * is not the one being renamed — so a list keeps every neighbour exactly as
 * written, and a property holding something else is left alone entirely.
 *
 * The comparison is case-insensitive, which is what `possible values` already
 * admits: a note saying `Implemented` holds the same value as one saying
 * `implemented`, and leaving it behind would be the surprise. A rename that only
 * changes case is therefore a real rename, and works.
 *
 * **A wikilink never matches a bare word.** `[[implemented]]` names a note, and
 * renaming a note is Obsidian's job — it rewrites every link that points at it,
 * which is exactly the thing this pass cannot do.
 */
function renamesTo(entry, from, to) {
	if (typeof entry !== 'string') return null;
	const text = entry.trim();
	if (!text || isWikiLink(text)) return null;
	if (text.toLowerCase() !== String(from).trim().toLowerCase()) return null;
	return to;
}

/* The whole value, scalar or list, or null when nothing in it was that value. */
function renameWithin(value, from, to) {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const renamed = renamesTo(entry, from, to);
			if (renamed === null) return entry;
			changed = true;
			return renamed;
		});
		return changed ? next : null;
	}
	return renamesTo(value, from, to);
}

/* One rename, named — the characteristic is half of its identity. */
function valueRenameKey(characteristic, value) {
	return String(characteristic) + '::' + String(value).trim().toLowerCase();
}

/*
 * The word as a whole word, anywhere in a body or a base file.
 *
 * Deliberately only a *report*: this is the fuzzy half of a search and replace,
 * and the reason the rename itself never uses it. A base filter is an expression
 * and a sentence is prose; both are named so nothing breaks quietly, and neither
 * is rewritten.
 */
function mentionsWord(text, word) {
	const clean = String(word).trim();
	if (!clean) return false;
	const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp('(^|[^\\w-])' + escaped + '($|[^\\w-])', 'i').test(String(text));
}

/* A note's body, without the frontmatter block the plugin reads separately. */
function withoutFrontmatter(text) {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(String(text));
	return match ? String(text).slice(match[0].length) : String(text);
}

/*
 * One cell of one table row rewritten, and only when it holds exactly the word
 * being renamed. Padding on either side is kept, so a table he has aligned by
 * hand stays aligned, and a `|` inside a cell is left escaped — the split only
 * cuts at the pipes that are really separators.
 */
function rewriteTableCell(line, index, from, to) {
	const parts = String(line).split(/(?<!\\)\|/);
	/* A leading `|` gives an empty first part, so the cells start one along. */
	const at = index + (/^\s*\|/.test(line) ? 1 : 0);
	if (at >= parts.length) return null;

	const cell = parts[at];
	if (cell.replace(/\\\|/g, '|').trim().toLowerCase()
		!== String(from).trim().toLowerCase()) return null;

	parts[at] = cell.match(/^\s*/)[0]
		+ String(to).replace(/\|/g, '\\|')
		+ cell.match(/\s*$/)[0];
	return parts.join('|');
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

/*
 * The other direction, for reading a scalar back off a line the file already
 * has — a view's `name:`. Only the two quotings `yamlScalar` can write are
 * undone, because this is used to *label* a view and never to write one back.
 */
function unquoteScalar(value) {
	const text = String(value === null || value === undefined ? '' : value).trim();
	const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
	if (!quoted) return text;
	return quoted[1] === '"'
		? quoted[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
		: quoted[2].replace(/''/g, "'");
}

function sameNameList(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/* ----- class symbols ----------------------------------------------------- */

/*
 * The symbols offered in the panel's picker. Characters rather than emoji,
 * because that is the ask — and because they sit on the text baseline at the
 * weight of the surrounding UI instead of dropping a coloured sticker into it.
 * His own vault already works this way: `•` before a name, `‣` before a word,
 * `∘` before a characteristic.
 *
 * **Grouped and searchable, with a word list per glyph** (2026-08-30, his ask
 * for kanji and for a caret). It was a flat, unsearchable array of sixty while
 * sixty was a screenful; it is not any more, and an unsearchable grid of a
 * hundred and sixty is the alphabetical-icons problem in miniature — the one you
 * would have picked is three screens from the one you thought of. The words are
 * also what the hover says, which matters most for the kanji: a grid of
 * ideographs with no gloss is a grid you cannot read.
 *
 * **Every glyph the flat array held is still here**, redistributed. Dropping one
 * would strand a class already marked with it — the picker decides which tab to
 * open on by asking whether the current symbol is in this list, so a missing
 * glyph would send a typographic mark to the emoji tab.
 */
const SYMBOL_GROUPS = [
	['Shapes', [
		['●', 'circle filled dot round'], ['■', 'square filled box'],
		['◆', 'diamond filled'], ['▲', 'triangle up filled point'],
		['▼', 'triangle down filled point'], ['★', 'star filled'],
		['○', 'circle outline ring round'], ['□', 'square outline box'],
		['◇', 'diamond outline'], ['△', 'triangle up outline'],
		['▽', 'triangle down outline'], ['☆', 'star outline'],
		['◈', 'diamond nested inside'], ['◉', 'circle fisheye target dot'],
		['◎', 'circle bullseye ring double'], ['⬡', 'hexagon outline'],
		['⬢', 'hexagon filled'], ['⟡', 'diamond white lozenge'],
		['◐', 'half circle left'], ['◑', 'half circle right'],
		['◒', 'half circle bottom'], ['◓', 'half circle top'],
		['⊕', 'circle plus add oplus'], ['⊗', 'circle cross times otimes'],
	]],
	['Marks', [
		['•', 'bullet dot point'], ['‣', 'triangular bullet word'],
		['∘', 'ring operator characteristic small circle'],
		['◦', 'white bullet hollow dot'], ['»', 'guillemet quote next arrow'],
		['§', 'section paragraph clause'], ['¶', 'pilcrow paragraph'],
		['✦', 'star four pointed filled sparkle'],
		['✧', 'star four pointed outline sparkle'],
		['✱', 'asterisk heavy note'], ['✳', 'asterisk eight spoked note'],
		['❖', 'diamond ornament floral'], ['✚', 'plus heavy cross add'],
		['†', 'dagger obelisk footnote'], ['‡', 'double dagger footnote'],
		['※', 'reference mark kome note'], ['‽', 'interrobang surprise question'],
		['⁂', 'asterism three stars break'],
	]],
	['Cursors', [
		/*
		 * The caret, both of the things that word means: the proofreader's mark
		 * that says *insert here*, and the bar the app blinks at you while you
		 * type. He asked for the second by describing it — "the thing that
		 * appears on screen to indicate the editing place" — so both readings
		 * carry the same words, and either spelling of it finds the row.
		 */
		['‸', 'caret carrot insert insertion mark editing point'],
		['⁁', 'caret carrot insertion point insert editing'],
		['^', 'caret carrot circumflex hat up editing point'],
		['⌃', 'caret carrot arrowhead up control editing'],
		['▏', 'cursor caret carrot bar text editing point line'],
		['▎', 'cursor caret carrot bar thick text editing'],
		['▌', 'cursor caret carrot block half text editing'],
		['▮', 'cursor caret carrot block filled text editing'],
		['❘', 'cursor caret carrot bar vertical light editing'],
		['⌶', 'cursor i-beam pointer mouse text editing'],
		['⎀', 'cursor insertion insert caret carrot editing point'],
	]],
	['Arrows', [
		['↑', 'up arrow north rise'], ['↓', 'down arrow south fall'],
		['→', 'right arrow next forward east'],
		['←', 'left arrow back previous west'],
		['↗', 'up right arrow growth increase'],
		['↘', 'down right arrow decrease'],
		['↻', 'refresh cycle clockwise repeat loop'],
		['↺', 'undo cycle anticlockwise repeat loop'],
		['⇄', 'swap exchange both ways sync'],
		['⇅', 'sort up down both ways'],
		['↳', 'child branch nested under sub'],
		['∞', 'infinity endless forever loop'],
	]],
	['Things', [
		['✎', 'pencil write edit draft'], ['✂', 'scissors cut trim'],
		['⚑', 'flag mark pin milestone'], ['⚙', 'gear cog settings machine'],
		['☗', 'shogi piece game house'], ['♦', 'diamond suit card'],
		['⌘', 'command key place of interest loop'],
		['⌂', 'house home root'], ['⏻', 'power on off toggle'],
		['⏱', 'stopwatch timer duration'], ['⌗', 'hash number sharp tag'],
		['⌾', 'circle position target place'],
		['♠', 'spade suit card'], ['♣', 'club suit card'],
		['♥', 'heart suit card love'], ['♪', 'music note sound song'],
		['♯', 'sharp music raise'], ['⚗', 'alembic chemistry experiment'],
		['⚖', 'scales balance justice weigh'],
		['⌬', 'benzene ring hexagon chemistry'],
	]],
	/*
	 * Kanji (2026-08-30, his ask). They belong in this tab rather than the emoji
	 * one for the reason that tab exists at all: an ideograph is one character
	 * drawn in the text colour at the text weight, which is what a class mark is
	 * here — it is a *word*, not a sticker. They are also the densest marks
	 * available: 森 says forest in one square.
	 *
	 * Four groups by meaning rather than by stroke count or reading, because the
	 * question in front of the picker is "what is this class about", never "how
	 * many strokes". Each carries its English gloss and its romaji, so the row is
	 * reachable whether he thinks `mori` or `forest`.
	 */
	['Kanji · nature', [
		['日', 'sun day light nichi hi'], ['月', 'moon month tsuki getsu'],
		['星', 'star hoshi sei'], ['空', 'sky empty air sora kuu'],
		['天', 'heaven sky ten'], ['山', 'mountain yama san'],
		['川', 'river stream kawa sen'], ['海', 'sea ocean umi kai'],
		['木', 'tree wood ki moku'], ['林', 'woods grove hayashi'],
		['森', 'forest mori'], ['花', 'flower blossom hana ka'],
		['草', 'grass plant herb kusa'], ['石', 'stone rock ishi seki'],
		['土', 'earth soil ground tsuchi do'], ['田', 'field rice paddy ta den'],
		['雨', 'rain ame u'], ['雪', 'snow yuki setsu'],
		['風', 'wind air style kaze fuu'], ['雲', 'cloud kumo un'],
		['火', 'fire flame hi ka'], ['水', 'water mizu sui'],
		['金', 'gold metal money kane kin'], ['夜', 'night evening yoru ya'],
	]],
	['Kanji · people', [
		['人', 'person people human hito jin'], ['私', 'i me self private watashi'],
		['友', 'friend companion tomo yuu'], ['家', 'house home family ie ka'],
		['子', 'child kid ko shi'], ['女', 'woman female onna jo'],
		['男', 'man male otoko dan'], ['王', 'king royal ruler ou'],
		['名', 'name title na mei'], ['心', 'heart mind spirit kokoro shin'],
		['体', 'body form karada tai'], ['目', 'eye see look me moku'],
		['口', 'mouth opening kuchi kou'], ['手', 'hand te shu'],
		['足', 'foot leg enough ashi soku'], ['声', 'voice sound koe sei'],
		['命', 'life command fate inochi mei'], ['神', 'god spirit divine kami shin'],
	]],
	['Kanji · mind', [
		['気', 'spirit energy air mood ki'], ['道', 'way path road michi dou'],
		['光', 'light shine ray hikari kou'], ['影', 'shadow shade silhouette kage'],
		['夢', 'dream vision yume mu'], ['愛', 'love affection ai'],
		['和', 'harmony peace japanese wa'], ['真', 'truth true real shin ma'],
		['美', 'beauty beautiful art bi utsukushii'],
		['力', 'power strength force chikara ryoku'],
		['死', 'death die end shi'], ['生', 'life birth raw live sei nama'],
		['時', 'time hour when toki ji'], ['間', 'interval space between gap ma kan'],
		['音', 'sound noise tone oto on'], ['色', 'colour color tint iro shiki'],
		['数', 'number count figure kazu suu'],
		['理', 'reason logic principle ri kotowari'],
	]],
	['Kanji · doing', [
		['書', 'write book document kaku sho'], ['読', 'read reading yomu doku'],
		['見', 'see look view miru ken'], ['聞', 'hear listen ask kiku bun'],
		['言', 'say word speak iu gen'],
		['語', 'language word talk story go kataru'],
		['文', 'text writing sentence letter bun'],
		['字', 'character letter glyph ji'], ['本', 'book origin main root hon'],
		['絵', 'picture painting drawing e kai'],
		['画', 'image stroke draw plan ga kaku'],
		['学', 'study learn school gaku manabu'],
		['知', 'know knowledge wisdom chi shiru'],
		['思', 'think thought feel omou shi'],
		['作', 'make create build saku tsukuru'],
		['新', 'new fresh atarashii shin'], ['古', 'old ancient furui ko'],
		['大', 'big large great dai ou'], ['小', 'small little shou chiisai'],
		['中', 'middle inside centre naka chuu'],
		['上', 'up above top over ue jou'], ['下', 'down below under shita ka'],
		['始', 'begin start open hajime shi'],
		['終', 'end finish close owari shuu'],
	]],
];

/*
 * The flat list, derived. It answers one question — is this stored symbol one of
 * ours, or an emoji — and deriving it is what keeps that answer true as groups
 * are added.
 */
const SYMBOL_PALETTE = SYMBOL_GROUPS.reduce(
	(all, [, entries]) => all.concat(entries.map(([glyph]) => glyph)), []);

/*
 * The emoji tab. A broad set rather than every emoji there is: the full list is
 * some 1,900 characters with no runtime source to read it from, so it would have
 * to be pasted in whole — and a picker nobody can find anything in is worse than
 * a shorter one that is searchable. Each carries the words you would look it up
 * by.
 *
 * Grouped the way every emoji picker groups them, because that is what the hand
 * already knows.
 */
const EMOJI_GROUPS = [
	['Faces', [
		['😀', 'grin happy smile'], ['😄', 'smile happy'], ['😊', 'blush smile'],
		['🙂', 'slight smile'], ['😉', 'wink'], ['😍', 'love heart eyes'],
		['🤩', 'star struck wow'], ['😎', 'cool sunglasses'], ['🤔', 'think hmm'],
		['🤨', 'raised brow doubt'], ['😐', 'neutral flat'], ['😴', 'sleep tired'],
		['😢', 'cry sad'], ['😭', 'sob cry'], ['😤', 'huff steam'],
		['😡', 'angry rage'], ['🥳', 'party celebrate'], ['😱', 'scream shock'],
		['🤯', 'mind blown'], ['🤐', 'zip quiet'], ['😇', 'angel halo'],
		['🤓', 'nerd glasses study'], ['🧐', 'monocle inspect'], ['👻', 'ghost'],
		['💀', 'skull dead'], ['👽', 'alien'], ['🤖', 'robot bot'],
		['🎃', 'pumpkin halloween'],
	]],
	['People', [
		['👤', 'person user silhouette'], ['👥', 'people group users'],
		['🧑', 'person'], ['👩', 'woman'], ['👨', 'man'], ['🧒', 'child'],
		['👶', 'baby'], ['🧓', 'older elder'], ['👪', 'family'],
		['🧑‍🎨', 'artist painter'], ['🧑‍💻', 'developer coder'],
		['🧑‍🏫', 'teacher'], ['🧑‍🔬', 'scientist'],
		['🧑‍🍳', 'cook chef'], ['🧑‍🌾', 'farmer'],
		['👑', 'crown king queen royal'], ['🫂', 'hug friends'],
		['🤝', 'handshake deal'], ['👋', 'wave hello'], ['🙏', 'thanks pray please'],
		['💪', 'strong muscle'], ['🧠', 'brain mind think'], ['👁', 'eye see'],
		['🗣', 'speak talk voice'],
	]],
	['Nature', [
		['🌱', 'seedling sprout grow'], ['🌿', 'herb plant leaf'],
		['🍀', 'clover luck'], ['🌳', 'tree'], ['🌲', 'evergreen pine'],
		['🌵', 'cactus'], ['🌸', 'blossom flower'], ['🌹', 'rose flower'],
		['🌻', 'sunflower'], ['🍁', 'maple leaf autumn'], ['🍂', 'leaves fall'],
		['🌊', 'wave water sea'], ['🔥', 'fire flame hot'], ['💧', 'drop water'],
		['❄', 'snow cold ice'], ['⛰', 'mountain'], ['🌋', 'volcano'],
		['🌍', 'earth world globe'], ['🌙', 'moon night'], ['⭐', 'star'],
		['☀', 'sun day'], ['⛅', 'cloud weather'], ['🌈', 'rainbow'],
		['⚡', 'lightning bolt power'], ['🐝', 'bee'], ['🦋', 'butterfly'],
		['🐦', 'bird'], ['🐕', 'dog'], ['🐈', 'cat'], ['🐟', 'fish'],
		['🦉', 'owl'], ['🐘', 'elephant'],
	]],
	['Food', [
		['🍎', 'apple fruit'], ['🍊', 'orange fruit'], ['🍋', 'lemon'],
		['🍇', 'grapes'], ['🍓', 'strawberry'], ['🥕', 'carrot vegetable'],
		['🍞', 'bread'], ['🧀', 'cheese'], ['🍳', 'egg cooking'],
		['🍜', 'noodles soup'], ['🍕', 'pizza'], ['🍰', 'cake dessert'],
		['🍫', 'chocolate'], ['☕', 'coffee tea drink'], ['🍵', 'tea'],
		['🍷', 'wine drink'], ['🍺', 'beer'], ['🥂', 'cheers celebrate'],
	]],
	['Activity', [
		['🎨', 'art paint palette'], ['🖌', 'brush paint'], ['✏', 'pencil write'],
		['🖊', 'pen write'], ['📝', 'note memo write'], ['📖', 'book read'],
		['📚', 'books library'], ['🎓', 'graduate school study'],
		['🎵', 'music note'], ['🎶', 'music notes'], ['🎸', 'guitar'],
		['🎹', 'piano keyboard'], ['🎬', 'film movie clapper'],
		['📷', 'camera photo'], ['🎮', 'game controller'], ['♟', 'chess pawn'],
		['🎲', 'dice random'], ['🏃', 'run exercise'], ['🚴', 'cycle bike'],
		['🧗', 'climb'], ['⚽', 'football soccer'], ['🏆', 'trophy win'],
		['🎯', 'target goal aim'], ['🧩', 'puzzle piece'],
	]],
	['Travel', [
		['🏠', 'house home'], ['🏡', 'home garden'], ['🏢', 'office building'],
		['🏛', 'classical museum institution'], ['🏰', 'castle'],
		['⛺', 'tent camp'], ['🗺', 'map'], ['🧭', 'compass direction'],
		['📍', 'pin location place'], ['🚗', 'car drive'], ['🚆', 'train'],
		['✈', 'plane flight travel'], ['🚀', 'rocket launch'], ['⛵', 'boat sail'],
		['🚲', 'bicycle'], ['🌆', 'city dusk'],
	]],
	['Objects', [
		['💡', 'idea light bulb'], ['🔧', 'wrench tool fix'], ['🔨', 'hammer build'],
		['⚙', 'gear settings machine'], ['🧰', 'toolbox'], ['🔬', 'microscope science'],
		['🧪', 'test tube experiment'], ['⚗', 'alembic chemistry'],
		['🔭', 'telescope'], ['💻', 'laptop computer'], ['🖥', 'desktop monitor'],
		['⌨', 'keyboard type'], ['🖱', 'mouse'], ['💾', 'save disk floppy'],
		['📀', 'disc'], ['📱', 'phone mobile'], ['☎', 'telephone call'],
		['📡', 'satellite signal'], ['🔋', 'battery power'], ['🔌', 'plug'],
		['💰', 'money bag'], ['💳', 'card payment'], ['📦', 'box package'],
		['🗃', 'file box archive'], ['🗂', 'dividers folders'], ['📁', 'folder'],
		['📄', 'page document'], ['📅', 'calendar date'], ['⏰', 'alarm clock'],
		['⏳', 'hourglass time'], ['🔑', 'key'], ['🔒', 'lock private'],
		['🔓', 'unlock open'], ['🔍', 'search magnify find'], ['🧲', 'magnet'],
		['🪞', 'mirror'], ['🕯', 'candle'], ['🎁', 'gift present'],
		['✉', 'mail envelope'], ['📌', 'pushpin'], ['📎', 'paperclip attach'],
		['✂', 'scissors cut'], ['🧵', 'thread'], ['🪡', 'needle sew'],
	]],
	['Symbols', [
		['❤', 'heart love red'], ['🧡', 'orange heart'], ['💛', 'yellow heart'],
		['💚', 'green heart'], ['💙', 'blue heart'], ['💜', 'purple heart'],
		['🖤', 'black heart'], ['🤍', 'white heart'], ['✨', 'sparkles'],
		['💥', 'boom collision'], ['💤', 'sleep zzz'], ['💭', 'thought bubble'],
		['💬', 'speech comment'], ['❗', 'exclamation important'],
		['❓', 'question'], ['✅', 'check done tick'], ['❌', 'cross no wrong'],
		['⚠', 'warning caution'], ['🚧', 'construction wip'], ['🔴', 'red circle'],
		['🟠', 'orange circle'], ['🟡', 'yellow circle'], ['🟢', 'green circle'],
		['🔵', 'blue circle'], ['🟣', 'purple circle'], ['⚫', 'black circle'],
		['⚪', 'white circle'], ['🟥', 'red square'], ['🟧', 'orange square'],
		['🟨', 'yellow square'], ['🟩', 'green square'], ['🟦', 'blue square'],
		['🔶', 'orange diamond'], ['🔷', 'blue diamond'], ['🏷', 'label tag'],
		['🔖', 'bookmark'], ['♾', 'infinity'], ['⏺', 'record dot'],
	]],
];

/*
 * The **icons** tab: Obsidian ships Lucide, which is the flat outline set Notion's
 * icons look like, and `getIconIds()` hands over every one at runtime. So the
 * "custom emoji with a more Notion-like appearance" needs no artwork shipped and
 * no list embedded — and the names come with it, which is what makes searching a
 * thousand of them possible.
 *
 * Stored as `lucide:heart`, a plain string in the frontmatter like any other
 * symbol. Everything that draws a symbol goes through `paintSymbol`, so a class
 * marked with an icon behaves exactly like one marked with a character.
 */
const ICON_PREFIX = 'lucide:';

/*
 * The icons, by what they *mean* (2026-08-24, his ask: more icons with more
 * emoji-like meanings).
 *
 * Obsidian ships what it ships — there is no way to add a 1,301st icon without
 * embedding artwork — so what can be added is **meaning**. Alphabetical is the
 * worst order for browsing: `smile` sits between `slash` and `snail`, and the one
 * you would have picked is fifty screens away from the one you thought of.
 *
 * These are the emoji categories, filled with Lucide. An id that this version of
 * Obsidian does not have is dropped silently, so the list can name icons
 * generously without breaking on an older build — and everything not named here
 * still appears, under *Everything else*.
 */
const ICON_GROUPS = [
	['Faces & people', [
		'smile', 'smile-plus', 'laugh', 'meh', 'frown', 'angry', 'annoyed',
		'user', 'users', 'user-round', 'baby', 'person-standing', 'accessibility',
		'crown', 'venetian-mask', 'skull', 'ghost', 'bot', 'brain', 'eye', 'ear',
		'hand', 'hand-metal', 'thumbs-up', 'thumbs-down', 'handshake',
		'heart-handshake', 'footprints', 'contact', 'baby-carriage',
	]],
	['Animals', [
		'bird', 'cat', 'dog', 'fish', 'fish-symbol', 'rabbit', 'squirrel', 'turtle',
		'snail', 'bug', 'worm', 'rat', 'shell', 'feather', 'egg', 'paw-print',
		'origami', 'bone',
	]],
	['Nature & weather', [
		'leaf', 'leafy-green', 'sprout', 'flower', 'flower-2', 'trees',
		'tree-pine', 'tree-deciduous', 'palmtree', 'cactus', 'clover', 'wheat',
		'sun', 'sunrise', 'sunset', 'moon', 'moon-star', 'star', 'stars',
		'sparkles', 'sparkle', 'cloud', 'cloud-rain', 'cloud-snow', 'cloud-sun',
		'snowflake', 'droplet', 'droplets', 'waves', 'wind', 'rainbow', 'zap',
		'flame', 'mountain', 'mountain-snow', 'globe', 'earth', 'tornado',
	]],
	['Food & drink', [
		'apple', 'banana', 'cherry', 'grape', 'citrus', 'carrot', 'salad',
		'sandwich', 'pizza', 'hamburger', 'popcorn', 'croissant', 'cookie',
		'cake', 'cake-slice', 'ice-cream-cone', 'ice-cream-bowl', 'candy',
		'dessert', 'donut', 'coffee', 'cup-soda', 'wine', 'beer', 'martini',
		'milk', 'soup', 'ham', 'beef', 'egg-fried', 'utensils', 'utensils-crossed',
		'chef-hat', 'cooking-pot', 'nut', 'bean',
	]],
	['Places & travel', [
		'home', 'house', 'building', 'building-2', 'castle', 'church', 'hotel',
		'store', 'factory', 'warehouse', 'school', 'university', 'landmark',
		'tent', 'tent-tree', 'caravan', 'map', 'map-pin', 'map-pinned', 'compass',
		'signpost', 'route', 'plane', 'plane-takeoff', 'car', 'car-front', 'bus',
		'train-front', 'tram-front', 'bike', 'ship', 'sailboat', 'rocket',
		'anchor', 'fuel', 'traffic-cone', 'luggage', 'backpack',
	]],
	['Study & making', [
		'book', 'book-open', 'book-marked', 'notebook', 'notebook-pen', 'library',
		'graduation-cap', 'pencil', 'pen', 'pen-tool', 'brush', 'paintbrush',
		'paintbrush-vertical', 'palette', 'scissors', 'ruler', 'pencil-ruler',
		'calculator', 'microscope', 'telescope', 'flask-conical', 'flask-round',
		'test-tube', 'test-tubes', 'atom', 'dna', 'magnet', 'lightbulb',
		'hammer', 'wrench', 'screwdriver', 'axe', 'shovel', 'drill', 'anvil',
		'scroll', 'scroll-text', 'feather', 'stamp', 'highlighter',
	]],
	['Play & sport', [
		'gamepad', 'gamepad-2', 'dices', 'dice-5', 'puzzle', 'trophy', 'medal',
		'award', 'target', 'crosshair', 'flag', 'flag-triangle-right', 'swords',
		'shield', 'shield-half', 'guitar', 'piano', 'drum', 'music', 'music-2',
		'music-4', 'headphones', 'mic', 'mic-vocal', 'radio', 'tv', 'clapperboard',
		'film', 'popcorn', 'ticket', 'dumbbell', 'bike', 'volleyball', 'tent',
		'party-popper', 'cake',
	]],
	['Body & care', [
		'heart', 'heart-pulse', 'heart-crack', 'activity', 'stethoscope', 'pill',
		'syringe', 'bandage', 'thermometer', 'brain-circuit', 'bed', 'bath',
		'shower-head', 'glasses', 'shirt', 'watch', 'gem', 'crown', 'umbrella',
		'hand-heart', 'smile-plus',
	]],
	['Things & money', [
		'key', 'lock', 'unlock', 'gift', 'package', 'box', 'boxes', 'archive',
		'folder', 'folder-open', 'file', 'file-text', 'paperclip', 'pin', 'tag',
		'tags', 'bookmark', 'calendar', 'calendar-days', 'clock', 'alarm-clock',
		'hourglass', 'timer', 'bell', 'mail', 'send', 'phone', 'message-circle',
		'message-square', 'camera', 'image', 'video', 'lamp', 'candle',
		'wallet', 'banknote', 'coins', 'credit-card', 'piggy-bank',
		'shopping-cart', 'shopping-bag', 'receipt', 'briefcase', 'scale',
		'trash', 'trash-2', 'recycle', 'battery', 'plug', 'wrench',
	]],
	['Marks & signs', [
		'check', 'check-check', 'x', 'circle', 'square', 'triangle', 'diamond',
		'hexagon', 'octagon', 'plus', 'minus', 'asterisk', 'hash', 'at-sign',
		'info', 'circle-help', 'circle-alert', 'triangle-alert', 'octagon-alert',
		'ban', 'infinity', 'quote', 'link', 'anchor', 'eye-off', 'lock-keyhole',
		'arrow-up', 'arrow-down', 'arrow-right', 'arrow-left', 'refresh-cw',
	]],
];

/*
 * Words that are not in an icon's name but are what you would type looking for
 * it. Lucide's own metadata has these; Obsidian does not expose them, so the ones
 * worth having are here — the emoji vocabulary, mostly, since that is the vocabulary
 * he is bringing to the picker.
 */
const ICON_SYNONYMS = {
	smile: 'happy joy grin emoji face',
	laugh: 'happy lol funny face',
	frown: 'sad unhappy face',
	angry: 'mad rage face',
	meh: 'neutral face',
	annoyed: 'unamused face',
	heart: 'love like favourite favorite red',
	'heart-pulse': 'health life beat',
	'heart-crack': 'broken heartbreak sad',
	star: 'favourite favorite rating best',
	sparkles: 'magic shine new special',
	flame: 'fire hot burn energy',
	zap: 'lightning bolt power fast energy',
	droplet: 'water drop rain wet',
	leaf: 'plant nature green eco',
	sprout: 'seedling grow new plant',
	trees: 'forest wood nature',
	sun: 'day light weather hot',
	moon: 'night sleep dark',
	snowflake: 'cold winter ice snow',
	rainbow: 'colour color pride weather',
	globe: 'world earth international language',
	bird: 'animal fly',
	cat: 'animal pet kitten',
	dog: 'animal pet puppy',
	fish: 'animal sea swim',
	bug: 'insect beetle problem',
	apple: 'fruit food health',
	pizza: 'food italian slice',
	coffee: 'drink cafe morning caffeine',
	wine: 'drink alcohol glass',
	cake: 'birthday food dessert celebrate',
	utensils: 'food eat restaurant meal',
	home: 'house building live',
	building: 'office city work',
	tent: 'camp outdoors camping',
	map: 'travel place geography',
	'map-pin': 'location place where marker',
	compass: 'direction navigate explore',
	plane: 'travel flight fly airport',
	car: 'drive travel vehicle',
	rocket: 'launch space fast start',
	book: 'read study library note',
	'book-open': 'read study reading',
	'graduation-cap': 'school study degree learn education',
	pencil: 'write edit draw note',
	brush: 'paint art draw',
	palette: 'art colour color paint',
	scissors: 'cut craft',
	microscope: 'science research study biology',
	'flask-conical': 'science chemistry experiment lab',
	atom: 'science physics',
	lightbulb: 'idea think insight bright',
	hammer: 'build tool make fix',
	wrench: 'tool fix settings repair',
	trophy: 'win award prize best',
	target: 'goal aim focus objective',
	flag: 'mark country milestone',
	music: 'song audio sound note',
	headphones: 'listen audio music',
	camera: 'photo picture snapshot',
	film: 'movie cinema video',
	'gamepad-2': 'game play controller',
	dices: 'random chance game luck',
	puzzle: 'piece problem solve',
	dumbbell: 'gym exercise fitness strong',
	bed: 'sleep rest bedroom',
	key: 'unlock access password secret',
	lock: 'private secure closed',
	gift: 'present birthday surprise',
	package: 'box parcel delivery ship',
	calendar: 'date day schedule when',
	clock: 'time hour when',
	bell: 'notification alert remind',
	mail: 'email letter message send',
	'message-circle': 'chat talk comment speak',
	wallet: 'money pay cash',
	banknote: 'money cash pay currency',
	coins: 'money cash currency',
	'shopping-cart': 'buy shop store purchase',
	briefcase: 'work job business office',
	skull: 'death dead danger',
	ghost: 'spooky halloween boo',
	bot: 'robot ai machine',
	brain: 'mind think memory idea',
	eye: 'see look watch view',
	crown: 'king queen royal best',
	gem: 'diamond jewel precious value',
	umbrella: 'rain weather protect',
	check: 'done yes tick complete ok',
	x: 'no close cancel wrong',
	infinity: 'forever endless loop',
	link: 'url connect chain',
	recycle: 'reuse green eco loop',
	trash: 'delete bin remove',
};

/* id -> the words above, once, so search can read one string per icon. */
function iconKeywords(name) {
	const extra = ICON_SYNONYMS[name];
	return extra ? name.replace(/-/g, ' ') + ' ' + extra : name.replace(/-/g, ' ');
}

function isIconSymbol(value) {
	return String(value || '').indexOf(ICON_PREFIX) === 0;
}

function iconNameOf(value) {
	return isIconSymbol(value) ? String(value).slice(ICON_PREFIX.length) : '';
}

/*
 * Draw a symbol into an element, whichever kind it is. One function, because the
 * mark appears in five places — the class row, the property heading, the picker,
 * the button that opens it, and the preview inside it — and five copies of
 * "is this an icon or a character" is five chances to disagree.
 *
 * What it draws is exactly what is stored. Nothing is added on the way out any
 * more; see `asEmoji` for where the presentation is decided instead.
 */
function paintSymbol(el, value) {
	el.textContent = '';
	el.removeClass('is-icon');
	if (!value) return el;

	if (isIconSymbol(value)) {
		el.addClass('is-icon');
		if (typeof setIcon === 'function') setIcon(el, iconNameOf(value));
		return el;
	}

	el.textContent = value;
	return el;
}

/*
 * The three dots, by whichever name this Obsidian's Lucide calls them.
 *
 * A hamburger means *navigation* — the application's own menu — and three dots
 * mean *more actions for this item*, which is what a class's menu is. His call,
 * 2026-08-24, and the right one.
 *
 * Lucide renamed `more-vertical` to `ellipsis-vertical`, and which one is present
 * depends on the Obsidian build, so the id is chosen from what is actually
 * registered: `setIcon` with a name it does not know draws nothing at all, and an
 * empty button is worse than the wrong glyph.
 */
let overflowIcon = null;

function overflowIconName() {
	/* Asked once: the answer cannot change while Obsidian is running, and this is
	 * called for every class row on every redraw. */
	if (overflowIcon) return overflowIcon;
	const have = new Set(availableIcons());
	for (const name of ['ellipsis-vertical', 'more-vertical', 'ellipsis',
		'more-horizontal', 'menu']) {
		if (have.has(name)) { overflowIcon = name; return overflowIcon; }
	}
	overflowIcon = 'menu';
	return overflowIcon;
}

/* Every Lucide id Obsidian knows, without the `lucide-` its own ids carry. */
function availableIcons() {
	if (typeof getIconIds !== 'function') return [];
	const seen = new Set();
	const out = [];
	for (const id of getIconIds()) {
		const name = String(id).replace(/^lucide-/, '');
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out.sort();
}

/*
 * U+FE0F, the emoji variation selector.
 *
 * There was a setting here that appended one of these to **every** symbol, and it
 * was wrong (2026-08-24): he picked an emoji and got a flat glyph, because dozens
 * of emoji — ❤ ☀ ✏ ✂ ⚙ ✈ ⚠ — have a text presentation for it to switch them to.
 *
 * Presentation belongs to the value, not to a mode. A typographic mark is stored
 * bare and Unicode's default presentation draws it flat, which is what it is for;
 * an emoji picked from the emoji tab is stored with its selector, so it is an
 * emoji wherever it appears, for ever, with nothing having to remember why.
 */
const EMOJI_PRESENTATION = '\uFE0F';

/*
 * The emoji tab's characters, as they should be *stored*.
 *
 * Everything in the astral planes (🎨 🚀 😀) is emoji-only and needs nothing. The
 * ones that need the selector are the old BMP symbols that were emoji-fied later
 * and still default to text — which is every dual-form character there is, and
 * exactly the set the old setting was flattening.
 */
function asEmoji(symbol) {
	const text = String(symbol === undefined || symbol === null ? '' : symbol);
	if (!text) return '';
	if (text.indexOf(EMOJI_PRESENTATION) !== -1) return text;
	const points = Array.from(text);
	if (points.length !== 1) return text;
	return points[0].codePointAt(0) <= 0x2bff ? text + EMOJI_PRESENTATION : text;
}

/*
 * What a class note's symbol property may hold. One grapheme — anything longer
 * is a mistake, most often a whole word pasted in, and a five-letter "symbol"
 * before every heading would wreck the layout it is meant to decorate.
 *
 * Counted with the segmenter where there is one, so a flag or a skin-toned emoji
 * counts as the one character it looks like rather than the four it is.
 */
function firstGrapheme(value) {
	/*
	 * The selector is part of the grapheme and stays. Stripping it here is what
	 * made a stored emoji flat again the moment it was read back.
	 */
	const text = String(value === undefined || value === null ? '' : value).trim();
	if (!text) return '';
	if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		for (const piece of segmenter.segment(text)) return piece.segment;
		return '';
	}
	return Array.from(text)[0] || '';
}

/*
 * A symbol as it should be stored, whichever kind it is.
 *
 * **The one-grapheme rule is about characters, and an icon is a name.** Running
 * `lucide:heart` through it left `l` — the whole icons tab writing a single
 * letter into the note. Every place that stores or reads a symbol goes through
 * here now, so there is one answer to what a symbol may be.
 */
function normaliseSymbol(value) {
	const text = String(value === undefined || value === null ? '' : value).trim();
	if (isIconSymbol(text)) {
		const name = iconNameOf(text).trim();
		return name ? ICON_PREFIX + name : '';
	}
	return firstGrapheme(text);
}

/* ----- the defaults table ------------------------------------------------ */

/*
 * A characteristic note carries a table saying what its value should be, and
 * where. His columns, 2026-08-30:
 *
 *   | Location  | Starting value | None replacement | Value must contain | Value must be |
 *   | --------- | -------------- | ---------------- | ------------------ | ------------- |
 *   | All notes |                |                  |                    |               |
 *
 * The table lives in the **body**, which is the one part of a note this plugin
 * has always refused to write. It still refuses to *rewrite* one, with the
 * narrow exceptions each named where they are written: the table is an input,
 * hand-edited the way `property type` and `possible values` above it are.
 *
 * **Four value columns, because they are four different claims** — and only the
 * first is about creation:
 *
 *   Starting value       what a note is *created* with. From then on the value
 *                        is the note's own and nothing here touches it again.
 *   None replacement     an empty value is replaced with this, retroactively and
 *                        for ever. A value that is *there* is never touched.
 *   Value must contain   the value must include this. On a list the entry is
 *                        added if it is missing and everything else is kept; on
 *                        a single value there is no way to add without
 *                        replacing, so a note that does not contain it is
 *                        reported instead.
 *   Value must be        the value must be this. Anything else, empty included,
 *                        is replaced.
 *
 * The last two replaced one *Strict default value* column, which meant "fill an
 * empty one" and — behind a setting — "and overwrite one that differs". **That
 * setting is gone with it**: which of the two a row means is now written in the
 * row, which is strictly more expressive than one switch over the whole vault,
 * and a switch that says what a column says is the duplication this plugin has
 * spent the day removing.
 *
 * **The table is the only place a default is written.** `default value:` in the
 * frontmatter said the same thing the *All notes* row says, and having both was
 * two spellings of one claim — so it is the frontmatter key that goes, on his
 * call, 2026-08-30. See `retire-default-value`, which moves a value it still
 * holds into this row and then takes the key out.
 *
 * (I had it the other way round earlier the same day, and removing the row was
 * wrong: it is the row that can also say *for this class*, so the table is the
 * structure that subsumes the other and not the reverse.)
 */
const ALL_NOTES_ROW = 'All notes';

/*
 * The columns, in order. `key` is what the code calls the field; `names` are
 * every heading that has ever meant it, lowercased — the first is what is
 * written, the rest are recognised for ever, for the reason `RENAME_MARKS`
 * exists: a table already on disk must be readable, or its values quietly stop
 * meaning anything. `upgrade-defaults-table` is what brings an old one forward.
 */
const DEFAULTS_FIELDS = [
	{ key: 'location', names: ['location', 'default location'] },
	{ key: 'starting', names: ['starting value', 'default value'] },
	{ key: 'none', names: ['none replacement', 'strict default value'] },
	{ key: 'contains', names: ['value must contain'] },
	{ key: 'must', names: ['value must be'] },
];

/* The headings as written. */
const DEFAULTS_COLUMNS = DEFAULTS_FIELDS.map((field) => field.names[0]
	.replace(/^./, (c) => c.toUpperCase()));

/*
 * What each column is padded to. The heading, except that the first is widened
 * to fit *All notes* — it is in every table, and a location cell wider than its
 * own heading is the one thing that makes the pipes visibly fail to line up.
 */
const DEFAULTS_WIDTHS = DEFAULTS_COLUMNS.map((column, index) =>
	Math.max(column.length, index === 0 ? ALL_NOTES_ROW.length : 0));

/* The four that hold a value — everything except the location. */
const DEFAULTS_VALUE_KEYS = DEFAULTS_FIELDS.slice(1).map((field) => field.key);

/*
 * Cells, from one `| a | b | c |` line. Splitting on a bare pipe would cut a
 * value in half at the first escaped one, so `\|` is protected on the way in and
 * restored on the way out.
 */
function tableCells(line) {
	const guarded = String(line).replace(/\\\|/g, '\u0000');
	const trimmed = guarded.trim().replace(/^\|/, '').replace(/\|$/, '');
	return trimmed.split('|').map((cell) => cell.replace(/\u0000/g, '|').trim());
}

/* `| --- | :--: |` — the line under a table's header, and never a row. */
function isTableRule(line) {
	const cells = tableCells(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/* A heading, stripped of the emphasis he may have put round it. */
function headingWord(cell) {
	return String(cell === undefined || cell === null ? '' : cell)
		.replace(/[*_`]/g, '').trim().toLowerCase();
}

/*
 * Which column is which, for one header line — `{ location: 0, starting: 1, … }`,
 * or **null** when the line is not a defaults header at all. Missing columns are
 * simply absent from the map, so a three-column table written before today reads
 * correctly and its two missing claims are empty rather than wrong.
 *
 * **`Location` alone is not enough evidence, and that is why this is a map rather
 * than a test on the first cell.** The old heading, *Default location*, could
 * only ever have meant this table. `Location` is an ordinary word — he has a
 * `location` characteristic — so a table headed with it is ours only if a second
 * column is one of ours too.
 */
function defaultsColumnMap(cells) {
	if (!Array.isArray(cells) || cells.length < 2) return null;

	const map = {};
	for (let i = 0; i < cells.length; i++) {
		const word = headingWord(cells[i]);
		for (const field of DEFAULTS_FIELDS) {
			if (map[field.key] !== undefined) continue;
			if (field.names.indexOf(word) === -1) continue;
			map[field.key] = i;
			break;
		}
	}

	if (map.location === undefined) return null;
	if (headingWord(cells[map.location]) === 'default location') return map;
	return DEFAULTS_VALUE_KEYS.some((key) => map[key] !== undefined) ? map : null;
}

/* Whether a header line is a defaults header. */
function looksLikeDefaultsHeader(cells) {
	return defaultsColumnMap(cells) !== null;
}

/* The words *All notes*, whatever emphasis has been put around them. */
function isAllNotesLocation(text) {
	return headingWord(text) === ALL_NOTES_ROW.toLowerCase();
}

/* One row's cells, read through its own table's column map. */
function defaultsRowFrom(cells, map, line, raw) {
	const at = (key) => (map[key] === undefined ? '' : String(cells[map[key]] || '').trim());
	const location = at('location');
	if (!location) return null;

	const row = {
		/* Kept as written: `[[Visual Artist]]`, or the words *All notes*. */
		location: location,
		isAll: isAllNotesLocation(location),
		line: line,
		/* The line as written, so a cell can be rewritten without re-reading. */
		raw: raw,
		/* Its table's map, so a cell can be found by name rather than by number. */
		columns: map,
	};
	for (const key of DEFAULTS_VALUE_KEYS) row[key] = at(key);
	return row;
}

/* Whether a row makes any claim at all. */
function defaultsRowSpeaks(row) {
	return DEFAULTS_VALUE_KEYS.some((key) => !isEmptyValue(row[key]));
}

/*
 * Every defaults row in a note body, in the order written. Rows with nothing in
 * any value column are kept out: the empty *All notes* row the table is seeded
 * with says nothing, and reading it as "the value should be blank" would make
 * seeding a note change what it means.
 */
function parseDefaultsTable(text) {
	const lines = String(text || '').split('\n');
	const rows = [];
	let map = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.indexOf('|') === -1) { map = null; continue; }

		const cells = tableCells(line);
		const header = defaultsColumnMap(cells);
		if (header) { map = header; continue; }
		if (!map || isTableRule(line)) continue;

		const row = defaultsRowFrom(cells, map, i + 1, line);
		if (row && defaultsRowSpeaks(row)) rows.push(row);
	}

	return rows;
}

/*
 * Every *All notes* row in a body, **empty ones included** — which is why this is
 * a second walk rather than a filter over `parseDefaultsTable`, whose whole job
 * is to drop rows that say nothing. The empty seeded row is exactly the one that
 * has to be found: it is where a retired `default value:` lands.
 */
function findAllNotesRows(text) {
	const lines = String(text || '').split('\n');
	const found = [];
	let map = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.indexOf('|') === -1) { map = null; continue; }

		const cells = tableCells(line);
		const header = defaultsColumnMap(cells);
		if (header) { map = header; continue; }
		if (!map || isTableRule(line)) continue;

		const row = defaultsRowFrom(cells, map, i + 1, line);
		if (row && row.isAll) found.push(row);
	}

	return found;
}

/* Whether a body already carries a defaults table, empty rows and all. */
function hasDefaultsTable(text) {
	return String(text || '').split('\n')
		.some((line) => line.indexOf('|') !== -1 && looksLikeDefaultsHeader(tableCells(line)));
}

/*
 * Every defaults table in a body whose columns are not the ones written today —
 * a heading missing, or worded the way it used to be. `{ start, end, map }` per
 * table, `start` being its header line.
 */
function findLegacyDefaultsTables(text) {
	const lines = String(text || '').split('\n');
	const found = [];

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].indexOf('|') === -1) continue;
		const map = defaultsColumnMap(tableCells(lines[i]));
		if (!map) continue;

		let end = i;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].indexOf('|') === -1) break;
			if (defaultsColumnMap(tableCells(lines[j]))) break;
			end = j;
		}

		const current = DEFAULTS_FIELDS.every((field, index) =>
			map[field.key] === index)
			&& tableCells(lines[i]).length === DEFAULTS_FIELDS.length;
		if (!current) {
			found.push({
				start: i, end: end, map: map,
				header: lines[i],
				lines: lines.slice(i, end + 1),
			});
		}
		i = end;
	}

	return found;
}

/* A table line built from cells, each padded to its column's own width. */
function defaultsLine(values) {
	const cells = DEFAULTS_WIDTHS.map((width, index) => {
		const text = String(values[index] === undefined || values[index] === null
			? '' : values[index])
			.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
		return text + ' '.repeat(Math.max(0, width - text.length));
	});
	return '| ' + cells.join(' | ') + ' |';
}

/* The `| --- | --- |` under the header, at the same widths. */
function defaultsRuleLine() {
	return '| ' + DEFAULTS_WIDTHS.map((width) => '-'.repeat(width)).join(' | ') + ' |';
}

/* The seeded *All notes* row, with a starting value in it or without. */
function defaultsAllRowLine(value) {
	return defaultsLine([ALL_NOTES_ROW, value]);
}

/* The empty table a new characteristic note is created with. */
function defaultsTableBlock() {
	return [
		defaultsLine(DEFAULTS_COLUMNS),
		defaultsRuleLine(),
		defaultsAllRowLine(''),
	];
}

/*
 * One table, rewritten with today's columns. Every value is carried across by
 * *name*, so a column that has moved, been renamed or was never there lands in
 * the right place or stays empty — the one thing that must not happen is a value
 * arriving under a heading that means something else.
 */
function upgradeDefaultsTable(lines, map) {
	const out = [
		defaultsLine(DEFAULTS_COLUMNS),
		defaultsRuleLine(),
	];

	for (let i = 1; i < lines.length; i++) {
		if (isTableRule(lines[i])) continue;
		const cells = tableCells(lines[i]);
		const row = defaultsRowFrom(cells, map, 0, lines[i]);
		if (!row) continue;
		out.push(defaultsLine([row.location].concat(
			DEFAULTS_VALUE_KEYS.map((key) => row[key]))));
	}

	return out;
}

/*
 * One cell of a table line, replaced. Unlike `rewriteTableCell` this does not
 * care what the cell held — it is used to fill the empty one a seeded row
 * carries — so the padding is rebuilt rather than preserved: a cell of nothing
 * but spaces has no "before" and "after" to keep, and both halves of the regexes
 * would match all of it. The column keeps its width where the value fits, so a
 * hand-aligned table stays aligned.
 */
function setTableCell(line, index, value) {
	const parts = String(line).split(/(?<!\\)\|/);
	const at = index + (/^\s*\|/.test(line) ? 1 : 0);
	if (at >= parts.length) return null;

	const text = String(value === undefined || value === null ? '' : value)
		.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
	const body = ' ' + text + ' ';
	parts[at] = body.length >= parts[at].length
		? body
		: body + ' '.repeat(parts[at].length - body.length);
	return parts.join('|');
}

/*
 * The *All notes* row as it should read once a retired `default value:` has moved
 * into it — the existing line with its **Starting value** cell filled, or a whole
 * new row when there is none. One function, so the confirmation diff and the
 * write cannot describe different lines.
 *
 * The cell is found through the table's own column map rather than at a fixed
 * number, because a table written before today has its starting value in a
 * different place and this must not put it in the wrong one.
 */
function allNotesRowWrite(raw, value, map) {
	if (!raw) return defaultsAllRowLine(value);
	const at = map && map.starting !== undefined ? map.starting : 1;
	const next = setTableCell(raw, at, value);
	return next === null ? defaultsAllRowLine(value) : next;
}

/*
 * The sentinel inside the Templater block that names a new note after the moment
 * it was made. The block is found by this line and not by matching the whole of
 * it: the format inside changes with the setting, and he may reasonably edit the
 * body around it, so the only stable thing is the mark.
 *
 * `RENAME_MARKS` is what is recognised; `RENAME_MARK` is what is written. They
 * differ because the plugin was renamed: blocks written while it was called "OOF
 * Classes" carry that wording, and a finder that knew only the current mark could
 * not see them — so Update appended a second block instead of replacing the
 * first, and every template written before the rename ended up carrying two.
 * Recognising the old wording is what lets the stale copy come back out.
 */
const RENAME_MARK = 'OOF Class Manager: unique file name';
const RENAME_MARKS = [RENAME_MARK, 'OOF Classes: unique file name'];

/*
 * Every block of ours in a body, in the order they appear:
 *
 *   { lines, blocks: [{ start, end }] }
 *
 * More than one is a defect rather than a shape to support — see RENAME_MARKS —
 * and finding them all is what lets `write-rename-block` collapse them to one.
 */
function findRenameBlocks(text) {
	const lines = String(text || '').split('\n');
	const blocks = [];

	for (let i = 0; i < lines.length; i++) {
		if (!RENAME_MARKS.some((mark) => lines[i].indexOf(mark) !== -1)) continue;

		let start = i;
		while (start > 0 && lines[start].indexOf('<%*') === -1) start--;
		if (lines[start].indexOf('<%*') === -1) continue;
		/* Never back into a block already taken: that would be one block twice. */
		if (blocks.length && start <= blocks[blocks.length - 1].end) continue;

		let end = i;
		while (end < lines.length - 1 && lines[end].indexOf('%>') === -1) end++;
		if (lines[end].indexOf('%>') === -1) continue;

		blocks.push({ start: start, end: end });
		i = end;
	}

	return { lines: lines, blocks: blocks };
}

/*
 * What a body carries: whether there is a block, how many, the format the first
 * one names, and the real lines of each — so the confirmation diff can show what
 * is actually in the file rather than a reconstruction of it, which is the only
 * way two identical-looking blocks read as two.
 */
function renameEntry(text) {
	const found = findRenameBlocks(text);
	const blocks = found.blocks.map(
		(range) => found.lines.slice(range.start, range.end + 1));
	const match = blocks.length
		? blocks[0].join('\n').match(/tp\.date\.now\("([^"]*)"\)/) : null;
	return {
		has: blocks.length > 0,
		count: blocks.length,
		format: match ? match[1] : '',
		blocks: blocks,
		/* One string that changes whenever any of them does, count included. */
		signature: blocks.length + '\n'
			+ blocks.map((one) => one.join('\n')).join('\n'),
	};
}

/*
 * The block itself.
 *
 * It goes *below* the frontmatter, and that is not a style choice: this plugin
 * writes a template's properties through `processFrontMatter`, which reads the
 * `---` on the first line. A Templater block above it would leave the file with
 * no frontmatter as far as Obsidian is concerned, and the next Update would lay
 * a second block of properties on top. His `Characteristic Template.md` puts its
 * own block first and is right to — nothing generates that one.
 *
 * The guard is `Untitled` rather than nothing at all. A note created by
 * following a link arrives already carrying that link's name, and with
 * `alwaysUpdateLinks` on, renaming it rewrites the very link that made it —
 * `[[The theory of information]]` would become a timestamp.
 */
function renameBlock(format) {
	return [
		'<%*',
		'/*',
		' * ' + RENAME_MARK + ' — a new note is named after the moment it was made.',
		' *',
		' * Only when it has no name of its own yet: a note created by following a',
		' * link arrives carrying that link\'s name, and renaming it would rewrite',
		' * the link that made it.',
		' *',
		' * Written by the plugin from its *Unique file name* setting. Edits here',
		' * are overwritten the next time that setting changes.',
		' */',
		'const stamp = tp.date.now("' + format + '");',
		'if (tp.file.title.startsWith("Untitled")) {',
		'\tlet name = stamp, n = 2;',
		'\twhile (app.vault.getAbstractFileByPath(',
		'\t\t\ttp.file.path(true).replace(/[^/]*$/, name + ".md"))) {',
		'\t\tname = stamp + " " + n++;',
		'\t}',
		'\tawait tp.file.rename(name);',
		'}',
		'-%>',
	];
}

/*
 * A cell is text; a property has a type. `12` in a number property should be the
 * number, or the note is out of step with its own `property type` the moment it
 * is written.
 *
 * A list splits on commas — but not the ones inside `[[…]]`, because a link may
 * carry one and cutting it there would produce two broken links.
 */
function coerceDefault(text, propertyType) {
	const raw = String(text === undefined || text === null ? '' : text).trim();
	if (!raw) return '';
	/* Machinery, not data: it is the code for a value, and stays text. */
	if (isTemplaterExpression(raw)) return raw;

	const type = String(propertyType || '').toLowerCase();

	if (type === 'number') {
		const number = Number(raw);
		return Number.isFinite(number) ? number : raw;
	}

	if (type === 'checkbox') {
		if (/^(true|yes)$/i.test(raw)) return true;
		if (/^(false|no)$/i.test(raw)) return false;
		return raw;
	}

	if (type === 'list' || type === 'tags' || type === 'multitext') {
		const parts = [];
		let depth = 0;
		let current = '';
		for (let i = 0; i < raw.length; i++) {
			const two = raw.slice(i, i + 2);
			if (two === '[[') { depth++; current += two; i++; continue; }
			if (two === ']]') { depth = Math.max(0, depth - 1); current += two; i++; continue; }
			if (raw[i] === ',' && depth === 0) { parts.push(current); current = ''; continue; }
			current += raw[i];
		}
		parts.push(current);
		return parts.map((part) => part.trim()).filter(Boolean);
	}

	return raw;
}

/* Whether a note's value already says what a default says. */
function sameDefaultValue(current, wanted) {
	if (Array.isArray(current) || Array.isArray(wanted)) {
		const a = toArray(current).map((entry) => String(entry).trim());
		const b = toArray(wanted).map((entry) => String(entry).trim());
		return sameNameList(a, b);
	}
	return String(current === undefined || current === null ? '' : current).trim()
		=== String(wanted === undefined || wanted === null ? '' : wanted).trim();
}

/* ----- the third sort direction: moved out ------------------------------
 *
 * Sorting by the order a characteristic note lists its values in — "As listed"
 * beside A → Z and Z → A — was here until 2026-08-30. It is its own plugin now,
 * `bases-declared-order`, on his reasoning: it interprets the OOF *rules* rather
 * than anything of this plugin's, so it belongs beside it rather than inside it.
 * It reads `possible values` off the characteristic note directly, and works with
 * this plugin uninstalled.
 *
 * The `declaredOrder:` and `declaredGroupOrder:` keys on a base view are
 * unchanged, so bases written while this feature lived here still sort correctly.
 * Nothing in OOF Class Manager reads or writes them any more.
 */

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
		/* Bases whose class is gone, gathered in the background. See orphanActions. */
		this.orphanBases = new Set();
		/*
		 * path -> the rows of that characteristic note's defaults table.
		 *
		 * A table lives in the body, and a body can only be read asynchronously,
		 * while everything that needs the rows - the picture, the plan, a Bases
		 * formula - is synchronous. So the rows are kept here and refreshed when a
		 * characteristic note changes, the way Bases Word Count keeps its counts.
		 * The cost is one pass over ~30 small files at startup.
		 */
		this.defaultsRows = new Map();
		/*
		 * class -> the symbol this plugin wrote onto it as a copy of an ancestor's.
		 * The only thing here that remembers what it wrote, and it has to: a copy
		 * and a deliberate choice look identical in the file.
		 */
		this.symbolWrites = new Map();

		/*
		 * The rename block each template currently carries, by path. Same shape and
		 * same reason as `defaultsRows`: a body cannot be read synchronously, and
		 * the planner runs synchronously, so the reading is done once in the
		 * background and the plan consults what was found.
		 */
		this.templateRenames = new Map();

		/*
		 * base path -> the names of the views inside it. Same shape and same reason
		 * as the two above: a `.base` body is only readable asynchronously, and the
		 * panel that offers those names to a `views` row is synchronous.
		 */
		this.baseViews = new Map();

		/*
		 * base path -> its text, from that same read.
		 *
		 * Kept because a class card says how many notes its base holds, and *how
		 * many* depends on what the base is **reading** — which stream, how far,
		 * and what it drops. That is a fact about the file, so the only honest
		 * source for it is the file. Reading it again would be a second read of
		 * something already in hand, and doing it lazily would be an asynchronous
		 * read behind a synchronous card.
		 *
		 * A whole `.base` is a few kilobytes and his vault has fifty-one of them.
		 */
		this.baseTexts = new Map();

		/* What Obsidian currently thinks each property's type is. */
		this.registeredTypes = {};
		/* Memoised inheritance walks, for the Bases formula functions. */
		this.invalidateClosures();

		await this.loadSettings();
		/* Not awaited: an empty set simply offers nothing this time round. */
		this.refreshOrphanBases().catch(() => {});
		this.readBaseViews().catch(() => {});
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

		/*
		 * `changed` hands over the file's text, which is the one place a body
		 * arrives without an await - so the defaults table is re-read here rather
		 * than through another pass over the vault.
		 */
		this.registerEvent(this.app.metadataCache.on('changed', (file, data) => {
			if (typeof data === 'string') {
				this.rememberDefaults(file, data);
				this.rememberRenameBlock(file, data);
			}
			touched(file);
		}));
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (this.isCharacteristicFile(file)) this.readDefaultsTables().catch(() => {});
			if (this.isTemplateFile(file)) this.readTemplateRenames().catch(() => {});
			if (isBaseFile(file)) this.readBaseViews().catch(() => {});
			touched(file);
		}));
		/*
		 * A `.base` has no frontmatter, so `metadataCache.on('changed')` never fires
		 * for one - the vault's own modify event is the only notice we get that a
		 * view was added to or renamed inside a base.
		 */
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (isBaseFile(file)) this.readBaseViews().catch(() => {});
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file && file.path) {
				this.defaultsRows.delete(file.path);
				this.templateRenames.delete(file.path);
				this.baseViews.delete(file.path);
				this.baseTexts.delete(file.path);
			}
			touched(file);
		}));
		/*
		 * A rename can move a note *out* of a watched folder, so the old path
		 * matters as much as the new one.
		 */
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.invalidateClosures();
			if (typeof oldPath === 'string') {
				this.defaultsRows.delete(oldPath);
				this.templateRenames.delete(oldPath);
				this.baseViews.delete(oldPath);
				this.baseTexts.delete(oldPath);
			}
			if (isBaseFile(file) || (typeof oldPath === 'string'
				&& oldPath.slice(-5) === '.base')) {
				this.readBaseViews().catch(() => {});
			}
			if (this.isCharacteristicFile(file)) this.readDefaultsTables().catch(() => {});
			if (this.isTemplateFile(file)) this.readTemplateRenames().catch(() => {});
			this.notePropertyRename(file, oldPath);
			const wasWatched = typeof oldPath === 'string'
				&& [this.settings.notesFolder, this.settings.templatesFolder,
					this.settings.characteristicsFolder]
					.some((folder) => oldPath.indexOf(folder + '/') === 0);
			if (wasWatched || this.inPictureFolders(file)) this.invalidatePicture();
		}));

		this.registerView(VIEW_TYPE, (leaf) => new ClassesView(leaf, this));

		this.registerView(UML_VIEW_TYPE, (leaf) => new UmlView(leaf, this));

		this.addCommand({
			id: 'open-class-diagram',
			name: 'Open the class diagram',
			callback: () => { this.activateUmlView(); },
		});

		this.addRibbonIcon('boxes', 'OOF Class Manager', () => { this.activateView(); });

		/*
		 * A second icon rather than a menu on the first. The panel and the diagram
		 * are two places you go, not two things you do to one place — and an icon
		 * that opens a menu costs a click on every single use to save one row of a
		 * ribbon you have already decided to keep.
		 */
		this.addRibbonIcon('workflow', 'Class diagram', () => { this.activateUmlView(); });

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
		/*
		 * The rename, reachable without the panel. The chip's menu is the
		 * discoverable way in; this is the one that works while reading a note.
		 */
		this.addCommand({
			id: 'rename-characteristic-value',
			name: 'Rename a value of a characteristic',
			callback: () => { new RenameValueModal(this.app, this, {}).open(); },
		});

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

		/*
		 * The hotkey that stands in for the button. It presses Obsidian's own
		 * button rather than reimplementing what it does — adding a property is
		 * Obsidian's business, and a second implementation of it would be a second
		 * thing to keep in step with the properties UI.
		 *
		 * No default binding is proposed. Every combination worth having is taken
		 * by something of his, and silently claiming one would be worse than
		 * asking him to choose.
		 */
		this.addCommand({
			id: 'add-property',
			name: 'Add a property to the open note',
			checkCallback: (checking) => {
				const button = this.addPropertyButton();
				if (checking) return !!button;
				if (!button) return false;
				this.pressAddProperty(button);
				return true;
			},
		});

		this.addSettingTab(new OofClassesSettingTab(this.app, this));

		/* Group headings over the properties panel. Nothing is written. */
		this.propertyObservers = new WeakMap();
		this.registerEvent(this.app.workspace.on('file-open',
			() => this.queuePropertyHeadings()));
		this.registerEvent(this.app.workspace.on('active-leaf-change',
			() => this.queuePropertyHeadings()));
		this.registerEvent(this.app.workspace.on('layout-change',
			() => this.queuePropertyHeadings()));
		this.registerEvent(this.app.metadataCache.on('changed',
			() => this.queuePropertyHeadings()));
		this.register(() => this.clearPropertyHeadings());
		this.app.workspace.onLayoutReady(() => this.queuePropertyHeadings());

		/* And the rename, offered where the value is written. */
		this.registerPropertyValueMenu();

		/* And what that field offers before anything is written at all. */
		this.registerValueSuggestions();

		/*
		 * The Class base button on a generated base's own toolbar. Nothing is
		 * written by drawing it.
		 *
		 * These four force a repaint because each can change which class a base
		 * belongs to - a class renamed, created or deleted, or simply a different
		 * file arriving in the leaf. Everything else reaches it through the
		 * observer, which only repaints a toolbar that has actually been rebuilt.
		 * `changed` is narrowed to the notes folder: a base can sit open for hours
		 * while he types in a journal entry, and each of those keystrokes would
		 * otherwise cost a walk over every class in the vault.
		 */
		this.baseToolbarObservers = new WeakMap();
		this.registerEvent(this.app.workspace.on('file-open',
			() => this.queueBaseToolbars(true)));
		this.registerEvent(this.app.workspace.on('active-leaf-change',
			() => this.queueBaseToolbars(true)));
		this.registerEvent(this.app.workspace.on('layout-change',
			() => this.queueBaseToolbars(true)));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (file && this.inFolder(file, this.settings.notesFolder)) {
				this.queueBaseToolbars(true);
			}
		}));
		this.register(() => this.clearBaseToolbars());
		this.app.workspace.onLayoutReady(() => this.queueBaseToolbars(true));

		/*
		 * The per-view half of the same reading, drawn onto Obsidian's own
		 * Configure view card - his N.B. One observer for the whole app, since the
		 * card is rebuilt every time it opens and again on every layout change.
		 */
		this.registerViewConfigCard();

		/*
		 * The defaults tables. Not awaited: the panel is useful before they arrive,
		 * and the read invalidates the picture itself when it finds anything.
		 */
		this.app.workspace.onLayoutReady(() => {
			this.readDefaultsTables().catch(() => {});
			this.readTemplateRenames().catch(() => {});
			/* Returns at once unless a value rename is waiting; see the method. */
			this.scanValueMentions().catch(() => {});
		});

		/* And the Add property button, hidden or not, per the setting. */
		this.applyAddPropertyVisibility();
		this.register(() => document.body.classList.remove('oof-hide-add-property'));
	}

	async activateView() {
		/* Obsidian may have changed a type since we last looked. */
		await this.loadRegisteredTypes();
		/* And a defaults table may have been edited while the panel was shut. */
		await this.readDefaultsTables();
		await this.readTemplateRenames();

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

	/*
	 * The diagram opens in the main area, not the sidebar — it is a thing you look
	 * at across a screen rather than a list you edit down the side — and a second
	 * call reveals the tab that is already open rather than making another.
	 */
	async activateUmlView() {
		const existing = this.app.workspace.getLeavesOfType(UML_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getLeaf(true);
		if (!leaf) return;
		await leaf.setViewState({ type: UML_VIEW_TYPE, active: true });
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
	 *
	 * **Either tag.** A component is a class — "components will work the same as
	 * classes except that they won't have templates" — so a note wearing only
	 * `#component` is found here exactly as one wearing `#class` is. Which of the
	 * two it should wear is `classTagFor`'s question, and it is asked once, in the
	 * plan.
	 */
	hasClassTag(file) {
		return this.classTags().some((tag) => this.hasTag(file, tag));
	}

	/*
	 * Which tag a class note should carry: the component one where the class is a
	 * component, the plain one otherwise.
	 *
	 * `components` is that set, passed in rather than read here, for the same
	 * reason `characteristicTagFor` takes its own: the plan works on **drafts**,
	 * so a component field typed into a card and not yet written has to count.
	 */
	classTagFor(name, components) {
		return (components && components.has(name))
			? String(this.settings.componentTag || '')
			: String(this.settings.classTag || '');
	}

	/* Both of them, so the wrong one can be taken off. */
	classTags() {
		return [this.settings.classTag, this.settings.componentTag]
			.map((tag) => String(tag || '').replace(/^#/, ''))
			.filter(Boolean);
	}

	/*
	 * The same question for any tag. Read through metadataCache's own tag list, so
	 * `tags:` in frontmatter and `#class` in the body both count — one note may
	 * say it either way and mean the same thing.
	 */
	hasTag(file, tag) {
		if (!tag || !file) return false;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return false;

		const wanted = '#' + String(tag).replace(/^#/, '');
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
	 * Which tag a characteristic note should carry: the component-field one where
	 * some class lists it under `component fields`, the plain one otherwise.
	 *
	 * `fields` is that set, passed in rather than read here, because the plan
	 * works on **drafts** — a component field added in the panel and not yet
	 * written has to count, or Update would create the note with the wrong tag and
	 * immediately want to change it.
	 */
	characteristicTagFor(name, fields) {
		return (fields && fields.has(name))
			? String(this.settings.componentFieldTag || '')
			: String(this.settings.characteristicTag || '');
	}

	/* Both of them, so the wrong one can be taken off. */
	characteristicTags() {
		return [this.settings.characteristicTag, this.settings.componentFieldTag]
			.map((tag) => String(tag || '').replace(/^#/, ''))
			.filter(Boolean);
	}

	/*
	 * Every characteristic some class declares as a component field, off the
	 * drafts. The panel's unsaved edits count — see `characteristicTagFor`.
	 */
	componentFieldNames(drafts) {
		const found = new Set();
		for (const draft of drafts.values()) {
			for (const field of draft.componentFields || []) {
				if (field) found.add(field);
			}
		}
		return found;
	}

	/*
	 * Which classes are **components** — the classes that are composed into other
	 * notes rather than instantiated. His note `Difference between classes and
	 * components`, 2026-09-05: *"a new tag be added, `#component`, and that this
	 * tag be used for all components."*
	 *
	 * **The tag is the declaration.** A class is a component because its note says
	 * so, and for no other reason. That is the plain reading of his sentence, and
	 * it is also the only version he can *see*: the answer is written on the note
	 * he is looking at, in one word, and changing it changes the answer.
	 *
	 * **This is a correction of what I built first.** v3.0.0 derived it instead —
	 * from the `possible values` of the characteristics some class lists under
	 * `component fields` — and wrote the tag as a *report* of that, the way
	 * `#componentfield` reports which of a class's two lists a characteristic sits
	 * in. The argument was that the vault already said it and a hand-written tag
	 * would be a second declaration free to disagree. Two things are wrong with
	 * that, and he found both within the hour:
	 *
	 *   1. **the input was invisible.** `#componentfield` is derived from a row on
	 *      the class card, one line, in front of you. This was derived from the
	 *      frontmatter of a characteristic note one indirection away, plus a
	 *      transitive closure — *"I don't understand how the program decides what
	 *      is a component and what is a class."* A derivation nobody can run in
	 *      their head is not a derivation, it is a verdict.
	 *   2. **he had already used the tag as an input.** He put `#component` on
	 *      `Calendar Event` by hand and nothing happened, because no component
	 *      field points at it — the plan was in fact going to take the tag back off
	 *      and write `#class` over it.
	 *
	 * So: read, never derived.
	 *
	 * **It travels down `type of`**, because his fourth rule leaves no choice —
	 * *"it is impossible for a class to be a type of a component and vice versa"* —
	 * and a subclass of a component is the thing that actually gets written into a
	 * component field. Update writes the tag onto those too, so *"used for all
	 * components"* holds literally and a search for `#component` finds the whole
	 * tree. That is one hop of inheritance off a value you can read, which is the
	 * same shape as `symbol:` and is small enough to hold in your head.
	 *
	 * The other direction cannot be settled here and is not guessed at: a class
	 * tagged `#component` whose parent is a plain class is the one violation left,
	 * and `structuralDiscrepancies` reports it while `componentDisputes` keeps
	 * everything from acting on it.
	 *
	 * Pure over its argument, with no cache: the picture and the plan build their
	 * own `drafts` and both call this, so there is one answer rather than two.
	 *
	 * Returns a Map from the class name to how it got here, so everything that
	 * turns on this can say why in words.
	 */
	componentClasses(drafts) {
		const found = new Map();
		if (!drafts || !this.settings.componentTag) return found;

		/* Declared: the note carries the tag. Nothing else makes a root. */
		for (const [name, draft] of drafts) {
			if (!draft.file) continue;
			if (this.hasTag(draft.file, this.settings.componentTag)) {
				found.set(name, { root: name, declared: true, via: null });
			}
		}

		if (found.size === 0) return found;

		/* And down through `type of`, off the drafts so unsaved edits count. */
		const children = new Map();
		for (const [name, draft] of drafts) {
			for (const parent of (draft.values
				&& draft.values[this.settings.inheritsProperty]) || []) {
				if (!children.has(parent)) children.set(parent, []);
				children.get(parent).push(name);
			}
		}

		let frontier = Array.from(found.keys());
		let depth = 0;
		while (frontier.length > 0 && depth < MAX_DEPTH) {
			const next = [];
			for (const name of frontier) {
				for (const child of children.get(name) || []) {
					/*
					 * A class that says so itself keeps saying so: its own tag is a
					 * statement, and being reached from above as well changes nothing
					 * about it. Only a class that has *not* declared is described here
					 * as inheriting, which is what the reason has to get right.
					 */
					if (found.has(child)) continue;
					const from = found.get(name);
					found.set(child, { root: from.root, declared: false, via: name });
					next.push(child);
				}
			}
			frontier = next;
			depth += 1;
		}

		return found;
	}

	/*
	 * Why this class is a component, in one sentence. Two answers, because there
	 * are exactly two ways to be one and they are not the same fact: one is
	 * something the note says, the other is something it inherits.
	 */
	componentReason(name, components) {
		const entry = components && components.get(name);
		if (!entry) return '';

		const tag = '#' + String(this.settings.componentTag || 'component');
		if (entry.declared) {
			return name + ' is tagged ' + tag + ', so it is filled into a component '
				+ 'field rather than instantiated.';
		}
		return name + ' is a ' + this.settings.inheritsProperty + ' ' + entry.via
			+ ', and ' + entry.root + ' is tagged ' + tag + ' — and a '
			+ this.settings.inheritsProperty + ' a component is a component.';
	}

	/*
	 * Classes whose kind is in dispute: a component that is *also* a
	 * `type of` a plain class. His fourth rule — *"it is impossible for a class
	 * to be a type of a component and vice versa"* — is true downward by
	 * construction, so this is the only shape it can be broken in, and it is
	 * reached from the component's side because that is the side that knows.
	 *
	 * **Nothing acts on one of these.** The plan leaves the class's tag and its
	 * template exactly as they are, and `structuralDiscrepancies` reports it
	 * instead. That is the plugin's oldest discipline applied to a derivation
	 * rather than to a value: where the model contradicts itself the answer is
	 * his, and trashing a template on the strength of a derivation the plugin is
	 * simultaneously calling broken is the worst of both — he resolves it the
	 * other way and the file has already gone.
	 *
	 * One helper for both readers, so the plan and the discrepancy list cannot
	 * come to disagree about which classes are in dispute.
	 */
	componentDisputes(drafts, components) {
		const found = new Map();
		if (!drafts || !components) return found;

		for (const [name, entry] of components) {
			if (!entry) continue;
			const draft = drafts.get(name);
			if (!draft) continue;
			const strangers = (draft.values
				&& draft.values[this.settings.inheritsProperty] || [])
				.filter((parent) => drafts.has(parent) && !components.has(parent));
			if (strangers.length > 0) found.set(name, strangers);
		}
		return found;
	}

	/*
	 * The same question asked of the picture, for everything that draws rather
	 * than plans: the panel's cards, its buttons and its menus all have a name and
	 * no `drafts` to hand.
	 */
	isComponent(name) {
		const picture = this.picture();
		return !!(picture.componentClasses && picture.componentClasses.has(name));
	}

	/*
	 * And whether its kind is in dispute rather than settled. The panel needs the
	 * two apart: it will not *make* an instance of a class whose kind it cannot
	 * state, but it will not hide a template the plan has deliberately kept.
	 */
	isDisputedComponent(name) {
		const picture = this.picture();
		return !!(picture.componentDisputes && picture.componentDisputes.has(name));
	}

	/*
	 * Why an instance of this class is refused, in the shape a Notice wants. One
	 * sentence in two versions, so every route out of the plugin — the panel's
	 * buttons, the menu, the command palette — refuses in the same words, and a
	 * class whose kind is unsettled is never told it has no template when its
	 * template is on disk.
	 */
	componentRefusal(names) {
		const list = toArray(names).filter((name) => this.isComponent(name));
		if (list.length === 0) return '';

		const disputed = list.filter((name) => this.isDisputedComponent(name));
		if (disputed.length > 0) {
			return andList(disputed) + ' is a component by one parent and a class by '
				+ 'another, so its kind is unsettled. Settle that first — the '
				+ 'discrepancy list names the parents.';
		}
		/*
		 * The property is named in backticks rather than read as a verb: with
		 * `is a` as its name, "nothing is is a it" is what the obvious sentence
		 * produces.
		 */
		return andList(list) + ' ' + (list.length === 1 ? 'is a component' : 'are components')
			+ ': filled into a component field rather than instantiated, so no note '
			+ 'should name ' + (list.length === 1 ? 'it' : 'them') + ' under `'
			+ this.settings.isAProperty + '`.';
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

	/*
	 * What a base characteristic's values *are*. Three kinds, and the difference
	 * matters at every edge — reading them off frontmatter, writing them back, and
	 * drawing them as chips.
	 *
	 *   characteristic  a property name, written `[[∘ domain]]`, shown as `domain`
	 *   component       the same spelling — a property name — but the property it
	 *                   names holds a *class* rather than a subject, so the row is
	 *                   read and written like `characteristics` and means something
	 *                   else entirely. Its own kind rather than a flag, because the
	 *                   panel draws a different row under it and `possible values`
	 *                   is read differently there.
	 *   class           a class name, canonicalised so `[[note]]` and `[[Note]]`
	 *                   are one class
	 *   view            a base, and past a `#` one view inside it
	 *
	 * **`views` is the reason this exists** (2026-09-01, his report — *"adding
	 * views doesn't really seem to work … it's still grayed out"*). Every base
	 * characteristic used to be read as a class name, which for a view is wrong
	 * twice over: `linkName()` drops both the `.base` and the `#dynamic project`,
	 * so the chip was greyed as a class with no note **and the next write of that
	 * class note would have put `[[Improvement Base]]` back in place of the view he
	 * chose**. The greying was the visible half of a silent data loss.
	 */
	logicValueKind(property) {
		if (property === this.settings.characteristicsProperty) return 'characteristic';
		if (property && property === this.settings.componentsProperty) return 'component';
		if (this.isViewProperty(property)) return 'view';
		return 'class';
	}

	/*
	 * Both view streams, in one predicate. They differ only in *who receives* a
	 * view — instances against subtypes — and in nothing else: both hold
	 * `[[Some Base.base#a view]]`, so both rows suggest bases, keep the subpath,
	 * grey on a missing base, and open one. Every caller that used to compare
	 * against `viewsProperty` asks this instead, which is what makes the second
	 * row cost no rendering code at all.
	 */
	isViewProperty(property) {
		if (!property) return false;
		return property === this.settings.viewsProperty
			|| property === this.settings.classViewsProperty;
	}

	/* Both kinds whose values are characteristic names, so spelled `[[∘ x]]`. */
	namesCharacteristic(kind) {
		return kind === 'characteristic' || kind === 'component';
	}

	/* Read every base characteristic off one note's frontmatter. */
	readLogicValues(frontmatter) {
		const values = this.emptyLogicValues();

		for (const property of this.settings.logicProperties) {
			const kind = this.logicValueKind(property);

			values[property] = toArray(frontmatter[property])
				/* A view keeps its subpath; everything else is reduced to a name. */
				.map((entry) => (kind === 'view' ? viewLink(entry) : linkName(entry)))
				.filter(Boolean)
				/*
				 * A view is not a note name, so there is nothing to canonicalise it
				 * against — and doing so would resolve `Improvement Base.base` to
				 * whatever `.md` happened to be near it.
				 */
				.map((name) => (kind === 'view' ? name : this.canonicalName(name)))
				/* `[[∘ domain]]` names the characteristic `domain`. */
				.map((name) => (this.namesCharacteristic(kind)
					? stripPrefix(name, this.settings.characteristicPrefix) : name));
		}

		return values;
	}

	/*
	 * A characteristic note has been renamed, so the property it names has been
	 * renamed with it.
	 *
	 * Nothing else can see this. Only the file system knows `domain` used to be
	 * called something else; the notes carrying `domain:` say nothing about where
	 * the name came from, and by the time Update runs the old note is gone. So it
	 * is caught at the moment it happens and written down.
	 *
	 * The prefix pass renames `domain.md` to `∘ domain.md`, which is the same
	 * characteristic under a tidier file name — `from` and `to` come out equal
	 * and nothing is recorded.
	 */
	notePropertyRename(file, oldPath) {
		if (!(file instanceof TFile) || typeof oldPath !== 'string') return;
		const folder = this.settings.characteristicsFolder;
		if (!folder) return;
		if (oldPath.indexOf(folder + '/') !== 0) return;
		if (!this.inFolder(file, folder)) return;

		const prefix = this.settings.characteristicPrefix;
		const wasFile = oldPath.split('/').pop().replace(/\.md$/, '');
		const from = stripPrefix(wasFile, prefix);
		const to = stripPrefix(file.basename, prefix);
		if (!from || !to || from === to) return;

		const pending = toArray(this.settings.pendingPropertyRenames)
			.filter((entry) => entry && entry.from && entry.to);

		/*
		 * Renamed twice before Update ran: follow the chain rather than recording
		 * two hops, or the second would look for a key the first already moved.
		 */
		const earlier = pending.find((entry) => entry.to === from);
		if (earlier) earlier.to = to;
		else if (!pending.some((entry) => entry.from === from)) pending.push({ from: from, to: to });

		this.settings.pendingPropertyRenames = pending
			.filter((entry) => entry.from !== entry.to);
		this.persist();
	}

	/*
	 * A property key the notes carry that no characteristic note defines.
	 *
	 * `notePropertyRename` catches a rename *as it happens*, which is the only
	 * moment the vault knows one occurred. It cannot catch one made while the
	 * plugin was off, or before it could — and those leave exactly this shape
	 * behind: sixty-nine notes carrying `lifespan` with nothing declaring it.
	 *
	 * Reported as one item per key rather than one per note, because it is one
	 * question — what was this renamed to? — asked sixty-nine times.
	 */
	/*
	 * A property the **system** owns, as opposed to one describing a subject: the
	 * base characteristics, the ones retired from that list, the native attributes,
	 * and the class's symbol.
	 *
	 * One function because there are two passes that must agree about this and they
	 * did not: `symbol` was excused in `unclaimedKeys` and not here, so the plugin
	 * wrote `symbol:` onto five class notes and then reported those same five notes
	 * for carrying a property nothing declares — an **insolvable** discrepancy,
	 * which blocks Update. Two copies of one rule is one copy too many.
	 */
	isSystemProperty(key) {
		if (this.settings.logicProperties.includes(key)) return true;
		if (toArray(this.settings.retiredLogicProperties).includes(key)) return true;
		if (this.isIgnoredProperty(key)) return true;
		if (this.settings.symbolProperty && key === this.settings.symbolProperty) return true;
		return false;
	}

	strandedProperties(characteristics) {
		const found = new Map();

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.inSystemFolder(file)) continue;
			const frontmatter = this.frontmatterOf(file);
			if (!frontmatter) continue;

			for (const key of Object.keys(frontmatter)) {
				if (characteristics.has(key)) continue;
				if (this.isSystemProperty(key)) continue;
				if (isTemplaterExpression(frontmatter[key])) continue;

				if (!found.has(key)) {
					found.set(key, { key: key, files: [], values: [], empty: 0 });
				}
				const entry = found.get(key);
				entry.files.push(file);
				if (isEmptyValue(frontmatter[key])) entry.empty += 1;
				else {
					for (const value of toArray(frontmatter[key])) {
						const text = String(value).trim();
						if (text && entry.values.indexOf(text) === -1) entry.values.push(text);
					}
				}
			}
		}

		return found;
	}

	/*
	 * Which characteristic this stranded key most likely became.
	 *
	 * By the **values it holds**, against each characteristic's `possible values`
	 * — evidence rather than a guess about names. `lifespan` holding `current`
	 * and `legacy` against a `life stage` that allows `current, dated, legacy` is
	 * a match; against a `maturity` that allows four Pokémon it is not. Null when
	 * nothing overlaps, which is honest: he is the one who knows.
	 */
	suggestRenameFor(entry, characteristics) {
		if (entry.values.length === 0) return null;

		let best = null;
		let bestScore = 0;
		for (const [name, characteristic] of characteristics) {
			const allowed = toArray(characteristic.possibleValues)
				.map((value) => String(value).toLowerCase());
			if (allowed.length === 0) continue;
			const hits = entry.values.filter(
				(value) => allowed.indexOf(String(value).toLowerCase()) !== -1).length;
			if (hits === 0 || hits < entry.values.length) continue;
			const score = hits / allowed.length;
			if (score > bestScore) { bestScore = score; best = name; }
		}
		return best;
	}

	/*
	 * Record a rename he has told us about, the same way one the plugin watched
	 * happen is recorded — so from here on there is only one path.
	 */
	async recordPropertyRename(from, to) {
		const before = String(from || '').trim();
		const after = String(to || '').trim();
		if (!before || !after || before === after) return;

		const pending = toArray(this.settings.pendingPropertyRenames)
			.filter((entry) => entry && entry.from && entry.to);

		const earlier = pending.find((entry) => entry.to === before);
		if (earlier) earlier.to = after;
		else if (!pending.some((entry) => entry.from === before)) {
			pending.push({ from: before, to: after });
		}

		this.settings.pendingPropertyRenames = pending
			.filter((entry) => entry.from !== entry.to);
		this.invalidatePicture();
		await this.persist();
		this.refreshViews();
	}

	/*
	 * Carrying those renames into the notes: every note holding the old key gets
	 * the new one, with the value.
	 */
	propertyRenameActions(characteristics, conflicts) {
		const actions = [];
		const pending = toArray(this.settings.pendingPropertyRenames)
			.filter((entry) => entry && entry.from && entry.to && entry.from !== entry.to);
		if (pending.length === 0) return actions;

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.inFolder(file, this.settings.characteristicsFolder)) continue;
			if (this.inFolder(file, this.settings.basesFolder)) continue;
			const frontmatter = this.frontmatterOf(file);
			if (!frontmatter) continue;

			for (const entry of pending) {
				if (!(entry.from in frontmatter)) continue;

				/*
				 * Both keys present and both holding something. Which value is the
				 * real one is his call, not a guess — the same rule every other
				 * populated collision follows.
				 */
				if (entry.to in frontmatter
					&& !isEmptyValue(frontmatter[entry.to])
					&& !isEmptyValue(frontmatter[entry.from])) {
					conflicts.push({
						file: file,
						property: entry.from,
						value: frontmatter[entry.from],
						reason: '"' + entry.from + '" was renamed to "' + entry.to
							+ '", but this note already has a "' + entry.to
							+ '" with a value of its own. Both are left as they are.',
					});
					continue;
				}

				actions.push({
					kind: 'rename-property',
					label: 'Rename "' + entry.from + '" to "' + entry.to
						+ '" on "' + file.basename + '"',
					file: file,
					path: file.path,
					from: entry.from,
					to: entry.to,
					detail: [
						'The characteristic note was renamed, so the property is renamed '
							+ 'with it — the value moves across rather than being left '
							+ 'behind under a name nothing declares any more.',
					],
				});
			}
		}

		return actions;
	}

	/* ----- renaming a value ------------------------------------------------
	 *
	 * The pass above moves a key. This moves what is written *under* one, on
	 * every note that holds it and nowhere else — which is the whole difference
	 * between it and a search and replace. `status: implemented` becoming
	 * `status: completed` must leave `category: implemented` alone, and must
	 * leave the word `implemented` in a sentence alone.
	 *
	 * Three things carry the rename, and they are one rename:
	 *
	 *   the notes            `status: implemented`  ->  `status: completed`
	 *   the characteristic   the entry in `possible values`, and `default value`
	 *   its defaults table   any cell holding the old word
	 *
	 * The characteristic note is not an afterthought. Leaving `possible values`
	 * saying `implemented` would turn every note the rename just moved into a
	 * conflict, which is the opposite of what was asked for.
	 */

	pendingValueRenames() {
		return toArray(this.settings.pendingValueRenames).filter((entry) =>
			entry && entry.characteristic && entry.from && entry.to
			&& entry.from !== entry.to);
	}

	/*
	 * Record a rename he has told us about. Nothing is written here — the same
	 * covenant every other edit follows: it becomes a plan, he sees the count and
	 * the diff, and Update does the writing.
	 */
	async recordValueRename(characteristic, from, to) {
		const name = String(characteristic || '').trim();
		const before = String(from || '').trim();
		const after = String(to || '').trim();
		if (!name || !before || !after || before === after) return;

		const pending = this.pendingValueRenames();

		/*
		 * Renaming twice before an Update follows the chain rather than trying
		 * each hop, exactly as the property renames do — by Update time only the
		 * far end of `idea -> thought -> seed` is on the notes, so the middle hop
		 * would find nothing and the first would find the wrong thing.
		 */
		const sameLine = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
		const earlier = pending.find((entry) =>
			entry.characteristic === name && sameLine(entry.to, before));
		if (earlier) earlier.to = after;
		else if (!pending.some((entry) =>
			entry.characteristic === name && sameLine(entry.from, before))) {
			pending.push({ characteristic: name, from: before, to: after });
		}

		this.settings.pendingValueRenames = pending.filter((entry) => entry.from !== entry.to);
		this.invalidatePicture();
		await this.persist();
		/* What the rename cannot reach, so it can be named rather than broken. */
		this.scanValueMentions().catch(() => {});
		this.refreshViews();
	}

	/* Carrying those renames into the vault. */
	valueRenameActions(characteristics) {
		const actions = [];
		const pending = this.pendingValueRenames();
		if (pending.length === 0) return actions;

		/*
		 * The notes, the classes and the templates. A template holding a default
		 * value is renamed with everything else — it is a real value, and every
		 * note made from it will carry it.
		 */
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.inFolder(file, this.settings.characteristicsFolder)) continue;
			if (this.inFolder(file, this.settings.basesFolder)) continue;
			const frontmatter = this.frontmatterOf(file);
			if (!frontmatter) continue;

			const properties = [];
			const said = [];
			for (const entry of pending) {
				const value = frontmatter[entry.characteristic];
				if (value === undefined || isTemplaterExpression(value)) continue;
				if (renameWithin(value, entry.from, entry.to) === null) continue;
				properties.push({
					property: entry.characteristic, from: entry.from, to: entry.to,
				});
				said.push('"' + entry.from + '" to "' + entry.to + '"');
			}
			if (properties.length === 0) continue;

			actions.push({
				kind: 'rename-value',
				label: 'Rename ' + andList(said) + ' on "' + file.basename + '"',
				file: file,
				path: file.path,
				property: properties[0].property,
				properties: properties,
				detail: [
					'Under ' + andList(properties.map((p) => '"' + p.property + '"'))
						+ ' only. The key stays, its other values stay, and nothing '
						+ 'outside the frontmatter is read.',
				],
			});
		}

		/*
		 * What the characteristic itself says is allowed. `default value` was read
		 * here too until it was retired; a default now lives in the defaults table,
		 * which `rename-defaults-value` below follows the value into.
		 */
		for (const entry of pending) {
			const characteristic = characteristics.get(entry.characteristic);
			if (!characteristic || !characteristic.file) continue;

			const frontmatter = this.frontmatterOf(characteristic.file) || {};
			const properties = [];
			for (const key of ['possible values']) {
				if (renameWithin(frontmatter[key], entry.from, entry.to) === null) continue;
				properties.push({ property: key, from: entry.from, to: entry.to });
			}

			if (properties.length > 0) {
				actions.push({
					kind: 'rename-value',
					label: 'Rename "' + entry.from + '" to "' + entry.to + '" in '
						+ andList(properties.map((p) => p.property)) + ' on "'
						+ characteristic.file.basename + '"',
					file: characteristic.file,
					path: characteristic.file.path,
					property: entry.characteristic,
					properties: properties,
					detail: [
						'What ' + entry.characteristic + ' says is allowed, moved with the '
							+ 'notes. Left behind it would make every note this rename '
							+ 'just touched a conflict.',
					],
				});
			}

			const cells = this.defaultsCellsHolding(characteristic, entry.from);
			if (cells.length === 0) continue;

			actions.push({
				kind: 'rename-defaults-value',
				label: 'Rename "' + entry.from + '" to "' + entry.to
					+ '" in the defaults table of "' + characteristic.file.basename + '"',
				file: characteristic.file,
				path: characteristic.file.path,
				property: entry.characteristic,
				from: entry.from,
				to: entry.to,
				cells: cells,
				detail: [
					andList(cells.map((cell) => cell.location + ' · '
						+ DEFAULTS_COLUMNS[cell.column])) + '.',
					'The one time the table is written rather than read. Only cells '
						+ 'holding exactly that word change; every other line of the note '
						+ 'comes out byte-identical.',
				],
			});
		}

		return actions;
	}

	/*
	 * Which cells of a characteristic's defaults table hold this word. All four
	 * value columns, and the column *number* comes from that table's own map — a
	 * table written before today has its columns somewhere else, and a rename
	 * that rewrote cell 2 by number would put the new word in the wrong claim.
	 */
	defaultsCellsHolding(characteristic, word) {
		const wanted = String(word).trim().toLowerCase();
		const cells = [];
		if (!characteristic) return cells;
		for (const row of toArray(characteristic.defaults)) {
			for (const key of DEFAULTS_VALUE_KEYS) {
				if (row.columns[key] === undefined) continue;
				if (String(row[key] || '').trim().toLowerCase() !== wanted) continue;
				cells.push({ column: row.columns[key], location: row.location });
			}
		}
		return cells;
	}

	/* Is there anything left for this rename to do? */
	valueRenameOutstanding(entry, characteristics) {
		const characteristic = characteristics.get(entry.characteristic);
		if (characteristic && characteristic.file) {
			const frontmatter = this.frontmatterOf(characteristic.file) || {};
			if (renameWithin(frontmatter['possible values'], entry.from, entry.to) !== null) {
				return true;
			}
			if (this.defaultsCellsHolding(characteristic, entry.from).length > 0) return true;
		}

		return this.app.vault.getMarkdownFiles().some((file) => {
			if (this.inFolder(file, this.settings.characteristicsFolder)) return false;
			if (this.inFolder(file, this.settings.basesFolder)) return false;
			const frontmatter = this.frontmatterOf(file);
			return !!frontmatter
				&& !isTemplaterExpression(frontmatter[entry.characteristic])
				&& renameWithin(frontmatter[entry.characteristic],
					entry.from, entry.to) !== null;
		});
	}

	/*
	 * The words a characteristic actually enumerates.
	 *
	 * A class constraint and an interval are not enumerations — nothing in them
	 * can be "the word it should have become" — so only the literals count when
	 * a rename is being guessed at.
	 */
	literalValuesOf(characteristic, picture) {
		return this.constraintsFor(characteristic, picture)
			.filter((constraint) => constraint.kind === 'literal')
			.map((constraint) => constraint.name);
	}

	/*
	 * Values the notes hold that their characteristic no longer allows, gathered
	 * **by value** rather than by note.
	 *
	 * This is the stranded-property question one level down, and it has the same
	 * answer. Renaming a word in `possible values` strands every note still
	 * holding the old one, and the plugin cannot know what it became — but
	 * twenty-one notes all holding the same disallowed word is a shape, not
	 * twenty-one separate mistakes, and it can carry the answer once he gives it.
	 */
	strandedValues(picture) {
		const found = new Map();
		/*
		 * One characteristic's constraints are the same for every note carrying
		 * it, and this walk asks for them once per note per key - three thousand
		 * times over on his vault. Built once each instead.
		 */
		const constraintsOf = new Map();

		this.walkValues(picture, (file, key, value) => {
			const characteristic = picture.characteristics.get(key);
			if (!characteristic) return;
			if (isTemplaterExpression(value)) return;

			if (!constraintsOf.has(key)) {
				constraintsOf.set(key, this.constraintsFor(characteristic, picture));
			}
			const constraints = constraintsOf.get(key);
			/* Only where words are enumerated: see literalValuesOf. */
			if (!constraints.some((constraint) => constraint.kind === 'literal')) return;

			for (const entry of toArray(value)) {
				if (isEmptyValue(entry)) continue;
				/* A link is a note, and a note is renamed by renaming it. */
				if (isWikiLink(entry)) continue;
				if (constraints.some((c) => this.admits(c, entry, file ? file.path : ''))) {
					continue;
				}

				const text = String(entry).trim();
				if (!text) continue;
				if (!found.has(key)) found.set(key, new Map());
				const byValue = found.get(key);
				const id = text.toLowerCase();
				if (!byValue.has(id)) {
					byValue.set(id, { characteristic: key, value: text, files: [] });
				}
				byValue.get(id).files.push(file);
			}
		});

		return found;
	}

	/*
	 * Which word this stranded one most likely became: one the characteristic now
	 * allows that no note anywhere uses.
	 *
	 * One such word is evidence — it was added and nothing has it yet, which is
	 * exactly what a rename looks like from outside. Two is a guess, and the
	 * whole point of asking is that he is the one who knows.
	 */
	suggestValueRenameFor(key, picture) {
		const characteristic = picture.characteristics.get(key);
		if (!characteristic) return null;

		const allowed = this.literalValuesOf(characteristic, picture);
		if (allowed.length === 0) return null;

		const used = this.valuesInUse(key);
		const spare = allowed.filter(
			(word) => !used.has(String(word).trim().toLowerCase()));
		return spare.length === 1 ? spare[0] : null;
	}

	/*
	 * Every value written under one characteristic anywhere in the vault, with
	 * the notes holding each. What the rename modal offers, and what tells a word
	 * that has fallen out of use from one that never entered it.
	 *
	 * Walked over the files themselves rather than over the picture, and that is
	 * load-bearing: this is the same set `valueRenameActions` writes to, so the
	 * count the modal shows before the rename is the count of notes the rename
	 * will change. A number gathered from anywhere else could differ from what
	 * happens, and that number is the whole of the reassurance the modal owes.
	 */
	valuesInUse(key) {
		const found = new Map();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.inFolder(file, this.settings.characteristicsFolder)) continue;
			if (this.inFolder(file, this.settings.basesFolder)) continue;

			const frontmatter = this.frontmatterOf(file);
			if (!frontmatter) continue;
			const value = frontmatter[key];
			if (value === undefined || isTemplaterExpression(value)) continue;

			for (const entry of toArray(value)) {
				if (isEmptyValue(entry)) continue;
				const text = String(entry).trim();
				if (!text) continue;
				const id = text.toLowerCase();
				if (!found.has(id)) {
					found.set(id, { value: text, files: [], link: isWikiLink(entry) });
				}
				found.get(id).files.push(file);
			}
		}
		return found;
	}

	/*
	 * Where the old word is still written outside frontmatter: inside a base, or
	 * in the prose of a note.
	 *
	 * Neither is touched. A base filter is an expression and a sentence is prose,
	 * and replacing text inside either is the fuzzy search-and-replace this
	 * feature exists to avoid — so they are **named** instead, and he decides.
	 *
	 * Read in the background and kept, because the planner is synchronous: the
	 * same arrangement `defaultsRows` and `templateRenames` use. It runs only
	 * while a rename is pending, so the ordinary cost of having this feature is
	 * nothing at all.
	 */
	async scanValueMentions() {
		const pending = this.pendingValueRenames();
		if (pending.length === 0) {
			this.valueMentions = new Map();
			return;
		}
		if (this.scanningMentions) return;
		this.scanningMentions = true;

		const found = new Map();
		for (const entry of pending) {
			found.set(valueRenameKey(entry.characteristic, entry.from),
				{ bases: [], notes: [] });
		}

		try {
			for (const file of this.app.vault.getFiles()) {
				const isBase = file.extension === 'base';
				if (!isBase && file.extension !== 'md') continue;

				let text = '';
				try { text = await this.app.vault.cachedRead(file); } catch (error) { continue; }
				const body = isBase ? text : withoutFrontmatter(text);

				for (const entry of pending) {
					if (!mentionsWord(body, entry.from)) continue;
					const bucket = found.get(valueRenameKey(entry.characteristic, entry.from));
					(isBase ? bucket.bases : bucket.notes).push({
						file: file,
						/*
						 * The lines themselves, so the report can show *where* rather
						 * than only *that*. Kept here because the panel is synchronous
						 * and this is the one pass that has the text open. Capped:
						 * this is a pointer to the file, not a copy of it.
						 */
						lines: this.mentionLines(text, body, entry.from),
					});
				}
			}
		} finally {
			this.scanningMentions = false;
		}

		this.valueMentions = found;
		this.refreshViews();
	}

	/*
	 * Where in a file the word still appears: the line number as the file counts
	 * them, and the line. Only the body is searched — a value in frontmatter is
	 * renamed like any other and is not a mention at all — so the offset of the
	 * body within the file is added back, or every number would be wrong by the
	 * length of the properties.
	 */
	mentionLines(text, body, word) {
		const offset = String(text).slice(0, String(text).length - String(body).length)
			.split('\n').length - 1;

		const found = [];
		const lines = String(body).split('\n');
		for (let i = 0; i < lines.length && found.length < 6; i += 1) {
			if (!mentionsWord(lines[i], word)) continue;
			const shown = lines[i].trim();
			found.push({
				number: offset + i + 1,
				text: shown.length > 160 ? shown.slice(0, 157) + '…' : shown,
			});
		}
		return found;
	}

	valueMentionsFor(entry) {
		const found = this.valueMentions
			&& this.valueMentions.get(valueRenameKey(entry.characteristic, entry.from));
		return found || { bases: [], notes: [] };
	}

	/*
	 * A name that is a characteristic's file name rather than a class's.
	 *
	 * The prefix is what tells them apart on sight, and it is the only thing that
	 * does: a class and a characteristic are both notes with a name. So a name
	 * carrying it has come from the wrong side of the model, and no class should
	 * ever be made out of it.
	 */
	looksLikeCharacteristic(name) {
		const prefix = String(this.settings.characteristicPrefix || '').trim();
		if (!prefix) return false;
		return String(name || '').trim().indexOf(prefix) === 0;
	}

	/* The file name a characteristic's note has, or should have. */
	characteristicFileName(name) {
		return addPrefix(name, this.settings.characteristicPrefix);
	}

	characteristicPath(name) {
		return this.settings.characteristicsFolder + '/'
			+ this.characteristicFileName(name) + '.md';
	}

	/* ----- the defaults tables ---------------------------------------------- */

	isCharacteristicFile(file) {
		return !!file && file.extension === 'md'
			&& this.inFolder(file, this.settings.characteristicsFolder);
	}

	/*
	 * Read every characteristic note's body and keep its defaults rows. Called
	 * once at layout, and again whenever one is created or renamed; an edit to an
	 * open note arrives through `metadataCache.on('changed')` instead, which hands
	 * over the text and needs no read at all.
	 */
	async readDefaultsTables() {
		let changed = false;
		const seen = new Set();

		for (const file of this.filesIn(this.settings.characteristicsFolder)) {
			seen.add(file.path);
			let text = '';
			try { text = await this.app.vault.cachedRead(file); } catch (error) { continue; }
			if (this.rememberDefaults(file, text, true)) changed = true;
		}

		for (const path of Array.from(this.defaultsRows.keys())) {
			if (!seen.has(path)) { this.defaultsRows.delete(path); changed = true; }
		}

		if (changed) {
			this.invalidatePicture();
			this.refreshViews();
		}
		return changed;
	}

	/*
	 * Store one note's rows. Returns whether anything actually moved, so a
	 * keystroke in a characteristic note that is not in its table does not rebuild
	 * the picture and redraw the panel.
	 */
	rememberDefaults(file, text, quiet) {
		if (!this.isCharacteristicFile(file)) return false;

		const entry = {
			rows: parseDefaultsTable(text),
			hasTable: hasDefaultsTable(text),
			allRows: findAllNotesRows(text),
			/* Tables whose columns are not the ones written today. */
			legacy: findLegacyDefaultsTables(text),
		};
		const before = this.defaultsRows.get(file.path);
		const same = before
			&& before.hasTable === entry.hasTable
			&& JSON.stringify(before.rows) === JSON.stringify(entry.rows)
			&& JSON.stringify(before.allRows) === JSON.stringify(entry.allRows)
			&& JSON.stringify(before.legacy) === JSON.stringify(entry.legacy);
		if (same) return false;

		this.defaultsRows.set(file.path, entry);
		if (!quiet) { this.invalidatePicture(); this.refreshViews(); }
		return true;
	}

	/* ----- what a `views` chip can offer ------------------------------------ */

	/*
	 * The views inside each `.base`, by path.
	 *
	 * A base's views live in its body, and a body can only be read
	 * asynchronously, while the panel that offers them is synchronous — the same
	 * arrangement `defaultsRows` and `templateRenames` use, and for the same
	 * reason. The cost is one pass over the bases at startup.
	 */
	async readBaseViews() {
		let changed = false;
		const seen = new Set();

		for (const file of this.app.vault.getFiles()) {
			if (file.extension !== 'base') continue;
			seen.add(file.path);

			let text = '';
			try { text = await this.app.vault.cachedRead(file); } catch (error) { continue; }
			if (this.rememberBaseViews(file, text)) changed = true;
		}

		for (const path of Array.from(this.baseViews.keys())) {
			if (!seen.has(path)) {
				this.baseViews.delete(path);
				this.baseTexts.delete(path);
				changed = true;
			}
		}

		if (changed) this.refreshViews();
		return changed;
	}

	/*
	 * One base's view names. Parsed with Obsidian's own YAML rather than by hand,
	 * and a base that will not parse is remembered as having none — being unable
	 * to read its views is no reason to forget the base.
	 */
	rememberBaseViews(file, text) {
		let names = [];
		try {
			const data = obsidian.parseYaml(text);
			const views = data && Array.isArray(data.views) ? data.views : [];
			names = views
				.map((view) => (view && typeof view.name === 'string' ? view.name.trim() : ''))
				.filter((name) => name.length > 0);
		} catch (error) {
			names = [];
		}

		/*
		 * The text counts as a change as much as the view names do, because a class
		 * card reads its base's *reading* out of it: throwing the stream switch edits
		 * no view and would otherwise leave every count on the screen saying what the
		 * base held a moment ago.
		 */
		const before = this.baseViews.get(file.path);
		const same = before && before.join(' ') === names.join(' ')
			&& this.baseTexts.get(file.path) === text;
		this.baseViews.set(file.path, names);
		this.baseTexts.set(file.path, text);
		return !same;
	}

	/*
	 * Every base, and every view inside one, as something a `views` row can hold.
	 * The text is what gets stored, so it is the full link — extension and
	 * subpath — and the chip shortens it for display rather than the other way
	 * round.
	 */
	viewSuggestions() {
		const out = [];

		const bases = this.app.vault.getFiles()
			.filter((file) => file.extension === 'base')
			.sort((a, b) => a.basename.localeCompare(b.basename));

		for (const file of bases) {
			const link = this.app.metadataCache.fileToLinktext(file, '', false);
			out.push(link);
			for (const name of (this.baseViews.get(file.path) || [])) {
				out.push(link + '#' + name);
			}
		}

		return out;
	}

	/*
	 * The `+` on a `views` row: pick a base, or one of its views.
	 *
	 * Labelled the way Dynamic Viewer's picker labels the same list, `Base  →
	 * view`, because it is the same list and the two should not feel like two
	 * different questions. What is *stored* is the full link, which is what the
	 * label is derived from rather than the other way round.
	 */
	promptForView(taken, onPick) {
		const already = new Set((taken || []).map((value) => String(value).toLowerCase()));

		const items = [];
		for (const value of this.viewSuggestions()) {
			if (already.has(value.toLowerCase())) continue;
			const parts = splitViewLink(value);
			const file = this.resolveBase(parts.target, '');
			const name = file ? file.basename : parts.target;
			items.push({
				value: value,
				label: parts.view ? name + '  →  ' + parts.view : name,
			});
		}

		if (items.length === 0) {
			new Notice(this.baseViews.size === 0
				? 'There are no .base files in this vault yet.'
				: 'Every base and view is already listed here.', 5000);
			return;
		}

		new BaseViewPickerModal(this.app, items, onPick).open();
	}

	/* What a `views` chip says on its face: the view it names, or the base. */
	viewLabel(value) {
		const parts = splitViewLink(value);
		if (parts.view) return parts.view;
		const file = this.resolveBase(parts.target, '');
		return file ? file.basename : parts.target;
	}

	/* And in full, on hover, with whether it actually reaches anything. */
	viewTooltip(value) {
		const parts = splitViewLink(value);
		const file = this.resolveBase(parts.target, '');
		if (!file) return value + ' — no base of that name';

		const known = this.baseViews.get(file.path) || [];
		if (!parts.view) return file.basename + ' — its default view';
		if (known.length > 0 && known.indexOf(parts.view) === -1) {
			return file.basename + ' — it has no view called "' + parts.view + '"';
		}
		return file.basename + ' — the view "' + parts.view + '"';
	}

	/* A `views` entry that reaches a real base, and a real view inside it. */
	viewResolves(value) {
		const parts = splitViewLink(value);
		const file = this.resolveBase(parts.target, '');
		if (!file) return false;
		if (!parts.view) return true;

		const known = this.baseViews.get(file.path) || [];
		/* Unread or unparsable: the base is there, so do not call it missing. */
		return known.length === 0 || known.indexOf(parts.view) !== -1;
	}

	/* A file in the templates folder, which is the only place a block is written. */
	isTemplateFile(file) {
		return file instanceof TFile && file.extension === 'md'
			&& this.inFolder(file, this.settings.templatesFolder);
	}

	/*
	 * Read every template's body and keep the format its rename block carries.
	 * Called at layout and whenever a template is created or renamed; an edit to
	 * an open one arrives through `metadataCache.on('changed')` with the text
	 * already in hand, the same as the defaults tables.
	 */
	async readTemplateRenames() {
		let changed = false;
		const seen = new Set();

		for (const file of this.filesIn(this.settings.templatesFolder)) {
			seen.add(file.path);
			let text = '';
			try { text = await this.app.vault.cachedRead(file); } catch (error) { continue; }
			if (this.rememberRenameBlock(file, text, true)) changed = true;
		}

		for (const path of Array.from(this.templateRenames.keys())) {
			if (!seen.has(path)) { this.templateRenames.delete(path); changed = true; }
		}

		if (changed) {
			this.invalidatePicture();
			this.refreshViews();
		}
		return changed;
	}

	/* One template's block. Returns whether anything moved, same as the tables. */
	rememberRenameBlock(file, text, quiet) {
		if (!this.isTemplateFile(file)) return false;

		const entry = renameEntry(text);
		const before = this.templateRenames.get(file.path);
		/*
		 * The whole of what was read, and not just `has` and the format: two blocks
		 * carry one format between them, so a comparison looking only at the format
		 * cannot tell one from two and the repair would never be planned.
		 */
		if (before && before.signature === entry.signature) return false;

		this.templateRenames.set(file.path, entry);
		if (!quiet) { this.invalidatePicture(); this.refreshViews(); }
		return true;
	}

	renameEntryFor(path) {
		return this.templateRenames.get(path) || null;
	}

	defaultsEntryFor(file) {
		return (file && this.defaultsRows.get(file.path))
			|| { rows: [], hasTable: false, allRows: [], legacy: [] };
	}

	/*
	 * What a characteristic's value should be for an instance of this class, and
	 * how firmly:
	 *
	 *   { value, strict, source }   source names the row that answered
	 *
	 * The walk is `effectiveCharacteristics`'s walk — the class, then its
	 * ancestors nearest first — so a default is inherited exactly the way the
	 * characteristic carrying it is, and a child that declares its own row wins
	 * over its parent's. Two parents at the same distance are met in the order the
	 * class names them, which is the same tie-break every other walk here uses.
	 *
	 * The *All notes* row is last, and there is nothing behind it: `default value:`
	 * in frontmatter used to be, and it said exactly what that row says, so it is
	 * retired rather than kept as a second spelling — see `retire-default-value`.
	 */
	/*
	 * The class, then its ancestors nearest first — memoised for as long as one
	 * `drafts` map lives, which is exactly one plan. `allDrafts` returns a new map
	 * every time, so keying on its identity gives a cache that cannot go stale and
	 * needs nothing to clear it.
	 *
	 * Worth having because the strict pass asks this once per characteristic per
	 * instance: on his vault that is tens of thousands of walks of the same dozen
	 * chains.
	 */
	ancestorChain(name, objects, drafts) {
		if (this.chainsFor !== drafts) {
			this.chains = new Map();
			this.chainsFor = drafts;
		}
		if (!this.chains.has(name)) {
			this.chains.set(name, [name].concat(this.ancestorsOf(name, objects, drafts)));
		}
		return this.chains.get(name);
	}

	defaultFor(characteristic, className, objects, drafts) {
		if (!characteristic) return null;

		const rows = characteristic.defaults || [];
		const answer = (row, source) => {
			const found = { source: source };
			for (const key of DEFAULTS_VALUE_KEYS) found[key] = row[key];
			return found;
		};

		if (className) {
			for (const name of this.ancestorChain(className, objects, drafts)) {
				for (const row of rows) {
					if (row.isAll) continue;
					const target = this.canonicalName(linkName(row.location) || row.location);
					if (target !== name) continue;
					return answer(row, name === className ? name : name + ' (inherited)');
				}
			}
		}

		/*
		 * The weakest row, and the last word. `characteristic.defaultValue` is still
		 * read off the note — it has to be, or a key he writes could never be
		 * noticed and retired — but it is no longer an answer to this question.
		 */
		for (const row of rows) {
			if (row.isAll) return answer(row, ALL_NOTES_ROW);
		}

		return null;
	}

	/*
	 * The same question for a note, which may name several classes. The first
	 * class with something to say answers — the same rule that decides which
	 * characteristics the note carries when its classes disagree.
	 */
	defaultForNote(characteristic, classNames, objects, drafts) {
		for (const className of classNames || []) {
			const found = this.defaultFor(characteristic, className, objects, drafts);
			if (found) return found;
		}
		return this.defaultFor(characteristic, null, objects, drafts);
	}

	/*
	 * What a template is created with, coerced to the property's type.
	 * **Value must be** wins over the starting value: a note created with one and
	 * then immediately replaced by the other would be born out of step. A row
	 * saying both, differing, is reported rather than resolved — see 4b.
	 */
	defaultWriteValue(characteristic, resolved) {
		if (!resolved) return '';
		const text = !isEmptyValue(resolved.must) ? resolved.must : resolved.starting;
		if (isEmptyValue(text)) return '';
		return coerceDefault(text, characteristic && characteristic.propertyType);
	}

	/* One column's value, coerced. */
	columnWriteValue(characteristic, resolved, key) {
		if (!resolved || isEmptyValue(resolved[key])) return '';
		return coerceDefault(resolved[key], characteristic && characteristic.propertyType);
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
				/* `is base characteristic` — what puts it in the base group. */
				isBase: fm['is base characteristic'] === true,
				/*
				 * An explicit constraint, when he has given one. Empty means
				 * "any value of the right shape" rather than "no values".
				 *
				 * Kept **raw** as well, because reducing each entry to a note
				 * name throws away the two things that decide what kind of
				 * constraint it is: whether it was written as a link, and its
				 * brackets. See `constraintsFor`.
				 */
				/*
				 * The **retired** `default value:` key, read only so that a note still
				 * carrying it can be noticed and settled — see `retire-default-value`.
				 * It is not an answer to `defaultFor` any more: what a generated
				 * template writes comes from the table's *All notes* row instead, which
				 * says the same thing and can also say it per class.
				 */
				defaultValue: fm['default value'] === undefined ? '' : fm['default value'],
				/*
				 * The rows of the note's own defaults table, which say the same
				 * thing per class. From the body, so they come from the index
				 * rather than from the metadata cache — see readDefaultsTables.
				 */
				defaults: this.defaultsEntryFor(file).rows,
				hasDefaultsTable: this.defaultsEntryFor(file).hasTable,
				/* Retired rows still on disk, which Update offers to take out. */
				allNotesRows: this.defaultsEntryFor(file).allRows,
				/* Tables still written with the old column names. */
				legacyTables: this.defaultsEntryFor(file).legacy,
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
			/*
			 * A named parent is a class too, even with no note of its own yet —
			 * unless it is plainly a characteristic. `type of: "[[∘ shelf]]"` is a
			 * characteristic in a place only a class belongs, and inventing a class
			 * from it put a `∘ shelf` card in the panel and generated
			 * `∘ shelf Template.md` and `∘ shelf Base.base` beside it. The plan
			 * reports it instead; see `buildPlan`.
			 */
			for (const parent of parents) {
				if (this.looksLikeCharacteristic(parent)) continue;
				record(parent);
			}
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
			object.componentFields = object.values[this.settings.componentsProperty] || [];
			object.parents = object.values[this.settings.inheritsProperty] || [];
			object.keys = new Set(Object.keys(fm));
			object.tagged = this.hasClassTag(file);
			/* One grapheme, so a word pasted into the property cannot reach the UI. */
			object.symbol = this.settings.symbolProperty
				? normaliseSymbol(fm[this.settings.symbolProperty]) : '';
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
			let known = classes.filter((name) => objects.has(name));
			/*
			 * "Everything automatically is a root note" - so a note that names no
			 * class is one of the root's, without saying so anywhere.
			 *
			 * **Only inside the notes folder.** An explicit `is a` is a statement
			 * he made and is honoured wherever he made it; root membership is
			 * implicit, and reaching it across the whole vault swept up `O.md`,
			 * `README.md` and everything else living at the root of it. This is
			 * the third time the same shape of bug has appeared - templates,
			 * then characteristics, now the vault root - so it is fixed here as
			 * one rule rather than as a third exclusion below.
			 */
			if (known.length === 0) {
				if (!this.inFolder(file, this.settings.notesFolder)) continue;
				known = this.rootAbove(file.basename).filter((name) => objects.has(name));
			}
			if (known.length === 0) continue;
			/*
			 * Never anything Obsidian keeps for itself. `getMarkdownFiles()` does
			 * not return these, so this guards a harness rather than the editor -
			 * but a plugin that writes into notes should not depend on that.
			 */
			if (file.path.split('/').some((part) => part.indexOf('.') === 0)) continue;
			/*
			 * The folders that *describe* the system rather than being subjects of
			 * it. A template names its class and is regenerated rather than
			 * patched; a characteristic note defines a property; a note filed with
			 * the bases is about them. One list rather than three lines, because
			 * this has grown by one every time something was swept up.
			 */
			if (this.inSystemFolder(file)) continue;
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

		/*
		 * `'symbol' in edit`, not a truthiness test: clearing one in the panel is an
		 * edit to the empty string, and a falsy check would read that as "not
		 * edited" and hand back the stored symbol for ever.
		 */
		const symbol = edit && 'symbol' in edit
			? normaliseSymbol(edit.symbol) : (object.symbol || '');

		return {
			name: object.name,
			file: object.file,
			values: values,
			symbol: symbol,
			/* Named aliases for the three the engine reasons with. */
			characteristics: values[this.settings.characteristicsProperty] || [],
			componentFields: values[this.settings.componentsProperty] || [],
			parents: values[this.settings.inheritsProperty] || [],
			isNew: !object.file,
		};
	}

	/*
	 * Which rows of this draft the vault has not been told about, and what each
	 * one would become — `[{ property, from, to }]`, empty when the draft says
	 * nothing new.
	 *
	 * The card needs the *list*, not the yes/no `draftDiffers` gives, because the
	 * whole point of marking a card is to say what is pending on it. An empty row
	 * is exactly what a class with nothing declared also looks like, so a card
	 * carrying an unapplied clearing is indistinguishable from an honest one
	 * until something says so out loud. That is how `Sub Goal` sat empty for a
	 * day before an unrelated Update wrote it out.
	 */
	pendingRows(draft, object) {
		const stored = (object && object.values) || this.emptyLogicValues();
		const rows = [];
		for (const property of this.settings.logicProperties) {
			const to = draft.values[property] || [];
			const from = stored[property] || [];
			if (!sameNameList(to, from)) rows.push({ property: property, from: from, to: to });
		}
		return rows;
	}

	/* The card's tooltip: every pending row, as `property: vault → panel`. */
	pendingTooltip(name, rows, symbol) {
		const show = (list) => (list.length > 0 ? list.join(', ') : 'empty');
		const lines = rows.map((row) => row.property + ': '
			+ show(row.from) + '  →  ' + show(row.to));
		if (symbol) lines.push(symbol);
		return 'Edited in the panel, not yet written to ' + name + '’s note:\n'
			+ lines.join('\n')
			+ '\n\nUpdate writes this; Discard throws it away.';
	}

	/* Does this draft say anything the vault does not already say? */
	draftDiffers(draft, object) {
		const stored = (object && object.values) || this.emptyLogicValues();
		for (const property of this.settings.logicProperties) {
			if (!sameNameList(draft.values[property] || [], stored[property] || [])) return true;
		}
		if (this.settings.symbolProperty
			&& (draft.symbol || '') !== ((object && object.symbol) || '')) return true;
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
	/*
	 * What the panel should highlight while this file is open, and **why** — the
	 * relation matters, because the chip on the card says it out loud.
	 *
	 * Five ways a file can be about a class, in the order they are decided:
	 *
	 *   self            it *is* the class note
	 *   template        it is that class's generated `<Class> Template.md`
	 *   base            it is that class's generated `<Class> Base.base`
	 *   characteristic  it is a characteristic note, and these classes declare it
	 *   instance        its `is a` names them
	 *
	 * The three middle ones were his ask, 2026-08-27. The template one very nearly
	 * worked already — a generated template carries `is a: [[Class]]`, so it fell
	 * through to the last branch — but only *nearly*: it is matched by **path**
	 * here instead, so a template whose `is a` he has emptied still belongs to its
	 * class, and it is reported as a template rather than as an instance, which is
	 * the thing it is not.
	 *
	 * A base carries no frontmatter at all, so nothing but the path could have
	 * found it.
	 *
	 * A characteristic highlights the classes that **declare** it, not every class
	 * that ends up carrying it. That is the same distinction the rest of the panel
	 * draws everywhere — the `inherited` row sits apart from `characteristics`, and
	 * `+N` counts only what a class adds — and it is the readable answer: five lit
	 * nodes that introduce `location`, rather than the nineteen that inherit it.
	 */
	activeClassesFor(file, classes, drafts) {
		if (!file) return { kind: null, names: [] };

		/* By path, not identity: the same note can arrive as a different object. */
		const own = classes.get(file.basename);
		if (own && own.file && own.file.path === file.path) {
			return { kind: 'self', names: [file.basename] };
		}

		const all = drafts || this.allDrafts(classes);

		/*
		 * Compared against the path the plugin *would* generate rather than by
		 * stripping the suffix off the name: one comparison, no edge cases, and it
		 * can never claim a note of his that happens to end in " Template".
		 */
		for (const name of all.keys()) {
			if (file.path === this.templatePathFor(name)) {
				return { kind: 'template', names: [name] };
			}
			if (file.path === this.basePathFor(name)) {
				return { kind: 'base', names: [name] };
			}
		}

		const characteristic = this.characteristicNameOf(file);
		if (characteristic) {
			const names = [];
			for (const [name, draft] of all) {
				if ((draft.characteristics || []).indexOf(characteristic) !== -1) names.push(name);
			}
			/*
			 * Nothing declares it — a base characteristic, or one nothing uses yet.
			 * Falling through rather than returning empty, because a characteristic
			 * note is still a note and may carry an `is a` of its own.
			 */
			if (names.length > 0) return { kind: 'characteristic', names: names };
		}

		const frontmatter = this.frontmatterOf(file);
		if (!frontmatter) return { kind: null, names: [] };

		const named = toArray(frontmatter[this.settings.isAProperty])
			.map(linkName).filter(Boolean)
			.map((name) => this.canonicalName(name))
			.filter((name) => classes.has(name));

		return { kind: named.length > 0 ? 'instance' : null, names: named };
	}

	/* The characteristic a file defines, if it is a characteristic note. */
	characteristicNameOf(file) {
		for (const [name, characteristic] of this.scanCharacteristics()) {
			if (characteristic.file && characteristic.file.path === file.path) return name;
		}
		return null;
	}

	classesForFile(file, classes, drafts) {
		return this.activeClassesFor(file, classes, drafts).names;
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

		/*
		 * The root sits above everything, so it sits above everything in the list
		 * too - outside the sort rather than first within it, because it is not
		 * one of the alphabetical run, it is what the run hangs from.
		 */
		const root = String(this.settings.rootClass || '').trim();
		const pinned = names.filter((name) =>
			root && String(name).toLowerCase() === root.toLowerCase());
		const rest = names.filter((name) => pinned.indexOf(name) === -1);

		if (this.settings.sortClasses !== 'descent') {
			return pinned.concat(rest.sort((a, b) => a.localeCompare(b)));
		}
		return pinned.concat(this.byDescent(rest, objects, drafts));
	}

	/* ----- the class tree ---------------------------------------------- */

	/*
	 * The classes laid out as a git graph: one class per row, and rails in lanes
	 * to the left of them. **Only `type of`** — subclassing is the tree; `is a`
	 * is instantiation and would make this a different picture entirely.
	 *
	 * The rule he asked for is that no two nodes share a horizontal position,
	 * which falls out of one class per row. What the lanes then have to do is
	 * carry an edge from a parent's row down to a child's without ever running
	 * through another node, exactly as a commit graph does.
	 *
	 * Returns one row per class:
	 *
	 *   name      the class
	 *   lane      which column its node sits in
	 *   parents   every `type of` parent, by name
	 *   from      the parent whose lane this row descends from, or null
	 *   through   the lanes carrying a rail past this row, this one included
	 *   depth     how far down the spanning tree, for indenting the stub
	 *
	 * Pure, and the whole of the layout: the renderer only draws what this says.
	 */
	/*
	 * `type of` read both ways round, alphabetically so the shape is stable.
	 *
	 * Extracted out of `classTree` 2026-09-05, because the class base's exclusion
	 * lists ask the same question the tree drawing does and must get the same
	 * answer: the classes a stream reaches are the classes drawn *under* the one
	 * the base is about, root edge and all. Two walks over one hierarchy is
	 * exactly the drift `file.isA()` was folded into this plugin to end.
	 */
	classParentage(drafts) {
		const names = Array.from(drafts.keys());
		const known = new Set(names);

		const parentsOf = new Map();
		const childrenOf = new Map();
		const rootName = names.find((name) => this.isRootClass(name)) || null;
		for (const name of names) {
			const draft = drafts.get(name);
			const parents = (draft.parents || [])
				.map((parent) => this.canonicalName(parent))
				.filter((parent) => known.has(parent) && parent !== name);
			/*
			 * The root class is above everything without a link saying so — that is
			 * what makes it the root — so the tree draws that edge even though no
			 * note contains it. Without this his vault came out as six separate
			 * trees six lanes wide, which is true of the links and false about the
			 * hierarchy.
			 */
			if (rootName && name !== rootName && parents.length === 0) {
				parents.push(rootName);
			}
			parentsOf.set(name, Array.from(new Set(parents)));
		}
		for (const name of names.slice().sort((a, b) => a.localeCompare(b))) {
			for (const parent of parentsOf.get(name)) {
				if (!childrenOf.has(parent)) childrenOf.set(parent, []);
				childrenOf.get(parent).push(name);
			}
		}
		return { names: names, parentsOf: parentsOf, childrenOf: childrenOf, rootName: rootName };
	}

	/*
	 * The classes a stream aimed at `name` can be asked to drop: everything below
	 * it, depth-first, each with how far down it sits so the menu can indent it.
	 *
	 * The class itself is **not** in the list. Excluding it would empty the stream
	 * outright, which is what turning the stream off already says - and a control
	 * that duplicates the one above it is a second way to reach a state, not a
	 * second state.
	 */
	excludableClasses(name, drafts) {
		const parentage = this.classParentage(drafts);
		const rows = [];
		const seen = new Set([name]);

		const walk = (parent, depth) => {
			for (const child of parentage.childrenOf.get(parent) || []) {
				if (seen.has(child)) continue;
				seen.add(child);
				rows.push({ name: child, depth: depth, parents: parentage.parentsOf.get(child) || [] });
				walk(child, depth + 1);
			}
		};
		walk(name, 0);
		return rows;
	}

	classTree(objects, drafts) {
		const parentage = this.classParentage(drafts);
		const names = parentage.names;
		const parentsOf = parentage.parentsOf;
		const childrenOf = parentage.childrenOf;

		/*
		 * Where the tree hangs from: classes with no parent. The root class first
		 * when there is one, for the same reason it leads everywhere else — it is
		 * what the rest hangs from rather than one of them.
		 */
		const root = String(this.settings.rootClass || '').trim().toLowerCase();
		const roots = names
			.filter((name) => parentsOf.get(name).length === 0)
			.sort((a, b) => {
				if (a.toLowerCase() === root) return -1;
				if (b.toLowerCase() === root) return 1;
				return a.localeCompare(b);
			});

		/*
		 * The order. Two things have to hold at once, and a plain depth-first walk
		 * gives only the second:
		 *
		 *   1. every parent is drawn **above** every child. With one parent that is
		 *      free; with two it is not, and my first attempt drew `Android` two
		 *      rows under `Person` while `Project`, its other parent, was six rows
		 *      further down — an edge running upward, which is not a graph anyone
		 *      can read.
		 *   2. a line of descent stays contiguous, so a chain reads as a trunk
		 *      rather than as scattered rows.
		 *
		 * So: a class is ready only once **all** its parents are drawn, and the
		 * ready ones are taken most-recent-first. That is a topological order with
		 * a stack instead of a queue, which is exactly depth-first wherever
		 * depth-first is legal and gives way where it is not.
		 */
		const owner = new Map();
		const remaining = new Map();
		for (const name of names) remaining.set(name, parentsOf.get(name).length);

		const rows = [];
		const busy = [];
		/*
		 * Reserved is not the same as running. A root's lane is claimed before any
		 * row is drawn, so treating "busy" as "has a rail" drew every root's lane
		 * from the top of the panel down to it, out of nothing. A lane starts when
		 * something actually branches into it, or at the root's own row.
		 */
		const started = [];
		const laneOf = new Map();
		const laneFor = new Map();
		const depthOf = new Map();

		const takeLane = () => {
			const free = busy.indexOf(false);
			if (free !== -1) { busy[free] = true; return free; }
			busy.push(true);
			started.push(false);
			return busy.length - 1;
		};

		const ready = [];
		for (const name of roots) {
			laneFor.set(name, takeLane());
			depthOf.set(name, 0);
			ready.push(name);
		}

		let guard = names.length + 1;
		while (ready.length > 0 && guard > 0) {
			guard -= 1;
			const name = ready.shift();
			const lane = laneFor.get(name);
			laneOf.set(name, lane);

			const row = {
				name: name,
				lane: lane,
				parents: parentsOf.get(name) || [],
				from: owner.has(name) ? owner.get(name) : null,
				depth: depthOf.get(name) || 0,
				/* Snapshotted before this row's children reserve theirs. */
				through: busy.map((used, index) => (used && started[index] ? index : -1))
					.filter((index) => index !== -1),
				/* Lanes that begin at this row, filled in once the children are known. */
				branches: [],
			};
			rows.push(row);

			/*
			 * Which children this row completes. A child with two parents becomes
			 * ready under the **second** of them, so it is drawn below both — and
			 * that parent is the one whose lane it descends from, which is why
			 * `from` is set here rather than worked out in advance.
			 */
			const freed = [];
			for (const child of childrenOf.get(name) || []) {
				if (remaining.get(child) === undefined) continue;
				remaining.set(child, remaining.get(child) - 1);
				if (remaining.get(child) !== 0) continue;
				remaining.delete(child);
				owner.set(child, name);
				depthOf.set(child, (depthOf.get(name) || 0) + 1);
				freed.push(child);
			}

			row.endsHere = freed.length === 0;
			if (freed.length === 0) {
				busy[lane] = false;
				started[lane] = false;
			} else {
				/* It carries on below this row, whether it arrived or begins here. */
				started[lane] = true;
				/* The first keeps this lane, so a straight descent stays straight. */
				freed.forEach((child, index) => {
					const childLane = index === 0 ? lane : takeLane();
					laneFor.set(child, childLane);
					/*
					 * A lane that *starts* here. It has to be drawn from this row's
					 * node downwards, not from the child's row — otherwise the line
					 * begins one row late and never reaches the dot it comes from,
					 * which is exactly the gap he was looking at.
					 */
					if (childLane === lane) return;
					started[childLane] = true;
					row.branches.push({ lane: childLane, name: child });
				});
			}

			/* Most recent first: depth-first wherever the order allows it. */
			ready.unshift.apply(ready, freed);
		}

		/*
		 * Anything a cycle kept out of the walk. It is still a class and still has
		 * to be shown, so it hangs from nothing, at the end.
		 */
		const stranded = names.filter((name) => !laneOf.has(name))
			.sort((a, b) => a.localeCompare(b));
		for (const name of stranded) {
			const lane = takeLane();
			laneOf.set(name, lane);
			rows.push({
				name: name,
				lane: lane,
				parents: parentsOf.get(name) || [],
				from: null,
				depth: 0,
				endsHere: true,
				through: busy.map((used, index) => (used && started[index] ? index : -1))
					.filter((index) => index !== -1),
				branches: [],
			});
			busy[lane] = false;
			started[lane] = false;
		}

		/*
		 * Every lane a row touches, and how much of the row it covers. Working
		 * this out here rather than in the renderer is what makes the geometry
		 * testable — and the geometry is where it was wrong.
		 *
		 *   'full'    top to bottom: a rail passing this row by
		 *   'top'     top down to the node: a lane arriving and ending here
		 *   'bottom'  node down to the bottom: a lane starting here
		 *
		 * `through` is the snapshot taken before this row's children reserved
		 * anything, so it holds the lanes that were already running — including
		 * this row's own, which arrived from above.
		 */
		for (let i = 0; i < rows.length; i += 1) {
			const row = rows[i];
			const branchLanes = new Set(row.branches.map((branch) => branch.lane));
			const segments = [];

			for (const lane of row.through) {
				/* Somebody else's rail. It passes straight through. */
				if (lane !== row.lane) segments.push({ lane: lane, kind: 'full' });
			}

			/*
			 * This row's own lane, in two halves: does it arrive from above, and
			 * does it carry on below?
			 *
			 * Arriving is decided by having a parent, **not** by whether the lane
			 * was already busy. A root reserves its lane before any row is drawn,
			 * so `through` says it was running — and reading that literally drew a
			 * rail descending into the topmost class out of nothing above it.
			 */
			const arrives = row.from !== null && row.from !== undefined;
			const leaves = !row.endsHere;
			if (arrives && leaves) segments.push({ lane: row.lane, kind: 'full' });
			else if (arrives) segments.push({ lane: row.lane, kind: 'top' });
			else if (leaves) segments.push({ lane: row.lane, kind: 'bottom' });

			for (const lane of branchLanes) segments.push({ lane: lane, kind: 'bottom' });

			row.segments = segments.filter((segment) => segment.kind !== 'none');
		}

		/* Now every lane is known, so the crossing edges can name theirs. */
		for (const row of rows) {
			row.parentLanes = row.parents
				.filter((parent) => parent !== row.from && laneOf.has(parent))
				.map((parent) => ({ name: parent, lane: laneOf.get(parent) }));
			row.fromLane = row.from === null || !laneOf.has(row.from)
				? null : laneOf.get(row.from);
		}

		/*
		 * The other parents, as wires of their own.
		 *
		 * A class that is a `type of` two classes has two edges, and only one of
		 * them can be the descent the lanes are built around — so the rest used to
		 * be drawn as a dashed stub at the child's row, reaching across to wherever
		 * the parent's lane happened to be. That stub did not reach the parent's
		 * *node*: a lane is released and handed out again the moment its class runs
		 * out of descendants, so by the child's row the column it pointed at was
		 * often somebody else's.
		 *
		 * Now each one is routed like a bracket — out of the parent's node, down a
		 * lane, back in at the child — and those lanes are a **band of their own,
		 * outside the class lanes**. Kept apart deliberately: threading them into
		 * the walk above would have them reserving and releasing lanes in the
		 * middle of the bookkeeping that decides where the *nodes* go, and the
		 * nodes are the thing that must not move.
		 */
		const rowAt = new Map(rows.map((row, index) => [row.name, index]));
		const merges = [];
		rows.forEach((row, index) => {
			for (const other of row.parentLanes) {
				const parent = rowAt.get(other.name);
				if (parent === undefined || parent >= index) continue;
				merges.push({ from: parent, to: index, parent: other.name, name: row.name });
			}
		});
		const mergeLanes = this.assignLanes(merges);

		return {
			rows: rows,
			lanes: Math.max(1, busy.length),
			merges: merges,
			mergeLanes: mergeLanes,
		};
	}

	/*
	 * A lane per span, reused wherever two do not overlap — the one piece of
	 * arithmetic every drawing here needs, so it lives in one place. The spans are
	 * single edges in the lane graph and in the plain bracket drawing, and whole
	 * bundles of them in the compressed one; nothing below cares which.
	 *
	 * **Shortest first**, which is what nests them. Assigning in row order gave
	 * the enclosing span the inner lane and the span inside it the outer one, so
	 * the two crossed instead of sitting inside each other. Taking the shortest
	 * first puts every edge inside the ones that contain it, and the longest reach
	 * ends up furthest out.
	 *
	 * Overlap is tested against the spans a lane actually holds rather than
	 * against how far the last one reached, so a short early edge can share a lane
	 * with a long later one.
	 *
	 * Free means strictly *past*, not merely landed: an edge arriving at row n and
	 * another leaving from row n do not overlap — one stops at the node, the other
	 * starts there — but sharing a lane would draw them as one unbroken line
	 * through that node, reading as a single edge spanning both. A lane is cheaper
	 * than that misreading, and this is the rule that answers "how many extra
	 * lanes": exactly as many as there are wires that have to overtake each other.
	 */
	assignLanes(edges) {
		const order = edges.slice().sort((a, b) =>
			((a.to - a.from) - (b.to - b.from)) || (a.from - b.from));

		const laneSpans = [];
		const clear = (spans, edge) => spans.every(
			(other) => edge.to < other.from || other.to < edge.from);

		for (const edge of order) {
			let lane = laneSpans.findIndex((spans) => clear(spans, edge));
			if (lane === -1) { lane = laneSpans.length; laneSpans.push([]); }
			laneSpans[lane].push(edge);
			edge.lane = lane;
		}

		/* Left in reading order, whatever order the lanes were handed out in. */
		edges.sort((a, b) => (a.from - b.from) || (a.to - b.to));
		return laneSpans.length;
	}

	/*
	 * The same tree, drawn the way he sketched it: **every node in one column**
	 * beside the cards, and the connexions routed out to the left only where they
	 * have to be.
	 *
	 * The difference from the lane graph is not the shape — it is the same
	 * ordering and the same parentage — it is what the horizontal space is spent
	 * on. There, a lane belongs to a *class* and holds it for as long as it has
	 * descendants; here a lane belongs to an *edge* and is released the moment it
	 * arrives. So the nodes line up with the cards, and the width is the number of
	 * connexions that have to overtake each other rather than the depth of the
	 * hierarchy.
	 *
	 *   straight   the child is the row directly below: a plain vertical
	 *   bracket    anything else: out, down its lane, and back in
	 *
	 * `compressed` bundles the wires that leave the same node into one trunk —
	 * see below, at the bundling itself.
	 *
	 * Returns `{ rows, brackets, bundles, lanes }`, where each row gains
	 * `straightFrom` (drawn from the row above) and `straightTo` (carries on to
	 * the row below). `brackets` is every wire, `bundles` is how they are drawn.
	 */
	classBrackets(objects, drafts, compressed) {
		const tree = this.classTree(objects, drafts);
		const rows = tree.rows.map((row) => Object.assign({}, row));
		const at = new Map(rows.map((row, index) => [row.name, index]));

		const edges = [];
		rows.forEach((row, index) => {
			row.straightFrom = false;
			row.straightTo = false;
			if (row.from === null || row.from === undefined) return;
			const parent = at.get(row.from);
			if (parent === undefined) return;
			/* Directly below its parent: no detour needed, and none drawn. */
			if (parent === index - 1) {
				row.straightFrom = true;
				rows[parent].straightTo = true;
				return;
			}
			edges.push({ from: parent, to: index, parent: row.from, name: row.name });
		});

		/*
		 * The other parents. A class that is a `type of` two classes has an edge to
		 * each, and this drawing used to show only the one the rows are ordered by
		 * — the second parentage was simply absent, which is the one thing a
		 * hierarchy view must not do.
		 *
		 * They are ordinary brackets in every way but two. They are never the
		 * straight, because the row above belongs to the descent and not to them;
		 * and they are marked `merge`, which is what decides who goes under at a
		 * crossing.
		 */
		rows.forEach((row, index) => {
			for (const other of row.parentLanes || []) {
				const parent = at.get(other.name);
				if (parent === undefined || parent >= index) continue;
				edges.push({ from: parent, to: index, parent: other.name,
					name: row.name, merge: true });
			}
		});

		/*
		 * The wires bundled by where they leave — his `Compressed wires.md`.
		 *
		 * Uncompressed, a lane belongs to one wire, so a class with ten children
		 * spends ten lanes on ten lines that leave the same node and run down
		 * beside each other. Past forty classes that band is wider than the cards
		 * next to it, and nearly all of its width is copies.
		 *
		 * Compressed, the wires out of **one node** are drawn as one trunk with a
		 * branch turning in at each child. No precision is lost by it: they leave
		 * the same node, so they were already lying on top of one another at the
		 * only point where they could have been told apart — the compression stops
		 * paying for a distinction the drawing never made.
		 *
		 * Two things are never bundled, because overlapping them *would* lose
		 * something. Wires from **different** nodes: where a wire comes from is the
		 * whole of what it says, and two origins on one line say neither. And a
		 * second-parent wire is kept apart from a descent even out of the same node
		 * — the two are drawn differently, dashed and solid, and one line cannot be
		 * both.
		 */
		const bundles = [];
		const byOrigin = new Map();
		for (const edge of edges) {
			const key = compressed
				? edge.from + (edge.merge ? ':wire' : ':descent') : null;
			let bundle = key === null ? null : byOrigin.get(key);
			if (!bundle) {
				bundle = {
					from: edge.from, to: edge.to, parent: edge.parent,
					merge: !!edge.merge, edges: [],
				};
				bundles.push(bundle);
				if (key !== null) byOrigin.set(key, bundle);
			}
			bundle.edges.push(edge);
			/* The trunk runs as far as the furthest child hanging off it. */
			bundle.to = Math.max(bundle.to, edge.to);
		}

		/*
		 * A lane per bundle, reused where two do not overlap. Shared with the lane
		 * graph, which allots its second-parent wires the same way.
		 *
		 * Handed to the **bundles** and not to the wires, which is the whole reason
		 * the bundling happens before the allotment rather than after it: a lane
		 * has to be reserved for a trunk's entire reach, or a short first branch
		 * would claim an inner lane and the rest of the trunk would then grow out
		 * through whatever had nested itself inside it.
		 */
		const lanes = this.assignLanes(bundles);
		for (const bundle of bundles) {
			for (const edge of bundle.edges) edge.lane = bundle.lane;
		}

		return { rows: rows, brackets: edges, bundles: bundles, lanes: lanes };
	}

	/*
	 * What to light in that drawing: the brackets and straight runs on the line of
	 * descent from the classes the open note belongs to.
	 */
	litBrackets(layout, active) {
		const at = new Map(layout.rows.map((row, index) => [row.name, index]));
		const dots = new Map();
		const straight = new Set();
		const brackets = new Set();
		/*
		 * The descent only. A class with two parents has two brackets ending on
		 * its row, and a merge wire is not the edge it descends from — letting one
		 * into this map would light whichever of the two happened to be last.
		 */
		const byChild = new Map(layout.brackets
			.filter((edge) => !edge.merge)
			.map((edge) => [edge.to, edge]));

		/*
		 * The wires arriving at each row. Kept as a list per child rather than
		 * under a `child + parent` key, so nothing depends on finding a separator
		 * no class name can contain.
		 */
		const wiresTo = new Map();
		for (const edge of layout.brackets) {
			if (!edge.merge) continue;
			if (!wiresTo.has(edge.to)) wiresTo.set(edge.to, []);
			wiresTo.get(edge.to).push(edge);
		}

		const every = this.everyWireLit();
		const starts = new Set();
		const seen = new Set();
		const queue = [];
		for (const name of toArray(active && active.size !== undefined
			? Array.from(active) : active)) {
			const index = at.get(name);
			if (index === undefined) continue;
			dots.set(name, 'active');
			starts.add(index);
			seen.add(index);
			queue.push(index);
		}

		/* Squared, because with every parent followed this is a graph walk and
		 * not a climb: a row can be reached from several descendants. */
		let guard = layout.rows.length * (layout.rows.length + 1);
		while (queue.length > 0 && guard > 0) {
			guard -= 1;
			const cursor = queue.shift();
			const row = layout.rows[cursor];

			const climb = (parentName) => {
				const parent = at.get(parentName);
				if (parent === undefined) return;
				if (!dots.has(parentName)) dots.set(parentName, 'ancestor');
				if (seen.has(parent)) return;
				seen.add(parent);
				queue.push(parent);
			};

			if (row.from !== undefined && row.from !== null && at.has(row.from)) {
				if (row.straightFrom) straight.add(cursor);
				else if (byChild.has(cursor)) brackets.add(byChild.get(cursor).lane
					+ ':' + cursor);
				climb(row.from);
			}

			/*
			 * The other parents. Their wires light for the class you are actually
			 * on either way — an edge arriving at the highlighted node is part of
			 * what the highlight is saying — and the walk carries on through them
			 * only when every wire is being followed.
			 */
			if (!every && !starts.has(cursor)) continue;
			for (const wire of wiresTo.get(cursor) || []) {
				brackets.add(wire.lane + ':' + wire.to);
				if (every) climb(wire.parent);
			}
		}

		return { dots: dots, straight: straight, brackets: brackets };
	}

	/*
	 * Whether the highlight follows every parent or only the one the rows are
	 * ordered by. Asked here rather than passed in, so the panel and the hover
	 * paint cannot disagree about it.
	 */
	everyWireLit() {
		return this.settings.treeLitPaths !== 'descent';
	}

	/*
	 * What to light for the classes the open note belongs to: the whole line of
	 * descent up to the root, and every node along it.
	 *
	 * A plugin method rather than part of the renderer because it is the second
	 * thing here to have been wrong twice — first drawn not at all, then only one
	 * hop up — and neither was visible to any assertion while it lived inside a
	 * view.
	 *
	 * Returns `{ lanes, dots }`: lanes is row index -> the lanes lit on that row,
	 * dots is class name -> 'active' when the note belongs to it, 'ancestor' when
	 * it merely descends from it.
	 */
	litPath(tree, active) {
		const at = new Map(tree.rows.map((row, index) => [row.name, index]));
		const lanes = new Map();
		const dots = new Map();

		const light = (index, lane) => {
			if (!lanes.has(index)) lanes.set(index, new Set());
			lanes.get(index).add(lane);
		};

		/* The second-parent wires arriving at each row. */
		const wiresTo = new Map();
		for (const wire of tree.merges || []) {
			if (!wiresTo.has(wire.to)) wiresTo.set(wire.to, []);
			wiresTo.get(wire.to).push(wire);
		}
		const wires = new Set();

		const every = this.everyWireLit();
		const starts = new Set();
		const seen = new Set();
		const queue = [];
		for (const name of toArray(active && active.size !== undefined
			? Array.from(active) : active)) {
			const index = at.get(name);
			if (index === undefined) continue;
			dots.set(name, 'active');
			light(index, tree.rows[index].lane);
			starts.add(index);
			seen.add(index);
			queue.push(index);
		}

		/*
		 * A walk rather than a climb, now that a row can have two parents: taken
		 * breadth-first, each row entered once, so a diamond in the hierarchy is
		 * lit once and cannot loop. Squared guard for the same reason — a row is
		 * reachable from several descendants.
		 */
		let guard = tree.rows.length * (tree.rows.length + 1);
		while (queue.length > 0 && guard > 0) {
			guard -= 1;
			const cursor = queue.shift();
			const row = tree.rows[cursor];

			const climb = (parentName) => {
				const parent = at.get(parentName);
				if (parent === undefined) return;
				if (!dots.has(parentName)) dots.set(parentName, 'ancestor');
				if (seen.has(parent)) return;
				seen.add(parent);
				queue.push(parent);
			};

			if (row.from !== undefined && row.from !== null && at.has(row.from)) {
				/*
				 * Every row this rail crosses on its way down, the branch included —
				 * and **only** that rail.
				 *
				 * Lighting the parent's own lane as well was wrong and looked it: at
				 * the parent's row that lane runs on down to the parent's *first
				 * child*, which is a different branch. It drew a bright stub setting
				 * off towards a class that has nothing to do with the path.
				 *
				 * Where the child did inherit the parent's lane, `row.lane` is that
				 * lane already, so the straight descent is covered either way. The
				 * join to the parent's node is the branch elbow, which is lit
				 * because its lane is.
				 */
				for (let i = at.get(row.from); i <= cursor; i += 1) light(i, row.lane);
				climb(row.from);
			}

			/*
			 * The other parents. Their wires light for the class you are actually
			 * on either way — an edge arriving at the highlighted node is part of
			 * what the highlight is saying — and the walk carries on through them
			 * only when every wire is being followed.
			 */
			if (!every && !starts.has(cursor)) continue;
			for (const wire of wiresTo.get(cursor) || []) {
				wires.add(wire.from + ':' + wire.to);
				if (every) climb(wire.parent);
			}
		}

		return { lanes: lanes, dots: dots, wires: wires };
	}

	byDescent(names, objects, drafts) {

		const depth = new Map();
		for (const name of names) depth.set(name, this.classDepth(name, objects, drafts));

		return names.slice().sort((a, b) => {
			const byDepth = depth.get(a) - depth.get(b);
			return byDepth !== 0 ? byDepth : a.localeCompare(b);
		});
	}

	/* Is this the root class? Asked by the panel, which marks it. */
	isRootClass(name) {
		const root = String(this.settings.rootClass || '').trim();
		return !!root && String(name).toLowerCase() === root.toLowerCase();
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

		/*
		 * `type of` always. `is a` as well when *Instances inherit what their class
		 * carries* is on - which makes the two relations both hand characteristics
		 * downwards, differing then only in what they mean rather than in what they
		 * do. The `seen` set is what keeps that safe: following two relations at
		 * once makes cycles far easier to write by accident.
		 */
		const edgesOf = (draft) => {
			if (!draft) return [];
			const parents = (draft.parents || []).slice();
			if (!this.settings.inheritCarried) return parents;
			return parents.concat(draft.values
				? (draft.values[this.settings.isAProperty] || [])
				: []);
		};

		let frontier = edgesOf(drafts.get(name)).concat(this.rootAbove(name));
		let depth = 0;

		while (frontier.length > 0 && depth < MAX_DEPTH) {
			const next = [];
			for (const parent of frontier) {
				if (seen.has(parent)) continue;
				seen.add(parent);
				chain.push(parent);
				next.push.apply(next,
					edgesOf(drafts.get(parent)).concat(this.rootAbove(parent)));
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

	/*
	 * The component fields an instance of this class carries: its own, and every
	 * ancestor's, nearest first, de-duplicated.
	 *
	 * Deliberately the same walk as `effectiveCharacteristics`, over the other
	 * list. His note says component fields are *"inherited much like
	 * characteristics and views"*, and the cheapest way to keep that promise is
	 * not to have a second idea of what inheritance is — `ancestorsOf` answers for
	 * both, so a class cannot inherit its parent's characteristics and miss its
	 * parent's component fields.
	 */
	effectiveComponentFields(name, objects, drafts) {
		const out = [];
		const seen = new Set();

		const add = (list) => {
			for (const field of list || []) {
				if (!field || seen.has(field)) continue;
				seen.add(field);
				out.push(field);
			}
		};

		const self = drafts.get(name);
		if (self) add(self.componentFields);

		for (const ancestor of this.ancestorsOf(name, objects, drafts)) {
			const draft = drafts.get(ancestor);
			if (draft) add(draft.componentFields);
		}

		return out;
	}

	/*
	 * Every property key a note should carry because of the classes it names, and
	 * where each one came from.
	 *
	 *   { keys, fields, targets, owner }
	 *
	 * Three things arrive together, and they have to, because the third is a
	 * consequence of the second:
	 *
	 *   1. the characteristics those classes declare  (effectiveCharacteristics)
	 *   2. the component *fields* they declare        (effectiveComponentFields)
	 *   3. for every component field this note has actually **filled** with a
	 *      class, everything that class brings — its characteristics, and its own
	 *      component fields, which this note may then fill in turn
	 *
	 * That third step is the whole feature: *"when the user inputs a class … then
	 * the current class will take all of the characteristics of the component
	 * class."* It reads the note's own frontmatter, so unlike (1) and (2) it is a
	 * fact about this note rather than about its class — which is why a template
	 * gets the empty fields and only a filled-in note gets what they lead to.
	 *
	 * It is a **fixed point, not one pass**. A component class may declare
	 * component fields of its own, and those become fields on this note, and this
	 * note may already have filled one. Depth-capped and guarded by `seen`, the
	 * way every other walk here is: a cycle through component fields is far easier
	 * to write by accident than a cycle through `type of`.
	 *
	 * `frontmatter` may be null — a class that exists only as a draft, a template
	 * that has not been written yet — and then steps (1) and (2) still answer.
	 */
	carriedKeys(classNames, frontmatter, objects, drafts) {
		const keys = [];
		const seenKey = new Set();
		const owner = new Map();
		const fields = [];
		const seenField = new Set();
		const targets = [];
		const seenTarget = new Set();

		const add = (key, from) => {
			if (!key) return;
			if (!owner.has(key) && from) owner.set(key, from);
			if (seenKey.has(key)) return;
			seenKey.add(key);
			keys.push(key);
		};

		let frontier = [];
		const addField = (field, from) => {
			if (!field || seenField.has(field)) return;
			seenField.add(field);
			fields.push(field);
			add(field, from);
			frontier.push(field);
		};

		for (const className of toArray(classNames)) {
			if (!drafts.has(className)) continue;
			for (const characteristic of this.effectiveCharacteristics(className, objects, drafts)) {
				add(characteristic, className);
			}
			for (const field of this.effectiveComponentFields(className, objects, drafts)) {
				addField(field, className);
			}
		}

		let depth = 0;
		while (frontier.length > 0 && depth < MAX_DEPTH) {
			const wave = frontier;
			frontier = [];
			if (!frontmatter) break;

			for (const field of wave) {
				for (const className of this.componentTargets(frontmatter, field)) {
					if (!drafts.has(className) || seenTarget.has(className)) continue;
					seenTarget.add(className);
					targets.push({ field: field, name: className });

					for (const characteristic of
						this.effectiveCharacteristics(className, objects, drafts)) {
						add(characteristic, className);
					}
					for (const nested of
						this.effectiveComponentFields(className, objects, drafts)) {
						addField(nested, className);
					}
				}
			}
			depth++;
		}

		return { keys: keys, fields: fields, targets: targets, owner: owner };
	}

	/*
	 * The classes one component field on one note names. A bare name and a
	 * `[[link]]` both count, and both are canonicalised, so `[[goal]]` and
	 * `[[Goal]]` are one class — the same rule `is a` follows.
	 */
	componentTargets(frontmatter, field) {
		if (!frontmatter || !field) return [];
		return toArray(frontmatter[field])
			.map((entry) => linkName(entry))
			.filter(Boolean)
			.map((name) => this.canonicalName(name));
	}

	/*
	 * Every property that some class in the vault declares as a component field.
	 *
	 * `file.hasA()` needs to know which of a note's keys are component fields
	 * without first working out which classes the note belongs to, and this is the
	 * honest answer to that: a component field is a property some class declared
	 * as one. Cached with the closures, so any edit to the hierarchy drops it.
	 */
	componentProperties() {
		if (this.componentFieldCache) return this.componentFieldCache;

		const found = new Set();
		const property = String(this.settings.componentsProperty || '').trim();
		if (property) {
			for (const file of this.filesIn(this.settings.notesFolder)) {
				const frontmatter = this.frontmatterOf(file);
				if (!frontmatter || !(property in frontmatter)) continue;
				for (const entry of toArray(frontmatter[property])) {
					const name = stripPrefix(linkName(entry), this.settings.characteristicPrefix);
					if (name) found.add(name);
				}
			}
		}

		this.componentFieldCache = found;
		return found;
	}

	/*
	 * How much a class actually adds.
	 *
	 *   { added, redeclared, carried, own }
	 *
	 * **New means new to the chain, not new to the note.** A class's
	 * `characteristics:` may name something an ancestor already declares —
	 * `Visual Artist` listing `children` when `Person` above it already does — and
	 * that adds nothing to an instance. Counting the list as written would rate
	 * such a class for work it did not do, which is the opposite of the question:
	 * *how much new metadata does this class add*.
	 *
	 * Base characteristics are left out. `is a`, `characteristics` and `type of`
	 * are how the system talks about itself; every class has them, so they say
	 * nothing about any one class.
	 *
	 * Drafts, not files, so an edit in the panel moves the number before Update
	 * writes anything.
	 */
	noveltyOf(name, objects, drafts) {
		const draft = drafts.get(name);
		const empty = { added: [], redeclared: [], carried: 0, own: 0 };
		if (!draft) return empty;

		const base = new Set(this.settings.logicProperties);

		const own = [];
		const seen = new Set();
		/*
		 * Component fields count. The question is *how much new metadata does this
		 * class add*, and a component field is a property every instance carries —
		 * one it did not have before this class declared it. Leaving them out would
		 * rate his `Goal` at +0 for the three fields that are the entire class.
		 */
		for (const characteristic of (draft.characteristics || [])
			.concat(draft.componentFields || [])) {
			if (!characteristic || base.has(characteristic)) continue;
			if (seen.has(characteristic)) continue;
			seen.add(characteristic);
			own.push(characteristic);
		}

		const above = new Set();
		for (const ancestor of this.ancestorsOf(name, objects, drafts)) {
			const parent = drafts.get(ancestor);
			if (!parent) continue;
			for (const characteristic of parent.characteristics || []) above.add(characteristic);
			for (const field of parent.componentFields || []) above.add(field);
		}

		const carried = this.carriedKeys([name], null, objects, drafts).keys
			.filter((characteristic) => !base.has(characteristic));

		return {
			added: own.filter((characteristic) => !above.has(characteristic)),
			redeclared: own.filter((characteristic) => above.has(characteristic)),
			carried: carried.length,
			own: own.length,
		};
	}

	/*
	 * A class's symbol, and where it came from.
	 *
	 *   { symbol, source, inherited }
	 *
	 * **Inherited, nearest first**, the same walk as characteristics and defaults:
	 * marking `Person` marks everything below it, and a subclass overrides by
	 * setting its own. That is what makes one symbol worth typing — otherwise
	 * every class in a chain would need its own.
	 *
	 * Empty when nothing in the chain has one, which is the ordinary case and not
	 * something to draw a placeholder for.
	 */
	symbolFor(name, objects, drafts) {
		if (!this.settings.symbolProperty) return { symbol: '', source: '', inherited: false };

		for (const above of this.ancestorChain(name, objects, drafts)) {
			const draft = drafts.get(above);
			if (!draft || !draft.symbol) continue;
			/*
			 * A class carrying a copy the plugin wrote is still *inheriting* it, and
			 * says so — otherwise materialising would make every class in a marked
			 * subtree look as though it had chosen the mark for itself, and the one
			 * class that actually did would be indistinguishable from the rest.
			 */
			if (above === name && this.copiedSymbol(name) === draft.symbol) {
				const from = this.inheritedSymbolFor(name, objects, drafts);
				if (from.symbol === draft.symbol) {
					return { symbol: draft.symbol, source: from.source, inherited: true };
				}
			}
			return {
				symbol: draft.symbol,
				source: above,
				inherited: above !== name,
			};
		}
		return { symbol: '', source: '', inherited: false };
	}

	/*
	 * The nearest symbol **above** a class, ignoring its own. What a class would
	 * show if it declared nothing — and so what a materialised copy should hold.
	 */
	inheritedSymbolFor(name, objects, drafts) {
		if (!this.settings.symbolProperty) return { symbol: '', source: '', inherited: false };

		for (const above of this.ancestorChain(name, objects, drafts)) {
			if (above === name) continue;
			const draft = drafts.get(above);
			if (!draft || !draft.symbol) continue;
			return { symbol: draft.symbol, source: above, inherited: true };
		}
		return { symbol: '', source: '', inherited: false };
	}

	/* The symbol this plugin last wrote onto a class as a copy, if any. */
	copiedSymbol(name) {
		return (this.symbolWrites && this.symbolWrites.get(name)) || '';
	}

	/*
	 * What a class's symbol property should hold once inherited symbols are
	 * written down, and why — `{ value, reason }`, or null when nothing is due.
	 *
	 * Four cases, and the record is what tells them apart:
	 *
	 *   none of its own, one above      write the copy
	 *   a copy, and the ancestor moved  update the copy
	 *   a copy, and the ancestor's gone remove the copy
	 *   anything else                   his; left alone
	 */
	symbolCopyFor(name, own, objects, drafts) {
		if (!this.settings.symbolProperty) return null;
		if (!this.settings.writeInheritedSymbols) return null;

		const above = this.inheritedSymbolFor(name, objects, drafts).symbol;
		const copied = this.copiedSymbol(name);

		if (!own) {
			return above ? { value: above, reason: 'write' } : null;
		}
		if (own !== copied) return null;
		if (!above) return { value: '', reason: 'remove' };
		if (above !== own) return { value: above, reason: 'update' };
		return null;
	}

	/* The same, drawn: one grapheme with the presentation the setting asks for. */
	symbolText(name, objects, drafts) {
		return this.symbolFor(name, objects, drafts).symbol;
	}

	/* What the badge on a class's row says, in words. */
	noveltyTooltip(name, novelty) {
		const lines = [];
		const added = novelty.added.length;

		if (added === 0) {
			lines.push(name + ' adds no metadata of its own.');
			lines.push(novelty.carried > 0
				? 'An instance of it carries ' + novelty.carried
					+ ', every one of them inherited.'
				: 'An instance of it carries none at all.');
		} else {
			lines.push(name + ' adds ' + added + ' characteristic'
				+ (added === 1 ? '' : 's') + ' that nothing above it declares: '
				+ novelty.added.join(', ') + '.');
			lines.push('An instance carries ' + novelty.carried + ' in all.');
		}

		if (novelty.redeclared.length > 0) {
			lines.push('It also lists ' + novelty.redeclared.join(', ')
				+ ', already declared further up — so ' + (novelty.redeclared.length === 1
					? 'that one adds' : 'those add') + ' nothing.');
		}

		return lines.join('\n');
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
			|| !obsidian.FileValue || !obsidian.BooleanValue || !obsidian.ListValue
			|| !obsidian.LinkValue;

		if (missing) {
			new Notice('OOF Class Manager: this Obsidian version does not expose the Bases function '
				+ 'registry, so file.isA() is unavailable.', 8000);
			console.error('oof-classes: registerInstanceFunc or a Value class is missing.');
			return false;
		}

		const self = { name: 'self', type: [obsidian.FileValue] };
		/*
		 * A class can be named as a word, as a link, or handed over as a **file** -
		 * the last so that `this.file` can be the target of one of these in a base
		 * that is being read against a note.
		 */
		const target = { name: 'type', type: obsidian.FileValue
			? [obsidian.StringValue, obsidian.LinkValue, obsidian.FileValue]
			: [obsidian.StringValue, obsidian.LinkValue] };

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'isA',
			'True when the note is an instance of the given class, following "is a" and '
				+ 'then the "type of" chain above it — and the "is a" chain too, when '
				+ '"Instances inherit what their class carries" is on.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return new obsidian.BooleanValue(false);
				if (this.matchesSelf(file, key)) return new obsidian.BooleanValue(true);
				return new obsidian.BooleanValue(this.isAClosure(file).distance.has(key));
			},
		));

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'hasA',
			'True when the note reaches the given class through one of its component '
				+ 'fields, following that link and then the "type of" chain above it.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return new obsidian.BooleanValue(false);
				return new obsidian.BooleanValue(this.hasAClosure(file).distance.has(key));
			},
		));

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'hasADistance',
			'How many hops away the given class is through this note\'s component '
				+ 'fields, 1 when a field names it directly, or null.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return obsidian.NullValue.value;
				const distance = this.hasAClosure(file).distance.get(key);
				return distance === undefined
					? obsidian.NullValue.value : new obsidian.NumberValue(distance);
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

		/*
		 * The exact reading of the `type of` stream, added 2026-09-05 with the
		 * three-stream class base. Not a new idea: `isADistance` and `hasADistance`
		 * are the same sentence about the other two relations - a note whose *own*
		 * property names the class sits at 1, and every hop above adds one - and
		 * without it the third stream had no exact reading to offer.
		 *
		 * Distance 0 is the class itself, which is what `inheritsFrom` already says
		 * by answering true for it.
		 */
		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'inheritsFromDistance',
			'How many hops away the given class is along the "type of" chain, 0 for '
				+ 'the class itself, 1 when its own "type of" names it, or null.',
			[self, target],
			(file, args) => {
				const key = this.targetKey(args[0], file.path);
				if (key === null) return obsidian.NullValue.value;
				if (this.matchesSelf(file, key)) return new obsidian.NumberValue(0);
				const distance = this.inheritsClosure(file).distance.get(key);
				return distance === undefined
					? obsidian.NullValue.value : new obsidian.NumberValue(distance);
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

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'views',
			'The bases this note is looked at through, from two streams: the "views" '
				+ 'its class declares and every class above that, plus the "class views" '
				+ 'of the note itself and every class it is a type of.',
			[self],
			(file) => new obsidian.ListValue(this.viewEntriesFor(file).map(
				(entry) => new obsidian.LinkValue(this.app, entry.link, file.path, null))),
		));

		this.registerInstanceFunc(obsidian.FileValue, new BasesFunction(
			this, 'classBase',
			'The generated base this note is seen through: its own when it is a class '
				+ 'that has one, otherwise the nearest class above it that does.',
			[self],
			(file) => {
				const base = this.classBaseFor(file);
				/*
				 * Linked as `Artist Base.base` - the spelling a `views` row uses, and
				 * the one that resolves: a bare wikilink would find a note of that name
				 * before the base beside it.
				 */
				return base
					? new obsidian.LinkValue(this.app, base.name, file.path, null)
					: obsidian.NullValue.value;
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
		/* One property, or several - the walk is the same either way. */
		const properties = toArray(property);
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
				for (const climbed of properties) {
					for (const parent of this.linkedParents(node.file, climbed)) {
						const key = nodeKey(parent.file, parent.name);
						if (seen.has(key)) continue;
						seen.add(key);
						distance.set(key, depth + 1);
						names.set(key, parent.name);
						next.push(parent);
					}
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
			this.seedsWithRoot(file, this.linkedParents(file, this.settings.isAProperty)),
			this.instanceClimb());
		this.isACache.set(file.path, closure);
		return closure;
	}

	/*
	 * The other stream. `hasA` is `isA` with a different set of seeds: the classes
	 * this note names in its **component fields**, then every class those are a
	 * type of.
	 *
	 * *"Instead of isA('...'), component connections will be queried with
	 * hasA('...'). This will work the same way as isA, just through a different
	 * pipeline."* — so it is literally `climb` again, with `instanceClimb()` above
	 * the seeds, and a component field's target sits at distance 1 exactly as an
	 * `is a` target does. `hasADistance(X) == 1` therefore means *a field names X
	 * itself*, which is the same reading `isADistance` has and the one a base
	 * filter will want.
	 *
	 * **The root is not seeded here.** Everything is implicitly a root note, and
	 * nothing implicitly *has* one — an unfilled component field means the note
	 * does not have that component, which is his `is sub goal` left empty.
	 *
	 * Which of a note's keys are component fields comes from
	 * `componentProperties()`: the properties some class declared as one. Asking
	 * the note's own classes instead would be circular in the awkward case that
	 * matters — a note whose class it can only work out by walking.
	 */
	hasAClosure(file) {
		const hit = this.hasACache.get(file.path);
		if (hit) return hit;

		const fields = this.componentProperties();
		const seeds = [];
		if (fields.size > 0) {
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = (cache && cache.frontmatter) || {};
			for (const field of Object.keys(frontmatter)) {
				if (!fields.has(field)) continue;
				for (const entry of toArray(frontmatter[field])) {
					const name = linkName(entry);
					if (!name) continue;
					const dest = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
					seeds.push({
						file: dest instanceof TFile ? dest : null,
						name: dest instanceof TFile ? dest.basename : name,
					});
				}
			}
		}

		const closure = this.climb(file, seeds, this.instanceClimb());
		this.hasACache.set(file.path, closure);
		return closure;
	}

	/*
	 * The same implicit edge the class walk uses, for the base functions - so
	 * `file.isA("Note")` and the panel cannot disagree about one vault. That
	 * disagreement is exactly what killed this feature the first time.
	 *
	 * Resolved through the vault so it is the real note when one exists, and a
	 * virtual node by name when it does not, which is what `climb` expects.
	 */
	seedsWithRoot(file, seeds) {
		const names = this.rootAbove(file.basename);
		if (names.length === 0) return seeds;

		const already = new Set(seeds.map((seed) => nodeKey(seed.file, seed.name)));
		const extra = [];
		for (const name of names) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
			const seed = {
				file: dest instanceof TFile ? dest : null,
				name: dest instanceof TFile ? dest.basename : name,
			};
			if (already.has(nodeKey(seed.file, seed.name))) continue;
			extra.push(seed);
		}
		return seeds.concat(extra);
	}

	/*
	 * What `file.isA()` climbs above the seeds. `type of` always; `is a` as well
	 * when *Instances inherit what their class carries* is on.
	 *
	 * This is the setting reaching the base functions, and it has to: with it on
	 * the panel says an instance carries what its class's own `is a` reaches, and
	 * a base that disagreed about the same vault would be the Bases Is A problem
	 * all over again - one hierarchy, two readings, quietly out of step.
	 *
	 * `inheritsFrom()` is deliberately left alone. It asks the strict question -
	 * "is this a subclass of that?" - and there has to remain a way to ask it.
	 */
	instanceClimb() {
		const properties = [this.settings.inheritsProperty];
		if (this.settings.inheritCarried) properties.push(this.settings.isAProperty);
		return properties;
	}

	/*
	 * The implicit edge, in one place. Everything is a root note and a type of one,
	 * except the root itself - which would otherwise be its own ancestor, and every
	 * walk here is depth-capped rather than cycle-proof by construction.
	 *
	 * Returns [] when the feature is off, so every caller can append it blindly.
	 */
	rootAbove(name) {
		const root = String(this.settings.rootClass || '').trim();
		if (!root || !name) return [];
		return String(name).toLowerCase() === root.toLowerCase() ? [] : [root];
	}

	/* Pure subclassing: the `type of` chain starting at the note itself. */
	inheritsClosure(file) {
		const hit = this.inheritsCache.get(file.path);
		if (hit) return hit;
		const closure = this.climb(file,
			this.seedsWithRoot(file,
				this.linkedParents(file, this.settings.inheritsProperty)),
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


	/* ----- the views a note is looked at through ---------------------------- */

	/*
	 * `views` is a base characteristic in his sense: a class's `views:` names the
	 * bases - and, past a `#`, the view inside one - that its instances are seen
	 * through, and nothing is ever written into an instance to say so. His note:
	 * "the plugin will understand that they inherit that view, but it will not be
	 * specifically listed anywhere in the frontmatter."
	 *
	 * **There are two streams, and they differ by one edge** (2026-09-05, his note
	 * `Class inheritance vs instance inheritance`):
	 *
	 *   `views`        from note X: cross X's `is a`, then climb `type of`.
	 *                  **X itself is not in the set.**
	 *   `class views`  from note X: climb X's own `type of`, reflexively.
	 *                  **X itself is in the set.**
	 *
	 * He described `class views` as *"a hidden `is a` being added"*. It is the
	 * opposite, and that is what makes it cheap: it is the ordinary `is a` being
	 * **dropped**. Both exclusions he wanted then fall out of the vault's own
	 * shape, with no clause stating either:
	 *
	 *   - a class note has an empty `is a:`, so it receives nothing from the
	 *     instance stream — *"I want to avoid classes containing views that are
	 *     only meant for their instances"*;
	 *   - an instance has an empty `type of:`, so it receives nothing from the
	 *     class stream.
	 *
	 * The asymmetry in reflexivity is not a choice either: `type of` is reflexive
	 * by nature — a class is a kind of itself — while `is a` is not, since a class
	 * is not an instance of itself. It is the same reading `climb` already has,
	 * where a seed sits at distance 1 and the note itself is never in `distance`.
	 *
	 * A generated template still receives the instance views, because it really
	 * does carry `is a: [[Class]]` — which is right: a template should show what
	 * the notes made from it will show.
	 *
	 * **What the split gives up, and gives back.** `views` used to be read off the
	 * note itself at distance 0, which is what let a dashboard be pinned to one
	 * note. That is gone from this stream by design. It survives spelled
	 * `class views`: a plain note has no subtypes, so a `class views` on it
	 * reaches exactly itself.
	 *
	 * Nearest first, deduplicated on the link as written, **keeping the smallest
	 * distance across both streams**: two classes naming one view is one view, and
	 * the nearer one is the one that says where it came from. Reading each stream
	 * in ascending order and keeping the first would let a far entry from the
	 * stream read first beat a near one from the other.
	 */
	viewEntriesFor(file) {
		if (!(file instanceof TFile)) return [];

		const instanceProperty = String(this.settings.viewsProperty || '').trim();
		const classProperty = String(this.settings.classViewsProperty || '').trim();
		if (!instanceProperty && !classProperty) return [];

		const entries = [];
		const found = new Map();

		const read = (source, property, distance) => {
			if (!property) return;
			const cache = this.app.metadataCache.getFileCache(source);
			const frontmatter = (cache && cache.frontmatter) || null;
			if (!frontmatter) return;

			for (const raw of toArray(frontmatter[property])) {
				const link = viewLink(raw);
				if (!link) continue;

				const key = link.toLowerCase();
				const known = found.get(key);
				if (known) {
					/* One view named twice is one view, placed by the nearer naming. */
					if (distance < known.distance) {
						known.distance = distance;
						known.from = source.basename;
						known.stream = property === classProperty ? 'class' : 'instance';
					}
					continue;
				}

				const parts = splitViewLink(link);
				const entry = {
					link: link,
					target: parts.target,
					view: parts.view,
					file: this.resolveBase(parts.target, source.path),
					from: source.basename,
					stream: property === classProperty ? 'class' : 'instance',
					distance: distance,
				};
				found.set(key, entry);
				entries.push(entry);
			}
		};

		/*
		 * Walk one closure, reading one property off every real note in it. A class
		 * named but never written is a virtual node and has no frontmatter to read.
		 */
		const walk = (closure, property) => {
			if (!property) return;
			const keys = Array.from(closure.distance.keys())
				.sort((a, b) => closure.distance.get(a) - closure.distance.get(b));

			for (const key of keys) {
				if (key.charAt(0) !== 'f') continue;
				const source = this.app.vault.getAbstractFileByPath(key.slice(2));
				if (source instanceof TFile) read(source, property, closure.distance.get(key));
			}
		};

		/* The instance stream: `is a` first, and never the note itself. */
		walk(this.isAClosure(file), instanceProperty);

		/* The class stream: the note's own, then straight up `type of`. */
		read(file, classProperty, 0);
		walk(this.inheritsClosure(file), classProperty);

		/*
		 * Nearest first, or furthest first when that is what he asked for.
		 *
		 * A **stable sort on the distance alone**, not a reversal of the array: the
		 * order in which one note or class writes its own list is his, and
		 * reversing everything would turn that round as well. This turns only the
		 * chain round and leaves each source's own list exactly as written.
		 *
		 * The nearest-first sort is new and is the price of two streams. With one
		 * walk the push order *was* ascending distance, so nothing had to be done;
		 * two walks interleave, and a class view at distance 0 would otherwise sit
		 * behind the whole instance chain.
		 *
		 * A link named twice is still collected once, at the nearer of the two
		 * namings - the dedupe keeps the smaller distance as they are read - so it
		 * is placed by that distance either way.
		 */
		entries.sort((a, b) => (this.settings.viewsFurthestFirst
			? b.distance - a.distance
			: a.distance - b.distance));

		return entries;
	}

	/* The same, as the links themselves - what Dynamic Viewer reads. */
	viewsFor(file) {
		return this.viewEntriesFor(file).map((entry) => entry.link);
	}

	/*
	 * A base named with or without its extension. Obsidian's own link resolution
	 * defaults to `.md`, so `[[Improvement Base]]` finds the note of that name and
	 * never the base beside it - the `.base` fallback is what lets both spellings
	 * work, and a note wins only when there is no base to be found.
	 */
	resolveBase(target, sourcePath) {
		if (!target) return null;

		const path = sourcePath || '';
		const named = this.app.metadataCache.getFirstLinkpathDest(target, path);
		if (named instanceof TFile && named.extension === 'base') return named;

		const guessed = this.app.metadataCache.getFirstLinkpathDest(target + '.base', path);
		if (guessed instanceof TFile) return guessed;

		return named instanceof TFile ? named : null;
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

		/*
		 * A **file** as the target, which is what `this.file` is - so
		 * `file.hasA(this.file)` reads as "reaches the note I am looking at
		 * through a component field", and `file.isA(this.file)` likewise.
		 *
		 * Added 2026-09-05, and the reason is worth keeping: he set a view of
		 * `Goal Base` to *has a* expecting exactly that sentence, got an empty
		 * view, and read it as `hasA()` being broken. It was not - the switch says
		 * *has a **Goal***, and nothing reaches Goal through a component field.
		 * But the sentence he wanted had no way to be written at all: handed
		 * `this.file`, this fell through to `String(value.data)`, which for a file
		 * is `[object Object]`, and answered a name no note has. Silently false.
		 *
		 * Read off whichever shape the value carries rather than one of them, since
		 * a Bases value class is internal and none of this is documented.
		 */
		const file = value instanceof TFile ? value
			: (value.data instanceof TFile ? value.data
				: (value.file instanceof TFile ? value.file : null));
		if (file) return 'f:' + file.path;
		if (typeof value.path === 'string' && value.path
			&& typeof this.app.vault.getAbstractFileByPath === 'function') {
			const found = this.app.vault.getAbstractFileByPath(value.path);
			if (found instanceof TFile) return 'f:' + found.path;
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
		this.hasACache = new Map();
		/* Built out of those walks, so it cannot outlive them. */
		this.instanceCache = new Map();
		/*
		 * Which properties are component fields is read off the class notes, so a
		 * class gaining or losing one changes the answer — and every `hasA` walk is
		 * seeded from it.
		 */
		this.componentFieldCache = null;
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
		/* Whatever changed may have made or unmade an orphan. */
		if (this.refreshingOrphans) return;
		this.refreshingOrphans = true;
		window.setTimeout(() => {
			this.refreshingOrphans = false;
			this.refreshOrphanBases().catch(() => {});
		}, 400);
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
				this.carriedKeys([name], null, classes, drafts).keys, characteristics,
				{ classes: [name], objects: classes, drafts: drafts });
			klass.instances = [];
		}

		const instances = new Map();
		for (const found of this.scanInstances(classes)) {
			for (const className of found.classes) {
				const klass = classes.get(className);
				if (klass) klass.instances.push(found.file.basename);
			}
			const expected = this.carriedKeys(
				found.classes, found.frontmatter, classes, drafts).keys;

			instances.set(found.file.path, {
				name: found.file.basename,
				file: found.file,
				classes: found.classes,
				expected: this.canonicalOrder(expected, characteristics,
					{ classes: found.classes, objects: classes, drafts: drafts,
						frontmatter: found.frontmatter }),
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

		/*
		 * Which characteristics are component fields, read off the drafts so the
		 * panel's unsaved edits count. `constraintsFor` needs it: a class in
		 * `possible values` means something different on a component field, and
		 * the characteristic note itself does not say which kind it is — the
		 * classes that list it do.
		 */
		const componentFields = new Set();
		for (const draft of drafts.values()) {
			for (const field of draft.componentFields || []) componentFields.add(field);
		}

		/*
		 * And which *classes* are components — read off the `#component` tag. On the
		 * picture rather than recomputed by each reader, for the reason
		 * `componentFields` is here: two answers to one question is how the answers
		 * drift.
		 */
		const componentClasses = this.componentClasses(drafts);

		return {
			notes: notes,
			characteristics: characteristics,
			classes: classes,
			instances: instances,
			componentFields: componentFields,
			componentClasses: componentClasses,
			/*
			 * The classes whose kind is an open question. On the picture beside the
			 * set it comes from, so the panel and the plan read one answer.
			 */
			componentDisputes: this.componentDisputes(drafts, componentClasses),
			drafts: drafts,
			edits: this.drafts,
		};
	}

	/* ------------------------------------------------------ the class diagram */

	/*
	 * The picture, read as UML.
	 *
	 * Nothing new is derived here. Every answer below already exists — `drafts`
	 * says what a class declares, `ancestorsOf` says what is above it,
	 * `effectiveCharacteristics` is the same walk this one repeats to keep the
	 * *source* of each inherited row. What this adds is a **reading**: which of
	 * the picture's relations is which UML shape.
	 *
	 *   class box            a class note
	 *   generalization       `type of`          — hollow triangle at the parent
	 *   composition          `component fields` — filled diamond at the class
	 *   attribute            `characteristics`
	 *   the greyed half      what an ancestor declared
	 *   «stereotype»         the class symbol
	 *
	 * The reading is the whole design decision, and two halves of it are worth
	 * saying out loud:
	 *
	 * **`is a` is not an edge here.** It is UML's instantiation, and a diagram
	 * with 151 objects hanging off `Goal` is not a class diagram — so instances
	 * are a count in the footer. `type of` is generalization because that is what
	 * it means, and it is the only relation between two *classes* the vault has.
	 *
	 * **A component field is composition, and its target comes from the
	 * characteristic's own `possible values`.** That is the only place the vault
	 * writes down what class may fill a field, so it is the only place an edge
	 * could come from. A field with no `possible values` is drawn as a row and
	 * not as an edge — faithfully, since nothing says where it points.
	 *
	 * Pure and DOM-free on purpose, exactly like `buildPicture`: the view draws
	 * what this returns and decides nothing, so the suite can run the whole
	 * derivation with no app around it.
	 */
	umlDiagram(options) {
		const opts = Object.assign({
			inherited: true, components: true, instances: true, root: false, focus: '',
		}, options || {});

		const picture = this.picture();
		const classes = picture.classes;
		const drafts = picture.drafts;
		const characteristics = picture.characteristics;

		const typeOf = (name) => {
			const characteristic = characteristics.get(name);
			return (characteristic && characteristic.propertyType) || '';
		};

		/*
		 * The parents this class draws an edge to. `known` rather than filtered
		 * here, because a dangling `type of` is something the box says — it is one
		 * of the discrepancy panel's insolvable faults, and a diagram that simply
		 * omitted the edge would be the one place in the system where a fault is
		 * quietly tidied away.
		 */
		const parentsOf = (name) => {
			const draft = drafts.get(name);
			const out = [];
			const seen = new Set([name]);
			for (const parent of (draft && draft.parents) || []) {
				if (!parent || seen.has(parent)) continue;
				seen.add(parent);
				out.push({ name: parent, implicit: false, known: drafts.has(parent) });
			}
			/*
			 * The implicit root edge, which `ancestorsOf` walks whether or not it is
			 * drawn. Off by default and behind a toggle: it is true of every class at
			 * once, so drawing it turns the diagram into a star about `Obsidian Note`
			 * and says nothing that one line of text does not say better.
			 */
			for (const root of this.rootAbove(name)) {
				if (seen.has(root)) continue;
				seen.add(root);
				out.push({ name: root, implicit: true, known: drafts.has(root) });
			}
			return out;
		};

		/*
		 * Three states a class can be in, and the box says which:
		 *
		 *   a note behind it             ordinary
		 *   no note, but a panel draft   pending — Update will write it
		 *   no note and no draft         named by a `type of` and by nothing else
		 *
		 * The third is the plan's own definition of a dangling parent, down to the
		 * test it uses — `known.file || this.drafts.has(target)`. It is a class
		 * here rather than an omission because `scanClasses` records it as one, and
		 * a diagram that quietly dropped the box would be the single place in the
		 * system where a fault is tidied away in the act of reading it.
		 */
		const missing = (name) => {
			const object = classes.get(name);
			return !(object && object.file) && !picture.edits.has(name);
		};

		/*
		 * The rows an ancestor declared, nearest first, each carrying the class it
		 * came from. `effectiveCharacteristics` answers the same question and
		 * throws that last part away; the box needs it, since "inherited" with no
		 * "from where" is the half of the answer you cannot act on.
		 *
		 * `owned` excludes both lists at once. A class that redeclares a parent's
		 * characteristic keeps it in its own compartment and nowhere else, which is
		 * first-occurrence-wins drawn rather than restated.
		 */
		const inheritedOf = (name, owned, key) => {
			const rows = [];
			const seen = new Set(owned);
			for (const ancestor of this.ancestorsOf(name, classes, drafts)) {
				const draft = drafts.get(ancestor);
				if (!draft) continue;
				for (const entry of draft[key] || []) {
					if (!entry || seen.has(entry)) continue;
					seen.add(entry);
					rows.push({ name: entry, type: typeOf(entry), from: ancestor });
				}
			}
			return rows;
		};

		const nodes = new Map();
		for (const name of Array.from(drafts.keys()).sort((a, b) => a.localeCompare(b))) {
			const draft = drafts.get(name);
			const object = classes.get(name);

			const own = (draft.characteristics || []).filter(Boolean)
				.map((c) => ({ name: c, type: typeOf(c), kind: 'characteristic' }));
			const ownFields = (draft.componentFields || []).filter(Boolean)
				.map((f) => ({ name: f, type: typeOf(f), kind: 'component' }));

			const owned = new Set(own.map((r) => r.name).concat(ownFields.map((r) => r.name)));

			/*
				 * A symbol is one of two kinds of thing, and this is the sixth place
				 * in the plugin that has to know it — `paintSymbol`'s own comment
				 * says five copies of *is this an icon or a character* are five
				 * chances to disagree, and the first version of this diagram was the
				 * sixth by not asking at all: it concatenated the stored value, so
				 * 52 of his 53 classes drew the literal text `lucide:brush Art`.
				 *
				 * Split here rather than in the drawing, because the *width* depends
				 * on it too — `lucide:person-standing` measured as a title is a box
				 * three times wider than the name needs.
				 */
			const symbol = this.symbolFor(name, classes, drafts).symbol;

			nodes.set(name, {
				name: name,
				symbol: symbol,
				icon: isIconSymbol(symbol) ? iconNameOf(symbol) : '',
				glyph: isIconSymbol(symbol) ? '' : symbol,
				file: (object && object.file) || null,
				/* Pending: no note yet, but the panel is holding one. */
				isDraft: !(object && object.file) && picture.edits.has(name),
				/* And the fault: no note, and nothing waiting to write one. */
				isMissing: missing(name),
				own: own,
				ownFields: ownFields,
				inherited: inheritedOf(name, owned, 'characteristics')
					.map((r) => Object.assign(r, { kind: 'characteristic' })),
				inheritedFields: inheritedOf(name, owned, 'componentFields')
					.map((r) => Object.assign(r, { kind: 'component' })),
				parents: parentsOf(name),
				dangling: parentsOf(name)
					.filter((p) => !p.known || missing(p.name)).map((p) => p.name),
				instances: (object && object.instances) ? object.instances.length : 0,
				children: 0,
				depth: 0,
			});
		}

		/* Which parent edges are actually drawn — asked twice, so said once. */
		const drawnParents = (node) => node.parents.filter((parent) => parent.known
			&& (opts.root || !parent.implicit));

		const edges = [];
		for (const node of nodes.values()) {
			for (const parent of drawnParents(node)) {
				edges.push({ kind: 'generalization', from: node.name, to: parent.name,
					implicit: parent.implicit });
				nodes.get(parent.name).children++;
			}
		}

		if (opts.components) {
			const made = new Set();
			for (const node of nodes.values()) {
				for (const field of node.ownFields) {
					const characteristic = characteristics.get(field.name);
					for (const target of (characteristic && characteristic.possibleValues) || []) {
						if (!nodes.has(target) || target === node.name) continue;
						const id = node.name + ' ' + field.name + ' ' + target;
						if (made.has(id)) continue;
						made.add(id);
						edges.push({ kind: 'composition', from: node.name, to: target,
							label: field.name });
					}
				}
			}
		}

		/*
		 * How far down the generalization graph a class sits: one below its
		 * *furthest* parent, so an edge always points upwards and multiple
		 * inheritance cannot leave a child level with one of its parents.
		 *
		 * A `type of` cycle is the picture's business to report and not this
		 * function's to break — so it is survived rather than fixed. A name met
		 * twice on one walk answers 0 and is not remembered, which ends the
		 * recursion without deciding anything about the cycle.
		 */
		const depths = new Map();
		const depthOf = (name, trail) => {
			if (depths.has(name)) return depths.get(name);
			if (trail.has(name)) return 0;
			trail.add(name);
			let depth = 0;
			for (const parent of drawnParents(nodes.get(name))) {
				depth = Math.max(depth, depthOf(parent.name, trail) + 1);
			}
			trail.delete(name);
			depths.set(name, depth);
			return depth;
		};
		for (const node of nodes.values()) node.depth = depthOf(node.name, new Set());

		/*
		 * One class and everything it is related to. The generalization graph both
		 * ways — a class is not explained by its parents alone — plus whatever its
		 * component fields point at, one hop, because that is the class the field
		 * holds and not a whole second subtree.
		 */
		let kept = null;
		if (opts.focus && nodes.has(opts.focus)) {
			kept = new Set([opts.focus]);
			const climb = (name) => {
				for (const parent of drawnParents(nodes.get(name))) {
					if (kept.has(parent.name)) continue;
					kept.add(parent.name);
					climb(parent.name);
				}
			};
			const descend = (name) => {
				for (const node of nodes.values()) {
					if (kept.has(node.name)) continue;
					if (!drawnParents(node).some((p) => p.name === name)) continue;
					kept.add(node.name);
					descend(node.name);
				}
			};
			climb(opts.focus);
			descend(opts.focus);
			for (const edge of edges) {
				if (edge.kind !== 'composition') continue;
				if (edge.from === opts.focus) kept.add(edge.to);
				if (edge.to === opts.focus) kept.add(edge.from);
			}
		}

		const drawn = Array.from(nodes.values())
			.filter((node) => !kept || kept.has(node.name));
		const drawnNames = new Set(drawn.map((node) => node.name));

		/* Size every box from its own longest line, before anything is placed. */
		for (const node of drawn) {
			const compartments = [];
			const first = node.own.concat(node.ownFields);
			if (first.length > 0) compartments.push({ kind: 'own', rows: first });
			if (opts.inherited) {
				const second = node.inherited.concat(node.inheritedFields);
				if (second.length > 0) compartments.push({ kind: 'inherited', rows: second });
			}
			node.compartments = compartments;
			node.footer = opts.instances
				? this.umlFooter(node) : '';

			/*
			 * The title is measured apart from the rows, because an icon widens it
			 * by a fixed amount rather than by a number of characters — and adding
			 * that allowance to the widest line of all would widen boxes whose
			 * longest line is a row the icon sits nowhere near.
			 */
			node.title = (node.glyph ? node.glyph + ' ' : '') + node.name;
			const titleWidth = node.title.length * UML.charWidth
				+ (node.icon ? UML.iconSize + UML.iconGap : 0);

			const lines = [];
			for (const compartment of compartments) {
				for (const row of compartment.rows) lines.push(umlRowText(row));
			}
			if (node.footer) lines.push(node.footer);

			const widest = lines.reduce((most, line) => Math.max(most, line.length), 0);
			node.width = Math.max(UML.minWidth, Math.min(UML.maxWidth,
				Math.round(Math.max(titleWidth, widest * UML.charWidth) + UML.padX * 2)));

			let height = UML.headerHeight;
			for (const compartment of compartments) {
				height += UML.compartmentPad * 2 + compartment.rows.length * UML.rowHeight;
			}
			if (node.footer) height += UML.footerHeight;
			node.height = height;
		}

		return {
			nodes: drawn.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
			edges: edges.filter((edge) => drawnNames.has(edge.from) && drawnNames.has(edge.to)),
			options: opts,
		};
	}

	/*
	 * What the box says underneath. Counted rather than drawn, per the note on
	 * `umlDiagram`: these are the two numbers that say whether a class is doing
	 * any work, and both are already in the picture.
	 */
	umlFooter(node) {
		const parts = [];
		if (node.instances > 0) {
			parts.push(node.instances + (node.instances === 1 ? ' instance' : ' instances'));
		}
		if (node.children > 0) {
			parts.push(node.children + (node.children === 1 ? ' subtype' : ' subtypes'));
		}
		return parts.join('  ·  ');
	}

	/*
	 * Where every box goes: layered by depth, and ordered inside a layer to put
	 * a class near what it is joined to.
	 *
	 * The ordering is the barycentre heuristic — a node wants to sit at the mean
	 * x of its parents, then of its children, alternately — which is what every
	 * layered graph drawer starts with and is enough here. It is not exact and
	 * does not need to be: fewer crossings is the whole goal, and the alternative
	 * is a search whose cost he would feel on every redraw.
	 *
	 * Pure, and separate from `umlDiagram`, for the same reason `canonicalOrder`
	 * is separate from the walk that feeds it: the reading and the arrangement
	 * are two things, and only one of them changes when a box moves.
	 */
	umlLayout(diagram) {
		const layers = [];
		for (const node of diagram.nodes) {
			if (!layers[node.depth]) layers[node.depth] = [];
			layers[node.depth].push(node);
		}
		for (let index = 0; index < layers.length; index++) {
			if (!layers[index]) layers[index] = [];
		}

		const byName = new Map(diagram.nodes.map((node) => [node.name, node]));
		const parentsOf = new Map();
		const childrenOf = new Map();
		for (const node of diagram.nodes) {
			parentsOf.set(node.name, []);
			childrenOf.set(node.name, []);
		}
		for (const edge of diagram.edges) {
			if (edge.kind !== 'generalization') continue;
			if (!byName.has(edge.from) || !byName.has(edge.to)) continue;
			parentsOf.get(edge.from).push(edge.to);
			childrenOf.get(edge.to).push(edge.from);
		}

		/* A first, stable arrangement, so an empty barycentre never decides anything. */
		const order = new Map();
		for (const layer of layers) {
			layer.sort((a, b) => a.name.localeCompare(b.name));
			layer.forEach((node, index) => order.set(node.name, index));
		}

		const barycentre = (node, neighbours) => {
			const places = neighbours.map((name) => order.get(name))
				.filter((place) => place !== undefined);
			if (places.length === 0) return order.get(node.name);
			return places.reduce((sum, place) => sum + place, 0) / places.length;
		};

		const sweep = (neighboursOf, downwards) => {
			const range = downwards
				? layers.map((_, index) => index) : layers.map((_, index) => index).reverse();
			for (const index of range) {
				const layer = layers[index];
				const keys = new Map(layer.map((node) =>
					[node.name, barycentre(node, neighboursOf.get(node.name))]));
				layer.sort((a, b) => keys.get(a.name) - keys.get(b.name)
					|| a.name.localeCompare(b.name));
				layer.forEach((node, place) => order.set(node.name, place));
			}
		};

		for (let pass = 0; pass < 4; pass++) {
			sweep(parentsOf, true);
			sweep(childrenOf, false);
		}

		/* Widths first, so every layer can be centred on the same axis. */
		const widths = layers.map((layer) => layer.reduce(
			(sum, node, index) => sum + node.width + (index > 0 ? UML.hGap : 0), 0));
		const widest = widths.reduce((most, width) => Math.max(most, width), 0);

		let y = UML.margin;
		layers.forEach((layer, index) => {
			let x = UML.margin + (widest - widths[index]) / 2;
			let tallest = 0;
			for (const node of layer) {
				node.x = Math.round(x);
				node.y = Math.round(y);
				x += node.width + UML.hGap;
				tallest = Math.max(tallest, node.height);
			}
			y += tallest + UML.vGap;
		});

		return {
			layers: layers,
			width: Math.round(widest + UML.margin * 2),
			height: Math.round(Math.max(y - UML.vGap, 0) + UML.margin),
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
	valueDiscrepancies(picture, skip) {
		const found = [];

		this.walkValues(picture, (file, key, value) => {
			const characteristic = picture.characteristics.get(key);
			if (!characteristic) return;

			if (isEmptyValue(value)) return;
			/* Machinery, not data: it is not a date yet, it is the code for one. */
			if (isTemplaterExpression(value)) return;

			const shape = this.shapeComplaint(characteristic, value);
			if (shape) {
				found.push({ file: file, property: key, value: value, reason: shape });
				return;
			}

			const complaint = this.valueComplaint(
				characteristic, value, picture, file ? file.path : '', skip);
			if (complaint) {
				found.push({ file: file, property: key, value: value, reason: complaint });
			}
		});

		return found;
	}

	/*
	 * Every property of every note the model knows about, once each: the
	 * instances, the class notes themselves, and the generated templates.
	 *
	 * One walk rather than a copy of it per pass, because two passes now ask the
	 * same question of the same notes - which values do not fit - and they have
	 * to see exactly the same set. If the aggregate saw a note the conflict pass
	 * did not, it would suppress a report nobody ever made.
	 *
	 * Templates count. A default written into one - `domain: visual` on every
	 * Visual Artist - is a real value that reaches every instance made from it,
	 * so it has to satisfy the same characteristic as any other.
	 *
	 * Once each is the point of `seen`: a class note that is also an instance of
	 * something appears in two of the three sets, and counting its values twice
	 * would say `implemented` is on twenty-two notes when it is on twenty-one.
	 */
	walkValues(picture, visit) {
		const seen = new Set();
		const each = (file, keys, values) => {
			for (const key of keys) {
				const id = (file ? file.path : '') + '::' + key;
				if (seen.has(id)) continue;
				seen.add(id);
				visit(file, key, values[key]);
			}
		};

		for (const instance of picture.instances.values()) {
			each(instance.file, Array.from(instance.keys), instance.values);
		}
		for (const klass of picture.classes.values()) {
			if (!klass.file || !klass.frontmatter) continue;
			each(klass.file, Array.from(klass.keys), klass.frontmatter);
		}
		for (const name of picture.classes.keys()) {
			const template = this.app.vault.getFileByPath(this.templatePathFor(name));
			if (!(template instanceof TFile)) continue;
			const frontmatter = this.frontmatterOf(template);
			if (!frontmatter) continue;
			each(template, Object.keys(frontmatter), frontmatter);
		}
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
				constraints.push({
					kind: 'interval', interval: interval,
					text: interval.text, entry: entry,
				});
				continue;
			}

			const name = linkName(typeof entry === 'string' ? entry : String(entry));
			if (!name) continue;
			const canonical = this.canonicalName(name);

			if (picture && picture.classes && isWikiLink(entry) && picture.classes.has(canonical)) {
				/*
				 * **On a component field a class means something else**, and this is
				 * the one place the two readings meet.
				 *
				 * An ordinary characteristic holds a subject, so `[[Person]]` there
				 * asks for *an instance of* Person — a note whose `is a` reaches it.
				 * A component field holds a **class**, so `[[Coding]]` there asks for
				 * Coding itself or any class that is a `type of` it. His own example
				 * is the proof: `subject` may hold `Coding`, and *"multiple other
				 * classes would inherit from Coding such as Bug or Obsidian Plugin"*
				 * — under the instance reading every one of those is refused, because
				 * `Bug` is a subclass of Coding and not one of its instances.
				 *
				 * Which reading applies is decided by the classes that list the
				 * characteristic, not by the characteristic note, because that is
				 * where a component field is declared.
				 */
				const component = !!(picture.componentFields
					&& picture.componentFields.has(characteristic.name));
				constraints.push({
					kind: 'class', name: canonical, component: component,
					text: component
						? canonical + ' or a type of it'
						: 'instances of ' + canonical,
					entry: entry,
				});
				continue;
			}

			/*
			 * The entry as written travels with the constraint. Only the value
			 * suggestions read it, and they need the word he typed rather than the
			 * name it was reduced to - see suggestedValuesFor.
			 */
			constraints.push({
				kind: 'literal', name: canonical, text: canonical, entry: entry,
			});
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
		/*
		 * A component field's value *is* a class, so the walk is `type of` and the
		 * class itself counts — unconditionally, not through
		 * `classIsItsOwnInstance`, which answers a different question (whether a
		 * class is one of its own instances). `Coding` in a field that permits
		 * `Coding` is not a borderline case.
		 */
		if (constraint.component) {
			return nodeKey(dest, dest.basename) === key
				|| this.inheritsClosure(dest).distance.has(key);
		}
		return this.matchesSelf(dest, key) || this.isAClosure(dest).distance.has(key);
	}

	/* Everything in this value that no constraint admits, said in one sentence. */
	valueComplaint(characteristic, value, picture, sourcePath, skip) {
		const constraints = this.constraintsFor(characteristic, picture);

		/*
		 * A component field holds a class, and that is true whether or not its
		 * `possible values` narrows *which* class. So an unconstrained one is not
		 * unconstrained after all: `type: soon` is wrong in a way `category: soon`
		 * is not, and saying so is worth more here than anywhere else, because a
		 * value that names nothing quietly hands the note no characteristics and
		 * looks exactly like a component that was never filled in.
		 */
		const isComponent = !!(picture && picture.componentFields
			&& picture.componentFields.has(characteristic.name));
		if (isComponent && !constraints.some((c) => c.kind === 'class')) {
			const strays = [];
			for (const entry of toArray(value)) {
				if (isEmptyValue(entry)) continue;
				const name = linkName(typeof entry === 'string' ? entry : String(entry));
				const canonical = name ? this.canonicalName(name) : '';
				if (canonical && picture.classes && picture.classes.has(canonical)) continue;
				strays.push(name || String(entry));
			}
			if (strays.length === 0) return null;
			return strays.join(', ') + ' — ' + characteristic.name
				+ ' is a component field, so its value has to name a class.';
		}

		if (constraints.length === 0) return null;

		const wantsClass = constraints.some((c) => c.kind === 'class');
		const offenders = [];

		for (const entry of toArray(value)) {
			if (isEmptyValue(entry)) continue;
			if (constraints.some((c) => this.admits(c, entry, sourcePath))) continue;

			/*
			 * A value with an answer already on its way, or one gathered into a
			 * question of its own, is not reported a second time here. Twenty-one
			 * notes holding a word that was renamed is one question, and saying it
			 * twenty-one times as well would bury it.
			 */
			if (skip && skip.has(valueRenameKey(characteristic.name, entry))) continue;

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

	/*
	 * The other inheritance. Two run in this model, and they are not the same
	 * shape:
	 *
	 *   A `is a` B      A itself carries B's characteristics
	 *   A `type of` B   A carries none of them, but every instance of A gets
	 *                   A's own *and* B's
	 *
	 * `effectiveCharacteristics` is the second - what instances of A receive.
	 * This is the first: what the note A holds in its own frontmatter because of
	 * what it says it is. The planner has always enforced it; nothing ever
	 * displayed it, which is why the panel looked like inheritance was broken.
	 */
	carriedCharacteristics(name, objects, drafts) {
		const draft = drafts.get(name);
		if (!draft) return [];

		const classes = (draft.values[this.settings.isAProperty] || [])
			.filter((className) => className !== name && drafts.has(className));
		if (classes.length === 0) return [];

		/*
		 * Through `carriedKeys`, so a class note gets the component fields its own
		 * `is a` gives it — and, where it has filled one in, what that leads to.
		 * A class note is an ordinary note in this respect: nothing about being a
		 * class stops it being a Goal whose `type` is Effort.
		 */
		const frontmatter = draft.file ? this.frontmatterOf(draft.file) : null;
		return this.carriedKeys(classes, frontmatter, objects, drafts).keys;
	}

	/* ----- the canonical property order ------------------------------------ */

	propertyTypeOf(name, characteristics) {
		const characteristic = characteristics.get(name);
		return characteristic && characteristic.propertyType
			? String(characteristic.propertyType)
			: '';
	}

	/*
	 * Which class each characteristic came from, and in what order those classes
	 * should be met. The walk is the same one `effectiveCharacteristics` does —
	 * each class, then its ancestors nearest first — so the groups come out in
	 * inheritance order, and a characteristic redeclared further up is credited
	 * to the nearest class that declares it, which is the one you would name if
	 * asked where it came from.
	 *
	 * `context` is `{ classes, objects, drafts }`: the classes the note claims.
	 */
	provenanceOf(context) {
		const rank = new Map();
		const owner = new Map();
		if (!context || !context.drafts) return { rank, owner };

		let position = 0;
		const meet = (className) => {
			if (rank.has(className)) return;
			rank.set(className, position);
			position += 1;
			const draft = context.drafts.get(className);
			for (const characteristic of (draft && draft.characteristics) || []) {
				if (!owner.has(characteristic)) owner.set(characteristic, className);
			}
			/*
			 * A component field is credited to the class that *declares* it, not to
			 * the class it points at — the same distinction drawn everywhere else
			 * here. `Goal` owns `type`; `Effort` owns what filling it brings.
			 */
			for (const field of (draft && draft.componentFields) || []) {
				if (!owner.has(field)) owner.set(field, className);
			}
		};

		const walk = (className) => {
			meet(className);
			for (const ancestor of this.ancestorsOf(className, context.objects, context.drafts)) {
				meet(ancestor);
			}
		};

		for (const className of toArray(context.classes)) walk(className);

		/*
		 * Then the classes this note reaches through its own component fields,
		 * **after** the ones it says it is. A property that arrived through `type:
		 * [[Effort]]` groups under Effort, and the group sits below the note's own
		 * class — which is the order the note reads in: what it is, then what it
		 * has.
		 */
		if (context.frontmatter) {
			const reach = this.carriedKeys(context.classes, context.frontmatter,
				context.objects, context.drafts);
			for (const target of reach.targets) walk(target.name);
		}

		return { rank, owner };
	}

	/*
	 * Properties are laid out by **property type first, then alphabetically**,
	 * whatever order they were added in. A property with no type known - no
	 * characteristic note, or one that has not said - sorts last, so untyped
	 * things do not wedge themselves between the typed groups.
	 *
	 * With *Group by the class it came from* on, that becomes the ordering
	 * **inside** each group, and the groups themselves run in inheritance order.
	 * Base characteristics lead, because `is a` belongs at the top of a note and
	 * no class declares it; anything managed that no class declares trails.
	 */
	canonicalOrder(names, characteristics, context) {
		const grouped = this.settings.propertyOrder === 'class' && context;
		const { rank, owner } = grouped
			? this.provenanceOf(context)
			: { rank: new Map(), owner: new Map() };

		/*
		 * Base characteristics before every class, unowned ones after every
		 * class — `rank` only ever holds values in between.
		 */
		/*
		 * The bands, top to bottom:
		 *
		 *   -2  base characteristics — what the note *is*, so first
		 *   -1  a characteristic no class accounts for
		 *   0…  the classes, **outermost ancestor first**
		 *
		 * Ancestors before descendants because that is the order the properties
		 * were acquired in: what every note has, then what every Person has, then
		 * what only an Artist has. Reading down the panel is reading down the
		 * hierarchy. `rank` counts the other way — 0 is the nearest class — so it
		 * is turned around here rather than in the walk, which several other
		 * things depend on being nearest-first.
		 *
		 * Fields Obsidian owns are not managed at all, so they never reach this
		 * and stay above the whole block, which is where he wants them.
		 */
		const deepest = rank.size > 0 ? rank.size - 1 : 0;
		const groupOf = (name) => {
			if (!grouped) return 0;
			/*
			 * `is a` ahead of the other base characteristics. They are one band and
			 * one heading, but within it the alphabet would put `characteristics`
			 * first, and the line that says what the note *is* should be the line
			 * you read first — on a template most of all, where it is the point.
			 */
			if (name === this.settings.isAProperty) return -4;
			if (this.isBaseProperty(name, characteristics)) return -3;
			const from = owner.get(name);
			if (!rank.has(from)) return -2;
			/*
			 * The root before every other class. The walk finds it at depth one —
			 * it is reachable from anywhere, that being what a root is — so by
			 * distance alone it landed in the middle, below classes that are in
			 * fact narrower than it. It is the most general thing in the vault by
			 * definition, so it is placed rather than measured.
			 */
			if (this.isRootClass(from)) return -1;
			return deepest - rank.get(from);
		};

		return names.slice().sort((a, b) => {
			const groupA = groupOf(a);
			const groupB = groupOf(b);
			if (groupA !== groupB) return groupA - groupB;

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

	/* ----- the group headings, in the properties panel --------------------- */

	/*
	 * The ordering above puts each class's characteristics together in the file.
	 * This draws the line between them where he can see it — and draws it in the
	 * **rendering**, never in the file.
	 *
	 * That is his call and it is the right one. Nothing survives in frontmatter
	 * except real YAML keys: there is not one comment or blank line in the two
	 * thousand notes of his vaults, because Obsidian re-emits the block from a
	 * parsed object every time a property is touched. A heading written into the
	 * file would have to be a property, and would then be a property for ever —
	 * in the panel, in every base, in the count. A heading drawn over the panel
	 * costs the file nothing and cannot decay.
	 */
	/*
	 * Force the headings to be built again. Needed when a *setting* changes the
	 * wording rather than the grouping: the signature is made of group keys, so
	 * an unchanged panel would rightly decide it had nothing to do and the new
	 * wording would not appear until something else disturbed it.
	 */
	redrawPropertyHeadings() {
		this.clearPropertyHeadings();
		this.queuePropertyHeadings();
	}

	/* ----- what a property field offers ------------------------------------
	 *
	 * Obsidian answers "what can go here" by scanning the vault for values that
	 * key already holds, and sorting them alphabetically. Where a characteristic
	 * has said what its values are, that is two wrong answers at once: a word
	 * nothing carries yet is not offered at all, and the order is the alphabet's
	 * rather than his. `possible values` is the better answer, so it is the one
	 * given — in the order the characteristic note writes it, the same order
	 * OOF Declared Order sorts a base by.
	 *
	 * It **replaces** Obsidian's list rather than joining it, and that is the
	 * point rather than an oversight. `possible values` is an allowlist: this
	 * plugin already reports every note holding a value it does not admit, so
	 * offering those values here would be offering to make one more.
	 *
	 * Where the characteristic does not **list** its values — no `possible values`
	 * at all, an interval, which is a shape, or a class, which is a type — Obsidian's
	 * own answer stands untouched. The plugin speaks only where it has something to
	 * say, which is what keeps a number field's used values in place and what keeps
	 * a class-valued field's shortlist of the notes he actually files under it from
	 * being buried under every instance in the vault. *Offer a class's instances
	 * too* opts back into the enumeration, class-valued characteristics and all;
	 * it is off, and why is at `suggestClassInstances`.
	 *
	 * The hook is `getFrontmatterPropertyValuesForKey`, which the value suggester
	 * is the only caller of. Everything downstream — the fuzzy filter, the link
	 * flair on a `[[…]]` suggestion, which widgets suggest at all — is Obsidian's
	 * and is left alone. One consequence worth knowing: with the field empty every
	 * suggestion scores 0 and the sort is stable, so the declared order is what
	 * shows; once he types, Obsidian ranks by how well each matches, which is what
	 * typing is for.
	 */
	registerValueSuggestions() {
		const cache = this.app.metadataCache;
		const original = cache.getFrontmatterPropertyValuesForKey;
		if (typeof original !== 'function') return;

		const patched = (key) => {
			let mine = null;
			try { mine = this.suggestedValuesFor(key); } catch (error) {
				/* Never take the field's own suggestions away over a bug in ours. */
				console.error('oof-classes: value suggestions', error);
			}
			return (mine && mine.length) ? mine : original.call(cache, key);
		};

		cache.getFrontmatterPropertyValuesForKey = patched;
		this.register(() => {
			/* Put back only what we replaced, and only while ours is still on. */
			if (cache.getFrontmatterPropertyValuesForKey === patched) {
				cache.getFrontmatterPropertyValuesForKey = original;
			}
		});
	}

	/*
	 * What `possible values` names for this property, in the order it names them,
	 * or null when it names nothing enumerable.
	 *
	 * Read through `constraintsFor`, so the three kinds are decided in exactly one
	 * place: the same classifier that says whether a note's value is permitted
	 * says what to offer, and the two can never come to disagree.
	 */
	suggestedValuesFor(key) {
		if (!this.settings.suggestPossibleValues || !key) return null;

		const picture = this.picture();
		const characteristic = picture.characteristics.get(key);
		if (!characteristic) return null;

		const suggestions = [];
		const seen = new Set();
		const offer = (text) => {
			const clean = String(text).trim();
			if (!clean || seen.has(clean.toLowerCase())) return;
			seen.add(clean.toLowerCase());
			suggestions.push(clean);
		};

		for (const constraint of this.constraintsFor(characteristic, picture)) {
			/* An interval is a shape and cannot be enumerated. */
			if (constraint.kind === 'interval') continue;

			/*
			 * A class is a *type*, and enumerating one is off unless he asks for
			 * it (2026-08-30, `Suggestions for values of properties are buggy` and
			 * the setting he asked for straight after).
			 *
			 * The two reasons a listed value beats Obsidian's answer both fail for
			 * a class, which is why the default is off. There is no declared order
			 * to restore: instances come out of a vault walk, alphabetically,
			 * exactly as Obsidian sorts. And nothing is missing that a note has not
			 * used yet: typing `[[` in the field hands over to Obsidian's own link
			 * search, which reaches every note in the vault, not merely the
			 * instances.
			 *
			 * What it costs was measured on his own vault: `project` names
			 * `[[Project]]`, and because `Improvement` is a type of `Project` that
			 * enumerated **84** notes in place of the **8** he actually files under
			 * it. None of the 8 were lost — they were buried, which for a list you
			 * pick from is the same thing. On a class with few instances it is a
			 * genuinely better list than Obsidian's, which is why the switch
			 * exists rather than the behaviour simply being gone.
			 */
			if (constraint.kind === 'class') {
				/*
				 * **A component field is the exception to *don't enumerate a type*,
				 * and it is the exception for the reason that rule was made.**
				 *
				 * That rule (2026-08-30) says a class in `possible values` names a
				 * type, and enumerating a type answers a question the field did not
				 * ask: `project` naming `[[Project]]` offered 84 notes where the
				 * vault held 8 values, and `[[` already reaches every note anyway.
				 *
				 * Both halves fail here, in the opposite direction. A component
				 * field's answer set is not the instances but the **subclasses** —
				 * closed, small, and exactly what he means by *"if the class is
				 * accepted by the possible values"*. And `[[` does not stand in for
				 * it: it reaches every note in the vault, where two or three of them
				 * are legal answers. So this list is strictly better than Obsidian's
				 * and there is nothing to weigh, which is why it needs no setting.
				 */
				if (constraint.component) {
					for (const name of this.subclassesOf(constraint.name)) {
						offer('[[' + name + ']]');
					}
					continue;
				}
				if (!this.settings.suggestClassInstances) continue;
				for (const name of this.instancesOf(constraint.name)) {
					offer('[[' + name + ']]');
				}
				continue;
			}

			/*
			 * A word is offered exactly as the characteristic note writes it.
			 * `constraint.name` has been through `canonicalName`, which would lend
			 * the word the capitalisation of a note that merely happens to share its
			 * spelling. A link stays a link, and there the canonical name is the
			 * right one, because it is the name that resolves.
			 */
			offer(isWikiLink(constraint.entry)
				? '[[' + constraint.name + ']]'
				: (typeof constraint.entry === 'string' ? constraint.entry : constraint.name));
		}

		return suggestions.length ? suggestions : null;
	}

	/*
	 * Every note that is an instance of this class, by name, alphabetically —
	 * the same walk `file.isA()` does, so a base and a property field cannot come
	 * to disagree about what a Place is. Only *Offer a class's instances too*
	 * reaches this.
	 *
	 * A generated template is not one, and this is the one walk that has to say
	 * so. `Teacher Template.md` carries `is a: [[Teacher]]` — that is what makes
	 * a note built from it a Teacher — so the walk finds it and it is perfectly
	 * right to; but it is the file that *makes* teachers, and offering it as one
	 * is the same mistake `activeClassesFor` already refuses to make. Judged by
	 * folder, the way that pass judges it by path.
	 *
	 * Cached, because the suggester asks again on every keystroke. It is emptied
	 * with the closures it is built out of, so any edit to the hierarchy drops it.
	 */
	/*
	 * A class and every class below it, the class itself first and the rest
	 * alphabetically — what a component field permitting that class will accept.
	 *
	 * `inheritsClosure`, not `isAClosure`: subclassing, strictly. Read off the
	 * notes rather than off the panel's drafts, because it answers a live
	 * suggester and the vault is what the value will be checked against. Shares
	 * `instanceCache` — both are dropped by `invalidateClosures`, and the keys
	 * cannot collide because this one is prefixed.
	 */
	subclassesOf(className) {
		const cacheKey = 'sub:' + className;
		const hit = this.instanceCache.get(cacheKey);
		if (hit) return hit;

		const key = this.keyForName(className, '');
		const below = this.filesIn(this.settings.notesFolder)
			.filter((file) => !this.isTemplateFile(file))
			.filter((file) => nodeKey(file, file.basename) !== key)
			.filter((file) => this.hasClassTag(file))
			.filter((file) => this.inheritsClosure(file).distance.has(key))
			.map((file) => file.basename)
			.sort((a, b) => a.localeCompare(b));

		const named = this.canonicalName(className);
		const names = [named].concat(below.filter((name) => name !== named));
		this.instanceCache.set(cacheKey, names);
		return names;
	}

	instancesOf(className) {
		const hit = this.instanceCache.get(className);
		if (hit) return hit;

		const key = this.keyForName(className, '');
		const names = this.app.vault.getMarkdownFiles()
			.filter((file) => !this.isTemplateFile(file))
			.filter((file) => this.matchesSelf(file, key)
				|| this.isAClosure(file).distance.has(key))
			.map((file) => file.basename)
			.sort((a, b) => a.localeCompare(b));

		this.instanceCache.set(className, names);
		return names;
	}

	/* ----- the menu on a property's value ----------------------------------
	 *
	 * The note is where you notice a value needs renaming, so it is where the
	 * rename should start.
	 *
	 * Obsidian already has a menu there — *Edit*, *Copy*, *Remove from list* — and
	 * it is a good one, so ours is **added to it** rather than put in its place.
	 * `Menu.forEvent` hands out one menu per event, so asking it for the menu is
	 * all it takes: Obsidian's listener asks for the same one. Where nothing else
	 * asks, the menu shows carrying only ours.
	 *
	 * One listener on the document rather than one per view. Property rows are
	 * rendered in a markdown view, in the sidebar and inside a base's properties
	 * panel, and all three are `.metadata-property[data-property-key]` — so
	 * delegation covers every one of them and there is nothing to attach, detach
	 * or keep in step when a leaf opens.
	 */
	registerPropertyValueMenu() {
		this.propertyMenuHandler = (event) => {
			if (!this.settings.renameValueFromProperties) return;

			let context = null;
			try { context = this.propertyContextFor(event); } catch (error) {
				/* Never take out the app's own menu because of a bug in ours. */
				console.error('oof-classes: property menu', error);
				return;
			}
			if (!context) return;

			/*
			 * `Menu.forEvent` is Obsidian's own extension point, and the whole
			 * answer. Read out of `obsidian-1.13.7.asar`:
			 *
			 *     Menu.forEvent = function (e) {
			 *       e.preventDefault();
			 *       var m = cache.get(e);
			 *       return m || (m = new Menu(), cache.set(e, m),
			 *         e.win.setTimeout(function () { m.showAtMouseEvent(e); }), m);
			 *     };
			 *
			 * One menu per event, kept in a WeakMap. So the menu returned here in
			 * the capture phase is **the very menu** Obsidian's own listener on the
			 * pill adds Edit, Copy and Remove from list to a moment later in the
			 * bubble phase. One menu, everyone's items, nothing to synchronise, and
			 * no assumption about who runs first.
			 *
			 * It also calls preventDefault itself and shows the menu on a timeout
			 * of its own — which is what the earlier attempts were fighting. Racing
			 * that timeout with one of ours is what produced the two stacked menus:
			 * ours was queued first, looked for a menu in the document, found none
			 * because Obsidian's had not rendered yet, and opened underneath it.
			 */
			const shared = typeof Menu.forEvent === 'function';
			const menu = shared ? Menu.forEvent(event) : new Menu();

			this.addValueRenameItems(menu, context);

			/* Older Obsidian, with no shared menu: ours alone, as it always was. */
			if (!shared) {
				event.preventDefault();
				menu.showAtMouseEvent(event);
			}
		};

		document.addEventListener('contextmenu', this.propertyMenuHandler, true);
		this.register(() => document.removeEventListener(
			'contextmenu', this.propertyMenuHandler, true));
	}

	/*
	 * What this right-click is about, or null when it is about nothing of ours.
	 */
	propertyContextFor(event) {
		const target = event.target;
		if (!target || typeof target.closest !== 'function') return null;

		/*
		 * A selection means he is doing something with the text — copying it, or
		 * about to paste over it — and Electron's own menu is the one he wants.
		 *
		 * This is the whole of the deference to that menu, and it is enough. A
		 * property value is an `input`, not a text editor: an empty one offers
		 * nothing to rename and falls through here on its own, and the case left
		 * over — right-clicking a value that is sitting there, without selecting
		 * it — is the case he asked for. Ctrl+V still pastes, and the setting
		 * turns the whole thing off.
		 */
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return null;

		const row = target.closest('.metadata-property[data-property-key]')
			|| target.closest('[data-property-key]');
		if (!row || !row.dataset || !row.dataset.propertyKey) return null;

		/* The key half is Obsidian's: it owns that menu, and it is a good one. */
		if (target.closest('.metadata-property-key')) return null;

		const key = row.dataset.propertyKey;
		const file = this.fileShowing(row);
		if (!file) return null;

		/*
		 * Whose values these are. **Two places**, and the second is the one he
		 * reached for first: a note carrying `status:` holds values of `status`,
		 * and a characteristic note's own `possible values` holds values of the
		 * characteristic it *is*. That list is where you change your mind about a
		 * value, so it is exactly where the rename has to be offered.
		 */
		let name = key;
		if (this.isCharacteristicFile(file) && key === 'possible values') {
			name = stripPrefix(file.basename, this.settings.characteristicPrefix);
		}

		const characteristic = this.picture().characteristics.get(name);
		if (!characteristic) return null;

		const frontmatter = this.frontmatterOf(file);
		if (!frontmatter || !(key in frontmatter)) return null;

		/*
		 * Which values this note holds under that key, from the **frontmatter**
		 * rather than from the markup.
		 *
		 * That is the whole reason this is robust. Obsidian's value markup differs
		 * per property type and changes between versions — a truncated div here, a
		 * pill there — so reading a value out of it would be a guess with a version
		 * number attached. The DOM is asked one question it answers reliably, and
		 * has answered since 1.13.7: which property row is this. The values come
		 * from the note.
		 */
		const values = toArray(frontmatter[key])
			.filter((entry) => !isEmptyValue(entry) && !isTemplaterExpression(entry))
			/* A link is a note, and Obsidian renames a note properly. */
			.filter((entry) => !isWikiLink(entry))
			/* And `[0, 10]` is a range, not a word. */
			.filter((entry) => !parseInterval(entry))
			.map((entry) => String(entry).trim())
			.filter(Boolean);
		if (values.length === 0) return null;

		/*
		 * The text under the pointer, when it can be read, so a list offers the one
		 * entry he clicked rather than all of them. Unreadable is not a failure:
		 * every value is offered instead, which is still one click away and cannot
		 * be wrong.
		 */
		const clicked = this.valueTextAt(target, row);
		const one = values.find(
			(value) => value.toLowerCase() === String(clicked).trim().toLowerCase());

		return {
			key: key,
			name: name,
			characteristic: characteristic,
			file: file,
			values: one ? [one] : values,
		};
	}

	/*
	 * Our items, on whichever menu ends up being shown.
	 *
	 * Sectioned rather than separated by hand. Obsidian's pill menu declares its
	 * sections — `title, open, action-primary, action, info, view, system, "",
	 * danger` — and puts its own three in `action-primary`, so `action` lands
	 * ours directly beneath them with the separator Obsidian draws itself. A
	 * hand-written separator would have been a second one, or a stray line above
	 * nothing on a menu carrying only these.
	 */
	addValueRenameItems(menu, context) {
		const section = (item) => (typeof item.setSection === 'function'
			? item.setSection('action') : item);

		for (const value of context.values.slice(0, 8)) {
			menu.addItem((item) => section(item)
				.setTitle('Rename "' + value + '" everywhere…')
				.setIcon('replace')
				.onClick(() => {
					new RenameValueModal(this.app, this,
						{ characteristic: context.name, from: value }).open();
				}));
		}

		/* Pointless when he is already reading it. */
		const note = context.characteristic.file;
		if (!note || note.path === context.file.path) return;
		menu.addItem((item) => section(item)
			.setTitle('Open ' + note.basename)
			.setIcon('file-text')
			.onClick(() => { this.app.workspace.getLeaf(false).openFile(note); }));
	}

	/*
	 * The text of the value under the pointer, or ''. Every selector here is a
	 * best effort and none is load-bearing — see `propertyContextFor`.
	 */
	valueTextAt(target, row) {
		const pill = target.closest
			&& (target.closest('.multi-select-pill') || target.closest('[class*="pill"]'));
		if (pill) {
			/*
			 * The pill carries a remove button whose label is part of its text, so
			 * the content element is preferred where there is one.
			 */
			const content = pill.querySelector
				&& (pill.querySelector('.multi-select-pill-content')
					|| pill.querySelector('[class*="pill-content"]'));
			return (content || pill).textContent || '';
		}

		const value = target.closest && target.closest('.metadata-property-value');
		if (value && value.children.length <= 1) return value.textContent || '';

		/* A single-valued row: the row itself, minus its key, is the value. */
		const keyEl = row.querySelector('.metadata-property-key');
		if (keyEl && row.textContent) {
			return row.textContent.slice((keyEl.textContent || '').length);
		}
		return '';
	}

	/* The file whose properties this row belongs to. */
	fileShowing(row) {
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const view = leaf && leaf.view;
			const container = view && view.containerEl;
			if (container && container.contains(row) && view.file instanceof TFile) {
				found = view.file;
			}
		});
		return found || this.app.workspace.getActiveFile();
	}

	queuePropertyHeadings() {
		if (this.headingTimer) window.clearTimeout(this.headingTimer);
		this.headingTimer = window.setTimeout(() => {
			this.headingTimer = null;
			this.renderPropertyHeadings();
		}, 0);
	}

	/*
	 * Obsidian's own markup, as of 1.13.7: a `.metadata-container` per markdown
	 * view holding one `.metadata-property[data-property-key]` per property. The
	 * selectors are tried in order and the first that finds rows wins, so a
	 * renamed container in a later version costs the headings rather than
	 * throwing inside someone's editor.
	 */
	propertyRowsIn(root) {
		for (const selector of ['.metadata-property[data-property-key]',
			'.metadata-property', '[data-property-key]']) {
			const found = Array.from(root.querySelectorAll(selector))
				.filter((el) => el.dataset && el.dataset.propertyKey);
			if (found.length > 0) return found;
		}
		return [];
	}

	clearPropertyHeadings(root) {
		const scope = root || document;
		for (const el of Array.from(scope.querySelectorAll('.oof-property-group'))) {
			el.remove();
		}
		/* Or the next render would believe its work was already done. */
		for (const el of Array.from(scope.querySelectorAll('[data-oof-groups]'))) {
			delete el.dataset.oofGroups;
		}
		if (scope.dataset && scope.dataset.oofGroups !== undefined) {
			delete scope.dataset.oofGroups;
		}
	}

	renderPropertyHeadings() {
		/*
		 * Headings only mean anything when the properties are actually grouped.
		 * In flat order the classes interleave, so a heading would appear above
		 * nearly every row and say nothing.
		 */
		const grouped = this.settings.propertyOrder === 'class';

		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf && leaf.view;
			const container = view && view.containerEl;
			const file = view && view.file;
			if (!container || !(file instanceof TFile)) return;

			if (!grouped) { this.clearPropertyHeadings(container); return; }

			const rows = this.propertyRowsIn(container);
			if (rows.length === 0) { this.clearPropertyHeadings(container); return; }

			const frontmatter = this.frontmatterOf(file) || {};
			/*
			 * The root class counts, and asking only the note's own `is a` was why
			 * it did not. When a root is set every note is one implicitly and by
			 * design writes no link saying so — so reading the link alone means the
			 * root can never be the answer, and its characteristics get reported as
			 * belonging to nothing. The ordering has always concatenated
			 * `rootAbove` here; the headings were the half that forgot.
			 */
			const classes = toArray(frontmatter[this.settings.isAProperty])
				.map(linkName).filter(Boolean)
				.concat(this.rootAbove(file.basename));

			const objects = this.scanClasses();
			const drafts = this.allDrafts(objects);
			const characteristics = this.scanCharacteristics();
			const { owner } = this.provenanceOf(
				{ classes: classes, objects: objects, drafts: drafts,
					frontmatter: frontmatter });

			/*
			 * The label for a row, or null where a heading would be noise.
			 *
			 * There is deliberately no early return for a note that claims no
			 * class. **Every class note in the vault is one**: a class says what
			 * its instances carry through `characteristics` and `type of`, and
			 * leaves its own `is a` empty. Bailing out meant that opening the very
			 * note where `type of` lives showed nothing at all — which is what he
			 * reported, and it read as `type of` being unsupported when in fact the
			 * chain was being walked correctly for every instance.
			 *
			 * What decides a heading is the property, not the note. Every row gets
			 * one, and there are three that do not name a class:
			 *
			 *   Base characteristics    `is a`, `type of`, and anything a
			 *                           characteristic note flags as base
			 *   Not from a class        a real characteristic that no class in the
			 *                           chain — nor the root — hands down
			 *   Nothing to do with      an ordinary field of his; the class system
			 *   classes                 has no opinion about it
			 *
			 * The last two are worth keeping apart. One is a question about the
			 * hierarchy and the other is not a question at all.
			 */
			const labelFor = (key) => {
				if (this.isBaseProperty(key, characteristics)) return BASE_LABEL;
				if (owner.has(key)) return owner.get(key);
				if (this.isIgnoredProperty(key)) return NATIVE_LABEL;
				return characteristics.has(key) ? NO_CLASS_LABEL : NATIVE_LABEL;
			};

			const labels = rows.map((row) => labelFor(row.dataset.propertyKey));

			/*
			 * A note with nothing but ordinary fields is left alone. One heading
			 * reading "nothing to do with classes" over the whole of a journal
			 * entry is not information, it is a plugin announcing itself — and the
			 * section exists to separate those fields *from* the class ones, which
			 * needs there to be some.
			 */
			if (labels.every((label) => label === NATIVE_LABEL)) {
				this.clearPropertyHeadings(container);
				return;
			}

			/*
			 * What the headings would be, as one string. Obsidian mutates this
			 * panel constantly — focus, hover, its own re-renders — and each of
			 * those wakes the observer. Tearing the headings down and building
			 * them again every time was **why clicking one did nothing**: between
			 * the mousedown and the click, the element under the pointer had been
			 * replaced by an identical one, and a click needs the same node for
			 * both halves.
			 *
			 * So nothing is rebuilt unless the answer actually changed.
			 */
			/*
			 * The symbols are part of the answer now, so a class gaining or losing
			 * one has to count as a change — otherwise the headings keep the mark
			 * they were built with until something else happens to move a row.
			 */
			const signature = rows.map(
				(row, i) => labels[i] + ' :: ' + row.dataset.propertyKey).join(' | ')
				+ ' :: ' + Array.from(new Set(labels)).filter((label) => this.isClassGroup(label))
					.map((label) => label + this.symbolText(label, objects, drafts)).join(',');

			if (container.dataset.oofGroups === signature
				&& container.querySelector('.oof-property-group')) {
				/* Same layout; only the folded state can have moved. */
				this.decorating = true;
				for (const heading of Array.from(
					container.querySelectorAll('.oof-property-group'))) {
					this.syncGroup(heading);
				}
				this.decorating = false;
				this.watchProperties(container);
				return;
			}

			/*
			 * Only now are the old headings thrown away. Clearing them before the
			 * comparison — which is what this did at first — deletes the signature
			 * along with them, so the comparison could never match and every
			 * mutation rebuilt everything.
			 */
			this.clearPropertyHeadings(container);

			this.decorating = true;
			let last = null;
			const headings = [];
			for (let i = 0; i < rows.length; i += 1) {
				const row = rows[i];
				const label = labels[i];
				if (label === last) continue;
				last = label;
				const heading = createDiv({ cls: 'oof-property-group' });
				/*
				 * The twisty first, so the row reads as something you can act on
				 * rather than as a caption that happens to be clickable.
				 */
				const twisty = heading.createSpan({ cls: 'oof-property-group-twisty' });
				if (typeof setIcon === 'function') setIcon(twisty, 'chevron-down');
				/*
				 * The class's symbol over its section, which is the other half of
				 * what he asked for: the same mark beside the class in the panel and
				 * above the properties that came from it. Only the class groups get
				 * one — *Base characteristics* and *Nothing to do with classes* are
				 * not classes and have no symbol to inherit.
				 */
				if (this.isClassGroup(label)) {
					const glyph = this.symbolFor(label, objects, drafts).symbol;
					if (glyph) {
						paintSymbol(heading.createSpan({ cls: 'oof-property-group-symbol' }),
							glyph);
					}
				}
				heading.createSpan({
					cls: 'oof-property-group-name', text: this.headingTextFor(label) });
				heading.createSpan({ cls: 'oof-property-group-count' });
				heading.dataset.group = label;
				heading.setAttr('role', 'button');
				heading.setAttr('tabindex', '0');
				row.parentElement.insertBefore(heading, row);
				headings.push(heading);
			}

			for (const heading of headings) this.syncGroup(heading);
			this.decorating = false;
			container.dataset.oofGroups = signature;

			this.watchProperties(container);
		});
	}

	/* ----- the Add property button, and the hotkey that replaces it -------- */

	/*
	 * Obsidian's own button, in whichever pane is showing the active note. Same
	 * defensive shape as `propertyRowsIn`: these are its internal class names, so
	 * a rename in a later version should cost the feature rather than throw.
	 */
	addPropertyButton() {
		const active = this.app.workspace.getActiveFile();
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const view = leaf && leaf.view;
			const container = view && view.containerEl;
			if (!container || !view.file) return;
			if (active && view.file.path !== active.path) return;
			for (const selector of ['.metadata-add-button', '.metadata-properties-heading '
				+ '.clickable-icon', '[class*="metadata-add"]']) {
				const button = container.querySelector(selector);
				if (button) { found = button; return; }
			}
		});
		return found;
	}

	/*
	 * Press it, even when it is hidden. `display: none` does not stop a
	 * programmatic click — the handler runs and Obsidian adds its empty row —
	 * but it does make the button measure 0x0, so it is briefly made real again
	 * in case anything positions itself against it. One tick, imperceptible.
	 *
	 * `setTimeout` rather than `requestAnimationFrame`: rAF does not fire in a
	 * window that is not compositing, and a backgrounded Obsidian would then
	 * leave the button showing until something else redrew it.
	 */
	pressAddProperty(button) {
		const hidden = this.settings.hideAddProperty;
		if (hidden) document.body.classList.remove('oof-hide-add-property');
		button.click();
		if (hidden) window.setTimeout(() => this.applyAddPropertyVisibility(), 0);
	}

	/*
	 * Native `classList`, not Obsidian's `toggleClass`. This runs on load, and
	 * Obsidian's Element helpers are its own extensions — depending on them here
	 * made every suite that does not stub them throw before its first assertion.
	 */
	applyAddPropertyVisibility() {
		document.body.classList.toggle(
			'oof-hide-add-property', !!this.settings.hideAddProperty);
	}

	/*
	 * What the command is bound to, for the settings tab to report — because
	 * hiding the button without binding the hotkey leaves him with neither, and
	 * that is a trap worth closing rather than documenting.
	 */
	addPropertyHotkey() {
		const id = this.manifest.id + ':add-property';
		const manager = this.app.hotkeyManager;
		if (!manager) return null;
		const keys = (manager.customKeys && manager.customKeys[id])
			|| (manager.getDefaultHotkeys && manager.getDefaultHotkeys(id))
			|| [];
		if (!keys.length) return null;
		return keys.map((key) => toArray(key.modifiers).concat([key.key]).join(' + '))
			.join(', ');
	}

	/*
	 * The rows a heading owns: everything after it until the next heading. The
	 * headings are siblings of the rows rather than wrappers, deliberately —
	 * Obsidian owns that list and rebuilds it, and a wrapper would be a second
	 * claim on its structure. Walking siblings costs nothing and survives.
	 */
	groupRows(heading) {
		const out = [];
		let node = heading.nextElementSibling;
		while (node && !node.classList.contains('oof-property-group')) {
			if (node.dataset && node.dataset.propertyKey) out.push(node);
			node = node.nextElementSibling;
		}
		return out;
	}

	/*
	 * A group that names a class, as opposed to the three fixed ones.
	 */
	isClassGroup(key) {
		return key !== BASE_LABEL && key !== NO_CLASS_LABEL && key !== NATIVE_LABEL;
	}

	/*
	 * What the heading reads. A class group says "Person characteristics" rather
	 * than "Person", because the heading is over the properties a Person carries,
	 * not over a Person.
	 *
	 * Kept apart from the group's **key**, which stays the bare class name. The
	 * key is what a fold is remembered by, and tying that to the wording would
	 * mean every future rephrasing silently unfolded everything — the lesson from
	 * renaming the native section.
	 */
	headingTextFor(key) {
		if (!this.isClassGroup(key)) return key;
		return this.settings.nameSectionsAsCharacteristics
			? key + ' characteristics'
			: key;
	}

	isGroupCollapsed(label) {
		return toArray(this.settings.collapsedGroups).indexOf(label) !== -1;
	}

	/* One heading and its rows, brought into line with the setting. */
	syncGroup(heading) {
		const collapsed = this.isGroupCollapsed(heading.dataset.group);
		const rows = this.groupRows(heading);
		heading.toggleClass('is-collapsed', collapsed);
		for (const row of rows) row.toggleClass('oof-group-hidden', collapsed);

		/*
		 * The count only when folded. Open, it is one more number beside a list
		 * you can already see; folded, it is the only evidence anything is there.
		 */
		const count = heading.querySelector('.oof-property-group-count');
		if (count) count.setText(collapsed ? String(rows.length) : '');
	}

	async toggleGroup(label) {
		if (!label) return;
		const collapsed = toArray(this.settings.collapsedGroups).filter(
			(name) => name !== label);
		if (!this.isGroupCollapsed(label)) collapsed.push(label);
		this.settings.collapsedGroups = collapsed;

		/*
		 * The fold happens first and the write follows. A click should show its
		 * effect immediately rather than a disk round-trip later — and every open
		 * pane is done at once, so the same group is never half folded.
		 */
		this.decorating = true;
		for (const heading of Array.from(
			document.querySelectorAll('.oof-property-group'))) {
			if (heading.dataset.group === label) this.syncGroup(heading);
		}
		this.decorating = false;

		/*
		 * Straight to disk, not through `saveSettings`: that drops the picture and
		 * the closures, which folding a heading has no business doing.
		 */
		await this.persist();
	}

	/*
	 * Obsidian rebuilds the rows whenever a property is edited, which throws the
	 * headings away. One observer per container puts them back — guarded against
	 * its own writes, or inserting a heading would trigger the observer that
	 * inserted it.
	 */
	watchProperties(container) {
		if (this.propertyObservers.has(container)) return;
		const observer = new MutationObserver(() => {
			if (this.decorating) return;
			this.queuePropertyHeadings();
		});
		observer.observe(container, { childList: true, subtree: true });
		this.propertyObservers.set(container, observer);
		this.register(() => observer.disconnect());

		/*
		 * One delegated listener on the container, rather than a handler on each
		 * heading. The container outlives every rebuild of the rows; a heading
		 * does not, and a listener attached to a node that has since been
		 * replaced is a listener that never fires. This is the half of the fix
		 * that does not depend on the rebuild being avoided.
		 *
		 * `mousedown` as well as `click`, because a click needs the same element
		 * for press and release, and the panel is exactly the kind of place where
		 * that stops being true.
		 */
		const hit = (event) => {
			const heading = event.target && event.target.closest
				? event.target.closest('.oof-property-group')
				: null;
			if (!heading || !container.contains(heading)) return null;
			return heading;
		};

		/*
		 * Both `mousedown` and `click`, because neither alone covers everything: a
		 * real press fires mousedown first, while a programmatic `.click()` — and
		 * assistive technology — fires only click. Debounced against each other so
		 * one press is one fold rather than two.
		 */
		const onPress = (event) => {
			const heading = hit(event);
			if (!heading) return;
			event.preventDefault();
			event.stopPropagation();

			const label = heading.dataset.group;

			/*
			 * A press raises mousedown and then click, and that pair is one fold.
			 * A *time window* is the wrong tool for this — it cannot tell the click
			 * that follows a press from a second, deliberate press, and blocking
			 * the latter looked exactly like the bug being fixed. So the mousedown
			 * marks, and the click that follows consumes the mark and returns.
			 * Two presses leave no mark standing between them, however fast.
			 */
			if (event.type === 'click') {
				if (this.pendingFold === label) { this.pendingFold = null; return; }
			} else {
				this.pendingFold = label;
			}

			this.toggleGroup(label);
		};

		container.addEventListener('mousedown', onPress, true);
		container.addEventListener('click', onPress, true);
		this.register(() => {
			container.removeEventListener('mousedown', onPress, true);
			container.removeEventListener('click', onPress, true);
		});

		const onKey = (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			const heading = hit(event);
			if (!heading) return;
			event.preventDefault();
			/* Enter on a focused element also raises a click; one fold, not two. */
			onPress(event);
		};
		container.addEventListener('keydown', onKey, true);
		this.register(() => container.removeEventListener('keydown', onKey, true));
	}

	/*
	 * A base characteristic: one of the logic properties, or a characteristic note
	 * that says so. Shared by the ordering and by the headings deliberately — two
	 * readings of "base" would put a property in one group and label it another.
	 */
	/*
	 * All of them, in order: the logic properties as he has listed them, then any
	 * characteristic note flagged `is base characteristic`. The predicate below
	 * answers for one key; this is the same question asked of the whole vault.
	 */
	baseCharacteristics(characteristics) {
		const out = this.settings.logicProperties.slice();
		const seen = new Set(out);
		if (characteristics) {
			for (const [name, characteristic] of characteristics) {
				if (!characteristic.isBase || seen.has(name)) continue;
				seen.add(name);
				out.push(name);
			}
		}
		return out;
	}

	isBaseProperty(key, characteristics) {
		if (this.settings.logicProperties.includes(key)) return true;
		const characteristic = characteristics && characteristics.get(key);
		return !!(characteristic && characteristic.isBase);
	}

	/*
	 * The folders that describe the class system: templates, characteristics and
	 * the generated bases. Nothing in them is an instance, however it is tagged —
	 * a note filed with the bases is about the bases.
	 */
	systemFolders() {
		return [
			this.settings.templatesFolder,
			this.settings.characteristicsFolder,
			this.settings.basesFolder,
		].filter((folder) => !!String(folder || '').trim());
	}

	inSystemFolder(file) {
		return this.systemFolders().some((folder) => this.inFolder(file, folder));
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
	 * The generated base a note is *seen through*: its own when it is a class that
	 * has one, otherwise the nearest class above it that does. What
	 * `file.classBase()` answers.
	 *
	 * Existence at the path this plugin would generate is the whole test - the
	 * same one `classForBase` makes, and the same reason: a base of his own that
	 * happens to end in " Base" must never be mistaken for a class's, and the
	 * dynamic base belongs to a selection rather than to a class. A class whose
	 * base he has trashed simply hands the question up to its parent.
	 *
	 * The `is a` closure first, nearest first - the walk `views` makes, and for
	 * the same reason: an instance is looked at through its class's base.
	 *
	 * Then the `type of` chain, which is not the same question and is the whole
	 * reason there are two walks here. A class seeds `isAClosure` with its `is a`,
	 * and a class has none - so a subclass whose base has been trashed would
	 * otherwise answer nothing at all, when the base of the class it is a type of
	 * is exactly what it should fall back to.
	 *
	 * One base, not a list. A note with two classes at the same distance takes the
	 * first its `is a` names, because "the base of this note" is one thing to open.
	 */
	classBaseFor(file) {
		if (!(file instanceof TFile)) return null;

		const generated = (name) => {
			if (!name) return null;
			const path = this.basePathFor(name);
			if (path === this.dynamicBasePath()) return null;
			const base = this.app.vault.getFileByPath(path);
			return base instanceof TFile ? base : null;
		};

		const own = generated(file.basename);
		if (own) return own;

		for (const closure of [this.isAClosure(file), this.inheritsClosure(file)]) {
			const keys = Array.from(closure.distance.keys())
				.sort((a, b) => closure.distance.get(a) - closure.distance.get(b));

			for (const key of keys) {
				const base = generated(closure.name.get(key));
				if (base) return base;
			}
		}

		return null;
	}

	/*
	 * Build the .base file for one class. Deliberately plain text rather than a
	 * YAML library: the shape is fixed, and this way the output reads exactly
	 * like the bases he writes by hand.
	 */
	baseColumnsFor(name, objects, drafts) {
		if (this.settings.baseColumns === 'own') {
			const draft = drafts.get(name) || {};
			/* Its own component fields are its own columns, for the same reason. */
			return (draft.characteristics || []).concat(draft.componentFields || []);
		}
		/*
		 * `carriedKeys` with no frontmatter: the characteristics and the component
		 * fields, and nothing a component *leads to* — a base is about the class,
		 * and what a given instance's `type` brings is a fact about that instance.
		 */
		return this.carriedKeys([name], null, objects, drafts).keys;
	}

	/*
	 * `reading` arrives here only from a reset - a base is generated as an
	 * inclusive `is a`, and every switch on the Class base menu is something done
	 * to one afterwards. It is passed through so that a reset rebuilds the base in
	 * the reading it was already in, which is the one thing a reset is not being
	 * asked to change; with none given, the generated reading is the plain one.
	 */
	baseContentFor(name, objects, drafts, reading) {
		const columns = this.baseColumnsFor(name, objects, drafts);
		const held = reading && (reading.streams || []).length > 0
			? reading
			: { streams: ['is a'], exact: false, excluded: {} };

		const lines = [];
		lines.push('filters:');
		lines.push('  and:');
		/* Instances of this class, inheritance included unless asked otherwise. */
		for (const line of this.readingClauseLines(name, held, 4)) lines.push(line);
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

	/* ----- the dynamic base ------------------------------------------------ */

	/*
	 * The one base that is rewritten rather than created once: it shows the
	 * instances of whichever classes are selected right now, and there is exactly
	 * one of it — his design, and the only one that works, because two bases
	 * cannot be opened at once.
	 *
	 * Named through `baseSuffix` like every other generated base, so it reads as
	 * one of the family rather than as a stray file.
	 */
	dynamicBasePath() {
		return this.settings.basesFolder + '/Dynamic' + this.settings.baseSuffix + '.base';
	}

	/*
	 * Every instance of any of them, and the columns are the union of what each
	 * class would show. Union rather than intersection: the point of looking at
	 * two classes together is to see what each brings, and an empty cell says
	 * "this one does not have that" perfectly well.
	 *
	 * `or:` nested inside `and:` rather than one expression with `||` — that is
	 * the grouping Bases' own filter format uses, and it is what Obsidian's filter
	 * editor will render back if he opens it.
	 */
	dynamicBaseContent(names, objects, drafts) {
		const columns = [];
		for (const name of names) {
			for (const column of this.baseColumnsFor(name, objects, drafts)) {
				if (columns.indexOf(column) === -1) columns.push(column);
			}
		}

		const lines = [];
		lines.push('filters:');
		lines.push('  and:');
		lines.push('    - or:');
		for (const name of names) lines.push('        - file.isA("' + name + '")');
		lines.push('    - \'!file.inFolder("' + this.settings.templatesFolder + '")\'');
		lines.push('views:');
		lines.push('  - type: table');
		lines.push('    name: ' + yamlScalar(andList(names.slice())));
		lines.push('    order:');
		lines.push('      - file.name');
		for (const column of columns) lines.push('      - ' + yamlScalar(column));

		return lines.join('\n') + '\n';
	}

	/*
	 * Write it and open it.
	 *
	 * **A file at that path this plugin did not create is never overwritten.** It
	 * is the only file the plugin rewrites without an Update plan in front of it,
	 * so the one protection it has to carry is that it is certainly ours: the flag
	 * is set when we create it and persisted, and without it the answer is no.
	 */
	async openDynamicBase(names, objects, drafts) {
		const path = this.dynamicBasePath();
		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing && !this.dynamicBaseOurs) {
			new Notice('OOF Class Manager: "' + path + '" already exists and was not created by '
				+ 'this plugin, so it will not be overwritten. Rename or delete it, or '
				+ 'switch the base setting back to static.', 10000);
			return null;
		}

		await this.ensureFolder(this.settings.basesFolder);
		const content = this.dynamicBaseContent(names, objects, drafts);

		let file = existing;
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else file = await this.app.vault.create(path, content);

		if (!this.dynamicBaseOurs) {
			this.dynamicBaseOurs = true;
			await this.persist();
		}

		await this.app.workspace.getLeaf(false).openFile(file);
		return file;
	}

	/* ----- the Class base item in Obsidian's own toolbar -------------------- */

	/*
	 * A generated base carries a **Class base** button in the base's own toolbar,
	 * beside Filter, Properties and Sort - his ask, 2026-08-28. It says what a
	 * class base is, it holds the *exact matches only* switch, and it is where a
	 * base is reset from its class.
	 *
	 * **The reset moved here and the panel's copy went with it** (his N.B.), and
	 * that is not a tidying-up. On a class card the reset was the one control that
	 * destroyed work nothing else keeps a copy of, aimed at a file you were *not*
	 * looking at - so it needed a typed code, and a queue, and an Update plan to
	 * show it one more time before anything happened. Standing on the base, the
	 * question is answerable by looking: this file, this diff, yes or no. One
	 * confirmation with the real diff under it replaces three layers of deferral,
	 * and `baseRefreshes` - the queue that existed only to carry the answer from
	 * the panel to the next Update - is gone with them.
	 *
	 * The consequence is worth stating: `write-base` no longer overwrites anything
	 * at all. Update creates a base that does not exist and never touches one that
	 * does, which is what its comment always claimed and is now true with no
	 * exception behind it.
	 *
	 * The button is drawn on the **base file's own** toolbar. A base embedded in a
	 * note has a toolbar too, and does not get one: that toolbar's leaf is about
	 * the note, and resetting a file from a view of it that lives somewhere else
	 * is exactly the aim-at-what-you-cannot-see problem this move was undoing.
	 */

	/*
	 * The class a `.base` was generated for, or null.
	 *
	 * Matched against the path the plugin *would* produce, the same test
	 * `activeClassesFor` uses - one comparison, and it can never claim a base of
	 * his that happens to end in " Base". The dynamic base is excluded outright:
	 * it belongs to a selection rather than to a class, and it is rewritten every
	 * time it is opened, so there is nothing there to reset.
	 */
	classForBase(file, drafts) {
		if (!(file instanceof TFile) || file.extension !== 'base') return null;
		if (!this.settings.createBases) return null;
		if (file.path === this.dynamicBasePath()) return null;

		const suffix = this.settings.baseSuffix || '';
		if (suffix && !file.basename.endsWith(suffix)) return null;
		const name = (suffix
			? file.basename.slice(0, file.basename.length - suffix.length)
			: file.basename).trim();
		if (!name || file.path !== this.basePathFor(name)) return null;

		const all = drafts || this.allDrafts(this.scanClasses());
		return all.has(name) ? name : null;
	}

	/*
	 * ── what a generated base holds ─────────────────────────────────────────
	 *
	 * Until 2026-09-05 this was **one line in one of four readings** - two
	 * questions, crossed: which of two streams, and how far along it. His note
	 * `Improvements to Class Bases` widens the first question and adds a third:
	 *
	 *   streams   any of `is a`, `has a`, `type of`, **or-ed**, at least one on
	 *   exclude   per stream, classes dropped out of that stream's subtree
	 *   exact     one switch across all of them
	 *
	 * **`or` and not `and` is his sentence, and it is the only reading that can
	 * be meant**: a note reached through a component field is not also an
	 * instance of the class, so anding two streams would empty every base that
	 * had both on. The streams are alternative routes to one class, not
	 * conditions on one note.
	 *
	 * **An exclusion is written without a distance, always.** `!file.isA("Effort")`
	 * removes the notes under Effort as well as Effort's own - his "if one class
	 * is excluded, then all of its children are turned off as well (because this
	 * is how it works anyways)". The relation already says it, so only the
	 * topmost class of an excluded branch is ever written, and a subclass he adds
	 * tomorrow is excluded the day it appears rather than the day the list is
	 * next opened.
	 *
	 * **One stream and nothing excluded is still one line**, byte-identical to
	 * what all 47 of his bases already say - which is why not one of them needed
	 * migrating for any of this.
	 */

	baseStreamOf(id) {
		for (const stream of BASE_STREAMS) if (stream.id === id) return stream;
		return BASE_STREAMS[0];
	}

	/*
	 * The term one stream contributes.
	 *
	 *   all     file.isA("Person")                subclasses included
	 *   exact   file.isADistance("Person") == 1   only notes naming it directly
	 *
	 * `<fn>Distance(X) == 1` is the exact reading of every stream for one reason:
	 * `climb()` seeds a direct mention at 1 and every hop above adds one. So
	 * "the note's own is a names X", "its own component field names X" and "its
	 * own type of names X" are one sentence about three relations, and the third
	 * needed only that its distance function be registered.
	 *
	 * None of them needs quoting - `==` is nothing to YAML.
	 */
	baseFilterExpression(name, exact, stream) {
		const fn = this.baseStreamOf(stream).fn;
		return exact
			? 'file.' + fn + 'Distance("' + name + '") == 1'
			: 'file.' + fn + '("' + name + '")';
	}

	/* One class dropped out of one stream. Quoted: a leading `!` is a YAML tag. */
	baseExcludeExpression(name, stream) {
		return '!file.' + this.baseStreamOf(stream).fn + '("' + name + '")';
	}

	/*
	 * How many notes one stream reaches at all, right now.
	 *
	 * **This exists because of a real mistake of his** (2026-09-05): he turned
	 * *has a* on for a view of `Goal Base`, the view emptied, and he read that as
	 * `hasA()` being broken. It was not - `file.hasA("Goal")` is true of **no**
	 * note in his vault and correctly so, because Goal is a class you instantiate
	 * and nothing names it in a component field. The switch was answering
	 * honestly; there was simply nothing to tell him that the answer was zero
	 * *before* he threw it.
	 *
	 * So the number sits on the row. `is a Goal - 151 notes`, `has a Goal -
	 * nothing reaches Goal this way`, and on `Obsidian Plugin Base` the other way
	 * round: `is a - nothing`, `has a - 113 notes`, which is the whole reason the
	 * stream switch exists said in one line.
	 *
	 * It counts what the *base* would hold, not what this reading holds:
	 * `matchesSelf` and the templates folder are treated exactly as the generated
	 * filter treats them, and exclusions are deliberately **not** applied - the
	 * question a row answers is "is there anything down this road", which is the
	 * one you ask before turning it on.
	 *
	 * Measured on his vault: 5ms cold over 346 notes, 0ms warm. It shares
	 * `instanceCache`, so `invalidateClosures` drops it with everything else, and
	 * the key is prefixed so it cannot collide.
	 */
	streamReach(className, stream) {
		const cacheKey = 'reach:' + stream + ':' + className;
		const hit = this.instanceCache.get(cacheKey);
		if (hit !== undefined) return hit;

		const key = this.keyForName(className, '');
		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.isTemplateFile(file)) continue;
			if (this.reachDistance(file, key, stream) !== null) count += 1;
		}
		this.instanceCache.set(cacheKey, count);
		return count;
	}

	/*
	 * How far this note is from the class down one stream, or null for out of
	 * reach — which is the whole of what a base filter asks.
	 *
	 * **It is the base functions' own arithmetic, said once.** `isADistance`,
	 * `hasADistance` and `inheritsFromDistance` are three spellings of one
	 * sentence, and everything that counts what a base holds has to agree with
	 * them exactly or the number on a card contradicts the rows behind it. The
	 * two asymmetries are theirs, not this function's: `matchesSelf` answers 0 for
	 * the two relations a class can bear to itself, and `has a` has none, because
	 * a class does not name itself in one of its own component fields.
	 */
	reachDistance(file, key, stream) {
		if (stream === 'has a') {
			const found = this.hasAClosure(file).distance.get(key);
			return found === undefined ? null : found;
		}
		if (this.matchesSelf(file, key)) return 0;
		const closure = stream === 'type of'
			? this.inheritsClosure(file) : this.isAClosure(file);
		const found = closure.distance.get(key);
		return found === undefined ? null : found;
	}

	/*
	 * How many notes a reading actually holds — the number a generated base would
	 * show if you opened it now.
	 *
	 * Not the same question as `streamReach`, and the difference is the point of
	 * both. A stream row asks *is there anything down this road*, which is asked
	 * before the switch is thrown, so it ignores exactness and exclusions. A count
	 * that sits on a **button** has to answer *what will I see when I press this*,
	 * so it applies all three — or the card says one number and the base it opens
	 * shows another, which is worse than no number.
	 *
	 * It mirrors `readingClauseLines` clause for clause, because that function is
	 * what the file actually says: the streams are or-ed, each stream's exclusions
	 * are and-ed onto it, and an exclusion is written without a distance whatever
	 * the reading's exactness — which is his own rule, so a subclass added
	 * tomorrow is excluded the day it appears.
	 */
	readingReach(className, reading) {
		const value = this.normaliseReading(reading);
		if (value.streams.length === 0) return 0;

		const cacheKey = 'holds:' + className + ':' + JSON.stringify(value);
		const hit = this.instanceCache.get(cacheKey);
		if (hit !== undefined) return hit;

		const key = this.keyForName(className, '');
		const excludedKeys = {};
		for (const stream of value.streams) {
			excludedKeys[stream] = (value.excluded[stream] || [])
				.map((one) => this.keyForName(one, ''));
		}

		const held = (file, stream) => {
			const distance = this.reachDistance(file, key, stream);
			if (distance === null) return false;
			if (value.exact && distance !== 1) return false;
			return !excludedKeys[stream].some(
				(dropped) => this.reachDistance(file, dropped, stream) !== null);
		};

		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.isTemplateFile(file)) continue;
			if (value.streams.some((stream) => held(file, stream))) count += 1;
		}
		this.instanceCache.set(cacheKey, count);
		return count;
	}

	/*
	 * What a class's base holds, and whether there is a base to open.
	 *
	 *   { file, count, reading, readable }
	 *
	 * The reading comes out of the **file**, not out of what the generator would
	 * write, because the two can differ: the stream switch, the exactness switch
	 * and the exclusions all live as a clause in the base and nowhere else — that
	 * is the design, so the line in the file *is* the setting. A base whose filter
	 * he has rewritten into something this cannot read falls back to the plain
	 * `is a` count with `readable` false, and the card says so rather than
	 * quietly reporting a number about a filter that is not there.
	 */
	classBaseHolds(className) {
		const path = this.basePathFor(className);
		const file = this.app.vault.getFileByPath(path);
		const found = file
			? this.readClassBaseReading(this.baseTexts.get(path) || '', className) : null;
		const reading = found
			? found.reading : this.normaliseReading({ streams: [BASE_STREAMS[0].id] });

		return {
			file: file,
			reading: reading,
			readable: !!found,
			count: this.readingReach(className, reading),
		};
	}

	/*
	 * The same answer as a sentence, for the badge's tooltip. It names the stream
	 * whenever the base is not reading the ordinary one, because "14" over a base
	 * about component fields is a different fact from "14" over a base about
	 * instances, and nothing else on the card would say which.
	 */
	classBaseHoldsSaid(className, holds) {
		if (!holds.file) {
			return 'Holds ' + holds.count + (holds.count === 1 ? ' note' : ' notes')
				+ ' by ' + BASE_STREAMS[0].label + ' ' + className + '.\n'
				+ (this.settings.createBases
					? 'No base for it yet — Update creates one.'
					: 'Generated bases are off in settings, so there is none to open.');
		}

		const notes = holds.count === 0
			? 'Holds nothing yet' : 'Holds ' + holds.count
				+ (holds.count === 1 ? ' note' : ' notes');
		const streams = holds.reading.streams
			.map((stream) => this.baseStreamOf(stream).label + ' ' + className)
			.join(' or ');
		const how = holds.reading.exact ? ', named directly only' : '';

		if (!holds.readable) {
			return notes + ' by ' + streams + how + '.\nIts filter is not one of mine, '
				+ 'so this counts the plain reading rather than what you wrote.';
		}
		return notes + ' — ' + streams + how + '. Click to open it.';
	}

	/* The same number as something a row can say. */
	streamReachSaid(className, stream) {
		const count = this.streamReach(className, stream);
		if (count === 0) return 'nothing reaches ' + className + ' this way';
		return count + (count === 1 ? ' note' : ' notes');
	}

	/*
	 * A reading in the one shape everything below passes around, with the streams
	 * in `BASE_STREAMS` order and each exclusion list sorted and de-duplicated.
	 *
	 * Normalised on the way in and on the way out, so that two readings holding
	 * the same thing are equal to `readingsEqual` and identical bytes on disk.
	 * That is what lets a view whose reading has come back to the base's be
	 * recognised and have its clause removed, rather than rewritten into a clause
	 * that says nothing.
	 */
	normaliseReading(reading) {
		const source = reading || {};
		const value = { streams: [], exact: !!source.exact, excluded: {} };
		const wanted = new Set(source.streams || []);
		for (const stream of BASE_STREAMS) {
			if (!wanted.has(stream.id)) continue;
			value.streams.push(stream.id);
			const names = ((source.excluded || {})[stream.id] || [])
				.map((one) => String(one === null || one === undefined ? '' : one).trim())
				.filter((one) => one);
			value.excluded[stream.id] = Array.from(new Set(names))
				.sort((a, b) => a.localeCompare(b));
		}
		return value;
	}

	readingsEqual(a, b) {
		const one = this.normaliseReading(a);
		const two = this.normaliseReading(b);
		if (one.exact !== two.exact) return false;
		if (one.streams.join(' ') !== two.streams.join(' ')) return false;
		for (const stream of one.streams) {
			if ((one.excluded[stream] || []).join(' ')
				!== (two.excluded[stream] || []).join(' ')) return false;
		}
		return true;
	}

	/*
	 * The clause a reading is written as - **one entry of the list it sits in**,
	 * however many lines that entry takes.
	 *
	 * That invariant is what keeps this line surgery in everything but name: the
	 * reading is found as one entry and replaced as one entry, so his own clauses
	 * beside it, his views, his sorts and his formulas come out byte-identical.
	 * It is the discipline the single line had, generalised from a line to a
	 * clause - which is the smallest generalisation that can hold an `or`.
	 */
	readingClauseLines(name, reading, indent) {
		const value = this.normaliseReading(reading);
		const pad = (n) => new Array(n + 1).join(' ');

		const streamLines = (stream, at) => {
			const term = this.baseFilterExpression(name, value.exact, stream);
			const excluded = value.excluded[stream] || [];
			if (excluded.length === 0) return [pad(at) + '- ' + term];

			const lines = [pad(at) + '- and:', pad(at + 4) + '- ' + term];
			for (const one of excluded) {
				lines.push(pad(at + 4) + '- '
					+ yamlSingleQuoted(this.baseExcludeExpression(one, stream)));
			}
			return lines;
		};

		if (value.streams.length === 0) return [];
		if (value.streams.length === 1) return streamLines(value.streams[0], indent);

		const lines = [pad(indent) + '- or:'];
		for (const stream of value.streams) {
			for (const line of streamLines(stream, indent + 4)) lines.push(line);
		}
		return lines;
	}

	/*
	 * The `filters:` block at the top of a base - the lines the base's own
	 * reading may live in, and nothing below them.
	 *
	 * Scoped deliberately, and it was not scoped before. A *view* can carry the
	 * very same expression as its own narrowing clause, so a search over the whole
	 * file would read one of those as the base's reading the moment his top-level
	 * clause had been edited - and then flip a view's line while announcing it had
	 * changed what the base is about. The base's reading is a top-level key or it
	 * is not there.
	 */
	topLevelFiltersRange(lines) {
		let start = -1;
		for (let i = 0; i < lines.length; i += 1) {
			if (/^filters\s*:/.test(lines[i])) { start = i; break; }
		}
		if (start === -1) return null;

		let end = lines.length;
		for (let i = start + 1; i < lines.length; i += 1) {
			if (!lines[i].trim()) continue;
			if (/^\s/.test(lines[i])) continue;
			end = i;
			break;
		}
		return { start: start, end: end };
	}

	/*
	 * One entry of a YAML list, read as a node: a scalar, or a group keyed
	 * `and:` / `or:` / `not:` holding entries of its own.
	 *
	 * Hand-read rather than handed to `parseYaml`, for the reason every read of a
	 * `.base` in this plugin is hand-read: the answer has to carry the lines it
	 * came from, or writing it back is a re-emission of the whole file and
	 * whatever the emitter does not happen to know about is lost.
	 */
	readClauseNode(lines, start, stop) {
		const head = /^(\s*)-(?:\s+(.*?))?\s*$/.exec(lines[start] || '');
		if (!head) return null;
		const indent = head[1].length;
		const rest = head[2] || '';

		const group = /^(and|or|not)\s*:\s*$/.exec(rest);
		if (!group) {
			let text = rest;
			let quote = '';
			const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
			if (quoted) { quote = quoted[1]; text = quoted[2]; }
			return {
				kind: 'scalar', start: start, stop: stop, indent: indent,
				text: text, quote: quote,
			};
		}

		/*
		 * Where this group's dashes sit is decided by its first one and every later
		 * one must match it, so a dash nested one level further in can never be
		 * mistaken for a sibling.
		 */
		let dash = -1;
		const starts = [];
		for (let i = start + 1; i < stop; i += 1) {
			if (!lines[i].trim()) continue;
			if (/^(\s*)/.exec(lines[i])[1].length <= indent) break;
			const marker = /^(\s*)-(\s|$)/.exec(lines[i]);
			if (!marker) continue;
			if (dash === -1) dash = marker[1].length;
			if (marker[1].length === dash) starts.push(i);
		}

		const children = [];
		for (let n = 0; n < starts.length; n += 1) {
			const end = n + 1 < starts.length ? starts[n + 1] : stop;
			const child = this.readClauseNode(lines, starts[n], end);
			if (!child) return null;
			children.push(child);
		}
		return {
			kind: group[1], start: start, stop: stop, indent: indent,
			children: children,
		};
	}

	/* The class one of our exclusion clauses names, or null. */
	excludedClassIn(text, stream) {
		if (typeof text !== 'string') return null;
		const prefix = '!file.' + this.baseStreamOf(stream).fn + '("';
		if (!text.startsWith(prefix) || !text.endsWith('")')) return null;
		const name = text.slice(prefix.length, text.length - 2);
		return name && name.indexOf('"') === -1 ? name : null;
	}

	/*
	 * The reading a clause says, or null when it says something else - which is
	 * the answer for every filter he has written himself.
	 *
	 * Everything here is compared as **exact text** against expressions this
	 * plugin generates, never by a pattern over anything that mentions the class.
	 * A base is his from the moment it is created and his filter can be anything;
	 * a fuzzy match would rewrite a clause he wrote. Nothing recognised means the
	 * menu says so and changes nothing - the posture Bases Sharing takes towards
	 * a filter it cannot reach.
	 */
	matchReadingNode(node, name) {
		if (!node) return null;

		const oneStream = (entry) => {
			if (entry.kind === 'scalar') {
				for (const stream of BASE_STREAMS) {
					for (const exact of [false, true]) {
						if (entry.text !== this.baseFilterExpression(name, exact, stream.id)) continue;
						return { stream: stream.id, exact: exact, excluded: [] };
					}
				}
				return null;
			}
			if (entry.kind !== 'and' || entry.children.length < 2) return null;

			const head = oneStream(entry.children[0]);
			if (!head || head.excluded.length > 0) return null;

			const excluded = [];
			for (let i = 1; i < entry.children.length; i += 1) {
				const child = entry.children[i];
				if (child.kind !== 'scalar') return null;
				const found = this.excludedClassIn(child.text, head.stream);
				if (!found) return null;
				excluded.push(found);
			}
			return { stream: head.stream, exact: head.exact, excluded: excluded };
		};

		const parts = node.kind === 'or' ? node.children : [node];
		/* An `or:` of one is not something this writes, so it is not read either. */
		if (node.kind === 'or' && parts.length < 2) return null;

		const reading = { streams: [], exact: false, excluded: {} };
		const seen = new Set();
		for (let i = 0; i < parts.length; i += 1) {
			const one = oneStream(parts[i]);
			if (!one) return null;
			if (seen.has(one.stream)) return null;
			/* One switch across the streams: two branches disagreeing is not ours. */
			if (i > 0 && one.exact !== reading.exact) return null;
			seen.add(one.stream);
			reading.streams.push(one.stream);
			reading.exact = one.exact;
			reading.excluded[one.stream] = one.excluded;
		}
		return this.normaliseReading(reading);
	}

	/*
	 * Every entry of a list inside `[from, to)`, as `{start, stop, indent}`,
	 * **outermost first**.
	 *
	 * Outermost first is what makes a multi-stream reading legible at all: an
	 * `or:` whose children are themselves readings would otherwise be found as
	 * its first branch, and the base would be reported as holding one stream when
	 * it holds three - and then flipped to one.
	 */
	clauseEntriesIn(lines, from, to) {
		const entries = [];
		for (let i = from; i < to; i += 1) {
			const marker = /^(\s*)-(\s|$)/.exec(lines[i] || '');
			if (!marker) continue;
			const indent = marker[1].length;
			let stop = to;
			for (let j = i + 1; j < to; j += 1) {
				if (!lines[j].trim()) continue;
				if (/^(\s*)/.exec(lines[j])[1].length > indent) continue;
				stop = j;
				break;
			}
			entries.push({ start: i, stop: stop, indent: indent });
		}
		entries.sort((a, b) => (a.indent - b.indent) || (a.start - b.start));
		return entries;
	}

	/*
	 * The first entry of a list that says a reading of ours, or null.
	 *
	 * **A group this refuses takes its children down with it**, and that guard is
	 * the whole of the outermost-first rule rather than an optimisation of it. The
	 * first version only sorted the entries and was caught by its own tests: given
	 * an `or:` of two branches disagreeing about exactness - a shape this never
	 * writes - it rejected the `or:` and then happily claimed its first branch, so
	 * a filter of his would have been reported as a plain `is a` base and the next
	 * flip would have rewritten one line out of the middle of his expression.
	 *
	 * If the group is not ours, nothing inside it is a clause; it is a piece of
	 * something he wrote.
	 */
	findReadingIn(lines, from, to, name) {
		const refused = [];
		for (const entry of this.clauseEntriesIn(lines, from, to)) {
			if (refused.some((range) => entry.start >= range.start && entry.start < range.stop)) {
				continue;
			}
			const node = this.readClauseNode(lines, entry.start, entry.stop);
			const reading = this.matchReadingNode(node, name);
			if (!reading) {
				if (node && node.kind !== 'scalar') refused.push(entry);
				continue;
			}
			return {
				lines: lines, start: entry.start, stop: entry.stop, indent: entry.indent,
				node: node, reading: reading,
			};
		}
		return null;
	}

	/* Where the base's own reading is, and what it says. */
	readClassBaseReading(text, name) {
		const lines = String(text === null || text === undefined ? '' : text).split('\n');
		const range = this.topLevelFiltersRange(lines);
		if (!range) return null;
		return this.findReadingIn(lines, range.start, range.end, name);
	}

	/*
	 * Lay a reading back into the entry it was read from.
	 *
	 * A single scalar keeps whatever quoting it arrived with, so a base whose one
	 * line he happened to quote comes back quoted and the file is byte-identical
	 * everywhere the reading did not change.
	 */
	spliceReadingClause(lines, found, name, reading) {
		const block = this.readingClauseLines(name, reading, found.indent);
		if (block.length === 0) return null;

		if (block.length === 1 && found.node && found.node.kind === 'scalar' && found.node.quote) {
			const pad = new Array(found.indent + 1).join(' ');
			const term = block[0].slice(pad.length + 2);
			block[0] = pad + '- ' + found.node.quote + term + found.node.quote;
		}
		return lines.slice(0, found.start).concat(block, lines.slice(found.stop));
	}

	/* ----- exactness, one view at a time ------------------------------------ */

	/*
	 * *Exact matches only* used to be one switch over the whole base, and his ask
	 * (2026-09-05) is that it be one per **view**: a base with a Table, a
	 * Smart Goals and a graph is three readings of one set of notes, and there is
	 * no reason all three have to travel the same distance up the hierarchy.
	 *
	 * **The whole base keeps its switch and the views are narrowings under it.**
	 * That is not a compromise between two designs, it is what the file already
	 * says: the top-level `filters:` is what the base is *of*, a view's own
	 * `filters:` is what that view keeps of it, and Bases ands the two together.
	 * So a view is made exact by giving it `file.isADistance("X") == 1` of its
	 * own, and the base-wide switch stays exactly where it was - which is also
	 * why an old base needs no migrating.
	 *
	 * The consequence, stated because it is the one thing that surprises: with
	 * the whole base exact, a per-view switch has nothing left to narrow. Those
	 * items are drawn checked and disabled with the reason in the **label**,
	 * since a disabled Obsidian menu item swallows its own click and can say
	 * nothing of its own.
	 *
	 * **Still no stored state.** The clause in the view *is* the switch, the same
	 * way the top-level line is, so what the menu says and what the base does
	 * cannot drift - and a view whose filter he has rewritten is reported rather
	 * than guessed at, which is the posture every other write to a `.base` here
	 * takes.
	 */

	/*
	 * Every view in a base, as **lines** rather than as parsed YAML.
	 *
	 * Read by hand for the reason every write to a `.base` in this plugin is line
	 * surgery: the answer has to be somewhere to write, and a YAML round trip
	 * loses whatever the emitter does not happen to know about - his
	 * `columnSize`, his `graphOptions`, the order he put his keys in. `parseYaml`
	 * is still what `rememberBaseViews` uses, because *listing* views loses
	 * nothing.
	 */
	baseViewBlocks(text) {
		const lines = String(text === null || text === undefined ? '' : text).split('\n');

		let viewsAt = -1;
		for (let i = 0; i < lines.length; i += 1) {
			if (/^views\s*:\s*$/.test(lines[i])) { viewsAt = i; break; }
		}
		if (viewsAt === -1) return { lines: lines, views: [] };

		let end = lines.length;
		for (let i = viewsAt + 1; i < lines.length; i += 1) {
			if (!lines[i].trim()) continue;
			if (/^\s/.test(lines[i])) continue;
			end = i;
			break;
		}

		/*
		 * Where this list's dashes sit is decided by the first one and every later
		 * one must match it, so a dash nested inside a view - an `order:` entry, a
		 * filter clause - can never be mistaken for a view of its own.
		 */
		let dash = -1;
		const starts = [];
		for (let i = viewsAt + 1; i < end; i += 1) {
			const marker = /^(\s*)-(\s|$)/.exec(lines[i]);
			if (!marker) continue;
			if (dash === -1) dash = marker[1].length;
			if (marker[1].length === dash) starts.push(i);
		}

		const views = [];
		for (let n = 0; n < starts.length; n += 1) {
			const stop = n + 1 < starts.length ? starts[n + 1] : end;
			views.push(this.readBaseViewBlock(lines, starts[n], stop, dash, n));
		}
		return { lines: lines, views: views };
	}

	/*
	 * One view's lines. The first line of a block carries its first key after the
	 * `- `, so it is read as a key sitting at the same column as the rest.
	 */
	readBaseViewBlock(lines, start, stop, dash, index) {
		const keyIndent = dash + 2;

		const keyAt = (i) => {
			const text = lines[i];
			if (!text || !text.trim()) return null;
			const parts = i === start
				? /^(\s*-\s+)([A-Za-z_][^:]*):(.*)$/.exec(text)
				: /^(\s*)([A-Za-z_][^:]*):(.*)$/.exec(text);
			if (!parts) return null;
			if (parts[1].length !== keyIndent) return null;
			return { key: parts[2].trim(), value: parts[3].trim() };
		};

		const view = {
			index: index, start: start, stop: stop, dash: dash, keyIndent: keyIndent,
			name: '', nameLine: -1, filters: null,
		};

		for (let i = start; i < stop; i += 1) {
			const entry = keyAt(i);
			if (!entry) continue;
			if (entry.key === 'name' && view.nameLine === -1) {
				view.nameLine = i;
				view.name = unquoteScalar(entry.value);
			} else if (entry.key === 'filters' && !view.filters) {
				view.filters = this.readViewFilters(lines, i, stop, keyIndent, entry.value);
			}
		}
		return view;
	}

	/*
	 * A view's own `filters:`, in the three shapes it can take.
	 *
	 *   and     `and:` with a list under it - the one we can add a clause to
	 *   group   `or:` or `not:` - adding a clause there changes what his filter
	 *           means, so it is refused and said out loud
	 *   scalar  one expression written on the key's own line, same reason
	 */
	readViewFilters(lines, line, stop, keyIndent, inline) {
		const filters = {
			line: line, kind: 'scalar', andLine: -1, clauses: [], clauseIndent: keyIndent + 4,
			keys: 0, end: line + 1,
		};
		if (inline) return filters;

		let end = stop;
		for (let i = line + 1; i < stop; i += 1) {
			if (!lines[i].trim()) continue;
			const indent = /^(\s*)/.exec(lines[i])[1].length;
			if (indent > keyIndent) continue;
			end = i;
			break;
		}
		filters.end = end;

		/* An empty `filters:` is a key with nothing under it - nothing to add to. */
		if (end === line + 1) { filters.kind = 'empty'; return filters; }

		filters.kind = 'group';
		for (let i = line + 1; i < end; i += 1) {
			const parts = /^(\s*)([A-Za-z_][^:]*):(.*)$/.exec(lines[i]);
			if (!parts || parts[1].length !== keyIndent + 2) continue;
			filters.keys += 1;
			if (parts[2].trim() === 'and' && !parts[3].trim() && filters.andLine === -1) {
				filters.andLine = i;
			}
		}
		if (filters.andLine === -1) return filters;

		filters.kind = 'and';
		for (let i = filters.andLine + 1; i < end; i += 1) {
			if (!lines[i].trim()) continue;
			const marker = /^(\s*)-(\s|$)/.exec(lines[i]);
			if (!marker) continue;
			if (marker[1].length <= keyIndent + 2) break;
			if (filters.clauses.length === 0) filters.clauseIndent = marker[1].length;
			if (marker[1].length === filters.clauseIndent) filters.clauses.push(i);
		}
		return filters;
	}

	/*
	 * The reading one view carries as its own narrowing clause, or null.
	 *
	 * The same machinery the base's own reading is read with, pointed at the
	 * view's `and:` list instead of the top-level one - which is the whole reason
	 * a view can now say everything the base can. Both streams and both
	 * exactnesses are looked for rather than only the reading the base is
	 * currently in, because that is what lets `setClassBaseReading` carry a
	 * view's narrowing across a change of stream instead of stranding it.
	 */
	findViewReadingClause(lines, view, name) {
		if (!view || !view.filters || view.filters.kind !== 'and') return null;

		return this.findReadingIn(lines, view.filters.andLine + 1, view.filters.end, name);
	}

	/*
	 * What the menu needs to know about one view: its name, the reading it
	 * carries of its own, and - when it carries none - whether it could.
	 */
	baseViewReadings(text, name) {
		const parsed = this.baseViewBlocks(text);
		return parsed.views.map((view) => {
			const clause = this.findViewReadingClause(parsed.lines, view, name);
			const kind = view.filters ? view.filters.kind : 'none';
			let reason = '';
			if (!clause) {
				if (kind === 'group') reason = 'its filter is not an "and"';
				else if (kind === 'scalar') reason = 'its filter is one written-out expression';
			}
			return {
				index: view.index,
				name: view.name || 'Untitled view ' + (view.index + 1),
				named: !!view.name,
				reading: clause ? clause.reading : null,
				exact: !!(clause && clause.reading.exact),
				reachable: !reason,
				reason: reason,
			};
		});
	}

	/*
	 * Add, replace or remove one view's narrowing clause. Every other line of the
	 * file - his views, his sorts, his own filter clauses, the base's own
	 * reading - comes out byte-identical, which is the discipline the base-wide
	 * switch has always had.
	 *
	 * `reading` of null means *this view says nothing of its own* and takes the
	 * block back down with it: a `filters:` left holding an empty `and:` is a
	 * shape Obsidian did not write and would only have to be tidied later, so a
	 * clause that was the only one takes its `and:` and its `filters:` away too -
	 * and the file comes out identical to one no switch had ever been thrown on.
	 */
	rewriteViewReading(text, name, viewIndex, reading) {
		const parsed = this.baseViewBlocks(text);
		const view = parsed.views[viewIndex];
		if (!view) return { text: text, changed: false, reason: 'that view is no longer there' };

		const lines = parsed.lines;
		const clause = this.findViewReadingClause(lines, view, name);
		const wanted = reading ? this.normaliseReading(reading) : null;

		if (wanted && wanted.streams.length === 0) {
			return {
				text: text, changed: false,
				reason: 'a view has to keep at least one stream on, or it holds nothing',
			};
		}

		if (!wanted) {
			if (!clause) return { text: text, changed: false, reason: '' };
			const drop = new Set();
			for (let i = clause.start; i < clause.stop; i += 1) drop.add(i);
			if (view.filters.clauses.length === 1) {
				drop.add(view.filters.andLine);
				if (view.filters.keys === 1) drop.add(view.filters.line);
			}
			return {
				text: lines.filter((line, i) => !drop.has(i)).join('\n'),
				changed: true, reason: '',
			};
		}

		/* Already narrowed: lay the new reading into the entry the old one had. */
		if (clause) {
			if (this.readingsEqual(clause.reading, wanted)) {
				return { text: text, changed: false, reason: '' };
			}
			const next = this.spliceReadingClause(lines, clause, name, wanted);
			return { text: next.join('\n'), changed: true, reason: '' };
		}

		const kind = view.filters ? view.filters.kind : 'none';
		if (kind === 'group') {
			return {
				text: text, changed: false,
				reason: 'its filter is not an "and", so a clause cannot be added to it '
					+ 'without changing what it means',
			};
		}
		if (kind === 'scalar') {
			return {
				text: text, changed: false,
				reason: 'its filter is one written-out expression rather than a list of '
					+ 'clauses',
			};
		}

		if (kind === 'and') {
			const indent = view.filters.clauses.length > 0
				? view.filters.clauseIndent
				: view.keyIndent + 4;
			/*
			 * First among his clauses, where the base's own reading sits in the
			 * top-level block: what the view is *about* reads before what it then
			 * keeps out.
			 */
			const block = this.readingClauseLines(name, wanted, indent);
			lines.splice(view.filters.andLine + 1, 0, ...block);
			return { text: lines.join('\n'), changed: true, reason: '' };
		}

		/*
		 * No `filters:` at all, or one with nothing under it. A fresh block goes
		 * after `name:` - which is where Obsidian's own writer puts it, so a view
		 * it later rewrites comes back looking the same.
		 */
		const pad = (n) => new Array(n + 1).join(' ');
		const at = view.nameLine !== -1 ? view.nameLine + 1 : view.start + 1;
		const inner = this.readingClauseLines(name, wanted, view.keyIndent + 4);
		const block = kind === 'empty'
			? [pad(view.keyIndent + 2) + 'and:'].concat(inner)
			: [pad(view.keyIndent) + 'filters:', pad(view.keyIndent + 2) + 'and:'].concat(inner);
		lines.splice(kind === 'empty' ? view.filters.line + 1 : at, 0, ...block);
		return { text: lines.join('\n'), changed: true, reason: '' };
	}

	/*
	 * Throw one view's switch. The reason a refusal carries is handed back rather
	 * than swallowed, so the notice can say which view and why.
	 */
	async setViewReading(file, name, viewIndex, reading) {
		let reason = '';
		const rewrite = (text) => {
			const result = this.rewriteViewReading(text, name, viewIndex, reading);
			reason = result.reason;
			return result.text;
		};

		if (typeof this.app.vault.process === 'function') {
			await this.app.vault.process(file, rewrite);
			return reason;
		}
		const text = await this.app.vault.read(file);
		const next = rewrite(text);
		if (next !== text) await this.app.vault.modify(file, next);
		return reason;
	}

	/*
	 * What a view can still say once the base has been changed under it.
	 *
	 * A view can only ever **narrow** - Bases ands the top-level `filters:` with
	 * each view's own - so a stream the base has turned off says nothing in a
	 * view, and a clause no note can satisfy empties that view in silence. That
	 * is the exact failure the stream switch was built to cure, so the views are
	 * carried rather than left behind: a view keeps the streams that survive, and
	 * a view left with none goes back to following the base.
	 */
	restrictViewReading(view, base) {
		const one = this.normaliseReading(view);
		const two = this.normaliseReading(base);
		const survived = one.streams.filter((stream) => two.streams.indexOf(stream) !== -1);
		const streams = survived.length > 0 ? survived : two.streams.slice();
		const value = { streams: streams, exact: one.exact, excluded: {}, stranded: survived.length === 0 };
		for (const stream of streams) {
			value.excluded[stream] = (one.excluded[stream] || []).slice();
		}
		const kept = this.normaliseReading(value);
		kept.stranded = survived.length === 0;
		return kept;
	}

	/*
	 * Write a whole reading into the base. One clause changes; every other line -
	 * his views, his sorts, the columns he added, his own filter clauses - comes
	 * out byte-identical. Same line surgery Bases Sharing does to a `.base`, and
	 * for the same reason: parsing a file and re-emitting it loses whatever the
	 * emitter does not happen to know about.
	 *
	 * The views are carried with it, and the count of those that moved is handed
	 * back, because the edit is larger than the item it was asked of and a change
	 * he did not ask for is one to be told about rather than to discover.
	 */
	async setClassBaseReading(file, name, reading) {
		const wanted = this.normaliseReading(reading);
		let carried = 0;

		const rewrite = (text) => {
			const found = this.readClassBaseReading(text, name);
			if (!found) return text;
			if (wanted.streams.length === 0) return text;

			carried = 0;
			let next = text;
			if (!this.readingsEqual(found.reading, wanted)) {
				const lines = this.spliceReadingClause(found.lines, found, name, wanted);
				if (!lines) return text;
				next = lines.join('\n');
			}

			/*
			 * Backwards, so that rewriting one view cannot move the lines of a view
			 * this loop has not reached yet.
			 */
			const views = this.baseViewReadings(next, name);
			for (let i = views.length - 1; i >= 0; i -= 1) {
				if (!views[i].reading) continue;
				const kept = this.restrictViewReading(views[i].reading, wanted);
				/*
				 * A view that has come back to saying exactly what the base says, and
				 * only because every stream of its own is gone, has nothing left to
				 * narrow - so its clause goes rather than standing there restating the
				 * line above it. A clause that is merely redundant (the base has been
				 * made exact under a view that was already exact) is left alone, or
				 * un-exacting the base later would find his per-view choice thrown away.
				 */
				const settled = (kept.stranded && this.readingsEqual(kept, wanted)) ? null : kept;
				if (settled && this.readingsEqual(views[i].reading, settled)) continue;
				const result = this.rewriteViewReading(next, name, i, settled);
				if (result.changed) carried += 1;
				next = result.text;
			}
			return next;
		};

		if (typeof this.app.vault.process === 'function') {
			await this.app.vault.process(file, rewrite);
			return carried;
		}
		const text = await this.app.vault.read(file);
		const next = rewrite(text);
		if (next !== text) await this.app.vault.modify(file, next);
		return carried;
	}

	/*
	 * `setBaseReading` is the last of these, and four methods that used to sit
	 * under it are gone (2026-09-05): `findViewExactClause`, `rewriteViewExact`,
	 * `setViewExact` and `viewIsExact`, which spoke about a view's narrowing as
	 * though exactness were the only thing it could say.
	 *
	 * **Their contract stopped being expressible the day a view could carry a
	 * reading of its own**, and the sweep over his real bases is what proved it:
	 * turning exactness *off* removed the whole clause, so a view narrowed to one
	 * stream with two classes excluded lost all of it. There is no fixing the
	 * signature either - deciding whether what is left "says anything" needs the
	 * **base's** reading, and none of them took it. They were dead in production
	 * by then (the card and the menu both go through `setViewReading`), so what
	 * they really were is a loaded gun with the old contract written on the side.
	 */
	/* The two-switch call the reset still speaks in. */
	async setBaseReading(file, name, exact, stream) {
		return this.setClassBaseReading(file, name, { streams: [stream], exact: exact });
	}


	/*
	 * Rebuild one base from its class, now, with the diff in front of it and a
	 * typed code behind that.
	 *
	 * Two things about it are deliberate. **The reading survives**: if the base is
	 * on *exact matches only*, so is the rebuilt one, and the modal says so.
	 * Everything else about the file is generated afresh, but which notes it is
	 * about is the one thing a reset is not being asked to change. And **an
	 * unapplied draft is announced rather than ignored**: `baseContentFor` reads
	 * drafts like everything else here, so a class with pending panel edits builds
	 * a base for what it is about to become, and that is worth knowing before
	 * pressing the button rather than after.
	 */
	async resetClassBase(name, file) {
		const objects = this.scanClasses();
		const drafts = this.allDrafts(objects);

		if (!drafts.has(name)) {
			new Notice('OOF Class Manager: there is no class called "' + name + '" any more.', 6000);
			return;
		}

		const before = await this.app.vault.read(file);
		const found = this.readClassBaseReading(before, name);
		const reading = found ? found.reading : null;
		const after = this.baseContentFor(name, objects, drafts, reading);

		if (after === before) {
			new Notice('OOF Class Manager: ' + file.path + ' is already exactly what "' + name
				+ '" would generate. Nothing to reset.', 6000);
			return;
		}

		const lines = [
			file.path + ' is rebuilt from scratch, exactly as the plugin would generate '
				+ 'it from "' + name + '" today.',
			'Any views, sorts, group-bys and filters you added are lost. Nothing else '
				+ 'keeps a copy of them.',
		];
		if (reading && !this.readingsEqual(reading, { streams: ['is a'], exact: false })) {
			lines.push('The reading stays as it is - ' + this.describeReading(name, reading)
				+ '. Which notes the base is about is the one thing a reset keeps.');
		}
		/*
		 * The base-wide reading survives a reset; a per-view narrowing cannot,
		 * because the view it was written on does not. Said in its own line rather
		 * than left inside "any views you added are lost", since that line reads as
		 * being about views he built and these are readings he set.
		 */
		const narrowed = this.baseViewReadings(before, name).filter((view) => view.reading);
		if (narrowed.length > 0) {
			lines.push(andList(narrowed.map((view) => '"' + view.name + '"'))
				+ (narrowed.length === 1 ? ' reads' : ' read')
				+ ' more narrowly than the base does. That goes with the views: the '
				+ 'rebuilt base has one view, and it is the base-wide reading that a '
				+ 'reset keeps.');
		}
		if (this.drafts.has(name)) {
			lines.push('"' + name + '" has edits in the panel that Update has not applied '
				+ 'yet. The base is built from those, so it will show what the class is '
				+ 'about to become rather than what its note currently says.');
		}

		new ConfirmCodeModal(this.app, {
			title: 'Reset the base for "' + name + '"?',
			lines: lines,
			diff: { before: before.split('\n'), after: after.split('\n') },
			confirmText: 'Reset the base',
			onConfirm: async () => {
				await this.app.vault.modify(file, after);
				new Notice('OOF Class Manager: rebuilt ' + file.path + ' from "' + name + '".', 5000);
			},
		}).open();
	}

	/* ----- painting it ------------------------------------------------------ */

	queueBaseToolbars(force) {
		if (force) this.baseToolbarForce = true;
		if (this.baseToolbarTimer) window.clearTimeout(this.baseToolbarTimer);
		this.baseToolbarTimer = window.setTimeout(() => {
			this.baseToolbarTimer = null;
			const forced = !!this.baseToolbarForce;
			this.baseToolbarForce = false;
			this.renderBaseToolbars(forced);
		}, 0);
	}

	clearBaseToolbars(root) {
		const scope = root || document;
		for (const el of Array.from(scope.querySelectorAll('.oof-class-base-item'))) {
			el.remove();
		}
		for (const el of Array.from(scope.querySelectorAll('.bases-toolbar[data-oof-base]'))) {
			delete el.dataset.oofBase;
		}
	}

	/*
	 * The file a leaf is showing, by path. `view.file` is the direct answer and is
	 * missing on a leaf Obsidian has not loaded yet, so the view state - which
	 * every leaf carries, deferred or not - is what fills in.
	 */
	leafFilePath(leaf) {
		const view = leaf && leaf.view;
		if (view && view.file instanceof TFile) return view.file.path;
		if (!leaf || typeof leaf.getViewState !== 'function') return '';
		const state = leaf.getViewState();
		const path = state && state.state && state.state.file;
		return typeof path === 'string' ? path : '';
	}

	renderBaseToolbars(force) {
		const found = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf && leaf.view;
			const container = view && view.containerEl;
			if (!container) return;
			const toolbar = container.querySelector('.bases-toolbar');
			if (!toolbar) return;
			found.push({ toolbar: toolbar, path: this.leafFilePath(leaf) });
		});

		/* No base open anywhere: not a walk over the vault's classes worth taking. */
		if (found.length === 0) return;

		/*
		 * A base view mutates constantly as its rows render, and the observer that
		 * catches its toolbar being rebuilt sees every one of those. Without this
		 * every scrolled row would cost a scan of the vault. The signature lives on
		 * the toolbar element, so a rebuilt toolbar arrives without it and is
		 * repainted; a *renamed class* would not be noticed, which is why the events
		 * that can change what a class is called pass `force`.
		 */
		if (!force && found.every((entry) => entry.toolbar.dataset.oofBase === entry.path)) {
			return;
		}

		const on = this.settings.createBases && this.settings.classBaseToolbar;
		const drafts = on ? this.allDrafts(this.scanClasses()) : new Map();

		for (const entry of found) {
			const file = entry.path ? this.app.vault.getFileByPath(entry.path) : null;
			const name = on ? this.classForBase(file, drafts) : null;
			this.paintBaseToolbar(entry.toolbar, name, file);
			entry.toolbar.dataset.oofBase = entry.path;
			/* Only a toolbar that carries a button of ours is worth watching. */
			if (name) this.watchBaseToolbar(entry.toolbar);
		}
	}

	/*
	 * Obsidian's own markup for a toolbar button, as of 1.13.7: a
	 * `.bases-toolbar-item` holding a `.text-icon-button` of an icon span and a
	 * label span. Built by hand rather than borrowed, because the class that
	 * builds them is internal - but built to that shape exactly, so the toolbar's
	 * own rule hiding labels in a narrow pane reaches ours as well.
	 */
	paintBaseToolbar(toolbar, name, file) {
		const existing = toolbar.querySelector(':scope > .oof-class-base-item');

		if (!name || !(file instanceof TFile)) {
			if (existing) existing.remove();
			return;
		}

		if (existing && existing.dataset.oofClass === name) return;
		if (existing) existing.remove();

		const item = createDiv({ cls: 'bases-toolbar-item oof-class-base-item' });
		item.dataset.oofClass = name;
		const button = item.createDiv({ cls: 'text-icon-button', attr: { tabindex: '0' } });
		const icon = button.createSpan({ cls: 'text-button-icon' });
		if (typeof setIcon === 'function') setIcon(icon, 'boxes');
		button.createSpan({ cls: 'text-button-label', text: 'Class base' });

		/*
		 * Both of these are async and nothing awaits them, so each needs its own
		 * catch or a throw inside one becomes an unhandled rejection with no notice
		 * and no menu.
		 */
		const open = (event) => {
			event.preventDefault();
			this.openClassBaseMenu(button, name, file).catch((error) => {
				console.error('oof-classes: the Class base menu failed', error);
				new Notice('OOF Class Manager: the Class base menu failed — see the console.', 8000);
			});
		};
		button.addEventListener('click', open);
		button.addEventListener('keydown', (event) => {
			if (event.isComposing || event.defaultPrevented) return;
			if (event.key !== 'Enter' && event.key !== ' ') return;
			open(event);
		});

		/*
		 * Beside Filter and Properties, which is where he asked for it. After
		 * Properties rather than at the end, because the end of that row belongs to
		 * the new-item button and putting ours past it would read as part of it.
		 * Each fallback is one step further out, so a class renamed in a later
		 * Obsidian costs the position rather than the button.
		 */
		const after = toolbar.querySelector(':scope > .bases-toolbar-properties-menu')
			|| toolbar.querySelector(':scope > .bases-toolbar-filter-menu')
			|| toolbar.querySelector(':scope > .bases-toolbar-sort-menu');
		const before = toolbar.querySelector(':scope > .bases-toolbar-new-item-menu');

		if (after) after.insertAdjacentElement('afterend', item);
		else if (before) toolbar.insertBefore(item, before);
		else toolbar.appendChild(item);
	}

	/*
	 * One observer per toolbar, so a toolbar Obsidian rebuilds gets the button
	 * back. Same idea as `watchProperties`, aimed one level tighter: the
	 * **header** rather than the whole view, because a base view mutates on every
	 * row it renders and the header does not. It is the toolbar's parent that is
	 * watched, not the toolbar, since the thing to catch is the toolbar itself
	 * being replaced.
	 *
	 * There is deliberately **no is-this-us guard**. A mutation record arrives as
	 * a microtask, by which time any synchronous "I am painting" flag has already
	 * been cleared - so such a flag never suppresses anything, and writing one
	 * would only look like protection. What actually stops the loop is the
	 * signature in `renderBaseToolbars`: the pass our own painting provokes finds
	 * nothing stale and returns.
	 */
	watchBaseToolbar(toolbar) {
		if (!this.baseToolbarObservers) this.baseToolbarObservers = new WeakMap();
		const watched = toolbar.parentElement || toolbar;
		if (this.baseToolbarObservers.has(watched)) return;

		const observer = new MutationObserver(() => this.queueBaseToolbars());
		observer.observe(watched, { childList: true, subtree: true });
		this.baseToolbarObservers.set(watched, observer);
		this.register(() => observer.disconnect());
	}

	/*
	 * ── the reading, as menu items ──────────────────────────────────────────
	 *
	 * **One builder, two ways in** - the rule this plugin's class menu already
	 * lives by. The three streams, their exclusions and *exact matches only* are
	 * drawn by `addReadingItems`, and both the Class base button (for the whole
	 * base) and Obsidian's own Configure view menu (for one view) call it. Two
	 * copies of these controls would be two places to add the next stream to, and
	 * the one I forgot would be the one he opened.
	 *
	 * Which surface a scope is drawn on is his N.B., and it is not only a
	 * preference - it is what makes the depth work. Streams carry a list of
	 * classes, so a per-view stream reached from the Class base button would be
	 * *Class base → Views → this view → is a → Effort*, five levels. Reached from
	 * the view's own menu, where the view is already named by where you are
	 * standing, it is three.
	 */
	describeReading(name, reading) {
		const value = this.normaliseReading(reading);
		if (value.streams.length === 0) return 'nothing';

		const said = value.streams.map((stream) => {
			const excluded = value.excluded[stream] || [];
			const head = stream === 'has a'
				? (value.exact
					? 'notes whose own component fields name ' + name
					: 'notes reaching ' + name + ' through a component field')
				: stream === 'type of'
					? (value.exact
						? 'classes whose own "type of" names ' + name
						: 'every class that is a type of ' + name + ', ' + name + ' included')
					: (value.exact
						? 'notes whose own "is a" names ' + name
						: 'notes that are ' + article(name) + ' ' + name);
			return excluded.length === 0
				? head
				: head + ' (except ' + andList(excluded.slice()) + ')';
		});
		return andList(said);
	}

	/*
	 * Which classes a stream can be asked to drop, and which of them are already
	 * gone because something above them is.
	 *
	 * A class is dropped by the class *above* it as well as by itself, because
	 * `!file.isA("Effort")` removes everything under Effort too - his "this is how
	 * it works anyways". So a row whose ancestor is excluded is drawn ticked-off
	 * and disabled, with the ancestor named: it is not a state he can leave from
	 * that row, and a control that silently does nothing is worse than one that
	 * says why.
	 */
	exclusionRows(name, drafts, excluded) {
		const rows = this.excludableClasses(name, drafts);
		const byName = new Map(rows.map((row) => [row.name, row.parents]));
		const gone = new Set(excluded || []);

		const blockedBy = (from) => {
			const seen = new Set();
			const stack = (byName.get(from) || []).slice();
			while (stack.length > 0) {
				const parent = stack.pop();
				if (parent === name || seen.has(parent)) continue;
				seen.add(parent);
				if (gone.has(parent)) return parent;
				for (const above of byName.get(parent) || []) stack.push(above);
			}
			return null;
		};

		const under = (from) => {
			const below = new Set();
			const stack = [from];
			while (stack.length > 0) {
				const one = stack.pop();
				for (const row of rows) {
					if (below.has(row.name) || row.name === from) continue;
					if ((row.parents || []).indexOf(one) === -1) continue;
					below.add(row.name);
					stack.push(row.name);
				}
			}
			return below;
		};

		return rows.map((row) => ({
			name: row.name,
			depth: row.depth,
			excluded: gone.has(row.name),
			blockedBy: gone.has(row.name) ? null : blockedBy(row.name),
			below: under(row.name),
		}));
	}

	/*
	 * One stream's submenu: whether it is on, the two quick answers, and then the
	 * classes it can be asked to drop.
	 */
	fillStreamSubmenu(sub, ctx, stream) {
		const reading = this.normaliseReading(ctx.reading);
		const on = reading.streams.indexOf(stream.id) !== -1;
		const excluded = (reading.excluded[stream.id] || []).slice();

		const withStreams = (streams) => this.normaliseReading({
			streams: streams, exact: reading.exact, excluded: reading.excluded,
		});
		const withExcluded = (names) => {
			const next = { streams: reading.streams.slice(), exact: reading.exact, excluded: {} };
			for (const one of reading.streams) next.excluded[one] = (reading.excluded[one] || []).slice();
			next.excluded[stream.id] = names;
			return this.normaliseReading(next);
		};

		sub.addItem((entry) => {
			entry.setTitle(on ? 'On for this ' + ctx.scopeWord : 'Off for this ' + ctx.scopeWord)
				.setIcon(on ? 'toggle-right' : 'toggle-left')
				.onClick(() => {
					const streams = new Set(reading.streams);
					if (on) {
						/*
						 * The last one on cannot be turned off. A reading with no streams is
						 * not "a base about nothing" - it is a clause this plugin can no
						 * longer read, and the only way back would be the reset.
						 */
						if (streams.size === 1) {
							new Notice('OOF Class Manager: at least one stream has to stay on, or '
								+ 'the base holds nothing at all. Turn another one on first.', 7000);
							return;
						}
						streams.delete(stream.id);
					} else if (this.settings.oneStreamAtATime) {
						streams.clear();
						streams.add(stream.id);
					} else {
						streams.add(stream.id);
					}
					ctx.apply(withStreams(Array.from(streams)));
				});
			if (typeof entry.setChecked === 'function') entry.setChecked(on);
		});

		if (!on) return;
		if (typeof sub.addSeparator === 'function') sub.addSeparator();

		const rows = this.exclusionRows(ctx.name, ctx.drafts, excluded);
		const direct = rows.filter((row) => row.depth === 0).map((row) => row.name);

		sub.addItem((entry) => {
			entry.setTitle('Include every class').setIcon('check-check');
			if (excluded.length === 0) {
				if (typeof entry.setDisabled === 'function') entry.setDisabled(true);
				return;
			}
			entry.onClick(() => ctx.apply(withExcluded([])));
		});

		sub.addItem((entry) => {
			entry.setTitle('Exclude every subclass').setIcon('x-octagon');
			const already = direct.length > 0 && direct.every((one) => excluded.indexOf(one) !== -1);
			if (direct.length === 0 || already) {
				if (typeof entry.setDisabled === 'function') entry.setDisabled(true);
				return;
			}
			entry.onClick(() => ctx.apply(withExcluded(direct.slice())));
		});

		if (rows.length === 0) {
			sub.addItem((entry) => {
				entry.setTitle('Nothing below ' + ctx.name + ' to exclude');
				if (typeof entry.setDisabled === 'function') entry.setDisabled(true);
			});
			return;
		}

		if (typeof sub.addSeparator === 'function') sub.addSeparator();

		for (const row of rows) {
			sub.addItem((entry) => {
				const indent = new Array(row.depth + 1).join(' ');
				const included = !row.excluded && !row.blockedBy;
				entry.setTitle(row.blockedBy
					? indent + row.name + '  —  excluded with ' + row.blockedBy
					: indent + row.name)
					.setIcon(included ? 'check' : 'minus');
				if (typeof entry.setChecked === 'function') entry.setChecked(included);

				if (row.blockedBy) {
					if (typeof entry.setDisabled === 'function') entry.setDisabled(true);
					return;
				}
				entry.onClick(() => {
					if (row.excluded) {
						ctx.apply(withExcluded(excluded.filter((one) => one !== row.name)));
						return;
					}
					/*
					 * Only the topmost class of an excluded branch is written: anything
					 * already listed below this one is now said by this one, so it comes
					 * back off the list rather than being written twice.
					 */
					const kept = excluded.filter((one) => !row.below.has(one));
					kept.push(row.name);
					ctx.apply(withExcluded(kept));
				});
			});
		}
	}

	/* The four items a reading is: three streams, and how far each travels. */
	addReadingItems(menu, ctx) {
		const reading = this.normaliseReading(ctx.reading);
		const on = new Set(reading.streams);
		const offered = ctx.offered || BASE_STREAMS.map((stream) => stream.id);

		for (const stream of BASE_STREAMS) {
			menu.addItem((item) => {
				const allowed = offered.indexOf(stream.id) !== -1;
				const excluded = reading.excluded[stream.id] || [];
				item.setIcon(stream.icon);

				/*
				 * **The row names the class**, because `has a` on its own reads as
				 * "has a *the note I am looking at*" - which is what he took it for,
				 * and is a different question entirely. `has a Goal` cannot be read
				 * that way.
				 */
				const named = stream.label + ' ' + ctx.name;

				if (!allowed) {
					/*
					 * A view can only ever narrow - Bases ands the top-level `filters:`
					 * with the view's own - so a stream the base has off says nothing
					 * here, and the label carries the reason because a disabled Obsidian
					 * menu item swallows its own click.
					 */
					item.setTitle(named + '  —  the base is not read this way');
					if (typeof item.setDisabled === 'function') item.setDisabled(true);
					return;
				}

				item.setTitle(named + '  —  ' + this.streamReachSaid(ctx.name, stream.id)
					+ (excluded.length > 0 ? ', ' + excluded.length + ' excluded' : ''));
				if (typeof item.setChecked === 'function') item.setChecked(on.has(stream.id));
				if (typeof item.setSubmenu !== 'function') return;
				this.fillStreamSubmenu(item.setSubmenu(), ctx, stream);
			});
		}

		menu.addItem((item) => {
			const governed = ctx.scope === 'view' && ctx.baseExact;
			item.setTitle(governed
				? 'Exact matches only  —  the whole base is exact'
				: 'Exact matches only')
				.setIcon('crosshair');
			if (typeof item.setChecked === 'function') {
				item.setChecked(reading.exact || !!ctx.baseExact);
			}
			if (governed) {
				if (typeof item.setDisabled === 'function') item.setDisabled(true);
				return;
			}
			item.onClick(() => ctx.apply(this.normaliseReading({
				streams: reading.streams, exact: !reading.exact, excluded: reading.excluded,
			})));
		});
	}

	/*
	 * What the button opens: what a class base is, in the base's own words, then
	 * the reading and the two things you can do to the file.
	 *
	 * Obsidian's own `Menu` rather than a popover of ours. A menu is the wrong
	 * shape for a paragraph and the right shape for everything else here - it
	 * positions itself, closes on Escape and on a click elsewhere, and looks like
	 * the app - so the paragraph goes in as a label item and is styled to wrap,
	 * rather than a second popup being written to hold it.
	 *
	 * The file is read first, because the reading is written in the file and
	 * nowhere else. There is no stored state for any of it: the clause *is* the
	 * setting, so what the menu says and what the base does cannot drift.
	 */
	async openClassBaseMenu(buttonEl, name, file) {
		if (typeof Menu !== 'function') {
			new Notice('OOF Class Manager: this Obsidian version does not expose Menu.', 6000);
			return;
		}

		/* Taken before the read, so the menu lands under the button either way. */
		const rect = buttonEl.getBoundingClientRect();

		let text = '';
		try {
			text = await this.app.vault.cachedRead(file);
		} catch (error) {
			console.error('oof-classes: could not read ' + file.path, error);
		}

		const objects = this.scanClasses();
		const drafts = this.allDrafts(objects);
		if (!drafts.has(name)) {
			new Notice('OOF Class Manager: there is no class called "' + name + '" any more.', 6000);
			return;
		}

		const columns = this.baseColumnsFor(name, objects, drafts);
		const found = this.readClassBaseReading(text, name);
		const reading = found ? found.reading : null;

		const said = [
			'Generated by OOF Class Manager for the class ' + name + ': one column per '
				+ 'characteristic ' + name + ' carries, and one row per note it reaches.',
			'It was created once and has been yours ever since - Update never rewrites '
				+ 'it. Resetting it from the class is the only thing that does, and that '
				+ 'is here.',
		];
		said.push(reading
			? 'Showing ' + this.describeReading(name, reading) + '.'
			: 'Its filter has been edited, so what it shows is yours rather than the '
				+ 'generated one.');

		if (reading) {
			const narrowed = this.baseViewReadings(text, name).filter((view) => view.reading);
			if (narrowed.length > 0) {
				said.push(andList(narrowed.map((view) => '"' + view.name + '"'))
					+ (narrowed.length === 1 ? ' reads' : ' read')
					+ ' more narrowly than the base does. A view is set from its own '
					+ 'Configure view menu, beside Rename and Duplicate.');
			}
		}
		said.push(columns.length > 0
			? 'Columns: file.name, ' + columns.join(', ') + '.'
			: 'Only file.name, since ' + name + ' has no characteristics yet.');

		const menu = new Menu();

		menu.addItem((item) => {
			if (typeof item.setIsLabel === 'function') item.setIsLabel(true);
			const box = createDiv({ cls: 'oof-class-base-explainer' });
			box.createDiv({ cls: 'oof-class-base-explainer-title', text: 'Class base' });
			for (const line of said) {
				box.createDiv({ cls: 'oof-class-base-explainer-line', text: line });
			}
			const fragment = document.createDocumentFragment();
			fragment.appendChild(box);
			item.setTitle(fragment);
		});

		if (typeof menu.addSeparator === 'function') menu.addSeparator();

		if (!reading) {
			menu.addItem((item) => {
				item.setTitle('The reading is not one of ours — reset to get it back')
					.setIcon('alert-triangle');
				if (typeof item.setDisabled === 'function') item.setDisabled(true);
			});
		} else {
			this.addReadingItems(menu, {
				scope: 'base', scopeWord: 'base', name: name, drafts: drafts,
				reading: reading,
				apply: async (next) => {
					try {
						const carried = await this.setClassBaseReading(file, name, next);
						new Notice('OOF Class Manager: ' + file.path + ' now shows '
							+ this.describeReading(name, next) + '.'
							+ (carried > 0
								? ' ' + carried + (carried === 1 ? ' view' : ' views')
									+ ' moved with it.'
								: ''), 6000);
					} catch (error) {
						console.error('oof-classes: writing the class base reading failed', error);
						new Notice('OOF Class Manager: that change was not written — see the '
							+ 'console.', 8000);
					}
				},
			});
		}

		if (typeof menu.addSeparator === 'function') menu.addSeparator();

		const classFile = drafts.get(name).file;
		if (classFile instanceof TFile) {
			menu.addItem((item) => item
				.setTitle('Open ' + name)
				.setIcon('file-text')
				.onClick(() => { this.app.workspace.getLeaf(false).openFile(classFile); }));
		}

		menu.addItem((item) => {
			item.setTitle('Reset from the class…')
				.setIcon('refresh-cw')
				.onClick(() => {
					this.resetClassBase(name, file).catch((error) => {
						console.error('oof-classes: the base reset failed', error);
						new Notice('OOF Class Manager: the base reset failed — see the console. '
							+ 'Nothing was written.', 8000);
					});
				});
			if (typeof item.setWarning === 'function') item.setWarning(true);
		});

		if (typeof menu.showAtPosition === 'function') {
			menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
		}
	}

	/* ----- the per-view half, on Obsidian's own Configure view card --------- */

	/*
	 * His N.B.: *these options will still belong to Class Bases, but they will
	 * live in the native view panel instead of the dedicated Class Bases panel.*
	 *
	 * So the reading of **one view** is set on Obsidian's own Configure view card,
	 * under its View name, Layout and the layout's own options - a **Class base**
	 * group of the same shape as the ones Obsidian draws there. The Class base
	 * button keeps only the reading of the **whole base**.
	 *
	 * **It began behind the card's ⋮ and he moved it onto the card** (2026-09-05,
	 * the same day): a menu is the right shape for a list of *actions* - set as
	 * default, duplicate, delete - and the wrong shape for a set of switches you
	 * are reading off against each other. Three streams and their exclusions are a
	 * state to look at, not a command to pick, and the card is where every other
	 * thing about a view is already looked at.
	 *
	 * **The exclusions gained by the move rather than merely surviving it.** In a
	 * menu they were a submenu per stream that closes the moment you touch one;
	 * on the card they are rows you throw one after another, indented by depth, and
	 * a class dropped by something above it is greyed in place rather than needing
	 * its reason written into a label.
	 *
	 * **A view can only narrow.** Bases ands the top-level `filters:` with each
	 * view's own, so a stream the base has off can never be turned on here - those
	 * rows are drawn disabled with the reason beside them. Widening lives on the
	 * Class base button because that is the only place it can live.
	 */

	/*
	 * The card lives in a `.menu` attached to `body`, not inside the base's leaf -
	 * checked, rather than assumed - so there is nothing of the base's to hang an
	 * observer on. `body`'s **direct children** are watched instead: menus,
	 * popovers and modals are appended there and nothing else is, so this fires a
	 * handful of times a session rather than on every row a base renders.
	 *
	 * A second observer then watches each menu itself, because the form arrives
	 * *inside* a menu that is already in the document, and is rebuilt from scratch
	 * every time the layout dropdown changes - `display()` empties it.
	 *
	 * **Every menu is watched, not only the ones already holding a form**, and
	 * that is the whole of a bug he reported: the views popover opens on its
	 * *list* of views, so the menu is appended with no form in it; clicking the
	 * chevron beside a view then replaces the page **inside** that element, which
	 * is no mutation of `body` at all. So nothing fired, and the card appeared
	 * only when something else was appended to `body` - which is what pressing the
	 * card's own ⋮ does. It looked like the ⋮ summoning it.
	 *
	 * Watching a menu that never holds a form costs nothing: a menu is a handful
	 * of nodes, and the paint it provokes returns at the signature.
	 */
	registerViewConfigCard() {
		this.viewCardMenus = new WeakSet();

		const scan = () => {
			for (const menu of Array.from(document.querySelectorAll('.menu'))) {
				this.watchViewConfigMenu(menu);
			}
			this.queueViewConfigCards();
		};

		const observer = new MutationObserver(scan);
		observer.observe(document.body, { childList: true });
		this.register(() => observer.disconnect());
		scan();
	}

	watchViewConfigMenu(menu) {
		if (!this.viewCardMenus || this.viewCardMenus.has(menu)) return;
		this.viewCardMenus.add(menu);
		const observer = new MutationObserver(() => this.queueViewConfigCards());
		observer.observe(menu, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
	}

	/*
	 * Coalesced into one frame. **No is-this-us flag**: a mutation record arrives
	 * as a microtask, by which time a synchronous "I am painting" flag has already
	 * been cleared, so such a flag never suppresses anything. What stops the loop
	 * is the signature stamped on the form - the pass our own painting provokes
	 * finds nothing stale and returns.
	 */
	queueViewConfigCards() {
		if (this.viewCardFrame) return;
		this.viewCardFrame = window.requestAnimationFrame(() => {
			this.viewCardFrame = null;
			for (const form of Array.from(document.querySelectorAll('.view-config-menu'))) {
				this.paintViewConfigCard(form).catch((error) => {
					console.error('oof-classes: painting the Class base card failed', error);
				});
			}
		});
	}

	/*
	 * The `.base` a views popover belongs to.
	 *
	 * The popover is on `body`, so there is no toolbar above it to read: the
	 * active leaf is the answer, and it stays the base's leaf while its own
	 * toolbar menu is open. A base drawn **inside a note** - a Dynamic Viewer
	 * band, a `![[X.base]]` - therefore answers nothing, which is the rule the
	 * Class base button itself already follows: that leaf is about the note, and
	 * aiming a write at a file you are not looking at is what the reset was moved
	 * out of the panel to stop.
	 */
	activeBaseFile() {
		const leaf = this.app.workspace.activeLeaf;
		const path = leaf ? this.leafFilePath(leaf) : '';
		const file = path ? this.app.vault.getFileByPath(path) : null;
		return file instanceof TFile && file.extension === 'base' ? file : null;
	}

	/*
	 * The view a config card is about, read off the **name field** - the first
	 * input on the card, which is what Obsidian fills with `view.name`. There is
	 * no route from that DOM back to the view object, and the selected view is not
	 * the answer either: the chevron beside any view in the list opens this card
	 * for that one. A name no view answers to means the card is mid-rename, and
	 * nothing is drawn until it settles.
	 */
	viewNameOnCard(form) {
		const input = form ? form.querySelector('input') : null;
		return input ? String(input.value || '').trim() : '';
	}

	async paintViewConfigCard(form) {
		if (!form || !form.isConnected) return;

		const clear = () => {
			const stale = form.querySelector(':scope > .oof-view-card');
			if (stale) stale.remove();
			delete form.dataset.oofView;
			delete form.dataset.oofBase;
		};

		if (!this.settings.createBases || !this.settings.classBaseToolbar) { clear(); return; }

		const viewName = this.viewNameOnCard(form);
		const file = this.activeBaseFile();
		if (!viewName || !file) { clear(); return; }

		/*
		 * The vault walk is the expensive half and **every** menu mutation reaches
		 * here now, so a card already right about this file, this view and this
		 * version of the file is answered before it. `mtime` is what makes the
		 * cheap key honest: our own write bumps it, and so does an edit made
		 * anywhere else, so a stale card cannot survive one.
		 */
		const cheap = file.path + '\u0000' + viewName + '\u0000' + (file.stat || {}).mtime;
		if (form.dataset.oofBase === cheap && form.querySelector(':scope > .oof-view-card')) {
			return;
		}

		const objects = this.scanClasses();
		const drafts = this.allDrafts(objects);
		const name = this.classForBase(file, drafts);
		if (!name) { clear(); return; }

		let text = '';
		try {
			text = await this.app.vault.cachedRead(file);
		} catch (error) {
			clear();
			return;
		}
		if (!form.isConnected) return;

		const found = this.readClassBaseReading(text, name);
		if (!found) { clear(); return; }

		const views = this.baseViewReadings(text, name);
		let view = null;
		for (const one of views) {
			if (one.name === viewName) { view = one; break; }
		}
		if (!view) { clear(); return; }

		const base = found.reading;
		/*
		 * **Both guards ask whether the card is still there**, and the second one
		 * did not until he found it. `display()` rebuilds the form from scratch
		 * whenever the layout dropdown changes - and `empty()` takes the children
		 * without taking the `data-` attributes, so a signature written before the
		 * rebuild still matched afterwards and the group never came back. A stamp
		 * on an element the app owns describes something that may already be gone;
		 * it has to be checked against the thing it claims to describe.
		 */
		const signature = JSON.stringify([file.path, name, view.index, view.name,
			base, view.reading, view.reachable, view.reason]);
		if (form.dataset.oofView === signature
			&& form.querySelector(':scope > .oof-view-card')) {
			return;
		}

		clear();
		form.dataset.oofView = signature;
		form.dataset.oofBase = cheap;

		const container = form.createDiv({ cls: 'input-group-container oof-view-card' });
		if (form.childElementCount > 1) container.createDiv({ cls: 'input-group-divider' });
		const header = container.createDiv({ cls: 'input-group' })
			.createDiv({ cls: 'input-group-header' });
		const chevron = header.createDiv({ cls: 'collapse-icon' });
		if (typeof setIcon === 'function') setIcon(chevron, 'right-triangle');
		header.createDiv({ cls: 'input-group-header-text', text: 'Class base' });
		const body = container.createDiv({ cls: 'input-group-content' });

		/*
		 * Open the first time and closed after that is a fold you have to discover;
		 * this one is remembered for the session on the plugin, so it behaves like
		 * Obsidian's own groups without a preference behind it - a control is not a
		 * preference.
		 */
		let collapsed = !!this.viewCardCollapsed;
		const fold = () => {
			chevron.toggleClass('is-collapsed', collapsed);
			body.toggleClass('is-hidden', collapsed);
			body.style.display = collapsed ? 'none' : '';
		};
		header.addEventListener('click', (event) => {
			event.preventDefault();
			collapsed = !collapsed;
			this.viewCardCollapsed = collapsed;
			fold();
		});
		fold();

		if (!view.reachable) {
			body.createDiv({
				cls: 'oof-view-card-note',
				text: 'This view cannot be narrowed — ' + view.reason + '.',
			});
			return;
		}

		this.drawReadingCard(body, {
			scope: 'view', scopeWord: 'view', name: name, drafts: drafts,
			/* With no clause of its own a view reads exactly as the base does. */
			reading: view.reading || base,
			baseReading: base,
			baseExact: base.exact,
			offered: base.streams.slice(),
			apply: async (next) => {
				try {
					/*
					 * A view saying exactly what the base says is a view that says
					 * nothing, so its clause comes back out rather than standing there
					 * restating the line above it.
					 */
					const settled = this.readingsEqual(next, base) ? null : next;
					const refused = await this.setViewReading(file, name, view.index, settled);
					if (refused) {
						new Notice('OOF Class Manager: "' + view.name + '" was left alone — '
							+ refused + '.', 8000);
					}
					/*
					 * Repainted from the file rather than from what was just asked for:
					 * a refusal leaves the card saying what the view really holds.
					 */
					delete form.dataset.oofView;
					delete form.dataset.oofBase;
					this.queueViewConfigCards();
				} catch (error) {
					console.error('oof-classes: writing the view reading failed', error);
					new Notice('OOF Class Manager: that change was not written — see the '
						+ 'console.', 8000);
				}
			},
		});
	}

	/*
	 * The reading as rows on a card, in Obsidian's own `.input-row` markup so the
	 * theme, the widths and the label rules are the card's rather than ours.
	 *
	 * Same shape as `addReadingItems` draws in a menu and deliberately so: three
	 * streams, the classes each one drops, and how far they travel.
	 */
	drawReadingCard(host, ctx) {
		const reading = this.normaliseReading(ctx.reading);
		const on = new Set(reading.streams);
		const offered = ctx.offered || BASE_STREAMS.map((stream) => stream.id);

		const row = (label, hint, depth) => {
			const el = host.createDiv({ cls: 'input-row oof-view-card-row' });
			if (depth) el.style.paddingInlineStart = (depth * 14) + 'px';
			const side = el.createDiv({ cls: 'input-row-label' });
			side.createDiv({ cls: 'oof-view-card-name', text: label });
			if (hint) side.createDiv({ cls: 'oof-view-card-hint', text: hint });
			return { el: el, content: el.createDiv({ cls: 'input-row-content' }) };
		};

		const toggle = (into, value, disabled, change) => {
			if (obsidian.ToggleComponent) {
				const control = new obsidian.ToggleComponent(into).setValue(value);
				if (disabled) control.setDisabled(true);
				else control.onChange(change);
				return;
			}
			const box = into.createEl('input', { type: 'checkbox' });
			box.checked = value;
			box.disabled = !!disabled;
			if (!disabled) box.addEventListener('change', () => change(box.checked));
		};

		const withStreams = (streams) => this.normaliseReading({
			streams: streams, exact: reading.exact, excluded: reading.excluded,
		});
		const withExcluded = (stream, names) => {
			const next = { streams: reading.streams.slice(), exact: reading.exact, excluded: {} };
			for (const one of reading.streams) {
				next.excluded[one] = (reading.excluded[one] || []).slice();
			}
			next.excluded[stream] = names;
			return this.normaliseReading(next);
		};

		for (const stream of BASE_STREAMS) {
			const allowed = offered.indexOf(stream.id) !== -1;
			const live = on.has(stream.id);
			const excluded = (reading.excluded[stream.id] || []).slice();

			/*
			 * The row names the class for the reason the menu does, and carries how
			 * many notes the stream reaches, so a road with nothing down it says so
			 * before it is taken rather than after.
			 */
			const line = row(stream.label + ' ' + ctx.name,
				allowed
					? this.streamReachSaid(ctx.name, stream.id)
						+ (excluded.length > 0
							? ', ' + excluded.length + (excluded.length === 1 ? ' class excluded' : ' classes excluded')
							: '')
					: 'the base is not read this way');
			line.el.addClass('oof-view-card-stream');
			toggle(line.content, live, !allowed, (value) => {
				const streams = new Set(reading.streams);
				if (!value) {
					/*
					 * The last one on cannot be turned off. A reading with no streams is
					 * not "a base about nothing" - it is a clause this plugin can no
					 * longer read, and the only way back would be the reset.
					 */
					if (streams.size === 1) {
						new Notice('OOF Class Manager: at least one stream has to stay on, or '
							+ 'the ' + ctx.scopeWord + ' holds nothing at all. Turn another one '
							+ 'on first.', 7000);
						this.queueViewConfigCards();
						return;
					}
					streams.delete(stream.id);
				} else if (this.settings.oneStreamAtATime) {
					streams.clear();
					streams.add(stream.id);
				} else {
					streams.add(stream.id);
				}
				ctx.apply(withStreams(Array.from(streams)));
			});

			if (!allowed || !live) continue;

			const rows = this.exclusionRows(ctx.name, ctx.drafts, excluded);
			if (rows.length === 0) continue;

			const direct = rows.filter((one) => one.depth === 0).map((one) => one.name);
			const actions = host.createDiv({ cls: 'oof-view-card-actions' });
			const all = actions.createEl('button', { text: 'Include every class' });
			all.disabled = excluded.length === 0;
			all.addEventListener('click', () => ctx.apply(withExcluded(stream.id, [])));
			const none = actions.createEl('button', { text: 'Exclude every subclass' });
			none.disabled = direct.length === 0
				|| direct.every((one) => excluded.indexOf(one) !== -1);
			none.addEventListener('click', () => ctx.apply(withExcluded(stream.id, direct.slice())));

			for (const one of rows) {
				const included = !one.excluded && !one.blockedBy;
				const entry = row(one.name,
					one.blockedBy ? 'excluded with ' + one.blockedBy : '', one.depth + 1);
				entry.el.addClass('oof-view-card-class');
				toggle(entry.content, included, !!one.blockedBy, (value) => {
					if (value) {
						ctx.apply(withExcluded(stream.id,
							excluded.filter((gone) => gone !== one.name)));
						return;
					}
					/*
					 * Only the topmost class of an excluded branch is written: anything
					 * already listed below this one is now said by this one, so it comes
					 * off the list rather than being written twice.
					 */
					const kept = excluded.filter((gone) => !one.below.has(gone));
					kept.push(one.name);
					ctx.apply(withExcluded(stream.id, kept));
				});
			}
		}

		const governed = ctx.scope === 'view' && ctx.baseExact;
		const exact = row('Exact matches only',
			governed ? 'the whole base is exact' : '');
		exact.el.addClass('oof-view-card-stream');
		toggle(exact.content, reading.exact || !!ctx.baseExact, governed, (value) => {
			ctx.apply(this.normaliseReading({
				streams: reading.streams, exact: value, excluded: reading.excluded,
			}));
		});
	}


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
		/*
		 * **Both lists.** This walked `characteristics` alone until 2026-09-04, and
		 * the consequence was exact: a component field he had typed into a class
		 * card had no note created for it, so the chip stayed grey for ever and the
		 * property had nothing behind it — no `possible values` to say which classes
		 * it takes, no defaults table, nothing. A component field *is* a
		 * characteristic; only the tag differs.
		 */
		const componentFields = this.componentFieldNames(drafts);
		/*
		 * And which classes are components, off the `#component` tag. Computed here
		 * from this pass's own `drafts` rather than read off the picture:
		 * `buildPlan` builds its own model, and a set that exists on one and not the
		 * other is exactly the defect that let every component value through as a
		 * conflict on 2026-09-04.
		 */
		const components = this.componentClasses(drafts);
		/*
		 * And the ones whose kind is in dispute, which this pass and the template
		 * pass both stand aside for — see `componentDisputes`.
		 */
		const disputed = this.componentDisputes(drafts, components);
		for (const [className, draft] of drafts) {
			for (const characteristic of (draft.characteristics || [])
				.concat(draft.componentFields || [])) {
				if (!characteristic) continue;
				if (!referencedBy.has(characteristic)) referencedBy.set(characteristic, []);
				if (referencedBy.get(characteristic).indexOf(className) === -1) {
					referencedBy.get(characteristic).push(className);
				}
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
			const isComponent = componentFields.has(name);
			const reason = isBase
				? 'A base characteristic, but it has no note of its own'
					+ (byClasses.length > 0 ? '; also listed by ' + byClasses.join(', ') : '') + '.'
				: 'Listed as a ' + (isComponent ? 'component field' : 'characteristic') + ' of '
					+ byClasses.join(', ') + ', but has no note of its own.';

			/*
			 * The tag is the only difference between the two kinds, so it is the
			 * only thing decided differently here — the note is otherwise created
			 * exactly as a characteristic is, which is his instruction verbatim.
			 */
			const tag = this.characteristicTagFor(name, componentFields);

			actions.push({
				kind: 'create-characteristic',
				label: 'Create ' + (isComponent ? 'component field' : 'characteristic')
					+ ' note "' + name + '"',
				path: this.characteristicPath(name),
				name: name,
				/* A base characteristic is a list of links; anything else is his to say. */
				propertyType: isBase ? 'list' : '',
				isBase: isBase,
				tag: tag,
				detail: [
					reason,
					isBase
						? 'Created with property type: list, since the base characteristics '
							+ 'hold links. Ready for a meaning.'
						: 'Created empty, ready for a meaning and a property type.',
				].concat(tag ? ['Tagged #' + tag + '.'] : []),
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

		/*
		 * 1a2. Links to the root that no longer need writing down.
		 *
		 * The whole point of a root class is that nothing mentions it, so an
		 * explicit `is a: "[[Obsidian Note]]"` is now clutter. Removing it loses
		 * nothing: the setting says exactly what the link said.
		 *
		 * This is the one place a *populated* property is rewritten rather than
		 * reported, and it is justified narrowly - the value being taken out is the
		 * value the setting puts back. Other entries in the same list are kept.
		 */
		for (const note of this.picture().notes.values()) {
			const rootNames = this.rootAbove(note.name);
			if (rootNames.length === 0) continue;

			for (const property of [this.settings.isAProperty, this.settings.inheritsProperty]) {
				const raw = toArray(note.frontmatter[property]);
				if (raw.length === 0) continue;

				const kept = raw.filter((entry) => {
					const name = linkName(entry);
					if (!name) return true;
					return !rootNames.some((root) =>
						String(this.canonicalName(name)).toLowerCase() === String(root).toLowerCase());
				});
				if (kept.length === raw.length) continue;

				actions.push({
					kind: 'strip-root-link',
					label: 'Remove the ' + property + ' link to "' + rootNames[0]
						+ '" from "' + note.name + '"',
					file: note.file,
					path: note.file.path,
					property: property,
					values: kept,
					detail: [
						'"' + rootNames[0] + '" is the root class, so every note is one '
							+ 'without saying so.',
						kept.length > 0
							? property + ' keeps ' + kept.join(', ') + '.'
							: property + ' is left empty — nothing is lost, the root still '
								+ 'applies.',
					],
				});
			}
		}

		/*
		 * 1a3. Dates that should have been filled in when the note was made.
		 *
		 * A characteristic whose default is `<% tp.date.now(...) %>` gets its value
		 * from Templater at creation - which does nothing for notes that already
		 * existed, or that predate the characteristic. Those carry an empty
		 * `created:` for ever unless something fills it.
		 *
		 * The value is the file's own creation time, never the current time: this
		 * is recovering a fact, not inventing one, and "now" would tell every old
		 * note it was made today. Only ever fills an EMPTY key - a date he has
		 * written himself is his, like every other value in this plugin.
		 */
		/*
		 * Every note, not only the instances - a class note is a note, and so is one
		 * that names no class at all. Templates and characteristics are outside the
		 * picture, which is right: a template must keep the expression itself.
		 */
		for (const instance of this.picture().notes.values()) {
			for (const key of Object.keys(instance.frontmatter)) {
				if (!isEmptyValue(instance.frontmatter[key])) continue;

				const characteristic = characteristics.get(key);
				if (!characteristic) continue;

				/*
				 * The vault-wide default, which is the table's *All notes* row. It was
				 * `characteristic.defaultValue` until that key was retired, and asking
				 * with no class named is the same question: what every note carrying
				 * this characteristic is created with.
				 */
				const resolved = this.defaultFor(characteristic, null, objects, drafts);
				const expression = resolved ? resolved.starting : '';
				if (isEmptyValue(expression)) continue;
				if (!isTemplaterExpression(expression)) continue;

				const type = String(characteristic.propertyType || '').toLowerCase();
				if (type !== 'date' && type !== 'datetime') continue;

				const stat = instance.file && instance.file.stat;
				if (!stat || !stat.ctime) continue;

				const value = formatMoment(new Date(stat.ctime),
					templaterDateFormat(expression));

				actions.push({
					kind: 'fill-datetime',
					label: 'Fill ' + key + ' on "' + instance.file.basename + '" — ' + value,
					file: instance.file,
					path: instance.file.path,
					property: key,
					value: value,
					detail: [
						key + ' is empty, and its characteristic fills it with '
							+ expression + ' when a note is made.',
						'This note already existed, so the value comes from the file itself: '
							+ 'created ' + value + '.',
					],
				});
			}
		}

		/*
		 * 1a4. Entries in `is a` / `type of` that say nothing the list does not
		 * already say.
		 *
		 * Three ways an entry can be redundant:
		 *
		 *   blank      a list item with nothing in it
		 *   repeated   the same class named twice
		 *   implied    `is a: [[Artist]], Person` where Artist is a type of Person,
		 *              so Person is already reached through Artist
		 *
		 * The last is the interesting one, and it is safe for the same narrow
		 * reason as the root links: what is removed is still true afterwards.
		 * `file.isA("Person")` keeps answering yes, through the entry that stays.
		 */
		for (const note of this.picture().notes.values()) {
			for (const property of [this.settings.isAProperty, this.settings.inheritsProperty]) {
				const raw = toArray(note.frontmatter[property]);
				if (raw.length < 2) continue;

				const entries = raw.map((entry) => {
					const name = linkName(entry);
					return { entry: entry, name: name ? this.canonicalName(name) : null };
				});

				const kept = [];
				const dropped = [];
				const seen = new Set();

				for (let i = 0; i < entries.length; i += 1) {
					const here = entries[i];

					if (!here.name) { dropped.push({ entry: here.entry, why: 'blank' }); continue; }
					if (seen.has(here.name.toLowerCase())) {
						dropped.push({ entry: here.entry, why: 'named twice', name: here.name });
						continue;
					}

					/*
					 * Implied by another entry — but only by one that is not itself
					 * implied by this one. Two classes that reach each other are a
					 * cycle, and removing either would be a guess about which.
					 */
					const by = entries.find((other) => {
						if (other === here || !other.name || other.name === here.name) return false;
						const reaches = this.ancestorsOf(other.name, objects, drafts);
						if (reaches.indexOf(here.name) === -1) return false;
						return this.ancestorsOf(here.name, objects, drafts).indexOf(other.name) === -1;
					});

					if (by) {
						dropped.push({ entry: here.entry, why: 'implied', name: here.name, by: by.name });
						continue;
					}

					seen.add(here.name.toLowerCase());
					kept.push(here.entry);
				}

				if (dropped.length === 0) continue;

				/*
				 * Three reasons to drop an entry, and they do not share a closing
				 * sentence. "keeps [[Project]], which says the same thing" was
				 * written for a *class* being dropped, where the point is that the
				 * entry left over still reaches it. Read underneath "Removed: an
				 * empty entry" it says Project is the redundant one — the exact
				 * opposite of what is happening, and the reading he got. An empty
				 * entry never said anything, so there is nothing for what is left
				 * to be saying instead: the honest line there is that nothing else
				 * changes.
				 */
				const blanks = dropped.filter((d) => d.why === 'blank').length;
				const onlyBlanks = blanks === dropped.length;

				/*
				 * The blanks are counted rather than listed: two of them produced
				 * the same sentence twice, which reads as two different faults.
				 */
				const said = [];
				if (blanks === 1) said.push('a list entry with nothing in it');
				else if (blanks > 1) said.push(blanks + ' list entries with nothing in them');
				for (const d of dropped) {
					if (d.why === 'blank') continue;
					if (d.why === 'named twice') said.push(d.name + ' is named twice');
					else {
						said.push(d.by + ' is already a ' + d.name
							+ ', so naming ' + d.name + ' as well says nothing new');
					}
				}

				actions.push({
					kind: 'strip-redundant-link',
					label: (onlyBlanks
						? 'Remove ' + (blanks === 1 ? 'the empty entry' : blanks + ' empty entries')
							+ ' from ' + property
						: 'Tidy ' + property)
						+ ' on "' + note.name + '"',
					file: note.file,
					path: note.file.path,
					property: property,
					values: kept,
					detail: [
						'Removed: ' + said.join('; ') + '.',
						kept.length === 0
							? 'The ' + property + ' list is left empty.'
							: onlyBlanks
								? 'Nothing else changes — the ' + property + ' list still says '
									+ kept.join(', ') + '.'
								: 'What is left — ' + kept.join(', ') + ' — still says '
									+ 'everything the list said.',
					],
				});
			}
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
			for (const action of this.orphanActions(objects)) actions.push(action);
			for (const action of this.unusedCharacteristicActions(characteristics, drafts)) {
				actions.push(action);
			}
		}

		/*
		 * 1c. the tag on every characteristic note.
		 *
		 * His ask, 2026-09-04: *"make it so that the class manager enforces the
		 * `#characteristic` tag to all characteristics and enforces the
		 * `#componentfield` tag to all components."* One tag each and never both,
		 * because the two kinds *are* the same thing besides the tag — so a note
		 * wearing both would be saying two things about itself, and neither of them
		 * decisively.
		 *
		 * **Which one is derived, not read.** A characteristic is a component field
		 * because some class lists it under `component fields`; the tag reports
		 * that. Reading the tag instead would make it a second declaration, free to
		 * disagree with the class that declares it — the `default value:` lesson
		 * again. So moving a characteristic from one list to the other swaps the
		 * tag on the next Update, without him touching the note.
		 *
		 * Over **every** characteristic note rather than only the ones some class
		 * lists, because "all characteristics" is what he said and a note nothing
		 * lists is still one. It runs after 1b so a note on its way to the trash is
		 * not tagged on the way there.
		 */
		const trashing = new Set(actions
			.filter((action) => action.kind === 'trash-characteristic' && action.file)
			.map((action) => action.file.path));

		for (const [name, characteristic] of characteristics) {
			if (!characteristic.file || trashing.has(characteristic.file.path)) continue;

			const wanted = this.characteristicTagFor(name, componentFields);
			if (!wanted) continue;
			if (this.hasTag(characteristic.file, wanted)) {
				/*
				 * Right tag on, wrong tag also on: still out of step. A note that
				 * has just moved between the two lists by hand looks exactly like
				 * this, and leaving the old tag would leave the vault searchable
				 * for a claim that is no longer true.
				 */
				const strays = this.characteristicTags().filter(
					(tag) => tag !== wanted && this.hasTag(characteristic.file, tag));
				if (strays.length === 0) continue;

				actions.push({
					kind: 'describe-characteristic',
					label: 'Untag ' + name + ' — ' + strays.map((t) => '#' + t).join(', '),
					file: characteristic.file,
					removeTags: strays,
					detail: [name + ' is a '
						+ (componentFields.has(name) ? 'component field' : 'characteristic')
						+ ' and is tagged #' + wanted + ' already, but still carries '
						+ andList(strays.map((t) => '#' + t)) + '.'],
				});
				continue;
			}

			const strays = this.characteristicTags().filter(
				(tag) => tag !== wanted && this.hasTag(characteristic.file, tag));
			const isComponent = componentFields.has(name);
			const byClasses = referencedBy.get(name) || [];

			actions.push({
				kind: 'describe-characteristic',
				label: 'Tag ' + name + ' #' + wanted
					+ (strays.length > 0 ? ' (was ' + strays.map((t) => '#' + t).join(', ') + ')' : ''),
				file: characteristic.file,
				addTag: wanted,
				removeTags: strays,
				detail: [
					isComponent
						? 'A component field: ' + (byClasses.length > 0
							? andList(byClasses) + ' list' + (byClasses.length === 1 ? 's' : '')
								+ ' it under ' + this.settings.componentsProperty + '.'
							: 'some class lists it under ' + this.settings.componentsProperty + '.')
						: 'An ordinary characteristic, so it carries #' + wanted + '.',
				].concat(strays.length > 0
					? [andList(strays.map((t) => '#' + t)) + ' is removed: a characteristic note '
						+ 'carries one of the two, never both.']
					: []),
			});
		}

		/*
		 * Keys nothing declares. Two questions are asked of them below, so both
		 * answers are worked out once, here, before any pass that consults them:
		 *
		 *   strandedWithValues  it holds a value on *some* note, so the empty
		 *                       copies are evidence and are not swept away
		 *   aggregated          it is on two notes or more, so it is one item
		 *                       rather than one per note
		 */
		const strandedWithValues = new Set();
		const aggregated = new Set();
		for (const [key, entry] of this.strandedProperties(characteristics)) {
			if (entry.files.length > entry.empty) strandedWithValues.add(key);
			if (entry.files.length >= 2) aggregated.add(key);
		}

		/*
		 * 1a-bis. a characteristic named where a class belongs. Reported rather
		 * than guessed at: which class he meant is not the plugin's to decide, and
		 * silently ignoring it would leave a parent that does nothing.
		 */
		for (const [name, klass] of objects) {
			if (!klass.file) continue;
			const strays = toArray(klass.values[this.settings.inheritsProperty] || [])
				.filter((parent) => this.looksLikeCharacteristic(parent));
			if (strays.length === 0) continue;
			conflicts.push({
				file: klass.file,
				property: this.settings.inheritsProperty,
				value: strays.join(', '),
				reason: andList(strays.map((n) => '"' + n + '"'))
					+ (strays.length === 1 ? ' is a characteristic' : ' are characteristics')
					+ ', not a class, so "' + name + '" cannot be a type of '
					+ (strays.length === 1 ? 'it' : 'them') + '. Move '
					+ (strays.length === 1 ? 'it' : 'them') + ' to the '
					+ this.settings.characteristicsProperty + ' list, or name a class '
					+ 'instead.',
			});
		}

		/*
		 * 1b-bis. characteristic notes he has renamed. **Before** every pass that
		 * would otherwise see the old key as belonging to nothing — the value has
		 * to move first, or the note is left with the old key reported as a
		 * conflict and the new one arriving empty beside it.
		 */
		for (const action of this.propertyRenameActions(characteristics, conflicts)) {
			actions.push(action);
		}

		/*
		 * 1b-ter. values he has renamed. Beside the pass above and for the same
		 * reason: a value nothing allows any more is reported by every pass below
		 * unless it moves first, and that report would be of a fault rather than
		 * of a rename already on its way.
		 */
		for (const action of this.valueRenameActions(characteristics)) {
			actions.push(action);
		}

		/*
		 * 1c. templates whose name does not match the class they declare. Not
		 * conditional on the trash-collection setting: nothing is removed here,
		 * and a template nothing can find is broken whatever he has that switch
		 * set to. Before the templates are written, so a misnamed one is put right
		 * rather than duplicated by the pass that generates the missing one.
		 */
		for (const action of this.misnamedTemplateActions(objects, components)) {
			if (action.insolvable) conflicts.push(action);
			else actions.push(action);
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

				const wantedTag = this.classTagFor(name, components);

				actions.push({
					kind: 'create-class',
					label: 'Create ' + (components.has(name) ? 'component' : 'class')
						+ ' note "' + name + '"',
					path: this.settings.notesFolder + '/' + name + '.md',
					name: name,
					values: wanted,
					write: this.settings.logicProperties.slice(),
					addTag: wantedTag,
					detail: [
						'Named as a class, but no note exists for it yet.',
						'Tagged #' + wantedTag + '.',
					].concat(components.has(name)
						? [this.componentReason(name, components)]
						: []).concat(declared.length > 0
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
			/*
			 * "Everything automatically is a root note" - class notes included, so
			 * the root is appended here too. Without it a class note carrying
			 * `created` was reported as unaccounted for while every ordinary note
			 * with the same property was fine.
			 */
			const ownClasses = (draft.values[this.settings.isAProperty] || [])
				.concat(this.rootAbove(name))
				.filter((className) => drafts.has(className));
			/*
			 * `carriedKeys` again: a class note is an ordinary note in this respect.
			 * If what it is a declares component fields, the class note carries them
			 * too, and filling one brings the rest.
			 */
			const inherited = this.carriedKeys(
				ownClasses, object.frontmatter, objects, drafts).keys;
			const seenInherited = new Set(inherited);

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
				(key) => isEmptyValue(object.frontmatter[key]) && !strandedWithValues.has(key));

			for (const key of unclaimed) {
				if (shedEmpty.includes(key)) continue;
				/* Gathered into one item instead; the same rule as for instances. */
				if (aggregated.has(key)) continue;
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
			/*
			 * A class note is laid out as the instance it is: the properties on it
			 * come from whatever its own `is a` names, not from what it declares
			 * for its instances.
			 */
			const canonical = this.canonicalOrder(managedAfter, characteristics,
				{ classes: ownClasses, objects: objects, drafts: drafts,
					frontmatter: object.frontmatter });

			/*
			 * `reorderFrontMatter` lays a note out as *everything unmanaged, then the
			 * managed keys in canonical order* — so an unmanaged key sitting after a
			 * managed one is out of place, and the properties view says so out loud:
			 * it heads each **run** of properties, so a native attribute stranded at
			 * the bottom produces a second *Native attributes* heading under the
			 * class's own.
			 *
			 * Only the symbol is checked, and deliberately. It is the plugin's own
			 * property — it landed at the end because `processFrontMatter` appends a
			 * new key and nothing then asked for a reorder, since `misordered` only
			 * ever compared the managed keys with each other. His fields are his, and
			 * shuffling those to tidy a heading is not something he asked for.
			 */
			const symbolKey = this.settings.symbolProperty;
			const firstManaged = keysAfter.findIndex(
				(key) => this.isManagedProperty(key, characteristics));
			const symbolAt = symbolKey ? keysAfter.indexOf(symbolKey) : -1;
			const symbolStranded = symbolAt !== -1 && firstManaged !== -1
				&& symbolAt > firstManaged;
			/*
			 * A symbol being **added** strands itself: `processFrontMatter` appends
			 * a new key, and the check above cannot see it, because at plan time the
			 * note does not carry it yet. Asking for the layout in the same action is
			 * what makes it land in place on this Update rather than on the next one
			 * — the mutation sets the key before `applyOrder` runs, so the reorder
			 * catches it.
			 */
			const symbolArriving = symbolAt === -1 && firstManaged !== -1;

			const misordered = !sameNameList(managedAfter, canonical) || symbolStranded;

			/*
			 * Every class says so with a tag, and which tag says which kind it is:
			 * `#class` for one you instantiate, `#component` for one you compose
			 * with. Exactly one of the two, never both — a note wearing both would
			 * be saying two things about itself and neither decisively, which is
			 * the same rule and the same shape as the characteristic notes'.
			 *
			 * The stray is taken off in the same action rather than in one of its
			 * own: a class that has just moved between the two kinds passes through
			 * no state carrying both, and the search for `#class` never returns a
			 * component even for an instant.
			 */
			/*
			 * A class in dispute keeps whatever tag it has: its kind is the thing
			 * being argued about, so claiming one in the meantime would be the
			 * plugin taking a side in a question it has just reported as his.
			 */
			const inDispute = disputed.has(name);
			const wantedTag = inDispute ? '' : this.classTagFor(name, components);
			const needsTag = !!wantedTag && !this.hasTag(object.file, wantedTag);
			const strayTags = wantedTag
				? this.classTags().filter(
					(tag) => tag !== wantedTag && this.hasTag(object.file, tag))
				: [];

			/*
			 * The symbol is an edit like any other, so it travels in the plan rather
			 * than being written the moment it is typed. Rename is the one thing
			 * here that happens straight away, and it has a reason: it moves files,
			 * and a pending rename would leave the panel showing a name the vault
			 * does not have. A symbol has neither problem.
			 */
			const symbolNow = (object.symbol || '');
			const symbolOwn = (draft && draft.symbol) || '';
			/*
			 * The panel's value if he has set one; otherwise whatever the chain says,
			 * written down. `symbolCopyFor` returns null when there is nothing due,
			 * which is every class he has not marked and whose ancestors carry
			 * nothing either.
			 */
			const symbolCopy = this.symbolCopyFor(name, symbolOwn, objects, drafts);
			const symbolWanted = symbolCopy ? symbolCopy.value : symbolOwn;
			const symbolChanged = !!this.settings.symbolProperty
				&& symbolWanted !== symbolNow;

			if (write.length > 0 || dropped.length > 0 || misordered || needsTag
				|| strayTags.length > 0
				|| shedEmpty.length > 0 || gained.length > 0 || symbolChanged) {
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
					described.push('#' + wantedTag);
					detail.push('Tagged #' + wantedTag + ' — this note is a '
						+ (components.has(name) ? 'component' : 'class') + ', and says so.'
						+ (components.has(name)
							? ' ' + this.componentReason(name, components) : ''));
				}
				if (strayTags.length > 0) {
					described.push(strayTags.map((tag) => '-#' + tag).join(', '));
					detail.push(andList(strayTags.map((tag) => '#' + tag))
						+ ' is removed: a class note carries one of #'
						+ this.classTags().join(' and #') + ', never both.');
				}

				if (symbolChanged) {
					described.push(symbolWanted ? 'symbol ' + symbolWanted : 'symbol removed');
					const from = symbolCopy
						? this.inheritedSymbolFor(name, objects, drafts).source : '';
					const why = !symbolCopy
						? (symbolWanted
							? '. Shown before ' + name + ' in the panel, and before its '
								+ 'section in the properties view — and inherited by every '
								+ 'class below it that has none of its own.'
							: '. Classes below it fall back to the nearest symbol above.')
						: (symbolCopy.reason === 'remove'
							? '. ' + name + ' was carrying a copy of an ancestor\'s symbol, '
								+ 'and that symbol is gone, so the copy goes with it.'
							: '. Inherited from ' + from + ' and written here, so '
								+ name + '\'s own note says what it is marked with. Change it '
								+ 'on ' + from + ' and this follows; change it here and it '
								+ 'becomes ' + name + '\'s own.');
					detail.push(this.settings.symbolProperty + ' — '
						+ (symbolNow ? symbolNow : 'empty') + '  →  '
						+ (symbolWanted ? symbolWanted : 'empty') + why);
				}

				if (misordered) {
					described.push('order');
					detail.push('Properties reordered by type then name: ' + canonical.join(', '));
					if (symbolStranded) {
						detail.push(symbolKey + ' moves up with the other native attributes — '
							+ 'it was written after them, which split them into two sections '
							+ 'in the properties view.');
					}
				}

				actions.push({
					kind: 'update-class',
					symbolProperty: symbolChanged ? this.settings.symbolProperty : null,
					symbol: symbolWanted,
					/*
					 * Whether this value is a copy of an ancestor's, so `applyAction`
					 * can record it. Only a recorded copy is ever updated or removed
					 * later; anything else is his.
					 */
					symbolCopied: !!symbolCopy && symbolCopy.reason !== 'remove',
					/* The class this acts on, by name — `applyAction` keys the record on it. */
					object: name,
					label: 'Update class "' + name + '" — ' + described.join(', '),
					file: object.file,
					values: wanted,
					write: write,
					remove: dropped.concat(shedEmpty),
					add: gained,
					missing: missing,
					addTag: needsTag ? wantedTag : null,
					removeTags: strayTags,
					/* Also when the symbol is arriving — see `symbolArriving`. */
					order: (misordered || (symbolChanged && symbolWanted && symbolArriving))
						? canonical : null,
					managed: managedAfter,
					detail: detail,
				});
			}
		}

		/* 3. one template per class, carrying the flattened characteristics */
		for (const [name, draft] of drafts) {
			const path = this.templatePathFor(name);
			const file = this.app.vault.getFileByPath(path);

			/*
			 * **A component has no template**, which is the whole of what his note
			 * asks for: *"Components will work the same as classes except that they
			 * won't have templates, which effectively means that they cannot be
			 * instantiated."* No template is the mechanism, not a side effect — it
			 * is what removes the button, what the `+ New` menu has nothing to make
			 * a note from, and what leaves `is a: "[[Project]]"` with no way to
			 * arise except by hand.
			 *
			 * One that already exists is trashed, and only one **we** generated:
			 * the same `is a` test `orphanActions` uses, so a template of his own
			 * that happens to sit under that name is left exactly where it is. It
			 * goes to the Obsidian trash, so a component that stops being one gets
			 * its template written again and the old one is still recoverable in
			 * the meantime.
			 */
			if (components.has(name)) {
				/*
				 * Its kind is in dispute, so its template is not the plugin's to
				 * destroy — he may settle it the other way, and a trashed file is a
				 * worse answer to that than a stale one.
				 */
				if (disputed.has(name)) continue;
				if (!(file instanceof TFile)) continue;

				const frontmatter = this.frontmatterOf(file) || {};
				const claims = toArray(frontmatter[this.settings.isAProperty])
					.map(linkName).filter(Boolean)
					.some((target) => String(target).toLowerCase() === name.toLowerCase());
				if (!claims) {
					conflicts.push({
						file: file,
						property: this.settings.isAProperty,
						value: frontmatter[this.settings.isAProperty],
						reason: name + ' is a component, so it has no template — but this '
							+ 'file does not say `' + this.settings.isAProperty + ': "[['
							+ name + ']]"`, so it was not generated here. Left untouched.',
					});
					continue;
				}

				actions.push({
					kind: 'trash-template',
					label: 'Trash the template for "' + name + '" — it is a component',
					file: file,
					path: path,
					detail: [
						this.componentReason(name, components),
						'A component is never instantiated, so it has no template. Without '
							+ 'one there is nothing to make a note from, which is what makes '
							+ 'that true rather than merely discouraged.',
						'It goes to the Obsidian trash, so it can be brought back.',
					],
				});
				continue;
			}

			const current = file instanceof TFile ? this.frontmatterOf(file) : null;
			/*
			 * The component *fields* belong in a template, empty — they are what a
			 * new note is asked to fill in. What filling one leads to does not,
			 * because nothing has been filled in yet: a template is the shape of an
			 * instance before any of its components have been chosen.
			 *
			 * The template's own frontmatter is passed all the same, so a template
			 * he has given a standing component value — `type: [[Effort]]` on
			 * `Sub Goal Template.md` — carries what that brings, the same as any
			 * other note. Ordinarily it is empty and this changes nothing.
			 */
			const expected = this.carriedKeys([name], current, objects, drafts).keys;

			/*
			 * A base characteristic belongs in a template only when it is being
			 * given a value. For an instance template that is `is a`, and
			 * nothing else: a new note is not a class, so `characteristics` and
			 * `type of` would be blank, and blank base characteristics are not
			 * written. The ordinary characteristics follow, empty, ready to fill.
			 */
			/*
			 * The root's own template does not write `is a`. A note made from it is
			 * a root note without saying so - that is the whole setting - so the
			 * line would be exactly the clutter it exists to remove. Every other
			 * template still needs its `is a`: that is what tells a new note which
			 * class it belongs to.
			 */
			/*
			 * The root's template carries `is a` too, empty. It has nothing to point
			 * at — a note made from it is a root note without saying so, which is
			 * the whole setting — but the key is still written, so every note in
			 * the vault has the property and the panel shows the same shape
			 * everywhere. His call, and the right one: an absent property and an
			 * empty one look nothing alike in the properties view.
			 */
			const emptyIsA = this.isRootClass(name);
			/*
			 * With *All notes carry the base characteristics* on, the template
			 * writes them too — otherwise every note made from one would be born
			 * out of step and Update would immediately add them again.
			 */
			const templateBase = this.settings.allNotesCarryBase
				? this.baseCharacteristics(characteristics).filter(
					(key) => key !== this.settings.isAProperty)
				: [];

			const wantedKeys = this.canonicalOrder(
				[this.settings.isAProperty]
					.concat(templateBase)
					.concat(expected.filter((c) => c !== this.settings.isAProperty
						&& templateBase.indexOf(c) === -1)),
				characteristics,
				{ classes: [name], objects: objects, drafts: drafts,
					frontmatter: current });

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
			/*
			 * A key gathered into one discrepancy elsewhere is not a stray here
			 * either — it is the same question, and a template holding it is one
			 * more note the rename will carry. Reporting it again added ten items
			 * about `lifespan` on top of the one that can actually be answered.
			 */
			const strayEmpty = stray.filter((key) => isEmptyValue(current[key])
				&& !strandedWithValues.has(key));
			const strayFilled = stray.filter((key) => !isEmptyValue(current[key])
				&& !aggregated.has(key));

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

			/*
			 * What the `is a` line should say: the class, or nothing at all for the
			 * root. Comparing it against the class name unconditionally would make
			 * the root's template differ from itself for ever — wanting empty,
			 * finding empty, and asking whether the empty one names the class.
			 */
			const isASettled = emptyIsA
				? (!current || isEmptyValue(current[this.settings.isAProperty]))
				: toArray(current && current[this.settings.isAProperty]).map(linkName)[0] === name;

			/*
			 * A characteristic may say what a template should put in it. A template
			 * whose value disagrees is out of step exactly the way a missing key is,
			 * so it is compared here rather than only written on the way past.
			 */
			/*
			 * And it may say something different for *this* class: a row in its
			 * defaults table naming the class, or naming something the class
			 * descends from. `defaultFor` does that walk; the class's own row wins
			 * over its parent's, and the *All notes* row is the fallback.
			 */
			const defaults = {};
			const defaultSources = {};
			for (const property of wantedKeys) {
				const characteristic = characteristics.get(property);
				const resolved = this.defaultFor(characteristic, name, objects, drafts);
				const fallback = this.defaultWriteValue(characteristic, resolved);
				if (!isEmptyValue(fallback)) {
					defaults[property] = fallback;
					defaultSources[property] = resolved ? resolved.source : '';
				}
			}
			const defaultsSettled = !current || Object.keys(defaults).every(
				(property) => sameDefaultValue(current[property], defaults[property]));

			if (currentKeys && sameNameList(wantedKeys, currentKeys)
				&& strayEmpty.length === 0 && isASettled && defaultsSettled) {
				continue;
			}

			const detail = [
				emptyIsA
					/* No article before the name: "a Obsidian Note" was the first try. */
					? 'Gives a new note the properties ' + name + ' carries. `'
						+ this.settings.isAProperty + '` is written empty: ' + name
						+ ' is the root class, so a new note is one without saying so — '
						+ 'but the property is there to fill in with something narrower.'
					: 'Gives a new ' + name + ' every property an instance of it carries.',
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
			for (const property of Object.keys(defaults)) {
				const source = defaultSources[property];
				detail.push(property + ' — filled with '
					+ toArray(defaults[property]).join(', ')
					+ (source
						? ', from the ' + source + ' row of its defaults table.'
						: ', from its characteristic note.'));
			}

			actions.push({
				kind: 'write-template',
				label: (file ? 'Rewrite' : 'Create') + ' template for "' + name + '"',
				path: path,
				file: file instanceof TFile ? file : null,
				object: name,
				properties: wantedKeys,
				/* The root's `is a` is written, but with nothing in it. */
				emptyIsA: emptyIsA,
				defaults: defaults,
				/* What apply() is allowed to clear before laying the properties out. */
				managed: Array.from(characteristics.keys()).concat(wantedKeys),
				/* Keys that belong to nothing, and are empty, so nothing is lost. */
				remove: strayEmpty,
				types: expected.map((c) => (characteristics.get(c) || {}).propertyType || ''),
				detail: detail,
			});
		}

		/*
		 * 3a-ii. the Templater block that names a new note after the moment it was
		 * made, in every class template.
		 *
		 * The class templates only. `Characteristic Template.md` is not one of them
		 * and must never be given this: a characteristic's file name *is* the
		 * property it defines (`∘ domain` → `domain`), so a timestamp there would
		 * cut every characteristic loose from its own property. It carries its own
		 * prefix rename instead, which this leaves alone — the loop below only ever
		 * looks at paths `templatePathFor()` produced.
		 *
		 * A template that has not been read yet is skipped rather than guessed at:
		 * a missing action is safe, a wrong one is not. The same reasoning as the
		 * orphan bases.
		 */
		{
			const wanted = String(this.settings.uniqueNameFormat || '').trim();
			for (const name of drafts.keys()) {
				/*
				 * A component's template is on its way to the trash in the pass
				 * above, and editing a file in the same Update that removes it is
				 * two actions arguing about one file.
				 */
				if (components.has(name)) continue;
				const path = this.templatePathFor(name);
				const file = this.app.vault.getFileByPath(path);
				if (!(file instanceof TFile)) continue;

				const entry = this.renameEntryFor(path);
				if (!entry) continue;

				if (!wanted) {
					if (!entry.has) continue;
					actions.push({
						kind: 'write-rename-block',
						label: 'Remove the naming block from the template for "' + name + '"',
						file: file,
						path: path,
						object: name,
						format: '',
						detail: [
							'*Unique file name* is empty, so the convention is off and the '
								+ 'block comes back out.',
							'Notes made from this template keep whatever name they are '
								+ 'created with.',
						],
					});
					continue;
				}

				/*
				 * One block, written with the format the setting names. More than one is the
				 * defect RENAME_MARKS describes, so it is planned even when the format is
				 * already right — what changes then is the removal of the stale copies, not
				 * the block that is kept.
				 */
				if (entry.has && entry.count === 1 && entry.format === wanted) continue;

				const stale = entry.count > 1;
				const onlyStale = stale && entry.format === wanted;

				actions.push({
					kind: 'write-rename-block',
					label: !entry.has
						? 'Add the naming block to the template for "' + name + '"'
						: onlyStale
							? 'Remove the duplicate naming block from the template for "'
								+ name + '"'
							: 'Update the naming block in the template for "' + name + '"',
					file: file,
					path: path,
					object: name,
					format: wanted,
					detail: !entry.has
						? [
							'A note made from this template with no name of its own is named '
								+ 'after the moment it was made, as `' + wanted + '`.',
							'Appended below the frontmatter, which is where it has to go — '
								+ 'the properties above it are written through Obsidian, and '
								+ 'that reads the `---` on the first line.',
						]
						: [
							stale
								? 'The template carries ' + entry.count + ' copies of the block. An '
									+ 'earlier Update wrote a second one instead of replacing the '
									+ 'first; all but the first come out.'
								: 'The block names new notes `' + entry.format + '`, and *Unique '
									+ 'file name* now says `' + wanted + '`.',
							'Only the blocks are touched. Everything else in the template, '
								+ 'frontmatter included, is left exactly as it is.',
						],
				});
			}
		}

		/*
		 * 3b. one .base per class, listing its instances.
		 *
		 * Created once and then left alone - unlike templates, which are
		 * regenerated to stay in step. A base is a starting point he goes on to
		 * edit (adding views, sorts, group-bys), so rewriting it would throw
		 * that work away. An existing base is never touched, however stale.
		 *
		 * That is now true without exception. There used to be a queue behind it -
		 * a class whose base he had asked to be reset from the panel came through
		 * here with `overwrite` set - and the reset lives on the base's own toolbar
		 * since 2026-08-28, where it writes the file in front of him rather than
		 * posting an instruction to a plan he will confirm later.
		 */
		if (this.settings.createBases) {
			for (const name of drafts.keys()) {
				const path = this.basePathFor(name);
				if (this.app.vault.getFileByPath(path)) continue;

				const columns = this.baseColumnsFor(name, objects, drafts);
				/*
				 * **A component's base is of the other stream.** Nothing is ever `is
				 * a` a component, so a base generated in the usual reading would open
				 * empty and stay empty — which is exactly the silent failure the
				 * stream switch was added for on 2026-09-04, arriving here as a
				 * consequence of the same rule rather than as a surprise. What
				 * reaches a component is `has a`: the notes that fill it into a
				 * component field.
				 */
				const reading = components.has(name)
					? { streams: ['has a'], exact: false, excluded: {} }
					: null;
				const detail = [];
				detail.push(components.has(name)
					? 'Table of everything that has a ' + name
						+ ' in a component field, templates excluded.'
					: 'Table of everything that is a ' + name
						+ ', templates excluded.');
				if (components.has(name)) {
					detail.push(this.componentReason(name, components)
						+ ' Nothing is `' + this.settings.isAProperty + '` one, so the '
						+ 'ordinary reading would hold no rows at all.');
				}
				detail.push(columns.length > 0
					? 'Columns: file.name, ' + columns.join(', ')
					: 'Only file.name, since ' + name + ' has no characteristics yet.');
				detail.push('Created once — from then on it is yours. Update leaves it '
					+ 'alone; Class base › Reset from the class is what rebuilds it.');

				actions.push({
					kind: 'write-base',
					label: 'Create base for "' + name + '"',
					path: path,
					object: name,
					content: this.baseContentFor(name, objects, drafts, reading),
					detail: detail,
				});
			}
		}

		/* 4. existing instances, brought in line retroactively */
		for (const instance of instances) {
			const expected = [];
			const seen = new Set();
			/*
			 * With *All notes carry the base characteristics* on, they lead the
			 * expected list, so a note missing one is out of step exactly the way a
			 * note missing a class characteristic is — no separate pass, no
			 * separate rules.
			 */
			if (this.settings.allNotesCarryBase) {
				for (const base of this.baseCharacteristics(characteristics)) {
					if (seen.has(base)) continue;
					seen.add(base);
					expected.push(base);
				}
			}
			/*
			 * `carriedKeys`, not `effectiveCharacteristics`: an instance carries the
			 * component *fields* its classes declare as well, and — where it has
			 * filled one — everything the class it named brings with it. That last
			 * part reads this note's own frontmatter, so two notes of the same class
			 * legitimately expect different keys, which is the point of the feature
			 * and is new here.
			 */
			const carried = this.carriedKeys(
				instance.classes, instance.frontmatter, objects, drafts);
			for (const characteristic of carried.keys) {
				if (seen.has(characteristic)) continue;
				seen.add(characteristic);
				expected.push(characteristic);
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
			 * it has something to say with it. Blank ones are cleared out — unless
			 * he has asked that every note carry them all, which is the same rule
			 * read the other way round.
			 */
			const blankBase = this.settings.allNotesCarryBase
				? []
				: this.settings.logicProperties.filter(
					(property) => (property in instance.frontmatter)
						&& isEmptyValue(instance.frontmatter[property]));

			/*
			 * Fields nothing accounts for. Empty ones join the removals; ones
			 * holding a value are reported instead, the same rule as everywhere
			 * else - a value he typed is his, even when it belongs nowhere.
			 */
			const unclaimed = this.unclaimedKeys(instance.frontmatter, expected, characteristics);
			/*
			 * One note carrying a key nothing declares is an anomaly, and saying
			 * which note and which class is the useful thing to say about it.
			 *
			 * The *same* key on many notes is a different animal — almost always a
			 * characteristic renamed while the plugin could not see it — and asking
			 * "what is this?" once per note asked it forty-six times on his vault,
			 * all about `lifespan`. Those are gathered into one discrepancy that
			 * carries the way to answer them; see `strandedProperties`.
			 */
			for (const key of unclaimed.filter((k) =>
				!isEmptyValue(instance.frontmatter[k]) && !aggregated.has(k))) {
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

			/*
			 * An unclaimed key that holds a value on *some other* note is a shape,
			 * not a stray: almost always a characteristic renamed out from under
			 * it. Removing the empty copies would quietly destroy two thirds of the
			 * evidence before he has answered what it became — so they are held
			 * until nothing carries a value under that name any more.
			 */
			const evidenced = (key) => strandedWithValues.has(key);
			const removable = stale.filter((key) => isEmptyValue(instance.frontmatter[key]))
				.concat(unclaimed.filter((key) => isEmptyValue(instance.frontmatter[key])
					&& !evidenced(key)))
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
			const canonical = this.canonicalOrder(managedAfter, characteristics,
				{ classes: instance.classes, objects: objects, drafts: drafts,
					frontmatter: instance.frontmatter });
			const misordered = !sameNameList(managedAfter, canonical);

			if (missing.length === 0 && removable.length === 0 && !misordered) continue;

			const detail = [];
			if (missing.length > 0) {
				/*
				 * Which component brought it, where one did. "carried by Goal" is
				 * true of `checkpoint` here only in the sense that Goal let him ask
				 * for it; what actually put it on this note is `type: [[Effort]]`,
				 * and that is the line he needs in order to undo it.
				 */
				const viaComponent = new Map();
				for (const target of carried.targets) {
					for (const key of missing) {
						if (viaComponent.has(key)) continue;
						if (carried.owner.get(key) === target.name) {
							viaComponent.set(key, target);
						}
					}
				}
				const direct = missing.filter((key) => !viaComponent.has(key));
				if (direct.length > 0) {
					detail.push('Add, empty: ' + direct.join(', ')
						+ ' — carried by ' + instance.classes.join(', ') + '.');
				}
				const byTarget = new Map();
				for (const [key, target] of viaComponent) {
					const label = target.field + ': ' + target.name;
					if (!byTarget.has(label)) byTarget.set(label, []);
					byTarget.get(label).push(key);
				}
				for (const [label, keys] of byTarget) {
					detail.push('Add, empty: ' + keys.join(', ')
						+ ' — brought in through ' + label + '.');
				}
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
		 * 4a. the three standing columns, enforced on the instances.
		 *
		 * The four value columns differ in exactly this. **Starting value** is what
		 * a note is *created* with and is the note's own from then on — nothing here
		 * touches it. The other three are standing claims about every instance:
		 *
		 *   None replacement    fills an empty value, and only an empty one:
		 *                       *"NONE is never accepted, and NONE will always be
		 *                       replaced"*. A value that is there is left alone.
		 *   Value must be       replaces anything that is not it, empty included.
		 *   Value must contain  adds the entry to a list that is missing it, and
		 *                       keeps everything else in the list.
		 *
		 * Where a differing value is *replaced* and where it is *reported* used to be
		 * one setting over the whole vault. It is written in the row now — which is
		 * the same claim said per characteristic and per class, so the setting went.
		 */
		for (const instance of instances) {
			/*
			 * `carriedKeys`, not `effectiveCharacteristics` - the same correction pass 4
			 * already carries, arriving here a version late. A characteristic reached
			 * through a **component field** is one of this note's own: `goal type:
			 * [[Project]]` hands the note `done`, pass 4 duly writes the empty key for
			 * it, and this pass never looked at it - so `done`'s *None replacement* of
			 * `false` was never enforced and nothing was reported either. Found by him,
			 * 2026-09-05, and his theory of it was exactly right.
			 *
			 * `owner` names the class each key came from - the first of the note's own
			 * classes to declare it, or the component class that brought it - which is
			 * the class whose row in the defaults table should answer. For the `is a`
			 * half that is precisely what the two nested loops used to compute, so
			 * nothing about the old behaviour moves.
			 *
			 * The `strictSeen` guard went with the nesting: `carriedKeys`
			 * de-duplicates by construction, and a second guard over one list is a
			 * second answer waiting to disagree with the first.
			 */
			const carried = this.carriedKeys(
				instance.classes, instance.frontmatter, objects, drafts);
			for (const key of carried.keys) {
				const className = carried.owner.get(key) || null;

				const characteristic = characteristics.get(key);
				const resolved = this.defaultFor(characteristic, className, objects, drafts);
				if (!resolved) continue;

				const current = instance.frontmatter[key];
				const where = resolved.source === ALL_NOTES_ROW
					? 'every note carrying ' + key
					: 'an instance of ' + resolved.source;

				/*
				 * A value already written as a Templater expression is machinery, and
				 * so is a claim written as one: it says what the *template* should
				 * hold, and there is nothing to enforce on a note that exists.
				 * `fill-datetime` is what recovers those, from the file's own
				 * creation time.
				 */
				if (isTemplaterExpression(current)) continue;

				const must = this.columnWriteValue(characteristic, resolved, 'must');
				const none = this.columnWriteValue(characteristic, resolved, 'none');
				const contains = this.columnWriteValue(characteristic, resolved, 'contains');

				/* Value must be — total, so it is asked first and answers alone. */
				if (!isEmptyValue(must) && !isTemplaterExpression(must)) {
					if (sameDefaultValue(current, must)) continue;
					const shown = toArray(must).join(', ');
					actions.push({
						kind: 'fill-default',
						label: (isEmptyValue(current) ? 'Fill ' : 'Replace ') + key + ' on "'
							+ instance.file.basename + '" — '
							+ (isEmptyValue(current) ? shown
								: toArray(current).join(', ') + ' → ' + shown),
						file: instance.file,
						path: instance.file.path,
						property: key,
						value: must,
						overwrite: true,
						detail: [
							'The defaults table for ' + key + ' says ' + where
								+ ' must be ' + shown + ', and this holds '
								+ (isEmptyValue(current)
									? 'nothing.' : toArray(current).join(', ') + '.'),
							'Value must be is total: anything else is replaced. Empty the '
								+ 'cell, or use None replacement instead, if what you meant '
								+ 'was only to fill an empty one.',
						],
					});
					continue;
				}

				/* None replacement — an empty value, and nothing else. */
				if (!isEmptyValue(none) && !isTemplaterExpression(none)
					&& isEmptyValue(current)) {
					const shown = toArray(none).join(', ');
					actions.push({
						kind: 'fill-default',
						label: 'Fill ' + key + ' on "' + instance.file.basename
							+ '" — ' + shown,
						file: instance.file,
						path: instance.file.path,
						property: key,
						value: none,
						/* Only if it is still empty when the write happens. */
						overwrite: false,
						detail: [
							key + ' is empty, and its defaults table replaces none with '
								+ shown + ' for ' + where + '.',
							'A none replacement is not a starting point: an empty value is '
								+ 'never accepted while one stands.',
						],
					});
					continue;
				}

				/* Value must contain — an entry that has to be in the list. */
				if (!isEmptyValue(contains) && !isTemplaterExpression(contains)) {
					const wanted = toArray(contains).map((one) => String(one).trim())
						.filter((one) => one !== '');
					const held = toArray(current).map((one) => String(one).trim());
					const missing = wanted.filter((one) => !held.some(
						(have) => sameDefaultValue(have, one)));
					if (missing.length === 0) continue;

					/*
					 * Only a list can gain an entry. On a single value there is no way
					 * to add without replacing, and replacing is what the *Value must
					 * be* column is for — so this is reported rather than guessed at.
					 */
					const type = String(characteristic
						&& characteristic.propertyType || '').toLowerCase();
					const isList = type === 'list' || type === 'tags' || type === 'multitext';

					if (!isList) {
						if (!isEmptyValue(current)
							&& wanted.every((one) => String(current).indexOf(one) !== -1)) {
							continue;
						}
						conflicts.push({
							file: instance.file,
							property: key,
							value: current,
							reason: 'The defaults table for ' + key + ' says ' + where
								+ ' must contain ' + missing.join(', ') + ', and this holds '
								+ (isEmptyValue(current)
									? 'nothing' : toArray(current).join(', '))
								+ '. ' + key + ' is not a list, so there is nothing to add '
								+ 'to — write it yourself, or say Value must be instead.',
						});
						continue;
					}

					actions.push({
						kind: 'fill-default',
						label: 'Add to ' + key + ' on "' + instance.file.basename
							+ '" — ' + missing.join(', '),
						file: instance.file,
						path: instance.file.path,
						property: key,
						value: held.filter((one) => one !== '').concat(missing),
						overwrite: true,
						detail: [
							'The defaults table for ' + key + ' says ' + where
								+ ' must contain ' + missing.join(', ') + '.',
							'Added to what is there. Nothing already in the list is '
								+ 'removed or reordered.',
						],
					});
				}
			}
			}

		/*
		 * 4b. a row that says two things at once.
		 *
		 * **Value must be** is total, so any other claim in the same row about the
		 * same value would be visibly ignored for ever: a note created with the
		 * starting value would be replaced the moment Update ran, and a none
		 * replacement would never be reached because an empty value is already not
		 * what the value must be. Not a preference the plugin can resolve, so it is
		 * reported on the characteristic note, once per row.
		 */
		for (const characteristic of characteristics.values()) {
			for (const row of characteristic.defaults || []) {
				if (isEmptyValue(row.must)) continue;
				for (const key of ['starting', 'none']) {
					if (isEmptyValue(row[key])) continue;
					if (String(row[key]).trim() === String(row.must).trim()) continue;
					const column = DEFAULTS_COLUMNS[DEFAULTS_VALUE_KEYS.indexOf(key) + 1];
					conflicts.push({
						file: characteristic.file,
						property: characteristic.name,
						value: row[key],
						reason: 'The ' + row.location + ' row gives ' + column.toLowerCase()
							+ ' ' + row[key] + ' and says the value must be ' + row.must
							+ '. What the value must be is what gets written, so the other '
							+ 'would never be used. Empty one of them.',
					});
				}
			}
		}

		/*
		 * 4c. characteristic notes with no defaults table, or none with an
		 * *All notes* row in it.
		 *
		 * *Each* characteristic has one, so one without is out of step the same way
		 * a note missing a property is. The rows are an input, like `property type`
		 * beside them — nothing here rewrites one; a table is appended to a note
		 * that has none, and a missing *All notes* row is put back under the header.
		 *
		 * That second half exists because the row is where a default for every note
		 * lives now, so a table without one has nowhere to say it. It is the same
		 * claim as the first half and rides the same setting.
		 */
		if (this.settings.seedDefaultsTable) {
			for (const characteristic of characteristics.values()) {
				if (!characteristic.file) continue;

				/*
				 * A table written with the old column names, brought up to date first:
				 * everything below reads a row through its table's column map, so an old
				 * table is *read* correctly either way — but a note he opens should say
				 * what the plugin says, and the two new claims have nowhere to be written
				 * until the columns exist.
				 *
				 * Values move across by **name**, so nothing lands under a heading that
				 * means something else. `Strict default value` becomes **None
				 * replacement**, which is what it did on its own: filling an empty value.
				 * The other half of it was a setting, now *Value must be*.
				 */
				const legacy = characteristic.legacyTables || [];
				if (legacy.length > 0) {
					actions.push({
						kind: 'upgrade-defaults-table',
						label: 'Bring the defaults table in "' + characteristic.file.basename
							+ '" up to date',
						file: characteristic.file,
						path: characteristic.file.path,
						name: characteristic.name,
						detail: [
							'Its columns are ' + tableCells(legacy[0].header).join(', ') + '.',
							'Rewritten as ' + DEFAULTS_COLUMNS.join(', ') + '. Every value moves '
								+ 'by column name, so nothing lands under a heading that means '
								+ 'something else, and every line outside the table is untouched.',
						],
					});
					continue;
				}

				if (!characteristic.hasDefaultsTable) {
					actions.push({
						kind: 'add-defaults-table',
						label: 'Add the defaults table to "' + characteristic.file.basename + '"',
						file: characteristic.file,
						path: characteristic.file.path,
						name: characteristic.name,
						detail: [
							'No defaults table, so ' + characteristic.name + ' has no way to say '
								+ 'what its value should be for a given class.',
							'Appended to the end of the note. Nothing already written is read, '
								+ 'moved or removed.',
						],
					});
					continue;
				}

				if ((characteristic.allNotesRows || []).length > 0) continue;

				/*
				 * Left to `retire-default-value`, which inserts the row *with* the value
				 * in it — one action rather than an empty row and then a fill.
				 */
				const frontmatter = this.frontmatterOf(characteristic.file) || {};
				if (!isEmptyValue(frontmatter['default value'])) continue;

				actions.push({
					kind: 'add-all-notes-row',
					label: 'Put the All notes row back in "'
						+ characteristic.file.basename + '"',
					file: characteristic.file,
					path: characteristic.file.path,
					name: characteristic.name,
					detail: [
						'The defaults table has no All notes row, so there is nowhere for '
							+ characteristic.name + ' to say what every note carrying it '
							+ 'should hold — only what one class or another should.',
						'Inserted empty, under the header. Every other line is left exactly '
							+ 'as it is.',
					],
				});
			}
		}

		/*
		 * 4d. `default value:` in the frontmatter, which is retired.
		 *
		 * It said what the table's *All notes* row says — a value for every note
		 * carrying the characteristic, whatever its class — and two spellings of one
		 * claim is two things that can disagree. His call, 2026-08-30: the table is
		 * the one that can *also* say "for this class", so it is the frontmatter key
		 * that goes.
		 *
		 * The key is still read (see `defaultValue`), because a key that is never
		 * looked at is a value silently doing nothing. It is read in order to be
		 * moved here and removed.
		 *
		 * An empty key is simply removed. A key with a value needs somewhere to put
		 * it, and that is the *All notes* row: filled if the row is there, inserted
		 * if the table is there without one. A note with no table at all waits for
		 * `add-defaults-table` in this same plan — and if that is switched off, the
		 * value has nowhere to go and is reported instead of dropped.
		 */
		for (const characteristic of characteristics.values()) {
			if (!characteristic.file) continue;
			/*
			 * The key being *present* is what there is to do something about, not its
			 * value: an empty one is a line to remove, and `defaultValue` reads the
			 * same either way.
			 */
			const frontmatter = this.frontmatterOf(characteristic.file) || {};
			if (!('default value' in frontmatter)) continue;
			const held = frontmatter['default value'];

			const entry = this.defaultsEntryFor(characteristic.file);
			const row = (entry.allRows || [])[0] || null;
			const text = toArray(held).map((one) => String(one).trim()).join(', ').trim();

			if (isEmptyValue(held)) {
				actions.push({
					kind: 'retire-default-value',
					label: 'Remove the empty default value from "'
						+ characteristic.file.basename + '"',
					file: characteristic.file,
					path: characteristic.file.path,
					name: characteristic.name,
					moveValue: '',
					targetLine: null,
					detail: [
						'A default for every note is what the All notes row of the defaults '
							+ 'table says. The empty key below possible values says nothing '
							+ 'and is removed.',
					],
				});
				continue;
			}

			/* Nowhere to put it yet, and something in this plan is about to make one. */
			if (!row && !entry.hasTable && this.settings.seedDefaultsTable) continue;

			if (!row && !entry.hasTable) {
				conflicts.push({
					file: characteristic.file,
					property: characteristic.name,
					value: text,
					reason: 'default value is retired — the All notes row of the defaults '
						+ 'table is where a value for every note lives now. This note has no '
						+ 'table, and *Every characteristic note carries the table* is off, '
						+ 'so there is nowhere to move ' + text + ' to. Turn that on, or add '
						+ 'the table yourself.',
				});
				continue;
			}

			if (row && !isEmptyValue(row.must) && row.must.trim() !== text) {
				conflicts.push({
					file: characteristic.file,
					property: characteristic.name,
					value: text,
					reason: 'default value says ' + text + ', and the All notes row already '
						+ 'says the value must be ' + row.must + ' for every note — which is '
						+ 'what would be written, so the other would never be used. Settle it '
						+ 'in the row and the key will be removed.',
				});
				continue;
			}

			if (row && !isEmptyValue(row.starting) && row.starting.trim() !== text) {
				conflicts.push({
					file: characteristic.file,
					property: characteristic.name,
					value: text,
					reason: 'default value says ' + text + ', and the All notes row of the '
						+ 'defaults table already says ' + row.starting + '. Two answers to one '
						+ 'question, so neither is written over: keep the one you mean in the '
						+ 'row, and the key will be removed.',
				});
				continue;
			}

			const already = row && !isEmptyValue(row.starting);
			actions.push({
				kind: 'retire-default-value',
				label: already
					? 'Remove the default value from "' + characteristic.file.basename
						+ '" — the All notes row already says it'
					: 'Move the default value of "' + characteristic.file.basename
						+ '" into the All notes row',
				file: characteristic.file,
				path: characteristic.file.path,
				name: characteristic.name,
				/* Empty when the row already says it: then this is only a removal. */
				moveValue: already ? '' : text,
				/* The row to fill, or null to insert one under the header rule. */
				targetLine: row ? row.line : null,
				detail: already ? [
					'The All notes row of the defaults table already gives every note '
						+ row.starting + ' to start with. The key says the same thing a second '
						+ 'way, and is removed.',
				] : [
					text + ' is what every note carrying ' + characteristic.name
						+ ' starts with, whatever its class — which is what the Starting value '
						+ 'cell of the All notes row says.',
					row
						? 'The value moves into that row and the key is removed. Nothing '
							+ 'changes about what a note is created with.'
						: 'The row is inserted under the header, the value goes in it, and '
							+ 'the key is removed. Nothing changes about what a note is '
							+ 'created with.',
				],
			});
		}

		/*
		 * Values a characteristic does not permit. Reported, never fixed - the
		 * plugin has no business choosing a different value than the one he
		 * typed.
		 */
		/*
		 * `componentFields` is not decoration here - it is what tells
		 * `constraintsFor` which reading of a class constraint applies. Without
		 * it every component value in the vault is judged as though `[[Goal
		 * Type]]` asked for an *instance* of Goal Type, and `goal type:
		 * [[Project]]` - a subclass, which is the whole point - is reported as
		 * a value the characteristic does not permit.
		 *
		 * This picture is assembled by hand rather than by `buildPicture`, so a
		 * field added to one is not added to the other. That is exactly how it
		 * went missing.
		 */
		const localPicture = {
			characteristics: characteristics,
			classes: objects,
			componentFields: componentFields,
			instances: new Map(instances.map((i) => [i.file.path, {
				file: i.file, keys: new Set(Object.keys(i.frontmatter)), values: i.frontmatter,
			}])),
		};

		/*
		 * Two kinds of offending value are held back from this report: one he has
		 * already answered for, and one carried by enough notes to be a question
		 * of its own. Both are raised once, by the pass that can actually carry a
		 * rename, rather than twenty-one times over as faults.
		 */
		const answered = new Set();
		for (const entry of this.pendingValueRenames()) {
			answered.add(valueRenameKey(entry.characteristic, entry.from));
		}
		for (const [key, byValue] of this.strandedValues(localPicture)) {
			for (const stranded of byValue.values()) {
				if (stranded.files.length < 2) continue;
				answered.add(valueRenameKey(key, stranded.value));
			}
		}

		for (const complaint of this.valueDiscrepancies(localPicture, answered)) {
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
	/*
	 * Templates and bases whose class is gone.
	 *
	 * Renaming a class moves all three files, so these only appear when a class
	 * note is deleted by hand - and then they linger for ever, which is what he
	 * noticed.
	 *
	 * The naming alone is not evidence. `Characteristic Template.md` and
	 * `Base Base.base` are his own and match the pattern exactly; trashing them on
	 * the strength of a filename would be unforgivable. So a file has to *look
	 * generated* as well: a template carries `is a` naming the class its name
	 * implies, and a base filters on `file.isA("that class")`. His own files do
	 * neither.
	 */
	/*
	 * A template whose file name does not match the class it declares.
	 *
	 * `templatePathFor()` computes where a class's template *should* be, so a
	 * template filed anywhere else is invisible: nothing finds it, a second one
	 * is generated beside it, and the two drift apart for ever. The orphan scan
	 * below does not catch it either — that one looks for `<X> Template.md` whose
	 * `is a` names X, and a misnamed file fails that by definition.
	 *
	 * The name is not decoration. It is the only link between a class and its
	 * template, so it has to be true.
	 */
	misnamedTemplateActions(objects, components) {
		const found = [];

		for (const file of this.filesIn(this.settings.templatesFolder)) {
			/*
			 * Only a template that says which class it is for. One with no `is a`
			 * is either his own or the root's, whose template writes none by
			 * design — and neither can be placed by guessing.
			 */
			const frontmatter = this.frontmatterOf(file) || {};
			const claimed = toArray(frontmatter[this.settings.isAProperty])
				.map(linkName).filter(Boolean)
				.map((name) => this.canonicalName(name))
				.find((name) => objects.has(name));
			if (!claimed) continue;

			/*
			 * A component has no template, so there is no name for this one to be
			 * put right to. Renaming it into the place the trash pass is about to
			 * clear would be one Update moving a file and the next removing it.
			 */
			if (components && components.has(claimed)) continue;

			const target = this.templatePathFor(claimed);
			if (file.path === target) continue;

			/*
			 * Something is already correctly named for that class. Renaming would
			 * collide, and choosing which of the two is the real template is not
			 * the plugin's call.
			 */
			const occupied = this.fileAt(target);
			if (occupied && occupied !== file) {
				/* A conflict, in the shape the rest of them take. */
				found.push({
					insolvable: true,
					file: file,
					property: this.settings.isAProperty,
					value: '[[' + claimed + ']]',
					reason: 'This says it is the template for ' + claimed + ', but '
						+ target + ' already has the name that class expects. A class has '
						+ 'exactly one template and it is found by its name, so one of '
						+ 'these two is not it. Rename or delete whichever is wrong.',
				});
				continue;
			}

			found.push({
				kind: 'rename-template',
				label: 'Rename the template for "' + claimed + '"',
				file: file,
				path: file.path,
				target: target,
				object: claimed,
				detail: [
					'It says `' + this.settings.isAProperty + ': "[[' + claimed
						+ ']]"`, so its name has to be "' + claimed
						+ this.settings.templateSuffix + '".',
					'Under any other name nothing finds it, and a second template is '
						+ 'generated beside it.',
					file.path + '  →  ' + target,
				],
			});
		}

		return found;
	}

	orphanActions(objects) {
		const found = [];
		const suffix = this.settings.templateSuffix || '';

		for (const file of this.filesIn(this.settings.templatesFolder)) {
			if (!suffix || !file.basename.endsWith(suffix)) continue;
			const name = file.basename.slice(0, file.basename.length - suffix.length).trim();
			if (!name || objects.has(name)) continue;

			/* Generated templates say what they are an instance of. His do not. */
			const frontmatter = this.frontmatterOf(file) || {};
			const claims = toArray(frontmatter[this.settings.isAProperty])
				.map(linkName).filter(Boolean)
				.some((target) => String(target).toLowerCase() === name.toLowerCase());
			if (!claims) continue;

			found.push({
				kind: 'trash-template',
				label: 'Trash the template for "' + name + '"',
				file: file,
				path: file.path,
				detail: [
					'No class called "' + name + '" exists any more, and this template '
						+ 'says `' + this.settings.isAProperty + ': "[[' + name + ']]"`.',
					'It goes to the Obsidian trash, so it can be brought back.',
				],
			});
		}

		/*
		 * Bases cannot be read synchronously, so the evidence is gathered in the
		 * background and consulted here. An orphan that has not been scanned yet is
		 * simply not offered this time round - a missing action is safe, a wrong
		 * one is not.
		 */
		for (const path of this.orphanBases || []) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) continue;
			const baseSuffix = this.settings.baseSuffix || '';
			const name = file.basename.slice(0, file.basename.length - baseSuffix.length).trim();
			if (!name || objects.has(name)) continue;

			found.push({
				kind: 'trash-base',
				label: 'Trash the base for "' + name + '"',
				file: file,
				path: file.path,
				detail: [
					'No class called "' + name + '" exists any more, and this base filters '
						+ 'on `file.isA("' + name + '")`.',
					'It goes to the Obsidian trash, so it can be brought back.',
				],
			});
		}

		return found;
	}

	/*
	 * Which `.base` files look generated for a class that no longer exists. Async,
	 * and therefore kept off the plan's path: the plan reads the answer from last
	 * time rather than waiting for a fresh one.
	 */
	async refreshOrphanBases() {
		const found = new Set();
		const suffix = this.settings.baseSuffix || '';
		const objects = this.scanClasses();

		if (suffix) {
			for (const file of this.app.vault.getFiles()) {
				if (file.extension !== 'base') continue;
				if (!this.inFolder(file, this.settings.basesFolder)) continue;
				if (!file.basename.endsWith(suffix)) continue;

				const name = file.basename.slice(0, file.basename.length - suffix.length).trim();
				if (!name || objects.has(name)) continue;

				try {
					const content = await this.app.vault.cachedRead(file);
					if (content.indexOf('file.isA("' + name + '")') !== -1) found.add(file.path);
				} catch (error) {
					/* Unreadable: leave it alone, which is the safe direction. */
				}
			}
		}

		this.orphanBases = found;
		return found;
	}

	unusedCharacteristicActions(characteristics, drafts) {
		const used = new Set();

		for (const property of this.settings.logicProperties) used.add(property);
		for (const property of toArray(this.settings.retiredLogicProperties)) used.add(property);
		for (const draft of drafts.values()) {
			for (const characteristic of draft.characteristics) used.add(characteristic);
			/*
			 * Named by a class in *any* base characteristic, not only in its
			 * `characteristics` list. A characteristic written into `type of` by
			 * mistake is reported as a conflict for him to resolve — and until he
			 * does, it must not be trashed. Telling him to fix a mistake and then
			 * deleting the thing the mistake refers to is the worst of both.
			 */
			for (const property of this.settings.logicProperties) {
				for (const value of toArray(draft.values && draft.values[property])) {
					used.add(stripPrefix(value, this.settings.characteristicPrefix));
				}
			}
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
		/*
		 * A key with a rename already recorded is not unaccounted for — it is
		 * accounted for by the rename, and `rename-property` owns it. Reporting it
		 * here as well raised one insolvable conflict per note, and insolvable
		 * conflicts block Update: he could answer what the key became and then be
		 * unable to press the button that carries the answer.
		 */
		const renaming = new Set(toArray(this.settings.pendingPropertyRenames)
			.filter((entry) => entry && entry.from).map((entry) => entry.from));
		return Object.keys(frontmatter).filter((key) => {
			if (renaming.has(key)) return false;
			if (declared.has(key)) return false;
			/*
			 * The base characteristics, the retired ones, the native attributes and
			 * the class's symbol. Shared with `strandedProperties`, which is the pass
			 * this list had already drifted out of step with.
			 */
			if (this.isSystemProperty(key)) return false;
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
				property: action.property || '',
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
				property: conflict.property || '',
				subject: conflict.file ? conflict.file.basename : '',
				label: (conflict.file ? conflict.file.basename + ' · ' : '') + conflict.property,
				file: conflict.file || null,
				path: conflict.file ? conflict.file.path : '',
				detail: [conflict.reason],
				fix: null,
			});
		}

		for (const structural of this.structuralDiscrepancies()) found.push(structural);

		/*
		 * Keys nothing declares, one item per key. Insolvable because the plugin
		 * cannot know what the thing was renamed to — but it can carry the answer
		 * once he gives it, which is what the button on this row is for.
		 */
		const characteristics = this.scanCharacteristics();
		const pending = toArray(this.settings.pendingPropertyRenames)
			.map((entry) => entry && entry.from);
		for (const [key, entry] of this.strandedProperties(characteristics)) {
			if (pending.indexOf(key) !== -1) continue;
			/*
			 * One note is an anomaly and is reported as one, naming the note and
			 * the class. Two or more is a shape, and gets this instead.
			 */
			if (entry.files.length < 2) continue;
			const suggestion = this.suggestRenameFor(entry, characteristics);
			const held = entry.files.length - entry.empty;
			found.push({
				severity: 'insolvable',
				kind: 'stranded-property',
				property: key,
				subject: key,
				label: '"' + key + '" — on ' + entry.files.length + ' note'
					+ (entry.files.length === 1 ? '' : 's') + ', declared by nothing',
				file: entry.files[0] || null,
				path: entry.files[0] ? entry.files[0].path : '',
				detail: [
					'No characteristic note defines "' + key + '", and no class lists it, '
						+ 'but ' + entry.files.length + ' note'
						+ (entry.files.length === 1 ? ' carries' : 's carry') + ' it'
						+ (held > 0 ? ' — ' + held + ' with a value' : '') + '.',
					'Most often this is a characteristic that was renamed while the '
						+ 'plugin could not see it happen. Say what it became and Update '
						+ 'will move every value across.',
				].concat(suggestion
					? ['Its values match "' + suggestion + '", which allows '
						+ entry.values.slice(0, 4).join(', ') + '.']
					: []),
				stranded: entry,
				suggestion: suggestion,
				fix: null,
			});
		}

		/*
		 * Values nothing allows any more, one item per value. The same question as
		 * the stranded key above asked one level down, and it has the same answer:
		 * he says what it became, and Update carries every note across.
		 */
		const picture = this.picture();
		const renaming = new Set(this.pendingValueRenames()
			.map((entry) => valueRenameKey(entry.characteristic, entry.from)));

		for (const [key, byValue] of this.strandedValues(picture)) {
			const suggestion = this.suggestValueRenameFor(key, picture);
			for (const stranded of byValue.values()) {
				if (renaming.has(valueRenameKey(key, stranded.value))) continue;
				/*
				 * One note holding a word nothing allows is a typo, and the pass that
				 * reports values reports it as itself, naming the note. Two or more
				 * is a shape, and gets this instead.
				 */
				if (stranded.files.length < 2) continue;

				found.push({
					severity: 'insolvable',
					kind: 'stranded-value',
					property: key,
					subject: key + ' · ' + stranded.value,
					label: '"' + stranded.value + '" — on ' + stranded.files.length
						+ ' notes, no longer a possible value for ' + key,
					file: stranded.files[0] || null,
					path: stranded.files[0] ? stranded.files[0].path : '',
					detail: [
						key + ' no longer allows "' + stranded.value + '", and '
							+ stranded.files.length + ' notes still hold it.',
						'Most often this is a value renamed in `possible values` with the '
							+ 'notes left behind. Say what it became and Update will move '
							+ 'every one of them.',
					].concat(suggestion
						? ['"' + suggestion + '" is allowed and nothing uses it, which is '
							+ 'what a rename looks like from the outside.']
						: []),
					strandedValue: stranded,
					suggestion: suggestion,
					fix: null,
				});
			}
		}

		/*
		 * And what a rename cannot reach: the word inside a base filter, or in the
		 * prose of a note. Named rather than rewritten — see `scanValueMentions`.
		 */
		for (const entry of this.pendingValueRenames()) {
			const mentions = this.valueMentionsFor(entry);
			const total = mentions.bases.length + mentions.notes.length;
			if (total === 0) continue;

			const said = [];
			if (mentions.bases.length > 0) {
				said.push(mentions.bases.length + ' base'
					+ (mentions.bases.length === 1 ? '' : 's'));
			}
			if (mentions.notes.length > 0) {
				said.push(mentions.notes.length + ' note'
					+ (mentions.notes.length === 1 ? '' : 's'));
			}

			const hits = mentions.bases.concat(mentions.notes);
			found.push({
				severity: 'insolvable',
				kind: 'value-mentions',
				property: entry.characteristic,
				subject: entry.characteristic + ' · ' + entry.from,
				label: '"' + entry.from + '" is still written in ' + andList(said),
				file: hits[0] ? hits[0].file : null,
				path: hits[0] ? hits[0].file.path : '',
				detail: [
					'Only in the text. A note carrying "' + entry.from + '" as a '
						+ entry.characteristic + ' is renamed like any other — this is '
						+ 'about the word written in a sentence, or inside a base filter, '
						+ 'and neither of those is rewritten.',
					'A filter is an expression and a sentence is prose, so replacing the '
						+ 'word inside either is the fuzzy edit this rename exists to '
						+ 'avoid. They are named here instead, and yours to change or to '
						+ 'leave.',
				],
				mentions: hits,
				renamedTo: entry.to,
				fix: null,
			});
		}

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

		/*
		 * A note that is an instance of a component — his note, 2026-09-05: *"If
		 * someone tries to instantiate a component, it will be a discrepancy."*
		 *
		 * There is nothing to fix automatically, and that is the honest answer
		 * rather than a gap: the note either belongs to a class that is not a
		 * component, or the class should not be one, and only he knows which. What
		 * the plugin can do is make it hard to arrive here at all — a component has
		 * no template, so no button makes one of these.
		 */
		const components = picture.componentClasses || new Map();
		for (const note of picture.notes.values()) {
			for (const target of note.classes) {
				if (!components.has(target)) continue;
				/* Already reported, and more usefully, as a link naming nothing. */
				if (!picture.classes.has(target)) continue;
				found.push({
					severity: 'insolvable',
					kind: 'instantiated-component',
					subject: note.name,
					label: '"' + note.name + '" is a "' + target + '", which is a component',
					file: note.file,
					path: note.file.path,
					detail: [
						this.componentReason(target, components),
						'A component is composed into other notes rather than instantiated, '
							+ 'so nothing should be `' + this.settings.isAProperty + '` one.',
						'Either point `' + this.settings.isAProperty + '` at a class that is '
							+ 'not a component, or stop using "' + target + '" as a component '
							+ 'field value — the tag follows whichever you choose.',
					],
					fix: null,
				});
			}
		}

		/*
		 * A class and a parent of different kinds — his fourth rule: *"it is
		 * impossible for a class to be a type of a component and vice versa."*
		 *
		 * Only one direction can actually occur, and saying which is the point.
		 * Downward the rule holds by construction: a `type of` a component *is* a
		 * component, because that is what gets written into the field. So the case
		 * left is a component that is also a type of a plain class — the same
		 * violation reached from the other side, and the one place the two trees
		 * would otherwise be spliced together.
		 *
		 * Through `componentDisputes`, which is the same set the plan stands aside
		 * for: what is reported here and what is left untouched there have to be
		 * one answer, or the plugin acts on a class in the same breath it says it
		 * cannot.
		 */
		for (const [name, strangers] of
			this.componentDisputes(picture.drafts, components)) {
			const klass = picture.classes.get(name) || {};
			for (const parent of strangers) {
				found.push({
					severity: 'insolvable',
					kind: 'component-mixed-parent',
					subject: name,
					label: '"' + name + '" is a component, but is a '
						+ this.settings.inheritsProperty + ' "' + parent
						+ '", which is not',
					file: klass.file || null,
					path: (klass.file || {}).path || '',
					detail: [
						this.componentReason(name, components),
						'"' + parent + '" is not a component: no component field permits '
							+ 'it, and nothing above it is one either.',
						'A class cannot be a ' + this.settings.inheritsProperty
							+ ' a component and a component cannot be a '
							+ this.settings.inheritsProperty + ' a class — the two are '
							+ 'separate trees. Either drop that parent, or point a component '
							+ 'field at "' + parent + '" so the whole branch is one kind.',
						'Until this is settled "' + name + '" is left exactly as it is: its '
							+ 'tag is not changed and its template is not removed.',
					],
					fix: null,
				});
			}
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
				new Notice('OOF Class Manager: "' + action.label + '" failed — see the console.', 8000);
			}
		}

		/* Applied intentions are no longer pending, on disk as well as in memory. */
		this.drafts.clear();
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
					new Notice('OOF Class Manager: "' + discrepancy.label + '" failed — see the console.',
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
			new Notice('OOF Class Manager: ' + remaining + ' discrepanc'
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
		this.invalidatePicture();
		this.forgetFinishedRenames();
		await this.persist();
		return result;
	}

	/*
	 * A recorded rename is done once no note carries the old key any more. Kept
	 * until then rather than cleared on the first Update, because one he left
	 * behind — a note he had not opened, a conflict he has not resolved — still
	 * needs it, and a forgotten rename is a value stranded under a name nothing
	 * declares.
	 */
	/*
	 * A value rename is done once nothing anywhere still holds the old word: no
	 * note, no template, and not the characteristic's own `possible values`,
	 * `default value` or defaults table. Same rule as the renames below, same
	 * reason - a note he had not opened still needs it.
	 */
	forgetFinishedValueRenames() {
		const pending = this.pendingValueRenames();
		if (pending.length === 0) return;

		const characteristics = this.scanCharacteristics();
		this.settings.pendingValueRenames = pending.filter(
			(entry) => this.valueRenameOutstanding(entry, characteristics));

		/* What is still written outside frontmatter has changed with them. */
		this.scanValueMentions().catch(() => {});
	}

	forgetFinishedRenames() {
		this.forgetFinishedValueRenames();

		const pending = toArray(this.settings.pendingPropertyRenames)
			.filter((entry) => entry && entry.from && entry.to && entry.from !== entry.to);
		if (pending.length === 0) return;

		const files = this.app.vault.getMarkdownFiles()
			.filter((file) => !this.inFolder(file, this.settings.characteristicsFolder));

		this.settings.pendingPropertyRenames = pending.filter((entry) =>
			files.some((file) => {
				const frontmatter = this.frontmatterOf(file);
				return !!frontmatter && (entry.from in frontmatter);
			}));
	}

	/*
	 * What an action would do to a note's frontmatter, as a function rather than
	 * as a write. `applyAction` hands it to `processFrontMatter`; the diff view
	 * runs it against a copy instead, so what he is shown is produced by the same
	 * code that will do the writing rather than by a description of it.
	 *
	 * Returns null for actions that are not frontmatter edits — trashing a file,
	 * renaming one, writing `types.json`.
	 */
	frontmatterMutation(action) {
		if (action.kind === 'fill-datetime') {
			return (fm) => {
				/* Only if it is still empty — he may have filled it in the meantime. */
				if (isEmptyValue(fm[action.property])) fm[action.property] = action.value;
			};
		}

		if (action.kind === 'fill-default') {
			return (fm) => {
				/*
				 * Still empty, unless the plan was explicitly to replace what is
				 * there — he may have filled it in between the plan and the write,
				 * and that value is newer than this one.
				 */
				if (!action.overwrite && !isEmptyValue(fm[action.property])) return;
				fm[action.property] = Array.isArray(action.value)
					? action.value.slice() : action.value;
			};
		}

		if (action.kind === 'strip-redundant-link' || action.kind === 'strip-root-link') {
			return (fm) => {
				/* Empty rather than absent: it is still a base characteristic. */
				fm[action.property] = action.values.length > 0 ? action.values.slice() : null;
			};
		}

		/*
		 * The retired key, leaving. Only ever removed — where it held a value, that
		 * value is put in the table's *All notes* row first, by the write itself.
		 */
		if (action.kind === 'retire-default-value') {
			return (fm) => { delete fm['default value']; };
		}

		if (action.kind === 'describe-characteristic') {
			return (fm) => {
				if (action.setType) fm['property type'] = action.setType;
				if (action.setBaseFlag) fm['is base characteristic'] = true;
				/* Off first, so a swap cannot pass through a state carrying both. */
				for (const tag of toArray(action.removeTags)) this.removeTag(fm, tag);
				if (action.addTag) {
					this.addTag(fm, action.addTag);
					this.tagsFirst(fm);
				}
			};
		}

		if (action.kind === 'rename-property') {
			return (fm) => {
				if (!(action.from in fm)) return;
				const value = fm[action.from];
				delete fm[action.from];
				/* Never over an existing value — the conflict pass caught those. */
				if (isEmptyValue(fm[action.to])) fm[action.to] = value;
			};
		}

		/*
		 * One value moving. The property is not touched, its other values are not
		 * touched, and nothing outside the frontmatter is read - which is the
		 * whole of what makes this a rename rather than a search and replace.
		 */
		if (action.kind === 'rename-value') {
			return (fm) => {
				for (const entry of action.properties) {
					const next = renameWithin(fm[entry.property], entry.from, entry.to);
					/*
					 * Null when what is there is no longer the value that was renamed
					 * - he may have edited it between the plan and the write, and what
					 * he typed is newer than this.
					 */
					if (next === null) continue;
					fm[entry.property] = next;
				}
			};
		}

		if (action.kind === 'update-instance') {
			return (fm) => {
				for (const key of action.add) if (!(key in fm)) fm[key] = null;
				for (const key of action.remove) delete fm[key];
				this.applyOrder(fm, action);
			};
		}

		if (action.kind === 'apply-class') {
			return (fm) => {
				/*
				 * Every selected class, not one — `is a` is a list, and a selection of
				 * three means the note is all three. `action.object` stays the first of
				 * them for the labels that were written when there could only be one.
				 */
				const applying = action.objects || [action.object];
				fm[this.settings.isAProperty] = applying.map(asLink);
				/*
				 * The class's keys arrive empty, so the note is a complete instance
				 * rather than one claiming a class it does not carry. Anything
				 * already in the note keeps its value — this never overwrites.
				 *
				 * Keys the *previous* class left behind are deliberately not removed
				 * here. The discrepancy handler owns that decision and has rules for
				 * it (an empty one goes, a populated one is a conflict he is asked
				 * about), and one confirmation should not smuggle in the other.
				 */
				for (const key of action.add) if (!(key in fm)) fm[key] = null;
				/*
				 * Deliberately not reordered. Putting the keys into inheritance order
				 * here rewrites every key the note already had, and in the diff those
				 * moves are indistinguishable from deletions — on a real note it
				 * turned a 3-line change into a 15-line one, which is the opposite of
				 * what a confirmation is for. Order is Update's business, and Update
				 * already checks for it.
				 */
			};
		}

		if (action.kind === 'update-class') {
			return (fm) => {
				this.writeLogicValues(fm, action);
				/* Off first, so a swap cannot pass through a state carrying both. */
				for (const tag of toArray(action.removeTags)) this.removeTag(fm, tag);
				if (action.addTag) this.addTag(fm, action.addTag);
				/*
				 * Cleared to empty rather than deleted. An absent property and an
				 * empty one look nothing alike in the properties view, and the same
				 * argument settled the root's `is a` — the key being there is what
				 * says the class *could* have a symbol.
				 */
				if (action.symbolProperty) {
					fm[action.symbolProperty] = action.symbol || null;
				}
				this.applyOrder(fm, action);
			};
		}

		if (action.kind === 'write-template') {
			const managed = new Set(action.managed || []);
			const stray = new Set(action.remove || []);
			const defaults = action.defaults || {};
			return (fm) => {
				for (const key of Object.keys(fm)) {
					if (key === this.settings.isAProperty || managed.has(key)) delete fm[key];
					else if (stray.has(key) && !isTemplaterExpression(fm[key])) delete fm[key];
				}
				for (const property of action.properties) {
					if (property === this.settings.isAProperty) {
						fm[property] = action.emptyIsA ? null : [asLink(action.object)];
					} else if (!isEmptyValue(defaults[property])) {
						fm[property] = defaults[property];
					} else {
						fm[property] = null;
					}
				}
			};
		}

		return null;
	}

	/*
	 * The frontmatter as Obsidian writes it: a bare key when there is no value, a
	 * block sequence for a list. Only used for showing him a change, never for
	 * writing — `processFrontMatter` owns that.
	 */
	frontmatterLines(frontmatter) {
		const lines = [];
		for (const key of Object.keys(frontmatter || {})) {
			const value = frontmatter[key];
			if (Array.isArray(value)) {
				lines.push(key + ':');
				for (const item of value) {
					lines.push('  - ' + (isEmptyValue(item) ? '' : yamlScalar(String(item))));
				}
				continue;
			}
			if (isEmptyValue(value)) { lines.push(key + ':'); continue; }
			if (value === true || value === false) { lines.push(key + ': ' + value); continue; }
			lines.push(key + ': ' + yamlScalar(String(value)));
		}
		return lines;
	}

	/*
	 * Before and after, for one action. `null` when there is nothing line-shaped
	 * to show.
	 */
	changePreview(action) {
		const file = action.file || (action.path
			? this.app.vault.getFileByPath(action.path) : null);

		if (action.kind === 'write-base') {
			/*
			 * A `.base` cannot be read synchronously, so there is no "before" to
			 * show. Every line reads as added, which is honest for a base being
			 * created — and for one being rewritten it is the plain truth: the file
			 * is replaced wholesale, which is what the red warning beside it says.
			 */
			return {
				path: action.path,
				before: [],
				after: String(action.content || '').split('\n'),
				whole: true,
			};
		}

		if (TRASH_KINDS.indexOf(action.kind) !== -1) {
			const frontmatter = file ? this.frontmatterOf(file) : null;
			return { path: action.path, whole: true,
				before: frontmatter ? this.frontmatterLines(frontmatter) : ['(the whole file)'],
				after: [] };
		}

		/*
		 * The only body change there is, so it is the only preview that shows
		 * lines which are not frontmatter. Appended, so everything already in the
		 * note is unchanged and there is nothing to mark as leaving.
		 */
		if (action.kind === 'add-defaults-table') {
			return {
				path: action.path,
				before: [],
				after: [''].concat(defaultsTableBlock()),
			};
		}

		/*
		 * The other body change. Unlike the table this one *replaces* when a block
		 * is already there, so the preview has a before as well as an after — he
		 * should see the format leaving, not only the one arriving.
		 */
		/*
		 * The third, and the only one whose before and after are the *same* lines
		 * with a word changed. Produced by `rewriteTableCell`, which is the
		 * function that will do the writing - so what he is shown is the change
		 * rather than a description of it.
		 */
		if (action.kind === 'rename-defaults-value') {
			const before = [];
			const after = [];
			for (const row of toArray(file ? this.defaultsEntryFor(file).rows : [])) {
				let next = row.raw;
				for (const key of DEFAULTS_VALUE_KEYS) {
					if (row.columns[key] === undefined) continue;
					const changed = rewriteTableCell(next, row.columns[key],
						action.from, action.to);
					if (changed !== null) next = changed;
				}
				if (next === row.raw) continue;
				before.push(row.raw);
				after.push(next);
			}
			return { path: action.path, before: before, after: after };
		}

		/*
		 * The fourth, and the only one that is a frontmatter change and a body
		 * change at once: the key leaves and, when it held one, its value arrives
		 * in the table's *All notes* row. Both sides in one diff because they are
		 * one move — seeing the key go without seeing where the value went would
		 * look like a value being thrown away.
		 *
		 * The row is built by `allNotesRowWrite`, which is the function that will
		 * do the writing, so this cannot describe something else.
		 */
		/*
		 * The table's own lines, before and after. Built by `upgradeDefaultsTable`,
		 * which is the function that will do the writing — so a value that would
		 * land in the wrong column is visible here rather than only afterwards.
		 */
		if (action.kind === 'upgrade-defaults-table') {
			const before = [];
			const after = [];
			for (const table of (file ? this.defaultsEntryFor(file).legacy : [])) {
				const lines = toArray(table.lines);
				before.push(...lines);
				after.push(...upgradeDefaultsTable(lines, table.map));
			}
			return { path: action.path, before: before, after: after };
		}

		/* The same row arriving, with nothing in it and no key leaving. */
		if (action.kind === 'add-all-notes-row') {
			return { path: action.path, before: [], after: [allNotesRowWrite(null, '', null)] };
		}

		if (action.kind === 'retire-default-value') {
			const current = file ? (this.frontmatterOf(file) || {}) : {};
			const copy = {};
			for (const key of Object.keys(current)) {
				copy[key] = Array.isArray(current[key]) ? current[key].slice() : current[key];
			}
			this.frontmatterMutation(action)(copy);

			const before = this.frontmatterLines(current);
			const after = this.frontmatterLines(copy);

			if (!isEmptyValue(action.moveValue)) {
				const rows = file ? (this.defaultsEntryFor(file).allRows || []) : [];
				const row = rows[0] || null;
				if (row) before.push(row.raw);
				after.push(allNotesRowWrite(row ? row.raw : null, action.moveValue,
					row ? row.columns : null));
			}

			return { path: action.path, before: before, after: after };
		}

		if (action.kind === 'write-rename-block') {
			const cached = this.renameEntryFor(action.path);
			/*
			 * The real lines out of the file, not a block rebuilt from the format: two
			 * copies of it are the thing being repaired, and a reconstruction shows one.
			 */
			const before = [];
			for (const one of (cached && cached.blocks) || []) {
				if (before.length) before.push('');
				before.push(...one);
			}
			return {
				path: action.path,
				before: before,
				after: action.format ? [''].concat(renameBlock(action.format)) : [],
			};
		}

		if (action.kind === 'create-characteristic' || action.kind === 'create-class') {
			const mutation = this.frontmatterMutation(action);
			const made = {};
			if (action.kind === 'create-characteristic') {
				if (action.tag) made.tags = [action.tag];
				made['characteristic meaning'] = null;
				made['property type'] = action.propertyType || null;
				made['is base characteristic'] = !!action.isBase;
				made['possible values'] = null;
			} else if (mutation) {
				mutation(made);
			}
			const body = action.kind === 'create-characteristic'
				? [''].concat(defaultsTableBlock()) : [];
			return {
				path: action.path,
				before: [],
				after: this.frontmatterLines(made).concat(body),
			};
		}

		const mutation = this.frontmatterMutation(action);
		if (!mutation || !file) return null;

		const current = this.frontmatterOf(file) || {};
		const before = this.frontmatterLines(current);

		/* A deep-enough copy: values are strings, booleans and arrays of strings. */
		const copy = {};
		for (const key of Object.keys(current)) {
			copy[key] = Array.isArray(current[key]) ? current[key].slice() : current[key];
		}
		mutation(copy);

		return { path: file.path, before: before, after: this.frontmatterLines(copy) };
	}

	async applyAction(action) {
		/*
		 * Obsidian's own events will invalidate this too, but not before the next
		 * line of the convergence loop runs. It must see what was just written.
		 */
		this.invalidatePicture();

		/*
		 * Remember a symbol written as a copy of an ancestor's, and forget one that
		 * is no longer a copy. This is what lets the next Update tell a value the
		 * plugin put there from one he chose — and so what stops a materialised
		 * symbol turning into a permanent fork of the class above it.
		 */
		if (action.kind === 'update-class' && action.symbolProperty && this.symbolWrites) {
			if (action.symbolCopied) this.symbolWrites.set(action.object, action.symbol);
			else this.symbolWrites.delete(action.object);
		}

		if (action.kind === 'create-characteristic') {
			await this.ensureFolder(this.settings.characteristicsFolder);
			/*
			 * The same five fields his Characteristic Template writes, and the
			 * defaults table under them. A note being created has nothing to lose,
			 * so the table costs nothing here — and a characteristic without one
			 * has no way to say what its value should be for a given class.
			 */
			/*
			 * The tag leads, the way it does on a class note: `tags:` is the first
			 * thing in his own notes and the first thing read off one.
			 */
			const content = '---\n'
				+ (action.tag ? 'tags:\n  - ' + action.tag + '\n' : '')
				+ 'characteristic meaning: \nproperty type: '
				+ (action.propertyType || '')
				+ '\nis base characteristic: ' + (action.isBase ? 'true' : 'false')
				+ '\npossible values: \n---\n\n'
				+ defaultsTableBlock().join('\n') + '\n';
			const made = await this.app.vault.create(action.path, content);
			/*
			 * The table is in the body, and the index that holds those is refreshed
			 * by Obsidian's events - which have not fired by the time the
			 * convergence loop builds its next plan. Without this the note it just
			 * created reads as one with no table, and the loop asks to append one
			 * for ever.
			 */
			if (made) this.rememberDefaults(made, content, true);
			return;
		}

		if (action.kind === 'add-defaults-table') {
			/*
			 * The one write into a body, and deliberately the dullest one possible:
			 * whatever is there, then the table. Nothing is parsed, nothing is
			 * moved, and no existing line is read — so there is no case in which
			 * this loses something he wrote.
			 */
			let written = null;
			const append = (data) => {
				written = hasDefaultsTable(data) ? String(data)
					: String(data).replace(/\s*$/, '')
						+ '\n\n' + defaultsTableBlock().join('\n') + '\n';
				return written;
			};
			if (typeof this.app.vault.process === 'function') {
				await this.app.vault.process(action.file, append);
			} else {
				/* Older Obsidian: read and write, which is the same thing less safely. */
				const data = await this.app.vault.read(action.file);
				const next = append(data);
				if (next !== data) await this.app.vault.modify(action.file, next);
			}
			/* Same reason as above: the loop re-plans before the event arrives. */
			if (written !== null) this.rememberDefaults(action.file, written, true);
			return;
		}

		if (action.kind === 'rename-defaults-value') {
			/*
			 * The third write into a body, and the narrowest of them. The table is
			 * found the way `parseDefaultsTable` finds it, and inside it only a cell
			 * holding exactly the old word is rewritten - so a row about something
			 * else, and every line outside the table, comes out byte-identical.
			 *
			 * Located again here rather than by the line numbers the plan carried:
			 * a note edited between the plan and the write is then changed in the
			 * right place, or not at all.
			 */
			let written = null;
			const rewrite = (data) => {
				const lines = String(data).split('\n');
				let map = null;
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.indexOf('|') === -1) { map = null; continue; }
					const header = defaultsColumnMap(tableCells(line));
					if (header) { map = header; continue; }
					if (!map || isTableRule(line)) continue;

					let next = line;
					for (const key of DEFAULTS_VALUE_KEYS) {
						if (map[key] === undefined) continue;
						const changed = rewriteTableCell(next, map[key], action.from, action.to);
						if (changed !== null) next = changed;
					}
					lines[i] = next;
				}
				written = lines.join('\n');
				return written;
			};

			if (typeof this.app.vault.process === 'function') {
				await this.app.vault.process(action.file, rewrite);
			} else {
				const data = await this.app.vault.read(action.file);
				const next = rewrite(data);
				if (next !== data) await this.app.vault.modify(action.file, next);
			}
			/* Same reason again: the loop re-plans before the event arrives. */
			if (written !== null) this.rememberDefaults(action.file, written, true);
			return;
		}

		if (action.kind === 'upgrade-defaults-table') {
			/*
			 * Located again here rather than by the line numbers the plan carried, the
			 * same as every other body write: a note edited in between is changed in
			 * the right place, or not at all. Only the lines of a defaults table are
			 * replaced, back to front so the earlier ranges keep their indices.
			 */
			let written = null;
			const upgrade = (data) => {
				const lines = String(data).split('\n');
				const tables = findLegacyDefaultsTables(data);
				for (let i = tables.length - 1; i >= 0; i--) {
					const table = tables[i];
					lines.splice(table.start, table.end - table.start + 1,
						...upgradeDefaultsTable(lines.slice(table.start, table.end + 1),
							table.map));
				}
				written = lines.join('\n');
				return written;
			};

			if (typeof this.app.vault.process === 'function') {
				await this.app.vault.process(action.file, upgrade);
			} else {
				const data = await this.app.vault.read(action.file);
				const next = upgrade(data);
				if (next !== data) await this.app.vault.modify(action.file, next);
			}
			/* Same reason as the other body writes: the loop re-plans before the event. */
			if (written !== null) this.rememberDefaults(action.file, written, true);
			return;
		}

		if (action.kind === 'retire-default-value' || action.kind === 'add-all-notes-row') {
			/*
			 * The fourth write into a body, and the only one that puts a value into
			 * the table rather than only moving words around inside it. It earns that
			 * because it is not new information: it is a value already in the note,
			 * moving to the one place that now holds it.
			 *
			 * The row goes in **first**. If the second write never lands the note says
			 * the same thing twice, which the next plan settles by removing the key —
			 * whereas removing the key first and failing to write the row loses the
			 * value outright.
			 *
			 * `add-all-notes-row` is the same write with nothing to put in the cell.
			 */
			const seeding = action.kind === 'add-all-notes-row';
			let written = null;
			if (seeding || !isEmptyValue(action.moveValue)) {
				/*
				 * Located here rather than by the line number the plan carried, the same
				 * as `rename-defaults-value`: a note edited in between is changed in the
				 * right place, or not at all. Only the *All notes* row of a defaults
				 * table is touched, and only its first value cell.
				 */
				const place = (data) => {
					const lines = String(data).split('\n');
					let map = null;
					let rule = -1;
					let done = false;

					for (let i = 0; i < lines.length && !done; i++) {
						const line = lines[i];
						if (line.indexOf('|') === -1) { map = null; continue; }
						const cells = tableCells(line);
						const header = defaultsColumnMap(cells);
						if (header) { map = header; rule = -1; continue; }
						if (!map) continue;
						if (isTableRule(line)) { rule = i; continue; }
						if (!isAllNotesLocation(cells[map.location])) continue;
						/*
						 * A row that appeared between the plan and the write. Seeding one
						 * has nothing to add to it, and blanking its cell would destroy a
						 * value he typed in the meantime.
						 */
						if (seeding) return String(data);
						lines[i] = allNotesRowWrite(line, action.moveValue, map);
						done = true;
					}

					/*
					 * No row to fill. Inserted directly under the header rule, where a
					 * seeded table puts it — never appended to the end of the table,
					 * which would land it after his own class rows.
					 */
					if (!done && rule !== -1) {
						lines.splice(rule + 1, 0, allNotesRowWrite(null, action.moveValue, null));
						done = true;
					}

					/*
					 * And no table either — which the plan only allows through when
					 * `add-defaults-table` is switched off, so there is nothing to wait
					 * for. Written as a whole table rather than dropped.
					 */
					if (!done) {
						const body = lines.join('\n').replace(/\s*$/, '');
						const table = defaultsTableBlock().slice(0, 2)
							.concat(allNotesRowWrite(null, action.moveValue, null));
						written = body + '\n\n' + table.join('\n') + '\n';
						return written;
					}

					written = lines.join('\n');
					return written;
				};

				if (typeof this.app.vault.process === 'function') {
					await this.app.vault.process(action.file, place);
				} else {
					const data = await this.app.vault.read(action.file);
					const next = place(data);
					if (next !== data) await this.app.vault.modify(action.file, next);
				}
				/* Same reason as the other body writes: the loop re-plans before the event. */
				if (written !== null) this.rememberDefaults(action.file, written, true);
			}

			if (!seeding) {
				await this.app.fileManager.processFrontMatter(
					action.file, this.frontmatterMutation(action));
			}
			return;
		}

		if (action.kind === 'write-rename-block') {
			/*
			 * The second write into a body, and the first that removed anything. It is
			 * still narrow: the blocks are located by their mark, and only the lines
			 * between a `<%*` and its `%>` are touched. Every other line comes out
			 * byte-identical — the same rule the .base surgery follows.
			 *
			 * The first block is rewritten in place and any others are removed. Keeping
			 * the *first* position rather than the last is what makes a repaired template
			 * byte-identical to one written from scratch, where the block sits directly
			 * below the frontmatter.
			 */
			let written = null;
			const rewrite = (data) => {
				const text = String(data);
				const found = findRenameBlocks(text);
				const block = action.format ? renameBlock(action.format) : null;

				if (found.blocks.length) {
					const lines = found.lines.slice();
					/* Back to front, so the earlier ranges keep their indices. */
					for (let i = found.blocks.length - 1; i >= 0; i--) {
						const range = found.blocks[i];
						if (i === 0 && block) {
							lines.splice(range.start, range.end - range.start + 1, ...block);
							continue;
						}
						/* Take the blank line above it too, or removal leaves a gap. */
						let from = range.start;
						while (from > 0 && lines[from - 1].trim() === '') from--;
						lines.splice(from, range.end - from + 1);
					}
					written = lines.join('\n');
				} else if (block) {
					written = text.replace(/\s*$/, '') + '\n\n' + block.join('\n') + '\n';
				} else {
					written = text;
				}
				return written;
			};

			if (typeof this.app.vault.process === 'function') {
				await this.app.vault.process(action.file, rewrite);
			} else {
				const data = await this.app.vault.read(action.file);
				const next = rewrite(data);
				if (next !== data) await this.app.vault.modify(action.file, next);
			}
			/* The loop re-plans before the vault event lands, so record it now. */
			if (written !== null) this.rememberRenameBlock(action.file, written, true);
			return;
		}

		if (action.kind === 'rename-template') {
			/*
			 * The file manager, so every link to the template is rewritten. Same
			 * collision guard as a characteristic: the vault may have changed since
			 * the plan was built.
			 */
			if (this.fileAt(action.target)) {
				new Notice('OOF Class Manager: "' + action.target + '" already exists, so "'
					+ action.file.basename + '" was left alone.', 8000);
				return;
			}
			await this.app.fileManager.renameFile(action.file, action.target);
			return;
		}

		if (action.kind === 'rename-characteristic') {
			/*
			 * Through the file manager, never the adapter: this is the one call that
			 * rewrites every link pointing at the note, and doing it by hand is how
			 * links get broken.
			 */
			if (this.fileAt(action.target)) {
				new Notice('OOF Class Manager: "' + action.target + '" already exists, so "'
					+ action.file.basename + '" was left alone.', 8000);
				return;
			}
			await this.app.fileManager.renameFile(action.file, action.target);
			return;
		}

		if (action.kind === 'trash-template' || action.kind === 'trash-base') {
			/* Trash, so it is recoverable — the same rule as a characteristic note. */
			if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(action.file);
			else await this.app.vault.trash(action.file, true);
			if (this.orphanBases) this.orphanBases.delete(action.path);
			return;
		}

		/*
		 * The frontmatter edits all run through one place, so the diff he is shown
		 * and the write he confirms cannot describe different things.
		 */
		if (['fill-datetime', 'fill-default', 'strip-redundant-link', 'strip-root-link',
			'describe-characteristic', 'update-instance',
			'rename-property', 'rename-value', 'apply-class'].indexOf(action.kind) !== -1) {
			const mutation = this.frontmatterMutation(action);
			await this.app.fileManager.processFrontMatter(action.file, mutation);
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
			await this.app.fileManager.processFrontMatter(
				action.file, this.frontmatterMutation(action));
			return;
		}

		if (action.kind === 'write-template') {
			await this.ensureFolder(this.settings.templatesFolder);
			let file = action.file;
			if (!file) file = await this.app.vault.create(action.path, '---\n---\n');

			/*
			 * Drops only the keys we manage, then lays them out in inheritance
			 * order. Anything else in the template is his and stays put — a
			 * Templater expression in the frontmatter, most of all. Shared with the
			 * diff view, so what it shows is what this writes.
			 */
			await this.app.fileManager.processFrontMatter(
				file, this.frontmatterMutation(action));
			return;
		}

		if (action.kind === 'write-base') {
			/*
			 * An existing base is his, full stop. The plan creates one that is not
			 * there and never touches one that is; rebuilding a base is done from
			 * its own toolbar, on the file, with the diff shown first.
			 */
			if (this.app.vault.getFileByPath(action.path)) return;

			await this.ensureFolder(this.settings.basesFolder);
			await this.app.vault.create(action.path, action.content);
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
			const link = this.namesCharacteristic(this.logicValueKind(property))
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

	/*
	 * `tags` to the top of the frontmatter, which is where every note of his that
	 * has one carries it — a class note opens with `tags:\n  - class`.
	 *
	 * `processFrontMatter` appends a key it has never seen, so without this a tag
	 * arriving on an existing characteristic note would land under `possible
	 * values`, while a note created by the same Update leads with it. Two spellings
	 * of one thing, decided by which came first.
	 *
	 * The other keys keep the order they were in: they are his, and the canonical
	 * order the rest of the plugin imposes is about *characteristics on a note*,
	 * which is not what a characteristic note's own frontmatter is.
	 */
	tagsFirst(frontmatter) {
		if (!frontmatter || !('tags' in frontmatter)) return;

		const snapshot = {};
		for (const key of Object.keys(frontmatter)) snapshot[key] = frontmatter[key];
		for (const key of Object.keys(frontmatter)) delete frontmatter[key];

		frontmatter.tags = snapshot.tags;
		for (const key of Object.keys(snapshot)) {
			if (key !== 'tags') frontmatter[key] = snapshot[key];
		}
	}

	/*
	 * One tag off `tags`, leaving every other tag exactly as it was — his own are
	 * on these notes too, and only the one named here is ours to take.
	 *
	 * It can only reach frontmatter. A tag written `#characteristic` in the body
	 * is in his prose, and this plugin does not edit bodies except in the three
	 * places that say so.
	 */
	removeTag(frontmatter, tag) {
		if (!tag || !frontmatter) return;

		const bare = String(tag).replace(/^#/, '');
		const existing = toArray(frontmatter.tags)
			.filter((entry) => typeof entry === 'string');
		const kept = existing.filter((entry) => entry.replace(/^#/, '') !== bare);
		if (kept.length === existing.length) return;

		/* An emptied list is written as nothing, not as `tags: []`. */
		frontmatter.tags = kept.length > 0 ? kept : null;
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

		/* The prefix belongs to characteristics; a class carrying it is a mistake. */
		if (this.looksLikeCharacteristic(name)) {
			return { ok: false, reason: '"' + this.settings.characteristicPrefix
				+ '" starts the name of a characteristic, not a class.' };
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
		await this.persist();

		return { ok: true, renamed: renamed };
	}

	/* What a rename would touch, for the confirmation. */
	/*
	 * What a class leaves behind: the notes that call themselves one of it, and
	 * the classes that descend from it. Neither is touched by deleting it — a note
	 * is his, and a class below it is a class — but both end up pointing at
	 * nothing, so the dialog names them before anything moves.
	 */
	deleteFallout(name) {
		const objects = this.scanClasses();
		const drafts = this.allDrafts(objects);

		const children = [];
		for (const [other, draft] of drafts) {
			if (other === name) continue;
			if ((draft.parents || []).indexOf(name) !== -1) children.push(other);
		}

		const instances = [];
		for (const found of this.scanInstances(objects)) {
			if (found.classes.indexOf(name) !== -1) instances.push(found.file.basename);
		}

		return { children: children, instances: instances };
	}

	/*
	 * Delete a class: its note, its template and its base, to the **trash**.
	 *
	 * Straight away rather than on Update, for the reason rename is: it moves
	 * files, and a deletion left pending would leave the panel showing a class the
	 * vault is meant to be rid of. Trash rather than erase, the same as every other
	 * removal here — this is the one action in the plugin that takes away a note he
	 * wrote, so it has to be undoable by the ordinary means.
	 */
	async deleteClass(name) {
		const objects = this.scanClasses();
		const klass = objects.get(name);
		const trashed = [];

		const bin = async (file) => {
			if (!file) return;
			if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(file);
			else await this.app.vault.trash(file, true);
			trashed.push(file.path);
		};

		await bin(klass && klass.file);
		await bin(this.app.vault.getFileByPath(this.templatePathFor(name)));
		await bin(this.app.vault.getFileByPath(this.basePathFor(name)));

		/* Everything the panel remembers about it goes too, or it comes back. */
		this.drafts.delete(name);
		this.expanded.delete(name);
		if (this.symbolWrites) this.symbolWrites.delete(name);
		await this.persist();

		this.invalidateClosures();
		this.invalidatePicture();
		return { ok: true, trashed: trashed };
	}

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
	/*
	 * Making a note that already exists an instance of a class: what `is a` will
	 * say, which keys arrive with it, and what is being displaced. Pure — it
	 * builds the action and reads the situation, and writes nothing.
	 *
	 * Returns a `reason` instead of an action when there is nothing sensible to
	 * do, so the caller can say why rather than silently doing nothing.
	 */
	applyClassAction(classNames, file) {
		/*
		 * One class or several — a custom selection can hold any number, and its
		 * meaning is "make the note all of these at once", not "do this five
		 * times". So the whole action is built from a list, and one name is a list
		 * of one rather than a separate path through here.
		 */
		const names = Array.isArray(classNames) ? classNames.slice() : [classNames];

		if (names.length === 0) {
			return { reason: 'Nothing is selected, so there is no class to apply.' };
		}
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return { reason: 'Open a note first — there is nothing to apply a class to.' };
		}

		const objects = this.scanClasses();
		const drafts = this.allDrafts(objects);

		for (const className of names) {
			if (!drafts.has(className)) {
				return { reason: '"' + className + '" is not a class yet. Press Update first.' };
			}

			/*
			 * Applying a class writes `is a`, and nothing is `is a` a component —
			 * so the refusal belongs here as well as on the button, for every way
			 * in that is not the button.
			 */
			if (this.isComponent(className)) {
				return { reason: this.componentRefusal([className]) };
			}

			/*
			 * A class note is not an instance of another class by `is a` — that is
			 * what `type of` is for, and writing `is a` between two classes is the
			 * mistake the whole two-relations design exists to prevent.
			 */
			const target = drafts.get(className);
			if (target && target.file && target.file.path === file.path) {
				return { reason: '"' + className + '" is that class. A class is not an '
					+ 'instance of itself.' };
			}
		}

		if (drafts.has(file.basename) && objects.has(file.basename)) {
			return { reason: '"' + file.basename + '" is a class. To put a class under '
				+ 'another, use `' + this.settings.inheritsProperty + '` on its card, not `'
				+ this.settings.isAProperty + '`.' };
		}

		const frontmatter = this.frontmatterOf(file) || {};
		const current = toArray(frontmatter[this.settings.isAProperty])
			.map(linkName).filter((name) => !!name);

		/*
		 * Already exactly these, case-insensitively, because that is how Obsidian
		 * resolves the link. Order does not count: `is a` is a set, and rewriting
		 * the property to say the same thing in another order is not a change worth
		 * a confirmation.
		 */
		const same = (list) => list.map((n) => n.toLowerCase()).sort().join('\u0000');
		if (current.length === names.length && same(current) === same(names)) {
			return { reason: '"' + file.basename + '" is already '
				+ andList(names.map((n) => article(n) + ' ' + n)) + '.' };
		}

		/*
		 * The union of what all of them declare, in the order the classes were
		 * given, each class's own order within that. A characteristic two of them
		 * share is one key, not two.
		 *
		 * Through `carriedKeys`, which is the one answer to *what keys does a note
		 * carry* - so the classes' **component fields** arrive as well, and where this
		 * note has already filled one, whatever that class brings. Applying `Goal` to
		 * a note used to leave out `goal type` and `goal subject` entirely, and the
		 * next Update would add them; two paths answering one question differently is
		 * how the answer drifts.
		 */
		const expected = this.carriedKeys(names, frontmatter, objects, drafts).keys;
		const add = expected.filter((key) => !(key in frontmatter));

		/*
		 * Keys the note carries that the new classes do not declare. Not removed —
		 * see the mutation — but he is told, because that is the surprising half of
		 * changing a note's class.
		 */
		const characteristics = this.scanCharacteristics();
		const kept = Object.keys(frontmatter).filter((key) =>
			key !== this.settings.isAProperty
			&& !this.isIgnoredProperty(key)
			&& !this.settings.logicProperties.includes(key)
			&& expected.indexOf(key) === -1
			&& characteristics.has(key));

		return {
			action: {
				kind: 'apply-class',
				/* `object` is the label everything downstream already reads. */
				object: names[0],
				objects: names,
				file: file,
				path: file.path,
				add: add,
			},
			names: names,
			replacing: current,
			add: add,
			kept: kept,
		};
	}

	/*
	 * The name a new instance is given, from the same *Unique file name* format
	 * the templates carry.
	 *
	 * Formatted here rather than left to the template's own block, because
	 * `createInstance` falls back to copying the template when Templater is not
	 * available — and on that path nothing expands the block at all, so the note
	 * would be called "Untitled" and carry the block as literal text. Deciding the
	 * name up front makes it right on both paths, and the block then sees a title
	 * that is not "Untitled" and stands down.
	 *
	 * `obsidian.moment` and not `formatMoment`: that one knows six tokens, and the
	 * default format uses `dddd`, which it would leave standing in the file name.
	 */
	uniqueInstanceName(format, folder) {
		const target = folder || this.settings.notesFolder;
		const stamp = obsidian.moment().format(format);
		let name = stamp;
		for (let n = 2; this.app.vault.getAbstractFileByPath(target + '/' + name + '.md'); n++) {
			name = stamp + ' ' + n;
		}
		return name;
	}

	async createInstance(objectName, noteName, folder) {
		/*
		 * A component has no template, so this would fail anyway — but it would
		 * fail saying "press Update first", which is advice that can never work.
		 * The panel's button is already refused; this is the same refusal for
		 * every other way in.
		 */
		if (this.isComponent(objectName)) {
			new Notice('OOF Class Manager: ' + this.componentRefusal([objectName]), 6000);
			return null;
		}

		const templatePath = this.templatePathFor(objectName);
		const template = this.app.vault.getFileByPath(templatePath);
		if (!(template instanceof TFile)) {
			new Notice('OOF Class Manager: no template for "' + objectName + '" yet. Press Update first.', 6000);
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


	/*
	 * An instance of several classes at once — his `is a` will name all of them.
	 *
	 * **It is made from the first one's template**, and that is the only answer
	 * available: a note is created from one file, and the templates are one per
	 * class. So the first class selected is the primary one — it decides the body,
	 * the folder and whatever Templater runs — and the rest arrive afterwards as
	 * `is a` entries and as their characteristics, added empty.
	 *
	 * Written through `processFrontMatter` like every other write, and into a note
	 * that was created a moment ago by us, so there is nothing of his to lose.
	 */
	async createInstanceOfMany(names, noteName, folder) {
		/*
		 * Every one of them, not only the first: the new note's `is a` names them
		 * all, so one component anywhere in the list is one note that is a
		 * component.
		 */
		const refusal = this.componentRefusal(names);
		if (refusal) {
			new Notice('OOF Class Manager: ' + refusal, 6000);
			return null;
		}

		const file = await this.createInstance(names[0], noteName, folder);
		if (!(file instanceof TFile) || names.length < 2) return file;

		const objects = this.scanClasses();
		const drafts = this.allDrafts(objects);

		/*
		 * The union, in the order the classes were selected - through `carriedKeys`
		 * for the same reason as everywhere else, so the later classes' component
		 * fields arrive empty rather than being left for the next Update to notice.
		 * The frontmatter is read too: the first class's template has already run, and
		 * may have filled a component field in.
		 */
		const expected = this.carriedKeys(
			names, this.frontmatterOf(file), objects, drafts).keys;

		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[this.settings.isAProperty] = names.map(asLink);
			/*
			 * Never overwritten: the template may have filled one in, and a default
			 * value it wrote is exactly the kind of thing this must not undo.
			 */
			for (const key of expected) if (!(key in fm)) fm[key] = null;
		});

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
			this.migrations.add('defaults-table-on');
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
			/*
			 * The base characteristics are the plugin's list, not his (2026-09-01):
			 * *"All base characteristics should be added in the backend."* So a
			 * stored copy is **overwritten** rather than merged, and anything it
			 * names that the code does not is *retired* rather than simply dropped -
			 * the same mechanism the chip's × used to drive, so Update still clears
			 * the orphan key off every class that still carries it.
			 *
			 * The rename is applied first, or `inherits from` in an old stored list
			 * would be retired and Update would go looking for a key to clear that
			 * his notes stopped using months ago.
			 *
			 * **This runs on every load, and that is the point.** A one-shot
			 * migration is right where a value is legitimately his to set straight
			 * back - the sort below is exactly that - but here there is no way to set
			 * it back, so a stored list outranking the code even once would be the
			 * feature not existing.
			 */
			const strayBase = toArray(stored.logicProperties)
				.map((property) => (property === 'inherits from'
					? DEFAULT_SETTINGS.inheritsProperty
					: property))
				.filter((property) => BASE_CHARACTERISTICS.indexOf(property) === -1);

			stored.logicProperties = BASE_CHARACTERISTICS.slice();
			stored.retiredLogicProperties = Array.from(new Set(
				toArray(stored.retiredLogicProperties)
					.concat(strayBase)
					.filter((property) => BASE_CHARACTERISTICS.indexOf(property) === -1)));

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
			 * A folded group is remembered by the heading's own text, so renaming
			 * a heading would quietly unfold it. Carried across rather than
			 * dropped: he folded a section, not a string.
			 */
			if (Array.isArray(stored.collapsedGroups)
				&& stored.collapsedGroups.indexOf(RETIRED_NATIVE_LABEL) !== -1) {
				stored.collapsedGroups = stored.collapsedGroups
					.map((name) => (name === RETIRED_NATIVE_LABEL ? NATIVE_LABEL : name))
					.filter((name, index, all) => all.indexOf(name) === index);
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

			/*
			 * The defaults table shipped for one version with *Every characteristic
			 * note carries the table* off, so any vault that ran it has `false`
			 * stored - and a value saved once outranks every default that follows,
			 * which is exactly the trap the comment above describes. Turning it on
			 * in DEFAULT_SETTINGS therefore did nothing at all for the one vault the
			 * plugin actually runs in.
			 *
			 * One-shot for the same reason as the sort: off is also a legitimate
			 * choice, so this must not overrule him twice.
			 */
			if (!this.migrations.has('defaults-table-on')) {
				stored.seedDefaultsTable = true;
				this.migrations.add('defaults-table-on');
				this.migrationPending = true;
			}

			/*
			 * `cover image` was added to the native attributes 2026-08-24. Adding it
			 * to the default reaches nobody who already has the plugin — a value
			 * saved once outranks every default that follows — so it is added to the
			 * stored list instead.
			 *
			 * One-shot, and *added* rather than the list being replaced: the list
			 * may be his by now, and replacing it would throw away whatever else he
			 * had put there. Running once is what leaves him free to take it out
			 * again.
			 */
			if (!this.migrations.has('cover-image-native')) {
				/*
				 * Only an **untouched** list, the same test the retired default gets
				 * above: if it matches the previous default exactly he never chose
				 * it, so the new default is what he asked for. A list he has edited
				 * is his, and appending to it on his behalf is the thing this file
				 * keeps promising not to do.
				 */
				if (sameNameList(toArray(stored.ignoredProperties), PREVIOUS_IGNORED_DEFAULT)) {
					stored.ignoredProperties = DEFAULT_SETTINGS.ignoredProperties.slice();
				}
				this.migrations.add('cover-image-native');
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

				const restored = { values: values };
				/* Only when it was actually edited — see `draftOf`. */
				if ('symbol' in draft) restored.symbol = draft.symbol;
				this.drafts.set(name, restored);
			}
		}

		if (data.symbolWrites) {
			for (const name of Object.keys(data.symbolWrites)) {
				this.symbolWrites.set(name, data.symbolWrites[name]);
			}
		}

		this.dynamicBaseOurs = !!data.dynamicBase;

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
			symbolWrites: (() => {
				const out = {};
				for (const [name, value] of (this.symbolWrites || new Map())) out[name] = value;
				return out;
			})(),
			expanded: Array.from(this.expanded),
			dismissed: Array.from(this.dismissed),
			migrations: Array.from(this.migrations || []),
			/*
			 * That the dynamic base at that path is ours to rewrite. Remembered
			 * rather than sniffed out of the file, because a marker inside a `.base`
			 * would be a line Obsidian's own base editor is entitled to drop.
			 */
			dynamicBase: !!this.dynamicBaseOurs,
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
		/*
		 * Every cached answer depends on the settings that produced it: the picture
		 * is built from the folder names, and the `is a` closures from the property
		 * names and the root. Changing one and keeping the other was a real bug -
		 * setting a root class did nothing visible, because the discrepancy pass
		 * and `file.isA()` were still answering from before it.
		 *
		 * Dropping both here rather than in each handler means it cannot be
		 * forgotten for the next setting either.
		 */
		this.invalidatePicture();
		this.invalidateClosures();
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
		await this.persist();
	}

	refreshViews() {
		/*
		 * Both tabs, since 2.98.0. A setting that changes what the panel says
		 * changes what the diagram draws — they read one picture — and leaving the
		 * diagram out would have made it the one place a settings change did not
		 * reach.
		 */
		for (const type of [VIEW_TYPE, UML_VIEW_TYPE]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
			}
		}
	}
}

/* --------------------------------------------------- the class diagram tab */

/*
 * The UML view. It draws `umlDiagram()` and decides nothing about it — every
 * question of what a box says or where it goes is answered before this class is
 * reached, which is the same division the panel keeps with `picture()`.
 *
 * SVG built through `createElementNS` rather than Obsidian's `createSvg`, for
 * one reason: this is the only file in the plugin that draws vector graphics,
 * and the namespace call is the part that has to be right whichever helper wraps
 * it.
 */
class UmlView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		/*
		 * Search and focus are where you are in a piece of work rather than
		 * preferences, so neither is persisted — the same reading the panel's
		 * selection gets. The four toggles *are* preferences and live in settings.
		 */
		this.query = '';
		this.focus = '';
		this.viewBox = null;
	}

	getViewType() { return UML_VIEW_TYPE; }
	getDisplayText() { return 'Class diagram'; }
	getIcon() { return 'workflow'; }

	async onOpen() {
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (this.plugin.inPictureFolders(file)) this.queueRender();
		}));
		this.registerEvent(this.app.vault.on('delete', () => this.queueRender()));
		this.registerEvent(this.app.vault.on('rename', () => this.queueRender()));
		/* Only when following: otherwise a diagram you arranged is left alone. */
		this.registerEvent(this.app.workspace.on('file-open', () => {
			if (this.following) this.render();
		}));
		this.render();
	}

	/*
	 * The panel's own coalescing, for the same reason it has it: typing in a note
	 * inside the notes folder fires `changed` on every keystroke, and a redraw
	 * here is a whole layout rather than a list.
	 */
	queueRender() {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.setTimeout(() => {
			this.renderQueued = false;
			this.render();
		}, 400);
	}

	settings() { return this.plugin.settings; }

	async setToggle(key, value) {
		this.plugin.settings[key] = value;
		await this.plugin.persist();
		this.render();
	}

	/* --------------------------------------------------------------- drawing */

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('oof-uml');

		const settings = this.settings();

		/*
		 * Following the active note is a *focus*, worked out at draw time rather
		 * than stored: what the note is about can change without the diagram being
		 * touched, and a stored answer would go stale exactly the way the panel's
		 * old `getActiveFile()` fallback did.
		 */
		this.following = !!settings.umlFollowActiveNote;
		if (this.following) {
			const active = this.app.workspace.getActiveFile();
			const objects = this.plugin.scanClasses();
			const about = this.plugin.activeClassesFor(active, objects,
				this.plugin.allDrafts(objects));
			this.focus = (about.names && about.names[0]) || '';
		}

		const diagram = this.plugin.umlDiagram({
			inherited: settings.umlShowInherited,
			components: settings.umlShowComponents,
			instances: settings.umlShowCounts,
			root: settings.umlShowRoot,
			focus: this.focus,
		});
		const layout = this.plugin.umlLayout(diagram);

		this.drawToolbar(container, diagram);

		const stage = container.createDiv({ cls: 'oof-uml-stage' });
		if (diagram.nodes.length === 0) {
			stage.createDiv({ cls: 'oof-uml-empty',
				text: this.focus
					? 'Nothing to draw for ' + this.focus + '.'
					: 'No classes yet. A note becomes one by carrying the class tag, '
						+ 'declaring characteristics, or naming a parent.' });
			return;
		}

		this.drawDiagram(stage, diagram, layout);
		this.applyQuery();
	}

	drawToolbar(container, diagram) {
		const settings = this.settings();
		const bar = container.createDiv({ cls: 'oof-uml-bar' });

		const count = bar.createDiv({ cls: 'oof-uml-count' });
		count.createSpan({ cls: 'oof-uml-count-number', text: String(diagram.nodes.length) });
		count.createSpan({ text: diagram.nodes.length === 1 ? ' class' : ' classes' });

		if (this.focus) {
			const chip = bar.createDiv({ cls: 'oof-uml-chip' });
			chip.createSpan({ text: this.focus });
			const clear = chip.createSpan({ cls: 'oof-uml-chip-clear', text: '×' });
			clear.setAttribute('aria-label', 'Show every class again');
			clear.onclick = () => {
				this.focus = '';
				/* Clearing by hand also stops the following that put it there. */
				if (this.following) {
					this.setToggle('umlFollowActiveNote', false);
					return;
				}
				this.viewBox = null;
				this.render();
			};
		}

		const search = bar.createEl('input', { cls: 'oof-uml-search',
			attr: { type: 'text', placeholder: 'Find a class…', value: this.query } });
		search.oninput = () => {
			this.query = search.value;
			/*
			 * Dimming rather than redrawing. A search that relaid the diagram would
			 * move every box on every keystroke, and the thing you were looking for
			 * would never be where you last saw it.
			 */
			this.applyQuery();
		};

		const toggles = bar.createDiv({ cls: 'oof-uml-toggles' });
		const toggle = (key, label, tooltip) => {
			const button = toggles.createEl('button',
				{ cls: 'oof-uml-toggle' + (settings[key] ? ' is-on' : ''), text: label });
			button.setAttribute('aria-label', tooltip);
			button.onclick = () => this.setToggle(key, !settings[key]);
		};
		toggle('umlShowInherited', 'inherited',
			'The greyed compartment: what an ancestor declared');
		toggle('umlShowComponents', 'components',
			'Composition edges, from a component field’s possible values');
		toggle('umlShowCounts', 'counts', 'Instances and subtypes, under each box');
		toggle('umlShowRoot', 'root',
			'The implicit edge every class has to ' + (settings.rootClass || 'the root class'));
		toggle('umlFollowActiveNote', 'follow',
			'Draw only what the note you are reading is about');

		const zoom = bar.createDiv({ cls: 'oof-uml-zoom' });
		const step = (factor) => {
			if (!this.viewBox) return;
			const box = this.viewBox;
			const width = box.w * factor;
			const height = box.h * factor;
			this.setViewBox({ x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2,
				w: width, h: height });
		};
		const zoomButton = (label, tooltip, run) => {
			const button = zoom.createEl('button', { cls: 'oof-uml-zoom-button', text: label });
			button.setAttribute('aria-label', tooltip);
			button.onclick = run;
		};
		zoomButton('−', 'Zoom out', () => step(1.25));
		zoomButton('+', 'Zoom in', () => step(0.8));
		zoomButton('fit', 'Fit the whole diagram', () => {
			this.viewBox = null;
			this.render();
		});
	}

	/*
	 * A Lucide symbol, drawn as an icon.
	 *
	 * `setIcon` builds a real `<svg viewBox="0 0 24 24">` in the SVG namespace, so
	 * it nests inside this diagram and takes `x`/`y`/`width`/`height` like any
	 * other child — checked in the running app before this was written, because a
	 * foreign element that silently measures 0×0 is exactly the failure this
	 * whole feature is a fix for.
	 *
	 * Its own class is **added to**, never replaced: `svg-icon` is what carries
	 * Obsidian's stroke width and `currentColor`, so overwriting the attribute
	 * would draw a correctly placed invisible icon.
	 */
	drawIcon(group, name, x, y, size) {
		if (typeof setIcon !== 'function') return null;
		const holder = document.createElement('div');
		setIcon(holder, name);
		const icon = holder.firstElementChild;
		if (!icon) return null;

		icon.setAttribute('x', String(x));
		icon.setAttribute('y', String(y));
		icon.setAttribute('width', String(size));
		icon.setAttribute('height', String(size));
		icon.classList.add('oof-uml-icon');
		group.appendChild(icon);
		return icon;
	}

	svg(tag, attrs, parent) {
		const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const key of Object.keys(attrs || {})) {
			if (attrs[key] === null || attrs[key] === undefined) continue;
			el.setAttribute(key, String(attrs[key]));
		}
		if (parent) parent.appendChild(el);
		return el;
	}

	drawDiagram(stage, diagram, layout) {
		const svg = this.svg('svg', {
			class: 'oof-uml-svg',
			preserveAspectRatio: 'xMidYMid meet',
		}, stage);
		this.svgEl = svg;

		if (!this.viewBox || this.lastSize !== layout.width + 'x' + layout.height) {
			this.viewBox = { x: 0, y: 0, w: layout.width, h: layout.height };
		}
		this.lastSize = layout.width + 'x' + layout.height;
		this.setViewBox(this.viewBox);

		this.drawMarkers(svg);

		const byName = new Map(diagram.nodes.map((node) => [node.name, node]));
		const edgeLayer = this.svg('g', { class: 'oof-uml-edges' }, svg);
		const nodeLayer = this.svg('g', { class: 'oof-uml-nodes' }, svg);

		this.drawGeneralizations(edgeLayer, diagram, byName);
		this.drawCompositions(edgeLayer, diagram, byName);
		for (const node of diagram.nodes) this.drawNode(nodeLayer, node);

		this.wirePointer(svg);
	}

	/*
	 * The two arrowheads UML is read by. Both are `userSpaceOnUse` in effect —
	 * `markerUnits: userSpaceOnUse` — so they keep one size whatever the line
	 * weight, and the hollow triangle is filled with the pane's own background
	 * rather than left open, or the edge shows through it.
	 */
	drawMarkers(svg) {
		const defs = this.svg('defs', {}, svg);

		const triangle = this.svg('marker', {
			id: 'oof-uml-generalization', viewBox: '0 0 12 12',
			refX: 11, refY: 6, markerWidth: 12, markerHeight: 12,
			markerUnits: 'userSpaceOnUse', orient: 'auto',
		}, defs);
		this.svg('path', { d: 'M0,0 L12,6 L0,12 z', class: 'oof-uml-arrow-hollow' }, triangle);

		const diamond = this.svg('marker', {
			id: 'oof-uml-composition', viewBox: '0 0 14 10',
			refX: 1, refY: 5, markerWidth: 14, markerHeight: 10,
			markerUnits: 'userSpaceOnUse', orient: 'auto',
		}, defs);
		this.svg('path', { d: 'M0,5 L7,0 L14,5 L7,10 z', class: 'oof-uml-arrow-solid' }, diamond);
	}

	/*
	 * Generalization, drawn the way UML draws it: straight up out of the child,
	 * across, and into the parent's underside behind one hollow triangle.
	 *
	 * The children of one parent are **fanned across its lower edge** rather than
	 * all meeting at its centre. Two reasons, and the second is the one that
	 * matters: a shared point makes six edges into one thick stem you cannot
	 * follow, and it puts six arrowheads on top of each other, so the triangle —
	 * the mark that says which relation this is — stops being legible at exactly
	 * the class that has the most of them.
	 */
	drawGeneralizations(layer, diagram, byName) {
		const groups = new Map();
		for (const edge of diagram.edges) {
			if (edge.kind !== 'generalization') continue;
			if (!groups.has(edge.to)) groups.set(edge.to, []);
			groups.get(edge.to).push(edge);
		}

		for (const [parentName, edges] of groups) {
			const parent = byName.get(parentName);
			edges.sort((a, b) => byName.get(a.from).x - byName.get(b.from).x);

			edges.forEach((edge, index) => {
				const child = byName.get(edge.from);
				const at = parent.x + parent.width * (index + 1) / (edges.length + 1);
				const from = { x: child.x + child.width / 2, y: child.y };
				const to = { x: at, y: parent.y + parent.height };

				/*
				 * The elbow only works while the child sits below the parent, which
				 * depth guarantees — except around a `type of` cycle, where depth
				 * refuses to decide. A straight line there rather than a path that
				 * doubles back through both boxes.
				 */
				const path = from.y > to.y
					? 'M' + from.x + ',' + from.y + ' V' + ((from.y + to.y) / 2)
						+ ' H' + to.x + ' V' + to.y
					: 'M' + from.x + ',' + from.y + ' L' + to.x + ',' + to.y;

				const line = this.svg('path', {
					d: path,
					class: 'oof-uml-edge oof-uml-generalization'
						+ (edge.implicit ? ' is-implicit' : ''),
					'marker-end': 'url(#oof-uml-generalization)',
				}, layer);
				line.setAttribute('data-from', edge.from);
				line.setAttribute('data-to', edge.to);
			});
		}
	}

	/*
	 * Composition, which does not respect the layers: a component field may point
	 * anywhere, so these are curves between the nearest sides rather than elbows,
	 * and they carry the field's name because *which* field it is is the whole
	 * content of the edge.
	 */
	drawCompositions(layer, diagram, byName) {
		for (const edge of diagram.edges) {
			if (edge.kind !== 'composition') continue;
			const from = byName.get(edge.from);
			const to = byName.get(edge.to);

			const rightwards = to.x + to.width / 2 >= from.x + from.width / 2;
			const start = { x: rightwards ? from.x + from.width : from.x,
				y: from.y + from.height / 2 };
			const end = { x: rightwards ? to.x : to.x + to.width, y: to.y + to.height / 2 };
			const reach = Math.max(40, Math.abs(end.x - start.x) / 2);
			const bend = rightwards ? reach : -reach;

			const line = this.svg('path', {
				d: 'M' + start.x + ',' + start.y
					+ ' C' + (start.x + bend) + ',' + start.y
					+ ' ' + (end.x - bend) + ',' + end.y
					+ ' ' + end.x + ',' + end.y,
				class: 'oof-uml-edge oof-uml-composition',
				/*
				 * The diamond and nothing else. UML draws composition as a plain line
				 * with the filled diamond at the **whole** — the class holding the
				 * field — and an arrowhead at the far end is a separate claim
				 * (navigability) that this diagram is not making. His correction,
				 * 2026-09-05, and the right one: the line already reads left to right
				 * from the diamond, so the arrow was saying a second time what the
				 * diamond had said, in a notation that means something else.
				 */
				'marker-start': 'url(#oof-uml-composition)',
			}, layer);
			line.setAttribute('data-from', edge.from);
			line.setAttribute('data-to', edge.to);

			if (!edge.label) continue;
			const label = this.svg('text', {
				x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4,
				class: 'oof-uml-edge-label', 'text-anchor': 'middle',
			}, layer);
			label.textContent = edge.label;
		}
	}

	drawNode(layer, node) {
		const group = this.svg('g', {
			class: 'oof-uml-node' + (node.isDraft ? ' is-draft' : '')
				+ (node.isMissing ? ' is-missing' : '')
				+ (node.dangling.length > 0 ? ' is-faulty' : ''),
			transform: 'translate(' + node.x + ',' + node.y + ')',
		}, layer);
		group.setAttribute('data-name', node.name);
		/*
		 * What the search reads, written down here rather than scraped off the
		 * drawing afterwards.
		 *
		 * `textContent` looked like the free version of this and is not: an SVG
		 * `<title>` is a child element, so every tooltip is part of it, and a box
		 * whose inherited row says *from Sculpture* answered to "sculpture". The
		 * string is built from the model instead, so what a search matches is what
		 * the class actually carries.
		 *
		 * **What it declares, not what it carries.** Searching `location` lights
		 * the classes that introduce it, not the nineteen that inherit it — which
		 * is the panel's own rule for a characteristic note, and the readable
		 * answer for the same reason: the inherited half is a consequence, and a
		 * search that returned every consequence would return most of the vault.
		 */
		group.setAttribute('data-search', [node.name]
			.concat(node.own.concat(node.ownFields).map((row) => row.name))
			.join(' ').toLowerCase());
		group.onmouseenter = () => this.light(node.name);
		group.onmouseleave = () => this.light('');

		/*
		 * The tooltip belongs to the whole group, not to the name: a `<title>` as
		 * a child of the `<g>` is what SVG reads for the box, and hovering anywhere
		 * on a class is when you want to be told what state it is in.
		 */
		let says = 'Open ' + node.name;
		if (node.isDraft) says = node.name + ' — drafted in the panel, not written yet';
		else if (node.isMissing) says = node.name + ' — named by a `type of`, with no note';
		this.svg('title', {}, group).textContent = says;

		this.svg('rect', { x: 0, y: 0, width: node.width, height: node.height,
			rx: 4, class: 'oof-uml-box' }, group);

		/*
		 * The icon and the name are centred **as a pair**, not the name alone with
		 * the icon hung off it — otherwise a class with an icon reads as a name
		 * pushed to the right of its box.
		 *
		 * The text width is the same estimate the layout sized the box with, so the
		 * two cannot disagree: whatever the estimate is wrong by, it is wrong by
		 * equally in both places.
		 */
		const textWidth = node.title.length * UML.charWidth;
		const pairWidth = textWidth + (node.icon ? UML.iconSize + UML.iconGap : 0);
		const left = (node.width - pairWidth) / 2;

		if (node.icon) {
			this.drawIcon(group, node.icon, left,
				(UML.headerHeight - UML.iconSize) / 2, UML.iconSize);
		}

		const title = this.svg('text', {
			x: left + pairWidth - textWidth / 2, y: UML.headerHeight / 2 + 4,
			class: 'oof-uml-name', 'text-anchor': 'middle',
		}, group);
		title.textContent = node.title;

		/*
		 * The name opens the note; the box does not. A box is most of the target
		 * and you land on one every time you finish a drag, so opening from it
		 * would make panning a way to lose your place.
		 */
		title.onclick = (event) => {
			if (!node.file) return;
			event.stopPropagation();
			this.app.workspace.getLeaf(event.ctrlKey || event.metaKey).openFile(node.file);
		};

		let y = UML.headerHeight;
		this.svg('line', { x1: 0, y1: y, x2: node.width, y2: y, class: 'oof-uml-rule' }, group);

		for (const compartment of node.compartments) {
			y += UML.compartmentPad;
			for (const row of compartment.rows) {
				const text = this.svg('text', {
					x: UML.padX, y: y + UML.rowHeight - 5,
					class: 'oof-uml-row is-' + compartment.kind + ' is-' + row.kind,
				}, group);
				text.textContent = umlRowText(row);
				if (row.from) {
					this.svg('title', {}, text).textContent = 'from ' + row.from;
				}
				y += UML.rowHeight;
			}
			y += UML.compartmentPad;
			if (compartment !== node.compartments[node.compartments.length - 1]) {
				this.svg('line', { x1: 0, y1: y, x2: node.width, y2: y,
					class: 'oof-uml-rule is-soft' }, group);
			}
		}

		if (!node.footer) return;
		this.svg('line', { x1: 0, y1: y, x2: node.width, y2: y,
			class: 'oof-uml-rule is-soft' }, group);
		const footer = this.svg('text', {
			x: node.width / 2, y: y + UML.footerHeight - 4,
			class: 'oof-uml-footer', 'text-anchor': 'middle',
		}, group);
		footer.textContent = node.footer;
	}


	/*
	 * Hovering a class lights what it is joined to and dims the rest.
	 *
	 * Done by class on elements already drawn, not by redrawing: a diagram that
	 * rebuilt itself under the pointer would flicker on every crossing, and the
	 * edge you were following would be a different element by the time you got to
	 * the end of it. The lit set is grown from the *edges* rather than recomputed
	 * from the model, so what lights up is exactly what is drawn — a composition
	 * edge hidden by its toggle cannot light a class that is not there.
	 */
	light(name) {
		const svg = this.svgEl;
		if (!svg) return;
		svg.classList.toggle('is-lighting', !!name);

		const related = new Set(name ? [name] : []);
		for (const edge of Array.from(svg.querySelectorAll('.oof-uml-edge'))) {
			const on = !!name && (edge.getAttribute('data-from') === name
				|| edge.getAttribute('data-to') === name);
			edge.classList.toggle('is-lit', on);
			if (!on) continue;
			related.add(edge.getAttribute('data-from'));
			related.add(edge.getAttribute('data-to'));
		}
		for (const group of Array.from(svg.querySelectorAll('.oof-uml-node'))) {
			group.classList.toggle('is-lit', related.has(group.getAttribute('data-name')));
		}
	}

	/* ------------------------------------------------------ pan, zoom, search */

	setViewBox(box) {
		this.viewBox = box;
		if (!this.svgEl) return;
		this.svgEl.setAttribute('viewBox',
			box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h);
	}

	wirePointer(svg) {
		let dragging = null;

		svg.onmousedown = (event) => {
			if (event.button !== 0) return;
			dragging = { x: event.clientX, y: event.clientY,
				box: Object.assign({}, this.viewBox) };
			svg.classList.add('is-dragging');
		};
		const stop = () => {
			dragging = null;
			svg.classList.remove('is-dragging');
		};
		svg.onmouseup = stop;
		svg.onmouseleave = stop;

		svg.onmousemove = (event) => {
			if (!dragging) return;
			const scale = this.viewBox.w / Math.max(svg.clientWidth || 1, 1);
			this.setViewBox({
				x: dragging.box.x - (event.clientX - dragging.x) * scale,
				y: dragging.box.y - (event.clientY - dragging.y) * scale,
				w: dragging.box.w, h: dragging.box.h,
			});
		};

		/*
		 * Zoom towards the pointer, so the thing under the cursor stays under it.
		 * `passive: false` because the default would scroll the pane behind.
		 */
		svg.addEventListener('wheel', (event) => {
			event.preventDefault();
			const box = this.viewBox;
			const rect = svg.getBoundingClientRect();
			const atX = box.x + ((event.clientX - rect.left) / Math.max(rect.width, 1)) * box.w;
			const atY = box.y + ((event.clientY - rect.top) / Math.max(rect.height, 1)) * box.h;
			const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
			const width = box.w * factor;
			const height = box.h * factor;
			this.setViewBox({
				x: atX - (atX - box.x) * factor,
				y: atY - (atY - box.y) * factor,
				w: width, h: height,
			});
		}, { passive: false });
	}

	/*
	 * The search, applied to what is already drawn. A class matches on its own
	 * name or on any row it carries — looking for `location` should find the
	 * classes that declare it, which is the question a diagram is being asked
	 * when you type a characteristic into it.
	 *
	 * It reads `data-search`, written when the box was drawn. See `drawNode`:
	 * reading the drawing's own text instead matched every tooltip on it.
	 */
	applyQuery() {
		if (!this.svgEl) return;
		const query = this.query.trim().toLowerCase();
		this.svgEl.classList.toggle('is-searching', query.length > 0);
		if (!query) {
			for (const group of Array.from(this.svgEl.querySelectorAll('.oof-uml-node'))) {
				group.classList.remove('is-miss');
			}
			return;
		}
		for (const group of Array.from(this.svgEl.querySelectorAll('.oof-uml-node'))) {
			const text = group.getAttribute('data-search') || '';
			group.classList.toggle('is-miss', text.indexOf(query) === -1);
		}
	}
}

/* --------------------------------------------------------------- the panel */

class ClassesView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;

		/*
		 * Which classes are highlighted, and why. Deliberately **not** persisted:
		 * a selection is where you are in a piece of work, not a preference, and
		 * opening the vault tomorrow to a panel still holding three classes you
		 * picked on Tuesday would be a state you have to notice and undo. It starts
		 * where the panel has always started — following the note you are reading.
		 */
		this.selectionMode = 'active';
		this.selection = new Set();
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Classes'; }
	getIcon() { return 'boxes'; }

	async onOpen() {
		/*
		 * Frontmatter edited outside the panel should show up here - but only when
		 * it is frontmatter the panel could be showing. It used to redraw for every
		 * metadata change anywhere in the vault, so typing in an unrelated note
		 * rebuilt the whole class list every few hundred milliseconds.
		 */
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (this.plugin.inPictureFolders(file)) this.queueRender();
		}));

		/* Follow whatever note he is looking at. */
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (file instanceof TFile) this.enteredNote = true;
			this.queueRender();
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			if (this.isNoteLeaf(leaf)) this.enteredNote = true;
			this.queueRender();
		}));

		this.render();
	}

	/*
	 * Whether becoming active makes this leaf "the note he is now looking at".
	 *
	 * Clicking back into a note you already have open fires **no `file-open`** —
	 * the active file has not changed, only the leaf — and that is exactly the
	 * moment the panel should come home. Graph Focus learnt this first and its
	 * `onActiveLeafChange` says so in as many words; this is the same fix.
	 *
	 * The guard is what makes it safe, and it has to be, because the leaf that
	 * becomes active when you click a dot is **this panel's own**. Two tests, both
	 * of which our panel fails: the leaf must carry a file (an `ItemView` has no
	 * `.file`), and it must live in the main area rather than in a sidebar. So a
	 * click inside the panel can never undo the selection that click just made —
	 * which is the trap the whole design has been avoiding since the first version.
	 *
	 * `getActiveFile()` is deliberately not used as a fallback: it answers with the
	 * last note whatever leaf you clicked, which is precisely the confusion the
	 * guard exists to prevent.
	 */
	isNoteLeaf(leaf) {
		const view = leaf && leaf.view;
		if (!view || !(view.file instanceof TFile)) return false;
		if (typeof leaf.getRoot !== 'function') return true;
		return leaf.getRoot() === this.app.workspace.rootSplit;
	}

	queueRender() {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.setTimeout(() => {
			this.renderQueued = false;
			/*
			 * A redraw that changes nothing still costs a flicker: the panel is
			 * emptied and rebuilt, and a sticky header with a backdrop filter is
			 * re-composited over whatever is behind it. Editing the body of a note
			 * in the notes folder fires `changed` without altering a single thing
			 * the panel shows, and that was most of them.
			 *
			 * Only event-driven redraws are skipped this way. Anything he does in
			 * the panel calls `render()` directly and always draws.
			 */
			/*
			 * Except when he has just gone back into a note. The signature is taken
			 * *before* the render, so it still describes the state the render is
			 * about to change — a skip here would swallow the very event that hands
			 * the panel back to the active note, and the flag would sit set until
			 * something unrelated redrew.
			 */
			if (!this.enteredNote) {
				const signature = this.renderSignature();
				if (signature === this.lastSignature) return;
			}
			this.render();
		}, 300);
	}

	/*
	 * Everything the panel's appearance depends on, as one string. Cheap to build
	 * next to what a render costs, and deliberately generous: a signature that
	 * missed something would leave the panel showing the wrong thing, which is far
	 * worse than a redraw that was not needed.
	 */
	renderSignature() {
		const plugin = this.plugin;
		const objects = plugin.scanClasses();
		const drafts = plugin.allDrafts(objects);

		const parts = [];
		for (const [name, draft] of drafts) {
			parts.push(name + '{' + plugin.settings.logicProperties
				.map((property) => (draft.values[property] || []).join(','))
				.join('|') + '}'
				/* Its symbol is drawn on the row, so a change to one is a redraw. */
				+ (draft.symbol ? '@' + draft.symbol : ''));
		}

		const characteristics = plugin.scanCharacteristics();
		for (const [name, characteristic] of characteristics) {
			parts.push('c:' + name + ':' + (characteristic.propertyType || '')
				+ ':' + (characteristic.defaultValue || '')
				/* A row edited in a body changes the plan, so it changes this too. */
				+ ':' + (characteristic.defaults || [])
					.map((row) => row.location + '='
						+ DEFAULTS_VALUE_KEYS.map((key) => row[key]).join('/'))
					.join('~'));
		}

		const found = plugin.findDiscrepancies();
		const active = plugin.settings.followActiveNote
			? this.app.workspace.getActiveFile()
			: null;

		return parts.join(';')
			+ '::' + found.solvable.length + '/' + found.insolvable.length
			+ '/' + found.dismissed.length
			+ '::' + (active ? active.path : '')
			/* Which of two highlighted classes the toolbar is acting on. */
			+ '::' + String(this.toolbarClass || '')
			/* And what the panel is highlighting at all — the mode and the set. */
			+ '::' + String(this.selectionMode || 'active')
			+ '::' + Array.from(this.selection || []).join(',')
			+ '::' + String(this.filter || '')
			/* And whether the bar it is typed into is open at all. */
			+ '::' + String(!!this.searchOpen)
			+ '::' + Array.from(plugin.expanded).sort().join(',')
			+ '::' + plugin.isDirty(objects);
	}

	render() {
		const container = this.containerEl.children[1];

		/*
		 * A render rebuilds the whole panel, which throws away two things the eye
		 * and the hand were relying on: where the list was scrolled to, and which
		 * box was being typed in. Adding a characteristic re-renders, so adding
		 * three in a row meant being thrown back to the top three times.
		 *
		 * Both are taken before the rebuild and put back after it. The search box
		 * used to do this for itself; now everything gets it.
		 */
		const keptScroll = container.scrollTop;
		/* `renderHeader` reads this to paint the frost in, rather than fading it in. */
		this.keptScrollForHeader = keptScroll;
		const focused = document.activeElement;
		const keptFocus = focused && container.contains(focused)
			? focused.getAttribute('data-oof-focus')
			: null;
		const keptCaret = keptFocus && typeof focused.selectionStart === 'number'
			? focused.selectionStart
			: null;
		const keptValue = keptFocus ? focused.value : null;

		container.empty();
		container.addClass('oof-objects');

		this.restoreAfterRender = () => {
			/*
			 * Scroll first: focusing an input scrolls it into view, and doing that
			 * against a container still at the top would undo the restore.
			 */
			if (keptScroll) container.scrollTop = keptScroll;
			if (!keptFocus) return;

			const next = container.querySelector('[data-oof-focus="' + keptFocus + '"]');
			if (!next) return;
			/*
			 * A half-typed value survives too. It will be empty after adding a chip,
			 * which is what should happen - the row is ready for the next one.
			 */
			if (keptValue && !next.value) {
				next.value = keptValue;
				/*
				 * And re-filter its suggestions to the restored text. Only for the
				 * chip inputs: the search box re-renders from its own `oninput`, so
				 * calling it here would recurse.
				 */
				if (next.classList.contains('oof-add') && typeof next.oninput === 'function') {
					next.oninput();
				}
			}
			/*
			 * `preventScroll`, or focusing drags the panel to wherever the input
			 * happens to be — which is the jolt this whole restore exists to stop,
			 * arriving by the back door.
			 */
			next.focus({ preventScroll: true });
			if (keptCaret !== null && typeof next.setSelectionRange === 'function') {
				const at = Math.min(keptCaret, next.value.length);
				next.setSelectionRange(at, at);
			}
			if (keptScroll) container.scrollTop = keptScroll;
		};

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

		/*
		 * Everything in one wrapper, and the classes in a second inside it.
		 *
		 * **Only the classes are ever wider than the panel.** The header, the
		 * discrepancies and the base characteristics are prose and controls; there
		 * is nothing in them to read sideways, and widening them only cut their
		 * sentences off at the pane edge. So the outer wrapper is what the
		 * scrollbar widens, the inner one is what makes it wide, and the three
		 * blocks between them are pinned at the panel's own width — they neither
		 * stretch nor move when the classes scroll under them.
		 *
		 * All three are inside the wrapper rather than outside it, because a
		 * sticky element can only be moved *within* its containing block: as a
		 * child of the scroll container each of them filled that box exactly,
		 * leaving no room to hold it back with, and it slid away with the rest.
		 */
		const body = container.createDiv({ cls: 'oof-panel-body' });

		/*
		 * The classes the active note is about — itself if it is a class, else
		 * whatever its `is a` names.
		 *
		 * Worked out before the header rather than with the list, because in
		 * toolbar mode the header holds the actions and they act on this.
		 */
		const activeFile = plugin.settings.followActiveNote
			? this.app.workspace.getActiveFile()
			: null;

		/*
		 * Scroll to it only when he has actually moved to another note. Doing it
		 * on every render would yank the panel around while he edits chips.
		 */
		const activePath = activeFile ? activeFile.path : null;
		const moved = activePath !== this.lastActivePath;
		this.lastActivePath = activePath;

		/*
		 * --- which classes are highlighted, and why ---
		 *
		 * Two modes, his `Moving options for classes.md`: the panel either follows
		 * the note you are reading, or holds a selection you made by clicking dots.
		 * Everything downstream — the card highlight, the lit rails, the toolbar —
		 * reads `this.active` and never asks which of the two put a name in it.
		 *
		 * **Selecting is a toolbar-mode thing.** The dots exist to feed a row of
		 * buttons that acts on the selection; with an identical row of buttons on
		 * every card there is nothing for a selection to drive, so it is not
		 * offered and the panel simply tracks the active note.
		 */
		this.selecting = plugin.settings.classActions === 'toolbar';
		if (!this.selection) this.selection = new Set();
		if (!this.selecting) this.selectionMode = 'active';

		/*
		 * Not just which classes, but how the open file is about them: its own
		 * note, its template, its base, a characteristic it declares, or an
		 * instance. The chip on the card says which, so it has to be carried.
		 */
		const relation = plugin.activeClassesFor(activeFile, objects, drafts);
		const tracked = relation.names;
		this.activeKind = relation.kind;

		/*
		 * Opening a note hands the panel back to active-note tracking — his rule.
		 * Keyed on the active **file changing**, not on a leaf becoming active:
		 * clicking a dot in the sidebar changes the active leaf and would otherwise
		 * undo the very click that selected.
		 *
		 * What happens to the set is the one setting here. Kept, so the mode button
		 * returns you to exactly what you had picked; or replaced by the classes of
		 * the note you just opened, so the selection follows you and switching to it
		 * always starts from where you are standing.
		 */
		/*
		 * `moved` is not enough on its own, and that was the bug: clicking back into
		 * the note you already have open changes no path, so nothing fired. What
		 * actually happened is that a note leaf became active, which `isNoteLeaf`
		 * watches for — `moved` stays in the test only as a belt-and-braces for a
		 * file that changed without either event reaching us.
		 */
		const entered = this.enteredNote || moved;
		this.enteredNote = false;

		if (entered) {
			if (this.selectionMode === 'custom') this.selectionMode = 'active';
			if (plugin.settings.resetSelectionOnNote) this.selection = new Set(tracked);
		}

		/* A selected class that has since stopped being one is not a subject. */
		this.selection = new Set(Array.from(this.selection).filter((name) => drafts.has(name)));

		/*
		 * An empty selection either stands or hands the panel back — the one place
		 * that decides it, so `pickClass` and the × need no rule of their own.
		 */
		if (this.selection.size === 0 && !plugin.settings.emptySelectionStands) {
			this.selectionMode = 'active';
		}

		this.active = this.selectionMode === 'custom'
			? new Set(this.selection)
			: new Set(tracked);

		this.renderHeader(body, drafts, objects, { shown: names.length, total });

		/* When he is hunting for a class, the rest of the panel is noise. */
		if (!filter) {
			this.renderDiscrepancies(body);
			this.renderBaseCharacteristics(body, characteristics);
		}

		/* The one thing the sideways scroll acts on. */
		const list = body.createDiv({ cls: 'oof-class-list' });

		/*
		 * The tree is the sort: `classTree` decides the order, so the sort setting
		 * has nothing to say while it is on. It is also skipped while searching —
		 * a filtered tree is a tree with holes in it, and the rails would run to
		 * classes that are not there.
		 */
		/* Cleared here, so the flat list is left without one: there are no rails
		 * to light, and the elements the last drawing filed are gone. */
		this.hoverIndex = null;
		this.hovered = [];

		/*
		 * Whether the classes are drawn as a plain stack of cards. The two tree
		 * layouts draw a node beside every card already; the flat list has none, so
		 * the cards grow one of their own — his N.B., and the reason it is worth
		 * having: the dot is the select button, so a layout without one would be a
		 * layout you cannot select in.
		 */
		this.flatList = plugin.settings.classLayout === 'list' || !!filter;

		const brackets = plugin.settings.classLayout === 'brackets'
			|| plugin.settings.classLayout === 'compressed';
		if (brackets && !filter) {
			this.renderClassBrackets(list, names, objects, drafts, characteristics,
				plugin.settings.classLayout === 'compressed');
		} else if (plugin.settings.classLayout === 'tree' && !filter) {
			this.renderClassTree(list, names, objects, drafts, characteristics);
		} else {
			for (const name of names) {
				this.renderObject(list, drafts.get(name), objects, drafts, characteristics);
			}
		}

		if (moved && this.active.size > 0) {
			const card = container.querySelector('.oof-object-active');
			if (card && typeof card.scrollIntoView === 'function') {
				card.scrollIntoView({ block: 'nearest' });
			}
		}

		if (names.length === 0) {
			list.createEl('p', {
				text: filter
					? 'No class matches "' + this.filter + '".'
					: 'No classes yet. A class is a note tagged #class, or one that lists '
						+ 'characteristics or names a parent.',
				cls: 'oof-empty',
			});
		}

		/*
		 * One bar at the bottom of the panel, when that is the mode. It goes on
		 * the scroll container rather than on anything of ours, because that is
		 * the element whose box is the visible panel — a horizontal bar belongs at
		 * the bottom of what you are looking at, not at the bottom of a stack of
		 * cards several screens tall.
		 */
		const scroller = this.containerEl.children[1];
		if (scroller && scroller.classList) {
			const mode = plugin.settings.cardOverflow;
			/* Both of the settings that keep a row whole widen the panel. */
			scroller.classList.toggle('oof-scroll-wide',
				mode === 'panel' || mode === 'wrap');
			/*
			 * How wide. `max-content` is every row on one line; `fit-content` is
			 * only as wide as the widest row *has* to be — which, with the chips
			 * free to wrap, is the top line. That one word is the whole difference
			 * between the two wide settings.
			 */
			scroller.classList.toggle('oof-wide-fit', mode === 'wrap');
		}
		this.syncPortWidth();
		this.syncFixedBlocks();

		this.watchScroll();
		this.syncStuckHeader();
		/* What this draw was of, so an identical one can be skipped. */
		this.lastSignature = this.renderSignature();

		/* Put the scroll position and the caret back where he left them. */
		if (this.restoreAfterRender) {
			const restore = this.restoreAfterRender;
			this.restoreAfterRender = null;
			restore();
		}
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
	 * How wide the pane actually is, published to the stylesheet.
	 *
	 * Only the two widening settings need it, and only the pinned blocks use it —
	 * everything else in there is *meant* to be as wide as the content. From
	 * inside a container widened past its scrollport there is no length left that
	 * still names the scrollport, so it is measured here and handed over.
	 *
	 * Measured at the end of a render, when the content exists: taken before, a
	 * vertical scrollbar that is about to appear is not counted, and the pinned
	 * blocks come out 15px too wide.
	 */
	syncPortWidth() {
		const scroller = this.containerEl.children[1];
		if (!scroller || !scroller.style) return;
		/*
		 * The *content* width, not `clientWidth`: the blocks are capped at what a
		 * block in this pane would ordinarily get, and that is the pane less the
		 * padding it actually has. Subtracting the 12px the stylesheet asks for
		 * would be a guess, and a theme setting 10px made it a wrong one.
		 */
		const style = window.getComputedStyle(scroller);
		const inner = scroller.clientWidth
			- (parseFloat(style.paddingLeft) || 0)
			- (parseFloat(style.paddingRight) || 0);
		scroller.style.setProperty('--oof-pane', Math.max(0, inner) + 'px');
	}

	/* The pane can be dragged wider without the panel redrawing. */
	onResize() {
		this.syncPortWidth();
		this.syncFixedBlocks();
	}

	/*
	 * Holds the header, the discrepancies and the base characteristics still
	 * while the classes scroll sideways under them.
	 *
	 * `position: sticky` was the obvious way and very nearly worked: a sticky
	 * element is held within its containing block, so the room it has to resist
	 * scrolling with is `wrapperWidth - itsOwnWidth`, while the distance it must
	 * resist is `scrollWidth - paneWidth`. Those agree only while nothing outside
	 * the wrapper carries side padding — and what carries side padding is the
	 * pane, whose rules a theme is entitled to outbid. The failure mode is the
	 * worst kind: the blocks hold for most of the scroll and slip the last few
	 * pixels, which reads as a bug, and is invisible in a harness with no theme.
	 *
	 * Cancelling the scroll with a transform needs no arithmetic and no
	 * assumption about anyone else's padding. Reading `scrollLeft` here is the
	 * measurement the layout would otherwise have had to imply.
	 */
	syncFixedBlocks() {
		const scroller = this.containerEl.children[1];
		if (!scroller || typeof scroller.querySelectorAll !== 'function') return;
		const x = scroller.scrollLeft;
		const shift = x ? 'translateX(' + x + 'px)' : '';
		for (const el of Array.from(scroller.querySelectorAll('.oof-panel-fixed'))) {
			el.style.transform = shift;
		}
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
		const sync = () => {
			this.syncStuckHeader();
			this.syncFixedBlocks();
		};
		if (typeof this.registerDomEvent === 'function') this.registerDomEvent(scroller, 'scroll', sync);
		else scroller.addEventListener('scroll', sync);
	}

	renderHeader(container, drafts, objects, counts) {
		const plugin = this.plugin;
		/*
		 * Whether it is stuck is decided *here*, from the scroll position carried
		 * over the rebuild — not afterwards by `syncStuckHeader`.
		 *
		 * Adding the class after the fact left one painted frame in which a
		 * scrolled panel had a fully transparent header sitting over its content,
		 * and then a 120ms fade back to frosted. Every re-render flickered, which
		 * is what he was seeing while editing a note.
		 */
		const stuck = (this.keptScrollForHeader || 0) > 2;
		const header = container.createDiv({
			cls: 'oof-header oof-panel-fixed' + (stuck ? ' is-scrolled' : ''),
		});

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
					this.createClassNamed(name, drafts, null);
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
			new Notice('OOF Class Manager: pending edits discarded. Your notes were never touched.');
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
		/*
		 * Nothing solvable means nothing for Update to do, so it fades out the way
		 * Discard does with no pending edits. A button that is live but does
		 * nothing when pressed teaches him to stop trusting the panel.
		 */
		const nothingToDo = found.solvable.length === 0;

		const update = buttons.createEl('button', {
			text: 'Update',
			cls: !blocked && !nothingToDo && pending ? 'mod-cta' : '',
		});
		if (blocked || nothingToDo) {
			update.setAttribute('disabled', 'true');
			update.setAttribute('title', blocked
				? found.insolvable.length + ' discrepanc'
					+ (found.insolvable.length === 1 ? 'y needs' : 'ies need')
					+ ' you first — see the list below.'
				: 'Nothing to update: the vault already matches the panel.');
		}
		update.onclick = () => {
			if (blocked || nothingToDo) return;
			new UpdateModal(this.app, this.plugin, this).open();
		};

		/*
		 * Filtering the list — a looking glass that opens a search bar, which is
		 * how Bases does it and how he asked for it.
		 *
		 * The bar is not left standing there when there is nothing to find: an
		 * input that is empty most of the time still spends a row of a 300px
		 * sidebar and still reads as a thing you were meant to have filled in. So
		 * the row is one icon until it is wanted.
		 *
		 * Obsidian's own `SearchComponent` rather than a bare input, for the sake
		 * of the × that clears it: that is the app's markup and the app's
		 * stylesheet, so it hides itself while the box is empty, sits where every
		 * other × in Obsidian sits, and puts focus back in the field afterwards —
		 * none of which is worth reimplementing badly.
		 *
		 * Re-rendering rebuilds this input, so focus and the caret are put back
		 * afterwards - otherwise every keystroke would drop him out of the box.
		 */
		const searchOpen = !!this.searchOpen;
		const search = new SearchComponent(header);
		search.containerEl.addClass('oof-search-bar');
		search.inputEl.addClass('oof-search');
		search.setPlaceholder('Find a class…');
		search.setValue(this.filter || '');
		search.inputEl.setAttribute('data-oof-focus', '::search');
		/* Focus and caret come back through the shared restore in `render()`. */
		search.onChange((value) => {
			this.filter = value;
			this.render();
		});
		/*
		 * Escape closes the bar rather than only emptying it. Emptying is what the
		 * × is for, and from an already-empty box the only thing left to ask for
		 * is the row back.
		 */
		search.inputEl.onkeydown = (event) => {
			if (event.key !== 'Escape') return;
			this.closeSearch();
		};
		if (!searchOpen) search.containerEl.hide();

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

		/*
		 * The looking glass, first in the group: it opens something above the list
		 * rather than changing the list itself.
		 *
		 * A second press closes the bar *and* drops the filter, which is what
		 * closing a search means — a hidden bar still narrowing the list would be
		 * a panel lying about how many classes there are. Bases closes its own
		 * search the same way.
		 */
		this.headerIcon(folding, 'search', '⌕', {
			cls: 'oof-search-toggle' + (searchOpen ? ' is-active' : ''),
			label: searchOpen ? 'Close the search' : 'Find a class',
			onClick: () => {
				if (this.searchOpen) this.closeSearch();
				else this.openSearch();
			},
		});

		/*
		 * List or tree, in the panel rather than only in the settings. It belongs
		 * on this row for the same reason the folding pair does: it acts on how
		 * the list is shown, not on the vault — and it is a thing to flick between
		 * while looking at the classes, which is a poor errand to send someone to
		 * a settings tab for.
		 *
		 * One button that flips rather than two, unlike the folding pair: there
		 * are exactly two layouts, so the one you are not in *is* the one you will
		 * get, and neither is ever a no-op the way "unfold all" is when everything
		 * is already open.
		 *
		 * While searching it is disabled and says why. A filtered tree has holes
		 * in it, so the panel falls back to the list — and a control that silently
		 * does nothing is worse than one that is visibly unavailable.
		 */
		const searching = !!String(this.filter || '').trim();
		/*
		 * Four layouts now, so the button steps round them rather than flipping.
		 * Each still shows what it will give you next, which is what a two-state
		 * toggle got for free and a cycle has to be told to do.
		 *
		 * The compressed tree sits next to the tree it compresses, so the step
		 * between them is the one that changes least.
		 */
		const LAYOUTS = [
			{ id: 'list', icon: 'list', glyph: '≡', name: 'a list' },
			{ id: 'brackets', icon: 'git-fork', glyph: '⑂', name: 'a tree' },
			{ id: 'compressed', icon: 'git-merge', glyph: '⑃',
				name: 'a compressed tree' },
			{ id: 'tree', icon: 'git-branch', glyph: '⑄', name: 'a graph' },
		];
		const here = Math.max(0, LAYOUTS.findIndex(
			(layout) => layout.id === plugin.settings.classLayout));
		const next = LAYOUTS[(here + 1) % LAYOUTS.length];
		this.headerIcon(folding, next.icon, next.glyph, {
			cls: 'oof-layout-toggle'
				+ (plugin.settings.classLayout !== 'list' ? ' is-tree' : ''),
			label: searching
				? 'The tree is unavailable while searching'
				: 'Show as ' + next.name,
			disabled: searching,
			onClick: async () => {
				plugin.settings.classLayout = next.id;
				/*
				 * `persist`, not `saveSettings`: the layout changes nothing about
				 * the model, and dropping the picture and the closures to redraw a
				 * list would rebuild the whole vault's worth of them.
				 */
				await plugin.persist();
				this.render();
			},
		});

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

		/*
		 * The actions, when they live here rather than on every card. Inside the
		 * header rather than under it, so they stay put while the classes scroll:
		 * they act on the highlighted class, which is very often exactly the card
		 * that has just gone off the top.
		 */
		if (plugin.settings.classActions === 'toolbar') {
			this.renderClassToolbar(header, objects, drafts);
		}
	}

	/*
	 * One row of actions, above all the classes, for the classes the panel is
	 * highlighting — his `Moving options for classes.md`.
	 *
	 * **It only has buttons while something is highlighted**, which is what he
	 * asked for and is also the only coherent reading: these act on *a* class, and
	 * with none highlighted there is no class for them to act on. The row itself
	 * stays, saying so — a row that comes and goes as you move between notes would
	 * shift the whole panel up and down under the pointer.
	 *
	 * The names mean two different things in the two selection modes, and that is
	 * deliberate. Tracking the active note, the panel is *reporting* what the note
	 * is, and a note that is `is a` two classes gives a picker: which one the
	 * single-class buttons open. In a custom selection the panel is *taking
	 * instructions*, and the whole set is the instruction — every selected class is
	 * acted on at once. The mode button and the row's own tint say which of the two
	 * you are looking at.
	 */
	renderClassToolbar(container, objects, drafts) {
		const plugin = this.plugin;
		const custom = this.selectionMode === 'custom';
		const bar = container.createDiv({
			cls: 'oof-class-toolbar' + (custom ? ' is-custom' : ''),
		});

		/* A draft is what every action reads, so a name without one is no subject. */
		const active = Array.from(this.active || []).filter((name) => drafts.has(name));

		this.renderSelectionMode(bar, active.length);

		if (active.length === 0) {
			/*
			 * Three different nothings, and they want different sentences. Standing
			 * on an emptied selection is a state he asked for and chose, so it says
			 * how to leave it rather than how to arrive somewhere.
			 */
			bar.createSpan({
				cls: 'oof-toolbar-empty',
				text: custom
					? 'Nothing selected — click a dot, or click back into a note.'
					: (plugin.settings.followActiveNote
						? 'Nothing highlighted — open a class, or click the dot beside one.'
						: 'Following the active note is off. Click the dot beside a class.'),
			});
			return;
		}

		/*
		 * Which of them the buttons act on. In a custom selection, all of them; when
		 * tracking the active note, one — kept across renders so that opening a
		 * template does not throw the choice away, and dropped the moment it stops
		 * being one of the highlighted classes.
		 */
		if (!custom && (!this.toolbarClass || active.indexOf(this.toolbarClass) === -1)) {
			this.toolbarClass = active[0];
		}
		const acting = custom ? active : [this.toolbarClass];
		const several = !custom && active.length > 1;

		const names = bar.createDiv({ cls: 'oof-toolbar-names' });
		for (const name of active) {
			const picked = custom || name === this.toolbarClass;
			const el = names.createEl('a', {
				cls: 'oof-toolbar-name' + (picked ? ' is-chosen' : ''),
				attr: {
					title: picked
						? 'Open ' + name
						: 'These actions act on ' + name + ' instead',
				},
			});

			const symbol = plugin.symbolFor(name, objects, drafts);
			if (symbol.symbol) {
				paintSymbol(el.createSpan({
					cls: 'oof-symbol' + (symbol.inherited ? ' is-inherited' : ''),
				}), symbol.symbol);
			}
			el.createSpan({ text: name });

			el.onclick = (event) => {
				event.preventDefault();
				if (several && !picked) {
					this.toolbarClass = name;
					this.render();
					return;
				}
				this.openClassNote(name, drafts);
			};
		}

		/*
		 * Unselect the lot. Only in a custom selection — in tracking mode the
		 * highlight belongs to the note you have open, and there is nothing of his
		 * to clear.
		 *
		 * It sits at the end of the names rather than with the file buttons on the
		 * right: it acts on the selection, and those act on a class.
		 */
		if (custom) {
			const clear = names.createEl('a', {
				cls: 'oof-toolbar-clear',
				attr: {
					'aria-label': 'Unselect all classes',
					title: plugin.settings.emptySelectionStands
						? 'Unselect all classes — nothing will be highlighted until you '
							+ 'click back into a note'
						: 'Unselect all classes and go back to following the active note',
				},
			});
			if (typeof setIcon === 'function') setIcon(clear, 'x');
			else clear.textContent = '×';
			clear.onclick = (event) => {
				event.preventDefault();
				this.clearSelection();
			};
		}

		const actions = bar.createDiv({ cls: 'oof-toolbar-actions' });
		this.classActionButtons(actions, objects, drafts, acting, { includeNote: false });
	}

	/*
	 * Which of the two selection modes the panel is in, and the way to change it by
	 * hand — his note asks for both: the change is *shown*, and either mode can
	 * still be turned on deliberately.
	 *
	 * The switch back to a custom selection is only offered when there is a
	 * selection to go back to, which is the other half of his rule: the set is
	 * **kept** when the mode flips away from it, so toggling it on by hand brings it
	 * back — while clicking a dot enters the mode afresh and scraps it.
	 */
	renderSelectionMode(bar, highlighted) {
		const custom = this.selectionMode === 'custom';
		const kept = this.selection ? this.selection.size : 0;
		const canGoBack = custom || kept > 0;

		const button = bar.createEl('a', {
			cls: 'oof-selection-mode' + (custom ? ' is-custom' : '')
				+ (canGoBack ? '' : ' is-stuck'),
			attr: {
				/*
				 * What is behind the button, named. With *opening a note resets the
				 * selection* on, the kept set is the class you are reading — so it
				 * says which class, rather than "your selection of 1 class", which
				 * would be true and tell him nothing.
				 */
				title: custom
					? (kept === 0
						? 'You have unselected everything. Click to follow the active note '
							+ 'again, or click a dot to start a new selection.'
						: 'Your own selection of ' + kept + ' class'
							+ (kept === 1 ? '' : 'es') + '. Click to follow the active note again.')
					: (kept > 0
						? 'Following the active note. Click to select '
							+ andList(Array.from(this.selection))
							+ ', and shift or ctrl-click a dot to pick more.'
						: 'Following the active note. Click the dot beside a class to select '
							+ 'your own instead.'),
			},
		});
		if (typeof setIcon === 'function') {
			setIcon(button, custom ? 'mouse-pointer-click' : 'crosshair');
		}
		button.createSpan({
			cls: 'oof-selection-mode-label',
			text: custom
				? 'selection' + (highlighted > 1 ? ' ' + highlighted : '')
				: 'active note',
		});

		button.onclick = (event) => {
			event.preventDefault();
			if (!canGoBack) return;
			this.selectionMode = custom ? 'active' : 'custom';
			this.render();
		};
	}

	/*
	 * A dot is a select button — his note, and the reason the flat list grows dots
	 * of its own even though nothing is drawn between them.
	 *
	 * Plain click selects that class alone; shift or ctrl adds or removes one.
	 * Arriving from active-note tracking **scraps** whatever was selected before,
	 * which is his rule and the difference between coming back to a selection by
	 * hand and starting a new one.
	 */
	wireSelectDot(el, name, target) {
		if (!this.selecting) return el;

		const chosen = this.selectionMode === 'custom'
			&& this.selection && this.selection.has(name);
		el.addClass('is-selectable');
		if (chosen) el.addClass('is-selected');

		/*
		 * The class the state is painted on and the box the click lands in are not
		 * always the same element. A rail's node is 8px of circle positioned by
		 * hand and is its own target; a card's is a dot inside a pad, because 8px
		 * is not something to ask anyone to hit twice.
		 */
		const hit = target || el;
		hit.setAttribute('aria-label', chosen ? 'Deselect ' + name : 'Select ' + name);
		hit.setAttribute('title', chosen
			? 'Deselect ' + name + ' — shift or ctrl-click to select more than one'
			: 'Select ' + name + ' — shift or ctrl-click to select more than one');

		hit.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.pickClass(name, !!(event.shiftKey || event.ctrlKey || event.metaKey));
		};
		return el;
	}

	pickClass(name, extend) {
		if (!this.selection) this.selection = new Set();

		if (this.selectionMode !== 'custom') {
			this.selectionMode = 'custom';
			/*
			 * Arriving from active-note tracking, a plain click starts a new
			 * selection — his rule: turning the mode back on by clicking a dot
			 * scraps what was stored.
			 *
			 * A **modifier** click does not, and reading it that way was a bug he
			 * hit repeatedly: shift-clicking a second class while the panel was
			 * highlighting one of its own dropped that one and kept only the new.
			 * What his rule scraps is the *stored* selection from earlier, not the
			 * class in front of you — and shift-click has one meaning everywhere,
			 * which is "and this one as well".
			 *
			 * So it extends what is **showing**, `this.active`, and not the stored
			 * set: the stored set is not on the screen, and the mode button is the
			 * way back to it.
			 */
			this.selection = extend
				? new Set(Array.from(this.active || []).concat([name]))
				: new Set([name]);
			this.render();
			return;
		}

		if (!extend) this.selection = new Set([name]);
		else if (this.selection.has(name)) this.selection.delete(name);
		else this.selection.add(name);

		/*
		 * What an empty set means is decided in `render()`, in one place. The last
		 * selected class is deliberately not special-cased into staying — his N.B.,
		 * and he is right: a control that refuses the last of something is a
		 * control you have to learn an exception for.
		 */
		this.render();
	}

	/* Unselect everything at once. */
	clearSelection() {
		this.selection = new Set();
		this.render();
	}

	/* The class's own note, or a word about why there isn't one yet. */
	openClassNote(name, drafts) {
		const draft = drafts.get(name);
		if (draft && draft.file) {
			this.app.workspace.getLeaf(false).openFile(draft.file);
			return;
		}
		new Notice('No note for "' + name + '" yet — Update creates it.', 4000);
	}

	/*
	 * The search bar, opened and closed by the looking glass beside it.
	 *
	 * Focus is taken here rather than through `render()`'s restore, because the
	 * restore puts back whatever *was* focused and what was focused is the button
	 * that was just pressed. `preventScroll` for the restore's own reason —
	 * focusing an input drags the panel to wherever it happens to be.
	 */
	openSearch() {
		this.searchOpen = true;
		this.render();
		const input = this.containerEl.querySelector('.oof-search');
		if (!input) return;
		input.focus({ preventScroll: true });
		input.select();
	}

	/* Closing empties it: a bar you cannot see must not go on narrowing the list. */
	closeSearch() {
		this.searchOpen = false;
		this.filter = '';
		this.render();
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
		/*
		 * Nothing live means nothing to be alarmed about. A card that keeps its
		 * warning colour for a list he has already dealt with is a warning he
		 * learns to ignore.
		 */
		const quiet = found.solvable.length === 0 && found.insolvable.length === 0;

		const card = container.createDiv({
			cls: 'oof-object oof-panel-fixed oof-discrepancies'
				+ (found.insolvable.length > 0 ? ' oof-discrepancies-blocking' : '')
				+ (quiet ? ' oof-discrepancies-quiet' : '')
				+ (open ? ' is-open' : ' is-closed'),
		});

		const title = this.titleRow(card);
		title.onclick = async () => {
			await plugin.toggleExpanded(DISCREPANCY_CARD);
			this.render();
		};

		const twisty = title.createSpan({ cls: 'oof-twisty' });
		if (typeof setIcon === 'function') setIcon(twisty, 'chevron-right');

		const caution = title.createSpan({ cls: 'oof-caution' });
		if (typeof setIcon === 'function') {
			setIcon(caution, quiet ? 'check' : 'alert-triangle');
		}

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
		/* So the card is never a bare caution symbol with no number on it. */
		if (found.dismissed.length > 0) {
			title.createSpan({
				text: found.dismissed.length + ' dismissed',
				cls: 'oof-badge oof-badge-solvable',
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

		/*
		 * Folded away by default. Dismissing something is saying "I know, leave me
		 * alone"; leaving the list open afterwards ignores half of that, and it was
		 * filling the whole card with things he had already answered.
		 */
		if (found.dismissed.length > 0) {
			const shown = plugin.expanded.has(DISMISSED_SECTION);
			const toggle = body.createEl('p', { cls: 'oof-base-note oof-dismissed-toggle' });
			toggle.setText((shown ? '▾ ' : '▸ ') + found.dismissed.length
				+ ' dismissed — still true, no longer blocking.');
			toggle.onclick = async () => {
				await plugin.toggleExpanded(DISMISSED_SECTION);
				this.render();
			};
			if (shown) this.renderDiscrepancyList(body, found.dismissed, true);
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

			/*
			 * The change itself, line by line, before it happens — so a plan entry
			 * that reads oddly can be checked rather than guessed at.
			 */
			this.iconButton(head, 'file-diff', {
				label: 'See the change',
				tooltip: discrepancy.fix
					? 'Show the lines this will change, before it happens.'
					: 'Show the file as it stands, with the line at issue marked.',
				onClick: () => {
					new ChangeModal(this.app, plugin, discrepancy).open();
				},
			});

			/*
			 * The one question the plugin cannot answer for itself. Answering it
			 * records the rename, and Update carries every note across — the same
			 * path a rename it *did* witness takes.
			 */
			if (discrepancy.kind === 'stranded-property') {
				this.iconButton(head, 'replace', {
					label: 'Say what it was renamed to',
					tooltip: 'Move "' + discrepancy.property + '" and its values onto '
						+ 'another characteristic.',
					onClick: () => {
						new RenamePropertyModal(this.app, plugin, discrepancy,
							() => this.render()).open();
					},
				});
			}

			/* The same question, one level down, and the same button for it. */
			if (discrepancy.kind === 'stranded-value') {
				this.iconButton(head, 'replace', {
					label: 'Say what it was renamed to',
					tooltip: 'Move "' + discrepancy.strandedValue.value + '" to another '
						+ 'value of ' + discrepancy.property + ', on every note holding it.',
					onClick: () => {
						new RenameValueModal(this.app, plugin, {
							characteristic: discrepancy.property,
							from: discrepancy.strandedValue.value,
							suggestion: discrepancy.suggestion,
						}, () => this.render()).open();
					},
				});
			}

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
	 * above the objects because they apply to all of them. One row per entry on
	 * every class card below.
	 *
	 * **Read-only since 2026-09-01**, from his note `The user should not be able
	 * to add or delete base characteristics`. The chips still open their notes;
	 * what is gone is `onChange`, and `renderChipRow` draws neither the x nor the
	 * + without it - so there is one way to change this list and it is
	 * BASE_CHARACTERISTICS.
	 */
	renderBaseCharacteristics(container, characteristics) {
		const plugin = this.plugin;
		const card = container.createDiv({ cls: 'oof-object oof-panel-fixed oof-base' });

		/* No dropdown on this one: it is one short list, and it applies to all. */
		const title = this.titleRow(card, 'oof-title-static');
		title.createSpan({ text: 'Base characteristics', cls: 'oof-object-name' });
		title.createSpan({ text: 'logic', cls: 'oof-badge oof-badge-root' });

		const body = card.createDiv({ cls: 'oof-object-body' });
		body.createEl('p', {
			text: 'The properties the system reasons with. Every class below gets one row '
				+ 'per entry. The list belongs to the plugin, so it is not added to or '
				+ 'removed from here.',
			cls: 'oof-base-note',
		});

		this.renderChipRow(body, 'properties', plugin.settings.logicProperties, {
			owner: '::base',
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
				const parts = [];
				if (meaning) parts.push(meaning);
				parts.push(this.baseCharacteristicRole(name));
				if (!characteristic) parts.push('no note yet');
				return parts.join(' — ');
			},
			missing: (name) => !characteristics.has(name),
		});
	}

	/*
	 * What one base characteristic is for, in three words. Read off the settings
	 * that name them rather than off the list's order, so renaming `is a` in the
	 * settings does not leave a chip claiming the wrong job.
	 */
	baseCharacteristicRole(name) {
		const settings = this.plugin.settings;
		if (name === settings.isAProperty
			|| name === settings.characteristicsProperty
			|| name === settings.inheritsProperty) {
			return 'used by the engine';
		}
		if (name === settings.viewsProperty) return 'file.views(), to instances';
		if (name === settings.classViewsProperty) return 'file.views(), to subtypes';
		if (name === settings.componentsProperty) return 'read by file.hasA()';
		return 'stored and editable, no inheritance';
	}

	/* ----- the second, fainter path: the class under the pointer ----- */

	/*
	 * Hovering a class lights its line of descent back to the root, the way the
	 * active note's is lit but in a tint of the accent rather than the accent.
	 *
	 * It reuses `litPath` and `litBrackets` rather than owning a second idea of
	 * what a line of descent is — there would otherwise be two answers to that
	 * question and only one of them under test. So each drawing files every rail
	 * element it makes under the *key that decided its `is-lit`*, and hovering
	 * re-runs the same function for one name and lights whatever is filed under
	 * the keys it hands back.
	 *
	 * Not by re-rendering, which was the other way to do it: the panel's render
	 * rebuilds every card, and doing that on each twitch of the pointer would
	 * throw away scroll position, focus and any half-typed chip.
	 */
	beginHoverIndex(shape) {
		this.hovered = [];
		this.hoverIndex = Object.assign({ els: new Map() }, shape);
		return this.hoverIndex;
	}

	fileHover(key, el) {
		if (this.hoverIndex) {
			const els = this.hoverIndex.els;
			if (!els.has(key)) els.set(key, []);
			els.get(key).push(el);
		}
		return el;
	}

	/*
	 * The whole row is the target, not the card: the rail beside a class is as
	 * much that class's row as its card is, and pointing at a node to see where
	 * it comes from is the obvious thing to try.
	 */
	watchHover(row, name) {
		row.addEventListener('mouseenter', () => {
			this.hoverName = name;
			this.paintHover(name);
		});
		row.addEventListener('mouseleave', () => {
			this.hoverName = null;
			this.paintHover(null);
		});
	}

	/*
	 * Which class the pointer is on, remembered, so a render that happens while
	 * he is hovering — switching notes, an edit landing — comes back painted.
	 * `mouseenter` will not fire again on the fresh elements until the pointer
	 * actually moves, and the highlight would sit missing until it did.
	 */
	repaintHover() {
		if (this.hoverName) this.paintHover(this.hoverName);
	}

	paintHover(name) {
		for (const el of this.hovered || []) {
			el.removeClass('is-hover-lit');
			el.removeClass('is-hover-active');
			el.removeClass('is-hover-ancestor');
		}
		this.hovered = [];

		const index = this.hoverIndex;
		if (!name || !index) return;

		const light = (key, extra) => {
			for (const el of index.els.get(key) || []) {
				el.addClass('is-hover-lit');
				if (extra) el.addClass(extra);
				this.hovered.push(el);
			}
		};

		const only = new Set([name]);
		if (index.kind === 'tree') {
			const path = this.plugin.litPath(index.tree, only);
			for (const [row, lanes] of path.lanes) {
				for (const lane of lanes) light('lane:' + row + ':' + lane);
			}
			for (const [cls, mark] of path.dots) light('dot:' + cls, 'is-hover-' + mark);
			for (const key of path.wires) light('wire:' + key);
		} else {
			const lit = this.plugin.litBrackets(index.layout, only);
			for (const row of lit.straight) light('straight:' + row);
			for (const key of lit.brackets) light('bracket:' + key);
			for (const [cls, mark] of lit.dots) light('dot:' + cls, 'is-hover-' + mark);
		}
	}

	/* ----- wires that cross ----- */

	/*
	 * A horizontal run of wire, broken wherever a rail crosses it.
	 *
	 * Two wires meeting on the page have to say which of them is which, and the
	 * answer a wiring diagram has always given is that one passes behind and is
	 * cut either side of the other. Here the **vertical always wins**: it is drawn
	 * straight through and the horizontal is the one with the gap in it. That is
	 * the rule he asked for, and it falls the right way round on its own — a
	 * second-parent wire is horizontal for the whole of its detour out and back,
	 * so it is the wire doing nearly all of the crossing and nearly all of the
	 * giving way.
	 *
	 * The break is cut here rather than painted over. The other way to do it is a
	 * halo of the panel colour around every vertical, which needs no arithmetic at
	 * all — and needs the whole drawing to be in the right z-order, including the
	 * corners each vertical legitimately touches. Cutting the run is decidable
	 * from the layout alone, which is where the rest of this geometry lives.
	 *
	 * `ends` are `{ col, trim }`: the column each end sits in and how far short of
	 * it to stop, as a CSS length. `crossing` is every column with a rail passing
	 * this row — only the ones strictly between the ends can cut anything.
	 *
	 * Returns the pieces, because a caller that labels or lights the run has to do
	 * it to all of them.
	 */
	crossedRun(rail, cls, from, to, crossing) {
		const centre = (col, op, expr) => 'calc(var(--oof-lane-width) * ' + col
			+ ' + var(--oof-lane-width) / 2'
			+ (expr ? ' ' + op + ' ' + expr : '') + ')';

		const lo = Math.min(from.col, to.col);
		const hi = Math.max(from.col, to.col);
		const loEnd = from.col <= to.col ? from : to;
		const hiEnd = from.col <= to.col ? to : from;

		/* Every stop and start along the run, in order, left to right. */
		const points = [centre(lo, '+', loEnd.trim)];
		const cut = Array.from(new Set(crossing || []))
			.filter((col) => col > lo && col < hi)
			.sort((a, b) => a - b);
		for (const col of cut) {
			points.push(centre(col, '-', 'var(--oof-cross-gap) / 2'));
			points.push(centre(col, '+', 'var(--oof-cross-gap) / 2'));
		}
		points.push(centre(hi, '-', hiEnd.trim));

		const parts = [];
		for (let i = 0; i + 1 < points.length; i += 2) {
			const el = rail.createDiv({ cls: cls });
			el.style.left = points[i];
			el.style.width = 'calc(' + points[i + 1] + ' - ' + points[i] + ')';
			parts.push(el);
		}
		return parts;
	}

	/*
	 * The classes as a git graph. `classTree` decides the whole layout; this only
	 * draws it, which is why the awkward part is testable without a browser.
	 *
	 * Rails are plain elements rather than SVG, deliberately: a row is as tall as
	 * the card in it, and an expanded card is very tall. A vertical rail is a
	 * `top: 0; bottom: 0` element and does not care; an SVG would have to be
	 * measured, redrawn on every fold, and would still stretch its diagonals.
	 *
	 * Edges are elbows for the same reason — a horizontal run at the node's line
	 * and a vertical down the lane. That is what most commit graphs draw anyway.
	 */
	renderClassTree(container, names, objects, drafts, characteristics) {
		const plugin = this.plugin;
		const tree = plugin.classTree(objects, drafts);
		const shown = new Set(names);

		const onRight = plugin.settings.treeRailSide === 'right';
		const tree_el = container.createDiv({
			cls: 'oof-tree' + (onRight ? ' is-right' : '')
				+ (plugin.settings.treeDotTone === 'strong' ? '' : ' is-quiet-dots')
				+ (plugin.settings.treeDotFill === 'solid' ? '' : ' is-hollow-dots')
				+ (plugin.settings.treeCorners === 'square' ? ' is-square-corners' : '')
				+ (plugin.settings.treeWireDash === 'solid' ? ' is-solid-wires' : ''),
		});
		/* The class lanes, and the band of wire lanes outside them. */
		const wireLanes = tree.mergeLanes || 0;
		const allLanes = tree.lanes + wireLanes;
		tree_el.style.setProperty('--oof-lanes', String(allLanes));

		/*
		 * Which column a lane is drawn in. Mirrored on the right so that lane 0 —
		 * the root's, usually — stays the *outermost* one, furthest from the cards.
		 * Flipping the row alone would have turned the graph inside out and put the
		 * deepest classes on the outside.
		 *
		 * Both kinds of lane are placed by how far *out* they sit, which is the one
		 * measure that survives the mirror: 0 is against the cards, `allLanes - 1`
		 * is the far edge. The second-parent wires take the outermost band, so
		 * adding one never moves a node — the class lanes keep their order and
		 * their distance from the cards, and the drawing only grows at the edge.
		 */
		const place = (outward) => (onRight ? outward : allLanes - 1 - outward);
		const column = (lane) => place(tree.lanes - 1 - lane);
		const wireColumn = (lane) => place(tree.lanes + lane);
		const xc = (col) => 'calc(var(--oof-lane-width) * ' + col
			+ ' + var(--oof-lane-width) / 2)';

		/*
		 * The lanes to light up: the run from the active class up to the parent it
		 * descends from, and the edge that joins them. He asked for the connexion
		 * of the highlighted note, and a highlighted node with a grey line into it
		 * says less than nothing — the line is what tells you where it sits.
		 */
		/*
		 * The line of descent for the class the open note belongs to. Worked out
		 * by the plugin, so it can be asserted; drawn here.
		 */
		const at = new Map(tree.rows.map((row, index) => [row.name, index]));
		const path = plugin.litPath(tree, this.active || new Set());
		const lit = path.lanes;
		const litDots = path.dots;

		/* Same drawing, ready to be painted a second time and fainter. */
		this.beginHoverIndex({ kind: 'tree', tree: tree });

		for (const row of tree.rows) {
			if (!shown.has(row.name)) continue;
			const draft = drafts.get(row.name);
			if (!draft) continue;

			const index = at.get(row.name);
			const on = lit.get(index) || new Set();

			const line = tree_el.createDiv({ cls: 'oof-tree-row' });
			this.watchHover(line, row.name);
			const rail = line.createDiv({ cls: 'oof-tree-rail' });

			const x = (lane) => 'calc(var(--oof-lane-width) * ' + column(lane)
				+ ' + var(--oof-lane-width) / 2)';
			/*
			 * `span()` used to live here, laying out an elbow between two lanes.
			 * Both callers — the branch elbow and the second-parent stub — go
			 * through `crossedRun` now, which does the same arithmetic and can also
			 * put a break in the middle of it. Nothing belongs here.
			 */

			/* The rails, each covering as much of the row as the layout says. */
			const below = lit.get(index + 1) || new Set();
			for (const segment of row.segments) {
				/*
				 * This row's own lane running straight through is **two** edges: the
				 * one that brought it here and the one that carries on to its first
				 * child. Only one of them is usually on the path, so it is drawn as
				 * two halves with a flag each — the same fix the aligned drawing
				 * needed, and the same bug: lighting the pair together ran the
				 * highlight one class past where it stops.
				 *
				 * Every other lane on the row is one edge passing by, and lights or
				 * does not as a whole.
				 */
				if (segment.lane === row.lane && segment.kind === 'full') {
					const top_el = this.fileHover('lane:' + index + ':' + segment.lane,
						rail.createDiv({
							cls: 'oof-tree-line oof-tree-line-top oof-tree-at-node'
								+ (on.has(segment.lane) ? ' is-lit' : ''),
						}));
					top_el.style.left = x(segment.lane);
					const bottom_el = this.fileHover('lane:' + (index + 1) + ':' + segment.lane,
						rail.createDiv({
							cls: 'oof-tree-line oof-tree-line-bottom oof-tree-at-node'
								+ (below.has(segment.lane) ? ' is-lit' : ''),
						}));
					bottom_el.style.left = x(segment.lane);
					continue;
				}
				const rail_el = rail.createDiv({
					cls: 'oof-tree-line oof-tree-line-' + segment.kind
						/*
						 * This row's own lane is the one the node sits in, so a segment
						 * of it stops at the circle. Every other lane is an edge on its
						 * way past, or a branch leaving at the turn.
						 */
						+ (segment.lane === row.lane ? ' oof-tree-at-node'
							: (segment.kind === 'bottom' ? ' oof-tree-at-corner' : ''))
						+ (on.has(segment.lane) ? ' is-lit' : ''),
				});
				rail_el.style.left = x(segment.lane);
				this.fileHover('lane:' + index + ':' + segment.lane, rail_el);
			}

			/*
			 * A lane branching off at this row: a horizontal from this node across
			 * to it. Drawn *here*, at the parent, which is the fix — it used to be
			 * drawn at the child's row, where it joined a rail that had not started
			 * yet and so reached nothing.
			 */
			/*
			 * Every column with something vertical standing in it at the height the
			 * elbows run at, so any run reaching past one can be cut where it is.
			 *
			 * A rail *passing* the row counts; this row's own lane never does,
			 * because it is split at the node and both halves stop there — and it
			 * is an end of every run on this row anyway. A branch lane counts: it
			 * starts at this row with a turn sitting exactly on the elbows' line.
			 */
			const crossing = [];
			for (const segment of row.segments) {
				if (segment.kind === 'full' && segment.lane !== row.lane) {
					crossing.push(column(segment.lane));
				}
			}
			for (const branch of row.branches) crossing.push(column(branch.lane));
			for (const wire of tree.merges) {
				if (wire.from <= index && index <= wire.to) {
					crossing.push(wireColumn(wire.lane));
				}
			}

			for (const branch of row.branches) {
				/* The turn where the branch leaves this row's node and heads down. */
				const nodeLeft = column(row.lane) < column(branch.lane);
				const turn = rail.createDiv({
					cls: 'oof-tree-corner oof-tree-corner-down-'
						+ (nodeLeft ? 'right' : 'left')
						+ (on.has(branch.lane) ? ' is-lit' : ''),
				});
				turn.style.left = nodeLeft
					? 'calc(' + x(branch.lane) + ' - var(--oof-corner) + 1px)'
					: 'calc(' + x(branch.lane) + ' - 1px)';
				turn.style.top = 'calc(var(--oof-dot-top) - 1px)';
				this.fileHover('lane:' + index + ':' + branch.lane, turn);

				const label = branch.name + ' is a type of ' + row.name;
				const parts = this.crossedRun(rail,
					'oof-tree-elbow' + (on.has(branch.lane) ? ' is-lit' : ''),
					{ col: column(branch.lane), trim: '(var(--oof-corner) - 1px)' },
					{ col: column(row.lane), trim: 'var(--oof-dot-gap)' },
					crossing);
				for (const part of parts) {
					this.fileHover('lane:' + index + ':' + branch.lane, part);
					part.setAttr('aria-label', label);
					part.setAttr('title', label);
				}
			}

			/*
			 * The second-parent wires: out of the parent's node, down a lane of the
			 * outer band, and back in at the child's. Routed exactly as a bracket
			 * is, because that is what it is — an edge that cannot be a lane of its
			 * own without moving the nodes.
			 *
			 * This replaced a dashed stub drawn only at the child's row, reaching
			 * across to whatever column the parent's lane was in. It never arrived:
			 * a lane is released and handed out again as soon as its class runs out
			 * of descendants, so by the child's row that column usually belonged to
			 * somebody else, and the stub pointed at a stranger.
			 */
			for (const wire of tree.merges) {
				if (index < wire.from || index > wire.to) continue;
				const col = wireColumn(wire.lane);
				/*
				 * Keyed by the two rows it joins, not by the class it arrives at: a
				 * class with three parents has two wires, and they are different
				 * edges that light on different occasions.
				 */
				const key = 'wire:' + wire.from + ':' + wire.to;
				const on_wire = path.wires.has(wire.from + ':' + wire.to);
				const label = wire.name + ' is also a type of ' + wire.parent;
				const kind = index === wire.from ? 'bottom'
					: (index === wire.to ? 'top' : 'full');

				const rail_el = rail.createDiv({
					cls: 'oof-tree-line oof-tree-line-' + kind
						+ (kind === 'full' ? '' : ' oof-tree-at-corner')
						+ ' oof-tree-wire-merge' + (on_wire ? ' is-lit' : ''),
				});
				rail_el.style.left = xc(col);
				rail_el.setAttr('title', label);
				this.fileHover(key, rail_el);

				if (index !== wire.from && index !== wire.to) continue;

				const nodeLeft = column(row.lane) < col;
				const dir = index === wire.from ? 'down' : 'up';
				const turn = rail.createDiv({
					cls: 'oof-tree-corner oof-tree-corner-' + dir + '-'
						+ (nodeLeft ? 'right' : 'left')
						+ ' oof-tree-wire-merge' + (on_wire ? ' is-lit' : ''),
				});
				turn.style.left = nodeLeft
					? 'calc(' + xc(col) + ' - var(--oof-corner) + 1px)'
					: 'calc(' + xc(col) + ' - 1px)';
				turn.style.top = dir === 'down'
					? 'calc(var(--oof-dot-top) - 1px)'
					: 'calc(var(--oof-dot-top) - var(--oof-corner) + 1px)';
				this.fileHover(key, turn);

				const parts = this.crossedRun(rail,
					'oof-tree-elbow oof-tree-wire-merge' + (on_wire ? ' is-lit' : ''),
					{ col: col, trim: '(var(--oof-corner) - 1px)' },
					{ col: column(row.lane), trim: 'var(--oof-dot-gap)' },
					crossing);
				for (const part of parts) {
					this.fileHover(key, part);
					part.setAttr('aria-label', label);
					part.setAttr('title', label);
				}
			}

			/*
			 * The class the note belongs to is filled; everything it descends from
			 * is ringed. Both lit, so the whole line reads as one path, but only
			 * one of them is where the note actually sits.
			 */
			const mark = litDots.get(row.name);
			const dot = rail.createDiv({
				cls: 'oof-tree-dot' + (mark ? ' is-lit is-' + mark : ''),
			});
			dot.style.left = x(row.lane);
			this.fileHover('dot:' + row.name, dot);
			/* And the dot is the select button, when there is a toolbar to feed. */
			this.wireSelectDot(dot, row.name);
			if (plugin.isRootClass(row.name)) dot.addClass('is-root');
			if (row.parents.length > 1) dot.addClass('is-merge');

			const body = line.createDiv({ cls: 'oof-tree-body' });
			this.renderObject(body, draft, objects, drafts, characteristics);
		}

		this.repaintHover();
		return tree_el;
	}

	/*
	 * His drawing: the nodes in one column beside the cards, and a connexion
	 * routed out to the left only when the child is not the row directly below.
	 *
	 * The column nearest the cards is the nodes'; the lanes to its left carry
	 * brackets, the outermost lane the longest reach. Mirrored bodily when the
	 * rails run down the right.
	 *
	 * `compressed` draws the same picture with the wires out of one class sharing
	 * a lane — one trunk, a branch per child. It is not a second renderer: the
	 * plain drawing is the compressed one with every bundle holding a single wire,
	 * and everything below is written in terms of bundles for that reason.
	 */
	renderClassBrackets(container, names, objects, drafts, characteristics, compressed) {
		const plugin = this.plugin;
		const layout = plugin.classBrackets(objects, drafts, compressed);
		const shown = new Set(names);
		const lit = plugin.litBrackets(layout, this.active || new Set());

		/* Same drawing, ready to be painted a second time and fainter. */
		this.beginHoverIndex({ kind: 'brackets', layout: layout });

		const onRight = plugin.settings.treeRailSide === 'right';
		const tree_el = container.createDiv({
			cls: 'oof-tree oof-tree-brackets'
				+ (compressed ? ' is-compressed' : '')
				+ (onRight ? ' is-right' : '')
				+ (plugin.settings.treeDotTone === 'strong' ? '' : ' is-quiet-dots')
				+ (plugin.settings.treeDotFill === 'solid' ? '' : ' is-hollow-dots')
				+ (plugin.settings.treeCorners === 'square' ? ' is-square-corners' : '')
				+ (plugin.settings.treeWireDash === 'solid' ? ' is-solid-wires' : ''),
		});
		/* The lanes, plus the one the nodes stand in. */
		tree_el.style.setProperty('--oof-lanes', String(layout.lanes + 1));

		/*
		 * Column 0 is the outermost lane; the nodes are innermost. On the right
		 * that reflects, so the nodes stay against the cards either way.
		 */
		const nodeColumn = layout.lanes;
		const column = (index) => (onRight ? layout.lanes - index : index);
		const x = (index) => 'calc(var(--oof-lane-width) * ' + column(index)
			+ ' + var(--oof-lane-width) / 2)';
		/* The end at `dot` stops short of the node, as the verticals do. */
		const span = (from, dot) => {
			const a = column(from);
			const b = column(dot);
			return {
				left: 'calc(var(--oof-lane-width) * ' + Math.min(a, b)
					+ ' + var(--oof-lane-width) / 2'
					+ (b < a ? ' + var(--oof-dot-gap)' : '') + ')',
				width: 'calc(var(--oof-lane-width) * ' + Math.abs(a - b)
					+ ' - var(--oof-dot-gap))',
			};
		};
		/* A bracket in lane n is drawn n columns out from the nodes. */
		const laneColumn = (lane) => layout.lanes - 1 - lane;

		layout.rows.forEach((row, index) => {
			if (!shown.has(row.name)) return;
			const draft = drafts.get(row.name);
			if (!draft) return;

			const line = tree_el.createDiv({ cls: 'oof-tree-row' });
			this.watchHover(line, row.name);
			const rail = line.createDiv({ cls: 'oof-tree-rail' });

			/*
			 * `turn` says this piece of line **ends** where it is drawn to, at the
			 * arc it makes towards a node — which is what pulls it back by the
			 * corner's radius. A half that is only half because the run is being
			 * lit in two pieces is not a turn: it carries straight on, and pulling
			 * it back would open a gap in a lane that never stops.
			 */
			const vertical = (col, kind, on, merge, turn) => {
				const atNode = col === nodeColumn;
				const el = rail.createDiv({
					cls: 'oof-tree-line oof-tree-line-' + kind
						/*
						 * The node column ends at a circle; a lane ends at the turn it
						 * makes towards one, which is a corner rather than a node.
						 */
						+ (atNode ? ' oof-tree-at-node'
							: (turn ? ' oof-tree-at-corner' : ''))
						+ (merge ? ' oof-tree-wire-merge' : '')
						+ (on ? ' is-lit' : ''),
				});
				el.style.left = x(col);
				return el;
			};

			/*
			 * The turn itself: a box with two borders and a radius on the corner
			 * between them, which draws a quarter arc. Sitting on the lane, so the
			 * straight above or below it meets it exactly.
			 */
			const corner = (lane, dir, on, merge) => {
				const nodeLeft = column(nodeColumn) < column(lane);
				const el = rail.createDiv({
					cls: 'oof-tree-corner oof-tree-corner-' + dir + '-'
						+ (nodeLeft ? 'right' : 'left')
						+ (merge ? ' oof-tree-wire-merge' : '')
						+ (on ? ' is-lit' : ''),
				});
				el.style.left = nodeLeft
					? 'calc(' + x(lane) + ' - var(--oof-corner) + 1px)'
					: 'calc(' + x(lane) + ' - 1px)';
				el.style.top = dir === 'down'
					? 'calc(var(--oof-dot-top) - 1px)'
					: 'calc(var(--oof-dot-top) - var(--oof-corner) + 1px)';
				return el;
			};

			/*
			 * Which lanes have a rail crossing this row at the height the elbows
			 * run at, so an elbow reaching past them can be cut where they are.
			 *
			 * Only a lane **passing** the row counts. One that ends here stops a
			 * corner's height above the elbows and one that starts here begins a
			 * corner's height below them, so neither is anywhere near.
			 */
			const crossing = layout.bundles
				.filter((bundle) => bundle.from < index && index < bundle.to)
				.map((bundle) => column(laneColumn(bundle.lane)));

			/*
			 * The straight part of the turn: from the arc across to the node. Short
			 * of the lane by the corner, short of the node by the dot gap, and
			 * broken wherever one of those passing rails is in the way.
			 *
			 * `- 1px` again: the arc's stroke is its border, drawn inside the box.
			 */
			const horizontal = (from, dot, on, merge) => this.crossedRun(rail,
				'oof-tree-elbow' + (merge ? ' oof-tree-wire-merge' : '')
					+ (on ? ' is-lit' : ''),
				{ col: column(from), trim: '(var(--oof-corner) - 1px)' },
				{ col: column(dot), trim: 'var(--oof-dot-gap)' },
				crossing);

			/*
			 * The node column, in two halves — always two, never one.
			 *
			 * Drawing a class that both arrives from above and carries on below as
			 * a single `full` segment meant one lit flag for two different runs.
			 * The half above and the half below belong to *different edges*, and
			 * only one of them is usually on the path: lighting the pair together
			 * ran the highlight one class past where it should stop.
			 */
			if (row.straightFrom) {
				this.fileHover('straight:' + index,
					vertical(nodeColumn, 'top', lit.straight.has(index)));
			}
			if (row.straightTo) {
				this.fileHover('straight:' + (index + 1),
					vertical(nodeColumn, 'bottom', lit.straight.has(index + 1)));
			}

			/*
			 * Every bundle of wires that touches this row: one trunk down its lane,
			 * one turn out of the parent at the top of it, and a turn back in at
			 * each child hanging off it. Uncompressed a bundle holds one wire and
			 * the two turns are its two ends, which is exactly the old drawing.
			 */
			for (const bundle of layout.bundles) {
				if (index < bundle.from || index > bundle.to) continue;
				const col = laneColumn(bundle.lane);
				const keyOf = (edge) => 'bracket:' + bundle.lane + ':' + edge.to;
				const onEdge = (edge) => lit.brackets.has(bundle.lane + ':' + edge.to);

				/*
				 * Named for what it is: one wire names its child, a trunk names the
				 * parent they all leave, and the branches name themselves below.
				 */
				const trunkLabel = bundle.edges.length === 1
					? bundle.edges[0].name + ' is a type of ' + bundle.parent
					: bundle.edges.length + ' classes are a type of ' + bundle.parent;

				/*
				 * The trunk, in the pieces this row needs it in.
				 *
				 * It is one line standing for several wires, so it lights for any of
				 * them it is still carrying **here** — and where a branch turns off,
				 * what it carries changes part way down the row. Drawn as a single
				 * `full` line it could only be all lit or all grey, so the highlight
				 * leading to a class ran on past the elbow it ends at.
				 *
				 * So a branch row is **two lines, one over the other**, and they are
				 * not two halves: the run that carries on is drawn `full`, for the
				 * whole row, and the piece that ends here is laid over its top and
				 * **stops at the arc** like every other turn in the drawing. Halving
				 * it at the node's line instead left the lit line overshooting the
				 * curve by the corner's radius — his *"it is still spilling over
				 * because of the rounded corners"* — because the arc leaves the lane
				 * six pixels above the line it was cut at.
				 *
				 * Order is load-bearing, and it is safe: the piece on top carries
				 * everything the one beneath it carries and the wire that ends here
				 * as well, so it is lit whenever the line under it is, and painting
				 * it second can only ever add.
				 *
				 * `first` is the earliest child a piece still carries.
				 */
				const branch = bundle.edges.some((edge) => edge.to === index);
				const anyLit = bundle.edges.some(onEdge);
				const pieces = [];
				if (index === bundle.from) pieces.push(['bottom', true, index + 1]);
				else if (index === bundle.to) pieces.push(['top', true, index]);
				else if (branch) {
					pieces.push(['full', false, index + 1]);
					pieces.push(['top', true, index]);
				} else pieces.push(['full', false, index]);

				for (const [kind, turn, first] of pieces) {
					const carried = bundle.edges.filter((edge) => edge.to >= first);
					const rail_el = vertical(col, kind,
						carried.some(onEdge), bundle.merge, turn);
					rail_el.setAttr('title', trunkLabel);
					for (const edge of carried) this.fileHover(keyOf(edge), rail_el);
				}
				/* Out of the parent, once, at the top of the trunk. */
				if (index === bundle.from) {
					const arc = corner(col, 'down', anyLit, bundle.merge);
					for (const edge of bundle.edges) this.fileHover(keyOf(edge), arc);
					/* One run, but several pieces where it had to give way. */
					for (const part of horizontal(col, nodeColumn, anyLit, bundle.merge)) {
						part.setAttr('title', trunkLabel);
						for (const edge of bundle.edges) this.fileHover(keyOf(edge), part);
					}
				}

				/*
				 * And back in at each child. A child part-way down the trunk is a
				 * branch off a line that carries on below it, so the turn is drawn
				 * over a lane still running — which is what a branch looks like.
				 */
				for (const edge of bundle.edges) {
					if (edge.to !== index) continue;
					const key = keyOf(edge);
					const hot = onEdge(edge);
					const label = edge.name + ' is a type of ' + edge.parent;
					this.fileHover(key, corner(col, 'up', hot, bundle.merge));
					for (const part of horizontal(col, nodeColumn, hot, bundle.merge)) {
						this.fileHover(key, part);
						part.setAttr('title', label);
					}
				}
			}

			const mark = lit.dots.get(row.name);
			const dot = rail.createDiv({
				cls: 'oof-tree-dot' + (mark ? ' is-lit is-' + mark : ''),
			});
			dot.style.left = x(nodeColumn);
			this.fileHover('dot:' + row.name, dot);
			/* And the dot is the select button, when there is a toolbar to feed. */
			this.wireSelectDot(dot, row.name);
			if (plugin.isRootClass(row.name)) dot.addClass('is-root');
			if (row.parents.length > 1) dot.addClass('is-merge');

			const body = line.createDiv({ cls: 'oof-tree-body' });
			this.renderObject(body, draft, objects, drafts, characteristics);
		});

		this.repaintHover();
		return tree_el;
	}

	/*
	 * Drafting a class. Both ways in arrive here — the + beside the count, and
	 * *New subclass of X…* in a class's own menu — so the two guards are stated
	 * once rather than once each. The + used to fail silently on a name already
	 * taken; it says so now, which is the only behaviour that changed.
	 *
	 * `parent` is the whole of what makes a subclass a subclass: a draft whose
	 * `type of` already names the class the menu was opened on. Nothing is written
	 * to the vault — a new class is a draft like every other edit here, and Update
	 * is what tells the vault about it.
	 */
	createClassNamed(name, drafts, parent) {
		const plugin = this.plugin;
		const clean = String(name || '').trim();
		if (!clean) return false;

		if (drafts.has(clean)) {
			new Notice('OOF Class Manager: there is already a class called "'
				+ clean + '".', 5000);
			return false;
		}
		/*
		 * The prefix is a characteristic's. A class drafted under one goes on to
		 * create `∘ Thing.md`, `∘ Thing Template.md` and `∘ Thing Base.base`, none
		 * of which is a thing that should exist.
		 */
		if (plugin.looksLikeCharacteristic(clean)) {
			new Notice('OOF Class Manager: "' + plugin.settings.characteristicPrefix
				+ '" starts the name of a characteristic, not a class.', 6000);
			return false;
		}

		/*
		 * Only the row that says anything — `type of` when this is a subclass, and
		 * nothing at all otherwise. It used to be `emptyLogicValues()`, which
		 * spells out all five rows as `[]`, and `[]` is how the panel says *he
		 * cleared this row*. Harmless while the class has no note, since there is
		 * nothing to disagree with; a trap the moment one appears by any route
		 * other than Update, because the placeholder then reads as five deliberate
		 * clearings and the next Update empties the note. See `setDraftValue`.
		 */
		const values = {};
		if (parent) values[plugin.settings.inheritsProperty] = [parent];
		plugin.drafts.set(clean, { values: values });

		/*
		 * Opened, because a new class is empty and the one thing worth seeing on it
		 * is the `type of` row already naming its parent — the confirmation that
		 * the subclass really is one, before Update has written a byte.
		 */
		plugin.expanded.add(clean);
		plugin.persist().then(() => { this.render(); });
		return true;
	}

	classActionSpecs(objects, drafts, names, options) {
		const plugin = this.plugin;
		const opts = options || {};
		const list = Array.isArray(names) ? names.filter(Boolean) : [names];
		if (list.length === 0) return [];

		const primary = list[0];
		const draft = drafts.get(primary);
		if (!draft) return [];
		const many = list.length > 1;
		const phrase = andList(list.slice());

		const templateFile = this.app.vault.getFileByPath(plugin.templatePathFor(primary));
		const baseFile = this.app.vault.getFileByPath(plugin.basePathFor(primary));

		/*
		 * A component is never instantiated, so the two things that would make an
		 * instance of one are refused rather than pending: *New X*, and *Apply to
		 * the open note*, which is the same act written into a note that already
		 * exists.
		 *
		 * Refused with the reason in words, not hidden. A button that disappears
		 * for some classes teaches nothing; one that says *New Project — Project is
		 * a component* teaches the distinction his note is asking to make explicit,
		 * in the place where the mistake would have been made.
		 *
		 * **A class whose kind is in dispute refuses for its own reason.** The plan
		 * stands aside for one of those — its tag is untouched and its template is
		 * still on disk — so saying "a component" here would be the panel deciding
		 * what the plan declined to decide. Making an instance is still refused,
		 * because a note whose class may be a component is a discrepancy waiting to
		 * be reported; *Open template* is not, because the file is there and the
		 * plugin kept it on purpose.
		 */
		const componentsIn = list.filter((name) => plugin.isComponent(name));
		const disputedIn = list.filter((name) => plugin.isDisputedComponent(name));
		const isComponent = componentsIn.indexOf(primary) !== -1;
		const isDisputed = disputedIn.indexOf(primary) !== -1;
		const componentSaid = disputedIn.length > 0
			? andList(disputedIn) + ' is a component by one parent and a class by another, '
				+ 'so its kind is unsettled — the discrepancy list says which parents'
			: (componentsIn.length === 1
				? andList(componentsIn) + ' is a component'
				: andList(componentsIn) + ' are components');
		const componentShort = disputedIn.length > 0 ? 'kind in dispute' : 'a component';

		const specs = [];
		/*
		 * A file that does not exist yet is *pending*; an action that cannot apply
		 * to this selection is *blocked*. Both carry a `reason`, and carrying it on
		 * the spec rather than in the drawing code is what lets the menu say it in
		 * words where an icon can only say it after being pressed.
		 */
		const pending = (why, short) => ({ cls: 'oof-icon-pending', reason: why, short: short });
		const blocked = (why, short) => ({ cls: 'oof-icon-disabled', reason: why, short: short });

		if (opts.includeNote !== false) {
			specs.push(Object.assign({
				icon: 'file-text',
				group: 'open',
				label: 'Open note',
				tooltip: draft.file ? draft.file.path : null,
				run: () => { this.app.workspace.getLeaf(false).openFile(draft.file); },
			}, draft.file ? {} : pending(
				'No note for "' + primary + '" yet — Update creates it.', 'no note yet')));
		}

		if (isComponent && !isDisputed) {
			specs.push(Object.assign({
				icon: 'layout-template',
				group: 'open',
				label: 'Open template',
			}, blocked(
				primary + ' is a component, so it has no template — a component is '
					+ 'filled into a field rather than instantiated.',
				'a component')));
		} else if (many) {
			specs.push(Object.assign({
				icon: 'layout-template',
				group: 'open',
				label: 'Open template',
			}, blocked(
				'A template belongs to one class, and ' + list.length + ' are selected ('
					+ phrase + ').',
				'one class at a time')));
		} else {
			specs.push(Object.assign({
				icon: 'layout-template',
				group: 'open',
				label: 'Open template',
				tooltip: templateFile instanceof TFile ? templateFile.path : null,
				run: () => { this.app.workspace.getLeaf(false).openFile(templateFile); },
			}, templateFile instanceof TFile ? {} : pending(
				'No template for "' + primary + '" yet — Update creates it.', 'none yet')));
		}

		if (plugin.settings.createBases && many) {
			/*
			 * The dynamic base: one file, rewritten to whichever classes are
			 * selected. It is the single thing in the plugin written without an
			 * Update plan in front of it — see `openDynamicBase`, which refuses a
			 * file of that name it did not create.
			 */
			if (plugin.settings.multiClassBase === 'dynamic') {
				specs.push({
					icon: 'table-2',
					group: 'open',
					label: 'Open the dynamic base',
					tooltip: 'One base showing every instance of ' + phrase + '. It is '
						+ 'rewritten each time you open it with a different selection.',
					run: () => { plugin.openDynamicBase(list, objects, drafts); },
				});
			} else {
				specs.push(Object.assign({
					icon: 'table-2',
					group: 'open',
					label: 'Open base',
				}, blocked(
					'Two bases cannot be opened at once. Switch "Several classes at once" '
						+ 'to the dynamic base to see ' + phrase + ' in one.',
					'one class at a time')));
			}
		} else if (plugin.settings.createBases) {
			specs.push(Object.assign({
				icon: 'table-2',
				group: 'open',
				label: 'Open base',
				tooltip: baseFile ? baseFile.path : null,
				run: () => { this.app.workspace.getLeaf(false).openFile(baseFile); },
			}, baseFile ? {} : pending(
				'No base for "' + primary + '" yet — Update creates it.', 'none yet')));
		}

		/*
		 * Applying the class to the note he already has open. Always offered, never
		 * hidden by what the active note happens to be: the panel would then
		 * re-render its icons on every file he opens, and a button that comes and
		 * goes is worse than one that explains itself when pressed.
		 *
		 * With several selected the note becomes all of them at once — his note:
		 * *"will give that note all of the selected classes"*.
		 */
		if (componentsIn.length > 0) {
			specs.push(Object.assign({
				icon: 'file-check',
				group: 'make',
				cls: 'oof-apply-class',
				label: many ? 'Apply these classes to the open note' : 'Apply to the open note',
			}, blocked(
				componentSaid + ', and applying a class writes `'
					+ plugin.settings.isAProperty + '` — which no note should name a '
					+ 'component under.',
				componentShort)));
		} else {
			specs.push({
				icon: 'file-check',
				group: 'make',
				cls: 'oof-apply-class',
				label: many ? 'Apply these classes to the open note' : 'Apply to the open note',
				tooltip: 'Make the open note '
					+ andList(list.map((name) => article(name) + ' ' + name)),
				run: () => {
					const file = this.app.workspace.getActiveFile();
					const situation = plugin.applyClassAction(list, file);
					if (situation.reason) {
						new Notice('OOF Class Manager: ' + situation.reason, 5000);
						return;
					}
					new ApplyClassModal(this.app, plugin, list, file, situation,
						() => this.render()).open();
				},
			});
		}

		/*
		 * Making an instance is what a class is *for*, so it ends the row and gets
		 * the biggest glyph. Obsidian's own "new note" icon, because that is what
		 * it does.
		 *
		 * With several selected the new note is `is a` all of them, and it is made
		 * from the **first** one's template — a note comes from one file, and that
		 * is the only place the body can come from.
		 */
		if (componentsIn.length > 0) {
			specs.push(Object.assign({
				icon: 'file-plus',
				group: 'make',
				label: many ? 'New note' : 'New ' + primary,
			}, blocked(
				componentSaid + ', so a note made from it would be an instance of a '
					+ 'component. A component is written into a field on a note that is '
					+ 'a class.',
				componentShort), { cls: 'oof-icon-disabled oof-new-instance' }));
		} else if (templateFile instanceof TFile) {
			specs.push({
				icon: 'file-plus',
				group: 'make',
				cls: 'oof-new-instance',
				label: many ? 'New note that is ' + phrase : 'New ' + primary,
				tooltip: many
					? 'New note that is ' + andList(list.map((name) => article(name) + ' ' + name))
						+ ', from ' + primary + '’s template'
					: 'New ' + primary + ', from its template',
				run: () => {
					/*
					 * No name is asked for — his call, 2026-08-24. The note is named
					 * after the moment it was made, which is the whole point of the
					 * *Unique file name* setting: there is nothing to ask.
					 *
					 * The modal survives for the one case that still has a question to
					 * answer: with the format emptied the convention is off, and there
					 * is no name to generate.
					 */
					const format = String(plugin.settings.uniqueNameFormat || '').trim();
					if (format) {
						plugin.createInstanceOfMany(list, plugin.uniqueInstanceName(format));
						return;
					}
					new NewInstanceModal(this.app, phrase, (noteName) => {
						plugin.createInstanceOfMany(list, noteName);
					}).open();
				},
			});
		} else {
			specs.push(Object.assign({
				icon: 'file-plus',
				group: 'make',
				label: many ? 'New note' : 'New ' + primary,
			}, pending(
				many
					? 'No template for "' + primary + '" yet, and a new note is made from the '
						+ 'first selected class’s template. Press Update first.'
					: 'No template for "' + primary + '" yet — Update creates it, and a new '
						+ 'note is made from it.',
				'no template yet'), { cls: 'oof-icon-pending oof-new-instance' }));
		}

		return specs;
	}

	/*
	 * The buttons that act on a class: its note, its template, its base, applying
	 * it to the note he has open, and making an instance of it. Drawn either on
	 * the class's own card or once in the toolbar above the list, so they are
	 * built here and handed the box to go in.
	 *
	 * The note button is the one that differs between the two. In toolbar mode it
	 * is left out, because there the class name is what opens the note.
	 *
	 * A file that does not exist yet keeps its place, faint, and says why when
	 * clicked: the row would jump about as templates and bases came into being
	 * otherwise. Since 2026-08-30 that rule finally covers the note button and the
	 * new-instance button too — both used to be dropped outright when their file
	 * was missing, which is the jumping the rule exists to stop.
	 *
	 * **`names` is a list**, because a custom selection can hold several classes
	 * and the meaning is "all of these at once", not "this, five times". Two of
	 * them split on that count:
	 *
	 *   apply, new instance   act on every selected class — one note that is a
	 *                         Person and a Teacher, not two notes
	 *   template, base        each belongs to exactly one class, so with several
	 *                         selected they grey out and say why
	 *
	 * The base is the one his note singles out, because two bases cannot be opened
	 * at once. *Where several classes share a base* decides: grey it out, or open
	 * the one dynamic base rewritten to show them all.
	 *
	 * The first selected class is the primary one and the single-class buttons
	 * follow it, so that with one selected nothing about this row has changed.
	 *
	 * What each button *is* lives in `classActionSpecs`, which a class's own
	 * right-click menu reads as well — so the row and the menu cannot come to
	 * disagree about what opening a base means, or about when it is possible.
	 */
	classActionButtons(actions, objects, drafts, names, options) {
		for (const spec of this.classActionSpecs(objects, drafts, names, options)) {
			this.iconButton(actions, spec.icon, {
				cls: spec.cls || '',
				label: spec.label,
				tooltip: spec.reason || spec.tooltip || spec.label,
				onClick: (event) => {
					if (spec.reason) {
						new Notice('OOF Class Manager: ' + spec.reason, 6000);
						return;
					}
					spec.run(event);
				},
			});
		}
	}

	renderObject(container, draft, objects, drafts, characteristics) {
		const plugin = this.plugin;
		const isActive = this.active && this.active.has(draft.name);
		const open = plugin.expanded.has(draft.name);

		const isRoot = plugin.isRootClass(draft.name);
		const card = container.createDiv({
			cls: 'oof-object' + (isActive ? ' oof-object-active' : '')
				+ (isRoot ? ' oof-object-is-root' : '')
				+ (open ? ' is-open' : ' is-closed'),
		});

		/*
		 * Where the buttons are. In toolbar mode this card carries none of them:
		 * the top line is left to say what the class is, and the one control that
		 * survives — the three-dot menu — moves to the far right.
		 */
		const onToolbar = plugin.settings.classActions === 'toolbar';

		/*
		 * --- 1. one row per class: the name and everything that acts on it ---
		 *
		 * The row is the dropdown's handle, so a click anywhere on it that is not
		 * an icon opens or closes the card.
		 */
		const title = this.titleRow(card);
		title.onclick = async () => {
			await plugin.toggleExpanded(draft.name);
			this.render();
		};

		/*
		 * The dot, in the layouts that have no rail to hang one in — his N.B.
		 * *"we will need to change the simple list view for the classes to still
		 * have dots, even if they will not be connected to anything."*
		 *
		 * Before the twisty, which is where the rail's node is relative to the card
		 * in the other two layouts: outside everything, at the leading edge. It
		 * takes a hit area of its own rather than relying on 8 pixels of circle.
		 */
		if (this.selecting && this.flatList) {
			const hit = title.createSpan({ cls: 'oof-dot-hit' });
			this.wireSelectDot(hit.createSpan({ cls: 'oof-flat-dot' }), draft.name, hit);
		}

		const twisty = title.createSpan({ cls: 'oof-twisty' });
		if (typeof setIcon === 'function') setIcon(twisty, 'chevron-right');

		/*
		 * The symbol, before the name — the position his own vault already uses for
		 * one (`• Violet`, `‣ snag`, `∘ domain`), and the reason it reads as
		 * belonging to the name rather than as another badge after it.
		 *
		 * An inherited one is drawn faintly, so a chain marked once at the top does
		 * not look like six classes each claiming the same symbol.
		 */
		const symbol = plugin.symbolFor(draft.name, objects, drafts);
		if (symbol.symbol) {
			const mark = title.createSpan({
				cls: 'oof-symbol' + (symbol.inherited ? ' is-inherited' : ''),
				attr: {
					title: symbol.inherited
						? 'Inherited from ' + symbol.source
						: draft.name + '’s own symbol',
				},
			});
			paintSymbol(mark, symbol.symbol);
		}

		const nameEl = title.createSpan({
			text: draft.name,
			cls: 'oof-object-name' + (onToolbar ? ' is-link' : ''),
		});

		/*
		 * With the note icon gone, the name is what opens the note — his ask. It
		 * stops the click going any further, so the name opens and the rest of the
		 * row still folds: two things to do with one row, and the one you meant is
		 * decided by which of them you aimed at.
		 */
		if (onToolbar) {
			nameEl.setAttribute('title', draft.file ? draft.file.path : 'No note yet');
			nameEl.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.openClassNote(draft.name, drafts);
			};
		}

		/*
		 * The pencil belongs to the name, so it stays beside it rather than joining
		 * the file links: those open a file, these change one.
		 *
		 * It is a **menu** rather than a straight rename (his call, 2026-08-24), and
		 * the reason is the row rather than the menu: it is already full — a symbol
		 * button of its own was what crushed the class name last time — and both of
		 * these change what the class *is called*, by name or by mark.
		 */
		const rename = () => {
			new RenameClassModal(this.app, plugin, draft.name, async (next) => {
				const result = await plugin.renameClass(draft.name, next);
				if (!result.ok) {
					if (result.reason !== 'unchanged') new Notice('OOF Class Manager: ' + result.reason, 6000);
					return;
				}
				new Notice('OOF Class Manager: renamed to "' + next + '". Obsidian updated the links.');
				this.render();
			}).open();
		};

		const pickSymbol = () => {
			new SymbolPickerModal(this.app, plugin, {
				className: draft.name,
				current: draft.symbol || '',
				inherited: plugin.symbolFor(draft.name, objects, drafts),
				onPick: (value) => { this.setDraftSymbol(draft, value); },
			}).open();
		};

		const remove = () => {
			const fallout = plugin.deleteFallout(draft.name);
			const targets = plugin.renameTargets(draft.name);
			const lines = [];

			lines.push(targets.length > 0
				? 'These go to the trash: ' + targets.join(', ') + '.'
				: 'This class has no note yet, so only the panel changes.');

			if (fallout.children.length > 0) {
				lines.push(fallout.children.join(', ')
					+ (fallout.children.length === 1 ? ' is a type of ' : ' are types of ')
					+ draft.name + ' and will be left pointing at nothing. They are not '
					+ 'touched — give them another parent afterwards.');
			}
			if (fallout.instances.length > 0) {
				lines.push(fallout.instances.length + ' note'
					+ (fallout.instances.length === 1 ? '' : 's') + ' say '
					+ '`' + plugin.settings.isAProperty + ': ' + draft.name + '`'
					+ ' — they keep every property they carry, and nothing will declare '
					+ 'those properties any more.');
			}
			lines.push('The files go to Obsidian\'s trash, so this is undoable there. '
				+ 'Nothing else is written.');

			new ConfirmCodeModal(this.app, {
				title: 'Delete the class "' + draft.name + '"?',
				lines: lines,
				confirmText: 'Delete the class',
				onConfirm: async () => {
					const done = await plugin.deleteClass(draft.name);
					new Notice('OOF Class Manager: "' + draft.name + '" deleted — '
						+ (done.trashed.length > 0
							? done.trashed.length + ' file'
								+ (done.trashed.length === 1 ? '' : 's') + ' in the trash.'
							: 'it had no files.'));
					this.render();
				},
			}).open();
		};

		/*
		 * Making a subclass of this one — his ask, 2026-08-30. It is a class like
		 * any other; the only thing the menu adds is that its `type of` already
		 * names the class you right-clicked, which is the whole of what "sub" means
		 * here. Drafted, not written: like every other class it waits for Update.
		 */
		const newSubclass = () => {
			new NewObjectModal(this.app, plugin, (name) => {
				this.createClassNamed(name, drafts, draft.name);
			}, {
				heading: 'New subclass of ' + draft.name,
				desc: 'The class note to create. It starts out ' + plugin.settings.inheritsProperty
					+ ' ' + draft.name + ', so it inherits every characteristic ' + draft.name
					+ ' declares.',
			}).open();
		};

		/*
		 * Everything that acts on a class, in one menu — his ask, 2026-08-30:
		 * *"right clicking on a class should bring up all the important options"*.
		 *
		 * **It is one menu with two ways in**, the three-dot button and a
		 * right-click anywhere on the class's line, rather than a short menu on the
		 * button and a long one on the row. Two menus over one class are two places
		 * to add the next item to, and the one you did not update is the one he
		 * right-clicks.
		 *
		 * **The five file actions are read off `classActionSpecs`**, which is what
		 * draws the icon row, so the menu cannot come to disagree with the buttons
		 * about when a base can be opened or what applying does. The menu gets
		 * something the icons never could, though: a missing file can say so in
		 * words — *Open template — none yet* — instead of being a faint glyph that
		 * only explains itself once pressed. Disabled items in Obsidian swallow
		 * their own clicks (`MenuItem.handleEvent` returns early), so saying it in
		 * the title is not a nicety here, it is the only way to say it at all.
		 *
		 * The order is what each item does to the vault: go somewhere, make
		 * something, change what this class is, destroy it. Delete sits alone after
		 * a separator, at the far end of that progression.
		 */
		const classMenu = (event) => {
			/* No Menu in the harness, and none needed: rename is what it was. */
			if (typeof Menu !== 'function') {
				rename();
				return;
			}

			const menu = new Menu();
			const separate = () => {
				if (typeof menu.addSeparator === 'function') menu.addSeparator();
			};

			const add = (options) => menu.addItem((item) => {
				item.setTitle(options.title);
				if (options.icon) item.setIcon(options.icon);
				if (options.tooltip && item.dom && item.dom.setAttribute) {
					item.dom.setAttribute('title', options.tooltip);
				}
				if (options.disabled) {
					if (typeof item.setDisabled === 'function') item.setDisabled(true);
					return;
				}
				item.onClick(options.run);
			});

			let group = null;
			for (const spec of this.classActionSpecs(objects, drafts, [draft.name],
				{ includeNote: true })) {
				if (group !== null && spec.group !== group) separate();
				group = spec.group;
				add({
					title: spec.reason ? spec.label + ' — ' + (spec.short || 'not now') : spec.label,
					icon: spec.icon,
					tooltip: spec.reason || spec.tooltip,
					disabled: Boolean(spec.reason),
					run: () => { spec.run(event); },
				});
			}

			separate();
			add({
				title: 'New subclass of ' + draft.name + '…',
				icon: 'git-branch-plus',
				tooltip: 'A new class that is ' + plugin.settings.inheritsProperty + ' '
					+ draft.name,
				run: newSubclass,
			});

			separate();
			add({ title: 'Rename…', icon: 'pencil', run: rename });
			if (plugin.settings.symbolProperty) {
				/*
				 * No *Remove symbol* here, his call: removing one is a thing you do
				 * having looked at what it is, and the picker already offers it. A
				 * menu that both opens a chooser and quietly throws the choice away
				 * puts a destructive item one slip below an ordinary one.
				 */
				add({
					title: draft.symbol ? 'Change symbol…' : 'Add a symbol…',
					icon: 'shapes',
					run: pickSymbol,
				});
			}

			separate();
			add({ title: 'Delete class…', icon: 'trash-2', run: remove });

			if (event && typeof menu.showAtMouseEvent === 'function') {
				menu.showAtMouseEvent(event);
			} else if (typeof menu.showAtPosition === 'function') {
				menu.showAtPosition({ x: 0, y: 0 });
			}
		};

		/*
		 * Three dots rather than a pencil (his call, 2026-08-24, in two steps: first
		 * a hamburger, then this). The button opens a menu of things that act on the
		 * class, and a pencil says "rename" — which it was, back when renaming was
		 * all it did. A hamburger says *navigation*, the application's own menu;
		 * three dots say *more actions for this item*, which is what this is.
		 */
		const addClassMenu = (parent, extra) => this.iconButton(parent, overflowIconName(), {
			cls: ('oof-rename ' + (extra || '')).trim(),
			label: 'Class menu',
			tooltip: 'Everything that acts on this class — right-clicking the row '
				+ 'opens the same menu',
			onClick: classMenu,
		});

		/*
		 * The row itself is the second way in, and in toolbar mode it is the useful
		 * one: there the card carries no buttons at all, and the toolbar acts on
		 * whatever is *selected* — so without this there is no way to open the base
		 * of a class you can see but have not selected.
		 *
		 * `stopPropagation` because the chips in the body have a context menu of
		 * their own; this one belongs to the line that names the class.
		 */
		title.oncontextmenu = (event) => {
			if (typeof Menu !== 'function') return;
			event.preventDefault();
			event.stopPropagation();
			classMenu(event);
		};

		/*
		 * Beside the name while the action icons are here too — it is about what
		 * the class is called, and the icons are about its files, so the two kinds
		 * sit at opposite ends. With the icons gone there is no other end, and it
		 * takes the far right, which is where it is looked for.
		 */
		if (!onToolbar) addClassMenu(title);

		/*
		 * How much this class adds. First of the badges, because it is about the
		 * class itself rather than about its relation to what you have open, and
		 * because a column of numbers in the same place down the panel can be read
		 * at a glance — which is the whole point of rating them.
		 */
		if (plugin.settings.showClassNovelty) {
			const novelty = plugin.noveltyOf(draft.name, objects, drafts);
			title.createSpan({
				text: '+' + novelty.added.length,
				cls: 'oof-badge oof-badge-novelty'
					+ (novelty.added.length === 0 ? ' is-nothing' : '')
					+ (novelty.redeclared.length > 0 ? ' has-redeclared' : ''),
				attr: { title: plugin.noveltyTooltip(draft.name, novelty) },
			});
		}

		/*
		 * How many notes it holds, beside how much it adds.
		 *
		 * The two numbers are the pair the card is for: `+3` is what this class
		 * *says*, and the count beside it is who is *listening*. A class that adds
		 * three characteristics to nothing at all is a different thing from one
		 * that adds three to a hundred and fifty notes, and until now nothing on
		 * the card said which — the diagram said it first, and this is that number
		 * brought back to the panel he actually works in.
		 *
		 * **It is a button, and that is what decides which number it is.** The
		 * diagram counts a class's *direct* instances, because the boxes below it
		 * carry the rest and the tree can be read. Here there is nowhere for the
		 * rest to be, and pressing it opens the base — so it counts what the base
		 * holds, exclusions and exactness included. A badge that opened a view of
		 * 151 notes while saying 3 would be a worse badge than none.
		 */
		const holds = plugin.classBaseHolds(draft.name);
		const count = title.createEl('button', {
			text: String(holds.count),
			cls: 'oof-badge oof-badge-holds'
				+ (holds.count === 0 ? ' is-nothing' : '')
				+ (holds.file ? '' : ' is-pending')
				+ (holds.readable || !holds.file ? '' : ' is-foreign'),
			attr: { title: plugin.classBaseHoldsSaid(draft.name, holds) },
		});
		/*
		 * A base that does not exist yet keeps its place, faint — the row's own
		 * rule, and the number is still true whether or not there is a file to
		 * show it in. `disabled` rather than a missing button, so the column of
		 * numbers down the panel stays a column.
		 */
		if (!holds.file) count.disabled = true;
		else {
			count.onclick = (event) => {
				event.stopPropagation();
				this.app.workspace.getLeaf(event.ctrlKey || event.metaKey)
					.openFile(holds.file);
			};
		}

		/*
		 * *"The difference between classes and components should be made
		 * explicit."* This is where it is made explicit: the panel is where he
		 * reads the classes, and the badge is the one place a component says so
		 * before he goes looking for its template.
		 *
		 * A word rather than a colour, and the tooltip carries the derivation,
		 * because a component is the only kind here the plugin decided on its own.
		 */
		if (plugin.isComponent(draft.name)) {
			title.createSpan({
				text: 'component',
				cls: 'oof-badge oof-badge-component',
				attr: {
					title: plugin.componentReason(draft.name,
						plugin.picture().componentClasses)
						+ ' It has no template and is never instantiated.',
				},
			});
		}

		/* Said, not only coloured: nothing else in the panel explains the pinning. */
		if (isRoot) title.createSpan({ text: 'root', cls: 'oof-badge oof-badge-root' });
		if (draft.isNew) title.createSpan({ text: 'new', cls: 'oof-badge' });

		/*
		 * This class is carrying an edit the vault has not been told about — and
		 * the tooltip says which rows, because that is the half that matters. An
		 * emptied row looks exactly like a class that declares nothing, so without
		 * this the panel shows a pending clearing and an honest empty class in the
		 * same ink.
		 *
		 * The same word and the same chip as the header's, deliberately: *pending*
		 * there means "work the vault has not been told about yet", which is what
		 * it means here, one class at a time. A new class is skipped — its `new`
		 * badge already says the note does not exist, and everything about it is
		 * pending by definition.
		 */
		if (!draft.isNew && plugin.drafts.has(draft.name)) {
			const stored = objects.get(draft.name);
			const rows = plugin.pendingRows(draft, stored);
			const symbolMoved = plugin.settings.symbolProperty
				&& (draft.symbol || '') !== ((stored && stored.symbol) || '')
				? plugin.settings.symbolProperty + ': '
					+ (((stored && stored.symbol) || '') || 'empty') + '  →  '
					+ ((draft.symbol || '') || 'empty')
				: '';

			if (rows.length > 0 || symbolMoved) {
				title.createSpan({
					text: 'pending',
					cls: 'oof-badge oof-badge-dirty',
					attr: { title: plugin.pendingTooltip(draft.name, rows, symbolMoved) },
				});
			}
		}
		if (isActive && this.selectionMode === 'custom') {
			/*
			 * A different word, because it is a different claim. `active` and `is a`
			 * say something about the note you are reading; this one says you picked
			 * it, and nothing about the note is involved.
			 */
			title.createSpan({ text: 'selected', cls: 'oof-badge oof-badge-active' });
		} else if (isActive) {
			/*
			 * Chipped whatever the relation is, so the chip is the constant and the
			 * word inside it says which relation: `active` when the class note
			 * itself is what you are reading, `is a` for one of its instances, and
			 * since 2026-08-27 `template`, `base` and `declares` for the three other
			 * ways a file can be about a class.
			 *
			 * The prose half — "active note" — is kept only for an instance, where
			 * the chip is about the link and something else still has to say which
			 * note is meant. The other four sit on the thing they are talking about
			 * closely enough that the chip alone is the whole sentence.
			 */
			const WORDS = {
				self: 'active',
				template: 'template',
				base: 'base',
				characteristic: 'declares',
				instance: 'is a',
			};
			const kind = this.activeKind || 'self';

			if (kind === 'instance') {
				title.createSpan({ text: 'active note', cls: 'oof-active-label' });
			}
			title.createSpan({
				text: WORDS[kind] || 'active',
				cls: 'oof-badge oof-badge-active',
			});
		}

		const actions = title.createDiv({ cls: 'oof-object-actions' });

		/*
		 * In toolbar mode this box holds the menu alone. It is still this box,
		 * rather than one of its own, because everything that keeps a control
		 * against the right-hand edge while a long row scrolls under it is already
		 * written against `.oof-object-actions`.
		 */
		if (onToolbar) addClassMenu(actions, 'oof-rename-end');
		else this.classActionButtons(actions, objects, drafts, [draft.name], { includeNote: true });

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
		/*
		 * A `views` chip names a base, so it opens the base - and says so when
		 * there is none, rather than offering to make a class of that name.
		 */
		const openView = (name) => {
			const file = plugin.resolveBase(splitViewLink(name).target, '');
			if (file) {
				this.app.workspace.getLeaf(false).openFile(file);
				return;
			}
			new Notice('No base called "' + splitViewLink(name).target + '".', 4000);
		};

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
		 * The symbol had a row of its own here, with a box and a small palette. It
		 * moved into the pencil's menu 2026-08-24 at his ask — one place to change
		 * what a class is called, whether by name or by mark, and a card that is not
		 * carrying a picker it rarely needs.
		 */

		/*
		 * --- 2 and 3. one row per base characteristic, in the order he lists
		 * them. `characteristics` takes note names from the characteristics
		 * folder; everything else points at objects.
		 */
		for (const property of plugin.settings.logicProperties) {
			const kind = plugin.logicValueKind(property);
			const isCharacteristics = kind === 'characteristic';
			const isComponents = kind === 'component';
			const isViews = kind === 'view';
			/*
			 * Both name characteristics, so both rows suggest, open, grey and
			 * right-click the same way. What they *mean* differs, and that is said
			 * in the tooltip and in the row drawn underneath — not here.
			 */
			const namesCharacteristic = isCharacteristics || isComponents;

			/*
			 * Four kinds of value, four sets of answers. A `views` row names bases
			 * rather than classes, so every one of these would otherwise be wrong:
			 * it would suggest class names, grey the chip for having no note, offer
			 * to open a class that does not exist, and show `Improvement Base` where
			 * he wrote `Improvement Base.base#dynamic project`.
			 */
			this.renderChipRow(body, property, draft.values[property] || [], {
				owner: draft.name,
				suggestions: namesCharacteristic
					? Array.from(characteristics.keys())
					: (isViews ? [] : objectNames),
				pick: isViews
					? (taken, add) => plugin.promptForView(taken, add)
					: null,
				onChange: (next) => { this.setDraftValue(draft, property, next); },
				onOpen: namesCharacteristic
					? openCharacteristic
					: (isViews ? openView : openObject),
				label: isViews ? (name) => plugin.viewLabel(name) : null,
				tooltip: isComponents
					? (name) => this.componentTooltip(name, characteristics)
					: (isCharacteristics ? characteristicTooltip : (isViews
						? (name) => plugin.viewTooltip(name)
						: (name) => {
							const object = objects.get(name);
							return object && object.file ? name : name + ' — no note yet';
						})),
				menu: namesCharacteristic
					? (name, event) => {
						if (characteristics.has(name)) this.characteristicMenu(name, event);
					}
					: null,
				missing: namesCharacteristic
					? (name) => !characteristics.has(name)
					: (isViews
						? (name) => !plugin.viewResolves(name)
						: (name) => {
							const object = objects.get(name);
							return (!object || !object.file) && !characteristics.has(name);
						}),
			});

			/*
			 * The component fields this class inherits, under the row that extends
			 * them — the same shape as `inherited` under `characteristics`, because
			 * it is the same walk and the same reason to show it: they are fields
			 * instances of this class carry, and they belong to a parent.
			 */
			if (isComponents) {
				const ownFields = new Set(draft.componentFields);
				const inheritedFields = plugin
					.effectiveComponentFields(draft.name, objects, drafts)
					.filter((field) => !ownFields.has(field));

				if (inheritedFields.length > 0) {
					this.renderChipRow(body, 'inherited components', inheritedFields, {
						onOpen: openCharacteristic,
						tooltip: (name) => this.componentTooltip(name, characteristics),
						missing: (name) => !characteristics.has(name),
						menu: (name, event) => {
							if (characteristics.has(name)) this.characteristicMenu(name, event);
						},
						muted: true,
					});
				}
			}

			/*
			 * What this note carries *itself* because of what it is a. Shown under
			 * the `is a` row that causes it, the way `inherited` sits under
			 * `characteristics`: each inheritance appears beneath its own cause.
			 */
			if (property === plugin.settings.isAProperty) {
				const carried = plugin.carriedCharacteristics(draft.name, objects, drafts);
				if (carried.length > 0) {
					this.renderChipRow(body, 'carries', carried, {
						onOpen: openCharacteristic,
						tooltip: (name) => {
							const base = characteristicTooltip(name);
							return base + ' — on this note itself, because it is a '
								+ (draft.values[plugin.settings.isAProperty] || []).join(', ');
						},
						missing: (name) => !characteristics.has(name),
						menu: (name, event) => {
							if (characteristics.has(name)) this.characteristicMenu(name, event);
						},
						muted: true,
					});
				}
			}

			/*
			 * Inherited characteristics cannot be edited here - they belong to
			 * the parent - but they still open their note, which is half the
			 * reason to look at them. Shown directly under the row they extend.
			 *
			 * `isCharacteristics`, not `namesCharacteristic`: everything below is
			 * about the `characteristics` list, and a component-fields row has had
			 * its own inherited row drawn above.
			 */
			if (!isCharacteristics) continue;

			const own = new Set(draft.characteristics);
			const inherited = plugin.effectiveCharacteristics(draft.name, objects, drafts)
				.filter((c) => !own.has(c));

			/*
			 * Said only where the two inheritances actually diverge: this class
			 * carries something itself, through `is a`, that its own instances will
			 * not receive. That is the whole difference between the two links, and
			 * the first version of this line got it wrong - it claimed nothing was
			 * inherited from the `is a` target at all, which is false.
			 */
			const carried = plugin.carriedCharacteristics(draft.name, objects, drafts);
			const notPassedOn = carried.filter(
				(c) => !own.has(c) && !inherited.includes(c));

			if (notPassedOn.length > 0) {
				const note = body.createEl('p', { cls: 'oof-inherit-note' });
				note.createSpan({
					/* No article before the name: "a Obsidian Plugin" was the first try. */
					text: notPassedOn.join(', ') + ' '
						+ (notPassedOn.length === 1 ? 'is' : 'are') + ' carried by this note '
						+ 'itself, not by instances of ' + draft.name + '. ',
				});
				note.createSpan({
					cls: 'oof-inherit-note-em',
					text: 'Add `' + plugin.settings.inheritsProperty + '` to pass '
						+ (notPassedOn.length === 1 ? 'it' : 'them') + ' on.',
				});
			}

			if (inherited.length === 0) continue;

			this.renderChipRow(body, 'inherited', inherited, {
				onOpen: openCharacteristic,
				tooltip: characteristicTooltip,
				missing: (name) => !characteristics.has(name),
				menu: (name, event) => {
					if (characteristics.has(name)) this.characteristicMenu(name, event);
				},
				muted: true,
			});
		}
	}

	/*
	 * What a component field's chip says on hover: which classes it will accept.
	 *
	 * That is the useful thing to know about one, and it is not on the class note
	 * — it is in the characteristic's `possible values`, one file away. A field
	 * that names none accepts any class, which is said rather than left blank,
	 * because an empty tooltip reads as "nothing known" and this is a decision.
	 *
	 * Read through `constraintsFor`, so what the tooltip promises and what the
	 * plan accepts are the same sentence — `constraint.text` is literally the
	 * phrase the complaint would use.
	 */
	componentTooltip(name, characteristics) {
		const plugin = this.plugin;
		const characteristic = characteristics.get(name);
		if (!characteristic) return name + ' — no note yet';

		const parts = [];
		if (characteristic.meaning) parts.push(characteristic.meaning);

		let constraints = [];
		try {
			constraints = plugin.constraintsFor(characteristic, plugin.picture());
		} catch (error) { constraints = []; }

		const classes = constraints.filter((constraint) => constraint.kind === 'class');
		parts.push(classes.length > 0
			? 'takes ' + classes.map((constraint) => constraint.text).join(', ')
			: 'takes any class — ' + name + ' names no possible values');
		return parts.join(' — ');
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
			/* Handed the event, so a menu can open where the pointer is. */
			options.onClick(event);
		};
		return button;
	}

	/*
	 * A chip per value. Each chip is an anchor, so it reads as a link and opens
	 * the note behind it - the whole chip is the target, not just the glyphs.
	 * With `onChange` the chips gain a remove button and the row gains an input
	 * to add one; without it the row is read-only, which is what `inherited` is.
	 */
	/*
	 * Like `setDraftValue`, for the one field on a class that is not a list.
	 *
	 * It used to seed the base characteristics from `draft.values`, on the stated
	 * grounds that *"a draft holding only a symbol would read as every base
	 * characteristic having been emptied"*. That was never true of `draftOf`,
	 * which falls through to the vault for any property a draft does not mention
	 * — an absent row and an emptied one are different things there, and only an
	 * explicit `[]` means emptied. The comment described the danger correctly and
	 * named the wrong shape as the cure: carrying the rows across is what makes a
	 * symbol change claim all five of them.
	 */
	setDraftSymbol(draft, symbol) {
		const existing = this.plugin.drafts.get(draft.name);
		const values = existing && existing.values
			? Object.assign({}, existing.values)
			: {};

		this.plugin.drafts.set(draft.name, {
			values: values,
			symbol: normaliseSymbol(symbol),
		});
		this.plugin.saveDrafts().then(() => { this.render(); });
	}

	/* ----- a row that runs off the side instead of down the page ----- */

	/*
	 * The card's top row. Made here rather than inline in each of the three cards
	 * so the overflow setting reaches all of them — it went in for the chip rows
	 * and missed this one, which is the row that actually runs out of width: a
	 * name, a symbol, a rating, two badges and five icons across 300px.
	 */
	titleRow(card, extra) {
		return this.fitRow(card.createDiv({
			cls: 'oof-object-title' + (extra ? ' ' + extra : ''),
		}), true);
	}

	/*
	 * What a row does when it holds more than fits.
	 *
	 * `alwaysRigid` is the top line, and it is rigid under every setting — there
	 * is no reading of a card on which a badge broken across two lines and a name
	 * cut to four letters is the wanted answer. Wrapping is a real answer for
	 * *chips*, which are a list and read as one however many lines they take; the
	 * top line is not a list, it is one statement about the class.
	 *
	 * So the card widens to whatever its top line needs, and the chips wrap inside
	 * that width. Which is the third setting.
	 */
	fitRow(row, isTitle) {
		const mode = this.plugin.settings.cardOverflow;
		/*
		 * Fitting the panel: the top line wraps too, but **between** its items and
		 * never inside one. That distinction is the whole of it — a badge reading
		 * IS over A is the row breaking a word, and a badge moved whole onto a
		 * second line is the row breaking where it is allowed to.
		 */
		if (mode === 'fit') {
			if (isTitle) row.addClass('is-wrapping');
			return row;
		}
		if (isTitle || mode !== 'wrap') row.addClass('is-rigid');
		if (mode === 'scroll') this.scrollSideways(row);
		return row;
	}

	/*
	 * One line that scrolls, for a row with more chips than fit across the panel.
	 *
	 * The wheel is the whole of the point. A horizontal scroller in a page that
	 * scrolls vertically is unreachable with an ordinary mouse — Chromium only
	 * turns a wheel sideways when shift is held — so without this the row would
	 * be scrollable in principle and stuck in practice. A trackpad's sideways
	 * gesture arrives as `deltaX` and is left alone.
	 *
	 * It gives the wheel back at each end rather than swallowing it: once the row
	 * has nowhere further to go the event is not consumed, so the panel carries on
	 * scrolling and the pointer resting over a chip row never traps the page.
	 *
	 * The handing back is decided by where the row **is**, not by where the tick
	 * would land, and that distinction is the whole of it. Refusing any tick that
	 * would overshoot left the last stretch unreachable: a row with 98px of travel
	 * took one 50px tick and then declined the second for ever, because 100 is
	 * past 98. So the tick that overshoots is clamped and consumed, and only the
	 * one after it — with the row already against the stop — goes to the page.
	 */
	scrollSideways(el) {
		el.addClass('is-scrolling');
		el.addEventListener('wheel', (event) => {
			if (event.deltaX !== 0 || event.deltaY === 0) return;
			const room = el.scrollWidth - el.clientWidth;
			if (room <= 0) return;
			const at = el.scrollLeft;
			if (event.deltaY > 0 && at >= room - 0.5) return;
			if (event.deltaY < 0 && at <= 0.5) return;
			event.preventDefault();
			el.scrollLeft = Math.max(0, Math.min(room, at + event.deltaY));
		}, { passive: false });
		return el;
	}

	/*
	 * The menu behind a characteristic chip.
	 *
	 * One item, and it is the one that cannot be reached any other way: which
	 * values are written under a characteristic, and on how many notes, is
	 * something only this plugin knows the extent of. Everything else a chip can
	 * do it already does by being clicked.
	 */
	characteristicMenu(name, event) {
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle('Rename a value of ' + name + '\u2026')
			.setIcon('replace')
			.onClick(() => {
				new RenameValueModal(this.app, this.plugin, { characteristic: name },
					() => this.render()).open();
			}));
		menu.showAtMouseEvent(event);
	}

	renderChipRow(card, label, values, options) {
		/*
		 * A name that survives a rebuild: the card it belongs to plus the row. The
		 * DOM is thrown away on every render, so identity has to come from what the
		 * row *is* rather than from the element.
		 */
		const focusKey = (options.owner || '') + '::' + label;
		const onChange = options.onChange || null;
		const row = card.createDiv({ cls: options.muted ? 'oof-row oof-row-muted' : 'oof-row' });
		row.createSpan({ text: label, cls: 'oof-row-label' });

		const chips = this.fitRow(row.createDiv({ cls: 'oof-chips' }));

		for (const value of values) {
			let cls = 'oof-chip';
			if (options.muted) cls += ' oof-chip-muted';
			if (options.missing && options.missing(value)) cls += ' oof-chip-missing';
			const chip = chips.createSpan({ cls: cls });

			/*
			 * What the chip says can differ from what it holds. A `views` entry is
			 * `Improvement Base.base#dynamic project` and reads as `dynamic project`;
			 * everything downstream - removing it, saving it - still works on the
			 * value, so this is display and nothing else.
			 */
			const shown = options.label ? options.label(value) : value;
			const text = chip.createEl('a', { text: shown, cls: 'oof-chip-text' });
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

			/*
			 * Right-click, for what a chip cannot say by being clicked. Opening the
			 * note is the obvious thing a chip does and stays the left button's; this
			 * is for the one operation only the plugin knows the extent of.
			 */
			if (options.menu) {
				chip.oncontextmenu = (event) => {
					event.preventDefault();
					event.stopPropagation();
					options.menu(value, event);
				};
			}

			if (!onChange) continue;

			const remove = chip.createSpan({ text: '×', cls: 'oof-chip-remove' });
			remove.setAttribute('aria-label', 'Remove ' + value);
			remove.onclick = (event) => {
				event.stopPropagation();
				onChange(values.filter((v) => v !== value));
			};
		}

		if (!onChange) return;

		/*
		 * Some rows are picked from rather than typed into. A class name is short,
		 * known and spellable, so the inline box below is right for it; a base view
		 * is long and exact and is being *chosen*, so its `+` opens a modal instead
		 * - the same prompt Dynamic Viewer gives for the same list.
		 */
		if (options.pick) {
			const button = chips.createSpan({ cls: 'oof-add oof-add-pick', text: '+' });
			button.setAttribute('title', 'Pick one');
			button.onclick = (event) => {
				event.stopPropagation();
				options.pick(values, (picked) => {
					if (!picked || values.includes(picked)) return;
					onChange(values.concat([picked]));
				});
			};
			return;
		}

		/*
		 * The input is wrapped so the dropdown arrow can be ours: the native one is
		 * a button, so a click on it opens the list instead of placing the caret -
		 * which in a box this small meant most of it took two clicks to type in.
		 */
		const wrap = chips.createSpan({ cls: 'oof-add-wrap' });
		const input = wrap.createEl('input', {
			cls: 'oof-add',
			attr: {
				placeholder: '+',
				'data-oof-focus': focusKey,
				title: 'Type to filter, Tab to take the first suggestion, Enter to add.',
			},
		});
		const listId = 'oof-list-' + Math.random().toString(36).slice(2);
		input.setAttribute('list', listId);

		const datalist = chips.createEl('datalist');
		datalist.id = listId;

		const available = (options.suggestions || []).filter((s) => !values.includes(s));

		/*
		 * One ordering, used twice: it fills the datalist and it decides what Tab
		 * completes to. If those two disagreed, Tab would take something other than
		 * the entry sitting at the top of the list he is looking at.
		 *
		 * Things that *start* with what he typed come first - typing "rel" should
		 * reach `relation to me` before `related` only if it sorts there, and
		 * neither before something that merely contains "rel" somewhere.
		 */
		const ranked = (typed) => {
			const needle = String(typed || '').trim().toLowerCase();
			if (!needle) return available;
			const starts = available.filter((s) => s.toLowerCase().startsWith(needle));
			const contains = available.filter((s) =>
				!s.toLowerCase().startsWith(needle) && s.toLowerCase().indexOf(needle) !== -1);
			return starts.concat(contains);
		};

		const fillList = (typed) => {
			datalist.empty();
			for (const suggestion of ranked(typed)) {
				datalist.createEl('option', { value: suggestion });
			}
		};
		fillList('');
		input.oninput = () => { fillList(input.value); };

		input.onkeydown = (event) => {
			if (event.key === 'Escape') {
				input.value = '';
				fillList('');
				input.blur();
				return;
			}

			/*
			 * Tab takes the first suggestion, the way a shell or an editor does. The
			 * completed part is left selected, so carrying on typing replaces it
			 * rather than appending to it - and Tab again, with nothing left to add,
			 * falls through and moves focus like an ordinary Tab.
			 */
			if (event.key === 'Tab' && !event.shiftKey) {
				const typed = input.value.trim();
				if (!typed) return;

				const top = ranked(typed)[0];
				if (!top || top.toLowerCase() === typed.toLowerCase()) return;

				event.preventDefault();
				input.value = top;
				fillList(top);
				if (typeof input.setSelectionRange === 'function') {
					input.setSelectionRange(typed.length, top.length);
				}
				return;
			}

			if (event.key !== 'Enter') return;

			const value = input.value.trim();
			if (!value || values.includes(value)) return;

			/*
			 * Cleared before the change, not after: the render that follows carries
			 * the caret over, and it would carry the word he has just turned into a
			 * chip along with it. Empty and still focused is what lets him type the
			 * next one straight away.
			 */
			input.value = '';
			fillList('');
			onChange(values.concat([value]));
		};
	}

	/*
	 * Carry across the rows already edited, then change the one being edited now
	 * - so editing `is a` cannot silently drop an unsaved edit to
	 * `characteristics`.
	 *
	 * **A draft holds only the rows he has actually touched** (2026-09-05). It
	 * used to be seeded from `draft.values` — everything currently shown — which
	 * turned a one-row edit into a snapshot of all five, frozen at the moment of
	 * that edit. Nothing goes wrong while the note sits still; it goes wrong when
	 * the note changes underneath, because the next Update writes all five rows
	 * from the snapshot and silently reverts whatever moved. That is what emptied
	 * `Sub Goal` — see `draftOf`.
	 *
	 * `draftOf` already reads a draft this way: a property the draft does not
	 * mention falls through to the vault. So an untouched row is now genuinely
	 * absent rather than claimed, and only the rows he edited can win.
	 */
	setDraftValue(draft, property, next) {
		const existing = this.plugin.drafts.get(draft.name);
		const values = existing && existing.values
			? Object.assign({}, existing.values)
			: {};

		values[property] = next;
		this.plugin.drafts.set(draft.name, { values: values });
		/* Kept immediately - there is no Save button to press. */
		this.plugin.saveDrafts().then(() => { this.render(); });
	}
}

/* --------------------------------------------------------------- the modals */
/*
 * Every base in the vault, and every view inside one, offered by name.
 *
 * A `views` row is picked from rather than typed into (2026-09-01, his ask):
 * the inline box with a datalist is right for a class name, which he knows and
 * can spell, and wrong for `Improvement Base.base#dynamic project`, which is
 * long, exact, and something he is choosing rather than recalling. Dynamic
 * Viewer prompts this way for the same list, and being prompted the same way for
 * the same thing in two plugins is the point.
 */
class BaseViewPickerModal extends FuzzySuggestModal {
	constructor(app, items, onChoose) {
		super(app);
		this.items = items;
		this.onChoose = onChoose;
		this.setPlaceholder('Pick a base, or one of its views');
	}

	getItems() { return this.items; }
	getItemText(item) { return item.label; }
	onChooseItem(item) { this.onChoose(item.value); }
}


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
			const trashing = plan.actions.filter(
				(a) => TRASH_KINDS.indexOf(a.kind) !== -1).length;

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
					/* Every action that removes a whole file is marked in red. */
					TRASH_KINDS.indexOf(action.kind) !== -1
						? { cls: 'oof-plan-destructive' } : {});
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

				new Notice('OOF Class Manager: ' + written + ' change'
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
	/*
	 * `options` is what makes this the subclass modal too — a heading and a
	 * description, and nothing else. The parent is not asked for here: the menu it
	 * was opened from already named the class, and a field repeating it would be a
	 * field to get wrong.
	 */
	constructor(app, plugin, onSubmit, options) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.options = options || {};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.options.heading || 'New class' });

		let name = '';
		new Setting(contentEl)
			.setName('Name')
			.setDesc(this.options.desc || 'The class note to create, e.g. "Artist".')
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
/*
 * The symbol picker: three tabs, a search box, and a grid.
 *
 *   Symbols  typographic marks — the default, and what he asked for
 *   Icons    Lucide, which is what Obsidian ships and what Notion's icons look
 *            like. Stored as `lucide:<name>`
 *   Emoji    a broad set, grouped and searchable
 *
 * Icons are their own tab rather than mixed in, because they are a different kind
 * of value — everything else here is one character, and `lucide:box` is a name.
 * Keeping them apart is what stops the grid pretending they are interchangeable.
 */
class SymbolPickerModal extends Modal {
	constructor(app, plugin, options) {
		super(app);
		this.plugin = plugin;
		this.className = options.className;
		this.current = options.current || '';
		this.inherited = options.inherited || null;
		this.onPick = options.onPick;
		/* Whichever tab the current symbol came from, so it opens where it is. */
		this.tab = isIconSymbol(this.current) ? 'icons'
			: (this.current && SYMBOL_PALETTE.indexOf(this.current) === -1 ? 'emoji' : 'symbols');
		this.query = '';
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-picker');

		const head = contentEl.createDiv({ cls: 'oof-picker-head' });
		const preview = head.createSpan({ cls: 'oof-picker-preview' });
		paintSymbol(preview, this.current);
		head.createDiv({ cls: 'oof-picker-title' })
			.createEl('h3', { text: 'Symbol for "' + this.className + '"' });

		/*
		 * What it would show with nothing of its own — said here rather than in the
		 * grid, because "inherits ◆ from Person" is the reason you might choose to
		 * set nothing at all.
		 */
		if (this.inherited && this.inherited.symbol && this.inherited.inherited) {
			const line = head.createDiv({ cls: 'oof-picker-inherited' });
			line.createSpan({ text: 'inherits ' });
			paintSymbol(line.createSpan({ cls: 'oof-picker-inline' }),
				this.inherited.symbol);
			line.createSpan({ text: ' from ' + this.inherited.source });
		}

		const tabs = contentEl.createDiv({ cls: 'oof-picker-tabs' });
		const grid = contentEl.createDiv({ cls: 'oof-picker-grid' });
		const search = contentEl.createEl('input', {
			cls: 'oof-picker-search',
			attr: { type: 'text', placeholder: 'Search…' },
		});
		/* Under the tabs in the DOM, above the grid on screen — see styles.css. */
		contentEl.insertBefore(search, grid);

		const names = [
			['symbols', 'Symbols'],
			['icons', 'Icons'],
			['emoji', 'Emoji'],
		];

		const drawTabs = () => {
			tabs.empty();
			for (const [key, label] of names) {
				if (key === 'icons' && availableIcons().length === 0) continue;
				const tab = tabs.createEl('a', {
					text: label,
					cls: 'oof-picker-tab' + (this.tab === key ? ' is-active' : ''),
				});
				tab.onclick = (event) => {
					event.preventDefault();
					this.tab = key;
					drawTabs();
					draw();
				};
			}
		};

		const cell = (value, label) => {
			const el = grid.createSpan({
				cls: 'oof-picker-cell' + (value === this.current ? ' is-current' : ''),
				attr: { 'aria-label': label, title: label },
			});
			paintSymbol(el, value);
			el.onclick = (event) => {
				event.preventDefault();
				/* The one already set, chosen again, means "none" — the same click undone. */
				this.onPick(value === this.current ? '' : value);
				this.close();
			};
			return el;
		};

		const draw = () => {
			grid.empty();
			const query = this.query.trim().toLowerCase();

			/*
			 * Both grid classes set here, every time, rather than added in the
			 * branch that wants them: they were, and it happened to work only
			 * because the emoji branch was the one that removed. A second class
			 * makes that a coincidence to rely on, so each tab now states what
			 * the grid is instead of what it changed.
			 */
			if (this.tab === 'emoji') grid.removeClass('is-wide');
			else grid.addClass('is-wide');
			if (this.tab === 'symbols') grid.addClass('is-glyphs');
			else grid.removeClass('is-glyphs');

			if (this.tab === 'symbols') {
				/*
				 * Searched and grouped, exactly like the emoji tab — the two are
				 * the same thing now that this one is a hundred and sixty
				 * characters rather than sixty. The label is the whole word list,
				 * because for a kanji that gloss is the only way to read the cell.
				 */
				let any = false;
				for (const [group, entries] of SYMBOL_GROUPS) {
					const matching = entries.filter(
						([glyph, words]) => !query
							|| words.indexOf(query) !== -1 || glyph === query);
					if (matching.length === 0) continue;
					any = true;
					grid.createDiv({ cls: 'oof-picker-group', text: group });
					for (const [glyph, words] of matching) cell(glyph, words);
				}
				if (!any) {
					grid.createDiv({ cls: 'oof-picker-more', text: 'No symbol called that.' });
				}
				return;
			}

			if (this.tab === 'icons') {
				const icons = availableIcons();

				/*
				 * Searched, it is a flat list — and it reads the **keywords**, not
				 * just the id, so the words you would use for an emoji find the icon
				 * that means it: "happy" finds `smile`, "love" finds `heart`, "idea"
				 * finds `lightbulb`. Lucide keeps those words in its own metadata and
				 * Obsidian does not expose them, so the ones worth having are ours.
				 */
				if (query) {
					const found = icons.filter(
						(name) => iconKeywords(name).indexOf(query) !== -1);
					for (const name of found) {
						cell(ICON_PREFIX + name, name.replace(/-/g, ' '));
					}
					if (found.length === 0) {
						grid.createDiv({ cls: 'oof-picker-more', text: 'No icon called that.' });
					}
					return;
				}

				/*
				 * Unsearched, **all of them, by meaning**. Alphabetical is the worst
				 * order for browsing an icon set: `smile` sits between `slash` and
				 * `snail`, and the one you would have chosen is fifty screens from
				 * the one you thought of. So the emoji categories, filled with
				 * Lucide — and everything not spoken for still shown, under a
				 * heading that says so, because a picker that hides two thirds of
				 * what it has is worse than an unsorted one.
				 */
				const have = new Set(icons);
				const placed = new Set();
				for (const [group, names] of ICON_GROUPS) {
					const present = names.filter(
						(name) => have.has(name) && !placed.has(name));
					if (present.length === 0) continue;
					grid.createDiv({ cls: 'oof-picker-group', text: group });
					for (const name of present) {
						placed.add(name);
						cell(ICON_PREFIX + name, name.replace(/-/g, ' '));
					}
				}

				const rest = icons.filter((name) => !placed.has(name));
				if (rest.length > 0) {
					grid.createDiv({ cls: 'oof-picker-group', text: 'Everything else' });
					for (const name of rest) cell(ICON_PREFIX + name, name.replace(/-/g, ' '));
				}
				return;
			}

			for (const [group, entries] of EMOJI_GROUPS) {
				const matching = entries.filter(
					([glyph, words]) => !query
						|| words.indexOf(query) !== -1 || glyph === query);
				if (matching.length === 0) continue;
				grid.createDiv({ cls: 'oof-picker-group', text: group });
				/*
				 * Stored *as an emoji* — `asEmoji` adds the selector to the ones that
				 * would otherwise come out as flat glyphs. Picking ❤ here must give a
				 * red heart, not an outline, whatever else is on screen.
				 */
				for (const [glyph, words] of matching) cell(asEmoji(glyph), words.split(' ')[0]);
			}
		};

		search.oninput = () => { this.query = search.value; draw(); };
		search.onkeydown = (event) => { if (event.key === 'Escape') this.close(); };

		drawTabs();
		draw();
		window.setTimeout(() => { search.focus(); }, 0);

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		if (this.current) {
			const clear = buttons.createEl('button', { text: 'Remove symbol' });
			clear.onclick = () => { this.onPick(''); this.close(); };
		}
		const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'mod-cta' });
		cancel.onclick = () => this.close();
	}

	onClose() { this.contentEl.empty(); }
}

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

/*
 * A line diff, by longest common subsequence. Small inputs — a frontmatter block
 * — so the quadratic table is nothing, and it is the honest algorithm: it shows a
 * reordering as the lines moving rather than as the whole block being rewritten.
 */
function diffLines(before, after) {
	const rows = before.length;
	const cols = after.length;
	const table = [];
	for (let i = 0; i <= rows; i += 1) table.push(new Array(cols + 1).fill(0));

	for (let i = rows - 1; i >= 0; i -= 1) {
		for (let j = cols - 1; j >= 0; j -= 1) {
			table[i][j] = before[i] === after[j]
				? table[i + 1][j + 1] + 1
				: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const out = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (before[i] === after[j]) { out.push({ sign: ' ', text: before[i] }); i += 1; j += 1; }
		else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ sign: '-', text: before[i] }); i += 1; }
		else { out.push({ sign: '+', text: after[j] }); j += 1; }
	}
	while (i < rows) { out.push({ sign: '-', text: before[i] }); i += 1; }
	while (j < cols) { out.push({ sign: '+', text: after[j] }); j += 1; }
	return out;
}

/*
 * One diff, rendered. A free function rather than a method because two modals
 * show diffs — the discrepancy view and the apply-a-class question — and the
 * rule about lines with nothing in them must have exactly one home.
 */
function renderDiffInto(contentEl, rows) {
	const block = contentEl.createEl('pre', { cls: 'oof-diff' });
	for (const row of rows) {
		const cls = row.sign === '+' ? 'oof-diff-add'
			: (row.sign === '-' ? 'oof-diff-remove' : 'oof-diff-same');
		const line = block.createEl('div', { cls: cls });
		line.createSpan({ text: row.sign + ' ' + row.text });

		/*
		 * The line that started all this is `  - ` — a list entry with nothing
		 * in it. Coloured red it still looks like nothing, which is exactly why
		 * he could not see what was being deleted. So a line with no visible
		 * content says so in words.
		 */
		if (row.sign !== ' ' && String(row.text).trim().replace(/^-\s*$/, '') === '') {
			line.createSpan({
				cls: 'oof-diff-empty',
				text: String(row.text).trim() === '' ? '(a blank line)' : '(an empty entry)',
			});
		}
	}
	return block;
}

/*
 * "an Artist", "a Person". Only the vowel rule, which is right for every class
 * in the vault and wrong only for the likes of "a Unicorn" — a real word about
 * a real class of his beats grammatical caution about a hypothetical one.
 */
function article(name) {
	return /^[aeiou]/i.test(String(name)) ? 'an' : 'a';
}

/* "a, b and c" — for saying what is being displaced without a bare comma list. */
function andList(items) {
	const list = toArray(items).map(String);
	if (list.length === 0) return '';
	if (list.length === 1) return list[0];
	return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

/*
 * The change, line by line, before it happens. Built by running the very function
 * that will do the writing against a copy of the frontmatter — so this cannot
 * drift from what Update actually does, which a hand-written description would.
 */
class ChangeModal extends Modal {
	constructor(app, plugin, discrepancy) {
		super(app);
		this.plugin = plugin;
		this.discrepancy = discrepancy;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-change-modal');

		const d = this.discrepancy;
		contentEl.createEl('h3', { text: d.label });
		if (d.path) contentEl.createEl('div', { text: d.path, cls: 'oof-plan-path' });

		for (const line of d.detail || []) {
			contentEl.createEl('p', { text: line, cls: 'oof-modal-lede' });
		}

		const preview = d.fix ? this.plugin.changePreview(d.fix) : null;

		if (!preview) {
			/*
			 * Nothing to apply, so nothing to show as a change — the file as it
			 * stands is what he needs to look at, with the line at issue marked.
			 */
			if (d.mentions) this.renderMentions(contentEl, d);
			else this.renderCurrent(contentEl, d);
		} else {
			const rows = diffLines(preview.before, preview.after);
			const changed = rows.filter((r) => r.sign !== ' ').length;
			contentEl.createEl('p', {
				cls: 'oof-modal-lede',
				text: changed === 0
					? 'No line changes — the difference is elsewhere in the file.'
					: changed + ' line' + (changed === 1 ? '' : 's') + ' change:',
			});
			this.renderDiff(contentEl, rows);
		}

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		if (d.file) {
			const open = buttons.createEl('button', { text: 'Open the note' });
			open.onclick = () => {
				this.app.workspace.getLeaf(false).openFile(d.file);
				this.close();
			};
		}
		const close = buttons.createEl('button', { text: 'Close', cls: 'mod-cta' });
		close.onclick = () => this.close();
	}

	renderDiff(contentEl, rows) { renderDiffInto(contentEl, rows); }

	/*
	 * Where the word still is.
	 *
	 * Its own rendering because `renderCurrent` shows **frontmatter**, and this
	 * discrepancy is the one kind that is never about frontmatter. Shown against
	 * that note's `status: effort`, it marked the very line the rename was about
	 * to change while saying nothing would be written — the opposite of true, and
	 * on the one note where the prose must *not* change, since it is the record
	 * of choosing the name.
	 */
	renderMentions(contentEl, d) {
		contentEl.createEl('p', {
			cls: 'oof-modal-lede',
			text: 'Nothing will be written for these. Every line still carrying the '
				+ 'word:',
		});

		for (const hit of d.mentions.slice(0, 6)) {
			contentEl.createEl('div', { text: hit.file.path, cls: 'oof-plan-path' });
			const block = contentEl.createEl('pre', { cls: 'oof-diff' });

			if (!hit.lines || hit.lines.length === 0) {
				block.createEl('div', {
					text: '  (the word is in this file; the lines were not kept)',
					cls: 'oof-diff-same',
				});
				continue;
			}

			for (const line of hit.lines) {
				block.createEl('div', {
					text: '! ' + line.number + '  ' + line.text,
					cls: 'oof-diff-subject',
				});
			}
		}

		const more = d.mentions.length - 6;
		if (more > 0) {
			contentEl.createEl('p', {
				cls: 'oof-modal-lede',
				text: '…and ' + more + ' more file' + (more === 1 ? '' : 's') + '.',
			});
		}
	}

	renderCurrent(contentEl, d) {
		const file = d.file;
		const frontmatter = file ? this.plugin.frontmatterOf(file) : null;
		if (!frontmatter) {
			contentEl.createEl('p', {
				cls: 'oof-modal-lede',
				text: 'Nothing to show: this one is about the vault as a whole rather '
					+ 'than about one file.',
			});
			return;
		}

		contentEl.createEl('p', {
			cls: 'oof-modal-lede',
			text: 'Nothing will be written for this one. The file as it stands'
				+ (d.property ? ', with ' + d.property + ' marked' : '') + ':',
		});

		const block = contentEl.createEl('pre', { cls: 'oof-diff' });
		for (const line of this.plugin.frontmatterLines(frontmatter)) {
			const isSubject = !!d.property
				&& (line === d.property + ':' || line.indexOf(d.property + ': ') === 0);
			block.createEl('div', {
				text: (isSubject ? '! ' : '  ') + line,
				cls: isSubject ? 'oof-diff-subject' : 'oof-diff-same',
			});
		}
	}

	onClose() { this.contentEl.empty(); }
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

		/*
		 * Optional, and only the base reset passes one so far. A description of
		 * what will be overwritten is a promise; the diff is the thing itself, and
		 * this is the one modal in the plugin where nothing else stands between
		 * the answer and the write. Same renderer as the discrepancy view and the
		 * apply-a-class question, so a yes here is a yes to lines he has read.
		 */
		if (this.options.diff) {
			renderDiffInto(contentEl,
				diffLines(this.options.diff.before, this.options.diff.after));
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

/*
 * Yes or no, before a class is applied to a note he already has open. The
 * question is asked with the diff underneath it rather than with a description
 * of the diff — the same `changePreview` the discrepancy view uses, so a yes
 * here is a yes to lines he has read.
 */
class ApplyClassModal extends Modal {
	constructor(app, plugin, classNames, file, situation, onDone) {
		super(app);
		this.plugin = plugin;
		/* One or several — a custom selection makes the note all of them at once. */
		this.names = Array.isArray(classNames) ? classNames.slice() : [classNames];
		this.className = this.names[0];
		this.file = file;
		this.situation = situation;
		this.onDone = onDone || (() => {});
	}

	/* "a Person", or "a Person and a Teacher". */
	phrase() {
		return andList(this.names.map((name) => article(name) + ' ' + name));
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-change-modal');

		const s = this.situation;
		contentEl.createEl('h3', {
			text: 'Make "' + this.file.basename + '" ' + this.phrase() + '?',
		});
		contentEl.createEl('div', { text: this.file.path, cls: 'oof-plan-path' });

		const say = (text, cls) => contentEl.createEl('p', {
			text: text, cls: cls || 'oof-modal-lede',
		});

		/* The surprising half first: something is being displaced. */
		if (s.replacing.length > 0) {
			say('It is currently ' + andList(s.replacing.map((n) => article(n) + ' ' + n))
				+ '. That is replaced.', 'oof-modal-warning');
		}

		if (s.add.length > 0) {
			say(s.add.length + ' propert' + (s.add.length === 1 ? 'y arrives' : 'ies arrive')
				+ ' empty: ' + s.add.join(', ') + '.');
		} else {
			say('The note already carries every property ' + this.phrase() + ' has.');
		}

		/*
		 * Keys the old class left behind. Saying nothing about them would be the
		 * dishonest option: they stay, and the next Update will ask about them.
		 */
		if (s.kept.length > 0) {
			say(andList(s.kept) + ' ' + (s.kept.length === 1 ? 'is' : 'are')
				+ ' not part of ' + andList(this.names.slice()) + '. Nothing is removed '
				+ 'here — the next Update decides, and it only ever removes an empty one.');
		}

		const preview = this.plugin.changePreview(s.action);
		if (preview) {
			const rows = diffLines(preview.before, preview.after);
			const changed = rows.filter((r) => r.sign !== ' ').length;
			say(changed + ' line' + (changed === 1 ? '' : 's') + ' change:');
			renderDiffInto(contentEl, rows);
		}

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'No' });
		cancel.onclick = () => this.close();

		const confirm = buttons.createEl('button', { text: 'Yes, apply it', cls: 'mod-cta' });
		confirm.onclick = async () => {
			this.close();
			await this.plugin.applyAction(s.action);
			new Notice('"' + this.file.basename + '" is now ' + this.phrase() + '.', 4000);
			this.onDone();
		};
		window.setTimeout(() => confirm.focus(), 0);
	}

	onClose() { this.contentEl.empty(); }
}

/*
 * What a stranded property became. The plugin can see that sixty-nine notes
 * carry `lifespan` and that nothing declares it; only he knows what it turned
 * into, so this asks — and then hands the answer to the machinery that already
 * carries a rename the plugin watched happen.
 */
class RenamePropertyModal extends Modal {
	constructor(app, plugin, discrepancy, onDone) {
		super(app);
		this.plugin = plugin;
		this.discrepancy = discrepancy;
		this.onDone = onDone || (() => {});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-change-modal');

		const key = this.discrepancy.property;
		const entry = this.discrepancy.stranded || { files: [], values: [], empty: 0 };
		const held = entry.files.length - entry.empty;

		contentEl.createEl('h3', { text: 'What did "' + key + '" become?' });

		const say = (text, cls) => contentEl.createEl('p', {
			text: text, cls: cls || 'oof-modal-lede',
		});

		say(entry.files.length + ' note' + (entry.files.length === 1 ? '' : 's')
			+ ' carry it' + (held > 0 ? ', ' + held + ' with a value' : '')
			+ ', and nothing declares it.');
		if (entry.values.length > 0) {
			say('The values it holds: ' + entry.values.slice(0, 8).join(', ')
				+ (entry.values.length > 8 ? ', …' : '') + '.');
		}
		say('Choosing a characteristic renames the property on every one of those '
			+ 'notes on the next Update, value and all. Nothing is written now.');

		const characteristics = this.plugin.scanCharacteristics();
		let chosen = this.discrepancy.suggestion || '';

		new Setting(contentEl)
			.setName('It is now')
			.setDesc(this.discrepancy.suggestion
				? 'Suggested because its values fit "' + this.discrepancy.suggestion + '".'
				: 'Pick the characteristic these values belong to.')
			.addDropdown((dropdown) => {
				dropdown.addOption('', '—');
				for (const name of Array.from(characteristics.keys()).sort()) {
					if (name === key) continue;
					dropdown.addOption(name, name);
				}
				dropdown.setValue(chosen);
				dropdown.onChange((value) => { chosen = value; });
			});

		const buttons = contentEl.createDiv({ cls: 'oof-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();

		const confirm = buttons.createEl('button', {
			text: 'Rename it', cls: 'mod-cta',
		});
		confirm.onclick = async () => {
			if (!chosen || chosen === key) {
				new Notice('OOF Class Manager: pick what "' + key + '" became first.', 4000);
				return;
			}
			this.close();
			await this.plugin.recordPropertyRename(key, chosen);
			new Notice('OOF Class Manager: "' + key + '" → "' + chosen
				+ '" on the next Update.', 5000);
			this.onDone();
		};
	}

	onClose() { this.contentEl.empty(); }
}

/*
 * What a value became.
 *
 * Three ways in and one modal, because they are one question: from a
 * characteristic chip on a class card, from the command, and from a value the
 * plugin found stranded by itself. What differs is only how much of it arrives
 * already answered.
 *
 * The count is the whole of the reassurance this modal owes him. A rename that
 * says "21 notes" before it runs is a rename he can check; one that says
 * "everywhere" is the search and replace he did not want.
 */
class RenameValueModal extends Modal {
	constructor(app, plugin, seed, onDone) {
		super(app);
		this.plugin = plugin;
		this.seed = seed || {};
		this.onDone = onDone || (() => {});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oof-change-modal');

		const picture = this.plugin.picture();
		const names = Array.from(picture.characteristics.keys()).sort();

		this.key = this.seed.characteristic || '';
		this.from = this.seed.from || '';
		this.to = this.seed.suggestion || '';

		contentEl.createEl('h3', {
			text: this.seed.from
				? 'What did "' + this.seed.from + '" become?'
				: 'Rename a value',
		});

		contentEl.createEl('p', {
			cls: 'oof-modal-lede',
			text: 'The value moves under one characteristic and nowhere else — the '
				+ 'same word written under another one, or in a sentence, is left '
				+ 'exactly as it is. Nothing is written now; this goes into the next '
				+ 'Update, with a diff.',
		});

		if (this.seed.characteristic) {
			new Setting(contentEl)
				.setName('Characteristic')
				.setDesc('The property this value is written under.')
				.addButton((button) => {
					button.setButtonText(this.key);
					button.setDisabled(true);
				});
		} else {
			new Setting(contentEl)
				.setName('Characteristic')
				.setDesc('The property this value is written under.')
				.addDropdown((dropdown) => {
					dropdown.addOption('', '—');
					for (const name of names) dropdown.addOption(name, name);
					dropdown.setValue(this.key);
					dropdown.onChange((value) => {
						this.key = value;
						this.from = '';
						this.paint();
					});
				});
		}

		this.rest = contentEl.createDiv();
		this.paint();
	}

	paint() {
		this.rest.empty();

		const plugin = this.plugin;
		const picture = plugin.picture();
		const characteristic = picture.characteristics.get(this.key);

		if (!characteristic) {
			this.rest.createEl('p', {
				cls: 'oof-modal-lede', text: 'Pick a characteristic first.',
			});
			this.addButtons();
			return;
		}

		const inUse = plugin.valuesInUse(this.key);
		const allowed = plugin.literalValuesOf(characteristic, picture);

		/*
		 * Every value actually written under this characteristic, commonest first,
		 * with how many notes hold it. Read off the vault rather than off
		 * `possible values`, because the ones that need renaming are exactly the
		 * ones `possible values` no longer mentions.
		 */
		if (!this.seed.from) {
			new Setting(this.rest)
				.setName('The value now')
				.setDesc('Everything written under ' + this.key + ' in the vault.')
				.addDropdown((dropdown) => {
					dropdown.addOption('', '—');
					const held = Array.from(inUse.values())
						.sort((a, b) => b.files.length - a.files.length);
					for (const value of held) {
						dropdown.addOption(value.value,
							value.value + '  · ' + value.files.length);
					}
					dropdown.setValue(this.from);
					dropdown.onChange((value) => { this.from = value; this.paint(); });
				});
		}

		new Setting(this.rest)
			.setName('It becomes')
			.setDesc(allowed.length > 0
				? this.key + ' allows ' + allowed.join(', ') + '.'
				: this.key + ' does not say which values it allows.')
			.addText((text) => {
				text.setPlaceholder('the new value');
				text.setValue(this.to);
				text.onChange((value) => { this.to = value; this.say(); });
			});

		this.line = this.rest.createEl('p', { cls: 'oof-modal-lede' });
		this.addButtons();
		this.say();
	}

	/* The count, and whether there is anything to press. */
	say() {
		if (!this.line) return;

		const plugin = this.plugin;
		const inUse = this.key ? plugin.valuesInUse(this.key) : new Map();
		const held = inUse.get(String(this.from).trim().toLowerCase());
		const to = String(this.to).trim();

		let blocked = '';
		if (!this.key || !this.from) blocked = 'Pick the value to rename.';
		else if (held && held.link) {
			/*
			 * A link is a note, and Obsidian renames a note properly — every link
			 * pointing at it is rewritten, which is the one thing this pass cannot
			 * do. Sending him there is the honest answer, not a limitation to work
			 * around.
			 */
			blocked = '"' + held.value + '" is a link to a note. Rename the note '
				+ 'instead — Obsidian rewrites every link that points at it.';
		} else if (!to) blocked = 'Say what it becomes.';
		else if (to === String(this.from).trim()) blocked = 'That is the same value.';

		if (blocked) {
			this.line.setText(blocked);
			if (this.confirm) this.confirm.disabled = true;
			return;
		}

		const count = held ? held.files.length : 0;
		const cells = plugin.defaultsCellsHolding(
			plugin.picture().characteristics.get(this.key), this.from);

		const parts = [count + ' note' + (count === 1 ? '' : 's')];
		if (allowsWord(plugin, this.key, this.from)) parts.push('possible values');
		if (cells.length > 0) {
			parts.push(cells.length + ' defaults cell' + (cells.length === 1 ? '' : 's'));
		}

		this.line.setText('"' + this.from + '" becomes "' + to + '" on '
			+ andList(parts) + ', on the next Update.');
		if (this.confirm) this.confirm.disabled = false;
	}

	addButtons() {
		const buttons = this.rest.createDiv({ cls: 'oof-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();

		this.confirm = buttons.createEl('button', {
			text: 'Rename it', cls: 'mod-cta',
		});
		this.confirm.disabled = true;
		this.confirm.onclick = async () => {
			const to = String(this.to).trim();
			if (!this.key || !this.from || !to) return;
			this.close();
			await this.plugin.recordValueRename(this.key, this.from, to);
			new Notice('OOF Class Manager: ' + this.key + ' "' + this.from + '" → "' + to
				+ '" on the next Update.', 5000);
			this.onDone();
		};
	}

	onClose() { this.contentEl.empty(); }
}

/* Does this characteristic's `possible values` still name this word? */
function allowsWord(plugin, key, word) {
	const characteristic = plugin.picture().characteristics.get(key);
	if (!characteristic) return false;
	return toArray(characteristic.possibleValuesRaw).some(
		(entry) => renamesTo(entry, word, word) !== null);
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
		/*
		 * Called "Ignored properties" until 2026-08-24, when he asked for "an option
		 * in the settings for deciding which attributes are native" — which is this
		 * one, under a name that did not say so. The properties view has been
		 * heading them **Native attributes** all along; the setting now says the
		 * same word, so the thing and the switch for it can be found from each
		 * other. The stored key is unchanged.
		 */
		this.addText(containerEl, NATIVE_LABEL,
			'Comma-separated properties the class system has no opinion about — they '
				+ 'are never reported as unaccounted for, and they are grouped under '
				+ '"' + NATIVE_LABEL + '" in the properties view. The ones Obsidian owns '
				+ '(tags, aliases, cssclasses), plus whichever of your own you decide are '
				+ 'not characteristics (cover image). Everything else a note carries that '
				+ 'its class does not declare is reported.',
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

		this.addText(containerEl, 'Root class',
			'A class every note belongs to without saying so: everything is a root note '
				+ 'and a type of one, with no link written anywhere. Leave empty for none. '
				+ 'Nothing is added to any file — the root simply sits above everything, '
				+ 'in the panel, in the templates and in file.isA() alike.',
			'rootClass');

		new Setting(containerEl)
			.setName('Instances inherit what their class carries')
			.setDesc('Off: `is a` gives characteristics to the note that declares it and '
				+ 'stops there — passing them further down needs `type of`, the way a '
				+ 'class extends another while an instance of it inherits nothing '
				+ 'onwards. On: an instance also receives whatever its class carries '
				+ 'through its own `is a`, so a chain of `is a` hands them down on its '
				+ 'own, and file.isA() widens to match. Changes what every instance is '
				+ 'expected to hold, so check the Update plan after switching it.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.inheritCarried)
				.onChange(async (value) => {
					this.plugin.settings.inheritCarried = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Class layout')
			.setDesc('A list, or a drawing of the `type of` chains with one class per '
				+ 'row. The compressed tree is the tree with the wires that leave one '
				+ 'class drawn as a single trunk, which is most of the width back at '
				+ 'forty classes and more. Searching falls back to the list whichever '
				+ 'is on, because a filtered tree has holes in it and its lines would '
				+ 'run to classes that are not there.')
			.addDropdown((dropdown) => dropdown
				.addOption('list', 'A list, sorted')
				.addOption('brackets', 'A tree — classes aligned, connexions drawn out')
				.addOption('compressed',
					'A compressed tree — one lane for all the wires out of a class')
				.addOption('tree', 'A graph — a lane per branch, like a commit graph')
				.setValue(this.plugin.settings.classLayout)
				.onChange(async (value) => {
					this.plugin.settings.classLayout = value;
					await this.plugin.saveSettings();
					/* The sort below it appears or goes with this choice. */
					this.display();
				}));

		/* Where the rails run. Only a question once there are rails. */
		if (this.plugin.settings.classLayout !== 'list') {
			new Setting(containerEl)
				.setName('Which side the tree runs down')
				.setDesc('Left is how a commit graph is drawn. Right suits the sidebar '
					+ 'the panel usually lives in: the lines sit against the window edge, '
					+ 'and the name is the first thing you read.')
				.addDropdown((dropdown) => dropdown
					.addOption('left', 'Left of the classes')
					.addOption('right', 'Right of the classes')
					.setValue(this.plugin.settings.treeRailSide)
					.onChange(async (value) => {
						this.plugin.settings.treeRailSide = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('How a connexion turns')
				.setDesc('In a curve, or in a right angle.')
				.addDropdown((dropdown) => dropdown
					.addOption('rounded', 'Rounded')
					.addOption('square', 'Square')
					.setValue(this.plugin.settings.treeCorners)
					.onChange(async (value) => {
						this.plugin.settings.treeCorners = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('How far the highlight reaches')
				.setDesc('Every wire leading to the class you are reading — both parents '
					+ 'of a class that has two, and their parents in turn, so the '
					+ 'highlight is everything the class inherits from. Or only the '
					+ 'single line the rows are ordered by, which is one path even where '
					+ 'the class has more than one.')
				.addDropdown((dropdown) => dropdown
					.addOption('all', 'Every wire leading to it')
					.addOption('descent', 'Only the line it descends from')
					.setValue(this.plugin.settings.treeLitPaths)
					.onChange(async (value) => {
						this.plugin.settings.treeLitPaths = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('The wire to a second parent')
				.setDesc('A class that is a type of two classes hangs from one of them '
					+ 'and reaches the other by a wire of its own. Dashed tells the two '
					+ 'apart at a glance; solid draws them alike, which is the truer '
					+ 'reading — both are ordinary "type of", and which one the rows are '
					+ 'ordered by is decided by the drawing, not by the vault. Either '
					+ 'way it is the wire that gives way where two cross.')
				.addDropdown((dropdown) => dropdown
					.addOption('dashed', 'Dashed — it is the other edge')
					.addOption('solid', 'Solid, like every other connexion')
					.setValue(this.plugin.settings.treeWireDash)
					.onChange(async (value) => {
						this.plugin.settings.treeWireDash = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('Inside a node')
				.setDesc('Empty, so the line shows through and a node is a ring, or '
					+ 'filled with the panel colour so it sits over the line. The root '
					+ 'empties with the rest — its accent ring is what says it is the '
					+ 'root — and so does a class with two parents, whose second wire '
					+ 'says what it is. Only the class you are reading and the class '
					+ 'under the pointer stay filled either way; for those the fill is '
					+ 'the whole of the mark.')
				.addDropdown((dropdown) => dropdown
					.addOption('transparent', 'Empty — the line shows through')
					.addOption('solid', 'Filled with the panel colour')
					.setValue(this.plugin.settings.treeDotFill)
					.onChange(async (value) => {
						this.plugin.settings.treeDotFill = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('Nodes that are not highlighted')
				.setDesc('Drawn in the colour of the lines, so the graph reads as one '
					+ 'drawing, or a shade darker so each class stands out on its own.')
				.addDropdown((dropdown) => dropdown
					.addOption('line', 'The same colour as the lines')
					.addOption('strong', 'A shade darker than the lines')
					.setValue(this.plugin.settings.treeDotTone)
					.onChange(async (value) => {
						this.plugin.settings.treeDotTone = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));
		}

		/*
		 * The tree *is* the order, so the sort has nothing to say while it is on.
		 * Hidden rather than left there doing nothing — the same thing the Bases
		 * section does with its own sub-settings, and one less dead control.
		 */
		if (this.plugin.settings.classLayout === 'list') {
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
		}

		new Setting(containerEl)
			.setName('Where a class’s actions live')
			.setDesc('On every card, or once in a row above all of them. The row acts '
				+ 'on the class the note you are reading is about, so it has buttons '
				+ 'only while one is highlighted — with nothing highlighted there is no '
				+ 'class for them to act on, and it says so rather than offering '
				+ 'buttons with no subject. Two things move with them: the class name '
				+ 'becomes what opens the class’s note, in place of the note button, '
				+ 'and the three-dot menu goes to the far right of the card. Needs '
				+ '“Follow the active note” on to have anything to act on.')
			.addDropdown((dropdown) => dropdown
				.addOption('card', 'On each card, beside its name')
				.addOption('toolbar', 'In one row above the classes')
				.setValue(this.plugin.settings.classActions)
				.onChange(async (value) => {
					this.plugin.settings.classActions = value;
					await this.plugin.persist();
					this.plugin.refreshViews();
					/* The base question below only exists for the row. */
					this.display();
				}));

		/*
		 * Only the toolbar can hold a selection of several classes, so this question
		 * only arises there. Hidden rather than left doing nothing, the same as the
		 * tree's own sub-settings.
		 */
		if (this.plugin.settings.classActions === 'toolbar') {
			new Setting(containerEl)
				.setName('Opening a note resets the selection')
				.setDesc('On: the selection follows you — whichever note you open becomes '
					+ 'the selection, so switching back to it always starts from the class '
					+ 'you are reading and shift or ctrl-clicking a dot picks more from '
					+ 'there. Off: the set you picked is kept while the panel follows the '
					+ 'active note, so the mode button returns you to exactly what you had. '
					+ 'Either way, opening a note is what hands the panel back to '
					+ 'active-note tracking — clicking again inside the note you already '
					+ 'have open changes nothing.')
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.resetSelectionOnNote)
					.onChange(async (value) => {
						this.plugin.settings.resetSelectionOnNote = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('Unselecting every class leaves nothing selected')
				.setDesc('On: emptying the selection — with the × in the row, or by '
					+ 'shift or ctrl-clicking the last one off — leaves nothing '
					+ 'highlighted, and it stays that way until you click back into a '
					+ 'note. The last selected class is not special: it can be '
					+ 'unselected like any other. Off: the panel hands itself straight '
					+ 'back to the active note the moment the set is empty, so something '
					+ 'is always highlighted while the note you are reading is about a '
					+ 'class.')
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.emptySelectionStands)
					.onChange(async (value) => {
						this.plugin.settings.emptySelectionStands = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));

			new Setting(containerEl)
				.setName('Several classes at once')
				.setDesc('Click the dot beside a class to select it, shift or ctrl-click '
					+ 'another to select both. A new note then becomes an instance of all '
					+ 'of them and applying gives the open note all of them — but two '
					+ 'bases cannot be opened at once, so this decides what the base '
					+ 'button does. Grey it out, or open one base that is rewritten each '
					+ 'time to show the instances of whichever classes are selected. That '
					+ 'dynamic base is the one file this plugin rewrites without showing '
					+ 'you a plan first; it lives at ' + this.plugin.dynamicBasePath()
					+ ', holds nothing that is not derived from the selection, and a file '
					+ 'of that name it did not create is never overwritten.')
				.addDropdown((dropdown) => dropdown
					.addOption('static', 'Grey the base button out')
					.addOption('dynamic', 'Open one dynamic base, rewritten each time')
					.setValue(this.plugin.settings.multiClassBase)
					.onChange(async (value) => {
						this.plugin.settings.multiClassBase = value;
						await this.plugin.persist();
						this.plugin.refreshViews();
					}));
		}

		/* Applies in every layout: an open card is an open card. */
		new Setting(containerEl)
			.setName('A row with more in it than fits')
			.setDesc('No item is ever squeezed under any of these — a badge broken '
				+ 'mid-phrase and a name cut short is nobody’s idea of the right '
				+ 'answer. What differs is where the extra room comes from. Each row '
				+ 'on its own turns that row sideways under the wheel, and the control '
				+ 'at its end — the + on a chip row, the file icons on a top line — '
				+ 'stays against the right-hand edge. One bar at the bottom keeps '
				+ 'every row on one line and moves the whole panel instead, so '
				+ 'everything stays lined up and you read across the cards together. '
				+ 'Wrapping the chips lets them take as many lines as they need and '
				+ 'the card comes out as wide as its top line. Wrapping everything '
				+ 'takes no room at all: the top line wraps between its items, so '
				+ 'nothing is ever wider than the panel and there is no sideways '
				+ 'scrolling anywhere — the tallest of the four, and the only one you '
				+ 'never have to scroll.')
			.addDropdown((dropdown) => dropdown
				.addOption('scroll', 'Each row scrolls on its own')
				.addOption('panel', 'One bar at the bottom scrolls everything')
				.addOption('wrap', 'The chips wrap; the card widens for the top line')
				.addOption('fit', 'Everything wraps to fit the panel')
				.setValue(this.plugin.settings.cardOverflow)
				.onChange(async (value) => {
					this.plugin.settings.cardOverflow = value;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				}));

		new Setting(containerEl)
			.setName('Trash what nothing uses')
			.setDesc('On Update, send to the trash: a characteristic note once no class lists '
				+ 'it, no note carries it as a property and nothing links to it; and the '
				+ 'template or base of a class that no longer exists. A template or base is '
				+ 'only ever taken if it looks generated — one of your own that happens to '
				+ 'share the naming is left alone. Trashed, never deleted outright.')
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
			new Setting(containerEl)
				.setName('A "Class base" button on the base\'s toolbar')
				.setDesc('Adds Class base beside Filter, Properties and Sort on a base this '
					+ 'plugin generated. It says what a class base is, it holds the two '
					+ 'switches that decide which notes it holds — through component fields, '
					+ 'and exact matches only — and it is where a base is reset from its '
					+ 'class. The reset lives there rather than on the class card, so it '
					+ 'is aimed at a file you are looking at. Nothing is written by showing '
					+ 'it.')
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.classBaseToolbar)
					.onChange(async (value) => {
						this.plugin.settings.classBaseToolbar = value;
						await this.plugin.saveSettings();
						this.plugin.clearBaseToolbars();
						this.plugin.queueBaseToolbars(true);
					}));

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
			text: 'file.isA("Person"), file.hasA("Coding"), file.inheritsFrom("Person"), '
				+ 'file.ancestors(), file.isADistance("Person"), file.hasADistance("Coding"), '
				+ 'file.inheritsFromDistance("Person"), file.views() and file.classBase() are '
				+ 'available in any base formula, filter or sort. '
				+ 'They read the same properties as the panel, so they can never disagree with it. '
				+ 'isA follows "is a" and then "type of"; hasA follows a component field '
				+ 'and then "type of"; inheritsFrom follows "type of" alone — three '
				+ 'streams, never mixed, and the three a class base can be read through. '
				+ 'Each carries a distance: file.isADistance("Person") == 1 is "named Person '
				+ 'in its own is a", file.hasADistance("Coding") == 1 is "named Coding in '
				+ 'its own component fields", file.inheritsFromDistance("Person") == 1 is '
				+ '"named Person in its own type of" — those are what exact matches only '
				+ 'writes. '
				+ 'file.views() answers from two streams as well: "views" travels down '
				+ '"is a" to instances, "class views" travels down "type of" to subtypes '
				+ 'and to the class itself.',
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
		this.addText(containerEl, 'Views property', 'Names the bases an object\'s instances '
			+ 'are looked at through — given through "is a", so the class itself does not '
			+ 'receive them. Read by file.views(); emptying it turns that half off.', 'viewsProperty');
		this.addText(containerEl, 'Class views property', 'Names the bases an object\'s '
			+ 'subtypes are looked at through — given through "type of", and the class '
			+ 'itself receives them too, so a note with no subtypes pins a view to itself. '
			+ 'Nothing instantiating the class sees these. Read by file.views(); emptying it '
			+ 'turns that half off.', 'classViewsProperty');
		this.addText(containerEl, 'Component fields property', 'Lists the fields that '
			+ 'instances of a class fill with a class of their own. Filling one hands the '
			+ 'note every characteristic of the class it names; read by file.hasA(), and '
			+ 'emptying it turns that off.', 'componentsProperty');

		new Setting(containerEl)
			.setName('Views from the furthest class first')
			.setDesc('The order file.views() answers in, and so the order a dynamic view '
				+ 'draws its tabs in — it shows them as they are given, it does not sort. '
				+ 'On: the widest class comes first and a note carries its own views: last. '
				+ 'Off: nearest first, which is the order this always had.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.viewsFurthestFirst)
				.onChange(async (value) => {
					this.plugin.settings.viewsFurthestFirst = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide the "Add property" button')
			.setDesc('Removes it from the properties panel. The command '
				+ '"OOF Class Manager: Add a property to the open note" does the same thing, '
				+ 'so give it a hotkey in Settings → Hotkeys first.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.hideAddProperty)
				.onChange(async (value) => {
					this.plugin.settings.hideAddProperty = value;
					await this.plugin.saveSettings();
					this.plugin.applyAddPropertyVisibility();
					this.display();
				}));

		/*
		 * Hiding the button without binding the hotkey leaves him with neither.
		 * Saying so here, with whatever it is currently bound to, is the whole
		 * difference between a setting and a trap.
		 */
		if (this.plugin.settings.hideAddProperty) {
			const bound = this.plugin.addPropertyHotkey();
			containerEl.createEl('p', {
				cls: bound ? 'setting-item-description' : 'oof-settings-warning',
				text: bound
					? 'Bound to ' + bound + '.'
					: 'No hotkey is bound yet, so there is currently no way to add a '
						+ 'property to a note. Settings → Hotkeys → search for "Add a '
						+ 'property".',
			});
		}

		new Setting(containerEl)
			.setName('Property order')
			.setDesc('How the properties of a note are laid out. Grouping puts each '
				+ 'class\'s characteristics together, nearest class first, and sorts by '
				+ 'type then name inside each group. Changing this rewrites the order of '
				+ 'every note on the next Update — the plan shows it first.')
			.addDropdown((dropdown) => dropdown
				.addOption('type', 'By property type, then name')
				.addOption('class', 'Grouped by the class it came from')
				.setValue(this.plugin.settings.propertyOrder)
				.onChange(async (value) => {
					this.plugin.settings.propertyOrder = value;
					await this.plugin.saveSettings();
					this.plugin.redrawPropertyHeadings();
				}));

		new Setting(containerEl)
			.setName('All notes carry the base characteristics')
			.setDesc('Every note gets every base characteristic, empty or not. Off, a '
				+ 'note that is not a class keeps one only when it has something to say '
				+ 'with it, and blank ones are cleared out on Update.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.allNotesCarryBase)
				.onChange(async (value) => {
					this.plugin.settings.allNotesCarryBase = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Class symbols' });

		this.addText(containerEl, 'Symbol property',
			'The property a class\'s symbol lives in, on the class note. It shows '
				+ 'before the class name in the panel and before its section in the '
				+ 'properties view, and a class with none shows the nearest one above '
				+ 'it. Leave this empty to turn symbols off.',
			'symbolProperty');

		new Setting(containerEl)
			.setName('Write an inherited symbol onto the class that inherits it')
			.setDesc('On, Update gives every class below a marked one its own copy of '
				+ 'that symbol, so the class note itself says what it is marked with. '
				+ 'The copies are remembered: change the symbol on the class above and '
				+ 'they follow, remove it and they go — but a symbol you set on a class '
				+ 'yourself is never touched. Off, the symbol is only resolved when '
				+ 'something asks, and the child notes stay empty.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.writeInheritedSymbols)
				.onChange(async (value) => {
					this.plugin.settings.writeInheritedSymbols = value;
					await this.plugin.saveSettings();
					this.plugin.invalidatePicture();
					this.plugin.refreshViews();
				}));

		new Setting(containerEl)
			.setName('Rate each class by what it adds')
			.setDesc('A "+N" beside every class name: how many characteristics it '
				+ 'declares that nothing above it already declares. A class showing +0 '
				+ 'adds no metadata of its own — it only narrows what its parent already '
				+ 'says. Hover it for the list.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showClassNovelty)
				.onChange(async (value) => {
					this.plugin.settings.showClassNovelty = value;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				}));

		containerEl.createEl('h3', { text: 'Default values' });
		containerEl.createEl('p', {
			text: 'Each characteristic note carries a table saying what its value should '
				+ 'be, and where: a row per class, inherited nearest-first, plus an '
				+ '"All notes" row for every note carrying the characteristic. Starting '
				+ 'value is what a note is created with and is then its own. The other '
				+ 'three are standing claims about every instance — None replacement '
				+ 'fills an empty value, Value must be replaces anything that is not it, '
				+ 'and Value must contain adds a missing entry to a list. The table is '
				+ 'the only place a default is written.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Every characteristic note carries the table')
			.setDesc('On, Update appends an empty table to any characteristic note '
				+ 'without one, puts back a missing All notes row, and brings a table '
				+ 'written with the old column names up to date. Off, only the notes '
				+ 'Update creates carry one.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.seedDefaultsTable)
				.onChange(async (value) => {
					this.plugin.settings.seedDefaultsTable = value;
					await this.plugin.saveSettings();
					this.plugin.invalidatePicture();
					this.plugin.refreshViews();
				}));

		new Setting(containerEl)
			.setName('Unique file name')
			.setDesc('A new note with no name of its own is named after the moment it '
				+ 'was made. Moment format — YYYY-MM-DD dddd — HH.mm.ss gives '
				+ '"2026-08-24 Monday — 15.42.07". Update writes a Templater block '
				+ 'carrying this into every class template, and rewrites it here when '
				+ 'you change it. Colons cannot appear in a file name. Empty turns the '
				+ 'convention off and takes the blocks back out.')
			.addText((text) => text
				.setPlaceholder('YYYY-MM-DD dddd — HH.mm.ss')
				.setValue(this.plugin.settings.uniqueNameFormat)
				.onChange(async (value) => {
					this.plugin.settings.uniqueNameFormat = value.trim();
					await this.plugin.saveSettings();
					this.plugin.invalidatePicture();
					this.plugin.refreshViews();
				}));

		new Setting(containerEl)
			.setName('Right-click a property value to rename it')
			.setDesc('Right-clicking a value in a note\'s properties offers to rename '
				+ 'it on every note that holds it, the same way the panel does. Only '
				+ 'values of properties a characteristic declares, and never the '
				+ 'property name — that menu is Obsidian\'s. Off gives the right-click '
				+ 'back to Obsidian and Electron.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.renameValueFromProperties)
				.onChange(async (value) => {
					this.plugin.settings.renameValueFromProperties = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Offer the possible values in a property field')
			.setDesc('Clicking into a value suggests what the characteristic permits, '
				+ 'in the order its note lists them, rather than the values the vault '
				+ 'already holds sorted alphabetically — so a value no note carries yet '
				+ 'is offered too. Only listed values: where a characteristic says '
				+ 'nothing, or names an interval or a class, Obsidian\'s own '
				+ 'suggestions stand.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.suggestPossibleValues)
				.onChange(async (value) => {
					this.plugin.settings.suggestPossibleValues = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Offer a class\'s instances too')
			.setDesc('A characteristic naming a class — "[[Project]]" — fills the '
				+ 'field with every note that is a Project, rather than the ones the '
				+ 'vault already files under that key. Off, because a class is a type '
				+ 'rather than a list: the instances come out alphabetically, which is '
				+ 'how Obsidian sorts anyway, and typing "[[" already reaches every '
				+ 'note in the vault. Worth turning on for a vault whose classes have '
				+ 'few instances. Needs the setting above.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.suggestClassInstances)
				.onChange(async (value) => {
					this.plugin.settings.suggestClassInstances = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Name class sections after their characteristics')
			.setDesc('The section for a class in the properties panel reads '
				+ '"Person characteristics" rather than "Person". The other three '
				+ 'sections are unaffected, and folding is unaffected either way.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.nameSectionsAsCharacteristics)
				.onChange(async (value) => {
					this.plugin.settings.nameSectionsAsCharacteristics = value;
					await this.plugin.saveSettings();
					this.plugin.redrawPropertyHeadings();
				}));
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

/*
 * The two view classes, hung off the export for the suites.
 *
 * Obsidian reads `module.exports` as the plugin constructor and looks at nothing
 * else on it, so these are invisible to the app. They are here because the
 * alternative is a suite that can only reach the half of the diagram with no DOM
 * in it — and the drawing is where a typo costs an empty tab rather than a
 * failing assertion.
 */
module.exports.ClassesView = ClassesView;
module.exports.UmlView = UmlView;
