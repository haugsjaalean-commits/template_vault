---
is a:
  - "[[Obsidian Plugin]]"
characteristics:
type of:
views:
created: 2026-09-01 18:43
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
active priority:
difficulty:
payoff:
activity:
done: false
urgency:
what to do:
checkpoint:
---


I want a way to dynamically create/destroy [[Sticky Note]]s. Notepads are something that will be linked to by every note. Or, at least, every note will have a `notepad` characteristic which will allow it the chance to have a note pad. The point of the note pad plugin is to add a notepad view. This view will show a blank document, and, when the user clicks on it, it creates a notepad for the active file. If the active file already has a notepad, then it is simply displayed in the view. If a notepad is not linked to by any other note and it contains no text, then the garbage collection of the plugin will delete it. 

The point of this is to allow me to quickly jot down thoughts without needing to give a second thought about where to put them. This follows the philosophy of *note first, organize later*. <![[Thoughts are fleeting]]>

The nice thing about this is that I will have a safe place to keep any random thoughts referring to a given subject, but I will also have a base which links to all other notepads. 

I previously said that I thought that each file should have a field through which it could link to a notepad, but this is obviously the wrong conception. It is undoubtedly better for the notepads themselves to link to files. This way, notepads do not necessarily need to be something that links to any given file. They can link to multiple files or not file at all. 

An alternative name would be Sticky Note. I think that this makes much more sense as a name. This is a bette name because it more accurately describes what it is. A sticky note is something that we create quickly and then stick to something. This is exactly the point of the feature in Obsidian. I want to have a way to be able to quickly create a place where I can write a random thought and then attach it to the main place where I am working. 




## Specs


List of options in the tab:
- Open Sticky Note base (the base will be opened in the Dynamic Sticky Notes tab itself)
- Create new Sticky Note for current file
- Create new Sticky Note

The Dynamic Sticky Notes panel will have three views: 
1. Notes view. This view shows a grid of open notes. (There will be a setting which determines the number or columns in the grid (potentially only one).) Each note can be pined. Any note which isn't pined and doesn't relate to the active file will be cleared when the user changes to another file (cleared sticky notes are sent to the trash can which is the the third view). All sticky notes for the active file will automatically enter the view (and will be highlighted). If the active file doesn't already have a sticky note, then there will be a blank note added which will allow the user write in it. Once they do write in it, a real note will automatically be created and linked to the active file. 
2. The base view. This view will simply show the base for sticky notes. Nothing too special here. 
3. The trash view. This view shows all sticky notes recently removed from the active view (Notes view). They are displayed in the same manner as in the other view. The user can select them one by one (which fills in a check circle in the top right corner of each note), and then they can press a button in the top of the view which will move the selected notes to the notes view. 


### Additional features 


It would be cool to have the options for the colors of the sticky notes. One of the options should be to create the sticky notes with random colors. The color would be stored in the frontmatter. The user should also have the chance to choose the color which they like. 


