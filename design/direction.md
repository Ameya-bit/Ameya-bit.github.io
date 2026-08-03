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
- **Flat 16px prose — with an apparatus tier under it (amended 2026-08-02).** The original rule said 16px for *everything* including captions and metadata. Re-checked against emilkowal.ski's shipped markup and that overshot: his prose really is flat (his post `<h1>` carries `class="mb-8 font-semibold"` with no font-size utility at all — it inherits the 16px root, and weight alone ranks it), but he keeps a whole second tier for things that aren't the argument. His figure attribution is `text-xs text-gray-1000`, his prev/next post links are `text-sm`, his code blocks are `text-xs`. Collapsing that tier into 16px is what made our figure captions weigh as much as the paragraphs they described.
  - **Prose stays flat at 16px**: body, h1–h6, post titles, listing items. Hierarchy = weight only: 400 body / 500 h3+labels+listing titles / 550 h2 / 600 h1+post title.
  - **Apparatus drops to `--text-apparatus` (14px), `--gray-1000`**: figure captions, post filing line (date + categories), TOC rail, epistemic-status blocks. Nothing that carries argument may use this tier, and nothing in this tier may grow back to 16px.
- Line-height 1.65 for prose, 1.6 for apparatus; paragraphs end with `margin-bottom: 26px` (one line); body text at `rgba(33,32,28,0.9)`.
- **Emphasis is a contrast event, not just a weight event.** Emil's `<em>` is `font-serif-inline text-[0.98em] font-normal italic text-gray-1200` — a dedicated italic-only webfont *and* full ink against 0.9-opacity body. We don't take the serif (that flourish is his), but we take the principle: `<strong>` is 600 **and** `--gray-1200`, so the verdict sentences lift off the paragraph.
- **The scale-breaking exception stays exactly one**: the homepage hero headline — `clamp(2rem, 1.2rem + 3vw, 3.25rem)`, weight 600, letter-spacing −0.02em, line-height 1.12. The apparatus tier is a *tier*, not a second exception; nothing else may go larger than 16px.
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
- **Masthead** = the Quarto navbar stripped to just the name: transparent, borderless, no search, no icons, `padding-block: 2rem 0`. It tracks `--shell` on the homepage via `body:has(.hero-screen)`. **On posts (≥992px) the name sits in the left gutter, flush with the TOC rail at the 24px screen inset (amended 2026-08-02)** — Quarto renders `#quarto-header` as `position: fixed`, so a name over the reading column gets scrolled underneath by the prose; parked in the empty gutter there is nothing for the text to pass beneath. Below 992px the TOC collapses, the gutter closes, and the name returns to the column edge. The override must be written `#quarto-header > .navbar`, not `.navbar`: Quarto ships `#quarto-header > nav { padding-left: 1em }` and an id outranks any amount of class weight, leaving the name 16px off the rail otherwise.
- No footer (`.nav-footer { display: none }`, no `page-footer` in yml). Social links live in the hero. **Exception (2026-07-24): one faint centred colophon line (`.site-colophon`) at the foot of the homepage only**, crediting the ma5a panda sprite/engine now that the hero has a real thing to attribute. It is bare text — no border, fill, or nav chrome — so it reads as a signature, not the footer returning. The no-footer stance otherwise holds; posts stay footerless.

### Links
Ink-colored text, always underlined; only the underline is tinted (`--gray-800`, hover → `--gray-900`), `text-decoration-thickness: 0.08em`, `text-underline-position: from-font`, offset 2px. **No transition** — hovers are instant.

### Writing list (homepage)
Two-column grid per item (`1fr 8rem`): title (500) + description (`--gray-1100`) left, date + reading time right-aligned in `--gray-1000`. Hover = instant `--hover-fill` pill bleeding 12px past the text edge (`margin: 0 -12px; padding: 12px; radius: 8px`). No borders, no thumbnails. Collapses to one column under 620px (metadata on top).

