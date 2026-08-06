"""Draw the pulse-profile post's figures from `_data.npz`.

    python3 plot.py

Needs only numpy + matplotlib — `compute.py` has already done the physics.

The rules are in `design/figures.mplstyle` and `design/direction.md`:

  * ONE WIDTH. Every figure exports at 8.0in x 160dpi = 1280px and displays at
    846px, transformer-circuits' 1.5x rule. This post's previous set came out
    of the manuscript pipeline at 1980px — sized for a Springer text block, not
    for this column — so it downscaled at 0.43x against the other posts' 0.66x
    and its labels rendered visibly smaller than theirs on the same page.
  * NO IN-FIGURE TITLES. The caption is the title.
  * ONE ACCENT. Vermillion #d55e00 means "this is the finding."
  * COLORMAPS BY MEANING.

WHAT CHANGED FROM THE MANUSCRIPT FIGURES, AND WHY.

The paper's set encodes Riley = blue, Miller = vermillion: hue carries WHOSE
FIT a curve is. That is a reasonable convention for a journal, where the two
teams' analyses are the subject under comparison. It is the wrong convention
here, because this post is not about the two teams — it is about one error and
where it hides. Hue spent on authorship is hue unavailable for the argument,
and it costs the site's accent rule its meaning: if vermillion is "Miller,"
vermillion can no longer be "this is the finding."

So the encoding is rebuilt around the claim instead:

    isotropic (the shortcut under test)  -> gray, dashed
    realistic I(mu) (the honest model)   -> ink, solid
    THE BIAS BETWEEN THEM                -> vermillion

and Riley versus Miller is carried by marker shape and a direct label, which is
what the paper's own design contract already said it preferred over legends.
The consequence worth having: in fig4 the accent falls on the one panel whose
number does not move, so the figure states the post's conclusion in colour.

The result reads as one set with the other posts' figures, and the reader is
never asked to remember which team is which colour in order to follow the
physics.
"""

from pathlib import Path

import matplotlib
import numpy as np

# Agg BEFORE pyplot, and this line is load-bearing rather than boilerplate. On
# macOS the default backend is `macosx`, which carries a 2x device-pixel ratio,
# and savefig honours it: the same 8.0in figure the style file pins to 1280px
# writes a 2560px file instead. That is silent — nothing warns, the figure looks
# correct, and the one-width rule is broken by a factor of two depending on
# which machine ran the script. A script whose only output is a file has no
# business selecting an interactive backend anyway.
matplotlib.use("Agg")

from matplotlib import font_manager                            # noqa: E402
from matplotlib import patheffects as pe                       # noqa: E402
from matplotlib import pyplot as plt                           # noqa: E402
from matplotlib.colors import LinearSegmentedColormap          # noqa: E402

HERE = Path(__file__).parent
DESIGN = HERE.parents[2] / "design"

# Nunito is the site's typeface but loads from Google Fonts, so it is not on the
# system font path. Register the static instances vendored in design/fonts/ and
# the figures speak the page's voice instead of falling back to DejaVu Sans.
for ttf in sorted((DESIGN / "fonts").glob("*.ttf")):
    font_manager.fontManager.addfont(str(ttf))

plt.style.use(str(DESIGN / "figures.mplstyle"))

# --- The site's tokens, straight from design/direction.md --------------------
INK = "#21201c"        # --gray-1200
SECONDARY = "#63635e"  # --gray-1100
TERTIARY = "#6f6f69"   # --gray-1000
BORDER = "#bcbbb5"     # --gray-800
RULE = "#e9e9e7"       # --gray-400
PAGE = "#fdfdfc"       # --gray-100
ACCENT = "#d55e00"     # marks
ACCENT_INK = "#b04d00" # accent text (5.28:1)

WIDTH = 8.0            # inches; 8.0 * 160dpi = 1280px. Never changes.

# Delta-PF on the phase diagram is one-signed — it runs 0 to +0.18, and a
# negative bias is not a thing this map contains — so the map is SEQUENTIAL from
# zero. A diverging map would invent a midpoint and imply the bias changes sign
# somewhere on the grid, which is exactly the false reading the style file warns
# about. Built from the site's own warm ramp rather than borrowed from magma, so
# the one figure on the page that carries a colormap still belongs to the page:
# page white through the accent to a deep burnt brown, lightness monotonic so it
# survives grayscale printing and low-vision viewing.
WARM = LinearSegmentedColormap.from_list(
    "site_warm", [PAGE, "#f6e3d0", "#eab583", "#d55e00", "#8f3a00", "#4a1d00"])

