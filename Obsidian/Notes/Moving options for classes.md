---
is a:
  - "[[Improvement]]"
characteristics:
type of:
created: 2026-08-27 08:22
ext links:
related:
note rating:
rating:
garden:
life stage: current
maturity: Charmander
importance:
activity: simmering
status: idea
category:
project:
  - "[[Class Manager]]"
subject:
---



There should be an option to move the place where the options for classes appear. Instead of having all the options listed in every card in the top line, they should be listed only once above all the classes. Clicking on the name of a class should bring the user to the note for that class. Whichever the options listed above the classes only appear when a class is highlighted, and they will be in accordance to the `active`/`is a active` class. 

As I suggested above, the option to open the note for a class should be removed and replaced by the option to simply click on the name of a class. The following options should be moved to the above section that I described:
- Template  
- Base + Reset base
- Make the open note a class
- New instance, from its template

The three-dot menu for renaming/symbols/deletion should go to the far right of the card where the other options used to be.



## The future of this idea



In the future, I will want to be able to select multiple classes at once. This will be implemented by having two selection modes:
1. Active note tracking: This is the mode that is already implemented. This tracks the active note and highlights the class that corresponds to it by tagging it as either `ACTIVE NOTE IS A` or `ACTIVE`. 
2. Custom selection: This is turned on when a user clicks on a dot next to a class. Clicking on one of the dots will select that class and shift/ctrl clicking on another one will select both. The view will be automatically shown as changing from `Active note tracking` to `Custom selection`. Either option can be toggle on manually, but they will also automatically change based on what the user does as I just stated. If the user clicks back onto the active note, then the mode will automatically return to the `active note` mode. However, the selection information for the `custom selection` will be kept if the user manually toggles it back on. However, if the user simply turns it back automatically by clicking on one of the dots, the information will be scrapped. 

N.B. Because this interface uses the dots as buttons, we will need to change the simple list view for the classes to still have dots, even if they will not be connected to anything. 


### Multiple class selection

When multiple classes are selected in `custom selection` mode, the options provided will change to fit this state. The button for creating a new instance will create an instance who's `is a` will contain all of the selected classes. Applying the class to the current note will give that note all of the selected classes. 

The one option that would be more difficult to pull off is the base. We cannot open two bases at once after all. What I propose is an option in the setting which allows the user to choose between two different modes:
1. Static base mode: When this mode is on, the option to open a base when multiple classes are selected will simply be grayed out, and everything will work as usual when just one class is selected. 
2. Dynamic base mode: When this is turned on, clicking on the base option with multiple selected classes will open a special base: the dynamic base. There is only one dynamic base, and its job is to change when it needs to based on the selected classes. If two classes are selected, then the base will show all of the instances from those two classe. This option would be complimentary to [[Class bases]], which adds additional options for manipulating bases according to classes; for instance, from the `class base` menu in the dynamic base, I could change which parts of the base change and which parts stay the same as the base is being updated. 