### Post pages
**Masthead (rebuilt 2026-08-02).** Publication grammar, not Emil's — he opens a post with a bare `<h1>` and *nothing else*: no date, no description, no categories anywhere on the page. We have all three and they're worth showing, so the block reads title → standfirst → 1px `--gray-400` rule → filing line (date · categories) in the apparatus tier. 64px top padding, 56px below. Categories are back but as plain middot-chained text, never pills — pills would be the only rounded filled object on a post page. Implementation: the header is `display: flex; flex-wrap: wrap`, `.quarto-title` is `display: contents` (promoting `h1` and `.quarto-categories` to direct flex items so `order` can reach them), and the rule is the header's own `::after` — a pseudo-element on a flex container is a flex item, so it orders with the rest and needs no extra markup. **Every metadata selector must carry `#title-block-header`**: the prose block is scoped `#quarto-content main.content p`, the title block lives inside `main.content`, and an unqualified `.quarto-title-meta-contents p.date` loses the id-weight fight and snaps back to 16px.

**Figures (unframed 2026-08-02).** No border, no radius — the PNGs sit on white and the page is `#fdfdfc`, so removing the frame turns them from cards into ink printed on the page. The frame returns on hover as `outline: 1px var(--gray-400)` at `outline-offset: 6px` — outline so nothing reflows, offset so the ring never crops the artwork — and that hover *is* the click affordance. 32px block margins. Captions 14px `--gray-1000` left-aligned (the old rule pinned them to 16px with `!important`; that was the single biggest reason figures read as undifferentiated slabs).

**Figure zoom** (`assets/site/figure-zoom.html`, inlined via `include-after-body`). Click or Enter/Space on a figure opens it full-size over the page; click anywhere or Esc closes. Overlay is `rgba(253,253,252,0.96)` — the page colour, not a black scrim: the reading room doesn't go dark, the article steps back. 150ms opacity fade on `cubic-bezier(0.16, 1, 0.3, 1)`, zero under `prefers-reduced-motion`. Chosen over Quarto's built-in `lightbox:` (GLightbox, ~30kb + dark chrome to restyle) and over widening figures into the margins — the 644px column is the point of the post page, and expand-on-click keeps it while giving dense figures somewhere to go.

**Epistemic status / closing aside.** A paragraph whose whole content is italic (`<p><em>…</em></p>`) is, by convention in this writing, not part of the argument — it's the confidence note up top and the nudge at the end. Both posts bookend exactly this way, so `p:has(> em:only-child)` catches all four with no markdown changes. Rendered as apparatus: 14px, `--gray-1100`, 1px `--gray-400` left rule, 20px indent, italics removed (the block carries the meaning now).

**Math.** KaTeX display: 32px block margins, `overflow-x: auto`. The equations are wider than the measure on a phone and used to scroll the whole document sideways (476px scrollWidth at a 375px viewport). Wide content scrolls inside its own box; the page body never does.

h2 rhythm: 56px above / 20px below; h3: 40/16.

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

---

## Layer 1b — The apparatus tier (BUILT 2026-08-02). The un-Emil half

*Built after an outside design review. The finding was not that the base is wrong — it's that **the severity was paid for and the whimsy was never spent**: Layer 2 unbuilt, accent undecided, serif undecided, so a visitor got the austerity with none of the return. Layer 1b is the answer to "how is this not just Emil's site," and it is deliberately drawn from what this site **publishes** rather than from whose CSS it was reverse-engineered out of. Emil runs a personal blog. We run a publication. A publication has an apparatus; a blog does not.*

**The rule: prose keeps Emil's voice, apparatus takes a second role.** Flat 17px Inter, weight-only rank in the body, instant hovers, no chrome — unchanged. What is new is a **monospace numbering system**.

- **Mono is for the numbering system, nothing else** *(amended same day — see below).* Section numerals in the article gutter and their counterparts in the rail: one material, two places, the same job. Everything else in the apparatus — dates, categories, TOC labels, listing metadata, colophon — is Inter at `--text-apparatus` in `--gray-1000`.
- Tokens: `--font-apparatus` (system mono stack), `--text-apparatus-mono: 0.8125rem` (13.8px, numerals only), `--text-label: 0.6875rem` (11.7px, uppercase, tracked — kickers only, in Inter).

**Amendment — mono was first applied to the whole apparatus tier, and pulled back the same day.** Ameya's read on the built page: *"the toc is a different font and size than the rest… it's not cohesive like a minimal website would be."* He was right, and the failure is diagnosable: the tier changed **typeface AND size AND tracking AND case simultaneously**. That is not a quieter tier, it is a second voice — and on a page whose content is only paragraphs and charts, a second voice has nothing to do but clash. It also caused a concrete regression: mono is wider, so the date and categories, which are meant to share one filing row, wrapped onto two lines.

The principle that survived: **numbers are what an instrument shows; the moment mono touches words it stops reading as instrumentation and starts reading as a different font.** Differentiate on one axis at a time.

