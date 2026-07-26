# The learned line-walker — engineering an emergent world model for the hat panda

*Drafted 2026-07-24; task upgraded to the viewing game the same day; lit-reviewed 2026-07-26; **rewritten 2026-07-26 (v3) as a phased implementation plan.** Status: **direction agreed, nothing built or scheduled.** Expands Phase 6 of [panda-chaos.md](panda-chaos.md).*

*The v3 decision: the world model must **emerge from playing the game** — no supervision on hidden state, ever. The supervised alternative (train belief heads directly on logged ground truth; near-guaranteed to produce "that's a sleeper, ~9s left" as a literal network output, with the debug overlay for free) was weighed 2026-07-26 and set aside. It survives as the **documented fallback** if the emergence run comes up dry, and shares ~80% of the infrastructure below — sim, corpora, logging, export, evals, even the probe tooling. Only Phase E actually commits to emergence; nothing built before it is wasted either way.*

---

## The pitch

Replace the hand-written maneuvering rules (sidestep + dive-roll + weave) with a small transformer that learns to walk the line itself — trained only on the **viewing game** (+points per tick spent within `R_VIEW` of an actively anomalous panda, −large penalty per knockdown, **no incident feed**), from partial egocentric observation, with memory. Structured like OthelloGPT: a training task that cannot be done well without reconstructing hidden state — here, each neighbour's anomaly FSM. Then probed as a real interp project, shipped as the hat panda's brain, and written up as the site's flagship post. The self-portrait goes fully recursive: a mech-interp site whose mascot is a trained policy, whose brain the site's author then opens up.

The policy owns **where to be** (locomotion + attention — what's worth walking to and viewing, that's the game). The **presentation layer stays hand-authored** on top: gaze flourish, plant/inspect poses, the hat-fetch skit, all the character beats. Decisions learned; look hand-made.

## What emergence can and cannot guarantee (the frame the plan hangs on)

You cannot guarantee a *representation*; you can guarantee a *computation*. If the game is engineered so that the achieved score is information-theoretically impossible without inferring the hidden state, then any network reaching that score is computing the latent *somewhere*. So the plan engineers two things separately:

1. **Necessity — hard guarantees available.** Close every reactive and degenerate path to a good score, then *measure* that they're closed:
   - **The reactive yardstick.** Train a deliberately memoryless twin (same architecture, 2-frame window). Its score is the **reactive ceiling**; a privileged **oracle** policy (fed true state) sets the upper bound. The gap between them — the **memory gap** — is the exact quantity of score only a world model can claim. Small gap = the game has a shortcut = *fix the game, not the model*. The gap is the project's health meter from Phase C on.
   - **Twin-episode certificates.** Matched episode pairs identical in every current observable, differing only in hidden history. Flagship: two pandas lying in the same fall cels — one a sleeper (no witnessed collision), one freshly knocked. A policy that approaches one and ignores the other has *behaviorally proven* the event-memory inference, no probes required. One battery per knowability tier.
2. **Legibility — strong pressure, no guarantee.** Diversity along every latent axis, small-but-deep-enough architecture, per-panda token addresses, training long past score saturation. The residual risk — the belief exists but is smeared and entangled rather than linear and compact — is irreducible. It is also what makes this an experiment instead of a construction.

**The purity dial (D2 — defaulted).** Three readings of "emerged from playing": **(1)** reward-only; **(2)** reward + predicting *his own future observations* (action-conditioned, multi-step — no labels, no privileged information; an agent anticipating its own sensory stream is still learning from play); **(3)** model-based RL (world model architecturally mandated — the letter of emergence, not the spirit). **Default: setting 2 is the main arm; setting 1 runs alongside on matched seeds as the aspiration check.** They differ by one loss term, so the purist result comes free if reward-only gets there. The POMDP literature is blunt that setting 1 alone usually yields near-optimal behavior *without* a clean belief state (appendix).

## ⚠️ Required changes to the live simulation (read before anything else)

