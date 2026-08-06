| Prompt | Test string | Query | Top 1 | Top 2 | Top 3 | Verdict |
|:--------------|:----------------------------------------|:-------|:----------|:----------|:----------|:---------|
| **P6-A paren-succ** | `x(ab x(cd` | `x`&nbsp;\@5 | `(`&nbsp;\@1 · 0.48 | `x`&nbsp;\@0 · 0.18 | `b`&nbsp;\@3 · 0.16 | induction |
| **P6-B letter-succ** | `xzab xzcd` | `x`&nbsp;\@5 | `x`&nbsp;\@0 · 0.57 | `z`&nbsp;\@1 · 0.24 | `␣`&nbsp;\@4 · 0.06 | sink |
| **P7-A unmatched** | `So (the cat naps` | `s`&nbsp;\@15 | `(`&nbsp;\@3 · 0.40 | `␣`&nbsp;\@7 · 0.09 | `␣`&nbsp;\@11 · 0.08 | other |
| **P7-B matched** | `So (the cat) naps` | `s`&nbsp;\@16 | `)`&nbsp;\@11 · 0.39 | `(`&nbsp;\@3 · 0.18 | `S`&nbsp;\@0 · 0.06 | other |
| **C8 open-vs-closed** | `A (B (C) D` | `D`&nbsp;\@9 | `␣`&nbsp;\@8 · 0.26 | `(`&nbsp;\@5 · 0.12 | `)`&nbsp;\@7 · 0.11 | previous-token |

: The parenthesis tests, read the same way. {#tbl-paren}

