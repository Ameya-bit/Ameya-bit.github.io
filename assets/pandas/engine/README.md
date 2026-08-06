# The hero panda engine (runtime copy — currently dormant)

The deterministic fixed-tick simulation + renderer + rules expert that drove the
home-page pandas. **Nothing loads it right now:** the `#panda-stage` div and the
loader script came out of `index.qmd` on 2026-08-03 — whimsy waits until the
minimal base stands on its own (`design/direction.md`, Layer 3). The files stay
in place, shipped but unreferenced, so the decision is a one-commit revert
rather than an archaeology exercise.

**This is a deployed artifact, not the project:** development
happens in [Ameya-bit/panda-engine](https://github.com/Ameya-bit/panda-engine)
(engine, NN trainer, design docs, tests), and this directory is refreshed from
there by that repo's `tools/sync-site.sh`.

Deliberately absent here: the NN policy layer (`policy/`, the worker/driver
files), the test suite, and the dev tools — the site ships the rules watcher
only (decided 2026-08-02), and everything under `assets/pandas/` is swept into
`_site` by a Quarto render, so dev files would be published.

One file is maintained in THIS repo and never synced: `render/site.js` (the
page entry point — the panda-engine copy carries the `?policy=nn` wiring this
one intentionally lacks). When the loader is restored, `index.qmd` picks this
engine by default and `?engine=old` selects the original `../pandas.js`, the
reference the port was judged byte-for-byte against.
