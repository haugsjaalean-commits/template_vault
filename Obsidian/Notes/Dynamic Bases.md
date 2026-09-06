---
is a:
  - "[[Goal]]"
characteristics:
class views:
component fields:
type of:
views:
goal subject:
  - "[[Obsidian Plugin]]"
created: 2026-08-31 10:39
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
checkpoint: seen
dead: false
category:
subject:
active priority: 0
difficulty: 10
payoff: 8
activity: simmering
goal type:
  - "[[Project]]"
---



I would like bases to function completely dynamically. What I imagine is that all functions, queries, and view settings would be shared. 

The view settings is everything changed under the `View` menue in each individual view and also the `Properties` menue. A view would not contain information about queries. Queries will be treated separately by the plugin. 


## New thoughts

[[Dynamic Views]] got us closer to the ideal of Dynamic Bases, but we still aren't there yet. Dynamic views me to easily change a base's query based on the active file. It also allows me to automatically imbed different views in the active file which is also great. What it doesn't allow me to do is quickly and easily change multiple parts of the query at once, which is the true ideal. For instance, I have many, many goals in my vault. I would like to be able to quickly and easily filter for goals based on their subject, or their type, or their sub class (like `Sub Goal`). Currently, other than making many different views throughout a few different bases which all basically repeat the same thing, there is no way of doing this. That is why I don't want views in bases to be static things. I wish that they could stack on top of each other and be easily exchanged. I think that the best way of integrating this is to add more options to the class bases options menue. I could add another option which allows me to easily decide which sub classes I accept. This is already partially implemented, but the only two options are all subclasses and no subclasses. I cannot choose to only focus on a given subclass for example. It would be cool if, with more or less one button press, I could limit the Goals base to only Sub Goals. 

I believe that there are multiple advantages to this implementation. First of all, it wouldn't be very hard to do at all. Secondly, it is quite elegant. A base can only be given one active file at once, so there is no question of doing multiple dynamic queries at once anyways. The different dynamic queries can be separated by view, and the different sub type queries can be done using the class bases menu. This seems quite elegant to me. 


### What I suggest implementing 

#### Simple implementation
![[Improvements to Class Bases]]

#### Advanced implementation 

![[Base Controller]]
