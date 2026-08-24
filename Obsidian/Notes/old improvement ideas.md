

## Improvements

### Old

- [x] Can you create an option to automatically create a base for any of the given objects. The base should always exclude templates. All of the new characteristics of an object should be columns in the table.
- [x] I want you to get rid of the root note feature. If I create a file, it should be explicit that it was created as a note. If I want to change this later, I should be able to delete the `[[Note]]` and add a different class (object). On update, the class will be updated. 
- [x] All base characteristics should automatically be a part of every template. This should not be because they all inherit from the base Note Template, but for the sole reason that they are base characteristics. 
- [x] On update, whenever there is an object which doesn't comply to the current norms describe in the panel, it should be updated.
- [x] I think you already have this at least partially set up, but there should always be a message explaining the change for each file on update.
- [ ] Currently, updates still don't find missing base characteristics to add I think. 
- [ ] I was mistaken when I said that all templates should have the base characteristics. In reality, only files aligned with a specific class should have the base characteristics. Base characteristics should be excluded from every other file. 




### Bugs



- [x] Saving in the panel never marks it as saved (`UNSAVED` is always displayed).
- [x] `type of` appears as not existing, but updating does not fix this or add it.
- [x] characteristics which are used no where should be deleted on update 
- [x] The feature which automatically reorders properties doesn't seem to have fully worked: [[Pasted image 20260816211259.png]] (there are sill properties out of order)



### New features

- [ ] `characteristics` should be replaced by two fields instead of one: `added characteristics` and `subtracted characteristics`. (I'm not sure about this)
- [x] Despite whatever order they may have been added in in the panel, updating should always reorder the properties of a note based first and property type and secondly on alphabetical order. This NEEDS to be something checked for on update. (This was already done, but I think that it needs to be worked on)
- [x] Can you add an option to automatically sort the objects in the panel first based on their line of descendance (children on the bottom) and secondly based on the alphabet. Also I would like you to add the option to quickly search for classes based on name.
- [x] Can you get rid of the `is a` plugin and integrate it with this one?
- [ ] This is a more complex feature: I want to have three types of characteristics: 1. base characteristics (these are logic characteristics which all notes have) 2. logic characteristics (these are logic characteristics which only some notes have - they would be added with the `logic characteristics` field which would be a base characteristic) 3. normal characteristics.
- [x] Can you add the option to rename classes from the context panel. 
- [ ] Can you add the option to selectively get rid of changes made in the c panel before update. For instance deleting a new class before it's been added.
- [ ] Can you add the option to have specific values for specific characteristics for a given object. I suppose this is already possible. The only thing I have to do is edit the template file to add the specific value. For example, I can say that every visual artist has `domain: visual`. This is quite like the characteristics: editing the file type of one of the characteristic files should automatically update all of the notes having this characteristic. This means that certain things will be like these should be based on the files and note the interface. What do you think? May there be a better way of doing this? The only other way of thinking of it is that the ONLY source of truth should be the panel, in which case we will need to add many more options. We would need to add an entire drop down for characteristics which would allow for editing their type, default values and accepted values. Speaking of this, whenever there is a non accepted value on update, there should be a message explaining this. I think that the panel should be the only source of truth - this is much simpler and easier to understand. 
- [x] Can you change how the top-most panel in the plugin looks, because it looks not so great with my current theme: [[Pasted image 20260816214055.png]]. I don't like the top part of this screen shot but the lower part is fine. Mostly I want the heading to be more stylized like from he calendar plugin and I want the background to be the transparent or something (although that may cause problems so you could simply make it rounder than it it right now cause I like roundness).
- [x] Instead of having rename be a link under the the class, can you add a pencil icon to the right of the class names which allows for rename
- [x] Make it so that the `Characteristic Template.md` adds a unique character to the beginning of all of the characteristics. Also please add this character to the beginning of all preexisting characteristics. 
- [x] Make an option to fold or unfold all classes at once in the view.
- [x] ![[Pasted image 20260819125850.png]]: Make the `open note` text simply purple with not back ground, and keep the `is a` text the same as it is now



