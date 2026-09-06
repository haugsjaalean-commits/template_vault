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
created: 2026-08-21 13:48
ext links:
related:
note rating:
rating:
evolution:
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
difficulty:
payoff:
activity: sleeping
goal type:
  - "[[Project]]"
---


I want to have the option to have folder-like sidebars. Currently, there are only two sidebars, but I want to be able to have the option to have expandable sidebars, which would be opened in a new window. These sidebars would be customizable in the settings and they could be in the toolbar or in the sidebars. Each new sidebars also has a section pointing to new sidebars. 

## Better explanation

Each **sidebar tab** will be configured in the settings with a symbol, and potentially also a hotkey. They will appear in the toolbar. 

We will call these special views or panels **panel groups** or PGs. When PGs are opened from the toolbar, they are opened in a new window. When they are given a window in one of the sidebars or the main window, they will simply display what's inside of them. 

PGs are simply contained panels in which we can put notes and views into any configuration we want. Each PG also has a configurable toolbar and two sidebars. 

## New thoughts on the issue

Each panel group will act like a side-bar. That is to say that it will be automatically *syncing* with the active file in the main window. The main reason for creating this would be to allow me to have other windows in Obsidian that are still properly syncing with the main window. Obsidian does allow for the creation of multiple windows, but it is practically useless because it doesn't sync with the active file. One can link specific files together, but, once again, this is practically useless. For me, the whole point of Obsidian is that I am constantly moving around from one file to the next, so the idea that the sync doesn't follow this constant flow is completely outrageous. 

When first conceiving of Panel Groups, I wrote about some quite complexe implementation features. Revisiting the idea now, I believe that the most important behavior is simply the automatic side-bar-like syncing described above. 

I can imagine a system where Panel Groups allows me to have multiple parallel workflows. This would mean that there could be multiple *focal points* at a time. Focal point being the active note. I could theoretically have a chain of linked views. One window could affect another could affect another. This is an interesting thing to muse about, but I'm not sure that it would be worth making. It would probably only further complicate things. I would need to have a real good reason to want to create something like this. 

I think that the best, simplest and most elegant way of thinking about Panel Groups is as detachable side-bars. The only thing I would change about them is that they would be indefinitely embeddable. I could put a Panel Group in a Panel Group in a side-bar. Also, I would like to allow for the ability to create split tabs in Panel Groups, which isn't something that side-bars can do. Side-bars can be split vertically but not horizonatlly.  

