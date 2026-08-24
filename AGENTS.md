<!-- BEGIN avo: managed by `avo install`, edits inside are overwritten -->

## avocode

This repo is an [avocode](https://github.com/mcannabrava/avocode) optimization loop: a scorer
`.avo/score` defines what better means, and a committed lineage of versions records every
improvement. Some rules always apply here.

- **`avo commit` is the only thing that persists a version.** Never hand-write a version commit,
  never edit `lineage/`, and never edit `.avo/score` to make a candidate pass.
- **Measure before you claim.** `avo score --json` is the only evidence that a change helped.
- **Read the past before you vary.** `avo mem prime`, `avo best`, and
  `avo know query "<idea>"` cost one command each and hold what earlier sessions learned.
- **Record what you learn.** `avo mem add "<insight>"` — especially dead ends. A refusal you do
  not write down is a refusal the next session earns again.
- **Use `bd` for task state, never markdown TODO lists.** `bd create`, `bd ready`, `bd close`.
  Markdown checklists are exactly what beads exists to replace, and they do not survive a
  session boundary.

### Skills

Full instructions live in `.agents/skills/<name>/SKILL.md`. Read the one that matches the task.

| Skill | Read this when |
| --- | --- |
| `avo-fanout` | Explore several variation directions at once with `avo fan` — N git worktrees, N headless agent processes on a small model, each scored, one promoted. |
| `avo-knowledge` | Search and grow `K`, an avocode repo's knowledge base — `avo know query` for hybrid search over local docs and the repo's own lineage, `avo know search` for the web, and `avo know add` to ingest a page or file with provenance. |
| `avo-lineage` | Read and extend `P_t`, the committed lineage of an avocode repo — `avo lineage`, `avo lineage show/diff`, `avo best`, and the commit rule that governs what gets kept. |
| `avo-score` | The `f` contract in avocode — run `avo score` to measure a candidate, read its JSON, and author or repair a `.avo/score` scorer. |
| `avo-vary` | Perform one variation step in an avocode optimization loop — read what is already known, change the code, measure it with `avo score`, and let `avo commit` decide whether it was progress. |

<!-- END avo -->
