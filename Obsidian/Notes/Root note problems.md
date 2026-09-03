---
is a:
  - "[[Project]]"
characteristics:
type of:
views:
created: 2026-08-27 11:04
ext links:
related:
note rating:
rating:
evolution: Charmander
garden:
life stage: current
dead: false
category:
  - improvement
project:
  - "[[Class Manager]]"
subject:
active priority: 5
difficulty: 2
payoff: 4
activity: simmering
done: false
urgency:
what to do:
checkpoint: mapped
---

Because of the root note option, there are no notes which link to the root note in `is a`. This is problematic, because it slightly brakes certain queries or displays. For instance, the `is a` for all notes inheriting from `Obisian Note` is `NONE`. Because of this, the the base for the root note doesn't work, as all notes it would want return NONE. 

I think that the best way to fix this is to simply make it so that, when the root note option is turned on, the `is a` function will still know to return `Obsidian Note`. This would fix all problems

