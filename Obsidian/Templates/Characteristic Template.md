<%*
/*
 * A characteristic note's file name begins with ∘ — the way • begins a name and
 * ‣ begins a word. The characteristic itself, and so the property it defines, is
 * never prefixed: this note is "∘ domain" and the property is "domain".
 *
 * Renaming here rather than in the frontmatter, because it is the file name that
 * carries the convention. Skipped when the title already has it, so re-applying
 * the template cannot produce "∘ ∘ domain".
 */
const prefix = "∘ ";
if (!tp.file.title.startsWith(prefix.trim())) {
  await tp.file.rename(prefix + tp.file.title);
}
-%>
---
characteristic meaning:
property type:
is base characteristic: false
possible values:
default value:
---
