# Install avocode

`avo` is a TypeScript CLI run through `tsx` — **there is no build step**. Installing means fetching
dependencies once and putting the entrypoint on your `PATH`.

## Install it

```sh
git clone https://github.com/marcoscannabrava/avocode
cd avocode
./install.sh
```

The script does three things, reporting each as `created` / `unchanged` / `skipped`:

| Step | What it does |
| --- | --- |
| 1. toolchain | checks Node ≥ 22 and npm; warns if `git` is missing (avo needs it at *runtime* — the lineage lives in commits) |
| 2. dependencies | `npm ci` on a fresh clone, `npm install` on an existing tree |
| 3. `avo` on PATH | symlinks `bin/avo` into `~/.local/bin`, then runs `avo --version` **through the link** to prove it resolves |

It finishes with an `avo doctor` report.

**Re-running is safe.** A second run creates nothing (invariant 5) — that is what the `unchanged`
lines mean, and `test/e2e-install-sh.sh` asserts it.

## Options

```sh
./install.sh --bin-dir /usr/local/bin   # somewhere else on PATH (or set AVO_BIN_DIR)
./install.sh --force                    # replace whatever occupies <bin-dir>/avo
./install.sh --skip-doctor              # no dependency report at the end
./install.sh --uninstall                # remove the link
./install.sh --help
```

## Why a symlink and not a copy

`git pull` in the checkout is then the whole upgrade path — no second copy to keep in step. It is
also why `bin/avo` walks the symlink chain before resolving its own root: taking `dirname` of the
*link* would make it look for `src/` next to `~/.local/bin/avo` and exit 127
([#41](https://github.com/marcoscannabrava/avocode/issues/41)). The e2e suite runs `avo --version`
from outside the checkout for exactly this reason.

## Fix a PATH that lacks `~/.local/bin`

The installer prints the line to paste. For the record:

```sh
export PATH="$HOME/.local/bin:$PATH"     # bash/zsh — add to ~/.bashrc or ~/.zshrc
fish_add_path ~/.local/bin               # fish
```

## Dependencies

`avo doctor` is the authority — it reports every one of these with an install line beside it, and
exits 1 only when a **required** dependency or *all* agents are missing.

| | Tool | Without it |
| --- | --- | --- |
| **required** | `git` | nothing works; `P_t` is git commits |
| **required** | `jq` | scorers and skills pipe through it |
| **one agent** | `pi`, `claude` or `codex` | there is no variation operator — `avo fan` and `avo run` have nothing to spawn |
| optional | `qmd` | `avo know query` falls back to a local file scan, returning identical JSON |
| optional | `bd` (beads) | memory falls back to `lineage/memory.jsonl` |
| optional | `hyperfine` | the wall-clock scorer template is unavailable; write your own `.avo/score` |
| optional | `just` | run the npm scripts directly instead |
| optional | `ddgs` | one fewer keyless web-search backend |
| optional | `shellcheck` | `just lint` falls back to `npm exec -- shellcheck`; if neither runs, lint **fails** rather than skipping ([#2](https://github.com/marcoscannabrava/avocode/issues/2)) |

Every optional dependency degrades with a named fallback and one warning — never a crash
(invariant 4).

### API keys

`avo doctor` reports these as present/unset only; their values never appear in any output
(invariant 6).

| Key | Enables |
| --- | --- |
| `ANTHROPIC_API_KEY` | `claude`, and pi's anthropic provider |
| `OPENAI_API_KEY` | `codex`, and pi's openai provider |
| `FIRECRAWL_API_KEY` | `avo know add <url>` and `avo know search` (free tier: 1000 credits/month, no card) |
| `SEARXNG_URL` | keyless `avo know search` (the instance must enable `format=json`) |
| `GROQ_API_KEY` / `CEREBRAS_API_KEY` / `OPENROUTER_API_KEY` | small probe models for `avo fan` |

## Work on avocode itself

You do not need `install.sh` — `./bin/avo` works from the checkout after `npm install`. But **the
wired skills all begin with `avo ...`**, so an agent driving the loop needs the bare name
resolvable:

```sh
PATH="$PWD/bin:$PATH" avo run --cwd ~/work/target --agent claude ...
```

See [testing.md](testing.md) for the health check and the test suites.

## Uninstall

```sh
./install.sh --uninstall    # removes the link, and only if it points at this checkout
rm -rf /path/to/avocode     # the checkout itself
```

A repo you ran `avo init`/`avo install` in keeps its `.avo/`, `lineage/`, `knowledge/` and the
managed block in its `AGENTS.md`. None of it depends on avocode staying installed — the lineage is
just git commits.
