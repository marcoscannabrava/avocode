#!/usr/bin/env python3
"""Latency charts and tables from run folders."""

from __future__ import annotations

import argparse
import glob
import json
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

BLUE, ORANGE, AQUA, YELLOW, VIOLET = "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#6250d6"
INK, MUTED, GRID, SURFACE = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "axes.edgecolor": GRID,
    "axes.labelcolor": MUTED, "xtick.color": MUTED, "ytick.color": MUTED,
    "text.color": INK, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.spines.top": False, "axes.spines.right": False, "font.size": 10,
    "axes.titlesize": 12, "axes.titleweight": "bold", "axes.titlelocation": "left",
})

MAIN_RUN = "20261111-001848-6d13ee2"   # OpenRouter, efforts low/medium
BASE_RUN = "20261109-232501-630903c"   # OpenAI baseline
BIG_OUT = 10_000                        # runaway reasoning threshold


def ts(text: str) -> float:
    return datetime.fromisoformat(text).timestamp()


def load_calls(runs: Path) -> list[dict]:
    rows = []
    for path in sorted(glob.glob(str(runs / "2026*/games/*/llm.jsonl"))):
        run = Path(path).parts[-4]
        cfg = json.loads((runs / run / "manifest.json").read_text())["config"]
        for line in Path(path).read_text().splitlines():
            r = json.loads(line)
            r["run"] = run
            r["effort"] = cfg.get(f"{r['role']}_effort") or "unset"
            r["lat"] = r["latency_ms"] / 1000
            r["group"] = f"{r['provider']} {r['role']} ({r['effort']})"
            rows.append(r)
    return rows


