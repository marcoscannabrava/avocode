# Paper

The LaTeX article "An implementation of NVIDIA's Agentic Variation Operators (AVO) for Autonomous
Evolutionary Search".

## Build

You need a TeX distribution with `latexmk`, TikZ, pgfplots and siunitx (TeX Live has all of them).

```sh
cd docs/paper
latexmk -pdf main.tex
```

All figures are TikZ or pgfplots code. There are no image files to convert.

## Files

| File | Content |
| --- | --- |
| `main.tex` | preamble and section order |
| `macros.tex` | notation, listing style, TikZ styles |
| `sections/*.tex` | one file for each section |
| `references.bib` | the bibliography (92 entries) |
| `outline.md` | the topic list and outline |
| `avo-paper-notes.md` | notes on the AVO paper (arXiv 2603.24517) |
| `related-work.md` | notes on related work, with BibTeX |
| `code-core.md` | notes on `f`, `P_t`, `K`, memory and the commit rule |
| `code-orchestration.md` | notes on `avo run`, `avo supervise`, `avo fan` and the agents |
| `evaluation.md` | notes on the benchmarks, results and history |

The notes give `file:line` sources for each claim in the article.
