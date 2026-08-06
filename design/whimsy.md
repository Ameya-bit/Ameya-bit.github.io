# Layer 3 — Whimsy: candidate designs

*2026-07-10. Workshop doc for the whimsy layer. Parent spec: [direction.md](direction.md); ma5a fencing rules there are binding.*

> **Status (2026-08-05, doc audit) — the 2026-07-10 header below is three decisions out of date, so here is where this layer actually stands.** ~~Layer 2 minimap TOC deferred by decision — the current text TOC stays for now~~: **the rail was built 2026-08-03.** ~~"Ask Niche" is the lead; engine drafted & tested; UI mocked. Nothing shipped to the site yet~~: **Ask Niche shipped on the induction post** (built 2026-07-10, restyled into the post-reset language 2026-08-05) and the **panda troupe shipped on the homepage** (2026-07-23 → 2026-07-27), **then came off it on 2026-08-03**. Layer 3 is **paused, not cancelled** — the re-entry condition is that the minimal base reads as finished with the hero empty. The panda project itself moved to [Ameya-bit/panda-engine](https://github.com/Ameya-bit/panda-engine) on 2026-08-02; see [panda-engine.md](panda-engine.md). Everything below is the candidate workshop that produced those picks, kept as the record.

> **2026-07-22 amendment (Ameya):** the site-wide Niche mascot is **retired** — it only ever related to the induction-head post, and the research is moving fast (next: replicating Anthropic's J-space paper). Homepage whimsy goes **identity-native** instead: the **panda troupe (candidate 6, new lead)**. Ask Niche survives as a *post-local* figure on the induction post. Candidates 5 and 3A are cut. Amended allocation model and fencing rules below.

**Live sketches (round 2 — the Ask Niche panel is working on the page itself):** https://claude.ai/code/artifact/c283ec6b-f6e2-4a6c-8ddb-b710692ba3db
*(Round-1 artifact with the cursor-trail demo was deleted; the trail spec survives in this file's git history.)*

---

## The allocation model (adopted direction)

One element per surface:

| Surface | Whimsy budget | Current candidate |
|---|---|---|
| Homepage / hero | One signature **system** (a troupe counts as one element) | **Panda troupe (candidate 6) — LEAD 2026-07-22**; "B5H0 reads the headline" (5) cut; photon walk (2A) stays parked for a physics post |
| Each post/project page | One element, **native to that post's topic** | **"Ask Niche" (candidate 4)** stays on the induction post — demoted from site mascot to that post's topic-made-live |
| 404 + other utility pages | One quiet resident | open (3A cut with the mascot retirement) |

Per-post whimsy = the post's subject made live (interactive-figure energy, not decoration); optional per post. **Two registers, one author (2026-07-22):** the homepage speaks Ameya's *identity* (the panda — his existing avatar across Instagram/WhatsApp/X); each post speaks its own *topic*. No cross-surface mascot anymore — a mascot tied to one project goes stale the moment the research moves on.

---

## Candidate 6 — Panda troupe on the hero (LEAD, 2026-07-22)

> **2026-07-23 — concept crystallized.** The troupe is no longer "roamers + a hat"; it now enacts **activation patching** (the method underneath every circuit the site dissects), with the hat panda as the interpreter/self-insert. Full choreography spec, metaphor mapping, 5 build phases, and open decisions live in **[panda-choreography.md](panda-choreography.md)**. This section below is retained as the base-engine + hat-fitting history that the choreography builds on.

### Status (2026-07-22, round 6): hat fitting bench — per-frame fits on dissected walk cells

**Live artifact:** https://claude.ai/code/artifact/9cc421bb-f300-40da-b1e0-ae99bc444813
**Working copy in-repo:** `design/sketches/panda-collision-replica.html` (self-contained, identical to the artifact — open locally or republish). *To update the artifact from a fresh session, pass its URL as the `url` parameter of the Artifact tool, else a new URL gets minted.*

**Build history (all 2026-07-22):**
- **Round 1** — flat SVG pandas roaming a hero replica. Rejected by Ameya: "a flat jpg moving across the screen," no expressivity.
- **Rounds 2–3** — procedurally generated 2-bit pixel sprites (pixel rasterizer + outline pass; round 3 added a 5-tone palette, 6-frame walk, pupils, parameterized expressions). Scrapped: the from-scratch art wasn't landing.
- **Round 4** — pivot per Ameya: replicate ma5a's *"panda collision"* pen exactly first, build on top later. Done. Sprite art is her verbatim path data (injected programmatically from the extracted pen source — zero transcription errors; decode verified: 90–134 balanced paths per direction row). Engine reimplemented, constant-for-constant faithful. Deliberate diffs only: area-scaled panda count on small screens, tap-to-knock, reduced-motion = standing still.
- **Round 5** — two behavior drafts on top of the replica: the hat panda (dǒulì composited into the walk cells; knock-off-and-retrieve skit, calm-drop/big-launch variants) and the induction walk (pair / train-of-three path copying). Ameya verdict: **the hat still doesn't fit.**
- **Round 6 (current)** — hat fitting bench. Approach change per Ameya: dissect the walk animation into its individual frames and draw the hat onto each one; induction walk **parked** (returns once the hat is approved). The 15 walk cells (5 direction rows × frames 0/1/2) were rasterized offline from her path data (axis-aligned h/v outlines, even-odd scanline fill) and the head contour measured per cell — findings: the head is ~15 units wide but the round-5 brim was 28 (nearly the whole panda), the head top dips 2 units in every mid-stride frame (f1), and the head center drifts ±1 unit between stride extremes; round 5 had one eyeballed seat per direction plus a guessed bob. The dǒulì is redrawn at 20 units (5 perspective drawings: band on front/¾-front, apex leaning into the heading on profile, plain cone on the back rows; 1-unit ink outline, white straw, radial ribs) and seated per frame from the measurements (brim underside = head-top + 1, centered on the measured head center). The artifact now leads with the bench: all 15 frames at 4× with the hat drawn on each, ◀▶▲▼ nudge controls per cell (1 sprite unit), pixel-grid + hat toggles, a per-row walk-cycle preview playing `[0,1,2,1]` with the per-frame hats, and a live `HAT_FIT` readout to carry into the next round; nudges also re-composite the hat panda in the simulation below live. Fall/stand-up cells stay hatless by design.

**How the pen actually works (corrects the earlier PNG-sprite assumption — her *homepage bunnies* are a PNG sheet; the *pen's panda* is pure SVG):**
- Pixel art stored as SVG paths compressed with a custom alphabet — each letter decodes to a path command (`a`=`h 1`, `N`=`v -1`, `D`/`F`/`o` open ink/white/pink paths). Five strings → five direction rows (up, diag-up, side, diag-down, down), viewBox 624×48 each = **13 frames of 48px cells**; displayed as a 1300×500 block behind a 100×100 overflow-hidden window, stepped by negative margins.
- Animations = frame-index lists at 140 ms/frame: walk `[0,1,2,1]` · fall `[3,4,5,6,5,7]` · fallen `[7]` · standUp `[7..12]` · stop `[0]`.
- 8 walking headings from 5 rows — left-facing is `scale(-1,1)` on the inner wrapper (hit area re-flipped).
- Movement: compass-walk (heading turns ±1 step, options `[1,1,-1,-1,0]`), 50px strides every 850–1100 ms, **glided by `transition: 2s` on margins** (this is what makes it feel soft), bounds clamp (−40 / stage−60), `z-index = y` depth sorting.
- Collision: 4 invisible hit-corners per panda (40×50 hit area), pairwise rect-overlap within a 20px buffer every 50 ms; corner pattern → knock direction (single corner = diagonal, two = cardinal, all four = the panda's own random default). Knock: 80px slide away, fall animation, lie 2–5 s, stand up, resume. The knock-down/get-up cycle is the pen's soul.
- Her values: 20 pandas, pink `rgb(255,151,186)` bg, ink `rgb(173,1,87)`, white + pink accent fills (inner ears).
- License: public CodePen pens are MIT (CodePen ToS); attribution embedded in the artifact and the in-repo copy. *(Fetch note: codepen.io Cloudflare-blocks curl; `https://cdpn.io/Ma5a/fullpage/WNEBqPO` with a browser UA returns the pen inside an escaped iframe `srcdoc`.)*

**Next pass (agreed direction, not started):**
1. **Recolor to the site palette** — ink `rgb(173,1,87)` → `--gray-1200`; white fills stay `--gray-100`; decide what the pink accent paths (`o`-prefixed: inner ears) become on sand (candidate: `--gray-800`); stage pink → `--gray-100` (the hero itself).
2. **Dǒulì hat** — open question: edit the path data per frame (13 × 5 cells) vs. a positioned overlay layer per direction row. Overlay is likely cheaper; hat must track the head through walk/fall/stand-up frames.
3. **Calmer, site-fenced behavior** — fewer pandas (3–5 by hero area), possibly rarer collisions/knocks, hero-only geographic fence, pause off-screen/hidden-tab. Note a rules tension to resolve: her engine animates *margins* (layout) with CSS transitions; direction.md's motion spec says transform/opacity only — either port movement to transforms (keeping the 2s-glide feel) or consciously exempt the replica engine.
4. **Ship integration** — `assets/pandas/` + Quarto include on the homepage hero, same pattern as Ask Niche.

**Verdicts wanted from Ameya before next pass:** does the replica feel like the real pen? · keep the knock-down/get-up behavior on the site (it needs ≥2 pandas colliding — or tap-to-knock)? · pink-accent → which sand tone? · hat approach (path-edit vs overlay)? · panda count on the hero?
*(Round 1 — flat SVG pandas roaming a hero replica — rejected 2026-07-22: no expressivity, "a flat jpg moving across the screen." Round 2 goes 2-bit pixel-sprite style after dissecting ma5a's actual bunny implementation: a 6-frame pixel sprite sheet animated by CSS `steps()` + JS scheduling. Ours generates the frames procedurally in code — a tiny pixel rasterizer + outline pass — so hats and expressions are parameters, not redraws. Workshop is strictly in the artifact until a design wins; mobile-friendly pens for: walk cycle, somersault roll, dǒulì hat, idle/blink/sleep, bamboo munch, edge-peek.)*

**Concept:** a small troupe of ink-and-sand pandas lives in the hero's empty space — ambling to waypoints, pausing, napping, greeting each other on collision. Ma5a-bunny aliveness, geographically fenced to the hero. Deliberately *not* research-native: the panda is Ameya's existing mark (avatar on Instagram/WhatsApp/X), so it survives every research pivot. Timelessness is the point.

**Why panda over research-native whimsy:**
- **Durability** — Niche was post-specific; the panda bets on the author, the one constant on a personal site.
- **Avatar continuity** — visitors arriving from X/Instagram see the mark they already associate with Ameya. That's what a signature is.
- **Natively grayscale** — the only animal that renders in the zero-chroma sand palette with no rule changes.

**Rule amendments this forces (conscious, adopted 2026-07-22):**
1. direction.md's "whimsy must speak the research language" → **homepage whimsy speaks the author's identity; per-post whimsy speaks the post's topic.**
2. "One autonomous animation per screen max; idle = fully static within ~1s" → **the hero fence permits one ambient autonomous *system*** (ma5a's actual rule is geographic — `scrollY < innerHeight` — not user-causation; her bunnies are autonomous). Everywhere else the old rules stand. Article pages: zero pandas, still air.

**Character design constraints:**
- ⚠ **Copyright:** the personal avatar is Po from Kung Fu Panda (DreamWorks IP). The site panda must be an **original design** — no Po facial features, proportions, or costume. A generic conical straw hat (dǒulì) is a traditional object, not DreamWorks's, and is what keeps the visual link to the avatar. Drawn in our own style: recommended.
- Ink-and-sand only: `--gray-1200` patches, `--gray-100` fur, hat in the gray-800/900 straw range.
- Build base: ma5a's panda pen (codepen.io/Ma5a/pen/WNEBqPO — public pens are MIT-licensed under CodePen ToS), replicated faithfully in round 4 (see Status above); her sprite art + constants, our engine. Site version diverges from here (palette, hat, behavior).

**Fencing (amended audit):**
- Geographic: hero only. Never below the Writing header, never on posts or utility pages.
- The hero text block is an **exclusion zone** — pandas path around it, never under the headline glyphs. Pandas are `aria-hidden` decoration.
- Perf: transform-only, rAF loop paused via IntersectionObserver when the hero is offscreen and on `visibilitychange`.
- `prefers-reduced-motion`: troupe present but static/asleep — species-appropriate degradation.
- Click a panda → hop (user-caused, ephemeral — allowed above content). Open question whether to keep.

**Standing open questions (beyond the round-4 verdicts above):** hat on all / one / none ("one" reads as *the* panda = Ameya) · mobile show/hide on the shipped hero · adopt the panda as favicon to close the loop with the social avatars.

---

## Candidate 4 — "Ask Niche" (SHIPPED; post-local as of 2026-07-22)

*The name: the model is named Niche after Nietzsche. Rhymes, even though it doesn't really.*

**Concept:** visitors ask the 4.9M-param char-level GPT (the one the posts dissect) to explain a passage. It can't — it's primed with the passage + a lead-in (`"This says this because "`) and simply continues, drifting into Nietzsche-flavored almost-language. The failure is the delight; the frame is the site's real joke (the author interprets the model's internals; the model can't interpret a paragraph).

### Decisions (2026-07-10, Ameya)
- **Viz: attention stripes** (not the top-k probability strip).
- **Mobile: hidden entirely** (`pointer: coarse` / narrow viewports).
- **Weights: fp16 lazy-load (9.8 MB) on first ask;** int8 quantization (~5 MB) only if it proves too slow in practice.
- **UI: a small squircle bottom-right that expands into the full Niche panel.** Layout top→bottom: attention stripes / output / input.

### UI spec (as mocked in the artifact — Emil language throughout)
- **Squircle FAB**: 46px, bottom-right (24px margins), `--gray-100` surface, 1px `--gray-400` border, radius ~16px (true superellipse via `clip-path` when shipping), mono glyph **`N̈`** in `--gray-1100` → ink on hover. Faint shadow. Press = `scale(0.97)` on `:active`. Static — no idle animation ever.
- **Expansion**: panel scales from 0.96 + opacity (never from 0), 220ms `cubic-bezier(0.16,1,0.3,1)`, `transform-origin: bottom right`; FAB fades out. Instant under `prefers-reduced-motion`. Escape closes; focus moves into the panel and back to the FAB on close.
- **Panel** (~390px, fixed bottom-right): `--gray-100`, 1px `--gray-400` border, radius 12, soft shadow.
  - **Header**: `N̈ Niche` (mono 14) + `4.9M params · char-level · thinks in Nietzsche` (mono 12, gray-1000) + quiet × close.
  - **Top — attention stripes**: 44px canvas; one vertical ink bar per context char (≤256 fit a 390px panel at ~1.5px each), bar height/opacity = B5H0's attention at the current generation step, redrawn per char. Caption (mono 11): "B5H0 attention over your passage — waiting / live / done". Real weights come free from `niche-infer.js` (`model.lastAttn`); the mock simulates the actual induction rule (attend to the char *after* previous occurrences of the current char, plus the position-0 sink from the post).
  - **Middle — output**: 14px, prime rendered as italic `--gray-1100` lead-in, generated text in ink, static `▍` caret while streaming (no blink — motion rules), removed at end. Streaming throttled to **~30 chars/s** (engine does 177) for legibility.
  - **Bottom — input**: textarea on `--gray-200` (200-char cap ≈ context budget), mono char counter, "ask Niche" button (border buttons, `scale(0.97)` press).
  - **Download state** (first ask only): 2px progress hairline + mono label "waking Niche — x.x / 9.8 MB (one time)" between stripes and output; Cache API for repeat visits.
- **Selection entry**: selecting >~12 chars of article text shows a small "ask Niche" chip above the selection (Medium-style); click → panel opens pre-filled with the selection (truncated to its last ~200 chars).
- **Fencing**: entirely user-caused; the FAB is static chrome; article stays still air until asked; desktop only; reduced-motion = instant everything.

### Engine (drafted & verified, `design/sketches/`)
- `export_niche_web.py` — checkpoint → fp16 bundle (9.8 MB) + manifest + parity vectors. Run against `niche_model.pt` ✓.
- `niche-infer.js` — dependency-free JS engine: KV cache, exact-erf GELU, 256-char sliding window, curly-quote/unknown-char handling, `lastAttn` (B5H0) exposed per char. **Parity vs PyTorch: max logit Δ 1e-5, greedy identical; 177 chars/s.**
- `test_niche_infer.mjs` — parity + speed test, all PASS.
- Remaining to build: productionize the mocked panel UI (swap canned text for the real engine), Quarto include wiring, Cache API, quote curation for the 404.

### Still open
1. Prime wording: `"This says this because "` vs `"In other words, "` vs `"That is to say: "`.
2. `N̈` glyph on the FAB: charming or too cute? (Alternative: plain `N`.)
3. Stop rule tuning: ~200–280 chars, cut at first sentence end past a minimum.
4. Does Ask Niche eventually appear on the homepage too, or stay post-only?

---

## Candidate 5 — Hero: "B5H0 reads the headline" (CUT 2026-07-22)

*Cut with the Niche retirement: it tied the site's front door to a project already outgrown. The hero slot goes to the panda troupe (candidate 6). Spec kept below for the record.*

**Concept:** the hero headline — *"Currently, I train small models and take them apart to see what they learned."* — is itself the specimen. Hover a word and the sentence shows what B5H0 (the induction head the site is about) attends to while reading that word: earlier characters light up with intensity proportional to real attention weights from the actual checkpoint. The headline *claims* "I take them apart"; the whimsy lets the visitor do the taking-apart, on the exact sentence they're reading. The claim demonstrates itself.

**Why this over the alternates:**
- It speaks the site's research language literally (direction.md's governing rule) — not physics-adjacent, not decorative, but the thesis sentence being interpreted by the thesis model.
- It completes the Niche fiction as one voice across surfaces: **hero = B5H0 reads; posts = Niche writes (Ask Niche); 404 = Niche mutters (quotes).** Same mascot, same ink, three verbs. This also answers whimsy.md open question #4: Ask Niche stays post-only; the hero gets its read-only sibling.
- It is the *most* fenced candidate possible: zero autonomous motion, entirely user-caused, instant on/off, nothing above content. The hero stays severity-pure at rest — which is exactly what buys the moment when it lights up.
- ~0 bytes for real: attention is **baked offline** (no 9.8 MB engine on the homepage) — a ~1 KB inline JSON + ~2 KB vanilla JS.

### Mechanics
- **Bake, don't infer.** Run the headline (14 words, ~79 chars) through the checkpoint once, offline. Take B5H0's attention row at each char position; aggregate per word by averaging the rows of that word's chars ("what does B5H0 look at while reading this word"). Quantize to uint8 → a 14 × 79 matrix, ~1.1 KB, inlined in the page. Bake script `design/sketches/bake_hero_attn.mjs` reuses `niche-infer.js`'s existing prime-processing path (`lastAttn` per consumed char — no generation needed).
- **Hover word W** → every char *before* W gets a selection-style background tint, alpha ∝ weight. Chars after W stay untouched — the causal mask made visible: the model can't see the future, so the highlight only ever spreads left. Mouseleave clears everything.
- **The sink shows.** Position 0 ("C") lights faintly on every hover — that's the real attention sink from the induction post. Leave it in; it's true, and it's a payoff for anyone who reads the post.
- **The induction payoff:** the sentence contains `them … they` and other char-level repeats; some hovers should visibly show the attend-to-what-followed-last-time rule. Which words demo best is an empirical question the bake answers — pick the strongest and consider them for the hint copy.

### UI spec (Emil language)
- **Rest:** headline is byte-identical to today. No affordance animation, ever.
- **Highlight rendering — decision needed (R1 recommended):**
  - **R1 — selection wash:** background tint per char using the site's own selection color (`--gray-500`) at weight-scaled alpha. Reads as "the model is selecting text" — a native metaphor, zero layout shift, readable at all weights.
  - **R2 — underline ticks:** weight-scaled underline segments under attended chars, in the link-underline grays. Quieter; risks reading as broken links.
  - **R3 — flashlight:** dim all chars toward `--gray-800`, keep attended chars ink. Most dramatic, worst for legibility mid-hover; probably too much for the front door.
- **No transitions.** Hover is high-frequency → instant apply, instant clear (same rule as the writing-list hover). This also makes reduced-motion compliance free — there is no motion.
- **Hovered word itself:** stays ink; optional 1px `--gray-400` underline to mark "you are probing this" (same vocabulary as figure borders).
- **Discoverability — decision needed:** an undiscovered easter egg is a no-op, but a loud hint breaks severity. Recommended: one mono 12px line in `--gray-1000` below the hero links, e.g. `a 4.9M-param model is also reading this headline — hover a word`. Alternatives: no hint (pure easter egg), or cursor: crosshair over the headline as a silent tell.
- **Mobile / coarse pointers: hidden** (no spans, no hint) — consistent with the Ask Niche precedent; hover is the whole interaction.
- **A11y:** spans are presentation-only (screen readers read the headline text unchanged); the headline keeps `role="heading" aria-level="1"`; highlights are `aria-hidden` decoration; no focusables added inside the heading.

### Fencing audit (ma5a rules)
Entirely user-caused ✓ · ephemeral & self-deleting on leave ✓ · zero autonomous animation (idle = static, period) ✓ · nothing above content ✓ · ink/sand palette only ✓ · vanilla JS, ~3 KB total ✓ · reduced-motion trivially satisfied ✓ · desktop only ✓.

### Implementation notes
- Headline is a `<p role="heading">` (Quarto h1-hoisting workaround) — JS span-ifies words/chars **at load** (progressive enhancement: no-JS visitors get today's plain headline). Backgrounds only, no font/metric changes → `text-wrap: balance` and CLS are unaffected.
- Uppercase and punctuation go through `niche-infer.js`'s existing unknown-char handling; verify at bake time that the tokenization of the headline round-trips (the Nietzsche corpus is char-level — confirm `C`, `I`, `,`, `.` are in-vocab).
- Files: `assets/hero/hero-attn.js` (+ tiny CSS in `styles.scss`), baked JSON inlined or fetched from `assets/hero/`; bake script stays in `design/sketches/`.

### Alternates considered for the hero
- **2A — photon random walk** (parked): still the best *ambient* option and genuinely pretty, but Ameya already flagged it doesn't fit the current work, and it spends the autonomous-animation budget on physics while the site's story is interp. Stays parked for a future radiative-transfer post.
- **New: live micro-training run** (from micrograd_study / makemore_study): a tiny model trains in the hero on load, loss curve draws itself once (~4 s), then freezes — the "I train small models" half of the sentence. Rejected for the hero: it's autonomous motion at page-open (weakest kind under the fencing rules), has zero replay value, and the training story is better told inside posts. Could resurface someday as a figure, not whimsy.

### Open questions for Ameya
1. Rendering: R1 selection-wash / R2 underline ticks / R3 flashlight? (Recommend R1.)
2. Hint line under the links: yes/no, and copy if yes.
3. Word-level hover only, or char-level (twitchier, more honest to char-level modeling)? (Recommend word-level.)
4. B5H0 only, or a head-picker easter egg (e.g. click cycles heads)? (Recommend B5H0 only — one head is the mascot; a picker is a dashboard.)

---

## Candidate 1 — Induction-head cursor trail (REJECTED 2026-07-10)

Cursor path quantized to cells; re-entering a visited cell replays what followed last time as a ghost running ahead. **Ameya: concept legible in the demo but nobody remembers how they moved their mouse, so the recognition never lands.** The induction energy moved to Ask Niche, where B5H0 is visualized on text — a domain where repetition is perceptible. Full spec in this file's git history.

## Candidate 2 — Photon random walk (parked; hero maybe)

One photon at a time: exponential free paths, scatter, absorb/escape, fading 1px ink polyline. **Ameya: actually interesting for the hero, but doesn't fit the current work.** Parked while the hero stays open; natural resident for a future mc-radiative-transfer post. Demo still live in the artifact.

## Candidate 3 — Niche quotes (CUT 2026-07-22 with the mascot retirement)

- **3A — 404 oracle**: 404 = Niche's room; one bad Nietzsche quote (real samples generated offline from `niche_model.pt`, curated ~30, static JSON), "ask again" instant swap. Static text, ~0 bytes JS.
- **3B — colophon whisper** (optional): last line of the homepage; drop it if it reads as a footer creeping back. **✅ shipped 2026-07-24** — but as a *credit*, not a Niche quote: a faint centred `.site-colophon` line attributing the ma5a panda sprite/engine (MIT). Bare text, homepage-only, no chrome, so it stays a signature rather than a footer.
- Synergy: if the visitor already loaded Ask Niche, "ask again" could sample live; otherwise static JSON.

---

## Build order (revised 2026-07-22)

1. **4 — Ask Niche**: ✅ shipped to the induction-head post (2026-07-10 iv). Stays, post-local.
2. **6 — Panda troupe**: ✅ round 4 replica base done (see Status) → Ameya's round-4 verdicts → next pass on the replica (recolor to sand · hat · calmer fenced behavior · resolve margins-vs-transform tension) → build `assets/pandas/` + Quarto hero include → Playwright verify at 1440/1024/768 + reduced-motion + fence (zero pandas below hero / on posts) → favicon decision.
3. **2A on a radiative-transfer post**: when that post exists.

## Session log
- **2026-07-10 (i)**: Candidates 1–3 fleshed out; live sketches v1; allocation model proposed.
- **2026-07-10 (ii)**: Verdicts — trail rejected, photon parked, Niche promoted. Ask Niche designed; export + JS engine drafted in `sketches/` and verified (parity 1e-5, greedy identical, 177 chars/s).
- **2026-07-10 (iii)**: Ameya decisions: attention stripes, mobile hidden, fp16 lazy-load, squircle→panel UI (stripes/output/input). Panel UI workshopped in Emil language and mocked live in the round-2 artifact (selection chip, download state, streaming, induction-rule stripe sim). Round-1 artifact deleted; new URL above.
- **2026-07-10 (iv)**: **SHIPPED to the induction-head post.** Ameya feedback applied: header slimmed to `N̈ Niche` (params line removed); stripes now settle on the **average attention across all generation steps** at completion (accumulated by absolute token index, stable across window rebuilds) instead of freezing on the last char. Production widget: `assets/niche/ask-niche.{js,css}` + engine + 9.8 MB bundle, `project.resources` added to `_quarto.yml`, loaded via raw-HTML block at the end of `posts/induction-head/index.qmd` (one-line italic invitation above it). Verified headless (Playwright): FAB → panel, real download + generation in-browser, live→averaged captions, selection chip prefill, hidden at 390px, no console errors (only Quarto's pre-existing `listings.json` 404). Not yet committed/deployed — local render only.
- **2026-07-10 (v)**: Hero whimsy planned — candidate 5 "B5H0 reads the headline" proposed as lead (baked offline attention, hover-to-dissect the hero sentence, zero ambient motion); photon walk demoted to hero-alternate; live micro-training run considered and rejected. Awaiting Ameya's verdicts on rendering variant, hint copy, hover granularity, head-picker.
- **2026-07-22 (i)**: Direction amended (Ameya). Niche retired as site-wide mascot — post-specific, and the research is moving to the J-space replication; candidates 5 and 3A cut, Ask Niche demoted to post-local. Homepage whimsy goes identity-native: **panda troupe (candidate 6, lead)**, after Ameya's cross-platform panda avatar. Ambient-alive autonomous motion approved inside the hero fence (geographic fencing is ma5a's actual rule); a troupe = one system = one element. KFP copyright flagged (the avatar is Po) → original panda design, generic straw hat keeps the avatar link.
- **2026-07-22 (ii)**: Panda workshop rounds. R1 flat SVG roamers in a hero replica — rejected (no expressivity). R2 pivot to 2-bit pixel sprites after dissecting ma5a's homepage bunny (PNG sheet + `steps()`): procedural pixel rasterizer, 7 pens. R3 detail pass: 5-tone palette, 6-frame walk, pupils, parameterized expressions, 9 pens. Ameya: still not landing → **scratch, replicate ma5a's "panda collision" pen exactly, build on that later.**
- **2026-07-22 (iii)**: Pen fetched (cdpn.io referer workaround), dissected, and replicated — her verbatim sprite path data + custom decoder + all behavior constants; engine reimplemented; decode verified. Artifact replaced with the replica; working copy saved to `design/sketches/panda-collision-replica.html`. Full spec, next-pass plan, and pending verdicts recorded in candidate 6's Status block.
- **2026-07-22 (iv)**: Round 5 — behavior drafts (hat panda skit + induction walk) on the workshop artifact; working copy `design/sketches/panda-behaviors-workshop.html`. Ameya: the hat still doesn't fit.
- **2026-07-22 (v)**: Round 6 — hat fitting bench (see Status). Walk cells rasterized offline and head contours measured; dǒulì redrawn 28→20 units; per-frame fits with live nudge controls, walk previews, and a `HAT_FIT` readout; induction walk parked. Artifact republished (same URL); working copy updated. **Awaiting Ameya: judge the walk previews, nudge any cells that are off, and paste back the readout table.**
