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
created: 2026-09-01 06:35
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
active priority: 0
difficulty: 8
payoff: 10
activity: simmering
goal type:
  - "[[Project]]"
---


This is probably a stupid idea, but what if it was possible to imbed a file anywhere? I believe that this could potentially open up some really interesting possibilities which I talk about in [[Using dynamic bases]]. 

What I mean by "imbed anywhere" is that I want to be able to imbed files in frontmatter or even in rows in bases. This may seem a little excessive, but once you start thinking about the possibilities, you can't help but to feel enticed. 

If I had this as an option, I would be able to do things that quite resembled relational databases. Currently, Obsidian only has a base that resembles a NoSQL database (non-relational (because it doesn't use SQL)). Obsidian only allows the user to make queries on one level. As I said, you can achieve the effect of multiple levels by simply moving into the notes themselves through the links, but then we lose the context of the rest of the base. The only way to turn Obsidian bases into something that acts like relational databases is to allow for imbedding. If a note is imbeded (or even better another base relating to that note) inside of another base, then we have functionally achieve relational querying. 


## Implementation 


I can imagine multiple different ways of implementing this. I don't think that it is necessarily a good idea for things to be imbedded in the frontmatter because this would lead to a lot of informational clutter. What does need to be implemented is a way for the base to know that a given file needs to be shown as an imbed. The best way I can think of doing this is by giving the information in the base itself instead of in the individual files. This will lead to more flexibility. What I think is the best idea is to tell the individual columns if they should be displaying files as imbeds or not. If the user right clicks on a column, they already see multiple options for the column, so it seems natural to add the option to display the files linked in the column as imbeds. (This may need to be limited to only properties of type `text` as it doesn't really make sense to imbed a list of files. This would probably cause complications.)


