"""Recompute every number the pulse-profile post shows, and cache it here.

Run with the research repo on hand (it has the engine, the anchors, and the
committed evidence base):

    MCRT_REPO=~/reserach_proj/mc-radiative-transfer python3 compute.py

Everything below is lifted from `docs/paper/poster/updated_graphs/
make_updated_figs.py` in github.com/Ameya-bit/mc-radiative-transfer — same
engine calls, same anchors, same committed `.npz` evidence files — so this
cache is a faithful replay rather than a second experiment. `plot.py` reads
`_data.npz` and needs only numpy + matplotlib, which is what lets the figures
be restyled without the research repo present at all.

Two kinds of number live in the source, and the distinction is worth keeping:

  * SCALARS AND SWEEPS come from the committed `.npz` evidence base under
    `data/`, which is the archived output of the long production runs (seed
    ensembles, the tau sweeps, the phase-diagram grid). They are read, not
    rerun — rerunning them is hours of Monte Carlo and the archive is what the
    manuscript quotes.
  * THE FOUR PULSE PROFILES are recomputed live, because they are cheap
    (~0.02s each) and because a curve is exactly the thing that should not be
    transcribed by hand.

The cache is checked against the post's own prose at the bottom of this file.
If a number the text quotes stops matching, this script fails rather than
writing a cache that silently disagrees with the paragraph beside it.
"""

import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
ROOT = Path(os.environ.get(
    "MCRT_REPO", Path.home() / "reserach_proj" / "mc-radiative-transfer"))
DATA = ROOT / "data"

if not DATA.is_dir():
    sys.exit(f"no evidence base at {DATA} — set MCRT_REPO to the research repo")

# The repo's own scripts import each other as top-level modules and several of
# its helpers resolve data paths relative to the repo root, so both directories
# go on the path and the process runs from the root. Same contract as running
# make_updated_figs.py in place.
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "scripts")]
os.chdir(ROOT)

from mcrt.beaming import beaming_lookup                      # noqa: E402
from mcrt.bending import ExactBending                        # noqa: E402
from mcrt.theory import chandrasekhar_h                      # noqa: E402
from mcrt.theory import eddington_limb_darkening             # noqa: E402
from anchor_lib import multi_spot_flux, shape_tau_index      # noqa: E402
from j0740_anchor import RILEY as J0740_RILEY                # noqa: E402
from j0740_anchor import MILLER as J0740_MILLER              # noqa: E402
from j0030_anchor import RILEY as J0030_RILEY                # noqa: E402
from j0030_anchor import MILLER as J0030_MILLER              # noqa: E402
from code_comparison import COMPACTNESS as SD_U              # noqa: E402
from code_comparison import load_reference, our_profile_at   # noqa: E402
from c1_doppler_validate import monochromatic_flux           # noqa: E402

out = {}

PHASE = np.linspace(0, 1, 1024, endpoint=False)
out["phase"] = PHASE


def pulsed_fraction(flux):
    """The post's one score: how deeply the light curve breathes."""
    lo, hi = float(flux.min()), float(flux.max())
    return (hi - lo) / (hi + lo) if (hi + lo) > 0 else 0.0


def peak(x):
    return np.asarray(x) / np.asarray(x).max()


# ---------------------------------------------------------------------------
# The beaming function at the production optical depth (tau = 10).
# ---------------------------------------------------------------------------
lib = np.load(DATA / "beaming_library.npz")
TAU_I = shape_tau_index(lib["tau_values"])
BEAMING = beaming_lookup(lib["mu_centers"], lib["intensity_by_tau"][TAU_I])


# ---------------------------------------------------------------------------
# fig1 — validation: the engine against theory, before anything is trusted.
# ---------------------------------------------------------------------------
h = np.load(DATA / "d_isotropic_h.npz")
mu = h["mu_centers"]
mu_fine = np.linspace(1e-3, 1, 300)

out["v_mu"] = mu
out["v_mu_fine"] = mu_fine
out["v_h_exact"] = chandrasekhar_h(mu_fine) / chandrasekhar_h(np.array([1.0]))[0]
out["v_eddington"] = (eddington_limb_darkening(mu_fine)
                      / eddington_limb_darkening(np.array([1.0]))[0])
for tag in ("isotropic", "thomson"):
    out[f"v_{tag}_mean"] = h[f"{tag}_i_mean"]
    out[f"v_{tag}_sem"] = h[f"{tag}_sem"]
    out[f"v_{tag}_resid"] = h[f"{tag}_residual_flux"]
out["v_chi2"] = float(np.atleast_1d(h["isotropic_reduced_chi2"])[0])

# (b) the static benchmark, and (c) the rotating one at 200 Hz.
ph_s, ref_s = load_reference(str(DATA / "l26_reference/SD1a_test_IM.txt"))
ours_s = our_profile_at(ph_s, bending=ExactBending(SD_U))
out["v_static_phase"] = ph_s
out["v_static_ref"] = peak(ref_s)
out["v_static_ours"] = peak(ours_s)
out["v_static_resid"] = 100 * (peak(ours_s) - peak(ref_s))

