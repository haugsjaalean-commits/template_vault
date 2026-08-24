---
is a:
  - "[[Issue]]"
characteristics:
type of:
created: 2026-08-24 08:45
ext links:
related:
  - "[[Default values from template]]"
  - "[[new default values should replace none values (maybe)]]"
note rating:
rating:
garden:
life stage: current
maturity: Charmander
importance:
activity: active
status: effort
project:
  - "[[Class Manager]]"
subject:
---

## Legacy idea

If a characteristic has a default value, then NONE is never accepted, and NONE will always be replaced with the default value. 

Templates should function like characteristics. They should be written and then be free to change. If they need to be rewritten, then the changes need to persist (unless the characteristic holding the default value was completely removed from the class, in which case it should be simply removed). A default value written in a template works the same as the default value written in the characteristic, and it will be used by all of the children of that class as well until it is changed by on if its child classes (following the rules of inheritance).

## New idea

Each characteristic should have a table containing three columns:
1. **Default location:** This is the place where the default is used. This is always a class. 
2. **Default value:** This is the value that the note is created with
3. **Strict default value:** If this value is given, then NONE is not accepted, and it will always be replaced by this value. There will be an option in the settings so that this also overrides wrong values and not just blank ones. 

The user can add more rows for different classes. Unless specified later, the children (`type of`) will always take the default values of their parents. If two parents have competing default values, then the child takes the nearest one. 


N.B. The locations will always be links. 

### Example table

| Default location | Default value | Strict default value |
| ---------------- | ------------- | -------------------- |
| All notes        |               |                      |


