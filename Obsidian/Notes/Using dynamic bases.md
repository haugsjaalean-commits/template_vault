---
is a:
  - "[[Sub Goal]]"
characteristics:
class views:
component fields:
type of:
views:
goal subject:
  - "[[Obsidian Plugin]]"
created: 2026-09-01 06:01
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
active priority: 10
difficulty: 6
payoff: 10
activity: active
goal type:
  - "[[Project]]"
working towards:
  - "[[Class Manager]]"
---




An example of a dynamic base is [[Improvement Base.base#dynamic project]]. This view allows me to have a standard way of seeing sub improvements for a given project, and it automatically updates itself depending on the project in the active window. This type of structure opens up a lot of amazing possibilities for speedy and automatic organization. My question is what is the best way to implement this. Obviously, it is already implemented without my having to do anything, but it requires multiple clicks from the user too see this view. This is not ideal. Ideally, the dynamic base could be seen completely automatically based on what the active note is. This is much like a query for a relational database. A query creations a template of sorts for how each thing should be shown, and then it repeats said template for every object in the database. In Obsidian, I want to achieve the same thing, just on a more theoretical level. For example, I want to have the following query: 
1. List Projects with no parent project (non sub-projects)
2. For projects show `dynamic project` view in `Improvement Base`. 

This shape should be seamlessly repeated for every project. The reason I said that this is mimicking a database on a *theoretical* level is because the whole structure neve actually exists all at once. In a database, the query is made, and the information is displayed. In Obsidian, the system restructures itself based on the users "position" in the arborescence of information. If one were to walk through multiple steps and then repeat this for others notes, all the while creating a map of what they see, the end result would be the same as the database. While Obsidian is purely position and primarily functions based on walking through the different levels of a purely theoretical query, there are ways to see the whole picture all at once as if it were a database. For example, [[It is possible for one base to do multiple things at the same time]]. This was quite surprising to me, and it means that I really should've been giving more credit to bases. The idea that one base can be showing two different things at once is quite mind blowing. I suppose it is a positive side effect of the fact that a base in Obsidian is just a few lines explaining a query and the view, but Obsidian simply interprets that wherever it is. This means that I have been thinking about bases all wrong this whole time. A base is not really a base at all. It is just a query - a query that can be repeated anywhere at any time as many times as I want! The real base is the vault itself, but the `.base` files are really nothing more than flexible queries! This opens up so, so many possibilities. 

In a relational database, the queries are made on the fly, and they can be changed at any time. Obsidian works a little differently: in Obsidian, we have the option to reshape the theoretical query when we want, but, most of the time, it is a static thing that doesn't change. The user walks though different parts of the query. (I am calling it a "query", but what I am referring to is the different *search branches* that make up the loose organizational structure of Obsidian.) One of the most obvious ways the user can make live changes to the query is simply using a search bar (either in the file explorer or in a base). Another way is by is by opening a dynamic base which relates to the active file but wasn't already linked to it. Or the user can change the view of the current base (this is probably the main way of actively restructuring the arborescence). To be truthful, Obsidian is a largely static searching model, which means that search paths (or queries as I've been calling them) are lade out in editing mode. And, in the viewing mode, the user simply walks through the structure they already created beforehand. <[[Repitition]]> In a way, the act of walking through the "graph" can be seen as the very act of creating the query. It's just that the query is made flexible and useful thanks to the structure of the links that are already there. 

## How to implement dynamic bases



I think that the best way of implementing dynamic bases is by creating a new base characteristic. This characteristic would be called `views`, and it would be a list of links to bases (which will sometimes specify which view in the base). Each class has the chance to add a view, and all of its child classes will also have that view. When I say they will "have" the view, I mean that the plugin will understand that they inherit that view, but it will not be specifically listed anywhere in the frontmatter. The Class Manager plugin will introduce a new function which will return the list of views of a given note. (Views function like characteristics, meaning that a file only recieves a view if the relationship is `is a`. Otherwise, if the connection is `type of` then it simply "stores" the view.) This function introduced by the Class Manager will be supplemented by a new plugin: [[Dynamic Views]]


