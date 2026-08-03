# The hero panda engine (runtime copy)

The deterministic fixed-tick simulation + renderer + rules expert that drives the
home-page pandas. **This is a deployed artifact, not the project:** development
happens in [Ameya-bit/panda-engine](https://github.com/Ameya-bit/panda-engine)
(engine, NN trainer, design docs, tests), and this directory is refreshed from
there by that repo's `tools/sync-site.sh`.

Deliberately absent here: the NN policy layer (`policy/`, the worker/driver
files), the test suite, and the dev tools — the site ships the rules watcher
only (decided 2026-08-02), and everything under `assets/pandas/` is swept into
`_site` by a Quarto render, so dev files would be published.

One file is maintained in THIS repo and never synced: `render/site.js` (the
page entry point — the panda-engine copy carries the `?policy=nn` wiring this
one intentionally lacks). `index.qmd` picks this engine by default;
`?engine=old` keeps the original `../pandas.js` as the reference.
