import shutil
import subprocess
from pathlib import Path

import pytest

VIEWER = Path(__file__).parent.parent / "bench" / "viewer"


@pytest.mark.skipif(shutil.which("node") is None, reason="node missing")
def test_node_tests() -> None:
    files = sorted(str(p) for p in (VIEWER / "tests").glob("*.test.js"))
    result = subprocess.run(["node", "--test", *files], check=False, capture_output=True,
                            text=True, cwd=VIEWER)
    assert result.returncode == 0, result.stdout[-3000:]
