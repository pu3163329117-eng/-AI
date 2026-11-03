"""Run storage guards using isolated imports in both supported ASGI layouts."""
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import fastapi
import pytest

ROOT = Path(__file__).resolve().parents[2]
CHILD = Path(__file__).with_name('entrypoint_probe_child.py')

@pytest.mark.parametrize('mode', ['package', 'top'])
def test_entrypoint_storage_guards(mode):
    # pytest's default tmp_path is below /tmp on Linux. A child named
    # "persistent" remains temporary there and must be rejected by production.
    # This tests path acceptance only; it does not certify real volume durability.
    with TemporaryDirectory(prefix='.synthetic-storage-entrypoints-', dir=ROOT) as name:
        workspace = Path(name).resolve()
        assert workspace.parent == ROOT.resolve()
        _probe(mode, workspace)


def _probe(mode, workspace):
    (workspace / 'transient').mkdir()
    (workspace / 'persistent').mkdir()
    env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR', 'PATH') if key in os.environ}
    env.update({'TEMP': str(workspace / 'transient'), 'TMP': str(workspace / 'transient'),
                'TMPDIR': str(workspace / 'transient'), 'PYTHONNOUSERSITE': '1',
                'PYTHONDONTWRITEBYTECODE': '1',
                'WENYAN_TEST_SITE_DIR': str(Path(fastapi.__file__).resolve().parent.parent),
                'WENYAN_ENV': 'test', 'WENYAN_ACCESS_MODE': 'local',
                'WENYAN_DATABASE_URL': 'sqlite:///:memory:', 'WENYAN_AI_ENABLED': '0',
                'WENYAN_COLLABORATION_ENABLED': '0', 'WENYAN_COLLABORATION_REAL_CALLS_ENABLED': '0'})
    result = subprocess.run([sys.executable, '-I', '-B', str(CHILD), mode, str(ROOT), str(workspace)],
                            cwd=ROOT if mode == 'package' else ROOT / 'backend', env=env,
                            text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr
