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
created: 2026-08-31 17:33
ext links:
related:
note rating:
rating:
evolution: Charmander
garden:
life stage: current
done: false
urgency:
what to do:
checkpoint: mapped
dead: false
category:
subject:
active priority: 10
difficulty:
payoff:
activity: simmering
goal type:
  - "[[Project]]"
working towards:
  - "[[Class Manager]]"
---
 

Instead of classes always adding to the list of characteristics, they should also have the ability to get rid of characteristics inherited from their parents. What I suggest is the addition of a new base characteristic: `lost characteristics`. 

A concrete use case of this would be my `Calendar Event` class. I would be able to create a child of that class called `Precise Calendar Event`, which would use `datetime` instead of `date`. In order to do this, I would make the `lost characteristics` of `Precise Calendar Event` contain `date` (meaning that `date` would no longer be a characteristic of this class). Then I would add another practically identical characteristic called `datetime` (which would use the `datetime` property type instead of the `date` property type). By following these steps, I would basically be able to make child classes which would be more specific than their parents.  

