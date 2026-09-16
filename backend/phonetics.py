from __future__ import annotations

import json
import os
import re
import unicodedata
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from .alignment import normalize_arabic

DATASET_ID = os.getenv("QWS_PHONETIC_DATASET", "Buraaq/quran-md-words")
DATASET_SERVER = os.getenv("QWS_DATASET_SERVER", "https://datasets-server.huggingface.co")
CACHE_ROOT = Path(os.getenv("QWS_CACHE_DIR", Path.home() / ".cache" / "quran-word-sync-maker")) / "phonetics-v1"

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "ʹ": "'", "`": "'"})
_DASHES_RE = re.compile(r"[‐‑‒–—−]")
_SPACE_RE = re.compile(r"\s+")


def normalize_phonetic(text: str) -> str:
    """Normalize Quran-MD transliteration without discarding phonetic symbols.

    The Qur'an-specific tokenizer was trained directly on Quran-MD ``word_tr``.
    We therefore keep the dataset's Latin/IPA-like characters and only normalize
    Unicode punctuation/case/spacing that can vary in JSON transport.
    """
    text = unicodedata.normalize("NFC", str(text or "")).translate(_APOSTROPHES)
    # The Qur'an phonetic tokenizer is mostly lowercase, but its published
    # vocabulary contains a distinct uppercase ``H`` token as well as lowercase
    # ``h``. Preserve that one phonetic distinction while normalizing ordinary
    # Latin capitals such as the dataset's display-form ``Bismi`` to lowercase.
    text = "".join(ch if ch == "H" else ch.lower() for ch in text)
    text = _DASHES_RE.sub("-", text)
    text = _SPACE_RE.sub(" ", text).strip()
    return text


def _cache_file(surah: int, ayah: int) -> Path:
    return CACHE_ROOT / f"{surah:03d}-{ayah:03d}.json"


def _read_cache(surah: int, ayah: int) -> list[dict[str, Any]] | None:
    path = _cache_file(surah, ayah)
    try:
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, list) and payload:
                return payload
    except Exception:
        return None
    return None


def _write_cache(surah: int, ayah: int, rows: list[dict[str, Any]]) -> None:
    try:
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        path = _cache_file(surah, ayah)
        path.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception:
        # A read-only home folder should not prevent alignment.
        pass


def _dataset_request(params: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    url = f"{DATASET_SERVER.rstrip('/')}/filter?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "QuranWordSyncMaker/5.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def fetch_ayah_phonetic_rows(surah: int, ayah: int, *, force_refresh: bool = False) -> list[dict[str, Any]]:
    """Fetch only the small metadata slice for one ayah from Quran-MD.

    Audio blobs are never downloaded. The Hugging Face dataset-viewer filter API
    returns the row metadata for the requested surah/ayah, capped at 100 rows per
    request; pagination handles unusually long ayahs.
    """
    if not force_refresh:
        cached = _read_cache(surah, ayah)
        if cached:
            return cached

    where = f'"surah_id"={int(surah)} AND "ayah_id"={int(ayah)}'
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        payload = _dataset_request(
            {
                "dataset": DATASET_ID,
                "config": "default",
                "split": "train",
                "where": where,
                "orderby": '"word_index"',
                "offset": offset,
                "length": 100,
            }
        )
        batch = payload.get("rows") or []
        for item in batch:
            row = item.get("row") if isinstance(item, dict) else None
            if isinstance(row, dict):
                # Store text metadata only; never cache the dataset audio object.
                rows.append(
                    {
                        "surah_id": row.get("surah_id"),
                        "ayah_id": row.get("ayah_id"),
                        "word_index": row.get("word_index"),
                        "word_id": row.get("word_id"),
                        "word_ar": row.get("word_ar"),
                        "word_tr": row.get("word_tr"),
                    }
                )
        if len(batch) < 100:
            break
        offset += len(batch)
        total = payload.get("num_rows_total")
        if isinstance(total, int) and offset >= total:
            break
        if offset > 300:  # defensive: no Qur'anic ayah approaches this many tokens
            break

    if not rows:
        raise RuntimeError(f"Quran-MD returned no phonetic metadata for {surah}:{ayah}.")
    rows.sort(key=lambda row: (int(row.get("word_index") or 0), str(row.get("word_id") or "")))
    _write_cache(surah, ayah, rows)
    return rows


def _similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(None, left, right).ratio()


def map_payload_to_phonetics(words_payload: list[dict[str, Any]], surah: int) -> tuple[list[str] | None, dict[str, Any]]:
    """Map selected Uthmani words to Quran-MD phonetic targets.

    Quran-MD documents ``word_index`` as zero-based. We prefer that exact position
    when its Arabic text agrees, then fall back to ordered text matching for source
    edition or tokenization differences.
    """
    by_ayah: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    for global_index, item in enumerate(words_payload):
        ayah = int(item.get("ayahNumber") or 0)
        by_ayah.setdefault(ayah, []).append((global_index, item))

    result: list[str | None] = [None] * len(words_payload)
    matched = 0
    diagnostics: list[str] = []

    for ayah, payload_items in by_ayah.items():
        rows = fetch_ayah_phonetic_rows(surah, ayah)
        row_words = [normalize_arabic(row.get("word_ar") or "") for row in rows]
        cursor = 0
        for global_index, item in payload_items:
            target = normalize_arabic(item.get("text") or "")
            best_index = -1
            best_score = 0.0

            # Quran-MD documents word_index as zero-based. Prefer that exact position
            # when its Arabic text agrees; this is especially important for repeated
            # words where a similarity-only search can choose the wrong occurrence.
            expected_index = int(item.get("wordIndex") or 0)
            if 0 <= expected_index < len(rows):
                expected_score = _similarity(target, row_words[expected_index])
                if expected_score >= 0.72:
                    best_index, best_score = expected_index, expected_score

            # Ordered local search remains as a fallback for edition/tokenization
            # differences (for example a prefixed basmala in one source).
            search_end = min(len(rows), cursor + 5)
            for row_index in range(cursor, search_end):
                score = _similarity(target, row_words[row_index])
                if score > best_score:
                    best_index, best_score = row_index, score
            if best_index < 0 or best_score < 0.72:
                # One wider search can recover from a one-off tokenization mismatch.
                for row_index in range(cursor, len(rows)):
                    score = _similarity(target, row_words[row_index])
                    if score > best_score:
                        best_index, best_score = row_index, score
            if best_index >= 0 and best_score >= 0.72:
                phonetic = normalize_phonetic(rows[best_index].get("word_tr") or "")
                if phonetic:
                    result[global_index] = phonetic
                    matched += 1
                    cursor = best_index + 1
                    continue
            diagnostics.append(f"{surah}:{ayah} word {int(item.get('wordIndex', 0)) + 1}")

    coverage = matched / max(1, len(words_payload))
    info = {
        "dataset": DATASET_ID,
        "matched": matched,
        "total": len(words_payload),
        "coverage": coverage,
        "unmatched": diagnostics[:12],
    }
    if coverage < 0.92 or any(value is None for value in result):
        return None, info
    return [str(value) for value in result], info
