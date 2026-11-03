"""Run storage guards using isolated imports in both supported ASGI layouts."""
import os
from pathlib import Path
import subprocess
import sys
import fastapi
import pytest

ROOT = Path(__file__).resolve().parents[2]
CHILD = Path(__file__).with_name('entrypoint_probe_child.py')

@pytest.mark.parametrize('mode', ['package', 'top'])
def test_entrypoint_storage_guards(mode, tmp_path):
    (tmp_path / 'transient').mkdir()
    (tmp_path / 'persistent').mkdir()
    env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR', 'PATH') if key in os.environ}
    env.update({'TEMP': str(tmp_path / 'transient'), 'TMP': str(tmp_path / 'transient'),
                'TMPDIR': str(tmp_path / 'transient'), 'PYTHONNOUSERSITE': '1',
                'PYTHONDONTWRITEBYTECODE': '1',
                'WENYAN_TEST_SITE_DIR': str(Path(fastapi.__file__).resolve().parent.parent),
                'WENYAN_ENV': 'test', 'WENYAN_ACCESS_MODE': 'local',
                'WENYAN_DATABASE_URL': 'sqlite:///:memory:', 'WENYAN_AI_ENABLED': '0',
                'WENYAN_COLLABORATION_ENABLED': '0', 'WENYAN_COLLABORATION_REAL_CALLS_ENABLED': '0'})
    result = subprocess.run([sys.executable, '-I', '-B', str(CHILD), mode, str(ROOT), str(tmp_path)],
                            cwd=ROOT if mode == 'package' else ROOT / 'backend', env=env,
                            text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr
