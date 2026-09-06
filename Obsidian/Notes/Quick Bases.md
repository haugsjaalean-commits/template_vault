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
created: 2026-08-29 09:06
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
checkpoint: reached
dead: false
category:
subject:
active priority: 10
difficulty:
payoff:
activity: active
goal type:
  - "[[Project]]"
---


# Bases drag and drop plugin

I think it would be truly incredible if there was a way to drag and drop elements within a base. Take my [[Improvement Base.base]] for example: one of the views for this based is grouped based on `status`. Even though the status of a note is clear based on which group it's in, I still like to have status visible so that I can easily change it without having to click into the note itself. But the downside is that this causes more visual clutter on the screen. Visual clutter is something that I want to avoid at all cost. My suggested solution for this is to be able to drag and drop files from one group to another, or even from one row to another. When the user does this, the values which need to be changed in the file in order for the repositioning to happen will automatically be changed without the user having to do any dirty work. 

N.B. Moving a note from row to row, should be a different event from moving a note from group to group. If the user wants to only regroup a note and note decide its position in the column, then they can drop it in the heading of the group; otherwise, they can drop it in exactly the place they want it to be displayed. 

Sometimes, because the last sorting item is the name of the file itself, it will be impossible to move the file to the exactly correct place, so the plugin should show the different options for moving based on these constraints. 


## Visuals 

I would like the place where the file is being dropped to be highlighted. As I discussed above, this highlighting will also be used to explain to the user where they can and cannot put the file. If the user hovers over the entire group, that whole area will be highlighted. There should be an option to always be told what will change with the move, and the user should be allowed to take back their choice. They should also be allowed to only accept certain changes in the move but not others. 


## Additional options

Since we already have the ability to drag and drop, we should also have the option to right click and move in a more manual/accessible manner. It's just like a file explorer, just on a far more complex level. 