**Related — the materials count.** The post page briefly carried ~9 materials (Inter prose, Inter gray secondary, mono uppercase tracked kicker, mono tracked labels, mono numerals, vermillion, hairline rule, left-rule aside, unframed figure) for a page whose content is *paragraphs and charts*. Emil runs about four — body text, small gray text, bold heading, bordered card — repeated dozens of times each, and that repetition is what reads as a system. **Cohesion is few materials used often, not many materials used once.** Pulling mono back to numerals removed two.

**Sections number themselves.** `counter-reset: section` on `main.content`, `counter-increment` on h2, rendered `decimal-leading-zero` in mono. Below 1200px the numeral sits inline ahead of the title; at ≥1200px it goes `position: absolute; left: -3.4rem` and hangs in the gutter, so the prose edge stays a clean vertical line and the numbers read as their own column down the page. The TOC carries a second, independent counter on `#TOC > ul > li` so the rail and the headings agree. Homepage is unaffected — the listing uses h3 and the hero headline is a `<p role="heading">`, so there are zero h2s on the index.

**Accent — open decision #1, resolved: `#d55e00` / `--accent-ink: #b04d00`.** Not chosen so much as discovered. Every figure on this site already reaches for Okabe-Ito vermillion when it needs to say *this is the finding* — the copying-score bar, the DLA annotation, the S-inhibition boxes. It is warm, so it belongs on sand, and it makes a highlighted bar and a hovered link literally the same colour. Two steps because one can't do both jobs: `#d55e00` is 3.80:1 (fine for marks, 1px ticks and the 3:1 non-text bar, **not** for small text), `#b04d00` is 5.28:1 and safe for text.

**Spending rule — the accent appears only on interaction.** Link hover underline, figure hover outline, `:focus-visible` ring, active TOC tick (+ its numeral in `--accent-ink`). At rest the page is monochrome, so severity is intact and colour reads as a *response* rather than decoration. This is also the un-Emil move on motion: his hovers are colourless and instant; ours stay instant and gain colour.

**Figures break the measure.** At ≥1200px, `.quarto-figure` takes `margin-right: -200px` into the empty right band — display width ~646px → ~846px. Two reasons: the figures are exported 1128–2210px and all shown at 646px, so the same 10pt label renders between **8.1px and 15.9px** across the set (a 2× swing); and a document where every element is one width is the definition of bland minimal. Captions do *not* follow the figure out (`max-width: 40rem`) — a 14px caption at 846px is a worse line than the one it replaced. Guarded by `overflow-x: clip` on post pages — `clip`, not `hidden`, so it creates no scroll container and the sticky TOC keeps working. Selector must be **descendant, not child**: Quarto wraps each h2 and its content in `<section class="level2">`, so figures are grandchildren of `main.content` and a `>` matches nothing.

**The scale's one reckless jump: the post title, 17px → 1.6rem / 27.2px** (line-height 1.22, tracking −0.015em). h2/h3 stay flat underneath it, so the system is *one event, then severity* rather than *no events*.

This breaks the original flat-scale rule on purpose, and the reason is that the rule was borrowed without its support structure. **Emil can run a flat scale because his column alternates prose with bordered demo cards every few lines, and those cards carry all of his page's punctuation.** This site took the flat scale but not the cards (figures here are deliberately unframed), and paired both with long paragraphs — three uniformity decisions stacked, and the column went gray. Every reference concentrates contrast in one place rather than spreading it: Ciechanowski jumps 2.8em→1.8em (1.56×) then runs flat, Distill 40px→24px (1.67×) then flat. Before this the only scale exception was the homepage hero — the page a reader spends the *least* time on, while posts had no contrast event at all.

**Vertical rhythm rebuilt around the 28.9px line** (17px × 1.70). The first pass raised the type and left the spacing, which made things worse, not better: the paragraph gap stayed at 26px — **0.90 of a line** — so a paragraph break read as a slightly loose line, and space below an h2 was 20px, **0.69 of a line**, so a heading sat closer to the paragraph above it than a paragraph break does. Now: paragraphs and lists `43px` (≈1.5 lines), h2 `72px / 29px` (2.5 / 1.0 lines, space-above ≈2.5× space-below so a heading binds to what follows), h3 `52px / 22px`, epistemic block `56px`, code and display math `48px`, figures `96px` (2.2:1 against the paragraph gap).

