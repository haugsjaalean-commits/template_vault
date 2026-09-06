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
created: 2026-09-05 07:25
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


Currently, the only relationship that actually gives a give note a certain field is with `is a` or a `component field`. 

I am thinking about this because I want a way to add dynamic views to the classes themselves. Because this is currently my only use-case for this feature, I think it's reasonable to only implement *class inheritance* for views. 

The easiest way to implement it would be to simply add a new base characteristic called `class views`. These views would be given through `type of` instead of `is a`. Basically, it is a hidden `is a` being added, but it only works for the `class views` if that makes sense. 

I suppose that there is a coding analogy to back up this intuition: class attributes/class methods. In Python, classes can have attributes which are unique to the class itself. In light of this, it makes complete sense to implement this. 

## How I want it implemented 

I said above that I only wanted to implement it for views, but I decided that it might as well be implemented for characteristics and components as well. 

For doing this, I would suggest a slight rework in the UI of the classes. It may take up more space, but that doesn't matter because the cards are collapsed most of the time anyways. 

What I suggest is keeping the base characteristics in the left most column of the cards, but adding two binds as columns to the right. One bin would be titled `class` and the other `object`. The user could drag and drop the items from one bin to the other. 


### Note


Claude doesn't think that it's a good idea to implement this for characteristics. It only thinks that the feature should be made for views. 


### New idea

> [!danger] The rename is a bad idea
> It actually doesn't even fix the problem I wanted it to fix so it's useless. 



Instead of having a base characteristic called `views`, I suggest the implementation of two base characteristics: `dviews` and `class dviews`. If a view is given in `dviews` then the instances of this class will have that view in the `views` field; similarly, if a view is given in `class dviews`, then any sub type of that class will have that view in the `views` field. 

The point of this is double: I want to avoid classes containing views that are only meant for their instances, and I want to be able to give special views to classes that won't appear in anything instantiating that class. 


