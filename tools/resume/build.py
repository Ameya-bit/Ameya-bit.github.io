#!/usr/bin/env python3
"""The résumé adapter: one source, two variants, two renderers.

    tools/resume/resume.toml            the inventory: every fact, said once
        ├── resume/_body.md             the page's body (site language; committed)
        └── build/Resume-<variant>.tex ──latexmk──► assets/<variant's pdf>

The TOML is an inventory of items (degrees, roles, studies, projects), each
carrying its facts, its outputs, and one table per surface. This script reads
the résumé's view of it: resume_source() reshapes the items that have a
`resume` table into sections, and everything downstream is unchanged. The
website's surfaces (the home page timeline, the about page) are read by
tools/home/build.py; their tables in the TOML are ignored here.

A variant ([resume.variants.<name>] in the TOML) is a selection over the one source:
its sections in its order, the entries and skills rows tagged for it, and any
per-variant override tables applied. The page renders the variant the TOML
names as `page`; --pdf builds every variant's PDF, and the page links them all.

Default run (no flags) regenerates resume/_body.md only. It is wired as the
project's Quarto pre-render hook, so the page can never drift from the source.

    python3 tools/resume/build.py --pdf

additionally fills template.tex's content region, runs latexmk once per
variant, and copies the PDFs into assets/. Run it whenever the content
changes; the PDFs are build artifacts, never edited by hand.

Same split as the figures' compute.py/plot.py: content computed once,
presentation per surface. The PDF is the SUBSET renderer (contact items with
web = false — the phone number — never reach the public page). Both surfaces
link entry headings; the page resolves web_url before url, and the PDF names
the destination inline with link_label, having no hover to reveal it.

Zero dependencies beyond Python 3.11+ (tomllib) and, for --pdf, the TeX
toolchain the template already requires (latexmk + carlito).
"""

import argparse
import html
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BODY_MD = ROOT / "resume" / "_body.md"
ASSETS = ROOT / "assets"


# ---- the inventory, as the résumé sees it ------------------------------------

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def format_dates(item: dict) -> str:
    """An item's start/end ("YYYY-MM") as the résumé prints a date range.

    One month stands alone; a range inside one year names the year once; an
    item with no end is still running.
    """
    sy, sm = (int(x) for x in item["start"].split("-"))
    start = f"{MONTHS[sm - 1]} {sy}"
    if "end" not in item:
        return f"{start} – Present"
    ey, em = (int(x) for x in item["end"].split("-"))
    if (sy, sm) == (ey, em):
        return start
    if sy == ey:
        return f"{MONTHS[sm - 1]} – {MONTHS[em - 1]} {ey}"
    return f"{start} – {MONTHS[em - 1]} {ey}"


def resume_entry(item: dict, variant_names: tuple) -> dict:
    """One inventory item -> the entry dict the renderers read.

    The résumé's wording comes from the item's `resume` table; the facts it
    does not restate (location, dates) come from the item itself. `web_link`
    names one of the item's outputs, and resolves to that output's folder.
    """
    view = item["resume"]
    entry = {k: v for k, v in view.items() if k not in ("section", "web_link")}
    entry.setdefault("dates", format_dates(item))
    if "location" in item:
        entry.setdefault("location", item["location"])
    if "web_link" in view:
        target = next((o for o in item.get("outputs", []) if o["kind"] == view["web_link"]), None)
        if target is None:
            sys.exit(f"resume.toml: {item['id']} has web_link = {view['web_link']!r} but no such output")
        entry["web_url"] = f"../{target['path']}/"
    return entry


def resume_source(inventory: dict) -> dict:
    """The inventory, reshaped into the sections the résumé is built from.

    A new dict; the inventory is untouched. Entries keep the inventory's order
    within their section. The Skills section is the `skills` rows.
    """
    settings = inventory["resume"]
    names = tuple(settings["variants"])
    titles = []
    for v in settings["variants"].values():
        titles += [t for t in v["sections"] if t not in titles]
    on_resume = [i for i in inventory["items"] if "resume" in i]
    unknown = {i["resume"]["section"] for i in on_resume} - set(titles)
    if unknown:
        sys.exit(f"resume.toml: no variant lists the section(s) {sorted(unknown)}")
    sections = [
        {
            "title": title,
            "entries": [resume_entry(i, names) for i in on_resume if i["resume"]["section"] == title],
            "skills": inventory.get("skills", []) if title == "Skills" else [],
        }
        for title in titles
    ]
    return {
        "name": inventory["person"]["name"],
        "updated": settings["updated"],
        "page": settings["page"],
        "variants": settings["variants"],
        "contact": inventory["contact"],
        "sections": sections,
    }