Everything below Phase A trains against the engine, so the engine moves first. In order of invasiveness:

1. **Fixed-tick determinism refactor — the big one (Phase A).** The engine currently runs on wall-clock time (rAF/timer callbacks, ms-denominated constants like the 0.17px/ms zoomies speed, loops polling at 400ms). It becomes a **fixed 20Hz integer-tick engine**: all `*_MS` and px-per-ms constants re-expressed per-tick; `Math.random()` replaced everywhere in sim logic by a seeded PRNG (mulberry32) carried *inside* sim state; no `Date.now()` in state-affecting code; transcendentals (`Math.sin/exp/pow`) wrapped for swappability. The renderer interpolates between ticks. **Risk: subtle feel drift across every behaviour that was ms-tuned.** Gate: Ameya's preview judgment ([[verify-animations-static-only]]) plus side-by-side trace comparison.
2. **Engine/presentation split (Phase A).** `pandas.js` splits into a pure, DOM-free `step(state, actions) → state` (movement, collision, director, all 8 anomaly FSMs, stack, cascade, hat physics) and a presentation layer (DOM, cels, gaze flourish, skits). Behavior-preserving refactor; golden-trace CI proves browser bundle ≡ Node import byte-for-byte.
3. **Hat-panda action seam + i-frames (Phase A).** The sim accepts the **17-way discrete action interface** (hold / step×8 / dive-roll×8) at 10Hz for the hat panda, and the shipped rules watcher+dodge is wrapped to emit through the *same* interface — expert and policy become plug-swappable and BC targets are exact by construction. The dive-roll gains **i-frames** (agreed 2026-07-24: committed escape; skill moves into *when*). Note this slightly changes live behaviour before any NN exists.
4. **Randomization/config hooks (Phase A–B).** Anomaly duration distributions, kind mix, `ANOM_GAP`, panda count, spawn placement become sim config with defaults = today's live values. The live site is unaffected; training corpora need broad randomization — diversity is a load-bearing emergence lever (legibility forms only along axes the training distribution varies).
5. **Roster freeze (exit of Phase B).** The 8 kinds lock; any new anomaly after corpora are cut forces a retrain.
6. **D1 — field of view: RESOLVED (2026-07-26) → heading-cone FOV.** Touches only the observation encoder, **not** the engine — so this list's engine scope is final: items 1–5 are the complete set of live-sim changes.

**Explicitly not changing:** the other pandas' logic and art, the incident feed (stays, for rules mode and presentation), scoring (`R_VIEW`, caps, bonuses live entirely trainer-side — the live site never computes score), two-way collidability (D4: stays, with an exploit watch in Phase E).

## The game, hardened for emergence

Base score: **+points per tick within `R_VIEW` of a panda whose anomaly is active; −large penalty per knockdown.** Hardening — all trainer-side, every item exists to move score from *reaction* to *inference*:

- **Pay for anticipation, not presence:** early-arrival multiplier (or pay only from arrival onward), so a late walk to a nearly-done nap earns ~nothing. The money moves into "worth the trip?" — the duration posterior.
- **Per-anomaly diminishing returns and/or score cap:** kills camping structurally (no penalty tuning), and mechanizes principle #3 of [panda-chaos.md](panda-chaos.md) — he watches a while, then *moves on*.
- **Small per-step movement cost:** sharpens every trip into a wager on time-remaining.
- **Danger asymmetry does classification pressure:** approaching a zoomies risks the knockdown penalty, a sleeper is free — misclassification is expensive, so kind-inference is consulted continuously.
- **Pre-training geometry audit** for the known degenerate optima: `R_VIEW`-intersection parking, spawn-centroid camping, corner-cowering (watch the penalty/reward ratio), episode-extension exploits. Every closed shortcut widens the memory gap; every open one is an off-ramp from inference.

The knowability spectrum stays the spec's spine, now with teeth at each tier:

