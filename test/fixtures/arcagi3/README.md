# arcagi3 fixtures — the known-good ladder, and the holdout

Deliberately **not** in `bench/arcagi3/`: `bench/init.sh` copies every file in a template directory, so
a ladder or a holdout game living there would ship straight into the target and hand the optimizer the
answer. Same reason `test/fixtures/fuzzysearch/` exists.

## The ladder

Two rungs, both measured against the shipped baseline (`primary` 0.277, 10 configs, 24 rollouts).
`test/e2e-arcagi3.sh` walks them so the e2e suite can assert a curve without spending an agent.

| Rung | `avo commit` says | Why |
| --- | --- | --- |
| `policy-v1-aimed-clicks.py` | **committed** | `ff01 +64%`, `ff03 +64%`, `mm01 +17%`, and the seven movement games come back *bit-identical* (`rel: 0`) because only the click path changed |
| `policy-v2-cell-clicks.py` | **refused** | `mm01 -100%` — memory-match hides its tiles *in* the background colour, so drawing clicks from non-background cells never flips one. A win on `ff03` cannot pay for it. |

The refused rung is the more useful of the two: a real, plausible, measured regression, so the e2e suite
can prove `avo commit`'s vector rule bites on this target rather than only asserting that a good change
lands.

## The holdout

`holdout.lock` pins eight games the target never sees, from the same upstream commit as
`bench/games.lock`. Five of them pair with a training game on purpose:

| Holdout | Pairs with | What a gap between them means |
| --- | --- | --- |
| `ez04` (go DOWN) | `ez02` (go LEFT) | a policy that memorised one direction |
| `fs03` (k-of-n plates) | `fs01` (all plates) | a policy that memorised one switch rule |
| `tp02` (one-way warps) | `tp01` (two-way warps) | a policy that memorised one teleporter rule |
| `bd01` (never revisit) | `va01` (visit everything) | a policy that learned the *opposite* coverage rule |
| `mm02` (memory match, harder) | `mm01` (memory match) | a policy tuned to one board size |
| `sv01` (survival/timing) | — | an unseen category |
| `pb01` (sokoban) | — | an unseen category, and hard |
| `cs01` (click, unseen category) | — | whether a *click* improvement transfers at all |

`cs01` and `mm02` are in for a specific reason. The first six holdout games are all movement games, and
with only those the holdout scored the shipped baseline and the aimed-clicks rung **identically** — no
click action means the click path never runs, so the corpus was blind to exactly the kind of
improvement this target rewards. A holdout that cannot see the change under test measures nothing. Both
gain from aiming on their own (`cs01` +0.07, `mm02` +0.10), so a click improvement now has somewhere to
show up.

`score-holdout.sh <target-repo>` fetches them, then runs the **target's own** `bench/run.py` against
them with `--games-dir`. Reusing the target's harness is the point: the games change, nothing else
does, so the two numbers are comparable.