# Anything drawn ON the colormap has to survive both ends of that ramp, and one
# treatment does it: INK with a page-coloured stroke around it. Over the light
# end the ink carries the shape and the halo is invisible; over the dark end the
# halo carries it and the ink reads as depth. The obvious alternative — page
# white with an ink stroke — fails in the light region, where white text on a
# near-white ground leaves nothing but a thin outline to read. The first draft
# of fig5 did exactly that and its "PF saturated" label sat in the palest corner
# of the map.
HALO = [pe.withStroke(linewidth=2.6, foreground=PAGE)]

d = np.load(HERE / "_data.npz", allow_pickle=True)


def tag(ax, letter, x=0.015, y=1.0):
    """Panel letter. The style file's one sanctioned in-figure label."""
    ax.text(x, y, f"({letter})", transform=ax.transAxes, fontsize=10,
            fontweight="semibold", color=INK, va="bottom", ha="left")


def save(fig, name):
    path = HERE / f"{name}.png"
    fig.savefig(path)
    plt.close(fig)
    px = fig.get_size_inches() * fig.dpi
    print(f"  {path.name}  {int(px[0])}x{int(px[1])}px  "
          f"{path.stat().st_size / 1024:.0f} KB")


# ===========================================================================
# fig1 — validation: the engine against theory, before anything is trusted
# ===========================================================================

def fig_validation():
    fig = plt.figure(figsize=(WIDTH, 4.3))
    gs = fig.add_gridspec(2, 3, height_ratios=[2.5, 1.0], hspace=0.06)
    top = [fig.add_subplot(gs[0, k]) for k in range(3)]
    bot = [fig.add_subplot(gs[1, k], sharex=top[k]) for k in range(3)]

    # ---- (a) the transport against Chandrasekhar's exact H(mu) ------------
    ax, axr = top[0], bot[0]
    ax.plot(d["v_mu_fine"], d["v_h_exact"], color=INK, lw=1.6,
            label=r"$H(\mu)$ exact", zorder=3)
    ax.plot(d["v_mu_fine"], d["v_eddington"], color=BORDER, ls=":", lw=1.4,
            label=r"Eddington $1+\frac{3}{2}\mu$", zorder=2)
    ax.errorbar(d["v_mu"], d["v_isotropic_mean"], yerr=d["v_isotropic_sem"],
                ls="none", marker="o", ms=3.6, color=ACCENT, lw=1,
                label="this engine", zorder=4)
    ax.errorbar(d["v_mu"], d["v_thomson_mean"], yerr=d["v_thomson_sem"],
                ls="none", marker="s", ms=3.2, color=SECONDARY, lw=1,
                label="Thomson slab", zorder=4)
    ax.set_ylabel(r"$I(\mu)\,/\,I(1)$")
    ax.legend(loc="lower right", fontsize=8, handlelength=1.3,
              labelspacing=0.28, borderaxespad=0.3)
    ax.text(0.04, 0.70, rf"$\chi^2/\mathrm{{dof}} = {float(d['v_chi2']):.2f}$",
            transform=ax.transAxes, fontsize=8.5, color=TERTIARY)
    tag(ax, "a")

    # The +/-2 sigma band is the acceptance criterion, so it is drawn as the
    # region rather than stated in a caption the reader has to hold in mind.
    axr.axhspan(-2, 2, color=RULE, zorder=0)
    axr.axhline(0, color=BORDER, lw=0.8)
    axr.plot(d["v_mu"], d["v_isotropic_resid"], "o", ms=3, color=ACCENT)
    axr.plot(d["v_mu"], d["v_thomson_resid"], "s", ms=2.8, color=SECONDARY)
    axr.set_ylim(-3.2, 3.2)
    axr.set_yticks([-2, 0, 2])
    axr.set_xlabel(r"$\mu = \cos\theta$")
    axr.set_ylabel(r"$\Delta/\sigma$")

    # ---- (b, c) the pulse machinery against published waveforms -----------
    panels = [
        ("b", "v_static_phase", "v_static_ref", "v_static_ours",
         "v_static_resid", "reference (SD1a)", "this work", None),
        ("c", "v_spin_phase", "v_spin_ref", "v_spin_ours",
         "v_spin_resid", "reference (SD1c)", "this work, 200 Hz", "static"),
    ]
    for i, (letter, kph, kref, kours, kres, lref, lours, extra) in enumerate(panels, 1):
        ax, axr = top[i], bot[i]
        ph = d[kph]
        if extra:
            ax.plot(d["v_static_phase"], d["v_static_ref"], color=RULE, lw=1.4,
                    label=extra, zorder=1)
        ax.plot(ph, d[kref], color=INK, lw=1.6, label=lref, zorder=2)
        ax.plot(ph[::3], d[kours][::3], "o", ms=3.6, color=ACCENT, label=lours,
                zorder=3)
        # Upper centre, not lower: these profiles are U-shaped and their flux
        # floor runs along the bottom of the panel, which is exactly where a
        # lower-centre legend lands on top of the data.
        ax.legend(loc="upper center", fontsize=8, handlelength=1.3,
                  labelspacing=0.28, borderaxespad=0.4)
        worst = np.abs(d[kres]).max()
        ax.text(0.5, 0.30, rf"max $|\Delta| = {worst:.2f}\%$",
                transform=ax.transAxes, fontsize=8.5, color=TERTIARY,
                ha="center")
        ax.set_ylim(-0.05, 1.42)
        tag(ax, letter)

        axr.axhline(0, color=BORDER, lw=0.8)
        axr.plot(ph, d[kres], color=ACCENT, lw=1.2)
        axr.set_xlabel(r"Rotational phase $\varphi/2\pi$")
    top[1].set_ylabel(r"$F(\varphi)\,/\,F_{\max}$")
    bot[1].set_ylabel("$\\Delta$ (% peak)")

    for ax in top:
        plt.setp(ax.get_xticklabels(), visible=False)
    save(fig, "fig1_validation")


