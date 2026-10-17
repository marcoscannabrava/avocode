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
    node_modules/.bin/oxlint --deny-warnings src test pi bench
    ./test/lint-sh.sh

typecheck:
    node_modules/.bin/tsc --noEmit

test:
    node_modules/.bin/tsx --test test/*.test.ts

# Suite cap; --foreground keeps Ctrl-C working (#53).
e2e_timeout := env_var_or_default("AVO_E2E_TIMEOUT", "1800")

# Exercises the real bin/avo; writes evidence/*-e2e.txt.
e2e:
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-score.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-lineage.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-mem.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-know.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-install.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-fan.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-supervise.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-run.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-pi.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-bench.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-arcagi3.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-lint.sh
    timeout --foreground -k 10 {{e2e_timeout}} ./test/e2e-install-sh.sh

# Real agents, real tokens: never in CI. Pass agent names to narrow.
smoke *agents:
    ./test/smoke-agents.sh {{agents}}

# Everything, including the slow end-to-end pass.
all: check e2e

# Dependency and API-key status.
doctor:
    ./bin/avo doctor
