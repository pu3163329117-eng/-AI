from __future__ import annotations

from dataclasses import dataclass, field
import os
import re
from pathlib import Path

try:
    from backend.config import ROOT
except ModuleNotFoundError:
    from config import ROOT


EXPECTED_DSH_VERSION = "0.2.0-rc.2"
DEFAULT_DSH_BIN = Path(r"C:\Users\admin\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js")


def _switch(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized not in {"0", "1", "false", "true", "off", "on"}:
        raise ValueError(f"{name}_INVALID")
    return normalized in {"1", "true", "on"}


def _path(value: str, name: str) -> Path:
    # Preserve the lexical path so junction/symlink checks cannot be bypassed
    # by resolving away the configured link before runtime admission.
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{name}_INVALID")
    return path


@dataclass(frozen=True)
class CollaborationSettings:
    enabled: bool = False
    token: str = field(default="", repr=False)
    database_url: str = f"sqlite:///{ROOT / 'data' / 'collaboration.db'}"
    runtime: str = "mock"
    real_calls_enabled: bool = False
    budget_policy_path: Path | None = None
    dsh_bin: Path = DEFAULT_DSH_BIN
    dsh_home: Path = ROOT / "data" / "dsh-collaboration"
    workspace: Path = ROOT / "data" / "dsh-collaboration-workspace"
    profile_name: str = "wenyan-collaboration-readonly"
    provider: str = "deepseek-official"
    model: str = "deepseek-flash"
    max_tokens: int = 4096
    run_timeout_seconds: int = 300
    mock_step_delay_seconds: float = 0.01
    max_prompt_bytes: int = 262_144
    max_output_bytes: int = 131_072
    allowed_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")

    def validate(self) -> None:
        if self.runtime not in {"mock", "dsh-stdio"}:
            raise ValueError("COLLABORATION_RUNTIME_INVALID")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", self.profile_name):
            raise ValueError("COLLABORATION_PROFILE_INVALID")
        if self.enabled and (len(self.token) < 24 or len(self.token) > 512):
            raise ValueError("COLLABORATION_TOKEN_INVALID")
        if any(char.isspace() or ord(char) < 33 or ord(char) > 126 for char in self.token):
            raise ValueError("COLLABORATION_TOKEN_INVALID")
        if not self.database_url.startswith("sqlite:///"):
            raise ValueError("COLLABORATION_DATABASE_MUST_BE_SQLITE")
        if self.runtime == "dsh-stdio" and not self.real_calls_enabled:
            raise ValueError("REAL_HARNESS_CALLS_NOT_AUTHORIZED")
        if self.max_tokens < 1 or self.max_tokens > 65_536:
            raise ValueError("COLLABORATION_MAX_TOKENS_INVALID")
        if self.run_timeout_seconds < 1 or self.run_timeout_seconds > 3600:
            raise ValueError("COLLABORATION_TIMEOUT_INVALID")
        if not 0 <= self.mock_step_delay_seconds <= 30:
            raise ValueError("COLLABORATION_MOCK_DELAY_INVALID")
        if not 1024 <= self.max_prompt_bytes <= 1_048_576 or not 1024 <= self.max_output_bytes <= 1_048_576:
            raise ValueError("COLLABORATION_BYTE_LIMIT_INVALID")
        home = Path.home().resolve()
        if self.dsh_home.resolve() == home or self.workspace.resolve() == home:
            raise ValueError("COLLABORATION_RUNTIME_DIRECTORY_UNSAFE")
        if self.dsh_home.resolve() == self.workspace.resolve():
            raise ValueError("COLLABORATION_RUNTIME_DIRECTORIES_MUST_DIFFER")


def load_settings(environ: dict[str, str] | None = None) -> CollaborationSettings:
    env = os.environ if environ is None else environ
    defaults = CollaborationSettings()
    enabled = _switch(env.get("WENYAN_COLLABORATION_ENABLED", "0"), "WENYAN_COLLABORATION_ENABLED")
    # Disabled deployments must not depend on a developer machine's Harness
    # executable, directories, credentials or runtime-specific configuration.
    # Validate the switch itself first so a typo cannot accidentally enable it.
    if not enabled:
        return defaults
    origins = tuple(item.strip() for item in env.get("WENYAN_COLLABORATION_ALLOWED_ORIGINS", ",".join(defaults.allowed_origins)).split(",") if item.strip())
    settings = CollaborationSettings(
        enabled=enabled,
        token=env.get("WENYAN_COLLABORATION_TOKEN", ""),
        database_url=env.get("WENYAN_COLLABORATION_DATABASE_URL", defaults.database_url),
        runtime=env.get("WENYAN_COLLABORATION_RUNTIME", "mock"),
        real_calls_enabled=_switch(env.get("WENYAN_COLLABORATION_REAL_CALLS_ENABLED", "0"), "WENYAN_COLLABORATION_REAL_CALLS_ENABLED"),
        budget_policy_path=_path(env["WENYAN_COLLABORATION_BUDGET_POLICY_PATH"], "WENYAN_COLLABORATION_BUDGET_POLICY_PATH") if env.get("WENYAN_COLLABORATION_BUDGET_POLICY_PATH") else None,
        dsh_bin=_path(env.get("WENYAN_COLLABORATION_DSH_BIN", str(DEFAULT_DSH_BIN)), "WENYAN_COLLABORATION_DSH_BIN"),
        dsh_home=_path(env.get("WENYAN_COLLABORATION_DSH_HOME", str(defaults.dsh_home)), "WENYAN_COLLABORATION_DSH_HOME"),
        workspace=_path(env.get("WENYAN_COLLABORATION_WORKSPACE", str(defaults.workspace)), "WENYAN_COLLABORATION_WORKSPACE"),
        profile_name=env.get("WENYAN_COLLABORATION_PROFILE", defaults.profile_name),
        provider=env.get("WENYAN_COLLABORATION_PROVIDER", defaults.provider),
        model=env.get("WENYAN_COLLABORATION_MODEL", defaults.model),
        max_tokens=int(env.get("WENYAN_COLLABORATION_MAX_TOKENS", str(defaults.max_tokens))),
        run_timeout_seconds=int(env.get("WENYAN_COLLABORATION_RUN_TIMEOUT_SECONDS", str(defaults.run_timeout_seconds))),
        mock_step_delay_seconds=float(env.get("WENYAN_COLLABORATION_MOCK_STEP_DELAY_SECONDS", "0.01")),
        max_prompt_bytes=int(env.get("WENYAN_COLLABORATION_MAX_PROMPT_BYTES", "262144")),
        max_output_bytes=int(env.get("WENYAN_COLLABORATION_MAX_OUTPUT_BYTES", "131072")),
        allowed_origins=origins,
    )
    settings.validate()
    return settings
