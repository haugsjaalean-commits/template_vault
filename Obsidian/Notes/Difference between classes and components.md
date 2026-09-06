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
created: 2026-09-05 14:00
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
activity: active
goal type:
  - "[[Project]]"
working towards:
  - "[[Class Manager]]"
---

I think that the difference between classes and components should be made explicite. This is because I don't think that it ever actually makes sense to instantiate something that is also being used as a component. This would be a very strange behavior indeed. 

## How to implement

I suggest that a new tag be added, `#component`, and that this tag be used for all components. Components will work the same as classes except that they won't have templates, which effectively means that they cannot be instantiated. If someone tries to instantiate a component, it will be a discrepancy. Furthermore, it is impossible for a class to be a type of a component and vice versa.

## New implementation ideas


I think that components should be able to inherit form classes (they already do seeing as they inherit from Obsidian Note), but classes should not be albe to inherit from components. This is because, if a class inherits form a component, then we would be able to instantiate something that was never meant to be instantiated. On the other hand, there are no problems caused when a component inherits characteristics from a class. It would allow for more complexe and free implementations of components. For instance, `Time Sensitive Todo` could inherit form `Calendar Event` even though `Calendar Event` is a class and not a component. I don't see this causing any problems. The only problem I see is that a base searching for calendar events would have to be looking for both `is a` and `has a` relationships. This could get messy. 

My final answer (at least for now) is that I think that there should be no crossover at all between components and classes. That means no inheritance. This means that, in order to maintain consistency, components should not inherit from the root note. They can still be instances of the root note, but they will not inherit. This doesn't really change anything. 

