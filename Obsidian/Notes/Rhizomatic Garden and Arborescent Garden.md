---
is a:
  - "[[Project]]"
characteristics:
type of:
views:
created: 2026-08-30 07:09
ext links:
related:
note rating:
rating:
evolution: Charmander
garden:
life stage: current
dead: true
category:
project:
  - "[[Class Manager]]"
subject:
  - wording and semantics
  - organization
active priority:
difficulty:
payoff:
activity: sleeping
done: true
urgency:
what to do:
checkpoint: mapped
---


Currently, all notes have a `garden` property. This property tracks the interconnectivity of notes. I had the idea of splitting this property into two different ones:
1. `rhizomatic garden` This tracks the level or interconnectivity of the note in the vault. Even if a note is well organized in the vault (meaning that it is easy to find in a few clicks), it may be poorly connected to related subjects. I often find myself writing in many different notes about similar things, but these notes and these thoughts may actually sit very far away from each other in the arborescent search path. This is why it is always important to connect things in a nonlinear way, so as to assure the richness afforded by connection. 
2. `arborescent garden` This tracks the level or organization of the note in the vault. Organization is achieved through tree-like shapes, so if something is hard to find in the tree, then this is a problem. This property tracks how organized the note is. 


The idea of splitting `garden` into two different categories sounds reasonable at first glance, but I do have my doubts. The first thing I have to say relates to Rhizomeur. In Rhizomeur, the organization of notes is completely separate form the creation of notes. Notes are created with their connections, and then the user organizes them by creating search pathways. The notes themselves don't "know" about the layer above them which is ment for organization. While some connections are more likely to directly come into use by the system above, all connections have the potential for queries. Following this logic, it would only really make sense to have one characteristic. However, I do think that there is room for making a counter argument. Even in Rhizomeur, it may be useful to keep track of how findable a note is in the vault. I still don't think that the two characteristics can ever be better than the one. Having two only ever makes sense if I believe that there is value in arbitrarily differentiating connections based on how useful I think they are for finding the note. I don't really believe in the idea of doing this. 

Theoretically, Rhizomeur could implement a coefficient of organization, which would take into account things like how many times the file appears in the tree, how many notes it's crowded out by in its nots, and how close it appears to the center of the graph. But this feature is a part of the higher level or organization. In Obsidian, there is not separation between the levels, so it can be argued that implementing this coefficient directly into each note makes sense, but I have no way of calculating it, so it will only weigh the system down. 



