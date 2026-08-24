---
is a:
  - "[[Issue]]"
characteristics:
type of:
created: 2026-08-21 13:17
ext links:
related:
note rating:
rating:
garden:
life stage: current
maturity:
importance:
activity: sleeping
status: idea
project:
  - "[[Class Manager]]"
subject:
---
Can you add the option to have specific values for specific characteristics for a given object. I suppose this is already possible. The only thing I have to do is edit the template file to add the specific value. For example, I can say that every visual artist has `domain: visual`. This is quite like the characteristics: editing the file type of one of the characteristic files should automatically update all of the notes having this characteristic. This means that certain things will be like these should be based on the files and not the interface. What do you think? May there be a better way of doing this? The only other way of thinking of it is that the ONLY source of truth should be the panel, in which case we will need to add many more options. We would need to add an entire drop down for characteristics which would allow for editing their type, default values and accepted values. Speaking of this, whenever there is a non accepted value on update, there should be a message explaining this. I think that the panel should be the only source of truth - this is much simpler and easier to understand. 

## Newer thoughts


It occurs to me that the program will not complain when I put default values in the template, but it will also no know that they are there. This is a problem, because something else may at some point change the value, or it may have been blank before the default was added. In these cases, the program should alert the user with a discrepancy. This is similar to [[new default values should replace none values (maybe)]], which talks about default described in the characteristics themselves being able to replace `NONE` values. These are similar issues. 

## More thoughts

When something has a `NONE` value, but the characteristic has a default value, then `NONE` is not accepted. It is only accepted when there is no default value. 
