"""Backend-only local settings. Never execute .env text or expose secret values."""
from dataclasses import dataclass, field
import os
from pathlib import Path

NAMES = {"WENYAN_AI_ENABLED", "WENYAN_AI_DATA_POLICY", "WENYAN_AI_MODEL", "DEEPSEEK_API_KEY"}


@dataclass(frozen=True)
class AISettings:
    enabled: bool = False
    data_policy: str = "synthetic_only"
    model: str = "deepseek-flash"
    api_key: str = field(default="", repr=False)

    def __post_init__(self):
        if (type(self.enabled) is not bool or self.data_policy not in {"synthetic_only", "minimal_learning"}
            or self.model not in {"deepseek-flash", "deepseek-v4-pro"}
            or not isinstance(self.api_key, str) or len(self.api_key) > 512
            or any(char.isspace() or ord(char) < 33 or ord(char) > 126 for char in self.api_key)):
            raise ValueError("AI_CONFIGURATION_INVALID")

    @property
    def ready(self):
        return self.enabled and bool(self.api_key)


def load_settings(*, environ=None, env_file=None):
    env = os.environ if environ is None else environ
    path = Path(env_file) if env_file is not None else Path(__file__).resolve().parents[1] / ".env"
    values = {}
    try:
        if path.exists():
            if path.stat().st_size > 16_384:
                raise ValueError()
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                name, sep, value = line.partition("=")
                name = name.strip()
                if name not in NAMES:
                    continue
                if not sep or name in values:
                    raise ValueError()
                value = value.strip()
                if value.startswith(('"', "'")):
                    if len(value) < 2 or value[-1] != value[0]:
                        raise ValueError()
                    value = value[1:-1]
                values[name] = value
        values.update({name: env[name] for name in NAMES if name in env})
        switch = values.get("WENYAN_AI_ENABLED", "0").lower()
        policy = values.get("WENYAN_AI_DATA_POLICY", "synthetic_only")
        model = values.get("WENYAN_AI_MODEL", "deepseek-flash")
        key = values.get("DEEPSEEK_API_KEY", "")
        if switch not in {"0", "1", "false", "true", "off", "on"} or policy not in {"synthetic_only", "minimal_learning"}:
            raise ValueError()
        if model not in {"deepseek-flash", "deepseek-v4-pro"}:
            raise ValueError()
        if len(key) > 512 or any(char.isspace() or ord(char) < 33 or ord(char) > 126 for char in key):
            raise ValueError()
        return AISettings(switch in {"1", "true", "on"}, policy, model, key)
    except (OSError, ValueError, UnicodeError):
        raise ValueError("AI_CONFIGURATION_INVALID") from None
