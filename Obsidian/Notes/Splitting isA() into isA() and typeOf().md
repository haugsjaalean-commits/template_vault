---
is a:
  - "[[Sub Goal]]"
characteristics:
class views:
component fields:
type of:
views:
goal subject:
  - "[[Programming]]"
created: 2026-09-05 08:37
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
active priority:
difficulty:
payoff:
activity:
goal type:
  - "[[Project]]"
working towards:
  - "[[Class Manager]]"
---


Currently, there are three ways of connecting files together: `is a`, `component fields` and `type of`. Despite this, there are only two queries: `isA()` and `hasA()`. This is bad, because it means that we are losing precision. That is why I propose splitting `isA()` into `isA()` and `typeOf()`. This would allow me to differentiate between instances and sub-types. This is crucial. 

N.B. This will also need to be added as an option for class bases. They will need to have an third option to filter for `typeOf()` instead of the other two functions. 



