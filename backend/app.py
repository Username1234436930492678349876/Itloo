from __future__ import annotations

import json
import html as html_lib
import random
import re
import subprocess
import urllib.parse
import urllib.request
import math
from difflib import SequenceMatcher
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from .alignment import (
    build_target_layout,
    ctc_viterbi,
    ctc_blank_boundary_curve,
    fuse_forced_alignments,
    local_realign_by_ayah,
    normalize_arabic,
    normalize_arabic as _normalize_arabic_target,
    quran_delimiter_curve,
    refine_boundaries,
    rms_boundary_curve,
    target_token_spans,
    word_timings_from_tokens,
)
from .audio_utils import convert_to_wav, load_mono, ffmpeg_exe
from .model_runtime import ALIGNMENT_MODEL, QURAN_MODEL, emissions, get_alignment_model, get_quran_model
from .phonetics import DATASET_ID, map_payload_to_phonetics, normalize_phonetic
from .render import render_video

ROOT = Path(__file__).resolve().parents[1]
app = FastAPI(title="Qur'an Word Sync Maker AI", version="7.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")

app.mount("/src", StaticFiles(directory=ROOT / "src"), name="src")
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")


def _save_upload(upload: UploadFile, folder: Path, name: str | None = None) -> Path:
    suffix = Path(upload.filename or "upload.bin").suffix or ".bin"
    path = folder / (name or f"upload{suffix}")
    with path.open("wb") as handle:
        shutil.copyfileobj(upload.file, handle)
    return path


COMMONS_API = "https://commons.wikimedia.org/w/api.php"
COMMONS_USER_AGENT = "QuranWordSyncMaker/6.9 (local background browser)"
BACKGROUND_THEMES = {
    "calm": ["clouds timelapse", "night sky timelapse", "ocean waves", "mountain clouds", "forest mist", "desert sunset"],
    "sky": ["night sky timelapse", "stars timelapse", "clouds timelapse", "moon clouds"],
    "nature": ["forest mist", "mountain clouds", "ocean waves", "waterfall slow motion", "desert sunset"],
    "dark": ["night sky", "dark clouds timelapse", "moon clouds", "fog forest"],
}


# Curated built-in recitation library. Files are fetched ayah-by-ayah from
# EveryAyah, then concatenated locally so the resulting clip contains only the
# selected verse range. Keeping the catalog small makes the UI predictable.
RECITATION_LIBRARY = {
    "mishary_alafasi": {
        "name": "Mishary Rashid Alafasy",
        "folder": "Alafasy_128kbps",
        "bitrate": "128 kbps",
        "quranicaudio_slug": "mishaari_raashid_al_3afaasee",
        "istiatha_probe_surah": 95,
    },
    "khalifa_altunaiji": {
        "name": "Khalifa Al Tunaiji",
        "folder": "khalefa_al_tunaiji_64kbps",
        "bitrate": "64 kbps",
        "quranicaudio_slug": "khalifah_taniji",
        "istiatha_probe_surah": 95,
    },
    "yasser_aldosari": {
        "name": "Yasser Al Dosari",
        "folder": "Yasser_Ad-Dussary_128kbps",
        "bitrate": "128 kbps",
        "quranicaudio_slug": "yasser_ad-dussary",
        "istiatha_probe_surah": 95,
    },
}
EVERYAYAH_BASE = "https://everyayah.com/data"
LIBRARY_CACHE = ROOT / ".cache" / "recitation-library"


ISTIATHA_WORDS = ["اعوذ", "بالله", "من", "الشيطان", "الرجيم"]

def _read_url_bytes(url: str, *, accept: str = "*/*", timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": "QuranWordSyncMaker/7.2 (local recitation library)",
        "Accept": accept,
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()

def _download_quranicaudio_surah(reciter_key: str, surah: int) -> Path:
    info = RECITATION_LIBRARY.get(reciter_key)
    if info is None:
        raise ValueError("Unknown reciter.")
    slug = str(info.get("quranicaudio_slug") or "").strip("/")
    if not slug:
        raise RuntimeError("No full-surah source is configured for this reciter.")
    cache_dir = LIBRARY_CACHE / reciter_key / "quranicaudio"
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{int(surah):03d}.mp3"
    if out.exists() and out.stat().st_size > 8192:
        return out
    url = f"https://download.quranicaudio.com/quran/{slug}/{int(surah):03d}.mp3"
    data = _read_url_bytes(url, accept="audio/mpeg,*/*", timeout=45)
    if len(data) < 8192:
        raise RuntimeError(f"The full-surah source returned an incomplete file for {info['name']}.")
    tmp = out.with_suffix('.tmp')
    tmp.write_bytes(data)
    tmp.replace(out)
    return out


def _extract_library_istiatha(reciter_key: str) -> Path:
    """Create/caches a clean reciter-specific isti'adhah clip.

    The source is a full-surah recording by the same reciter. We align the known
    isti'adhah (and, when present, basmalah) in the opening audio, then trim only
    the isti'adhah. This avoids hard-coded timestamps that vary by reciter.
    """
    info = RECITATION_LIBRARY.get(reciter_key)
    if info is None:
        raise ValueError("Unknown reciter.")
    cache_dir = LIBRARY_CACHE / reciter_key / "supplements"
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / "istiatha.m4a"
    if out.exists() and out.stat().st_size > 2048:
        return out
    probe_surah = int(info.get("istiatha_probe_surah", 95))
    source = _download_quranicaudio_surah(reciter_key, probe_surah)
    with tempfile.TemporaryDirectory(prefix="qws-istiatha-") as td:
        td = Path(td)
        wav = td / "opening.wav"
        command = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-t", "16", "-ac", "1", "-ar", "16000", str(wav)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Could not prepare the isti'adhah source audio.")
        samples, sample_rate = load_mono(wav)
        duration = len(samples) / sample_rate
        runtime = get_alignment_model()
        log_probs = emissions(runtime, samples, sample_rate)
        blank_id = runtime.processor.tokenizer.pad_token_id
        if blank_id is None:
            blank_id = runtime.model.config.pad_token_id
        if blank_id is None:
            blank_id = 0
        candidates = [ISTIATHA_WORDS + BASMALAH_WORDS, ISTIATHA_WORDS]
        aligned = None
        for target_words in candidates:
            try:
                layout = build_target_layout(runtime.processor.tokenizer, [normalize_arabic(w) for w in target_words])
                path, labels = ctc_viterbi(log_probs, layout.ids, int(blank_id))
                spans = target_token_spans(path, labels, layout.ids, log_probs)
                words, _ = word_timings_from_tokens(layout, spans, duration, log_probs.shape[0])
                first = words[:len(ISTIATHA_WORDS)]
                mean_conf = float(np.mean([float(w.get("ctc_confidence", 0.0)) for w in first])) if first else 0.0
                if len(first) == len(ISTIATHA_WORDS) and mean_conf >= 0.04:
                    aligned = first
                    break
            except Exception:
                continue
        if not aligned:
            raise RuntimeError(f"Could not isolate isti'adhah reliably for {info['name']}.")
        start = max(0.0, float(aligned[0]["start"]) - 0.05)
        end = min(duration, float(aligned[-1]["end"]) + 0.08)
        if end - start < 0.5 or end - start > 10:
            raise RuntimeError(f"The detected isti'adhah duration for {info['name']} was not plausible.")
        command = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.4f}", "-to", f"{end:.4f}", "-i", str(source), "-vn", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(out)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0 or not out.exists():
            raise RuntimeError(result.stderr.strip() or "Could not save the isti'adhah clip.")
    return out


