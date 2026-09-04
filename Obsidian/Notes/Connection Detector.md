---
is a:
  - "[[Obsidian Plugin]]"
characteristics:
type of:
views:
created: 2026-08-31 16:23
ext links:
related:
note rating:
rating:
evolution: Charmander
garden:
life stage: current
dead: false
category:
project:
subject:
active priority: 10
difficulty:
payoff:
activity: simmering
done: false
urgency:
what to do:
checkpoint: mapped
---

## Plugin idea and explanation

Currently in my base, I have implemented three formulas: `is_is_a`, `is_type_of`, and `connection type`. The purpose of this is so that I can know where the link exists and what it means (I want to know the type of the list). In other words, I want to return the property which holds the link which links to the active file (which I use fore the [[Backlink Base.base]]). Currently, these three formulas do a pretty good job, but they only distinguish between three different cases: the link is contained in `is a`, the link is contained in `type of`, the link is anywhere else in the file. 

What I want is to have a formula that returns all the situations automatically:
1. The name of the property which the link is contained in
2. Returns `file body text` if the link is not contained in any metadata. 
   
N.B. The function should return multiple values if there are multiple links in multiple places. 

Of course, if the note in question does not link to the file, then it will return `None`.