# ===========================================================================
# fig2 / fig3 — the two anchors, modeled both ways
#
# One drawing function, because they ARE the same measurement on two stars and
# the post's argument depends on the reader seeing that. What differs is the
# third panel: J0740 can plot the bias against optical depth, and J0030 cannot,
# because its bias is identically zero at every tau. That is the finding, not a
# missing panel, so the third panel switches to the measurement the error moved
# into rather than being left blank.
# ===========================================================================

def fig_anchor(star, teams, note, third, ylabel3, name, ylim):
    fig, axes = plt.subplots(1, 3, figsize=(WIDTH, 3.5))

    phase = d["phase"]
    for ax, (team, label, marker) in zip(axes[:2], teams):
        iso = d[f"{star}_{team}_iso"]
        real = d[f"{star}_{team}_real"]
        ax.plot(phase, iso, ls="--", lw=1.6, color=BORDER, label="isotropic",
                zorder=2)
        ax.plot(phase, real, lw=1.8, color=INK, label=r"realistic $I(\mu)$",
                zorder=3)
        # The shaded gap IS the error under test, so it takes the accent — the
        # one object in the panel the post is actually about.
        ax.fill_between(phase, iso, real, color=ACCENT, alpha=0.20, lw=0,
                        zorder=1)
        ax.set_xlim(0, 1)
        ax.set_ylim(*ylim)
        ax.set_xlabel(r"Rotational phase $\varphi/2\pi$")
        ax.text(0.97, 0.955, label + "\n" + note(star, team),
                transform=ax.transAxes, ha="right", va="top", fontsize=8.5,
                color=INK, linespacing=1.45)
        ax.legend(loc="upper left", fontsize=8, handlelength=1.3,
                  labelspacing=0.28, borderaxespad=0.3)
    axes[0].set_ylabel(r"Flux $F(\varphi)\,/\,F_{\max}$")
    tag(axes[0], "a")
    tag(axes[1], "b")

    ax = axes[2]
    for team, label, marker in teams:
        y = d[f"{star}_{team}_{third}"]
        ax.errorbar(d[f"{star}_tau"], y, yerr=d[f"{star}_{team}_tau_err"],
                    color=ACCENT, marker=marker, ms=4, lw=1.3, capsize=2,
                    zorder=3)
        # Direct labels instead of a legend: the two series differ by marker,
        # and a legend would spend a corner of the panel restating it.
        ax.annotate(label.split()[0], (d[f"{star}_tau"][-1], y[-1]),
                    textcoords="offset points", xytext=(6, -3), fontsize=8.5,
                    color=ACCENT_INK, ha="left", va="center")
    ax.set_xscale("log")
    ax.set_xlim(d[f"{star}_tau"][0] * 0.8, d[f"{star}_tau"][-1] * 2.6)
    ax.axhline(0, color=RULE, lw=0.8, zorder=0)
    ax.set_xlabel(r"Slab optical depth $\tau$")
    ax.set_ylabel(ylabel3)
    tag(ax, "c")

    save(fig, name)


