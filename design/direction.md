# Design Direction — ameyapanchal.github.io redesign

*Started 2026-07-10 from reverse-engineered analysis of emilkowal.ski, devouringdetails.com, and ma5a.com (actual shipped CSS/JS, not visual guesses). Layer 1 (the Emil base) is **built and approved** as of 2026-07-10; its as-built conventions are below. Next layers at the bottom — build them one at a time, workshopping between each.*

## The governing formula

**Severity buys whimsy.** ma5a's base is *more* minimal than a typical minimal site — one font, one size, two colors, one column. That severity is exactly what gives its bunnies and cursor trail room to read as signature instead of noise. Emil proves the same equation from the other side: a near-monotone system makes his one flourish (serif-italic word emphasis) feel deliberate.

Our design = **Emil-severity base (done) + Rauno minimap TOC + one or two mech-interp-native whimsy elements, fenced by ma5a's rules.**

The whimsy must speak the site's research language (attention, copying, scattering) the way ma5a's bunnies preview an animal-toy portfolio. Decoration that demonstrates competence reads as signature; off-topic decoration reads as clutter.

---

## Layer 1 — The Emil base (BUILT, approved). As-built conventions

All implemented in `styles.scss` + `_quarto.yml` + `index.qmd`. These are the rules every future layer must respect.

### Type
- **Font**: Inter variable (Google Fonts, `opsz 14..32, wght 400..700`), `font-feature-settings: "cv01","ss03"`, ligatures off, antialiased. Mono: system stack (ui-monospace/SF Mono/Menlo). No serif (the Tiempos-style italic flourish remains an open decision).
- **Fully flat scale: 16px for everything** — body, h1–h6, post titles, dates, captions, listing items. Hierarchy = weight only: 400 body / 500 h3+labels+listing titles / 550 h2 / 600 h1+post title.
- Line-height 1.65; paragraphs end with `margin-bottom: 26px` (one line); body text at `rgba(33,32,28,0.9)`.
- **The single sanctioned exception**: the homepage hero headline — `clamp(2rem, 1.2rem + 3vw, 3.25rem)`, weight 600, letter-spacing −0.02em, line-height 1.12. Nothing else may break the flat scale.
- Code: inline 0.857em on a `--gray-200` pill with `--gray-400` 1px border, radius 6px; blocks 13px mono in a bordered radius-8 card, `max-height: 332px`, scroll inside.

### Color — warm 12-step gray (Radix Sand), zero chroma
| Token | Value | Use |
|---|---|---|
| `--gray-100` | `#fdfdfc` | page background |
| `--gray-200` | `#f9f9f8` | raised surfaces / code bg |
| `--gray-400` | `#e9e9e7` | borders (figures, code, pills) |
| `--gray-500` | `#e2e1de` | text selection |
| `--gray-800` | `#bcbbb5` | link underlines at rest |
| `--gray-900` | `#8d8d86` | link underlines on hover |
| `--gray-1000` | `#82827c` | tertiary (dates, captions, listing metadata) |
| `--gray-1100` | `#63635e` | secondary (descriptions, ledes) |
| `--gray-1200` | `#21201c` | ink |
| `--hover-fill` | `#f5f4f4` | listing hover pill |

No accent color exists yet — reserved for the minimap TOC layer (open decision).

### Layout
- **Posts**: Quarto page grid intact and symmetric — `$grid-body-width: 692px`, `$grid-sidebar-width: 300px`, `$grid-margin-width: 300px`. Equal sidebar/margin keeps the article column truly centered. `main.content` gets 24px inline padding → ~644px measure.
- **Homepage only** breaks the narrow column (`page-layout: full`): full-viewport hero (`min-height: calc(100svh - 9.5rem)` so the "Writing" cue peeks above the fold) inside a `--shell: 1160px` container, then the wide writing list. Everything still built from Emil materials.
- **Masthead** = the Quarto navbar stripped to just the name: transparent, borderless, no search, no icons, `padding-block: 2rem 0`. Its container is 692px-centered on posts and tracks `--shell` on the homepage via `body:has(.hero-screen)`.
- No footer (`.nav-footer { display: none }`, no `page-footer` in yml). Social links live in the hero.

### Links
Ink-colored text, always underlined; only the underline is tinted (`--gray-800`, hover → `--gray-900`), `text-decoration-thickness: 0.08em`, `text-underline-position: from-font`, offset 2px. **No transition** — hovers are instant.

### Writing list (homepage)
Two-column grid per item (`1fr 8rem`): title (500) + description (`--gray-1100`) left, date + reading time right-aligned in `--gray-1000`. Hover = instant `--hover-fill` pill bleeding 12px past the text edge (`margin: 0 -12px; padding: 12px; radius: 8px`). No borders, no thumbnails. Collapses to one column under 620px (metadata on top).

### Post pages
Title block: 64px top padding, title 16px/600, description `--gray-1100`, date `--gray-1000`, "Published" heading and category pills hidden. Figures: 32px block margins, 1px `--gray-400` border, radius 8, captions 16px `--gray-1000` left-aligned. KaTeX display math: 32px block margins. h2 rhythm: 56px above / 20px below; h3: 40/16.

### TOC (current state — to be replaced by the minimap layer)
Left sticky sidebar in the grid's sidebar column, 14px, gray-1000 → ink on hover/active, 1px ink left-border on active. Quarto's own responsive collapse handles narrow viewports.

