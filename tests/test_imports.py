import shutil
import subprocess

import pytest


@pytest.mark.skipif(shutil.which("lint-imports") is None, reason="import-linter missing")
def test_import_rules() -> None:
    result = subprocess.run(["lint-imports"], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout[-2000:]
