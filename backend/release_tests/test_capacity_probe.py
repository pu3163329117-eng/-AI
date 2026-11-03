"""Synthetic capacity probe regression; no real accounts, mail, or remote network."""
import os
from pathlib import Path
import subprocess
import sys
import fastapi

ROOT = Path(__file__).resolve().parents[2]
CHILD = Path(__file__).with_name('capacity_probe_child.py')

def test_synthetic_capacity_create_write_and_readback(tmp_path):
    env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR', 'PATH') if key in os.environ}
    env.update({'TEMP': str(tmp_path), 'TMP': str(tmp_path), 'TMPDIR': str(tmp_path),
                'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                'WENYAN_TEST_SITE_DIR': str(Path(fastapi.__file__).resolve().parent.parent),
                'WENYAN_ENV': 'test', 'WENYAN_ACCESS_MODE': 'local',
                'WENYAN_DATABASE_URL': 'sqlite:///:memory:', 'WENYAN_AI_ENABLED': '0',
                'WENYAN_COLLABORATION_ENABLED': '0', 'WENYAN_COLLABORATION_REAL_CALLS_ENABLED': '0'})
    result = subprocess.run([sys.executable, '-I', '-B', str(CHILD), str(ROOT), str(tmp_path)],
                            cwd=ROOT, env=env, text=True, capture_output=True, timeout=90)
    assert result.returncode == 0, result.stderr