# ---- variants ---------------------------------------------------------------

def select(data: dict, variant: str) -> dict:
    """The source as one variant sees it: a new dict, the source untouched.

    Sections come in the variant's order (and only those it lists); an entry
    or skills row belongs to every variant unless its `variants` list says
    otherwise; a per-variant override table on an item replaces the item's
    own keys for that variant only.
    """
    names = tuple(data["variants"])

    def belongs(item: dict) -> bool:
        return variant in item.get("variants", names)

    def view(item: dict) -> dict:
        merged = {**item, **item.get(variant, {})}
        return {k: v for k, v in merged.items() if k != "variants" and k not in names}

    by_title = {s["title"]: s for s in data["sections"]}
    sections = [
        {
            "title": title,
            "entries": [view(e) for e in by_title[title].get("entries", []) if belongs(e)],
            "skills": [view(s) for s in by_title[title].get("skills", []) if belongs(s)],
        }
        for title in data["variants"][variant]["sections"]
    ]
    return {**data, "sections": sections}


# ---- text conversions -------------------------------------------------------

def tex_text(s: str) -> str:
    """Plain content string -> the template's TeX conventions."""
    for a, b in (("&", r"\&"), ("%", r"\%"), ("#", r"\#"), ("$", r"\$"),
                 ("~", r"\textasciitilde{}")):
        s = s.replace(a, b)
    # χ², with or without a trailing " = <number>", becomes one math span so
    # the equals sign keeps math spacing (matches the hand-written original).
    s = re.sub(r"χ²( = [\d.]+)?", lambda m: r"$\chi^2" + (m.group(1) or "") + "$", s)
    # Same treatment for ρ (a correlation), the résumé's other Greek letter.
    s = re.sub(r"ρ( = [\d.]+)?", lambda m: r"$\rho" + (m.group(1) or "") + "$", s)
    s = s.replace("−", "$-$").replace("×", r"$\times$")   # U+2212, U+00D7
    s = s.replace(" · ", r"\sep ")
    s = s.replace("—", "---").replace("–", "--")
    # Interword (not sentence-ending) spaces after abbreviations the résumé uses.
    s = s.replace("Prof. ", "Prof.\\ ").replace(" al. ", " al.\\ ")
    s = re.sub(r"\*(.+?)\*", r"\\emph{\1}", s)
    return s


def tex_url(s: str) -> str:
    """URL -> \\href's first argument.

    The heading reaches \\href through \\entry and a parbox, so the URL is read
    as an ordinary macro argument rather than verbatim and TeX's specials have
    to be escaped. A fragment's # is the one that actually shows up.
    """
    for a, b in (("#", r"\#"), ("%", r"\%"), ("&", r"\&")):
        s = s.replace(a, b)
    return s


def web_text(s: str) -> str:
    """Plain content string -> page HTML (unicode kept as itself)."""
    s = html.escape(s)
    s = re.sub(r"\*(.+?)\*", r"<em>\1</em>", s)
    return s


# ---- the PDF (subset renderer) ----------------------------------------------

def gen_tex(data: dict) -> str:
    out = []

    out.append("%----------HEADING----------")
    out.append("\\begin{center}")
    out.append("  {\\sizeName\\bfseries " + tex_text(data["name"]) + "}\\\\[\\gapS]")
    out.append("  \\rule{\\linewidth}{0.6pt}\\\\[\\gapS]")
    items = []
    for c in data["contact"]:
        t = tex_text(c["text"])
        boxed = f"\\mbox{{\\href{{{c['href']}}}{{{t}}}}}" if "href" in c else f"\\mbox{{{t}}}"
        items.append(boxed)
    out.append("  {\\sizeContact\n    " + "\\sep\n    ".join(items) + "%\n  }")
    out.append("\\end{center}")

    for sec in data["sections"]:
        out.append("\n\n%----------" + sec["title"].upper() + "----------")
        out.append("\\section{" + tex_text(sec["title"]) + "}")

        for e in sec.get("entries", []):
            # The heading IS the link here, the way it already is on the page;
            # link_label names the destination in its place. See \entrymarker.
            head = tex_text(e["heading"])
            if "url" in e:
                head = f"\\href{{{tex_url(e['url'])}}}{{{head}}}"
                if "link_label" in e:
                    head += f"\\entrymarker{{{tex_text(e['link_label'])}}}"
            out.append("")
            out.append("\\entry")
            out.append(f"  {{{head}}}{{{tex_text(e.get('location', ''))}}}")
            out.append(f"  {{{tex_text(e['detail'])}}}{{{tex_text(e['dates'])}}}")
            if e.get("bullets"):   # an empty itemize is a TeX error
                out.append("\\begin{points}")
                for b in e["bullets"]:
                    out.append("  \\item " + tex_text(b))
                out.append("\\end{points}")

        if sec.get("skills"):
            out.append("")
            out.append("\\vspace{\\gapS}")
            for sk in sec["skills"]:
                out.append(f"\\skillrow{{{tex_text(sk['label'])}}}{{{tex_text(sk['text'])}}}")

    template = (HERE / "template.tex").read_text()
    assert "@@CONTENT@@" in template, "template.tex lost its content marker"
    return template.replace("@@CONTENT@@", "\n".join(out))


# ---- the page body (superset renderer) --------------------------------------

def gen_web(data: dict) -> str:
    # The page shows one variant; the filing line offers every variant's PDF,
    # the page's own first.
    page = data["page"]
    order = [page] + [v for v in data["variants"] if v != page]
    links = " · ".join(
        f'<a href="../assets/{data["variants"][v]["pdf"]}">{web_text(data["variants"][v]["label"])}</a>'
        for v in order
    )
    out = [
        "<!-- GENERATED by tools/resume/build.py from resume.toml — do not edit."
        " Regenerates on every quarto render (pre-render hook). -->",
        "",
        "```{=html}",
        f'<p class="cv-filing">Updated {web_text(data["updated"])}'
        f" · Download as PDF: {links}</p>",
        "```",
    ]

    for sec in data["sections"]:
        out.append("")
        out.append("## " + sec["title"])
        out.append("")
        out.append("```{=html}")

        for e in sec.get("entries", []):
            link = e.get("web_url") or e.get("url")
            head = web_text(e["heading"])
            if link:
                head = f'<a href="{link}">{head}</a>'
            out.append('<article class="cv-entry">')
            out.append('  <div class="cv-row">')
            out.append(f'    <p class="cv-head">{head}</p>')
            out.append(f'    <p class="cv-when">{web_text(e["dates"])}</p>')
            out.append("  </div>")
            out.append('  <div class="cv-row">')
            out.append(f'    <p class="cv-detail">{web_text(e["detail"])}</p>')
            if e.get("location"):
                out.append(f'    <p class="cv-where">{web_text(e["location"])}</p>')
            out.append("  </div>")
            if e.get("bullets"):
                out.append('  <ul class="cv-points">')
                for b in e["bullets"]:
                    out.append(f"    <li>{web_text(b)}</li>")
                out.append("  </ul>")
            out.append("</article>")

        for sk in sec.get("skills", []):
            out.append(
                f'<p class="cv-skill"><strong>{web_text(sk["label"])}:</strong> '
                f'{web_text(sk["text"])}</p>'
            )

        out.append("```")

    return "\n".join(out) + "\n"


# ---- drivers ----------------------------------------------------------------

def build_pdf(data: dict, variant: str) -> None:
    build_dir = HERE / "build"
    build_dir.mkdir(exist_ok=True)
    stem = f"Resume-{variant}"
    (build_dir / f"{stem}.tex").write_text(gen_tex(data))
    proc = subprocess.run(
        ["latexmk", "-pdf", "-interaction=nonstopmode", f"{stem}.tex"],
        cwd=build_dir, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-3000:] + "\n" + proc.stderr[-1000:] + "\n")
        sys.exit(f"latexmk failed on {variant} — see log above")
    out = ASSETS / data["variants"][variant]["pdf"]
    shutil.copy(build_dir / f"{stem}.pdf", out)
    print(f"PDF ({variant}): {out.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pdf", action="store_true",
                    help="also build every variant's PDF via latexmk into assets/")
    args = ap.parse_args()

    source = resume_source(tomllib.loads((HERE / "resume.toml").read_text()))
    if source["page"] not in source["variants"]:
        sys.exit(f"resume.toml: page = {source['page']!r} names no variant")

    BODY_MD.parent.mkdir(exist_ok=True)
    body = gen_web(select(source, source["page"]))
    if not BODY_MD.exists() or BODY_MD.read_text() != body:
        BODY_MD.write_text(body)
        print(f"page body: {BODY_MD.relative_to(ROOT)} (updated)")

    if args.pdf:
        for variant in source["variants"]:
            build_pdf(select(source, variant), variant)


if __name__ == "__main__":
    main()
