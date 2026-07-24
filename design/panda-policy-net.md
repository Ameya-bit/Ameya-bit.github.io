# The learned line-walker — a world-model policy for the hat panda

*Drafted 2026-07-24. **Status: idea under discussion — nothing here is decided or scheduled.** This expands Phase 6 of [panda-chaos.md](panda-chaos.md) (parked there post-Phase-5) with the direction Ameya proposed: don't just train a dodging policy — train one that has to build its **own world model**, OthelloGPT-style, and then run a real interp project on it to find out whether it did.*

---

## The pitch (Ameya, 2026-07-24)

Replace the hand-written maneuvering rules (sidestep + dive-roll + weave) with a small neural network that learns to walk the line itself: maneuver the field, watch anomalies, avoid getting swept in. But rather than a plain policy, structure it like OthelloGPT — a model whose training task forces it to build an internal model of the world it can't directly see — and then probe it as a mech-interp study. The site's self-portrait goes fully recursive: a mech-interp site whose mascot is a trained policy, whose brain the site's author then opens up.

## The one load-bearing design decision

**The policy must be partially observed and have memory — or there is no world model to find.**

The Phase 6 sketch in panda-chaos.md (an MLP over nearby positions + velocities) would fail as an interp project: hand the network the world state and there is nothing latent for it to build; probes would just recover input features. What makes OthelloGPT interesting is that the board is never shown — only moves — so the network must *construct* the board to predict legal moves.

The panda engine has exactly the analogous structure:

| Othello | Panda hero |
|---|---|
| Hidden board state | Hidden generative state: director timers, each anomaly's FSM + phase, wobble accumulator, zoomies heading, cascade arming, `cascadeLock` claims |
| Observed move sequence | Observed surface behaviour: rendered positions + poses per frame |
| Task: predict legal moves | Task: dodge well / reach incidents / walk the line |
| Probes recover the board | Probes recover the anomaly FSMs |

So: feed the policy only what a panda could see — egocentric positions/poses over the last N frames, **no velocities, no anomaly flags, no director state** — through a tiny recurrent net or a 2-layer transformer over the frame history. To dodge well it is then *forced* to infer latent state ("that one is mid-zoomies heading NE", "that stack's wobble is near max", "that sleeper is inert — safe ground").

## Why this beats Othello as a study: the knowability spectrum

The engine gives ground truth on **what is knowable in principle**, which the original OthelloGPT setup couldn't pose:

- **Fully inferable** — zoomies heading, loop-ness, stack membership: determined by the observation history. *Positive controls: probes should find these.*
- **Statistically inferable** — time remaining in a nap: the model can at best hold a posterior over the duration distribution. *Graded case: does it encode a decaying estimate?*
- **Provably uninferable** — whether the cascade is armed: zero observable signature until ignition. *Negative control: a probe that "finds" this is finding leakage or artefact.*

The headline question upgrades from "did it build a world model" to **"did it learn exactly the knowable part of the world, and nothing else"** — with built-in controls at every tier. Follow-ups port directly from the OthelloGPT literature: linear probes per latent variable, then interventions along probe directions ("make it believe that panda is zooming") with the live panda flinching on the actual homepage as the demo.

## Training shape

- **Behavioural cloning from the rules baseline first.** The shipped rules-dodge is a *privileged expert* — it reads true engine state (threat speeds, anomaly flags). Cloning its actions from partial observations is literally training the network to reconstruct the state the expert saw (asymmetric-observation imitation, à la DAgger with privileged teachers). The world model is induced by supervised learning alone; RL fine-tuning (reward: avoid knockdowns, reach incidents, stay near the line) is optional polish on top.
- **Tiny model, in-browser inference.** A GRU or 2-layer transformer, d_model 32–64, a few thousand params — a few matmuls per tick, weights exported to JSON, no library. Probing/analysis happens offline in Python on saved activations.
- **i-frames ON in the learned version** (per the Phase 6 note): the roll becomes a committed escape; all skill moves into *when* it rolls. Fail = bad timing or on-cooldown, not bad luck mid-roll.

## Staged plan (each stage independently shippable)

1. **Headless sim extraction.** Pull movement/collision/director/anomaly logic out of `pandas.js` into a pure, DOM-free step function shared by site and trainer; verify parity against recorded traces from the live page. Good engineering for the site regardless (and the sim the trainer rolls out in).
2. **Full-observation BC policy shipped.** Proves the train → export-JSON → in-browser-inference pipeline end to end while the behaviour bar is low ("does he still dodge?"). No interp claims yet. Already makes the hero "a trained policy dodging chaos."
3. **Partial-observation + memory retrain.** The world-model version; replaces the rules dodge for real.
4. **The probing study.** Offline; the knowability-spectrum probes + interventions; publishes as the site's flagship post. Optional endgame: a debug overlay rendering the panda's *beliefs* (inferred anomaly type per neighbour) beside ground truth, live on the homepage.

## Open questions (to discuss before anything starts)

1. **Observation encoding.** Fixed-size egocentric feature vector (k-nearest neighbours' relative positions + pose class per frame) vs. a small grid raster. Nearest-k is cheaper and permutation issues are real either way.
2. **What exactly is the action space?** The rules layer acts at several granularities (stride direction, plant, sidestep, roll, sprint). One flat 10-way head, or a hierarchical keep-doing/act head?
3. **How much history?** N frames at 20Hz vs. a strided window; the nap-posterior question needs seconds of memory, the dodge needs fractions.
4. **Sim language.** Keep the step function in JS (Node rollouts, exact parity by construction) and train in Python on exported trajectories — or port the sim to Python and pay the parity-verification tax for faster rollouts?
5. **Does the hat panda's own effect on the world stay?** He knocks and is knocked (two-way collidable). A policy that learns to exploit its own collisions is on-theme but complicates the "observer" reading.
6. **Scope honesty.** panda-chaos.md already flags this as likely more work than Phases 2–5 combined; stages 3–4 are the bulk. Worth building only for its own sake — which, for this site, it may well be.