| Tier | Example | What forces it | Certificate |
|---|---|---|---|
| Fully inferable | kind + kinematics (zoomies dangerous, sleeper free points, starer vs ordinary idle only via history) | can't score at all without it | twin episodes + probes (positive control) |
| Statistically inferable | duration posterior ("will the nap outlast my walk?") | anticipation pay + movement cost | calibration curves; skip/commit behavior |
| Provably uninferable | cascade arming (zero observable signature until ignition) | nothing — that's the point | negative control; a probe that "finds" it is finding leakage |

**Flagship discrimination:** sleeper vs freshly-knocked — near-identical fall cels, decidable only by remembering whether something collided with it first. Event-memory-into-state; the canonical "you cannot do this reactively."

## Observation model — and D1, the FOV decision

The policy sees only what a panda could see: egocentric neighbour positions + observable pose class per frame, own proprioception (position vs walls + hero-card fence, hat on/off, roll cooldown). No velocities, no anomaly flags, no director state, no incident feed. Per-panda tokens with **persistent slot identity** (sticky k-nearest with hysteresis) — otherwise the net must solve identity binding before it can infer any FSM, a confound, not the study.

**D1 — how much does he see at once? RESOLVED (Ameya, 2026-07-26): variant (b), the heading cone.** Variants kept for the record:

- **(a) Full field** (as originally drafted): all pandas observable every frame. Memory pays only for event history and duration priors — there is no object permanence to learn, because everything is re-derivable by looking. Weakest emergence pressure; zero changes anywhere.
- **(b) Heading-cone FOV — recommended:** he observes pandas within a cone about his heading (plus a short omnidirectional "peripheral" radius). Object permanence becomes real: he must *track* the sleeper he's walking toward while watching elsewhere for threats, carry decaying estimates of pandas not seen for seconds. This is the strongest single emergence lever available, and it hands Phase G its cleanest probe — decodable state for *currently-unseen* pandas can only be memory. Implementation is an observation-encoder mask; **no engine change, no action-space change**; gaze flourish stays cosmetic. In character: he sees where he's looking.
- **(c) Controlled gaze:** look-direction becomes part of the action space (policy chooses where to point the cone independently of heading). Maximal pressure and attention-becomes-literal-attention poetry — but it extends the action space, breaks BC (the rules expert has no gaze policy to clone), requires engine support, and fights the authored gaze presentation. Not for v1; revisit as an add-on era idea.

## Model & training — locked decisions

- **Architecture: 4 layers minimum, d64–128, per-panda tokens, pre-LN, no dropout.** Four layers is the floor, not a sweep endpoint — shallow models hold decodable-but-*causally-unused* state (appendix: the Othello depth study); we need the belief wired into action selection. Width stays tight: overparameterization is what bred OthelloGPT's bag of per-square heuristics. Context 100–200 tokens (strided), with one hard constraint: **the window must cover the knock-to-classification horizon**, or the flagship discrimination is impossible by construction. A GRU-over-window fallback stays warm (small-scale PPO literature: GRU matches or beats attention; if the transformer won't train, the project survives).
- **BC from the rules expert = locomotion/style prior only.** The expert is privileged (reads the incident feed), so naive cloning teaches superstitious beelining and zero information-gathering — the imitation gap, formally established (appendix). RL owns every go/no-go decision. When the Stage-D clone confidently walks to invisible targets, that's the documented phenomenon, not a bug.
- **RL recipe:** critic-only warmup (actor frozen) until advantages are sane, then unfreeze at ~10× lower LR; **KL-to-frozen-BC replaces the entropy bonus** — anti-forgetting, anti-hacking, and the believability anchor in one term; conservative PPO (clip 0.1–0.2, 1–2 epochs/batch, advantage normalization); curriculum via cranked anomaly density; potential-based shaping only if reward starves.
- **The leash schedule is a first-class knob:** the KL anchor actively fights emergence — the expert never gathers information, so a tight leash taxes exactly the scanning/hedging behaviors the belief state exists to drive. Tight early (stability), **deliberately annealed loose mid-training** (information-seeking must be discoverable), re-tightened late if character drifts.
- **Auxiliary loss (setting 2 only):** action-conditioned, multi-step prediction of *his own future observations*. No time-to-live head, no state labels — those are the fallback's tools, and they'd contaminate the emergence claim.
- **Deployment: sample from the softmax (T ≤ 1), never argmax.** Determinism reads as a drone; the KL-anchored policy's entropy is BC-derived character for free.
- **Seeds are budget:** 3–5 policy seeds per arm, 5 probe seeds per probe, distributions reported. Ship-candidate selected jointly on score + twin battery + legibility.
- **Believability is measured, not vibes-only:** action-switch rate, direction reversals, path smoothness, reaction-time distributions vs the expert's traces, tracked per checkpoint. The character gate ([[verify-animations-static-only]] — Ameya judges all motion) still precedes the interp gate; if optimal play reads wrong, the page wins and the post reframes.

