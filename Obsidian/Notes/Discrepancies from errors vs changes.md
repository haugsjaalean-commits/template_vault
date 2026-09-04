---
is a:
  - "[[Project]]"
characteristics:
type of:
views:
created: 2026-09-03 09:34
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
active priority: 0
difficulty:
payoff:
activity: sleeping
done: false
urgency:
what to do:
checkpoint: mapped
---


Discrepancies can be created in two ways:
1. They can be created when the user changes the values of things through the editor panel. 
2. They can also be created when the user changes the values of the files themselves. 

There should be some sort of way for the Class Manager to inform the user about which type of discrepancy they are seeing. I would suggest the use of two different boxes in the top of the screen instead of just one. 

As I understand it, the class manager has a list of objects and classes and the likes. When the user changes something in the panel, the items in this list change. To me, this seems problematic. 


## Further thoughts


Above, I worry about the fact that sometimes discrepancies are created by changes in the file, and sometimes they are created by changes in the Class Manager panel. I thought the fact that these two things exist at once could cause harmful overlapping. This is where I was wrong. I was wrong because the two things actually never overlap at all. The only time when changes are made in the files in order to update things is in the characteristic files. Other than that, the plugin reads the files once in order to understand the objects, but, after that point, the "picture" made in that moment is considered the truth. Then all discrepancies are simply created by the difference between the files and the initial picture or any updates made to that picture. For this reason, it doesn't really make sense to try to separate discrepancies, because they all come from the same place in the end. 


### Correction


What I wrote above doesn't correctly represent how the actual system works. 

```
files → raw property lists  ──patch──→  patched lists → [derive] → model
                                                         ↑
                                              happens once, after
```