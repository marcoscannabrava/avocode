# avocode task runner. `just` with no argument runs the health check.

default: check

# Install: dependencies + `avo` linked into ~/.local/bin (override with AVO_BIN_DIR).
install:
    ./install.sh

# The Ralph health check: everything that must be green before any task starts.
check: lint typecheck test

# Static analysis. The shellcheck half lives in test/lint-sh.sh: it discovers its own file
# list from git and treats an unrunnable shellcheck as a failure, not a skip (#2).
lint:
    node_modules/.bin/oxlint src test pi bench
    ./test/lint-sh.sh

typecheck:
    node_modules/.bin/tsc --noEmit

test:
    node_modules/.bin/tsx --test test/*.test.ts

# Exercises the real bin/avo; writes evidence/*-e2e.txt.
e2e:
    ./test/e2e.sh
    ./test/e2e-score.sh
    ./test/e2e-lineage.sh
    ./test/e2e-mem.sh
    ./test/e2e-know.sh
    ./test/e2e-install.sh
    ./test/e2e-fan.sh
    ./test/e2e-supervise.sh
    ./test/e2e-run.sh
    ./test/e2e-pi.sh
    ./test/e2e-bench.sh
    ./test/e2e-lint.sh
    ./test/e2e-install-sh.sh

# Everything, including the slow end-to-end pass.
all: check e2e

# Dependency and API-key status.
doctor:
    ./bin/avo doctor
