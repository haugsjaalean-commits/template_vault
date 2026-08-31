---
is a:
  - "[[Obsidian Plugin]]"
characteristics:
type of:
created: 2026-08-16 16:42
ext links:
related:
note rating:
rating:
evolution:
garden:
life stage:
active priority:
difficulty:
payoff:
activity: active
checkpoint:
journey:
---
## Issues
### Complexe issues

[[Classe Manager coding logic]]
[[Ideas for taking the Classes plugin further]]
[[Doubts for the system]]
[[Dad's thoughts on the system]]
[[old issues]]
[[Over all thoughts on the plugin and its meaning]]
[[Classes plugin UI]]
[[two types in inheritance]]


### Simple issues

- [x] Remove automatically any redundant `is a` statements on update. (in other words, they should count as discrepancies)
- [x] I want the option to apply a given class to the active note. In order to avoid mistakes, this should also bring up a *yes/no* pop-up. 
- [x] There needs to be better trash collection: currently, unused characteristics are deleted, but this doesn't seem to be the case for templates or bases.

## Thoughts on the plugin 

The goal of this plugin was to streamline OOF 0.1. The goal was to create a plugin which was able to automatically manipulate my notes in order to create faux classes. Creating faux classes is something I've been dreaming of for a long time now. It solves a great deal of problems for me. 

As I talk about in [[Working through thoughts on Class Manager]], I think it's important to think deeply about what we are doing with a plugin like this, and - beyond the plugin itself - what are we doing with the method. That is what I will try to dig into here without going on for too long.

The goal of this plugin and the system as a whole is to create a way to make more powerful queries and more easily manage metadata. The main purpose was to have powerful base queries without loosing the rhizomatic flexibility of links; the need for easy metadata management simply followed suite. 

Wanting to create more powerful and more flexible connexions is all well and good, but what does that even mean? Well, for me it means achieving a rhizomatic shape - one not tied to any given structure, and one that can be given new "structure" at any time. 

Thinking about this system through the lens of Rhizomeur, I see that there is no right or wrong answer. The fact of the matter is that, in Obsidian, we are limited to a certain number of options. We are essentially limited to unidirectional links, markdown files, and bases. These are quite powerful tools, but we cannot do everything with them. Given this these limited options, we are simply trying to get as close as possible to what could be considered *ideal organization*. The way we do this is by setting as few traps for ourselves as possible. What I mean by this is that we mustn't get distracted by seemingly easy and efficient methods of organizing things which will in fact only lead to dead ends once we want to create more complexe relationships. Since Obsidian is not Rhizomeur, we will be forced into a corner at some point no matter what, but the goal is to give ourselves as many options as possible. To me, this is the purpose of creating a system of objects and classes. Having classes is simply the way in which we allow ourselves to describe twi specific types of relationships: `is a` and `type of`. These two relationships alone allow us to describe many things and create many interesting and even automated connexions. At some point, I may find myself needing to further generalize the system for more connexion types such as `has a`, but, for the moment, the current system works just fine. 

If our goal is to model objects just using `.md` files and markdown links, then we actually have a few ways to go about it. My chosen method is heavily file and link oriented, but I can also imagine a more database oriented approach. I like the simplicity and the directness of the files themselves simply linking to their attributes/parents/whatever. It is very logical and readable, even without a fancy plugin. That's the whole point of Obsidian in the end. 

I think that these thoughts can be improved upon, but this is currently where I stand when it comes to creating new methods for organizing things in Obsidian. 




