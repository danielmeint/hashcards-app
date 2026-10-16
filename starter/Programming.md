---
tags = ["programming"]
---

Tags: python
Q: What does this print?

```python
def add(item, items=[]):
    items.append(item)
    return items

add(1)
print(add(2))
```

A: `[1, 2]`
Extra: A default argument is evaluated **once**, when the function is defined, so every call shares one list. Write `items=None` and create the list inside.

---

Tags: javascript
Q: What does this evaluate to?

```js
[10, 9, 1].sort()
```

A: `[1, 10, 9]`
Extra: Without a compare function, `sort` compares elements as **strings**. For numbers, use `.sort((a, b) => a - b)`.

---

Q: Why is `0.1 + 0.2 === 0.3` false in JavaScript?
A: Floating-point rounding: `0.1 + 0.2` is `0.30000000000000004`.
Extra: Neither 0.1 nor 0.2 has an exact binary representation. Python, Java and C behave the same way.

---

Tags: git
Q: How do you undo your last commit but keep its changes staged?
A: `git reset --soft HEAD~1`
Extra: `--mixed`, the default, keeps the changes but unstages them. `--hard` throws them away.

---

Tags: http
Q: What do the HTTP status code classes mean?
A:

| Class | Meaning |
|---|---|
| 1xx | Informational |
| 2xx | Success |
| 3xx | Redirection |
| 4xx | Client error |
| 5xx | Server error |

---

Tags: sql
Q: SQL: what is the difference between `WHERE` and `HAVING`?
A: `WHERE` filters **rows** before grouping. `HAVING` filters **groups** after `GROUP BY`.

---

Tags: algorithms
C: Binary search on a sorted array takes [$O(\log n)$] time.
Extra: Each comparison halves the part of the array still to search.

---

Status: draft
Tags: http
C: HTTP status code [418] is "I'm a teapot", from an April Fools' RFC of 1998.