**The honest limit on spacing.** Emil's paragraph gap is *also* about one line and his page still breathes, because his paragraphs are 2–3 lines: his gap is ~45% of a block. At 8 lines a 26px gap is ~11% of a block, and matching his ratio would need a ~104px gap, which would look absurd. 1.5 lines buys back roughly half of it. **The other half is paragraph length — Layer 5, not CSS.**

**Filing row fixed.** Quarto ships `.quarto-title-meta` as `grid-template-columns: repeat(2, 1fr)` for multi-field bylines; with a single field it still reserves both columns, so the block sits at twice the width of the date. That is why date + categories wrapped to two lines as soon as the categories got any wider. One `max-content` column plus `margin-left: 1.75rem` on the categories, and the row fits with ~200px to spare.

**TOC hanging indent.** The numeral was an inline `::before`, so a wrapped item put its second line under the *number* instead of under the label — three of six items were ragged, which is most of why the rail read as unformatted rather than deliberate. Now `position: relative; padding-left: 2.4rem` on the anchor with the numeral absolute at `left: 0.7rem`. Nested (h3) items get the same padding so they can't reintroduce the ragged edge; neither post has an h3 yet.

**Figure rhythm 96px** against a 43px paragraph gap — 2.2:1, so a figure reads as an event. Ciechanowski runs 3:1 and it is most of why his figures feel like the point of the page. The original 32px against 26px was 1.2:1, very nearly uniform.

**Type: root 17px, prose line-height 1.70** (was 16px/1.65). The measure is fixed at ~646px by the grid, and at 16px that is ~80 characters per line — the longest line in the genre paired with the smallest letter. Tufte runs 21px/~64ch, LessWrong ~19px/~70ch; Distill tolerates ~83ch only on 1.7em leading and larger type. 17px gives ~75ch. **The column was deliberately not narrowed** — that would shrink the figures, which are the weaker link. Note `$font-size-root` reaches the page as `--bs-root-font-size`; `:root{font-size:11pt}` in the compiled CSS is `@media print` and is not a conflict.

**Contrast: `--gray-1000` `#82827c` → `#6f6f69`.** The old value was 3.80:1, a WCAG AA failure, and it carried every caption, date, category, TOC item, listing timestamp and the colophon — all at the small size. `#6f6f69` is the same hue and chroma one step darker: 4.97:1. The only approved palette value changed; the rest of the ramp already passes.

**The page grid is capped and centred** — `#quarto-content.page-columns { max-width: var(--page-max: 1440px); margin-inline: auto }`. The grid's outer slack columns are `5fr`, so at a 2700px viewport each grows to ~784px, stranding the 220px rail in ~670px of nothing and leaving masthead, rail and article reading as three unrelated objects adrift in the left half of the screen. One rule, no flatten, no fixed sidebar — Quarto's sticky recompute never notices. The masthead tracks the same capped box with the grid's own `1.5em` screen inset as padding, so the name lands flush with the rail at *every* width instead of only the one this was tuned on. (`#quarto-header` really is `position: fixed` — it ships `class="headroom fixed-top"` — so the gutter placement stays correct.) The rail also moved from `justify-self: start` to `stretch` + `min-width: 0`: at ~1000–1300px the left band narrows below 220px and the rail used to overflow its track and run under the article.

**Layer 4 brought forward — cross-document view transitions are in.** `@view-transition { navigation: auto }` plus `view-transition-name: masthead-name` on `.navbar-brand`, so the name holds still while the page changes under it. Two lines, fully progressive, no JS needed since every page ships this stylesheet. The UA-generated animation is *not* covered by `prefers-reduced-motion` on its own, so `::view-transition-group/old/new(*) { animation: none !important }` cancels it explicitly.

**Metadata (`_quarto.yml`).** `open-graph: true`, `twitter-card: {card-style: summary_large_image}`, `favicon: assets/favicon.svg`. Research circulates as links on X / LessWrong / the Alignment Forum, and every share of these posts previously rendered as a bare URL — no card, no image, no author — while five publication-grade figures sat in each post unable to be the preview. Both posts already declare `image:` in front matter, so post cards populate immediately. The favicon is **cel 0 of the `down` row of the hero sprite sheet**, extracted from `assets/pandas/engine/render/art-data.js` and cropped to its own bounds (32×32 viewBox, 1082 bytes, 9 paths) — the tab mark and the troupe are literally the same drawing, and nothing new was drawn ([[no-ai-generated-art]]).

