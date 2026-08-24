# avocode task runner. `just` with no argument runs the health check.

default: check

# The Ralph health check: everything that must be green before any task starts.
check: lint typecheck test

# Static analysis.
lint:
    node_modules/.bin/oxlint src test
    shellcheck -S style bin/avo test/e2e.sh test/e2e-score.sh test/e2e-lineage.sh test/e2e-mem.sh test/e2e-know.sh test/e2e-install.sh templates/score/*.sh ralph.sh test/ralph_test.sh || echo "shellcheck: skipped (not installed)"

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

# Everything, including the slow end-to-end pass.
all: check e2e

# Dependency and API-key status.
doctor:
    ./bin/avo doctor
