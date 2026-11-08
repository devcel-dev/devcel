# Formula and function reference

[Manual](README.md) / [Formula tutorial](formulas.md) / [Data types](data-types.md)

This reference lists functions accepted by Devcel's formula engine. Collection functions have a separate [detailed reference](formula-collections-reference.md).

## Function index

| Category | Functions | Purpose |
| --- | --- | --- |
| Numeric aggregation | [SUM](#sum), [AVG / AVERAGE](#avg), [MIN / MAX](#min-max) | Sum, average, minimum, maximum |
| Counting | [COUNT](#count) | Count supplied arguments |
| Numbers | [ABS](#abs), [ROUND](#round), [TRUNC / FLOOR / CEIL](#trunc-floor-ceil) | Absolute value and rounding |
| Curves | [CURVE](#curve) | Sample a curve over an input range |
| Colors | [COLOR32 / COLORFLOAT](#color) | Construct typed RGBA values and read channels |
| Color precision | [COLOR_TO_FLOAT / COLOR_TO_BYTE](#color-precision) | Normalize or quantize channels |
| Color transfer | [SRGB_TO_LINEAR / LINEAR_TO_SRGB / GAMMA_DECODE / GAMMA_ENCODE](#color-transfer) | Explicit RGB transfer functions |
| Color adjustments | [EXPOSURE / LERP_COLOR / CLAMP_COLOR](#color-edit) | Exposure, interpolation, clamping |
| Text | [CONCAT](#concat), [LEN / LENGTH](#len), [UPPER / LOWER](#upper-lower) | Join, count Unicode scalars, change case |
| Conditions | [IF](#if) | Choose a branch |
| Table queries | [LOOKUP](#lookup), [COUNTIF](#countif), [SUMIF](#sumif) | Find a unique row or aggregate exact matches |
| Collections | [MAP / FILTER / REDUCE / SEQUENCE](formula-collections-reference.md#shared-syntax) | Transform, select, and summarize values |
| Temporary tables | [TABLE](formula-collections-reference.md#table), [JOIN / HASROW / SAME](formula-collections-reference.md#join), [GROUPBY](formula-collections-reference.md#groupby) | Read, combine, and group rows |
| Local definitions | [LET](formula-collections-reference.md#let), [LETREC](formula-collections-reference.md#letrec) | Name values and recursive functions |

Function names are case-insensitive.

## Shared rules for basic functions

### Syntax and arguments

- Start cell formulas and default formulas with `=`, as in `=SUM(1, 2)`.
- Arguments are expressions: constants, column references, arithmetic, or other calls.
- Use ASCII commas, parentheses, and double quotes. Double a quote inside text as `""`. Single-quoted strings, backslash escapes, and formula comments are unsupported.
- An empty argument such as `SUM(1,,3)` or `IF(1,2,)` is a syntax error. Write `""` for an empty string.
- `COUNT()` and `CONCAT()` accept no arguments. Other basic functions require arguments.
- `ROUND` digits, color-constructor alpha, and the `CLAMP_COLOR` range are optional.
- Basic functions other than `IF` evaluate all arguments before running; argument errors propagate even if the resulting value would be ignored.
- Use comparisons, Boolean columns, `1`/`0`, or quoted text for conditions. Bare `true` and `false` are case-insensitive Boolean literals when not shadowed by a local binding or matching column. `TRUE()`/`FALSE()` and `NULL` have no special syntax.

### Values and types

The destination column validates the final result. `AVG(1, 2)` evaluates to `1.5`; an I32 destination rounds it to `2`. Use F64 to preserve decimals and String for text in the examples below.

- Integer literals and operations use checked 128-bit integer intermediates.
- Decimal and exponent values use finite 64-bit floating point. Mixing in a large integer that cannot be represented exactly causes a type error.
- NaN, infinity, and overflow are invalid numeric values. `="NaN"` is ordinary text in a String column, but interpreting it numerically, as in `SUM("NaN")`, fails.
- Numeric strings participate in arithmetic. `"20"` is numeric; empty text and `"abc"` are not. Surrounding whitespace is not trimmed.
- Ordinary column references resolve data names and display names in the current row case-insensitively. Ambiguity is an error. They do not use the query functions' UUID-first resolution.
- Cell references use the effective input: local input, inherited parent input, or column default. Inheritance without a parent uses the column default. With an empty column default, numbers supply `0`, Boolean supplies `false`, colors supply opaque white, Curve supplies its configured default curve, and other types supply empty text. None always supplies empty text. A String formula returning empty text retains its empty result. Empty raw input restores inheritance. See [Cell inputs](metadata-and-inheritance.md#choose-where-a-cell-gets-its-value).
- Number-to-text conversion does not pad decimal places: `ROUND(1.2, 2)` is `1.2`, not `1.20`.

### Operators

| Precedence, highest first | Syntax | Behavior |
| --- | --- | --- |
| Parentheses | `(expression)` | Evaluate inside first |
| Unary | `+value`, `-value`, `!value` | Numeric sign or truth inversion |
| Multiply/divide | `*`, `/` | Numeric operations; division by zero fails |
| Add/subtract | `+`, `-` | + adds numeric operands, otherwise concatenates; - is numeric |
| Compare | `=`, `==`, `!=`, `<>`, `<`, `>`, `<=`, `>=` | Return true or false |
| Logical AND | `&&` | Skip the right side when the left is false |
| Logical OR | `\|\|` | Skip the right side when the left is true |
| Conditional | `condition ? A : B` | Evaluate only A or B |

Conditional expressions associate right: `a ? b : c ? d : e` means `a ? b : (c ? d : e)`. Other operators of equal precedence associate left: `=10-3-2` is `5`; `=12/3/2` is `2`.

Comparisons are numeric when both sides can be read as numbers, otherwise lexicographic text comparisons that preserve case and spaces. `="010"=10` is true. Express a range as `price >= 0 && price <= 100` rather than chaining comparisons.

### Reference paths and interpolation

`equipment.attack` follows a Reference column to its target row. Paths can continue through further references, as in `equipment.category.multiplier`, and end in Curve or color columns. `equipment.color.r` reads a color channel. Tables are loaded on demand within the project. Rows are identified by UUID; display labels are not row keys. Each path segment uses case-insensitive data/display-name resolution.

A column matching the complete expression takes precedence even if its name contains dots. Backticks make path boundaries explicit. See [Reference paths and short expressions](formulas.md#reference-paths-and-short-expressions).

In `"Attack: ${attack}"`, `${...}` is evaluated. Write `$${` for literal `${` and `""` for embedded quotes. Interpolated text is not reinterpreted as another formula.

`?:`, `&&`, `||`, and `!` share `IF` truth rules. Unselected branches do not execute reference resolution, function calls, or division. The parser still checks delimiters and top-level syntax.

A reference target row missing from the selected content version is an error. Columns omitted from output may remain calculation dependencies. Reference cells resolve their effective input; following an empty Reference fails. The `??` operator is unsupported.

<a id="color"></a>
## Typed colors and channels

Color32 stores integer RGBA channels from 0 to 255. ColorFloat stores finite f32 channels; RGB can be negative or exceed 1 for HDR, while alpha stays within 0–1. Both use straight alpha and retain RGB at zero alpha. Color types have no sRGB, linear, or gamma tag and apply no automatic transfer function on save or reference.

- `COLOR32(r,g,b[,a])`: three or four numeric arguments; default alpha 255. Fractions and out-of-range channels fail.
- `COLORFLOAT(r,g,b[,a])`: default alpha 1. Nonfinite values, f32 overflow, and out-of-range alpha fail.
- `color.r`, `.g`, `.b`, `.a`: return numbers at stored precision. Color32 alpha is 0–255; ColorFloat alpha is 0–1.
- Column references, Reference paths, LOOKUP, TABLE, records, collections, and present optional JOIN rows preserve color types.
- Color32 results require a Color32 destination, and ColorFloat results require ColorFloat. Strings resembling JSON are not implicit color values; colors do not implicitly become strings.
- Equality/inequality and `SAME` compare all RGBA channels within one color type. Different color types or a color and string are unequal. ColorFloat positive and negative zero are equal. Ordering, ordinary arithmetic, CONCAT, and interpolation require channel values instead of whole colors: `CONCAT("R=", color.r)`.

Examples: `=COLOR32(128,64,255)` in Color32, `=COLORFLOAT(-0.5,2,4,0)` in ColorFloat, and `=color.r` in a numeric column.

<a id="color-precision"></a>
## Color precision conversion

- `COLOR_TO_FLOAT(color)` divides Color32 RGBA by 255 and returns ColorFloat. ColorFloat input retains its values. This changes precision, not color space.
- `COLOR_TO_BYTE(color)` multiplies ColorFloat RGBA by 255 and rounds to the nearest integer, with ties upward. Channels outside 0–1 fail; clamping must be explicit. Color32 input retains its values.

| Formula | RGB result | Meaning |
| --- | --- | --- |
| `=COLOR_TO_FLOAT(COLOR32(128,128,128))` | About 0.5019608 | 128/255; an sRGB input remains sRGB-valued |
| `=SRGB_TO_LINEAR(COLOR_TO_FLOAT(COLOR32(128,128,128)))` | About 0.2158605 | Explicit sRGB decoding |
| `=LINEAR_TO_SRGB(COLORFLOAT(0.2158605,0.2158605,0.2158605))` | About 0.5019608 | Explicit sRGB encoding |

<a id="color-transfer"></a>
## RGB transfer functions

These functions return ColorFloat. Color32 inputs are first normalized by 255. Alpha is unchanged by the transfer function, negative RGB retains its sign, and HDR is not clamped. Nonfinite results and f32 overflow fail.

- `SRGB_TO_LINEAR(color)` and `LINEAR_TO_SRGB(color)` use the piecewise sRGB conversion, including the signed extension in [W3C CSS Color 4](https://www.w3.org/TR/css-color-4/#color-conversion-code).
- `GAMMA_DECODE(color,gamma)` raises absolute RGB to gamma, then restores its sign.
- `GAMMA_ENCODE(color,gamma)` raises absolute RGB to `1/gamma`, then restores its sign. Gamma must be finite and positive.

`=GAMMA_DECODE(COLORFLOAT(-2,0.5,4,0.25),2)` returns `[-4,0.25,16,0.25]`.

<a id="color-edit"></a>
## Exposure, interpolation, and clamping

- `EXPOSURE(color,ev)` multiplies RGB by `2^ev`, preserves alpha, and returns ColorFloat.
- `LERP_COLOR(left,right,t)` interpolates RGBA as `left + (right-left)*t`. Inputs must share a color precision type; Color32 is normalized first. The result is ColorFloat. There is no transfer-function conversion or premultiplication. Finite t is not clamped; output alpha outside 0–1 fails.
- `CLAMP_COLOR(color[,min,max])` clamps RGB and returns ColorFloat while preserving alpha. The default range is 0–1. A custom range needs both finite endpoints, with min <= max.

`=COLOR_TO_BYTE(CLAMP_COLOR(COLORFLOAT(-2,0.5,4,0)))` returns `[0,128,255,0]`, explicitly clamping HDR before byte conversion.

## CURVE

`CURVE(current,min,max,curve)`

Convert a value's position within a range into the curve's height. This can model attack by level or a multiplier over time.

For a straight `growth` curve from Y=10 to Y=110, use an F64 result column:

| Formula | Result |
| --- | --- |
| `=CURVE(0,0,100,growth)` | 10 |
| `=CURVE(50,0,100,growth)` | About 60 |
| `=CURVE(100,0,100,growth)` | 110 |
| `=CURVE(150,0,100,growth)` | 110 |

Exactly four arguments are required. The first three can be numbers, references, or expressions. X is `(current-min)/(max-min)`, clamped at the endpoints. Min must be less than max; equal or reversed bounds cause `ArgumentError`.

Evaluation respects the Curve column's endpoint settings and tangent modes. A Curve cell inheriting an empty column default uses the configured default curve. Curve values can come from the current row, `IF`, or `LOOKUP`, and must be valid saved curve JSON. Invalid curves, empty text, nonnumeric inputs, and nonfinite values fail.

Interpolation produces floating point. Use `ROUND(CURVE(...),2)` for rounding. To read a curve from another table:

```text
=CURVE(level,1,100,LOOKUP("Curves","id","hero","growth"))
```

## SUM

`SUM(value1,value2,...)` takes at least one argument and sums numeric values. Nonnumeric and empty strings are skipped; no numeric values yields zero. Zero arguments cause `ArgumentError`. Errors within arguments, including division by zero or nonfinite numbers, propagate.

| Formula | Result |
| --- | --- |
| `=SUM(10,20,30)` | 60 |
| `=SUM(10,"20","x","")` | 30 |
| `=SUM("x")` | 0 |

It aggregates supplied values. Use [SUMIF](#sumif) or collection functions to aggregate rows.

<a id="avg"></a>
## AVG / AVERAGE

`AVG(value1,value2,...)` and `AVERAGE(...)` are aliases. At least one argument is required. Divide the numeric total by the number of numeric arguments; nonnumeric and empty strings are excluded from both. No numeric arguments yields zero.

| Formula | Result |
| --- | --- |
| `=AVG(10,20,30)` | 20 |
| `=AVERAGE(10,"x",20)` | 15 |
| `=AVG("x")` | 0 |
| `=AVG(1,2)` | 1.5 |

An empty numeric column normally supplies zero and therefore counts in the denominator.

<a id="min-max"></a>
## MIN / MAX

`MIN(value1,value2,...)` and `MAX(...)` return the smallest or largest numeric argument. They require at least one argument and at least one numeric value. Nonnumeric and empty strings are skipped. No numeric values causes `ArgumentError`.

| Formula | Result |
| --- | --- |
| `=MIN(5,10,3,8)` | 3 |
| `=MAX(5,10,3,8)` | 10 |
| `=MIN("x",2)` | 2 |
| `=MAX("")` | Error |

## COUNT

`COUNT(value1,value2,...)` counts all arguments, including empty text, nonnumeric text, and Boolean values. Zero arguments is valid. Arguments are evaluated, so `COUNT(1/0)` fails.

| Formula | Result |
| --- | --- |
| `=COUNT(1,"x","")` | 3 |
| `=COUNT()` | 0 |
| `=COUNT(price,quantity)` | 2 |

Use [COUNTIF](#countif) for matching rows.

## ABS

`ABS(value)` accepts exactly one numeric value and returns its absolute value. Empty or nonnumeric values and wrong arity cause `ArgumentError`. An intermediate integer whose absolute value overflows also fails.

`=ABS(-42)` → `42`; `=ABS("x")` → error.

## ROUND

`ROUND(value[,digits])` accepts one or two arguments. Digits must evaluate to a signed 32-bit integer and defaults to zero. Positive digits round decimal places; negative digits round tens, hundreds, and so on. Ties round away from zero.

| Formula | Result |
| --- | --- |
| `=ROUND(3.14159)` | 3 |
| `=ROUND(3.14159,2)` | 3.14 |
| `=ROUND(125,-1)` | 130 |
| `=ROUND(-2.5)` | -3 |
| `=ROUND(1.2,2)` | 1.2 |

Nonnegative digits leave integers unchanged. Very large negative digits round integers to zero. For floating point, a nonfinite scaling factor/result or a zero scaling factor is an error. Decimal-looking halfway values may differ slightly in binary floating point. Rounding does not pad displayed digits.

<a id="trunc-floor-ceil"></a>
## TRUNC / FLOOR / CEIL

Each takes one numeric argument. `TRUNC` rounds toward zero, `FLOOR` downward, and `CEIL` upward. Integer inputs retain their precision. Invalid arity, nonnumeric values, and nonfinite values fail.

| Formula | Result |
| --- | --- |
| `=TRUNC(2.5)` | 2 |
| `=TRUNC(-2.5)` | -2 |
| `=FLOOR(2.5)` | 2 |
| `=FLOOR(-2.5)` | -3 |
| `=CEIL(2.5)` | 3 |
| `=CEIL(-2.5)` | -2 |

Integer destination columns use nearest rounding with ties away from zero, then range-check. For I8, `127.4` becomes `127`, but `127.5` fails. For unsigned integers, `-0.4` becomes zero while `-0.5` fails. See [Result types](formulas.md#choose-the-result-type).

## CONCAT

`CONCAT(value1,value2,...)` evaluates and joins values without an implicit separator. Zero arguments returns empty text. Numbers use their calculated text representation. Supply separators as arguments.

| Formula | Result |
| --- | --- |
| `=CONCAT("Item_",12)` | Item_12 |
| `=CONCAT("12","3")` | 123 |
| `=CONCAT("Hello"," ","World")` | Hello World |
| `=CONCAT()` | Empty string |

<a id="len"></a>
## LEN / LENGTH

These aliases take exactly one argument and count Unicode scalar values in its evaluated string. This differs from UTF-8 bytes and visible grapheme clusters. Numbers are counted after conversion to text.

| Formula | Result |
| --- | --- |
| `=LEN("日本語")` | 3 |
| `=LENGTH("りんご🍎")` | 4 |
| `=LEN("é")` | 2: e plus a combining accent |
| `=LEN("👨‍👩‍👧‍👦")` | 7: includes zero-width joiners |
| `=LEN("")` | 0 |

These multilingual examples intentionally demonstrate Unicode behavior.

<a id="upper-lower"></a>
## UPPER / LOWER

`UPPER(value)` and `LOWER(value)` each take one argument and apply Unicode case conversion. Characters without case remain unchanged. Empty text stays empty; conversion may change the character count.

`=UPPER("hello")` → `HELLO`; `=LOWER("HELLO")` → `hello`.

## IF

`IF(condition,true_value,false_value)` requires three arguments and evaluates only the selected branch. Unselected division, unknown function calls, and circular references do not execute. Parentheses, quotes, and argument syntax must remain valid.

The following evaluated strings are false:

- Empty text
- Exactly `0`
- `false`, ignoring ASCII case

Everything else is true. Whitespace is not trimmed.

| Formula | Result |
| --- | --- |
| `=IF(2>1,"Allowed","Denied")` | Allowed |
| `=IF(1,42,1/0)` | 42 |
| `=IF(0,1/0,42)` | 42 |
| `=IF("FALSE",1,2)` | 2 |
| `=IF("0.0",1,2)` | 1: text 0.0 differs from 0 |
| `=IF(0.0,1,2)` | 2: numeric zero evaluates as 0 |
| `=IF(" false ",1,2)` | 1: spaces remain |

For conditions based on user-facing words or blank fields, express the intended comparison explicitly.

<a id="queries"></a>
## Shared table-query rules

`LOOKUP`, `COUNTIF`, and `SUMIF` search tables in the same project, including other rows in the current table. APIs without a project evaluation context, such as isolated-table evaluation, return `InvalidReference`.

<a id="query-identifiers"></a>
### Table and column identifiers

Table and column arguments evaluate to identifiers. Quote fixed names such as `"Items"`. Resolution searches UUID, then data name, then display name, case-insensitively at each stage. A higher-priority match stops the search; multiple matches at one stage are errors.

Use identifiers rather than file paths, another project's name, or spreadsheet addresses. Closed table tabs can still be queried. Loaded edits take precedence over older disk values.

### Criteria and evaluation scope

- Keys and criteria match evaluated strings exactly, including case, spaces, and numeric spelling. `"120"` and `"0120"` differ. Keep identifier formatting consistent.
- `">10"`, `"*"`, and `"?"` are literal text, not comparisons or wildcards.
- Search cells resolve local, parent, or column-default inputs before comparison. Formulas are evaluated and type-validated in the searched row. An empty column default supplies the type's fallback value described under [Values and types](#values-and-types); a String formula returning empty text remains empty text.
- Errors in referenced calculations propagate. A failing key formula may fail the query even on a row that would not have matched.
- Normal Studio display and edit validation include all content versions. A versioned runtime export includes target rows only when `min_version` is at most the selected version.
- A column's minimum version controls output inclusion; excluded columns can still supply dependencies to retained formulas.
- Cross-table calculations must be acyclic. Syntax, runtime AST, and dependent cells share a safety depth limit of 128. LETREC calls also have a depth limit of 64, plus shared step and memory budgets.

Examples below use:

| id | category | price |
| --- | --- | --- |
| potion | common | 120 |
| ether | common | 300 |
| sword | rare | 500 |

## LOOKUP

`LOOKUP(table,key_column,key,value_column)` requires exactly four arguments. It returns `value_column` from the single row whose key matches exactly. Zero or multiple matches cause `InvalidReference`. A calculated target is validated in its own column and then in the destination column. There is no fifth fallback argument.

| Formula | Result |
| --- | --- |
| `=LOOKUP("Items","id","potion","price")` | 120 |
| `=LOOKUP("Items","id","none","price")` | Error: no match |
| `=LOOKUP("Items","category","common","price")` | Error: multiple matches |

If your intended policy is to return zero for any nonunique match:

```text
=IF(COUNTIF("Items","id",item_id)=1,LOOKUP("Items","id",item_id,"price"),0)
```

When duplicates indicate bad data, fix them rather than hiding them with a fallback.

## COUNTIF

`COUNTIF(table,column,criterion)` takes three arguments and returns the number of exact matches. Zero and multiple matches are normal results.

| Formula | Result |
| --- | --- |
| `=COUNTIF("Items","category","common")` | 2 |
| `=COUNTIF("Items","category","none")` | 0 |
| `=COUNTIF("Items","price",">100")` | 0: literal criterion |
| `=COUNTIF("Items","id","Potion")` | 0: different case |

## SUMIF

`SUMIF(table,criterion_column,criterion,value_column)` takes four arguments and sums the values from exact-match rows. No matches returns zero. Every selected value must be numeric: unlike `SUM`, nonnumeric and empty strings cause an error.

Numeric cells use their selected local, parent, or column-default input; an empty numeric column default supplies zero. A String formula returning empty text selected for summation fails. Overflow, nonfinite values, and referenced formula failures also propagate.

| Formula | Result |
| --- | --- |
| `=SUMIF("Items","category","common","price")` | 420 |
| `=SUMIF("Items","category","none","price")` | 0 |
| `=SUMIF("Items","category","common","id")` | Error: potion and ether are not numbers |

<a id="errors"></a>
## Errors

Failed formulas appear as diagnostics such as `#ERROR: ...` in existing cells or validation failures during editing and export.

| Error | Common cause | What to check |
| --- | --- | --- |
| `ParseError` | Quotes, parentheses, operators, empty arguments, excessive depth | Syntax and column names |
| `TypeError` | Nonnumeric input, incompatible destination, overflow, nonfinite value, inexact integer conversion | Types and ranges |
| `CircularReference` | A dependency returns to the original cell | Make dependencies one-way |
| `InvalidReference` | Missing/ambiguous identifiers, nonunique LOOKUP, out-of-project target | Names, match count, version, source files |
| `DivisionByZero` | Zero denominator | Branch with IF |
| `FunctionNotFound` | Unsupported function | Function index |
| `ArgumentError` | Wrong argument count, invalid ABS input, or no numbers for MIN/MAX | Function contract |

There is no `IFERROR`. Anticipate division by zero or missing matches using `IF`, comparisons, and `COUNTIF`. Errors in the condition or chosen branch still propagate.

Allowing ordinary input-rule violations during runtime export does not turn an unevaluable formula into empty text or zero.

## Implementation references

- [Formula engine](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/formula_engine.rs): grammar, operators, functions, typed evaluation
- [Project formula context](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/formula_context.rs): queries, eligible rows, identifier resolution
- [Types](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/types.rs) and [column validation](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/column.rs): conversion and validation
- [Column-version export tests](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/tests/column_version_export.rs): using excluded columns as dependencies

## Collections, temporary tables, and local recursion

The [reward tutorial](formula-collections.md) introduces calculations with input tables and expected results. The [collection reference](formula-collections-reference.md) covers MAP, FILTER, REDUCE, TABLE, JOIN, GROUPBY, LET, and LETREC in detail.

[Formula tutorial](formulas.md) / [Manual](README.md)