### Motion spec (Emil's principles — binding for all future layers)
1. Every animation needs a nameable purpose (explain / feedback / delight) or it doesn't ship.
2. Frequency decides: high-frequency interactions (hovers, keyboard nav) get minimal or **no** animation — list hovers are deliberately untransitioned.
3. Never animate keyboard-initiated actions.
4. UI motion < 300ms; ease-out for enters/exits; custom beziers, never CSS defaults.
5. Never animate from scale(0); press feedback = scale(0.97) on `:active`.
6. Transform/opacity only; everything gated behind `prefers-reduced-motion`.

### Quarto implementation gotchas (learned the hard way — don't re-learn)
- **Quarto hoists the first `<h1>`** in a page (even inside raw HTML blocks) into `#title-block-header`. The hero headline is therefore a `<p role="heading" aria-level="1">`.
- **Specificity**: prose rules are scoped `#quarto-content main.content p/a/h3…` (id-weight). Any component override inside content (listing, hero) must nest under the same `#quarto-content main.content` scope or it silently loses.
- **Never flatten the page grid or `position: fixed` the sidebar.** quarto.js recomputes sidebar geometry on scroll; fighting it makes the TOC collapse into a full-width header block in real browsers (worked in static screenshots, broke live). Center the column with symmetric grid widths instead.
- `.navbar-brand-container` ships with `mx-auto` — zero its margin or the masthead drifts off the column.
- `design/` is excluded from render via `project.render: ["**/*.qmd", "!design/"]`.
- `search: false` under `website:` kills the navbar search icon.

---

## Next layers (in build order, one at a time)

### Layer 2 — Minimap TOC (Rauno / devouringdetails.com)
Replace the current text sidebar with the tick-rail minimap. Measured spec from the dissection:
- Rest state: column of **1px × 32px horizontal ticks**, 8px apart, vertically centered in the left rail. Tick shade encodes hierarchy (ink = section heads, `--gray-800`-ish = subsections/filler). Zero text visible.
- **Active section: the one accent-colored tick, stretched to 50px** — the entire "you are here" UI. ⚠ Requires the accent-color decision first.
- Hover anywhere on rail → all labels fade in at once (100ms ease-out). Hover an item → its tick springs 32→50px (spring: stiffness 240, damping 25) and takes the accent; label rides the stretch.
- Contextual depth: only the active section's subsections expand inline into the rail.
- Invisible enlarged hit areas (~14px) around each 1px tick; full `:focus-visible` support.
- Narrow viewports (<~1400px): rail slides off-canvas (350ms, `cubic-bezier(0.23, 0.88, 0.26, 0.92)`), toggle button + `S` keyboard shortcut; opened-as-menu shows labels instantly.
- Implementation route: custom JS that reads Quarto's generated `#TOC` nav and rebuilds it as the rail (keep Quarto's heading data, replace the presentation). Scroll-spy via IntersectionObserver, not scroll handlers.

### Layer 3 — Whimsy (pick at most two, ma5a's fencing rules binding)
**→ Full candidate designs, variants, live sketches, and the per-surface allocation proposal now live in [whimsy.md](whimsy.md) (2026-07-10).**

Candidates, all drawn from Ameya's own repos so the decoration demonstrates the research:
1. **Induction-head cursor trail** (from QuotesByNiche's B5H0): a trail that *replays your past trajectory* — `[A][B]…[A]→[B]`, copying what followed last time — rather than merely lagging. Desktop only, ink-colored, ephemeral.
2. **Photon random-walk** (from mc-radiative-transfer): scattering particles as a homepage-hero-only ambient effect.
3. **B5H0 Nietzsche quotes** (from the Niche char-level GPT): an occasional bad Nietzsche quote as a footer/404 easter egg; B5H0 as the site's named mascot.

ma5a's restraint rules (enforce in code, not vibes):
- Fence ambient motion geographically (`scrollY < innerHeight`-style predicates); article body = still air; ambient elements behind content (`z-index: -1`, `pointer-events: none`).
- Anything above content must be user-caused, ephemeral, self-deleting (≤500ms lifetime, sampled events).
- One autonomous animation per screen max; idle = fully static within ~1s.
- One voice: same ink palette, one mascot, whimsy demonstrates what the site is about.
- ~0 bytes: vanilla JS/CSS, transform/opacity only, gated behind `prefers-reduced-motion`, semantic interactive elements.

### Layer 4 — Page transitions (decision pending)
Candidate: View Transitions API morph on index→post only (the cobosrl/antfu fluidity), everything else stays instant. Cross-document `@view-transition { navigation: auto }` works on a static Quarto site in Chromium; degrades gracefully elsewhere. Decide after Layers 2–3 land — the base may feel complete without it.

### Layer 5 — Content restructuring (ongoing, per-post)
The 644px/16px system wants Emil's rhythm: 1–3 sentence paragraphs, h2 every 4–8 paragraphs, figures/math as breakout moments. The induction-head post still has 5–8 sentence walls — restructure when editing it next, and write new posts in this rhythm from the start.

## Open decisions
1. **Accent color** — exactly one, needed before Layer 2 (minimap active tick; Rauno owns orange). Should feel personal.
2. **Font pairing** — Inter is in; decide whether to adopt the serif-italic word-emphasis flourish (Emil uses Tiempos italic inside Inter) and which serif if so.
3. **Whimsy pick** — max two of the three candidates above.
4. **Layer 4 yes/no** — view transitions after seeing Layers 2–3.

## Session log
- **2026-07-10**: Inspiration research (galleries + site dissections of emilkowal.ski / devouringdetails.com / ma5a.com, exact measurements via shipped CSS). Layer 1 built, workshopped (homepage got the wide hero back after the pure-Emil version felt too stripped; TOC un-flattened after breaking in a real browser), and approved as the base.
