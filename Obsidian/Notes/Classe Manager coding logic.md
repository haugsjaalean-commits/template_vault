---
is a:
characteristics:
type of:
created: 2026-08-17 19:37
ext links:
related:
note rating:
rating:
garden:
life stage:
maturity:
---


[[Handling properties]]
[[Root Note]]


---

## Rebulid

I want to once again rework the logic for the classes. I previously explained a system of "pictures", in which we create replica code objects based on the `.md` files (in the `Notes`, `Templates`, or `Characteristics` folder). This system is good, but I want to further improve upon it for better results. 

I am imagining a system which works in three steps:
1. **Create picture:** Based on the `.md` files, we create code proxies for the objects (notes). 
2. **Handle discrepancies:** There will occasionally be discrepancies in the way the notes are written/set up; in this case, we need to solve them.
3. **Update classes**: Once the picture has been created and the discrepancies have been handled, we may want to create new classes or edit the preexisting ones. In order to do this, we will need to edit many files automatically. 


### Creating Pictures

The picture is something that looks at the `.md` files in the vault and decides how to map them to code objects. All notes are objects, even if they are note a class. 

Pictures will be created every time one of the `.md` files changes (only if the file is in one of these folders: `Notes`, `Templates`, or `Characteristics`). 

The picture is the thing that we see in the side bar, except we only see the classes and not the notes. 

### Handling Discrepancies

Sometimes, once we have created the *picture* of our object, we will have discrepancies in the syntax or disagreements between notes. These discrepancies will be a part of the picture. In these cases, there will be two types of discrepancies:
1. **Solvable:** These irregularities can be sorted out by the program. 
2. **Insolvable:** These cannot be solved without user intervention. 

Both of these should be listed under an orange caution symbol in the panel. 

### Updating Classes

While I can imagine multiple ways of updating classes, I think that the best way would be to reuse the mechanisms that I already described above. When updating a class, we simply first edit the files a first time with the changes we want to make, and then allow the *discrepancy handler* solve the solvable discrepancies created. 

Updating should only be possible once all discrepancies have been solved. 




## Improvements



- [x] The picture does not seem to register inconsistencies in the template files. This means that I can add whatever field I want in the frontmatter and the plugin won't complain. This needs to be fixed. 