def _library_ayah_url(reciter_key: str, surah: int, ayah: int) -> str:
    info = RECITATION_LIBRARY.get(reciter_key)
    if info is None:
        raise ValueError("Unknown reciter.")
    if not 1 <= int(surah) <= 114 or not 1 <= int(ayah) <= 286:
        raise ValueError("Invalid Surah or ayah number.")
    return f"{EVERYAYAH_BASE}/{info['folder']}/{int(surah):03d}{int(ayah):03d}.mp3"


def _download_library_ayah(reciter_key: str, surah: int, ayah: int) -> Path:
    info = RECITATION_LIBRARY.get(reciter_key)
    if info is None:
        raise ValueError("Unknown reciter.")
    folder = LIBRARY_CACHE / reciter_key / f"{int(surah):03d}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{int(surah):03d}{int(ayah):03d}.mp3"
    if path.exists() and path.stat().st_size > 2048:
        return path
    url = _library_ayah_url(reciter_key, surah, ayah)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "QuranWordSyncMaker/7.2 (local recitation library)", "Accept": "audio/mpeg,*/*;q=0.8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            data = response.read()
    except Exception as exc:
        raise RuntimeError(f"Could not download {info['name']} — {surah}:{ayah}. Check your internet connection.") from exc
    if len(data) < 2048:
        raise RuntimeError(f"The audio source returned an incomplete file for {surah}:{ayah}.")
    tmp = path.with_suffix('.tmp')
    tmp.write_bytes(data)
    tmp.replace(path)
    return path


def _concat_library_audio(paths: list[Path], output_path: Path) -> None:
    if not paths:
        raise ValueError("No ayahs were selected.")
    concat_file = output_path.parent / "concat.txt"
    lines = []
    for path in paths:
        escaped = str(path.resolve()).replace("'", "'\''")
        lines.append(f"file '{escaped}'")
    concat_file.write_text("\n".join(lines), encoding="utf-8")
    command = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-vn", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "FFmpeg could not combine the selected ayahs.")


@app.get("/api/library/reciters")
def library_reciters():
    return {
        "reciters": [
            {"id": key, "name": value["name"], "bitrate": value["bitrate"]}
            for key, value in RECITATION_LIBRARY.items()
        ]
    }


@app.get("/api/library/recitation")
def library_recitation(reciter: str, surah: int, start: int, end: int, istiatha: bool = False, basmalah: bool = False):
    try:
        if reciter not in RECITATION_LIBRARY:
            raise ValueError("Choose a supported reciter.")
        surah = int(surah)
        start = int(start)
        end = int(end)
        if not 1 <= surah <= 114:
            raise ValueError("Surah must be between 1 and 114.")
        if start < 1 or end < start:
            raise ValueError("Choose a valid ayah range.")
        # The frontend constrains to the selected Surah's real count. This hard
        # ceiling prevents malformed requests before any network downloads.
        if end > 286 or end - start > 80:
            raise ValueError("That ayah range is too large. Choose up to 81 consecutive ayahs at a time.")
        paths: list[Path] = []
        included_istiatha = bool(istiatha)
        included_basmalah = bool(basmalah)
        # Al-Fatihah 1 is the basmalah itself in this text/audio catalog. Avoid
        # silently doubling it when the selected range already begins with 1:1.
        if surah == 1 and start == 1:
            included_basmalah = False
        # At-Tawbah conventionally begins without the basmalah.
        if surah == 9:
            included_basmalah = False
        if included_istiatha:
            paths.append(_extract_library_istiatha(reciter))
        if included_basmalah:
            # EveryAyah 001001 is the same reciter's basmalah (Al-Fatihah 1),
            # which keeps the supplement in the same recitation collection.
            paths.append(_download_library_ayah(reciter, 1, 1))
        paths.extend(_download_library_ayah(reciter, surah, ayah) for ayah in range(start, end + 1))
        tempdir = Path(tempfile.mkdtemp(prefix="qws-library-"))
        suffix = ('-istiatha' if included_istiatha else '') + ('-basmalah' if included_basmalah else '')
        out = tempdir / f"{reciter}-{surah:03d}-{start:03d}-{end:03d}{suffix}.m4a"
        _concat_library_audio(paths, out)
        reciter_name = RECITATION_LIBRARY[reciter]["name"]
        return FileResponse(
            out,
            media_type="audio/mp4",
            filename=f"{reciter_name.replace(' ', '-')}-{surah}-{start}-{end}.m4a",
            headers={
                "X-Quran-Reciter": reciter_name,
                "X-Quran-Surah": str(surah),
                "X-Quran-Ayah-Start": str(start),
                "X-Quran-Ayah-End": str(end),
                "X-Quran-Istiatha": "1" if included_istiatha else "0",
                "X-Quran-Basmalah": "1" if included_basmalah else "0",
            },
            background=BackgroundTask(shutil.rmtree, tempdir, ignore_errors=True),
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _plain_metadata(value: object) -> str:
    raw = str((value or ""))
    raw = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html_lib.unescape(raw)).strip()


def _commons_search(query: str, limit: int = 18) -> list[dict]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"{query} filetype:video",
        "gsrnamespace": "6",
        "gsrlimit": str(limit),
        "prop": "imageinfo",
        "iiprop": "url|mime|size|extmetadata",
        "iiurlwidth": "480",
        "origin": "*",
    }
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": COMMONS_USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=12) as response:
        payload = json.load(response)
    pages = (payload.get("query") or {}).get("pages") or {}
    results: list[dict] = []
    for page in pages.values():
        info_list = page.get("imageinfo") or []
        if not info_list:
            continue
        info = info_list[0]
        mime = str(info.get("mime") or "")
        file_url = str(info.get("url") or "")
        size = int(info.get("size") or 0)
        if mime not in {"video/webm", "video/mp4"} or not file_url.startswith("https://upload.wikimedia.org/"):
            continue
        # Background browsing should stay quick; skip huge source files.
        if size and size > 85 * 1024 * 1024:
            continue
        meta = info.get("extmetadata") or {}
        def mv(name: str) -> str:
            entry = meta.get(name) or {}
            return _plain_metadata(entry.get("value") if isinstance(entry, dict) else entry)
        license_name = mv("LicenseShortName") or mv("UsageTerms") or "See source"
        artist = mv("Artist") or mv("Credit") or "Wikimedia Commons contributor"
        title = str(page.get("title") or "Background video").removeprefix("File:")
        results.append({
            "id": str(page.get("pageid") or title),
            "name": title,
            "url": file_url,
            "thumb": str(info.get("thumburl") or ""),
            "mime": mime,
            "size": size,
            "width": int(info.get("width") or 0),
            "height": int(info.get("height") or 0),
            "source": str(info.get("descriptionurl") or "https://commons.wikimedia.org/"),
            "license": license_name,
            "artist": artist[:160],
        })
    return results