## Phases

Each phase is independently shippable or independently informative, with hard exit results. A and D are worth having even if the project stops after them.

### Phase A — engine groundwork *(the only phase that touches the live site's code)*
**Build:** sim changes #1–#3 above (+ #4 config plumbing); golden-trace CI; a lint ban on `Math.random`/`Date.now` inside engine code.
**Done when:**
- The live site runs on the extracted engine and reads identical on the preview (Ameya's judgment).
- Golden traces: 32 seeds × 10k ticks, per-tick checksums byte-identical, browser bundle vs Node import.
- The rules watcher+dodge runs through the 17-action seam at 10Hz (i-frames live) with no visible regression.
- Every engine constant is tick-denominated; renderer interpolation looks clean.

### Phase B — trainer + corpus infrastructure *(no site impact)*
**Build:** Node rollout harness (parallel workers); per-tick ground-truth logging (every anomaly's FSM kind/phase/timers, cascade arm, `cascadeLock` claims) aligned for future activation capture; JSONL trajectory export; corpus configs — natural distribution, cranked density, fully randomized; observation encoder frozen and bit-matched (`Math.fround` at the boundary, cross-language unit tests).
**Done when:** rollouts ≥ ~50k ticks/s/core; a ≥10M-tick randomized training corpus + natural-distribution eval corpus cut and versioned; encoder parity tests green; **roster frozen (change #5).**

### Phase C — the yardstick gate *(game design happens here, where iteration is cheap)*
**Build:** the privileged **oracle** policy (true state as input — or the rules expert, re-scored on the game); the **reactive twin** (2-frame window, same architecture); scripted exploit bots (spawn-centroid camper, `R_VIEW`-intersection parker, corner cowerer); the twin-episode battery, one set per knowability tier.
**Done when:**
- **Memory gap ≥ threshold** (D3; initial proposal: oracle − reactive ≥ ~30% of oracle score).
- Every scripted exploit bot scores much nearer the reactive ceiling than the oracle.
- The oracle passes the twin-episode battery; the reactive twin fails it.
- **If any check fails: iterate the game knobs and re-run this phase. Do not proceed with a leaky game — Phase E cannot succeed against one.**

### Phase D — tracer bullet: full-observation BC policy, shipped *(parallel with C once B is done)*
**Build:** BC clone on *full* observation (the bar is only "does he still dodge"); binary weight export (little-endian blob + JSON manifest, lazy fetch after first paint); hand-rolled JS inference (preallocated `Float32Array`s, zero per-tick allocation, KV cache + recompute-from-ring-buffer debug path); `?policy=rules|nn` kill switch + auto-fallback on NaN/out-of-range logits.
**Done when:** action agreement JS↔PyTorch > 99.9% on seeded episodes; forward pass < 1ms measured in-page; weights ≤ ~400KB on the wire; character pass on live preview. The hero is now literally "a trained policy dodging chaos" — independently worth shipping.

### Phase E — the emergence run
**Build:** partial observation per D1; BC warm-start → the locked RL recipe; **setting-2 main arm + setting-1 aspiration arm, matched seeds**; dense checkpoints (every ~1M steps early); instrumentation probes at every checkpoint (kind/phase/time-remaining decodability vs an untrained-twin baseline, macro-F1 — *instrumentation, not results*); and the **shortcut hunt** loop: score climbing while probes stay flat ⇒ RL found an exploit we didn't ⇒ watch rollouts, find it, patch the game, re-run. That loop, repeated until score and decodability rise together, is what "engineering emergence" means in practice.
**Done when:**
- Score ≥ reactive ceiling + ~70% of the memory gap (it actually claimed the money only a world model can earn).
- Twin-episode battery passes *behaviorally* — flagship: approaches the sleeper, ignores the freshly-knocked.
- Instrumentation decodability clearly above the untrained-baseline gap and rising through training.
- Believability metrics in band; leash schedule executed as designed.
- ≥3 seeds; setting-1 arm's outcome recorded either way (it succeeding = the purist headline; it failing = the measured cost of purity).
- **Fallback trigger:** if repeated shortcut-hunt iterations can't get decodability moving while score saturates, the supervised-belief fallback activates — same infra, one loss change — and the post becomes "what control pressure doesn't buy."

### Phase F — ship the learned line-walker
**Done when:** the Phase-E policy is live behind the seam (sampling deployment, fallback verified) and passes Ameya's character gate on the homepage preview. If the best-scoring policy fails the gate, the ship candidate is the best *character*, or the site stays on rules — the page wins over the number, always.

### Phase G — the probing study + the post
**Build (offline, Python, on saved activations + logged ground truth):** the full control battery — untrained-network gap (expect random weights to probe *well above chance*; report the gap), shuffled-label selectivity, magnitude-matched random-direction intervention controls, bag-of-heuristics slot/region transfer tests, value-entanglement control (decodability on reward-neutral configurations), and — under D1(b) — the memory control (state of currently-unseen pandas). Egocentric probe bases (labels relative to *his* evidence stream; if linear probes fail, suspect the basis first). Bayes-posterior calibration curves vs observation time — the POMDP novelty over Othello/chess. Read-layer and write-layer swept independently; interventions by simple vector arithmetic with a swept scale; scored by edited-belief-consistent action mass. The homepage flinch demo ("make him believe that panda is zooming"); optional belief overlay beside ground truth.
**Done when:** every positive claim has its controls, every negative is written up honestly, and the flagship post ships.

## Open decisions

- **D1 — FOV: ~~open~~ RESOLVED (Ameya, 2026-07-26): heading-cone FOV (variant b).** Observation-encoder mask only — no engine change, no action-space change; gaze flourish stays cosmetic. Cone angle + peripheral radius are Phase C tunables (they directly move the memory gap). Controlled gaze (c) parked as an add-on-era idea.
- **D2 — purity dial:** defaulted above (setting 2 main + setting 1 alongside). Veto point.
- **D3 — memory-gap threshold + reward magnitudes + `R_VIEW`:** Phase C empiricism. Structural knobs (caps, diminishing returns, anticipation pay) before magnitude knobs; the +view/−hit ratio still sets the personality.
- **D4 — his own two-way collidability:** keep (on-theme), with an explicit exploit watch in Phase E (a policy weaponizing its own collisions is a hackable lever).
- **D5 — scope honesty:** unchanged — a season, not a sprint. Phases A and D are each independently worth having; the fallback means even a failed Phase E produces the site's brain and a post.

## Appendix — what the prior art says (lit review 2026-07-26, compressed)

**The OthelloGPT lineage** ([Li et al.](https://arxiv.org/abs/2210.13382) → [Nanda's linear reframing](https://www.neelnanda.io/mechanistic-interpretability/othello) → [Chess-GPT](https://arxiv.org/abs/2403.15498) → [bag-of-heuristics](https://www.lesswrong.com/posts/gcpNuEZnxAPayaKBY/othellogpt-learned-a-bag-of-heuristics-1) → [Hidden Pieces](https://ial.eecs.ucf.edu/pdf/Sukthankar-Austin-ICMLA2024.pdf) → [depth study](https://arxiv.org/abs/2310.07582)): probe-only claims died twice (nonlinear→linear via basis choice; world-model→heuristic-pile via neuron analysis); only intervention-backed claims survived. Untrained nets probe far above chance (66% vs 89% trained — report the gap). Interventions: simple vector arithmetic beat fancier methods, scale is critical, read- and write-layers peak at different depths, steering works best off-distribution. 1-layer models hold decodable-but-causally-unused state; ~4 layers was the causal threshold. Chess-GPT also grew an *unsupervised* skill latent — probe for our analogs (global chaos level, time-into-episode).

**World models in RL policies** ([Sokoban planning, ICLR 2025 oral](https://arxiv.org/abs/2504.01871); [cheese-vector steering](https://www.lesswrong.com/posts/cAC4AXiNC5ig6jQnc/understanding-and-controlling-a-maze-solving-policy-network); [Leela look-ahead](https://arxiv.org/abs/2406.00877); [meta-RL belief probing](https://arxiv.org/pdf/2510.22039); [AlphaZero concepts](https://arxiv.org/abs/2111.09259)): control pressure alone *can* produce causally-used state — when the representation is instrumentally unavoidable, training is diverse along that axis, and the architecture gives it an address (Sokoban's cell↔square bijection; our per-panda tokens). In POMDP belief-tracking specifically, reward-only agents typically get behavior *without* a clean belief; predictive auxiliaries reliably produce one ([2310.06089](https://arxiv.org/abs/2310.06089): reward-only nets warp representation space around rewarding states; predictive nets capture global structure). Representations arrive redundant (cheese lived in ~11 channels — if a 1-D edit fails, try whole-layer difference vectors); mechanism-present ≠ mechanism-used (measure action *and* score change under belief patching). Emergent tracking of *other agents'* hidden FSMs by a reward-trained policy is nearly unstudied — real novelty, matching risk.

**BC→RL practice** ([VPT](https://arxiv.org/pdf/2206.11795); [AlphaStar](https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf); [PIRLNav](https://arxiv.org/abs/2301.07302); [ADVISOR](https://arxiv.org/abs/2007.12173); [GTrXL](https://proceedings.mlr.press/v119/parisotto20a/parisotto20a.pdf); [POPGym](https://arxiv.org/pdf/2303.01859); [specification gaming](https://deepmind.google/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)): KL-to-frozen-BC replaces the entropy bonus and is the anti-forgetting/anti-hacking/believability mechanism in one; a fresh critic's advantages destroy a BC policy without critic warmup; the imitation gap means privileged experts teach superstitious beelining (DAgger doesn't fix it); per-tick proximity rewards always breed parking equilibria — change the reward's shape, don't penalize after the fact; pre-LN or transformers may not train under RL at all; GRU is a legitimate small-scale fallback; ABC-RL-style action-thrash penalties and stochastic deployment for character.

**Shipped in-browser agents** ([REINFORCEjs](https://github.com/karpathy/reinforcejs); [llama2.ts](https://github.com/wizzard0/llama2.ts) — binary-identical pure-TS inference; [WebGPT](https://github.com/0hq/WebGPT); [snake-dqn](https://github.com/tensorflow/tfjs-examples/tree/master/snake-dqn); [poke-env](https://github.com/hsahovic/poke-env); [float determinism](https://gafferongames.com/post/floating_point_determinism/)): hand-rolled typed-array JS is the *fast* option at sub-1M params (ORT-web ≈ 10MB wasm; TF.js = leak discipline for nothing); sub-ms forward passes well-evidenced; keep the sim in JS — nobody ports the sim (ML-Agents/poke-env); Node throughput only bottlenecks at billions of on-policy steps; JS↔JS bit-determinism is easy (IEEE-754 pinned) with seeded PRNG + integer ticks + golden traces; Python↔JS policy parity is statistical (>99.9% action agreement — near-tie argmax flips at 1e-6 are expected and harmless); binary weights + manifest, never JSON floats.
