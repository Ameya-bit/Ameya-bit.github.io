# Layer 3 — Whimsy: candidate designs

*2026-07-10. Workshop doc for the whimsy layer (Layer 2 minimap TOC deferred by decision — the current text TOC stays for now). Status: **"Ask Niche" is the lead; engine drafted & tested; UI mocked. Nothing shipped to the site yet.** Parent spec: [direction.md](direction.md); ma5a fencing rules there are binding.*

**Live sketches (round 2 — the Ask Niche panel is working on the page itself):** https://claude.ai/code/artifact/c283ec6b-f6e2-4a6c-8ddb-b710692ba3db
*(Round-1 artifact with the cursor-trail demo was deleted; the trail spec survives in this file's git history.)*

---

## The allocation model (adopted direction)

One element per surface:

| Surface | Whimsy budget | Current candidate |
|---|---|---|
| Homepage / hero | One big signature | **"B5H0 reads the headline" (candidate 5) — proposed lead, awaiting Ameya's verdict**; photon walk (2A) demoted to alternate |
| Each post/project page | One element, **native to that post's topic** | **"Ask Niche" (candidate 4)**; photon walk for a future radiative-transfer post |
| 404 + other utility pages | One quiet resident | Niche quotes (3A) |

Per-post whimsy = the post's subject made live (interactive-figure energy, not decoration); optional per post. One mascot/voice spans everything: **Niche the model, B5H0 its famous head.**

---

## Candidate 4 — "Ask Niche" (LEAD)

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

## Candidate 5 — Hero: "B5H0 reads the headline" (PROPOSED LEAD, 2026-07-10)

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

## Candidate 3 — Niche quotes (alive, part of the Niche fiction)

- **3A — 404 oracle**: 404 = Niche's room; one bad Nietzsche quote (real samples generated offline from `niche_model.pt`, curated ~30, static JSON), "ask again" instant swap. Static text, ~0 bytes JS.
- **3B — colophon whisper** (optional): last line of the homepage; drop it if it reads as a footer creeping back.
- Synergy: if the visitor already loaded Ask Niche, "ask again" could sample live; otherwise static JSON.

---

## Build order (revised)

1. **4 — Ask Niche**: ✅ shipped to the induction-head post (2026-07-10 iv).
2. **5 — Hero "B5H0 reads the headline"**: pending Ameya's verdict on the open questions, then: (a) bake script + verify headline round-trips the vocab, (b) pick the best demo words from real weights, (c) span-ify + hover JS + CSS, (d) Playwright verify at 1440/1024/768 + confirm hidden on coarse pointers.
3. **3A — 404 oracle**: cheap; quote curation run against the checkpoint.
4. **2A on a radiative-transfer post**: when that post exists.

## Session log
- **2026-07-10 (i)**: Candidates 1–3 fleshed out; live sketches v1; allocation model proposed.
- **2026-07-10 (ii)**: Verdicts — trail rejected, photon parked, Niche promoted. Ask Niche designed; export + JS engine drafted in `sketches/` and verified (parity 1e-5, greedy identical, 177 chars/s).
- **2026-07-10 (iii)**: Ameya decisions: attention stripes, mobile hidden, fp16 lazy-load, squircle→panel UI (stripes/output/input). Panel UI workshopped in Emil language and mocked live in the round-2 artifact (selection chip, download state, streaming, induction-rule stripe sim). Round-1 artifact deleted; new URL above.
- **2026-07-10 (iv)**: **SHIPPED to the induction-head post.** Ameya feedback applied: header slimmed to `N̈ Niche` (params line removed); stripes now settle on the **average attention across all generation steps** at completion (accumulated by absolute token index, stable across window rebuilds) instead of freezing on the last char. Production widget: `assets/niche/ask-niche.{js,css}` + engine + 9.8 MB bundle, `project.resources` added to `_quarto.yml`, loaded via raw-HTML block at the end of `posts/induction-head/index.qmd` (one-line italic invitation above it). Verified headless (Playwright): FAB → panel, real download + generation in-browser, live→averaged captions, selection chip prefill, hidden at 390px, no console errors (only Quarto's pre-existing `listings.json` 404). Not yet committed/deployed — local render only.
- **2026-07-10 (v)**: Hero whimsy planned — candidate 5 "B5H0 reads the headline" proposed as lead (baked offline attention, hover-to-dissect the hero sentence, zero ambient motion); photon walk demoted to hero-alternate; live micro-training run considered and rejected. Awaiting Ameya's verdicts on rendering variant, hint copy, hover granularity, head-picker.
