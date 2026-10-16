# Visuals: `avo report`

Today all seven figures in `docs/img/` are hand-made SVGs. `bench/verify-run.sh` prints text. A new
bench result needs new figures drawn by hand. This plan makes the loop draw its own.

Two layers:

1. **Generic** — `avo report`, from data every avocode repo already has. Works on any bench.
2. **Bench-specific** — images the scorer emits (game frames, achievement maps), shown inside the
   same report.

## 1. Data: the timeline (AVO-10)

`avo report --json` joins what is on disk into one ordered list of events. It reads only; it runs
nothing.

| Source | Events |
| --- | --- |
| `.avo/attempts.jsonl` | `attempt` (ts, head, tree hash, pass, primary, scores, hypothesis) |
| `git log` trailers + `git notes --ref=avo` | `version` (n, sha, ts, scores, why, parent) |
| `.avo/runs/*/manifest.json` | `turn` (run, iter, start, end, tokens, cost, outcome), `intervention` (kind, since_best, directive) |
| memory (`kind: failure`) | `refusal` (reason, vector) |

Derived fields per event: best-so-far, since-best (distinct trees), relative delta vs lineage root
and vs previous version. The root is the first version in the lineage, not the run start (fixes #51).

`bench/verify-run.sh` then reads this JSON instead of re-deriving the curve.

## 2. The report page (AVO-11)

`avo report --html [--out .avo/report/index.html] [--run <id>...]`

- One self-contained HTML file: inline SVG, inline CSS, no network, no build step. Charts are drawn
  by a small TS module in `src/report/`. No chart library: the repo has no build and few deps, and
  six chart types do not justify one.
- Light and dark theme from the same colour tokens as `docs/img/*.svg`.
- `--svg <dir>` writes each panel as a standalone SVG for the paper (light colours only, since
  `rsvg-convert` may drop the media query; see `evaluation.md` §8).
- `avo run` rewrites the report after each turn when `--report` is set, so a long run can be watched
  in a browser.

### Panels

| # | Panel | x | y / content | Marks |
| --- | --- | --- | --- | --- |
| 1 | **Progress** | attempt index (toggle: wall time) | primary, log scale toggle | dots = attempts (filled pass, hollow fail); step line = best; diamonds = versions; vertical bands = turns; red / amber rules = stall / thrash interventions |
| 2 | **Since best** | same x as panel 1 | since-best counter | dashed line = stall threshold; shows exactly when and why the supervisor fired |
| 3 | **Per-config heatmap** | config | version rows | cell = relative delta vs previous version; diverging colour; a refusal row in grey with the config that blocked it outlined |
| 4 | **Lineage chain** | version | — | generated form of `lineage-chain.svg`: each version with score and first line of `--why`; refused candidates hang off their parent |
| 5 | **Interventions** | intervention | — | table: kind, since-best, cited docs, turns to next version (or "none") |
| 6 | **Cost** | wall time | cumulative $ and tokens | per-turn bars |
| 7 | **Bench artifacts** | version | — | images from the scorer's `artifacts` field (see §3) |

With several `--run` values, panels 1, 2 and 6 overlay the runs. That is the ablation chart for
[supervisor-bench.md](supervisor-bench.md) Stage 3: supervisor-on runs in one colour, off in another.

## 3. Bench artifacts (AVO-11, ARC-*, CFX-*)

Add an optional field to the `f` schema:

```json
"artifacts": { "rollout:ez02": ".avo/artifacts/ez02.gif", "levels": ".avo/artifacts/levels.svg" }
```

- Paths are relative to the repo root and must sit under `.avo/artifacts/` (gitignored, part of the
  trajectory, like `.avo/runs/`).
- `avo commit` copies the artifacts of a committed version into
  `.avo/artifacts/v<NNN>/`, so the report can show each version's images after the working copy has
  moved on. They stay out of git.
- `avo score` validates that the files exist. A missing file is a warning, never a failure.

What each bench emits is in its own plan:

- **ARC-AGI-3**: per game, a frame strip or GIF of the best rollout, and a games × levels heatmap.
  See [PLAN_ARCAGI.md](PLAN_ARCAGI.md) §6.
- **Craftax**: per seed, a GIF of one episode, and an achievements × versions unlock heatmap. See
  [PLAN_CRAFTAX.md](PLAN_CRAFTAX.md) §6.
- **fuzzysearch**: none needed; panels 1-4 cover it.

## 4. Acceptance

1. `avo report --json` on the S9b target reproduces Table C of `evaluation.md` (v1..v7 primaries)
   and gives v7 = 7837x vs the lineage root.
2. `avo report --html` on the same target opens offline and shows panels 1-6.
3. On the e2e supervise fixture, panel 2 crosses the threshold line at the exact attempt where the
   recorded intervention sits.
4. `docs/img/results.svg` can be regenerated from `--svg` output with no hand edits to the data.