@app.get("/api/backgrounds/discover")
def discover_backgrounds(theme: str = "calm", seed: int = 0) -> dict:
    """Return a small rotating set of reusable video backgrounds from Commons."""
    rng = random.Random(int(seed))
    queries = list(BACKGROUND_THEMES.get(theme, BACKGROUND_THEMES["calm"]))
    rng.shuffle(queries)
    collected: dict[str, dict] = {}
    errors: list[str] = []
    for query in queries[:4]:
        try:
            for item in _commons_search(query, 14):
                collected[item["url"]] = item
        except Exception as exc:
            errors.append(str(exc))
        if len(collected) >= 12:
            break
    items = list(collected.values())
    # Prefer reasonably high-resolution clips, then shuffle within the good pool so
    # Refresh actually feels fresh without repeatedly showing low-quality files.
    items.sort(key=lambda item: (item.get("width", 0) * item.get("height", 0), -item.get("size", 0)), reverse=True)
    pool = items[:18]
    rng.shuffle(pool)
    chosen = pool[:5]
    if not chosen and errors:
        raise HTTPException(status_code=502, detail="Could not reach Wikimedia Commons. Check your internet connection and try Refresh again.")
    return {"items": chosen, "source": "Wikimedia Commons", "seed": seed, "theme": theme}


