---
tags:
  - test
is a:
characteristics:
class views:
component fields:
type of:
views:
created: 2026-08-24 08:16
ext links:
related:
note rating:
rating:
evolution: Charmander
garden:
life stage: current
---

This paragraph sits above every heading in the note, and it still gets the paper.
That is one of the two things v0.2 changed: the sheet is not something a heading
starts, it is the whole note. It carries no rule above it either — there is
nothing up there to be separated from.

Below, every heading level appears at least once, so all six separations are
visible in one screen. Watch the **line** and the **air beneath it**, because
those are now the only two things that change with depth.

# H1 — a 3px solid rule

The heaviest break in the note. Everything from here down is the same paper
colour and the same width as everything above it.

## H2 — a double rule

Two hairlines with a gap between them, which is CSS `border-top: 3px double`
rather than anything clever. A little less air under it than the H1 had.

## H2 — a second one straight after

Two H2s in a row, to check the rule reads as a break rather than as a border on
a box. Nothing here should look like a card any more.

### H3 — a hairline

An ordinary 1px solid line.

#### H4 — dashed

The first level where the line itself is broken rather than just thinner.

##### H5 — dotted

Finer still.

###### H6 — no rule at all

The sixth separation is the absence of one. Only the gap marks it, and the gap
is the smallest of the six.

## H2 — back up two levels

Worth keeping in the test even though v0.2 no longer cares: v0.1 painted a
background per *section*, and going back **up** a level is the case pure CSS
cannot handle. It is only a rule now, so the level below has no effect on it.

### H3 — with a heading immediately after

#### H4 — and nothing between them

Two rules with no text between should stack without collapsing into each other.

## H2 — other kinds of block on the sheet

The paper has to run under everything, not just paragraphs.

- a list item
- another one, so the block has some height
- a third

> A blockquote, which brings its own left border and background in most themes.

> [!note] A callout
> Callouts render as their own block. Worth a look — Obsidian gives them a
> background of their own, which may or may not sit well on the paper.

```python
# this comment must not be read as an H1
def separations():
    return ["solid", "double", "hairline", "dashed", "dotted", "air"]
```

| level | rule | gap |
|---|---|---|
| H1 | 3px solid | 2.2rem |
| H2 | 3px double | 1.9rem |
| H3 | 1px solid | 1.6rem |
| H4 | 1px dashed | 1.3rem |
| H5 | 1px dotted | 1.1rem |
| H6 | none | 0.9rem |

## H2 — the last one

To see the note with no H1 at all — the other case v0.2 promised — delete the
`# H1` line near the top. Everything should keep its paper exactly as it is now.
