---
is a:
  - "[[Creator]]"
characteristics:
type of:
created: <% tp.date.now("YYYY-MM-DD HH:mm") %>
ext links:
related:
note rating:
rating:
garden:
life stage: current
maturity: Charmander
birth day:
death day:
children:
relation to me:
historical importance:
location:
creation domain:
masetery:
---

<%*
/*
 * OOF Classes: unique file name — a new note is named after the moment it was made.
 *
 * Only when it has no name of its own yet: a note created by following a
 * link arrives carrying that link's name, and renaming it would rewrite
 * the link that made it.
 *
 * Written by the plugin from its *Unique file name* setting. Edits here
 * are overwritten the next time that setting changes.
 */
const stamp = tp.date.now("YYYY-MM-DD dddd — HH.mm.ss");
if (tp.file.title.startsWith("Untitled")) {
	let name = stamp, n = 2;
	while (app.vault.getAbstractFileByPath(
			tp.file.path(true).replace(/[^/]*$/, name + ".md"))) {
		name = stamp + " " + n++;
	}
	await tp.file.rename(name);
}
-%>