@app.get("/api/backgrounds/fetch")
def fetch_background(url: str):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "upload.wikimedia.org":
        raise HTTPException(status_code=400, detail="Only Wikimedia Commons media URLs are allowed.")

    def iterator():
        req = urllib.request.Request(url, headers={"User-Agent": COMMONS_USER_AGENT})
        with urllib.request.urlopen(req, timeout=25) as response:
            length = int(response.headers.get("Content-Length") or 0)
            if length and length > 85 * 1024 * 1024:
                raise RuntimeError("That background is too large for the quick picker.")
            read = 0
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                read += len(chunk)
                if read > 85 * 1024 * 1024:
                    raise RuntimeError("That background is too large for the quick picker.")
                yield chunk

    suffix = Path(parsed.path).suffix.lower()
    media_type = {".webm": "video/webm", ".ogv": "video/ogg", ".ogg": "video/ogg", ".mp4": "video/mp4"}.get(suffix, "application/octet-stream")
    filename = f"commons-background{suffix or '.video'}"
    return StreamingResponse(iterator(), media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/health")
def health() -> dict:
    dependencies = {}
    for module in ["torch", "transformers", "soundfile", "imageio_ffmpeg"]:
        try:
            __import__(module)
            dependencies[module] = True
        except Exception:
            dependencies[module] = False
    return {
        "ok": True,
        "version": "7.2.0",
        "dependencies": dependencies,
        "alignment_model": ALIGNMENT_MODEL,
        "quran_model": QURAN_MODEL,
        "note": "The first AI alignment downloads the configured Hugging Face models if they are not already cached.",
    }


def _ayah_occurrences_from_payload(words_payload: list[dict]) -> list[dict]:
    groups: list[dict] = []
    current_key = None
    current = None
    for item in words_payload:
        key = (int(item.get("ayahNumber") or 0), int(item.get("sequenceIndex") or 0))
        if key != current_key:
            current = {"ayahNumber": key[0], "sequenceIndex": key[1], "words": []}
            groups.append(current)
            current_key = key
        current["words"].append(item)
    return groups


def _letter_token_timings(layout, spans: list[dict], duration: float, frame_count: int) -> list[list[dict]]:
    """Return Arabic CTC token spans grouped by transcript word."""
    seconds_per_frame = duration / max(1, frame_count)
    grouped: list[list[dict]] = [[] for _ in layout.normalized_words]
    for token_index, word_index in enumerate(layout.token_to_word):
        if word_index is None or token_index >= len(spans):
            continue
        span = spans[token_index]
        start_frame = float(span.get("start_frame", math.nan))
        end_frame = float(span.get("end_frame", math.nan))
        if not math.isfinite(start_frame) or not math.isfinite(end_frame) or end_frame <= start_frame:
            continue
        grouped[word_index].append({
            "start": start_frame * seconds_per_frame,
            "end": end_frame * seconds_per_frame,
            "confidence": float(span.get("confidence", 0.0)),
        })
    return grouped


def _compact_arabic(text: str) -> str:
    return normalize_arabic(text).replace(" ", "")


BASMALAH_WORDS = ["بسم", "الله", "الرحمن", "الرحيم"]
BASMALAH_COMPACT = _compact_arabic(" ".join(BASMALAH_WORDS))
ISTIATHA_COMPACT = _compact_arabic(" ".join(ISTIATHA_WORDS))



def _prefix_similarity_to_target(recognized_prefix: str, target_compact: str) -> float:
    source = _compact_arabic(recognized_prefix)
    if not source:
        return 0.0
    target_len = len(target_compact)
    best = 0.0
    for window_len in range(max(4, target_len - 5), min(len(source), target_len + 7) + 1):
        best = max(best, SequenceMatcher(None, target_compact, source[:window_len], autojunk=False).ratio())
    return best

def align_leading_phrase_window(
    log_probs: np.ndarray,
    runtime,
    duration: float,
    blank_id: int,
    target_words: list[str],
    target_compact: str,
    mode: str,
    label: str,
    window_start: float,
    window_end: float,
    min_span: float = 0.4,
) -> tuple[list[dict] | None, dict]:
    mode = str(mode or "auto").lower()
    diagnostics = {"mode": mode, "similarity": 0.0, "meanConfidence": 0.0, "windowStart": round(window_start, 4), "windowEnd": round(window_end, 4)}
    if mode in {"never", "no", "false", "off"}:
        return None, diagnostics
    if window_end - window_start < 0.45:
        if mode in {"always", "yes", "true", "on"}:
            raise ValueError(f"{label} was marked as included, but there is not enough opening audio to align it safely.")
        return None, diagnostics
    frame_count = int(log_probs.shape[0])
    seconds_per_frame = duration / max(1, frame_count)
    start_frame = max(0, min(frame_count - 1, int(math.floor(window_start / seconds_per_frame))))
    end_frame = max(start_frame + 2, min(frame_count, int(math.ceil(window_end / seconds_per_frame))))
    probs = log_probs[start_frame:end_frame]
    local_duration = (end_frame - start_frame) * seconds_per_frame
    try:
        recognized_prefix = runtime.processor.batch_decode(np.argmax(probs, axis=-1)[None, :])[0]
    except Exception:
        recognized_prefix = ""
    similarity = _prefix_similarity_to_target(recognized_prefix, target_compact)
    diagnostics["similarity"] = round(similarity, 4)
    layout = build_target_layout(runtime.processor.tokenizer, [normalize_arabic(w) for w in target_words])
    if layout.unknown_tokens / max(1, len(layout.ids)) > 0.08:
        return None, diagnostics
    try:
        path, labels = ctc_viterbi(probs, layout.ids, int(blank_id))
        spans = target_token_spans(path, labels, layout.ids, probs)
        words, _ = word_timings_from_tokens(layout, spans, local_duration, probs.shape[0])
    except Exception:
        if mode in {"always", "yes", "true", "on"}:
            raise ValueError(f"{label} was marked as included, but it could not be aligned reliably in the opening audio.")
        return None, diagnostics
    for word in words:
        word["start"] = float(word["start"]) + start_frame * seconds_per_frame
        word["end"] = float(word["end"]) + start_frame * seconds_per_frame
    mean_conf = float(np.mean([float(word.get("ctc_confidence", 0.0)) for word in words])) if words else 0.0
    diagnostics["meanConfidence"] = round(mean_conf, 4)
    span_start = float(words[0]["start"]) if words else window_end
    span_end = float(words[-1]["end"]) if words else window_start
    span_duration = max(0.0, span_end - span_start)
    diagnostics["spanSeconds"] = round(span_duration, 4)
    auto_ok = (similarity >= 0.80 and mean_conf >= 0.08) or (similarity >= 0.70 and mean_conf >= 0.20) or mean_conf >= 0.42
    geometry_ok = span_duration >= min_span and span_end <= window_end + 0.16
    accepted = geometry_ok and (auto_ok or mode in {"always", "yes", "true", "on"})
    diagnostics["accepted"] = bool(accepted)
    if not accepted:
        if mode in {"always", "yes", "true", "on"}:
            raise ValueError(f"{label} was marked as included, but the opening audio did not match it strongly enough. Try Auto or Not included.")
        return None, diagnostics
    return words, diagnostics

def prepend_special_response(main_words: list[dict], specials: list[tuple[int, str, list[str], list[dict]]]) -> list[dict]:
    response: list[dict] = []
    global_index = 0
    sequence_index = 0
    for ayah_number, name, target_words, timings in specials:
        for word_index, timing in enumerate(timings):
            confidence = float(timing.get("ctc_confidence", 0.0))
            response.append({
                "index": global_index,
                "ayahNumber": ayah_number,
                "sequenceIndex": sequence_index,
                "occurrenceIndex": 0,
                "occurrenceKey": f"{name}@{sequence_index}",
                "wordIndex": word_index,
                "normalized": normalize_arabic(target_words[word_index]),
                "start": round(float(timing["start"]), 4),
                "end": round(float(timing["end"]), 4),
                "confidence": round(confidence, 4),
                "confidenceLabel": "high" if confidence >= 0.78 else "medium" if confidence >= 0.55 else "low",
                "ctcConfidence": round(confidence, 4),
                "genericConfidence": round(confidence, 4),
                "quranPhoneticConfidence": 0.0,
                "modelAgreement": 0.0,
                "boundaryConfidence": round(confidence, 4),
            })
            global_index += 1
        sequence_index += 1
    shift_sequences = sequence_index
    for item in main_words:
        clone = dict(item)
        clone["index"] = global_index
        seq = int(clone.get("sequenceIndex", 0)) + shift_sequences
        clone["sequenceIndex"] = seq
        clone["occurrenceKey"] = f"{int(clone.get('ayahNumber', 0))}@{seq}"
        response.append(clone)
        global_index += 1
    return response

def _prefix_similarity_to_basmalah(recognized_prefix: str) -> float:
    source = _compact_arabic(recognized_prefix)
    if not source:
        return 0.0
    target_len = len(BASMALAH_COMPACT)
    best = 0.0
    # Greedy CTC may lose a couple of letters or include the first sound of the
    # requested ayah, so compare a small family of prefix lengths only.
    for window_len in range(max(5, target_len - 4), min(len(source), target_len + 6) + 1):
        best = max(best, SequenceMatcher(None, BASMALAH_COMPACT, source[:window_len], autojunk=False).ratio())
    return best


def align_leading_basmalah(
    log_probs: np.ndarray,
    runtime,
    duration: float,
    first_main_start: float,
    blank_id: int,
    mode: str = "auto",
) -> tuple[list[dict] | None, dict]:
    """Align a possible introductory basmalah *without changing main-ayah timing*.

    The stable selected-passage alignment is completed first. Only the audio before
    its first aligned word is inspected. This prevents a false basmalah guess from
    shifting every requested word, which was the regression in v6.5.
    """
    mode = str(mode or "auto").lower()
    diagnostics = {"mode": mode, "similarity": 0.0, "meanConfidence": 0.0, "prefixSeconds": 0.0}
    if mode in {"never", "no", "false", "off"}:
        return None, diagnostics
    if first_main_start < 0.55 or duration <= 0.8:
        if mode in {"always", "yes", "true", "on"}:
            raise ValueError("Basmalah was marked as included, but there is not enough audio before the first selected ayah to align it safely.")
        return None, diagnostics

    frame_count = int(log_probs.shape[0])
    seconds_per_frame = duration / max(1, frame_count)
    prefix_end = min(duration, first_main_start + min(0.12, seconds_per_frame * 3))
    prefix_frames = max(2, min(frame_count, int(math.ceil(prefix_end / seconds_per_frame))))
    prefix_probs = log_probs[:prefix_frames]
    prefix_duration = prefix_frames * seconds_per_frame
    diagnostics["prefixSeconds"] = round(prefix_duration, 4)

    try:
        recognized_prefix = runtime.processor.batch_decode(np.argmax(prefix_probs, axis=-1)[None, :])[0]
    except Exception:
        recognized_prefix = ""
    similarity = _prefix_similarity_to_basmalah(recognized_prefix)
    diagnostics["similarity"] = round(similarity, 4)

    layout = build_target_layout(runtime.processor.tokenizer, BASMALAH_WORDS)
    unknown_ratio = layout.unknown_tokens / max(1, len(layout.ids))
    if unknown_ratio > 0.08:
        return None, diagnostics
    try:
        path, labels = ctc_viterbi(prefix_probs, layout.ids, int(blank_id))
        spans = target_token_spans(path, labels, layout.ids, prefix_probs)
        words, _ = word_timings_from_tokens(layout, spans, prefix_duration, prefix_probs.shape[0])
    except Exception:
        if mode in {"always", "yes", "true", "on"}:
            raise ValueError("Basmalah was marked as included, but it could not be aligned reliably in the opening audio.")
        return None, diagnostics

    mean_conf = float(np.mean([float(word.get("ctc_confidence", 0.0)) for word in words])) if words else 0.0
    diagnostics["meanConfidence"] = round(mean_conf, 4)
    span_start = float(words[0]["start"]) if words else prefix_duration
    span_end = float(words[-1]["end"]) if words else 0.0
    span_duration = max(0.0, span_end - span_start)
    diagnostics["spanSeconds"] = round(span_duration, 4)

    # Auto mode is intentionally conservative: either the greedy prefix must look
    # strongly like the basmalah with usable CTC confidence, or the CTC confidence
    # itself must be exceptionally strong. Forced alignment alone is not proof.
    auto_ok = (similarity >= 0.80 and mean_conf >= 0.10) or (similarity >= 0.70 and mean_conf >= 0.22) or mean_conf >= 0.42
    geometry_ok = span_duration >= 0.45 and span_end <= first_main_start + 0.16
    accepted = geometry_ok and (auto_ok or mode in {"always", "yes", "true", "on"})
    diagnostics["accepted"] = bool(accepted)
    if not accepted:
        if mode in {"always", "yes", "true", "on"}:
            raise ValueError("Basmalah was marked as included, but the opening audio did not match it strongly enough. Try Auto or Not included.")
        return None, diagnostics

    return words, diagnostics


def prepend_basmalah_response(main_words: list[dict], basmalah_words: list[dict]) -> list[dict]:
    response: list[dict] = []
    for index, timing in enumerate(basmalah_words):
        confidence = float(timing.get("ctc_confidence", 0.0))
        response.append({
            "index": index,
            "ayahNumber": 0,
            "sequenceIndex": 0,
            "occurrenceIndex": 0,
            "occurrenceKey": "basmalah@0",
            "wordIndex": index,
            "normalized": normalize_arabic(BASMALAH_WORDS[index]),
            "start": round(float(timing["start"]), 4),
            "end": round(float(timing["end"]), 4),
            "confidence": round(confidence, 4),
            "confidenceLabel": "high" if confidence >= 0.78 else "medium" if confidence >= 0.55 else "low",
            "ctcConfidence": round(confidence, 4),
            "genericConfidence": round(confidence, 4),
            "quranPhoneticConfidence": 0.0,
            "modelAgreement": 0.0,
            "boundaryConfidence": round(confidence, 4),
        })
    shift = len(basmalah_words)
    for index, item in enumerate(main_words):
        clone = dict(item)
        clone["index"] = shift + index
        sequence_index = int(clone.get("sequenceIndex", 0)) + 1
        clone["sequenceIndex"] = sequence_index
        clone["occurrenceKey"] = f"{int(clone.get('ayahNumber', 0))}@{sequence_index}"
        response.append(clone)
    return response


def detect_repeated_ayah_sequence(recognized: str, words_payload: list[dict]) -> list[int]:
    """Best-effort ayah-repeat detection from the model's greedy transcript.

    The exact-text forced aligner still does the final timing. This pre-pass is only
    used to discover repeated/backtracked ayahs so the target transcript can contain
    them before Viterbi alignment.
    """
    occurrences = _ayah_occurrences_from_payload(words_payload)
    original = [int(group["ayahNumber"]) for group in occurrences]
    if not original or len(set(original)) < len(original):
        # The user already described a repeat explicitly; trust that exact order.
        return original
    source = _compact_arabic(recognized)
    if len(source) < 8:
        return original

    templates: dict[int, str] = {}
    for group in occurrences:
        ayah = int(group["ayahNumber"])
        templates.setdefault(ayah, _compact_arabic(" ".join(str(w.get("text") or "") for w in group["words"])))

    candidates: list[dict] = []
    for ayah, target in templates.items():
        length = len(target)
        if length < 4:
            continue
        step = max(1, length // 12)
        min_len = max(4, round(length * 0.76))
        max_len = min(len(source), round(length * 1.24))
        local: list[dict] = []
        for start in range(0, max(1, len(source) - min_len + 1), step):
            best = None
            for window_len in {min_len, length, max_len}:
                end = min(len(source), start + window_len)
                if end - start < min_len:
                    continue
                segment = source[start:end]
                score = SequenceMatcher(None, target, segment, autojunk=False).ratio()
                if best is None or score > best["score"]:
                    best = {"ayah": ayah, "start": start, "end": end, "score": score, "length": length}
            if best and best["score"] >= 0.64:
                local.append(best)
        local.sort(key=lambda item: item["score"], reverse=True)
        kept: list[dict] = []
        for item in local:
            center = (item["start"] + item["end"]) / 2
            if any(abs(center - (other["start"] + other["end"]) / 2) < length * 0.52 for other in kept):
                continue
            kept.append(item)
            if len(kept) >= 5:
                break
        candidates.extend(kept)

    if not candidates:
        return original
    # Prefer high-quality whole-ayah matches and remove heavily-overlapping matches.
    candidates.sort(key=lambda item: (item["start"], -item["score"]))
    selected: list[dict] = []
    for item in candidates:
        if item["score"] < 0.70:
            continue
        if selected and item["start"] < selected[-1]["end"] - min(item["length"], selected[-1]["length"]) * 0.30:
            if item["score"] > selected[-1]["score"] + 0.035:
                selected[-1] = item
            continue
        selected.append(item)

    sequence = [int(item["ayah"]) for item in selected]
    if len(sequence) <= len(original):
        return original
    # Do not accept a speculative repeat unless the normal requested path is still
    # present as a subsequence in the detected order.
    cursor = 0
    for ayah in sequence:
        if cursor < len(original) and ayah == original[cursor]:
            cursor += 1
    if cursor != len(original):
        return original
    return sequence


def expand_payload_to_ayah_sequence(words_payload: list[dict], sequence: list[int]) -> list[dict]:
    source_groups = _ayah_occurrences_from_payload(words_payload)
    templates: dict[int, list[dict]] = {}
    for group in source_groups:
        templates.setdefault(int(group["ayahNumber"]), group["words"])
    counts: dict[int, int] = {}
    expanded: list[dict] = []
    global_index = 0
    for sequence_index, ayah in enumerate(sequence):
        if ayah not in templates:
            continue
        occurrence_index = counts.get(ayah, 0)
        counts[ayah] = occurrence_index + 1
        for word in templates[ayah]:
            clone = dict(word)
            clone["index"] = global_index
            clone["ayahNumber"] = ayah
            clone["sequenceIndex"] = sequence_index
            clone["occurrenceIndex"] = occurrence_index
            clone["occurrenceKey"] = f"{ayah}@{sequence_index}"
            expanded.append(clone)
            global_index += 1
    return expanded


@app.post("/api/align")
def align(
    audio: Annotated[UploadFile, File(...)],
    transcript: Annotated[str, Form(...)],
    quran_refine: Annotated[bool, Form()] = True,
    detect_repeats: Annotated[bool, Form()] = True,
    istiatha_mode: Annotated[str, Form()] = "auto",
    basmalah_mode: Annotated[str, Form()] = "auto",
) -> dict:
    try:
        payload = json.loads(transcript)
        words_payload = payload.get("words") or []
        surah_number = int(payload.get("surahNumber") or 0)
        if not words_payload:
            raise ValueError("No words were supplied for alignment.")
        if len(words_payload) > 700:
            raise ValueError("AI Precise mode currently supports up to 700 words in one clip.")
        normalized_words = [normalize_arabic(item.get("text", "")) for item in words_payload]
        if any(not word for word in normalized_words):
            raise ValueError("One or more Qur'anic words could not be normalized for alignment.")

        with tempfile.TemporaryDirectory(prefix="qws-align-") as temp:
            tempdir = Path(temp)
            source = _save_upload(audio, tempdir, "recitation" + (Path(audio.filename or "audio").suffix or ".bin"))
            wav = tempdir / "audio.wav"
            convert_to_wav(source, wav, 16000)
            samples, sample_rate = load_mono(wav)
            duration = len(samples) / sample_rate
            if duration <= 0.1:
                raise ValueError("The uploaded recitation is empty or too short.")
            if duration > 240:
                raise ValueError("AI Precise mode is limited to four minutes per clip so alignment stays accurate and memory-safe.")

            # Pass 1: exact Arabic forced alignment over the whole clip. This anchors
            # the passage and prevents a speech recognizer from inventing/replacing words.
            runtime = get_alignment_model()
            log_probs = emissions(runtime, samples, sample_rate)
            recognized = runtime.processor.batch_decode(np.argmax(log_probs, axis=-1)[None, :])[0]
            original_sequence = [int(group["ayahNumber"]) for group in _ayah_occurrences_from_payload(words_payload)]
            detected_sequence = detect_repeated_ayah_sequence(recognized, words_payload) if detect_repeats else original_sequence
            if detected_sequence != original_sequence:
                words_payload = expand_payload_to_ayah_sequence(words_payload, detected_sequence)
                normalized_words = [normalize_arabic(item.get("text", "")) for item in words_payload]
            layout = build_target_layout(runtime.processor.tokenizer, normalized_words)
            unknown_ratio = layout.unknown_tokens / max(1, len(layout.ids))
            if unknown_ratio > 0.08:
                raise ValueError(
                    f"The Arabic alignment model could not represent {unknown_ratio:.0%} of the selected text. "
                    "Try a shorter passage or choose Fast mode."
                )
            blank_id = runtime.processor.tokenizer.pad_token_id
            if blank_id is None:
                blank_id = runtime.model.config.pad_token_id
            if blank_id is None:
                blank_id = 0
            path, labels = ctc_viterbi(log_probs, layout.ids, int(blank_id))
            spans = target_token_spans(path, labels, layout.ids, log_probs)
            coarse_words, coarse_boundaries = word_timings_from_tokens(layout, spans, duration, log_probs.shape[0])
            coarse_letter_tokens = _letter_token_timings(layout, spans, duration, log_probs.shape[0])

            # Pass 2: re-run the same known-text alignment inside each ayah's coarse
            # window. This removes timing drift that can build up in a long CTC path.
            generic_words, generic_boundaries = local_realign_by_ayah(
                log_probs,
                runtime.processor.tokenizer,
                words_payload,
                normalized_words,
                coarse_words,
                duration,
                int(blank_id),
                normalizer=_normalize_arabic_target,
            )

            acoustic_curve, acoustic_step = rms_boundary_curve(samples, sample_rate)
            generic_blank_curve, generic_blank_step = ctc_blank_boundary_curve(log_probs, int(blank_id), duration)
            quran_curve = None
            quran_step = None
            quran_model_loaded = False
            quran_forced_used = False
            quran_error = None
            phonetic_info: dict = {"dataset": DATASET_ID, "matched": 0, "total": len(words_payload), "coverage": 0.0}
            quran_words = None
            quran_boundaries = None

            if quran_refine:
                try:
                    # Fetch only transliteration metadata (no dataset audio) for the
                    # selected ayahs. It is cached locally after first use.
                    phonetic_targets = None
                    if surah_number:
                        try:
                            phonetic_targets, phonetic_info = map_payload_to_phonetics(words_payload, surah_number)
                        except Exception as metadata_exc:
                            phonetic_info = {
                                "dataset": DATASET_ID,
                                "matched": 0,
                                "total": len(words_payload),
                                "coverage": 0.0,
                                "error": str(metadata_exc),
                            }

                    q_runtime = get_quran_model()
                    q_log_probs = emissions(q_runtime, samples, sample_rate)
                    quran_model_loaded = True
                    quran_curve, quran_step = quran_delimiter_curve(q_log_probs, q_runtime.processor.tokenizer, duration)

                    # Pass 3 (preferred): true phonetic forced alignment. The target is
                    # Quran-MD word_tr, the exact transcription family this Quran model
                    # was trained on. Each ayah is aligned in its own local window.
                    if phonetic_targets:
                        q_blank = q_runtime.processor.tokenizer.pad_token_id
                        if q_blank is None:
                            q_blank = q_runtime.model.config.pad_token_id
                        if q_blank is None:
                            q_blank = 0
                        quran_words, quran_boundaries = local_realign_by_ayah(
                            q_log_probs,
                            q_runtime.processor.tokenizer,
                            words_payload,
                            phonetic_targets,
                            generic_words,
                            duration,
                            int(q_blank),
                            normalizer=normalize_phonetic,
                        )
                        # Reject the exact-phonetic pass if the tokenizer still saw too
                        # many unknown symbols. Boundary-cue fallback remains available.
                        quran_forced_used = all(
                            float(word.get("ctc_confidence", 0.0)) > 0.015 for word in quran_words
                        )
                        if not quran_forced_used:
                            quran_words = None
                            quran_boundaries = None
                except Exception as exc:
                    quran_error = str(exc)

            # Pass 4: confidence-aware fusion. Continuous Arabic CTC is the stable
            # anchor; Qur'an phonetic CTC gets more weight when the two agree.
            word_times, fused_boundaries, _ = fuse_forced_alignments(
                generic_words,
                generic_boundaries,
                quran_words if quran_forced_used else None,
                quran_boundaries if quran_forced_used else None,
                duration,
            )

            # Final sub-word-boundary cleanup uses local waveform quietness and the
            # Quran model's blank/delimiter evidence, but never moves far from CTC.
            word_times, refined = refine_boundaries(
                word_times,
                fused_boundaries,
                duration,
                acoustic_curve,
                acoustic_step,
                quran_curve,
                quran_step,
                generic_blank_curve,
                generic_blank_step,
            )

            response_words = []
            for index, (source_word, timing) in enumerate(zip(words_payload, word_times)):
                confidence = float(timing.get("confidence", timing.get("ctc_confidence", 0.0)))
                final_start = float(timing["start"])
                final_end = float(timing["end"])
                coarse_start = float(coarse_words[index]["start"])
                coarse_end = float(coarse_words[index]["end"])
                coarse_duration = max(0.001, coarse_end - coarse_start)
                letter_tokens = []
                for token in coarse_letter_tokens[index]:
                    relative_start = max(0.0, min(1.0, (float(token["start"]) - coarse_start) / coarse_duration))
                    relative_end = max(relative_start, min(1.0, (float(token["end"]) - coarse_start) / coarse_duration))
                    letter_tokens.append({
                        "start": round(final_start + relative_start * (final_end - final_start), 4),
                        "end": round(final_start + relative_end * (final_end - final_start), 4),
                        "confidence": round(float(token.get("confidence", 0.0)), 4),
                    })
                response_words.append(
                    {
                        "index": int(source_word.get("index", index)),
                        "ayahNumber": int(source_word.get("ayahNumber", 0)),
                        "sequenceIndex": int(source_word.get("sequenceIndex", 0)),
                        "occurrenceIndex": int(source_word.get("occurrenceIndex", 0)),
                        "occurrenceKey": str(source_word.get("occurrenceKey") or f"{int(source_word.get('ayahNumber', 0))}@{int(source_word.get('sequenceIndex', 0))}"),
                        "wordIndex": int(source_word.get("wordIndex", index)),
                        "normalized": normalized_words[index],
                        "start": round(float(timing["start"]), 4),
                        "end": round(float(timing["end"]), 4),
                        "confidence": round(confidence, 4),
                        "confidenceLabel": "high" if confidence >= 0.78 else "medium" if confidence >= 0.55 else "low",
                        "ctcConfidence": round(float(timing.get("ctc_confidence", 0.0)), 4),
                        "genericConfidence": round(float(timing.get("generic_confidence", timing.get("ctc_confidence", 0.0))), 4),
                        "quranPhoneticConfidence": round(float(timing.get("quran_phonetic_confidence", 0.0)), 4),
                        "modelAgreement": round(float(timing.get("model_agreement", 0.0)), 4),
                        "boundaryConfidence": round(float(timing.get("boundary_confidence", 0.0)), 4),
                        "letterTimings": letter_tokens,
                    }
                )

            # Optional leading isti'adhah / basmalah pass. This happens only after
            # the selected ayahs are fully aligned, so prefix detection can never
            # shift the requested ayah timings.
            leading_istiatha = False
            leading_basmalah = False
            istiatha_diagnostics = {"mode": str(istiatha_mode or "auto")}
            basmalah_diagnostics = {"mode": str(basmalah_mode or "auto")}
            specials: list[tuple[int, str, list[str], list[dict]]] = []
            first_requested_ayah = int(words_payload[0].get("ayahNumber", 0)) if words_payload else 0
            already_is_basmalah = surah_number == 1 and first_requested_ayah == 1
            if response_words:
                first_main_start = float(response_words[0]["start"])
                if first_main_start > 0.45:
                    istiatha_words, istiatha_diagnostics = align_leading_phrase_window(
                        log_probs, runtime, duration, int(blank_id), ISTIATHA_WORDS, ISTIATHA_COMPACT,
                        istiatha_mode, "Isti'adhah", 0.0, first_main_start + 0.12, min_span=0.55,
                    )
                    if istiatha_words:
                        specials.append((-1, "istiatha", ISTIATHA_WORDS, istiatha_words))
                        leading_istiatha = True
                    if not already_is_basmalah:
                        basmalah_start = (float(istiatha_words[-1]["end"]) + 0.015) if istiatha_words else 0.0
                        basmalah_words, basmalah_diagnostics = align_leading_phrase_window(
                            log_probs, runtime, duration, int(blank_id), BASMALAH_WORDS, BASMALAH_COMPACT,
                            basmalah_mode, "Basmalah", basmalah_start, first_main_start + 0.14, min_span=0.42,
                        )
                        if basmalah_words:
                            specials.append((0, "basmalah", BASMALAH_WORDS, basmalah_words))
                            leading_basmalah = True
                elif str(istiatha_mode or "auto").lower() in {"always", "yes", "true", "on"}:
                    raise ValueError("Isti'adhah was marked as included, but there is not enough opening audio before the first selected ayah.")
                elif (not already_is_basmalah) and str(basmalah_mode or "auto").lower() in {"always", "yes", "true", "on"}:
                    raise ValueError("Basmalah was marked as included, but there is not enough opening audio before the first selected ayah.")
            if specials:
                response_words = prepend_special_response(response_words, specials)

            response_sequence = ([-1] if leading_istiatha else []) + ([0] if leading_basmalah else []) + detected_sequence

            return {
                "engine": "ai-precise-hierarchical-dual-ctc-stable",
                "duration": round(duration, 4),
                "alignmentModel": ALIGNMENT_MODEL,
                "quranPhoneticModel": QURAN_MODEL if quran_model_loaded else None,
                "quranPhoneticForcedAlignmentUsed": quran_forced_used,
                # Kept for the existing frontend and backwards compatibility.
                "quranRefinerUsed": bool(quran_forced_used or quran_curve is not None),
                "quranRefinerError": quran_error,
                "phoneticMetadata": phonetic_info,
                "recognized": recognized,
                "ayahSequence": response_sequence,
                "repeatDetected": detected_sequence != original_sequence,
                "leadingIstiatha": leading_istiatha,
                "istiathaDiagnostics": istiatha_diagnostics,
                "leadingBasmalah": leading_basmalah,
                "basmalahDiagnostics": basmalah_diagnostics,
                "unknownTokenRatio": round(unknown_ratio, 4),
                "words": response_words,
            }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/render")
def render(
    audio: Annotated[UploadFile, File(...)],
    metadata: Annotated[str, Form(...)],
    overlays: Annotated[list[UploadFile], File(...)],
    backgrounds: Annotated[list[UploadFile] | None, File()] = None,
    background: Annotated[UploadFile | None, File()] = None,
    watermark: Annotated[UploadFile | None, File()] = None,
    shadow_overlay: Annotated[UploadFile | None, File()] = None,
    intro_title: Annotated[UploadFile | None, File()] = None,
):
    try:
        meta = json.loads(metadata)
        if len(overlays) > 600:
            raise ValueError("Too many word-highlight overlays. Use Shorts Retention Mode or export a shorter passage.")
        tempdir = Path(tempfile.mkdtemp(prefix="qws-render-"))
        audio_path = _save_upload(audio, tempdir, "audio" + (Path(audio.filename or "audio").suffix or ".bin"))
        background_items = list(backgrounds or [])
        if background is not None and background.filename:
            background_items.append(background)
        bg_paths = [
            _save_upload(bg, tempdir, f"background-{index:02d}" + (Path(bg.filename or f"bg{index}").suffix or ".bin"))
            for index, bg in enumerate(background_items)
        ]
        if not bg_paths:
            raise ValueError("At least one background clip is required.")
        overlay_paths: list[Path] = []
        for index, overlay in enumerate(overlays):
            overlay_paths.append(_save_upload(overlay, tempdir, f"phrase-{index:03d}.png"))
        watermark_path = None
        if watermark is not None and watermark.filename:
            watermark_path = _save_upload(watermark, tempdir, "watermark" + (Path(watermark.filename).suffix or ".bin"))
        shadow_overlay_path = None
        if shadow_overlay is not None and shadow_overlay.filename:
            shadow_overlay_path = _save_upload(shadow_overlay, tempdir, "shadow-overlay" + (Path(shadow_overlay.filename).suffix or ".png"))
        intro_title_path = None
        if intro_title is not None and intro_title.filename:
            intro_title_path = _save_upload(intro_title, tempdir, "intro-title" + (Path(intro_title.filename).suffix or ".png"))
        output_path = tempdir / "quran-edit.mp4"
        render_video(
            audio_path=audio_path,
            background_paths=bg_paths,
            overlay_paths=overlay_paths,
            metadata=meta,
            output_path=output_path,
            background_content_types=[bg.content_type for bg in background_items],
            watermark_path=watermark_path,
            watermark_content_type=watermark.content_type if watermark else None,
            shadow_overlay_path=shadow_overlay_path,
            shadow_overlay_content_type=shadow_overlay.content_type if shadow_overlay else None,
            intro_title_path=intro_title_path,
            intro_title_content_type=intro_title.content_type if intro_title else None,
        )
        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="quran-synced-edit.mp4",
            background=BackgroundTask(shutil.rmtree, tempdir, ignore_errors=True),
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- v5.1 asynchronous render jobs -----------------------------------------
# FFmpeg now runs in a background thread so the browser can poll real encoder
# progress rather than sitting on the old hard-coded 42% holding point.
_RENDER_JOBS: dict[str, dict] = {}
_RENDER_LOCK = threading.Lock()


def _set_render_job(job_id: str, **updates) -> None:
    with _RENDER_LOCK:
        job = _RENDER_JOBS.get(job_id)
        if job is not None:
            job.update(updates)


def _cleanup_render_job(job_id: str) -> None:
    with _RENDER_LOCK:
        job = _RENDER_JOBS.pop(job_id, None)
    if job:
        shutil.rmtree(job.get("tempdir", ""), ignore_errors=True)


def _cleanup_stale_render_jobs(max_age: float = 2 * 60 * 60) -> None:
    now = time.time()
    stale = []
    with _RENDER_LOCK:
        for job_id, job in _RENDER_JOBS.items():
            if job.get("status") != "rendering" and now - float(job.get("created", now)) > max_age:
                stale.append(job_id)
    for job_id in stale:
        _cleanup_render_job(job_id)


def _run_render_job(
    job_id: str,
    audio_path: Path,
    bg_paths: list[Path],
    overlay_paths: list[Path],
    meta: dict,
    output_path: Path,
    background_content_types: list[str | None],
    watermark_path: Path | None,
    watermark_content_type: str | None,
    shadow_overlay_path: Path | None,
    shadow_overlay_content_type: str | None,
    intro_title_path: Path | None,
    intro_title_content_type: str | None,
) -> None:
    def on_progress(fraction: float, speed: str | None) -> None:
        _set_render_job(
            job_id,
            status="rendering",
            progress=max(0.0, min(1.0, float(fraction))),
            speed=speed,
        )

    try:
        render_video(
            audio_path=audio_path,
            background_paths=bg_paths,
            overlay_paths=overlay_paths,
            metadata=meta,
            output_path=output_path,
            background_content_types=background_content_types,
            watermark_path=watermark_path,
            watermark_content_type=watermark_content_type,
            shadow_overlay_path=shadow_overlay_path,
            shadow_overlay_content_type=shadow_overlay_content_type,
            progress_callback=on_progress,
            intro_title_path=intro_title_path,
            intro_title_content_type=intro_title_content_type,
        )
        _set_render_job(job_id, status="done", progress=1.0, speed=None)
    except Exception as exc:
        _set_render_job(job_id, status="error", error=str(exc), speed=None)
        with _RENDER_LOCK:
            job = _RENDER_JOBS.get(job_id)
            temp_path = job.get("tempdir") if job else None
        if temp_path:
            shutil.rmtree(temp_path, ignore_errors=True)


@app.post("/api/render/start")
def render_start(
    audio: Annotated[UploadFile, File(...)],
    metadata: Annotated[str, Form(...)],
    overlays: Annotated[list[UploadFile], File(...)],
    backgrounds: Annotated[list[UploadFile] | None, File()] = None,
    background: Annotated[UploadFile | None, File()] = None,
    watermark: Annotated[UploadFile | None, File()] = None,
    shadow_overlay: Annotated[UploadFile | None, File()] = None,
    intro_title: Annotated[UploadFile | None, File()] = None,
):
    try:
        _cleanup_stale_render_jobs()
        meta = json.loads(metadata)
        if len(overlays) > 600:
            raise ValueError("Too many word-highlight overlays. Use Shorts Retention Mode or export a shorter passage.")
        tempdir = Path(tempfile.mkdtemp(prefix="qws-render-"))
        audio_path = _save_upload(audio, tempdir, "audio" + (Path(audio.filename or "audio").suffix or ".bin"))
        background_items = list(backgrounds or [])
        if background is not None and background.filename:
            background_items.append(background)
        bg_paths = [
            _save_upload(bg, tempdir, f"background-{index:02d}" + (Path(bg.filename or f"bg{index}").suffix or ".bin"))
            for index, bg in enumerate(background_items)
        ]
        if not bg_paths:
            raise ValueError("At least one background clip is required.")
        overlay_paths = [
            _save_upload(overlay, tempdir, f"phrase-{index:03d}.png")
            for index, overlay in enumerate(overlays)
        ]
        watermark_path = None
        if watermark is not None and watermark.filename:
            watermark_path = _save_upload(watermark, tempdir, "watermark" + (Path(watermark.filename).suffix or ".bin"))
        shadow_overlay_path = None
        if shadow_overlay is not None and shadow_overlay.filename:
            shadow_overlay_path = _save_upload(shadow_overlay, tempdir, "shadow-overlay" + (Path(shadow_overlay.filename).suffix or ".png"))
        intro_title_path = None
        if intro_title is not None and intro_title.filename:
            intro_title_path = _save_upload(intro_title, tempdir, "intro-title" + (Path(intro_title.filename).suffix or ".png"))

        job_id = uuid.uuid4().hex
        output_path = tempdir / "quran-edit.mp4"
        with _RENDER_LOCK:
            _RENDER_JOBS[job_id] = {
                "status": "rendering",
                "progress": 0.0,
                "speed": None,
                "error": None,
                "created": time.time(),
                "tempdir": str(tempdir),
                "output_path": str(output_path),
            }
        thread = threading.Thread(
            target=_run_render_job,
            args=(
                job_id,
                audio_path,
                bg_paths,
                overlay_paths,
                meta,
                output_path,
                [bg.content_type for bg in background_items],
                watermark_path,
                watermark.content_type if watermark else None,
                shadow_overlay_path,
                shadow_overlay.content_type if shadow_overlay else None,
                intro_title_path,
                intro_title.content_type if intro_title else None,
            ),
            daemon=True,
            name=f"qws-render-{job_id[:8]}",
        )
        thread.start()
        return {"jobId": job_id, "status": "rendering", "progress": 0.0}
    except Exception as exc:
        # If the job did not get registered, remove any temp folder created above.
        if "tempdir" in locals():
            shutil.rmtree(tempdir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/render/{job_id}/status")
def render_status(job_id: str):
    with _RENDER_LOCK:
        job = _RENDER_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Render job not found.")
        return {
            "status": job.get("status"),
            "progress": round(float(job.get("progress", 0.0)), 4),
            "speed": job.get("speed"),
            "error": job.get("error"),
        }


@app.get("/api/render/{job_id}/download")
def render_download(job_id: str):
    with _RENDER_LOCK:
        job = _RENDER_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Render job not found.")
        if job.get("status") == "error":
            raise HTTPException(status_code=400, detail=job.get("error") or "Rendering failed.")
        if job.get("status") != "done":
            raise HTTPException(status_code=409, detail="The video is still rendering.")
        output_path = Path(job["output_path"])
    if not output_path.exists():
        _cleanup_render_job(job_id)
        raise HTTPException(status_code=404, detail="Finished video file is missing.")
    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename="quran-synced-edit.mp4",
        background=BackgroundTask(_cleanup_render_job, job_id),
    )
