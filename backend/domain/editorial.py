"""Pure content fingerprints and readiness checks for local human review.

An approval records a person attesting to one concrete content version. These
checks catch missing source data; they do not claim to verify textual accuracy.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import unicodedata
from urllib.parse import urlsplit

from .reading_context import reading_context_for, validate_reading_context


def content_fingerprint(metadata: dict, content: dict[str, dict]) -> str:
    normalized = {}
    for stage, payload in sorted(content.items()):
        normalized[stage] = payload
        if isinstance(payload, dict) and isinstance(payload.get("source"), str) and isinstance(payload.get("passage"), str):
            # Explicitly saving an already displayed registry context is a
            # no-op, not a different teaching version merely due to storage.
            normalized[stage] = {**payload, "reading_context": reading_context_for(payload)}
    serialized = json.dumps(
        {"metadata": metadata, "content": normalized},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def is_public_source_url(value: object) -> bool:
    """Accept public HTTP(S) citations, not credentials or local network links.

    No URLs are fetched here. DNS resolution is intentionally not part of the
    review operation, so a URL is a citation rather than an SSRF request.
    """
    if not isinstance(value, str) or not value.strip() or value != value.strip() or any(c.isspace() or unicodedata.category(c)[0] == "C" for c in value):
        return False
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        # Accessing port also rejects malformed port values/brackets.
        parsed.port
        if parsed.scheme not in ("http", "https") or not hostname or parsed.username is not None or parsed.password is not None:
            return False
        hostname = hostname.rstrip(".").lower()
        if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
            return False
        try:
            address = ipaddress.ip_address(hostname)
            return address.is_global and not address.is_multicast
        except ValueError:
            # A single-label host is normally an intranet machine name.
            # Reject legacy browser IPv4 forms such as 127.1 / 0177.0.0.1.
            parts = hostname.split(".")
            return "." in hostname and not parts[-1].isdigit() and all(
                part and len(part.encode("idna")) <= 63 and part[0].isalnum()
                and part[-1].isalnum() and part.replace("-", "").isalnum()
                for part in parts
            )
    except (ValueError, UnicodeError):
        return False


def _normalized_text(value: str) -> str:
    # Teaching editions may differ in whitespace and modern punctuation.
    return "".join(c for c in value if unicodedata.category(c)[0] not in "PZSC")


def review_readiness(content: dict[str, dict]) -> list[str]:
    issues: list[str] = []
    for stage in ("CORE", "TRANSFER"):
        payload = content.get(stage)
        if not isinstance(payload, dict):
            issues.append(f"{stage}：缺少训练内容。")
            continue
        if "reading_context" in payload and not validate_reading_context(payload["reading_context"]):
            issues.append(f"{stage}：阅读资料格式无效。")
            continue
        if not isinstance(payload.get("source"), str) or not isinstance(payload.get("passage"), str):
            issues.append(f"{stage}：缺少题源或题文。")
            continue
        context = reading_context_for(payload)
        passage_text = _normalized_text(payload["passage"])
        if not passage_text or passage_text not in _normalized_text(context["full_text"]):
            issues.append(f"{stage}：题文不是阅读资料中的连续原文，请核对跨段拼接或题源不一致。")
        if not is_public_source_url(context.get("source_url")):
            issues.append(f"{stage}：需补充不含凭证的公开 HTTP(S) 原文来源链接。")
        version = context.get("text_version", "").strip()
        if not version or "待" in version:
            issues.append(f"{stage}：需填写已校订的资料版本，不能使用待校订占位文本。")
        for key, label in (("author", "作者"), ("era", "时代")):
            value = context.get(key, "").strip()
            if not value or "待" in value:
                issues.append(f"{stage}：需补充{label}信息。")
        variable = payload.get("variable")
        if not isinstance(variable, str) or not variable.strip() or variable not in payload["passage"]:
            issues.append(f"{stage}：目标词必须出现在题文中。")
        elif not _normalized_text(variable) or _normalized_text(variable) not in _normalized_text(context["full_text"]):
            issues.append(f"{stage}：阅读资料中找不到目标词，需核对题源。")
    return issues