ref_c = np.loadtxt(DATA / "l26_reference/SD1c_test_IM.txt")
ph_c, f_refc = ref_c[:, 0], ref_c[:, 1]
ours_c = monochromatic_flux(ph_c, 200.0, with_time_delay=True)
out["v_spin_phase"] = ph_c
out["v_spin_ref"] = peak(f_refc)
out["v_spin_ours"] = peak(ours_c)
out["v_spin_resid"] = 100 * (peak(ours_c) - peak(f_refc))


# ---------------------------------------------------------------------------
# fig2 / fig3 — the two anchors, modeled both ways.
#
# J0740 uses the exact bending map (the ~1% linear approximation was a 2-sigma
# bias on the final number); J0030's published anchor numbers are quoted under
# the linear map, so it stays there. That asymmetry is the research repo's, and
# copying it is the point of a replay.
# ---------------------------------------------------------------------------
ANCHORS = (
    ("j0740", "riley", J0740_RILEY, True),
    ("j0740", "miller", J0740_MILLER, True),
    ("j0030", "riley", J0030_RILEY, False),
    ("j0030", "miller", J0030_MILLER, False),
)

for star, team, anchor, exact in ANCHORS:
    bending = ExactBending(anchor.compactness) if exact else None
    iso = multi_spot_flux(anchor.inclination, anchor.compactness,
                          anchor.spots, None, bending=bending)
    real = multi_spot_flux(anchor.inclination, anchor.compactness,
                           anchor.spots, BEAMING, bending=bending)
    key = f"{star}_{team}"
    out[f"{key}_iso"] = peak(iso)
    out[f"{key}_real"] = peak(real)
    out[f"{key}_dpf"] = pulsed_fraction(real) - pulsed_fraction(iso)
    out[f"{key}_pf_iso"] = pulsed_fraction(iso)
    out[f"{key}_pf_real"] = pulsed_fraction(real)
    out[f"{key}_shape_rms"] = float(np.sqrt(np.mean((peak(real) - peak(iso)) ** 2)))

# The tau sweeps and their seed-scatter error bars, from the archive.
#
# The two anchors carry DIFFERENT sweeps, and that asymmetry is the finding
# rather than a gap in the data: J0740's third panel plots dPF against optical
# depth, and J0030's cannot, because its dPF is identically zero at every tau.
# The archive has no `delta_pf` array for J0030 at all. What it has instead is
# the waveform-shape rms — the measurement the error moved into.
seeds = np.load(DATA / "a3_seed_errors.npz")
for star in ("j0740", "j0030"):
    anc = np.load(DATA / f"{star}_anchor.npz")
    out[f"{star}_tau"] = anc["tau_values"]
    for team in ("riley", "miller"):
        out[f"{star}_{team}_shape_tau"] = anc[f"{team}_shape_rms"]
        if star == "j0740":
            out[f"{star}_{team}_dpf_tau"] = anc[f"{team}_delta_pf"]
            out[f"{star}_{team}_tau_err"] = seeds[f"j0740_{team}_dpf_std"]
        else:
            out[f"{star}_{team}_tau_err"] = seeds[f"j0030_{team}_shape_std"]


# ---------------------------------------------------------------------------
# fig4 — the routing ladder: spin, band, and light-travel delay, one rung at a
# time. Rung order mirrors Table 2 of the manuscript.
# ---------------------------------------------------------------------------
c3 = np.load(DATA / "c3_band_doppler.npz")
c4 = np.load(DATA / "c4_caveat_audit.npz")
anc740 = np.load(DATA / "j0740_anchor.npz")


def s3(key):
    return float(np.atleast_1d(c3[key])[0])


def s4(key):
    return float(np.atleast_1d(c4[key])[0])


out["rungs"] = np.array([
    "static, bolometric",
    "346.5 Hz, bolometric",
    "346.5 Hz, NICER band",
    "+ light-travel delay, bolometric",
    "+ light-travel delay, band",
])

