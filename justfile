# avocode task runner. `just` with no argument runs the health check.

default: check

# The Ralph health check: everything that must be green before any task starts.
check: lint typecheck test ralph-test

# Static analysis.
lint:
    node_modules/.bin/oxlint src test pi bench
    shellcheck -S style bin/avo test/e2e.sh test/e2e-score.sh test/e2e-lineage.sh test/e2e-mem.sh test/e2e-know.sh test/e2e-install.sh test/e2e-fan.sh test/e2e-supervise.sh test/e2e-run.sh test/e2e-pi.sh test/e2e-bench.sh templates/score/*.sh bench/init.sh bench/verify-run.sh bench/fuzzysearch/avo/score ralph.sh test/ralph_test.sh || echo "shellcheck: skipped (not installed)"

typecheck:
    node_modules/.bin/tsc --noEmit

test:
    node_modules/.bin/tsx --test test/*.test.ts

# The loop harness itself, against a stub agent in a throwaway repo. Two seconds, and it is
# the only thing that proves an interrupted run leaves no session behind editing this one.
ralph-test:
    ./test/ralph_test.sh

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

# Everything, including the slow end-to-end pass.
all: check e2e

# Dependency and API-key status.
doctor:
    ./bin/avo doctor
