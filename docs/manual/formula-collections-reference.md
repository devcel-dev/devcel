# Collection functions and temporary tables

[Manual](README.md) / [Reward calculation tutorial](formula-collections.md) / [Function reference](formula-reference.md)

To count expensive rewards, group rewards by enemy, or use prices from another table, select the rows you need, transform them, and summarize the result. This page explains each function's inputs and outputs through small examples. To try these with tables in Studio, start with the illustrated [reward calculation tutorial](formula-collections.md).

## Choose a function

| Goal | Function | Example |
| --- | --- | --- |
| Read table rows | `TABLE` | [Read source rows](#table) |
| Calculate an amount for each row | `MAP` | [Multiply quantity by price](#map) |
| Keep rows matching a condition | `FILTER` | [Select prices of at least 30](#filter) |
| Produce a total, count, or string | `REDUCE` | [Combine into one result](#reduce) |
| Group by enemy or another key | `GROUPBY` | [Summarize each enemy](#groupby) |
| Combine two tables | `JOIN`, `SAME` | [Find missing prices](#join) |
| Calculate a series of stages | `SEQUENCE` | [Points for levels 1–3](#sequence) |
| Name an intermediate result | `LET` | [Break up a calculation](#let) |
| Define a local recursive function | `LETREC` | [Calculate a factorial](#letrec) |

## A temporary table is an intermediate result

Selecting drops whose price is at least 30 gives these stages:

| Stage | Value inside the formula |
| --- | --- |
| Read the source | `TABLE("Drops")` → all eligible Drops rows |
| Select rows | `FILTER(..., reward => reward.price >= 30)` → matching rows |
| Calculate amounts | `MAP(..., reward => reward.price * reward.quantity)` → `[30,90]` |
| Add the amounts | `REDUCE(..., 0, (total,amount) => total+amount)` → `120` |

A group of values is a **collection**. A collection of rows can act as a **temporary table**. Filtering and transformation happen inside the formula and leave the source rows unchanged.

A temporary table exists only during evaluation. To put a result in a cell, finish with one value such as a total, count, or string. To show results on several rows, create a result table and enter a formula on each row, as in [Totals by enemy](formula-collections.md#3-calculate-rewards-for-each-enemy).

“Intermediate results” below explain what happens inside a formula. Code beginning with `=` is a complete cell formula. Try numeric examples in an I32 column and text examples in a String column.

## Shared syntax

### Lists and records

`[10,20,30]` is a list of three values; `[]` is an empty list. `{price:10, quantity:2}` is a **record**, a set of named values. Read a field with a name such as `row.price`.

```text
=REDUCE([{price:10,quantity:2},{price:30,quantity:1}], 0,
        (total,row) => total + row.price * row.quantity)
```

The result is **50**. Small literal datasets let you try a formula before creating a table.

### Describe what to do with each row

`reward => reward.price * reward.quantity` names the incoming row `reward` and calculates its amount. This is a **lambda expression**. Unicode names are supported as well.

- `MAP`, `FILTER`: `row => expression` or `(row,index) => expression`
- `REDUCE`: `(result,row) => expression` or `(result,row,index) => expression`
- `GROUPBY`: `row => key`
- `JOIN`: `(leftRow,rightRow) => condition`

The optional index is **0** for the first input element, **1** for the second, and so on. It is an index in the current collection. After filtering, a following `MAP` counts from the start of the filtered list.

Names are case-insensitive. Duplicate names that differ only in case within one parameter list or record are errors. Lambdas can read outer values and columns of the formula's current row. A lambda parameter takes precedence over a same-named column. Backticks explicitly refer to the current row's column.

For example, when the current row's `x` column is 10, this returns **23**:

```text
=REDUCE(MAP([1,2], x => x + `x`), 0, (total,value) => total+value)
```

## TABLE

**Syntax:** `TABLE(table)`

The following examples use the tutorial's three-row `Drops` table:

| enemy (String) | item (String) | price (I32) | quantity (I32) |
| --- | --- | ---: | ---: |
| Slime | Jelly | 10 | 2 |
| Slime | Herb | 30 | 1 |
| Goblin | Iron | 30 | 3 |

```text
=REDUCE(TABLE("Drops"), 0, (total,reward) => total+reward.price*reward.quantity)
```

The result is **140**. `TABLE("Drops")` reads a table in the same project. It also accepts a table UUID string or a TableRef value.

Rows eligible for the selected content version appear in their stored order. Screen search, sorting, and output-row selection do not change the collection. Use `FILTER` for formula-specific conditions.

A row's columns are evaluated when read. Columns excluded from the output can still supply calculation inputs. You can read the current table and summarize other columns, but reading the cell currently being calculated causes a circular-reference error.

## MAP

**Syntax:** `MAP(collection, element => calculation)`

`MAP` produces one new value per input element, preserving count and order.

```text
=REDUCE(MAP(TABLE("Drops"), reward => reward.price*reward.quantity),
        0, (total,amount) => total+amount)
```

| Source row | Amount produced by MAP |
| --- | ---: |
| Jelly: 10 × 2 | 20 |
| Herb: 30 × 1 | 30 |
| Iron: 30 × 3 | 90 |

The intermediate list is `[20,30,90]` and the cell result is **140**. Separating transformation from summation makes it easier to add a condition between them.

You can also create temporary records containing the fields you need:

```text
=LET(amounts,
  MAP(TABLE("Drops"), reward => {item:reward.item, amount:reward.price*reward.quantity}),
  REDUCE(FILTER(amounts, row => row.amount >= 30), 0, (total,row) => total+row.amount))
```

| Temporary record's item | amount |
| --- | ---: |
| Jelly | 20 |
| Herb | 30 |
| Iron | 90 |

Filtering for amounts of at least 30 keeps Herb and Iron, so the result is **120**. [LET](#let) names the intermediate collection.

## FILTER

**Syntax:** `FILTER(collection, element => condition)`

`FILTER` retains matching elements with their contents and relative order intact.

```text
=REDUCE(FILTER(TABLE("Drops"), reward => reward.price >= 30),
        0, (count,reward) => count+1)
```

| Retained item | price | quantity |
| --- | ---: | ---: |
| Herb | 30 | 1 |
| Iron | 30 | 3 |

The result is **2 rows**. To count item quantities instead, change the final expression to `count+reward.quantity`; the result becomes **4**.

Combine conditions with `&&` (both) or `||` (either):

```text
=REDUCE(FILTER(TABLE("Drops"), reward => SAME(reward.enemy,"Slime") && reward.price >= 30),
        0, (total,reward) => total+reward.price*reward.quantity)
```

Only Herb is a Slime drop priced at least 30, so this returns **30**. No matches produce an empty list, for which this formula returns the starting total, **0**.

## REDUCE

**Syntax:** `REDUCE(collection, initial, (result,element) => nextResult)`

Process elements from first to last, passing each result into the next calculation. Summing `[20,30,90]` from zero gives `0 → 20 → 50 → 140`.

| Purpose | Complete formula | Result |
| --- | --- | --- |
| Sum | `=REDUCE([20,30,90],0,(total,value)=>total+value)` | 140 |
| Count | `=REDUCE([20,30,90],0,(count,value)=>count+1)` | 3 |
| Product | `=REDUCE([2,3,4],1,(product,value)=>product*value)` | 24 |
| Empty list | `=REDUCE([],100,(total,value)=>total+value)` | 100 |

The initial value starts the calculation and is also the answer for an empty input. Start a product with `1` or text concatenation with `""`.

```text
=REDUCE(["Jelly","Herb","Iron"], "",
        (list,name,index) => CONCAT(list, index=0?"":" / ", name))
```

A String column displays **Jelly / Herb / Iron**. Omitting the separator at index zero avoids a leading slash.

### Calculate a total and count together

The running result can be a record with several fields:

```text
=LET(summary,
  REDUCE(TABLE("Drops"), {total:0,count:0},
    (previous,row) => {total:previous.total+row.price*row.quantity,count:previous.count+1}),
  CONCAT("Total ",summary.total," / Count ",summary.count))
```

The result is **Total 140 / Count 3**. Keep the running result's type and record structure compatible with the initial value. Starting with a number and later returning text, or adding/removing record fields, causes an error. Collections and functions cannot be initial values.

## GROUPBY

**Syntax:** `GROUPBY(collection, element => key)`

`GROUPBY` collects rows with matching keys. Group drops by enemy with:

```text
GROUPBY(TABLE("Drops"), reward => reward.enemy)
```

| Group key | Original rows in the group's rows field |
| --- | --- |
| Slime | Jelly and Herb |
| Goblin | Iron |

Each group is `{key:keyValue, rows:originalRows}`. Apply `REDUCE` to `rows` to calculate a total for each enemy:

```text
=REDUCE(GROUPBY(TABLE("Drops"), reward => reward.enemy), "",
  (list,group,index) => CONCAT(list,index=0?"":" / ",group.key,": ",
    REDUCE(group.rows,0,(total,reward)=>total+reward.price*reward.quantity)))
```

The String result is **Slime: 50 / Goblin: 90**. Enemy types come from the source data, so the formula needs no fixed list of names.

Groups appear in order of each key's first occurrence; rows within a group keep input order. Key comparison follows `SAME`. Keys must have compatible types within one grouping: mixing string keys and numeric keys is an error.

## JOIN

**Syntax:** `JOIN(leftCollection, rightCollection, (leftRow,rightRow) => condition, "INNER" or "LEFT")`

Inputs are collections of table rows or records. Each resulting pair has `left` and `right` fields. For example, `pair.left.quantity` reads an original row's quantity.

These examples include a Gem with no price:

| Left: item | quantity |
| --- | ---: |
| Jelly | 2 |
| Gem | 1 |

| Right: item | price |
| --- | ---: |
| Jelly | 10 |
| Herb | 30 |

### INNER: keep matching pairs

```text
=REDUCE(JOIN(
  [{item:"Jelly",quantity:2},{item:"Gem",quantity:1}],
  [{item:"Jelly",price:10},{item:"Herb",price:30}],
  (reward,product)=>SAME(reward.item,product.item),"INNER"),
  0,(total,pair)=>total+pair.left.quantity*pair.right.price)
```

Jelly is the only match, so the result is **20**. Gem has no matching right row; Herb has no matching left row.

### LEFT: keep items with missing prices

`"LEFT"` also keeps left rows without a matching right row.

| pair.left.item | pair.right | `HASROW(pair.right)` |
| --- | --- | --- |
| Jelly | Jelly price row | true |
| Gem | Missing row | false |

```text
=REDUCE(JOIN(
  [{item:"Jelly",quantity:2},{item:"Gem",quantity:1}],
  [{item:"Jelly",price:10},{item:"Herb",price:30}],
  (reward,product)=>SAME(reward.item,product.item),"LEFT"),
  "",(list,pair,index)=>CONCAT(list,index=0?"":" / ",pair.left.item,": ",
    HASROW(pair.right)?CONCAT(pair.left.quantity*pair.right.price):"Missing price"))
```

The String result is **Jelly: 20 / Gem: Missing price**. To use real tables, replace the literal lists with `TABLE("RewardDrops")` and `TABLE("Items")`; see the [join tutorial](formula-collections.md#4-combine-prices-with-drops).

`HASROW(row)` returns true for a row and false for a left join's missing row. Check it before reading fields such as `price`: reading a missing row directly is an error. A missing row differs from an empty cell or a valid row with price zero. The `condition ? yes : no` expression evaluates only its selected branch.

### Multiple matches

`JOIN` returns every matching pair. Two left rows and three right rows with the same key produce **six pairs**. Duplicate prices can therefore inflate a total. Pairs appear in left input order, then right input order within each left row.

- `INNER`: an empty input on either side produces an empty result.
- `LEFT`: an empty left input produces an empty result. An empty right input gives each left row a missing `right`.
- `LOOKUP` is for exactly one match; zero or multiple matches are errors. Use `JOIN` when multiple pairs are intended.

### SAME: compare keys

**Syntax:** `SAME(value1, value2)`

`SAME` compares names or identifiers with their types taken into account.

| Comparison | Result | Reason |
| --- | --- | --- |
| `SAME("010",10)` | false | Text and numbers differ |
| `SAME("Jelly","jelly")` | false | Text comparison is case-sensitive |
| `SAME("Jelly","Jelly ")` | false | Trailing spaces matter |
| `SAME(1,1.0)` | true | Numerically equal |

Ordinary `"010"=10` returns true. Prefer `SAME` when text IDs should remain distinct from numbers. Large integers are compared without rounding them to floating point.

Reference and TableRef values use UUID identity. Empty or invalid references have no valid identity and cause errors as `SAME` or `GROUPBY` keys. Colors compare all RGBA components within the same color type; Color32 and ColorFloat differ, as do colors and strings. ColorFloat positive and negative zero are the same key.

## SEQUENCE

**Syntax:** `SEQUENCE(count)`

`SEQUENCE(3)` creates `[1,2,3]`. If levels 1–3 each need `level × 100` points, calculate their total with:

```text
=REDUCE(MAP(SEQUENCE(3), level => level*100),0,(total,required)=>total+required)
```

The intermediate result is `[100,200,300]`; the total is **600**. Sequence values start at one, while optional lambda indexes start at zero.

The count must be a nonnegative integer within the collection limit. Zero creates an empty list. Transform the sequence with `MAP` to choose another start or step:

```text
=REDUCE(MAP(SEQUENCE(3), number => 10+(number-1)*5),0,(total,value)=>total+value)
```

This sums `[10,15,20]` and returns **45**. `SEQUENCE` itself takes only the count argument.

## LET

**Syntax:** `LET(name, value, calculationUsingName)`

Give an intermediate value a meaningful name to make a long formula easier to read:

```text
=LET(expensiveRewards,FILTER(TABLE("Drops"),reward=>reward.price>=30),
  REDUCE(expensiveRewards,0,(total,reward)=>total+reward.price*reward.quantity))
```

`expensiveRewards` holds the Herb and Iron rows; the result is **120**. Write the name without quotes and use it in the final calculation. The binding changes no source data.

Nest `LET` expressions to introduce several names:

```text
=LET(multiplier,2,LET(original,[10,20,30],
  REDUCE(MAP(original,value=>value*multiplier),0,(total,value)=>total+value)))
```

The result is **120**. Inner expressions can read outer names such as `multiplier`.

## LETREC

Use `MAP` to repeat a calculation for each element, or `REDUCE` to carry a running result. When a local function needs to call itself, define it with `LETREC`.

**Syntax:** `LETREC(functionName, parameter => expression, calculationUsingFunction)`

```text
=LETREC(factorial,n=>n<=1?1:n*factorial(n-1),factorial(5))
```

The result is **120** (`5 × 4 × 3 × 2 × 1`). `n<=1` is the stopping condition. Unbounded or overly deep recursion fails at an evaluation limit. One `LETREC` defines one function; simultaneous mutually recursive definitions are unsupported.

`IF`, `? :`, `&&`, and `||` evaluate only the needed branch. Here, reaching `n<=1` prevents another call to `factorial(n-1)`.

## Types, empty collections, and errors

### Keep element types compatible

- `[10,20,30]` has compatible numeric elements. `[10,"20"]` mixes numbers and strings and is an error.
- Records must agree in field names, field order, and field types. Returning different record shapes from different branches of `MAP` is an error.
- A collection cannot directly contain another collection as an element. Record fields can contain collections, as with `GROUPBY`'s `rows` field.
- Color32 and ColorFloat are distinct types. Use [color functions](colors.md) to align precision before combining them in a collection or running result.

### Empty collections are valid

| Function | Empty-input result |
| --- | --- |
| `MAP`, `FILTER`, `GROUPBY` | Empty collection |
| `REDUCE` | Initial value |
| `SEQUENCE(0)` | Empty collection |

Zero matches are a valid result. A nonexistent field or failure in an element fails the entire formula; successfully processed elements do not become a partial answer.

### Large calculations and diagnostics

Defaults allow up to 100,000 elements in one collection and 2,000,000 steps per cell evaluation. Nested calculations, dependent cells, and recursion share those budgets. A join can hit its limit while testing pairs even if it produces few matches. Filtering inputs before joining reduces the work.

Exceeding a limit produces an error. Memory and expression depth also have limits. Screen calculations can be stopped with **Cancel**.

Diagnostic indexes start at zero: index 2 means the third element. Join diagnostics identify both left and right indexes. Check the expression, referenced table, and column, then see [Formula troubleshooting](formulas.md#7-troubleshoot-a-formula).

The [evaluation limits and SDK details](formula-collections-limits.md) specify exact budgets, evaluation boundaries, and diagnostic positions.