ti = shape_tau_index(anc740["tau_values"])
for team in ("riley", "miller"):
    out[f"rung_{team}_dpf"] = np.array([
        s3(f"j0740_{team}_0hz_m"),
        s3(f"j0740_{team}_d4_m"),
        s3(f"j0740_{team}_band_ph_m"),
        s3(f"j0740_{team}_d4_m") + s4(f"j0740_{team}_delay_d4_shift"),
        s3(f"j0740_{team}_band_ph_m") + s4(f"j0740_{team}_delay_band_ph_shift"),
    ])
    out[f"rung_{team}_err"] = np.array([
        s3(f"j0740_{team}_0hz_s"),
        s3(f"j0740_{team}_d4_s"),
        s3(f"j0740_{team}_band_ph_s"),
        s4(f"j0740_{team}_delay_d4_sigma"),
        s4(f"j0740_{team}_delay_band_ph_sigma"),
    ])
    # Shape rms is only measured on three of the five rungs; NaN is the honest
    # marker for "not measured here" and plot.py skips those points rather than
    # interpolating a line through them.
    out[f"rung_{team}_shape"] = np.array([
        float(anc740[f"{team}_shape_rms"][ti]),
        np.nan,
        s3(f"j0740_{team}_band_shape_rms"),
        np.nan,
        float(np.atleast_1d(c4[f"j0740_{team}_warp_shape_band_ph_rms"])[0]),
    ])


# ---------------------------------------------------------------------------
# fig5 — the phase diagram: two spacetimes, one map.
# ---------------------------------------------------------------------------
pd = np.load(DATA / "phase_diagram.npz")
r1 = np.load(DATA / "r1_revision_checks.npz")

out["pd_dphi"] = pd["dphi_axis"]
out["pd_theta"] = pd["theta_axis_deg"]
for star in ("j0740", "j0030"):
    # float32 on the two 2D grids only. They are read by a colormap and a
    # contour, neither of which resolves anything past seven digits, and at
    # float64 these four arrays are 80% of the cache — which is the file
    # everyone who clones the repo pays for. The axes, the boundaries and every
    # scalar stay float64.
    out[f"pd_{star}_dpf"] = pd[f"{star}_delta_pf"].astype(np.float32)
    out[f"pd_{star}_floor"] = pd[f"{star}_flux_floor"].astype(np.float32)
    out[f"pd_{star}_boundary"] = np.asarray(pd[f"{star}_boundary"], dtype=float)
    out[f"pd_{star}_boundary_exact"] = np.asarray(
        r1[f"r4_{star}_boundary_exact"], dtype=float)
    for team in ("riley", "miller"):
        out[f"pd_{star}_{team}_dphi"] = float(pd[f"{star}_{team}_dphi"])
        out[f"pd_{star}_{team}_theta"] = float(pd[f"{star}_{team}_theta_deg"])


# ---------------------------------------------------------------------------
# The cache is checked against the post's own prose before it is written.
#
# These are the numbers the text quotes in sentences, which are the ones a
# reader can catch drifting. A tolerance rather than equality: the profiles are
# recomputed here and the archive's scalars came from seed ensembles, so exact
# agreement is not the claim — agreement to the precision the post prints is.
# ---------------------------------------------------------------------------
CLAIMS = [
    ("J0740 Riley dPF          +0.137", out["j0740_riley_dpf"], 0.137, 0.004),
    ("J0740 Miller dPF         +0.195", out["j0740_miller_dpf"], 0.195, 0.006),
    ("J0030 Riley dPF           0.000", out["j0030_riley_dpf"], 0.0, 1e-9),
    ("J0030 Miller dPF          0.000", out["j0030_miller_dpf"], 0.0, 1e-9),
    ("J0030 Riley PF            1.000", out["j0030_riley_pf_real"], 1.0, 1e-9),
    ("J0030 Miller PF           1.000", out["j0030_miller_pf_real"], 1.0, 1e-9),
    ("J0030 Riley shape rms     0.061", out["j0030_riley_shape_rms"], 0.061, 0.002),
    ("J0030 Miller shape rms    0.058", out["j0030_miller_shape_rms"], 0.058, 0.002),
    ("chi2/dof                   0.70", out["v_chi2"], 0.70, 0.01),
    ("static benchmark max      0.11%", np.abs(out["v_static_resid"]).max(), 0.11, 0.01),
    ("rotating benchmark max    1.35%", np.abs(out["v_spin_resid"]).max(), 1.35, 0.02),
    ("Riley spin collapse      +0.037", out["rung_riley_dpf"][1], 0.037, 0.002),
    ("Miller spin collapse     +0.061", out["rung_miller_dpf"][1], 0.061, 0.002),
    ("Riley band               +0.019", out["rung_riley_dpf"][2], 0.019, 0.002),
    ("Miller band              +0.045", out["rung_miller_dpf"][2], 0.045, 0.002),
]

bad = []
print("\nchecking the cache against the post's prose:")
for label, got, want, tol in CLAIMS:
    ok = abs(float(got) - want) <= tol
    print(f"  {'ok ' if ok else 'BAD'}  {label}   got {float(got):+.4f}")
    if not ok:
        bad.append(label)
if bad:
    sys.exit(f"\n{len(bad)} number(s) no longer match the post: " + "; ".join(bad))

np.savez_compressed(HERE / "_data.npz", **out)
size = (HERE / "_data.npz").stat().st_size
print(f"\nwrote {HERE / '_data.npz'}  ({size / 1024:.1f} KB, {len(out)} arrays)")
