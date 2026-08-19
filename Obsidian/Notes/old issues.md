---
created: 2026-08-19 09:05
is a:
  - "[[Obsidian Note]]"
related:
note rating:
rating:
---


## Thoughts


### My system for `possible values`


If a link to a class is given in the `possible values` field, then the value given has to be a link to an instance of that class (we are using `is a`). If a list of strings is given, then the value must be one of these strings. If an interval (described with brackets like `[0, 10]` or `[1, 3[`)



### What the purpose of this plugin is 

 
I think that it's important that I think about the real meaning and purpose of this whole system and the plugin that I'm building on top of it. I need to do this because, otherwise, I run the risk of going completely against my whole theory which I have so tirelessly perfected. 

Often times, I find that the easiest way to think about this is by imagining Rhizomeur, and how this app would be constructed. I think that the Rhizomeur counterpart of this plugin would be as follows. In Rhizomeur, a *class* would simply be a note which says "my children have these following attributes (characteristics)". Then, if one creates a note which points to the parent object, they will inherit those attributes. This child could also point to another note and say that it inherits from that other note, in which case it would also get the attributes from that notes. Basically, `inherits from` and `is a` would do the same thing, but they simply have two different meanings. One could go further and ask themselves if it's possible that a note *inherits* from one thing and *is a* different thing, but I will be leaving that door open and allowing notes to do both for simplicities sake. Maybe this is something I will come back to revisit in the future. In any case, whatever I decide on for this philosophy, it will always just be a question of figuring out the semantics of my system, which is also something that I would be doing in Rhizomeur. Figuring out which links mean what is a central part of simply figuring out organization, but it doesn't mean I'm braking my theory - it is inside of my theory. Everything I am doing with this plugin is just me figuring out how I want to represent semantic relationships between objects. And it is also a way for me to carry out certain operations based on those relationships, like duplicate certain characteristics from note to note and keep track of things like classes. 

I am needing to use metadata in order to describe these semantic relationships, but Rhizomeur would not function like this exactly. Furthermore, the act of creating one *base note* is something that I actually would also do in Rhizomeur. Even though all notes are automatically considered notes, creating something like a `Rhizomeur Note.md` would allow me to specify how I want *my notes* to be. I am doing this same thing in Obsidian. 


### Takeaways - how to create the plugin 


The classes should be called as such instead of "objects". Also, `inherited from` should be renamed as `type of` for clarity (keep inherited section in panel however).

Each class will have a `#class` tag flagging it as such. All notes created that don't have that tag should have all blank base characteristics removed on creation or on update (templates should also not have blank base characteristics). I had previously stated that I thought that all base characteristics should be included in all templates, but I was wrong; instead, base characteristics will only appear in notes where they are being added with a value. In principle, the base characteristics will only be added to notes in these two scenarios:
1. **A new class is created:** Usually, there will be a `type of`. 
2. **A new note is created:** Usually, there will be an `is a`.

Basically what I'm saying is that a note should only be created with a base characteristic if that field is not blank in its parent, whether the relationship be `type of` or `is a`.


#### Thoughts on this method

I think that the use of tags for classes is simply something that allows me to make my class system more explicite. After all, the whole point of `is a` and `type of` is that I am defining different classes of objects (notes). By having a more explicite way of describing which notes add new information and which notes are simple "copies of these notes", we make the navigation of this class system much easier. I am still, however, on the fence about this feature. Something bothers me about it, and I don't know why. ==I think the real utility of the tag is that it allows us to know if a note is an instance of something or an entirely new thing which needs to be added to the classes panel.==

### Another change 

The only source of truth should be the context panel. This goes for all of the different types of files (notes, characteristics, architypes). I think that there should be a panel for editing all of the property types and allowed values for all of the properties (this could be a dropdown). 

#### Priority orders

I will describe what the order of priority should be for different things. This order can be used to solve cases of nul values or of values disagreeing. 

N.B. The first item on the list for all of these things is the edits made in the panel which always override anything else.

N.B. If something is not described by one of the first items on a list, then the fallback is the next one.
##### Priority order for attribute property types

1. The attribute notes property type field
2. The actual metadata property types in the notes. 

##### Priority order for list of attributes 





This should be the order of priority:
1. The new edits made through the panel.
2. The `#class` describe what the values of the 

#### Fixing discrepancies

When the value of something cannot be determined by one of the priority orders, then it will need to show up in a special discrepancy menu. This menu will show all of the things that couldn't be resolved and allow the user to choose what to do.

This is the list of all of the discrepancies I could think of:
1. unused characteristic (needs to be either used or deleted)
2. 


### New


#### Building a picture

How I would code the system is by creating a "picture" of the classes and notes which inherit from them. This picture would be created whenever the plugin loads or whatever (I'll leave this part to you). This picture is basically the classes, the notes, and all of their attributes and the values and types of these attributes. It is basically just describing the objects as code instead of as markdown files linked to each other. This whole picture is what we see displayed in the panel, and it will need to include all properties and their types and their allowed values. 

N.B. When someone interacts with the interface, they are actively changing the picture. 

In order to build the picture, the first thing to look at is the class notes in order to create the classes. Then we need to look at all of the other notes in order to create the instances. The instances will simply have the characteristics of their parents plus the characteristics listed in their parents. and they should also of course have an `is a`. 

#### Managing discrepancies 

The second step will be to find any inconsistencies in the between the picture and the reality. These have different types. I will list here the main types and what to do:
1. If there is a `#class` note which doesn't match any of the classes, then the user should be prompted to add it as a class from the note view. Otherwise, it stays listed as a discrepancy which will need to be resolved on update. 
2. you can imagine the rest
