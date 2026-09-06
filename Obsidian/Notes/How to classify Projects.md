---
is a:
  - "[[Sub Goal]]"
characteristics:
class views:
component fields:
type of:
views:
goal subject:
  - "[[Obsidian Plugin]]"
created: 2026-08-30 09:12
ext links:
related:
  - "[[Naming the status characteristic values]]"
note rating:
rating:
evolution:
garden:
life stage:
checkpoint: reached
dead: false
category:
subject:
  - wording and semantics
  - organization
active priority: 0
difficulty: 5
payoff: 1
activity: sleeping
goal type:
  - "[[Effort]]"
working towards:
  - "[[Class Manager]]"
---

## Ideas for the naming of the different pipelines


checkpoint:
1. seen
2. mapped
3. started
4. reached



journey:
1. in progress
2. ended
3. rerouted
4. abandoned


activity:
1. active
2. simmering
3. sleeping


## Another idea for structering things

![[Pasted image 20260831091023.png]]



## Separating sub-projects from projects

In my template vault, I have an `Improvement` class. This class has a characteristic called `project` which allows it to point to a higher up improvement. This means that every project has the chance to be a sub project. This isn't bad on the face of it, but feels to me that it removes a certain element of clarity in the semantics of my classes. The point of the classes isn't only to introduce inheritance: it is also to clarify which notes serve which purposes. If I rename `Improvement` as `Priority` and then make `Improvement` a sub class of `Priority`, then I will have succeeded in making sub classes explicite. Only priorities inheriting from `Improvement` would have the `project` field. 