def fig_j0740():
    fig_anchor(
        "j0740",
        [("riley", "Riley 2021", "o"), ("miller", "Miller 2021", "s")],
        lambda s, t: rf"$\Delta\mathrm{{PF}} = {float(d[f'{s}_{t}_dpf']):+.3f}$",
        "dpf_tau",
        r"$\Delta\mathrm{PF} = \mathrm{PF}_{\rm real} - \mathrm{PF}_{\rm iso}$",
        "fig2_j0740",
        (-0.03, 1.30),
    )


def fig_j0030():
    fig_anchor(
        "j0030",
        [("riley", "Riley 2019", "o"), ("miller", "Miller 2019", "s")],
        lambda s, t: (r"$\mathrm{PF} = 1$ (both)" + "\n"
                      + rf"shape rms $= {float(d[f'{s}_{t}_shape_rms']):.3f}$"),
        "shape_tau",
        "Waveform-shape rms",
        "fig3_j0030",
        (-0.06, 1.30),
    )


# ===========================================================================
# fig4 — the routing ladder: the amplitude bias collapses, the shape does not
#
# The accent falls entirely on panel (b). That is the post's conclusion drawn
# rather than captioned: the numbers that move are ink, the number that refuses
# to move is the finding.
# ===========================================================================

def fig_routing():
    rungs = [str(r) for r in d["rungs"]]
    ypos = np.arange(len(rungs))[::-1]
    off = 0.17
    teams = [("riley", "Riley 2021", "o", +off),
             ("miller", "Miller 2021", "s", -off)]

    fig, (ax1, ax2) = plt.subplots(
        1, 2, figsize=(WIDTH, 3.9), sharey=True,
        gridspec_kw={"width_ratios": [1.5, 1.0]})

    for team, label, marker, dy in teams:
        vals, errs = d[f"rung_{team}_dpf"], d[f"rung_{team}_err"]
        ax1.errorbar(vals, ypos + dy, xerr=errs, color=INK, marker=marker,
                     ms=4.2, ls="none", capsize=2, lw=1.1, zorder=3,
                     label=label)
        for v, yv in zip(vals, ypos + dy):
            # Labels sit BESIDE markers, never above or below, so adjacent
            # rungs cannot collide. Every one goes to the RIGHT: the earlier
            # flip-near-the-edge rule put the top rung's +0.195 back on top of
            # its own marker, and widening the axis is the cheaper fix than a
            # conditional that has to be re-tuned whenever a number moves.
            ax1.annotate(f"{v:+.3f}", (v, yv), textcoords="offset points",
                         xytext=(8, -3), ha="left", fontsize=7.5,
                         color=SECONDARY)

    ax1.axvline(0, color=RULE, lw=0.8, zorder=0)
    ax1.set_yticks(ypos, rungs)
    ax1.set_ylim(-0.75, len(rungs) - 1 + 0.95)
    ax1.set_xlim(-0.012, 0.265)
    ax1.set_xlabel(r"Pulsed-fraction bias $\Delta\mathrm{PF}$")
    ax1.grid(axis="x", visible=False)
    # A legend rather than a direct label here, which is the one place on this
    # post's figures it wins: the ladder's rows are already labelled on the y
    # axis, so a direct team label has nowhere to sit that is not either on a
    # value or on a rung name. The lower rungs leave the panel's right side
    # empty, so the legend costs nothing.
    ax1.legend(loc="lower right", fontsize=8.5, handletextpad=0.4,
               labelspacing=0.3, borderaxespad=0.5)
    tag(ax1, "a")

    for team, label, marker, dy in teams:
        vals = d[f"rung_{team}_shape"]
        keep = ~np.isnan(vals)
        ax2.plot(vals[keep], (ypos + dy)[keep], color=ACCENT, marker=marker,
                 ms=4.2, ls="none", zorder=3)
        for v, yv in zip(vals[keep], (ypos + dy)[keep]):
            ax2.annotate(f"{v:.3f}", (v, yv), textcoords="offset points",
                         xytext=(7, -3), fontsize=7.5, color=ACCENT_INK,
                         ha="left")
    ax2.axvline(0, color=RULE, lw=0.8, zorder=0)
    ax2.set_xlim(0, 0.185)
    ax2.set_xlabel("Waveform-shape difference (rms)")
    ax2.grid(axis="x", visible=False)
    tag(ax2, "b")

    save(fig, "fig4_routing")


# ===========================================================================
# fig5 — the phase diagram: two spacetimes, one map
# ===========================================================================