def pct(values: list[float], p: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


def group_table(rows: list[dict]) -> str:
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[f"{r['model']} / {r['role']} / {r['effort']}"].append(r)
    out = [("| Model / role / effort | Calls | p50 s | p90 s | Max s | Sum s "
           "| Out tok p50 | Out tok p90 | Tok/s p50 |"),
           "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for key, g in sorted(groups.items()):
        lat = [r["lat"] for r in g]
        outs = [r["out_tokens"] for r in g]
        tps = [r["out_tokens"] / r["lat"] for r in g if r["lat"]]
        out.append(f"| {key} | {len(g)} | {pct(lat, .5):.1f} | {pct(lat, .9):.1f} | "
                   f"{max(lat):.0f} | {sum(lat):.0f} | {pct(outs, .5):.0f} | "
                   f"{pct(outs, .9):.0f} | {statistics.median(tps):.0f} |")
    return "\n".join(out)


def offenders(rows: list[dict], n: int = 15) -> str:
    rows = sorted((r for r in rows if r["provider"] == "openrouter"), key=lambda r: -r["lat"])
    out = ["| Run | Call | Role | Latency s | Out tok | Visible chars | Tok/s | Retries |",
           "|---|---|---|---:|---:|---:|---:|---:|"]
    for r in rows[:n]:
        out.append(f"| {r['run']} | {r['call_id']} | {r['role']} | {r['lat']:.0f} | "
                   f"{r['out_tokens']} | {len(r['reply'])} | {r['out_tokens'] / r['lat']:.0f} | "
                   f"{r['retries']} |")
    return "\n".join(out)


def slow_tps(rows: list[dict], n: int = 8) -> str:
    rows = [r for r in rows if r["provider"] == "openrouter" and r["out_tokens"] > 500]
    rows.sort(key=lambda r: r["out_tokens"] / r["lat"])
    out = ["| Run | Call | Role | Latency s | Out tok | Tok/s |", "|---|---|---|---:|---:|---:|"]
    for r in rows[:n]:
        out.append(f"| {r['run']} | {r['call_id']} | {r['role']} | {r['lat']:.0f} | "
                   f"{r['out_tokens']} | {r['out_tokens'] / r['lat']:.0f} |")
    return "\n".join(out)


def breakdown(rows: list[dict], runs: Path, run: str) -> dict[str, float]:
    """Split one run's wall time into buckets."""
    events = []
    for path in glob.glob(str(runs / run / "games/*/events.jsonl")):
        events += [json.loads(line) for line in Path(path).read_text().splitlines()]
    starts = [ts(e["ts"]) for e in events]
    wall = max(starts) - min(starts)
    b = {"player: retried": 0.0, f"player: >{BIG_OUT // 1000}k out tokens": 0.0,
         "player: other": 0.0, "scorer": 0.0}
    for r in (r for r in rows if r["run"] == run):
        if r["role"] == "scorer":
            b["scorer"] += r["lat"]
        elif r["retries"] or not r["ok"]:
            b["player: retried"] += r["lat"]
        elif r["out_tokens"] > BIG_OUT:
            b[f"player: >{BIG_OUT // 1000}k out tokens"] += r["lat"]
        else:
            b["player: other"] += r["lat"]
    b["engine + session"] = max(0.0, wall - sum(b.values()))
    return b


def fig_by_group(rows: list[dict], out: Path) -> None:
    order = ["openai player (low)", "openrouter player (unset)", "openrouter player (low)",
             "openai scorer (medium)", "openrouter scorer (unset)",
             "openrouter scorer (medium)"]
    data = [[r["lat"] for r in rows if r["group"] == g] for g in order]
    fig, ax = plt.subplots(figsize=(9, 4.2))
    bp = ax.boxplot(data, orientation="horizontal", widths=0.5, patch_artist=True, showfliers=True,
                    medianprops={"color": INK, "linewidth": 2},
                    flierprops={"marker": "o", "markersize": 4, "alpha": 0.5})
    for patch, g in zip(bp["boxes"], order, strict=True):
        patch.set_facecolor(BLUE if g.startswith("openai") else ORANGE)
        patch.set_edgecolor(SURFACE)
    ax.set_yticks(range(1, len(order) + 1),
                  [f"{g}  n={len(d)}" for g, d in zip(order, data, strict=True)])
    ax.set_xscale("log")
    ax.set_xlabel("Call latency, seconds (log scale)")
    ax.set_title("Per-call latency by provider, role, and reasoning effort")
    ax.invert_yaxis()
    fig.tight_layout()
    fig.savefig(out, dpi=150)


def fig_tokens(rows: list[dict], out: Path) -> None:
    fig, ax = plt.subplots(figsize=(8, 5))
    for prov, color in (("openai", BLUE), ("openrouter", ORANGE)):
        g = [r for r in rows if r["provider"] == prov]
        ax.scatter([max(1, r["out_tokens"]) for r in g], [r["lat"] for r in g], s=14,
                   color=color, alpha=0.6, edgecolors=SURFACE, linewidths=0.5,
                   label=f"{prov} (n={len(g)})")
    for tps, label in ((100, "100 tok/s"), (25, "25 tok/s")):
        xs = [10, 200_000]
        ax.plot(xs, [x / tps for x in xs], color=MUTED, linewidth=1, linestyle="--")
        ax.annotate(label, (0.7 * tps, 0.7), color=MUTED, fontsize=9,
                    xytext=(0, 8), textcoords="offset points", rotation=33)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(10, 300_000)
    ax.set_ylim(0.5, 1000)
    ax.set_xlabel("Output tokens per call, reasoning included (log)")
    ax.set_ylabel("Latency, seconds (log)")
    ax.set_title("Latency follows output tokens")
    ax.legend(frameon=False, loc="upper left")
    fig.tight_layout()
    fig.savefig(out, dpi=150)


def fig_timeline(rows: list[dict], out: Path) -> None:
    fig, ax = plt.subplots(figsize=(8, 4.2))
    for run, color, label in ((BASE_RUN, BLUE, "openai (gpt-6-luna / gpt-6.1-sol)"),
                              (MAIN_RUN, ORANGE, "openrouter (deepseek / glm, low / medium)")):
        steps: dict[int, float] = defaultdict(float)
        for r in rows:
            if r["run"] == run:
                steps[r["step"]] += r["lat"]
        xs = sorted(steps)
        total, ys = 0.0, []
        for x in xs:
            total += steps[x]
            ys.append(total / 60)
        ax.plot(xs, ys, color=color, linewidth=2, label=label)
        ax.annotate(f"{ys[-1]:.0f} min", (xs[-1], ys[-1]), color=INK, fontsize=9,
                    xytext=(4, 0), textcoords="offset points", va="center")
    ax.set_xlabel("Step (game action)")
    ax.set_ylabel("Cumulative LLM time, minutes")
    ax.set_title("ls20: LLM time per game, step by step")
    ax.legend(frameon=False, loc="upper left")
    fig.tight_layout()
    fig.savefig(out, dpi=150)


def fig_breakdown(parts: dict[str, float], out: Path) -> None:
    colors = [VIOLET, ORANGE, YELLOW, BLUE, AQUA]
    total = sum(parts.values())
    fig, ax = plt.subplots(figsize=(9, 3.4))
    names = list(parts)
    vals = [parts[k] / 60 for k in names]
    bars = ax.barh(names, vals, color=colors[:len(names)], edgecolor=SURFACE, height=0.6)
    for bar, v in zip(bars, vals, strict=True):
        ax.annotate(f"{v:.0f} min ({100 * v * 60 / total:.0f}%)",
                    (bar.get_width(), bar.get_y() + bar.get_height() / 2),
                    xytext=(4, 0), textcoords="offset points", va="center", fontsize=9)
    ax.invert_yaxis()
    ax.set_xlim(0, max(vals) * 1.3)
    ax.set_xlabel("Wall time, minutes")
    ax.set_title(f"Where the time went: run {MAIN_RUN} ({total / 3600:.1f} h)")
    fig.tight_layout()
    fig.savefig(out, dpi=150)


def fig_probe(probe: Path, out: Path) -> str:
    rows = [json.loads(line) for line in probe.open()]
    rows = [r for r in rows if "error" not in r]
    keys = list(dict.fromkeys((r["role"], r["config"]) for r in rows))
    fig, ax = plt.subplots(figsize=(9, 3.8))
    labels, ttft, gen = [], [], []
    table = [("| Role | Config | Calls | Mean total s | Mean TTFT s | Mean reasoning tok "
             "| Mean out tok | Providers |"), "|---|---|---:|---:|---:|---:|---:|---|"]
    for role, cfg in keys:
        g = [r for r in rows if r["role"] == role and r["config"] == cfg]
        t = statistics.mean(r["total_s"] for r in g)
        f = statistics.mean(r["first_content_s"] for r in g)
        labels.append(f"{role}: {cfg}")
        ttft.append(f)
        gen.append(t - f)
        table.append(f"| {role} | {cfg} | {len(g)} | {t:.1f} | "
                     f"{statistics.mean(r['ttft_s'] for r in g):.1f} | "
                     f"{statistics.mean(r['reasoning_tokens'] for r in g):.0f} | "
                     f"{statistics.mean(r['out_tokens'] for r in g):.0f} | "
                     f"{', '.join(sorted({r['provider'] for r in g}))} |")
    ax.barh(labels, ttft, color=VIOLET, edgecolor=SURFACE, height=0.6,
            label="before first JSON token (queue + hidden reasoning)")
    ax.barh(labels, gen, left=ttft, color=AQUA, edgecolor=SURFACE, height=0.6,
            label="JSON answer")
    ax.invert_yaxis()
    ax.set_xlabel("Mean seconds per call")
    ax.set_title("Probe: same prompts, different reasoning settings")
    ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.4, -0.18), ncol=2)
    fig.tight_layout()
    fig.savefig(out, dpi=150)
    return "\n".join(table)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs", type=Path, default=Path("runs"))
    ap.add_argument("--out", type=Path, default=Path("scratch/latency"))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = load_calls(args.runs)
    fig_by_group(rows, args.out / "latency_by_group.png")
    fig_tokens(rows, args.out / "latency_vs_tokens.png")
    fig_timeline(rows, args.out / "cumulative_time.png")
    parts = breakdown(rows, args.runs, MAIN_RUN)
    fig_breakdown(parts, args.out / "time_breakdown.png")
    print("## Groups\n" + group_table(rows))
    print("\n## Breakdown, run", MAIN_RUN)
    for k, v in parts.items():
        print(f"- {k}: {v:.0f} s ({v / 60:.0f} min)")
    print("\n## Slowest calls\n" + offenders(rows))
    print("\n## Slowest throughput\n" + slow_tps(rows))
    probe = args.out / "probe.jsonl"
    if probe.exists():
        print("\n## Probe\n" + fig_probe(probe, args.out / "probe.png"))


if __name__ == "__main__":
    main()
