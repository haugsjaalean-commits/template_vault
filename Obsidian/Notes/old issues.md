---
is a:
characteristics:
type of:
created: 2026-08-19 09:05
ext links:
related:
note rating:
rating:
garden:
life stage:
maturity:
---
[[old improvement ideas]]

## Thoughts


### My system for `possible values`


If a link to a class is given in the `possible values` field, then the value given has to be a link to an instance of that class (we are using `is a`). If a list of strings is given, then the value must be one of these strings. If an interval (described with brackets like `[0, 10]` or `[1, 3[`)



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