def fig_phase_diagram():
    dphi, theta = d["pd_dphi"], d["pd_theta"]
    vmax = max(float(d["pd_j0740_dpf"].max()), float(d["pd_j0030_dpf"].max()))

    panels = [
        ("a", "j0740", r"J0740-like  ($u=0.49$, $i=87.6^\circ$)",
         [("Riley 2021", "riley", (-9, 11), "right"),
          ("Miller 2021", "miller", (-9, -18), "right")]),
        ("b", "j0030", r"J0030-like  ($u=0.31$, $i=53.9^\circ$)",
         [("Riley 2019", "riley", (-9, 9), "right"),
          ("Miller 2019", "miller", (-9, -18), "right")]),
    ]

    fig, axes = plt.subplots(1, 2, figsize=(WIDTH, 3.9), sharey=True)

    for ax, (letter, star, label, anchors) in zip(axes, panels):
        im = ax.pcolormesh(dphi, theta, d[f"pd_{star}_dpf"], cmap=WARM,
                           vmin=0, vmax=vmax, shading="auto", rasterized=True)
        # THE NUMERICAL TRANSITION IS NOT DRAWN, BECAUSE IT IS ALREADY THERE.
        # The manuscript figure put a white contour on the flux floor — where
        # the summed flux touches zero and PF pins to 1. But dPF IS zero exactly
        # where the flux floor is, so that contour traces the colormap's own
        # light-to-dark edge: a line drawn on top of the boundary it is
        # describing. A first pass here kept it as a soft pale band and it was
        # invisible for the same reason. What the post claims is that the
        # ANALYTIC boundary lands on the numerical transition, and the way to
        # show that is one line against the colour change, not two lines.
        #
        # Solid is the linear bending map the criterion is derived under; dashed
        # is the exact map, which bounds the criterion's placement error.
        for key, style, lw in ((f"pd_{star}_boundary", "-", 1.5),
                               (f"pd_{star}_boundary_exact", (0, (4, 2)), 1.3)):
            b = np.asarray(d[key], dtype=float)
            inside = b <= dphi.max()  # sentinel 1.0 = no boundary at this theta
            ax.plot(np.where(inside, b, np.nan), theta, color=INK, ls=style,
                    lw=lw, zorder=4)
        for name, team, offset, ha in anchors:
            x = float(d[f"pd_{star}_{team}_dphi"])
            y = float(d[f"pd_{star}_{team}_theta"])
            ax.plot(x, y, marker="*", ms=13, mfc=PAGE, mec=INK, mew=0.9,
                    ls="none", zorder=5)
            ax.annotate(name, (x, y), textcoords="offset points",
                        xytext=offset, ha=ha, fontsize=8.5, color=INK,
                        path_effects=HALO, zorder=5)
        ax.set_xlim(dphi.min(), dphi.max())
        ax.set_xlabel(r"Azimuthal spot separation $\Delta\varphi$ (cycles)")
        ax.grid(visible=False)
        # The spacetime is a label, not a title: set at the apparatus size in
        # the page's own gray so it does not read as a third heading.
        ax.text(0.0, 1.015, label, transform=ax.transAxes, fontsize=9,
                color=TERTIARY, va="bottom")
        tag(ax, letter, x=0.03, y=0.945)
        ax.texts[-1].set_path_effects(HALO)

    axes[0].set_ylabel(r"Spot colatitude $\theta_s$ (deg)")

    # The two regimes, named on the map where the reader is looking, rather
    # than in a legend that would have to be cross-referenced. Panel (b) has
    # the cleanest split, so it carries them for both.
    axes[1].text(0.15, 95, "PF saturated\nbias moves to\nwaveform shape",
                 color=INK, fontsize=8.5, ha="center", linespacing=1.5,
                 path_effects=HALO, zorder=5)
    axes[1].text(0.35, 22, "PF sensitive\nbias visible in $\\Delta$PF",
                 color=INK, fontsize=8.5, ha="center", linespacing=1.5,
                 path_effects=HALO, zorder=5)

    cbar = fig.colorbar(im, ax=axes, shrink=0.9, pad=0.015)
    cbar.set_label(r"$\Delta\mathrm{PF}$ at $\tau = 10$")
    cbar.outline.set_edgecolor(BORDER)
    cbar.outline.set_linewidth(0.8)

    save(fig, "fig5_phase_diagram")


if __name__ == "__main__":
    print(f"drawing -> {HERE}")
    fig_validation()
    fig_j0740()
    fig_j0030()
    fig_routing()
    fig_phase_diagram()
