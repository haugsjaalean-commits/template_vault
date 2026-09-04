---
is a:
  - "[[Project]]"
characteristics:
type of:
views:
created: 2026-09-03 08:44
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
  - "[[Class Manager]]"
subject:
active priority: 10
difficulty:
payoff:
activity: active
done: false
urgency:
what to do:
checkpoint: mapped
---




Instead of only having `is a`, I think it would be a good idea to add a new field called `components`. Components would not directly link to other classes; instead, it would simply be a list of connexions that a given classes instances can have with other classes. This will add en enormous amount of possibilities. If things work in this way, then `is a` is no longer the only way in which a notes metadata can be changed. This is powerful, because I am opening the door for `is a` relationships going through different streams. This will massively clarify things and open up many possibilities. (Bruh, I'm repeating myself.)

Components will be inherited much like characteristics and views. `components` will be a new base characteristic. The act of adding a new component simply adds a field where the user can input a class. When the user inputs a class (if the class is accepted by the `possible values`), then the current class will take all of the characteristics of the component class. 

## Example of how this can be used


I would use this to restructure my system of improvements and projects. Instead of having a branching tree pattern that starts at `Improvememnt`, I would simply have one `Goal` class with multiple components. The first component field would be `type`, and the possible classes for this would be `Effort` and `Todo`). The second component field would be `subject`, and for now the only thing it would be allowed to optionally contain is `Coding` (multiple other classes would inherit from `Coding` such as `Bug` or `Obsidian Plugin`). 

The only class inheriting form from `Goal` would be `Sub Goal`. This would add the option to explicitely say that the goal is 



The third and final component field would be `is sub goal` which would allow me to input the `Sub Goal` class. If it is left empty, that simply means that it is not a sub goal. 


