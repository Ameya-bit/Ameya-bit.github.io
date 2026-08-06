| Prompt | Test string | Query | Top 1 | Top 2 | Top 3 | Verdict |
|:--------------|:----------------------------------------|:-------|:----------|:----------|:----------|:---------|
| **P1-A xylophone** | `The man said, "xylophone do I write?". He then spoke, "Grashoper` | `"`&nbsp;\@54 | `x`&nbsp;\@15 · 0.42 | `.`&nbsp;\@37 · 0.13 | `T`&nbsp;\@0 · 0.12 | induction |
| **P1-B what** | `The man said, "what do I write?". He then spoke, "Grashoper` | `"`&nbsp;\@49 | `w`&nbsp;\@15 · 0.67 | `T`&nbsp;\@0 · 0.08 | `.`&nbsp;\@32 · 0.06 | induction |
| **P2-A cat** | `the cat sat on the mat, the cat ran` | `c`&nbsp;\@28 | `a`&nbsp;\@5 · 0.77 | `t`&nbsp;\@6 · 0.06 | `a`&nbsp;\@20 · 0.03 | induction |
| **P2-B dog** | `the dog sat on the mat, the dog ran` | `d`&nbsp;\@28 | `o`&nbsp;\@5 · 0.58 | `g`&nbsp;\@6 · 0.07 | `,`&nbsp;\@22 · 0.06 | induction |
| **P3-A repeat** | `Zarathustra spoke. Later, Zarathustra` | `Z`&nbsp;\@26 | `r`&nbsp;\@2 · 0.14 | `Z`&nbsp;\@0 · 0.09 | `t`&nbsp;\@21 · 0.09 | other |
| **P3-B norepeat** | `the crowd below heard Zarathustra` | `Z`&nbsp;\@22 | `t`&nbsp;\@0 · 0.14 | `h`&nbsp;\@1 · 0.11 | `e`&nbsp;\@2 · 0.11 | sink |
| **P4-A apple-last** | `"apple" ... "banana" ... "apple` | `"`&nbsp;\@25 | `b`&nbsp;\@13 · 0.22 | `"`&nbsp;\@0 · 0.18 | `p`&nbsp;\@2 · 0.09 | induction |
| **P4-B banana-last** | `"banana" ... "apple" ... "banana` | `"`&nbsp;\@25 | `b`&nbsp;\@1 · 0.21 | `"`&nbsp;\@0 · 0.20 | `a`&nbsp;\@14 · 0.11 | induction |
| **P5-A prior-opens** | `He said "one. She said "two. He said "` | `"`&nbsp;\@37 | `t`&nbsp;\@24 · 0.35 | `H`&nbsp;\@0 · 0.18 | `o`&nbsp;\@9 · 0.14 | induction |
| **P5-B prior-closes** | `one" and two" and three" and` | `"`&nbsp;\@23 | `o`&nbsp;\@0 · 0.47 | `␣`&nbsp;\@17 · 0.11 | `␣`&nbsp;\@13 · 0.10 | sink |

: The quote tests. `@N` is a token position and each weight is that token's share of B5H0's attention (softmax over keys). A verdict of *induction* means the top-attended token is the one that followed the query's own earlier occurrence; *sink* means position 0, where attention goes when nothing qualifies. {#tbl-quote}

