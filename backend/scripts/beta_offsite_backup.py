"""Age-encrypted private COS backup. Never read .env or expose provider errors.

Optional dependencies: Ubuntu age CLI; cos-python-sdk-v5==1.9.44.
Credentials are environment/private JSON only, never command-line arguments.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

from backend.scripts import beta_backup as local

FORMAT = "wenyan-offsite-receipt-v1"
AGE_HEADER = b"age-encryption.org/v1\n"
MAX_LIMIT = 1024 * 1024 * 1024
HEX = re.compile(r"[0-9a-f]{64}\Z")
OBJECT_NAME = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{32}\.tar\.age\Z")


class OffsiteError(ValueError):
    """An operator-safe constant code; never wrap raw exception messages."""


def _file(path: str | Path, *, existing: bool = True) -> Path:
    try:
        result = local.checked_path(path, existing=existing)
    except (local.BackupError, OSError):
        raise OffsiteError("OFFSITE_UNSAFE_FILE") from None
    if existing and os.name != "nt" and result.stat().st_mode & 0o037:
        raise OffsiteError("OFFSITE_PRIVATE_FILE_REQUIRED")
    return result


def _directory(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise OffsiteError("OFFSITE_PRIVATE_DIRECTORY_REQUIRED")
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise OffsiteError("OFFSITE_LINK_FORBIDDEN")
    if not path.is_dir():
        raise OffsiteError("OFFSITE_PRIVATE_DIRECTORY_REQUIRED")
    if os.name != "nt":
        info = path.stat()
        if info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise OffsiteError("OFFSITE_PRIVATE_DIRECTORY_REQUIRED")
    return path.resolve()


def _read_json(path: str | Path) -> dict:
    path = _file(path)
    if path.stat().st_size > 32768:
        raise OffsiteError("OFFSITE_JSON_TOO_LARGE")
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError, OSError):
        raise OffsiteError("OFFSITE_JSON_INVALID") from None
    if not isinstance(result, dict):
        raise OffsiteError("OFFSITE_JSON_INVALID")
    return result


@dataclass(frozen=True)
class Settings:
    region: str
    bucket: str
    prefix: str
    recipient: str
    secret_id: str = field(repr=False)
    secret_key: str = field(repr=False)
    token: str = field(default="", repr=False)
    age_bin: Path = Path("/usr/bin/age")
    identity_path: Path | None = field(default=None, repr=False)
    max_bytes: int = 256 * 1024 * 1024
    receipt_path: Path = Path("/var/lib/wenyan-ops/offsite-success.json")

    def validate(self) -> None:
        if not re.fullmatch(r"[a-z]{2}-[a-z]+(?:-[a-z]+)?(?:-\d)?", self.region):
            raise OffsiteError("OFFSITE_REGION_INVALID")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}", self.bucket):
            raise OffsiteError("OFFSITE_BUCKET_INVALID")
        if (not self.prefix.endswith("/") or len(self.prefix) > 160
                or not re.fullmatch(r"(?:[a-zA-Z0-9_-]+/)+", self.prefix)):
            raise OffsiteError("OFFSITE_PREFIX_INVALID")
        if not re.fullmatch(r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}", self.recipient):
            raise OffsiteError("OFFSITE_RECIPIENT_INVALID")
        if not 16384 <= self.max_bytes <= MAX_LIMIT:
            raise OffsiteError("OFFSITE_SIZE_LIMIT_INVALID")
        for credential in (self.secret_id, self.secret_key):
            if (not 16 <= len(credential) <= 512 or not credential.isascii() or any(c.isspace() or ord(c) < 33 for c in credential)
                    or any(marker in credential.lower() for marker in ("replace", "placeholder", "change_me"))):
                raise OffsiteError("OFFSITE_CREDENTIALS_REQUIRED")
        if len(self.token) > 4096 or not self.token.isascii() or any(c.isspace() or ord(c) < 33 for c in self.token):
            raise OffsiteError("OFFSITE_TOKEN_INVALID")
        if not self.age_bin.is_absolute():
            raise OffsiteError("OFFSITE_AGE_BINARY_INVALID")


def settings(environ: dict | None = None) -> Settings:
    env = dict(os.environ if environ is None else environ)
    values = _read_json(env["WENYAN_OFFSITE_CONFIG"]) if env.get("WENYAN_OFFSITE_CONFIG") else {}
    values.update({key: value for key, value in env.items() if key.startswith("WENYAN_OFFSITE_")})
    def get(name, default=""):
        value = values.get("WENYAN_OFFSITE_" + name, default)
        if not isinstance(value, str):
            raise OffsiteError("OFFSITE_CONFIG_INVALID")
        return value
    try:
        result = Settings(region=get("REGION"), bucket=get("BUCKET"), prefix=get("PREFIX"), recipient=get("RECIPIENT"),
                          secret_id=get("SECRET_ID"), secret_key=get("SECRET_KEY"), token=get("TOKEN"),
                          age_bin=Path(get("AGE_BIN", "/usr/bin/age")),
                          identity_path=Path(get("IDENTITY_PATH")) if get("IDENTITY_PATH") else None,
                          max_bytes=int(get("MAX_BYTES", "268435456")),
                          receipt_path=Path(get("RECEIPT_PATH", "/var/lib/wenyan-ops/offsite-success.json")))
    except (TypeError, ValueError):
        raise OffsiteError("OFFSITE_CONFIG_INVALID") from None
    result.validate()
    return result


def _hash(path: Path) -> str:
    with _file(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _new_file(path: Path):
    _file(path, existing=False)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    return os.fdopen(fd, "wb")


@contextmanager
def _locked(root: Path):
    path = root / ".offsite.lock"
    if path.exists() or path.is_symlink():
        _file(path)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            try:
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError:
                raise OffsiteError("OFFSITE_ALREADY_RUNNING") from None
        else:
            import fcntl
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise OffsiteError("OFFSITE_ALREADY_RUNNING") from None
        yield
    finally:
        os.close(fd)


def _age(config: Settings, source: Path, target: Path, *, decrypt=False):
    # Public age executable may be world-readable; credentials/identities may not.
    try:
        binary = local.checked_path(config.age_bin, existing=True)
    except (local.BackupError, OSError):
        raise OffsiteError("OFFSITE_AGE_BINARY_INVALID") from None
    command = [str(binary)]
    if decrypt:
        if config.identity_path is None:
            raise OffsiteError("OFFSITE_OFFLINE_IDENTITY_REQUIRED")
        identity = _file(config.identity_path)
        if os.name != "nt" and (identity.stat().st_mode & 0o077 or identity.stat().st_uid != os.geteuid()):
            raise OffsiteError("OFFSITE_PRIVATE_IDENTITY_REQUIRED")
        command += ["--decrypt", "--identity", str(identity)]
    else:
        command += ["--encrypt", "--recipient", config.recipient]
    # No credential-bearing environment, shell, external plugins or stderr logs.
    with _file(source).open("rb") as plain, _new_file(target) as output:
        try:
            result = subprocess.run(command, stdin=plain, stdout=output, stderr=subprocess.DEVNULL,
                                    env={"PATH": str(binary.parent), "LANG": "C", "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")},
                                    timeout=120, check=False)
        except (OSError, subprocess.SubprocessError):
            raise OffsiteError("OFFSITE_AGE_FAILED") from None
        if result.returncode:
            raise OffsiteError("OFFSITE_AGE_FAILED")
        output.flush()
        os.fsync(output.fileno())
    if target.stat().st_size > config.max_bytes + 1048576:
        raise OffsiteError("OFFSITE_SIZE_LIMIT_EXCEEDED")
    if not decrypt:
        with target.open("rb") as stream:
            if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                raise OffsiteError("OFFSITE_CIPHERTEXT_REQUIRED")


def cos_client(config: Settings):
    # Prevent SDK/HTTP diagnostics from recording signed requests or raw errors.
    for name in ("qcloud_cos", "requests", "urllib3"):
        logger = logging.getLogger(name)
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        logger.setLevel(logging.CRITICAL + 1)
    try:
        from qcloud_cos import CosConfig, CosS3Client
        from requests import Session
    except ImportError:
        raise OffsiteError("OFFSITE_COS_SDK_MISSING") from None
    session = Session()
    session.trust_env = False
    conf = CosConfig(Region=config.region, SecretId=config.secret_id, SecretKey=config.secret_key, Token=config.token or None,
                     Scheme="https", Timeout=20, AllowRedirects=False, VerifySSL=True)
    return CosS3Client(conf, retry=0, session=session)


def _object_key(config: Settings, name: str) -> str:
    if not isinstance(name, str) or not OBJECT_NAME.fullmatch(name):
        raise OffsiteError("OFFSITE_OBJECT_NAME_INVALID")
    return config.prefix + name


def _head(client, config: Settings, key: str, digest: str, size: int):
    metadata = {str(k).lower(): v for k, v in client.head_object(Bucket=config.bucket, Key=key).items()}
    try:
        actual_size = int(metadata.get("content-length", -1))
    except (TypeError, ValueError):
        actual_size = -1
    if actual_size != size or metadata.get("x-cos-meta-sha256") != digest:
        raise OffsiteError("OFFSITE_REMOTE_METADATA_MISMATCH")


def _download(client, config: Settings, key: str, digest: str, size: int, target: Path | None = None):
    if not HEX.fullmatch(digest) or not 1 <= size <= config.max_bytes + 1048576:
        raise OffsiteError("OFFSITE_REMOTE_SIZE_INVALID")
    _head(client, config, key, digest, size)
    result = client.get_object(Bucket=config.bucket, Key=key)
    stream = result["Body"].get_raw_stream()
    hash_state, count = hashlib.sha256(), 0
    output = None
    try:
        if target is not None:
            output = _new_file(target)
        deadline = time.monotonic() + 120
        while True:
            chunk = stream.read(min(1048576, size - count + 1))
            if not chunk:
                break
            count += len(chunk)
            if count > size or time.monotonic() > deadline:
                raise OffsiteError("OFFSITE_REMOTE_SIZE_INVALID")
            hash_state.update(chunk)
            if output:
                output.write(chunk)
        if count != size or not hmac.compare_digest(hash_state.hexdigest(), digest):
            raise OffsiteError("OFFSITE_REMOTE_HASH_MISMATCH")
        if output:
            output.flush()
            os.fsync(output.fileno())
    finally:
        stream.close()
        if output:
            output.close()


def _receipt(config: Settings, report: dict):
    target = config.receipt_path
    _directory(target.parent)
    prior = None
    if target.exists() or target.is_symlink():
        existing = _read_json(target)
        if existing.get("format") != FORMAT:
            raise OffsiteError("OFFSITE_RECEIPT_TARGET_OCCUPIED")
        prior = target.stat()
    temp = target.parent / (".offsite-receipt-" + uuid.uuid4().hex)
    try:
        with _new_file(temp) as stream:
            stream.write((json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        if prior is None:
            if target.exists() or target.is_symlink():
                raise OffsiteError("OFFSITE_RECEIPT_TARGET_CHANGED")
        else:
            _file(target)
            current = target.stat()
            if (prior.st_dev, prior.st_ino, prior.st_mtime_ns) != (current.st_dev, current.st_ino, current.st_mtime_ns):
                raise OffsiteError("OFFSITE_RECEIPT_TARGET_CHANGED")
        os.replace(temp, target)
        if os.name != "nt":
            directory_fd = os.open(target.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temp.exists():
            temp.unlink()


def create(database: str | Path, work_root: str | Path, config: Settings, *, client=None) -> dict:
    config.validate()
    source = _file(database)
    root = _directory(work_root)
    _directory(config.receipt_path.parent)
    if config.receipt_path.exists() or config.receipt_path.is_symlink():
        if _read_json(config.receipt_path).get("format") != FORMAT:
            raise OffsiteError("OFFSITE_RECEIPT_TARGET_OCCUPIED")
    if source.stat().st_size > config.max_bytes:
        raise OffsiteError("OFFSITE_SIZE_LIMIT_EXCEEDED")
    wal = Path(str(source) + "-wal")
    if (wal.exists() or wal.is_symlink()) and source.stat().st_size + _file(wal).stat().st_size > config.max_bytes:
        raise OffsiteError("OFFSITE_SIZE_LIMIT_EXCEEDED")
    with _locked(root), tempfile.TemporaryDirectory(prefix=".offsite-", dir=root) as temporary:
        job = Path(temporary)
        snapshot = job / "snapshot.db"
        metadata = local.backup(source, snapshot)
        if snapshot.stat().st_size > config.max_bytes:
            raise OffsiteError("OFFSITE_SIZE_LIMIT_EXCEEDED")
        archive = job / "snapshot.tar"
        with _new_file(archive) as stream, tarfile.open(fileobj=stream, mode="w") as tar:
            for file in (snapshot, Path(str(snapshot) + ".manifest.json")):
                tar.add(file, arcname=file.name, recursive=False)
        if archive.stat().st_size > config.max_bytes:
            raise OffsiteError("OFFSITE_SIZE_LIMIT_EXCEEDED")
        name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex + ".tar.age"
        key = _object_key(config, name)
        cipher = root / name
        try:
            _age(config, archive, cipher)
            digest, size = _hash(cipher), cipher.stat().st_size
            provider = client if client is not None else cos_client(config)
            with cipher.open("rb") as body:
                provider.put_object(Bucket=config.bucket, Key=key, Body=body, EnableMD5=True,
                                    ContentLength=str(size), ContentType="application/octet-stream",
                                    # 1.9.44's mapped() forwards Metadata keys verbatim;
                                    # the named ForbidOverwrite parameter is newer than this pin.
                                    Metadata={"x-cos-meta-sha256": digest, "x-cos-forbid-overwrite": "true"})
            _download(provider, config, key, digest, size)
            report = {"format": FORMAT, "status": "ok", "completed_at_utc": datetime.now(timezone.utc).isoformat(),
                      "backup_sha256": metadata["database_sha256"], "cipher_sha256": digest, "cipher_size_bytes": size,
                      "bucket": config.bucket, "region": config.region, "object_key": key}
            _receipt(config, report)
            return report
        finally:
            # Only the fresh, unpredictable ciphertext produced in this call.
            if cipher.exists() and not cipher.is_symlink():
                cipher.unlink()


def recover(receipt_path: str | Path, work_root: str | Path, config: Settings, *, offline_confirmed=False, client=None) -> dict:
    if not offline_confirmed:
        raise OffsiteError("OFFSITE_OFFLINE_CONFIRMATION_REQUIRED")
    config.validate()
    receipt = _read_json(receipt_path)
    root = _directory(work_root)
    if receipt.get("format") != FORMAT or receipt.get("status") != "ok":
        raise OffsiteError("OFFSITE_RECEIPT_INVALID")
    key = receipt.get("object_key", "")
    if receipt.get("bucket") != config.bucket or receipt.get("region") != config.region or not isinstance(key, str) or not key.startswith(config.prefix):
        raise OffsiteError("OFFSITE_RECEIPT_TARGET_MISMATCH")
    key = _object_key(config, key[len(config.prefix):])
    digest, size = receipt.get("cipher_sha256", ""), receipt.get("cipher_size_bytes", 0)
    if not isinstance(digest, str) or type(size) is not int or not isinstance(receipt.get("backup_sha256"), str) or not HEX.fullmatch(receipt["backup_sha256"]):
        raise OffsiteError("OFFSITE_RECEIPT_INVALID")
    if config.identity_path is None:
        raise OffsiteError("OFFSITE_OFFLINE_IDENTITY_REQUIRED")
    _file(config.identity_path)
    # Always create a fresh private directory. No destination argument can target live DB.
    job = Path(tempfile.mkdtemp(prefix="restore-", dir=root))
    cipher, plain = job / "snapshot.tar.age", job / "snapshot.tar"
    provider = client if client is not None else cos_client(config)
    _download(provider, config, key, digest, size, cipher)
    _age(config, cipher, plain, decrypt=True)
    with tarfile.open(plain, mode="r:") as tar:
        members = tar.getmembers()
        if {entry.name for entry in members} != {"snapshot.db", "snapshot.db.manifest.json"} or len(members) != 2:
            raise OffsiteError("OFFSITE_ARCHIVE_INVALID")
        if any(not entry.isfile() or entry.size < 0 or entry.size > config.max_bytes for entry in members):
            raise OffsiteError("OFFSITE_ARCHIVE_INVALID")
        if sum(entry.size for entry in members) > config.max_bytes:
            raise OffsiteError("OFFSITE_SIZE_LIMIT_EXCEEDED")
        for entry in members:
            with _new_file(job / entry.name) as output, tar.extractfile(entry) as source:
                while chunk := source.read(1048576):
                    output.write(chunk)
    snapshot = job / "snapshot.db"
    if local.verify(snapshot)["database_sha256"] != receipt["backup_sha256"]:
        raise OffsiteError("OFFSITE_BACKUP_HASH_MISMATCH")
    restored = job / "restored.db"
    result = local.restore(snapshot, restored, offline_confirmed=True)
    return {"status": "ok", "restore_directory": str(job), "database_sha256": result["database_sha256"],
            "auth_revocations": result["auth_revocations"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("create")
    make.add_argument("--database", required=True)
    make.add_argument("--work-root", required=True)
    restore = commands.add_parser("restore")
    restore.add_argument("--receipt", required=True)
    restore.add_argument("--work-root", required=True)
    restore.add_argument("--offline-confirmed", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = settings()
        if args.command == "create":
            result = create(args.database, args.work_root, config)
        else:
            result = recover(args.receipt, args.work_root, config, offline_confirmed=args.offline_confirmed)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, OffsiteError) else "OFFSITE_OPERATION_FAILED"
        print(json.dumps({"status": "error", "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