**`design/figures.mplstyle` — written, not yet applied.** The figures live in other repos and are not regenerated here, so this is the spec to plot against next time: fix the **width** at 1280px (846 × 1.5, transformer-circuits' rule), vary height per plot, Okabe-Ito cycle, and the colormap rule stated in comments — diverging pinned to zero for signed quantities, sequential from zero for unsigned. The current figures already get that right; the note is so it stays right.

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

**2026-07-22 amendment — two registers, one author.** The "whimsy speaks the research language" rule is amended: **homepage whimsy speaks the author's *identity*** (the panda troupe — Ameya's cross-platform avatar mark, durable across research pivots); **per-post whimsy speaks that post's *topic***. The site-wide Niche mascot is retired (Ask Niche stays post-local on the induction post). Fencing amendment: ma5a's real rule is *geographic* fencing, not user-causation — one ambient autonomous **system** is permitted inside the hero fence (idle-static rules stand everywhere else; article pages remain still air).

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
1. ~~**Accent color**~~ — **resolved 2026-08-02: `#d55e00` marks / `#b04d00` text**, taken from the vermillion the figures already use for "this is the finding." Interaction-only spending rule. Layer 2 is unblocked. See Layer 1b.
2. **Font pairing** — Inter is in, and the second *role* is now filled by mono (Layer 1b), which was the actual gap: the apparatus and the argument used to look identical, which is the specific tell that reads as "template." The serif-italic emphasis flourish stays **open** — it is Emil's signature and taking it is the thing Layer 1b was built to avoid. Revisit only if `<strong>`-as-contrast-event proves too quiet.
3. **Whimsy pick** — resolved 2026-07-22: panda troupe on the hero (identity-native; whimsy.md candidate 6) + Ask Niche post-local. Character/behavior verdicts pending in whimsy.md.
4. ~~**Layer 4 yes/no**~~ — **resolved 2026-08-02: yes, brought forward.** Two lines, fully progressive, no JS. Shipped in Layer 1b rather than waiting on 2–3.
5. **Homepage share card** — post cards populate from each post's `image:`, but the index has no OG image, so a share of the homepage is a text-only card. Needs an asset that isn't AI-generated ([[no-ai-generated-art]]); a rendered still of the panda stage is the obvious candidate. Open.

## Session log
- **2026-08-02**: Outside design review (award criteria + research-publishing conventions, measured against shipped CSS from Distill, transformer-circuits, ciechanow.ski, thesephist, rauno.me, Tufte CSS). Diagnosis: the base is well executed but **under-composed** — one width for everything (the 300px margin column was allocated and empty on every page, zero footnotes, zero outset figures), 80ch at 16px, a WCAG-failing tertiary gray, an unbounded grid that sprawled at wide viewports, and four different accent colours across eleven figures while the page itself had none. **Layer 1b built** in response (see above): apparatus mono role, section numbering, accent resolved and spent on interaction only, figures outset, 17px/1.70, contrast fix, grid capped, view transitions, OG/Twitter/favicon, `figures.mplstyle` spec. Deferred by decision: no content edits (so the quote-grammar table stays a PNG and the induction post stays without a repo link), and the panda engine's more intentional use is a later conversation — the NN is not ready and development stays in the panda-engine repo.
- **2026-07-10**: Inspiration research (galleries + site dissections of emilkowal.ski / devouringdetails.com / ma5a.com, exact measurements via shipped CSS). Layer 1 built, workshopped (homepage got the wide hero back after the pure-Emil version felt too stripped; TOC un-flattened after breaking in a real browser), and approved as the base.
- **2026-07-22**: Whimsy direction amended — Niche mascot retired; identity-native **panda troupe** adopted for the hero (whimsy.md candidate 6); ambient autonomous motion permitted inside the hero fence as one system. Workshop ran four rounds (flat SVG → procedural 2-bit sprites ×2 → pivot); landed on a faithful replica of ma5a's "panda collision" pen (MIT via CodePen, attributed) as the build base — her sprite art + constants, engine reimplemented. Replica: `design/sketches/panda-collision-replica.html` + live artifact. Next pass (pending Ameya's verdicts in whimsy.md): recolor to sand, dǒulì hat, calmer hero-fenced behavior, then `assets/pandas/` + hero include. Note: her engine animates margins with CSS transitions — conflicts with the transform-only motion rule; resolve when porting.
