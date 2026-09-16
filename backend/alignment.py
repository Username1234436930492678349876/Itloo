from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np

ARABIC_MARKS_RE = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")
NON_ARABIC_RE = re.compile(r"[^\u0621-\u064A\s]")
SPACE_RE = re.compile(r"\s+")


def normalize_arabic(text: str) -> str:
    """Create an ASR-friendly Arabic form while keeping word order intact."""
    text = ARABIC_MARKS_RE.sub("", str(text or ""))
    text = text.replace("ـ", "")
    text = text.replace("ٱ", "ا")
    text = NON_ARABIC_RE.sub(" ", text)
    return SPACE_RE.sub(" ", text).strip()


@dataclass
class TargetLayout:
    ids: list[int]
    token_to_word: list[int | None]
    delimiter_positions: list[int]
    normalized_words: list[str]
    unknown_tokens: int


def _ids_for_word(tokenizer: Any, word: str) -> tuple[list[int], int]:
    encoded = tokenizer(word, add_special_tokens=False)
    ids = list(encoded.input_ids if hasattr(encoded, "input_ids") else encoded.get("input_ids", []))
    unk_id = getattr(tokenizer, "unk_token_id", None)
    unknown = sum(1 for token_id in ids if unk_id is not None and token_id == unk_id)
    return ids, unknown


def build_target_layout_custom(tokenizer: Any, words: Iterable[str], normalizer) -> TargetLayout:
    normalized_words = [normalizer(word) for word in words]
    normalized_words = [word for word in normalized_words if word]
    if not normalized_words:
        raise ValueError("No transcript words remained after normalization.")

    delimiter_id = getattr(tokenizer, "word_delimiter_token_id", None)
    if delimiter_id is None:
        delimiter_token = getattr(tokenizer, "word_delimiter_token", None) or "|"
        try:
            delimiter_id = tokenizer.convert_tokens_to_ids(delimiter_token)
        except Exception:
            delimiter_id = None
        unk_id = getattr(tokenizer, "unk_token_id", None)
        if delimiter_id == unk_id:
            delimiter_id = None

    ids: list[int] = []
    token_to_word: list[int | None] = []
    delimiter_positions: list[int] = []
    unknown_tokens = 0
    for word_index, word in enumerate(normalized_words):
        word_ids, unknown = _ids_for_word(tokenizer, word)
        unknown_tokens += unknown
        if not word_ids:
            raise ValueError(f"The alignment tokenizer produced no tokens for Arabic word: {word}")
        ids.extend(word_ids)
        token_to_word.extend([word_index] * len(word_ids))
        if word_index < len(normalized_words) - 1 and delimiter_id is not None:
            delimiter_positions.append(len(ids))
            ids.append(int(delimiter_id))
            token_to_word.append(None)

    if not ids:
        raise ValueError("The alignment transcript produced no CTC target tokens.")
    return TargetLayout(ids, token_to_word, delimiter_positions, normalized_words, unknown_tokens)


def build_target_layout(tokenizer: Any, words: Iterable[str]) -> TargetLayout:
    return build_target_layout_custom(tokenizer, words, normalize_arabic)


def ctc_viterbi(log_probs: np.ndarray, target_ids: list[int], blank_id: int) -> tuple[np.ndarray, np.ndarray]:
    """Memory-efficient Viterbi forced alignment against a fixed CTC target.

    Returns the chosen CTC state for every frame and the expanded state labels.
    """
    if log_probs.ndim != 2:
        raise ValueError("log_probs must have shape [frames, vocab].")
    frames, vocab = log_probs.shape
    if not target_ids:
        raise ValueError("Target transcript is empty.")
    if frames <= 0:
        raise ValueError("Audio produced no CTC frames.")
    if max(target_ids + [blank_id]) >= vocab:
        raise ValueError("Target token id is outside the model vocabulary.")

    target = np.asarray(target_ids, dtype=np.int64)
    state_count = target.size * 2 + 1
    labels = np.full(state_count, int(blank_id), dtype=np.int64)
    labels[1::2] = target

    neg_inf = np.float32(-1e30)
    previous = np.full(state_count, neg_inf, dtype=np.float32)
    previous[0] = log_probs[0, blank_id]
    if state_count > 1:
        previous[1] = log_probs[0, labels[1]]

    back = np.zeros((frames, state_count), dtype=np.uint8)
    indices = np.arange(state_count)
    can_skip = np.zeros(state_count, dtype=bool)
    for s in range(2, state_count):
        if labels[s] != blank_id and labels[s] != labels[s - 2]:
            can_skip[s] = True

    for t in range(1, frames):
        stay = previous
        advance = np.full(state_count, neg_inf, dtype=np.float32)
        advance[1:] = previous[:-1]
        skip = np.full(state_count, neg_inf, dtype=np.float32)
        skip[2:] = previous[:-2]
        skip[~can_skip] = neg_inf

        candidates = np.stack([stay, advance, skip], axis=0)
        choice = np.argmax(candidates, axis=0).astype(np.uint8)
        best = candidates[choice, indices]
        current = best + log_probs[t, labels]
        back[t] = choice
        previous = current.astype(np.float32, copy=False)

    final_candidates = [state_count - 1]
    if state_count >= 2:
        final_candidates.append(state_count - 2)
    final_state = max(final_candidates, key=lambda state: float(previous[state]))
    if not np.isfinite(previous[final_state]) or previous[final_state] < neg_inf / 2:
        raise ValueError("CTC alignment failed. The audio may not match the selected ayahs closely enough.")

    path = np.zeros(frames, dtype=np.int32)
    state = final_state
    path[-1] = state
    for t in range(frames - 1, 0, -1):
        state -= int(back[t, state])
        state = max(0, state)
        path[t - 1] = state
    return path, labels


def target_token_spans(
    path: np.ndarray,
    labels: np.ndarray,
    target_ids: list[int],
    log_probs: np.ndarray,
) -> list[dict[str, float]]:
    spans: list[dict[str, float]] = []
    frame_count = len(path)
    for target_index, token_id in enumerate(target_ids):
        state = target_index * 2 + 1
        frames = np.flatnonzero(path == state)
        if frames.size == 0:
            spans.append({"start_frame": math.nan, "end_frame": math.nan, "confidence": 0.0})
            continue
        probs = np.exp(log_probs[frames, token_id])
        spans.append(
            {
                "start_frame": float(frames[0]),
                "end_frame": float(frames[-1] + 1),
                "confidence": float(np.clip(np.mean(probs), 0.0, 1.0)),
            }
        )
    return spans


def _nearest_valid(value: float, fallback: float) -> float:
    return fallback if not math.isfinite(value) else value


def word_timings_from_tokens(
    layout: TargetLayout,
    spans: list[dict[str, float]],
    duration: float,
    frame_count: int,
) -> tuple[list[dict[str, float]], list[float]]:
    seconds_per_frame = duration / max(1, frame_count)
    word_token_indexes: list[list[int]] = [[] for _ in layout.normalized_words]
    for token_index, word_index in enumerate(layout.token_to_word):
        if word_index is not None:
            word_token_indexes[word_index].append(token_index)

    words: list[dict[str, float]] = []
    for word_index, indexes in enumerate(word_token_indexes):
        if not indexes:
            words.append({"start": 0.0, "end": 0.0, "ctc_confidence": 0.0})
            continue
        valid = [spans[i] for i in indexes if math.isfinite(spans[i]["start_frame"])]
        if not valid:
            words.append({"start": 0.0, "end": 0.0, "ctc_confidence": 0.0})
            continue
        start = min(item["start_frame"] for item in valid) * seconds_per_frame
        end = max(item["end_frame"] for item in valid) * seconds_per_frame
        confidence = float(np.mean([item["confidence"] for item in valid]))
        words.append({"start": start, "end": end, "ctc_confidence": confidence})

    delimiter_times: list[float] = []
    for token_index in layout.delimiter_positions:
        span = spans[token_index]
        if math.isfinite(span["start_frame"]):
            delimiter_times.append(((span["start_frame"] + span["end_frame"]) / 2) * seconds_per_frame)
        else:
            delimiter_times.append(math.nan)

    # Fill impossible gaps conservatively so the UI always gets monotonic timings.
    for i, word in enumerate(words):
        if word["end"] <= word["start"]:
            prev = words[i - 1]["end"] if i else 0.0
            next_start = words[i + 1]["start"] if i + 1 < len(words) and words[i + 1]["start"] > prev else duration
            word["start"] = prev
            word["end"] = max(prev + 0.04, min(duration, next_start))

    boundaries: list[float] = []
    for i in range(len(words) - 1):
        fallback = (words[i]["end"] + words[i + 1]["start"]) / 2
        if i < len(delimiter_times):
            boundary = _nearest_valid(delimiter_times[i], fallback)
        else:
            boundary = fallback
        lo = words[i]["start"] + 0.02
        hi = words[i + 1]["end"] - 0.02
        boundaries.append(float(np.clip(boundary, lo, max(lo, hi))))
    return words, boundaries


def _frame_slice(log_probs: np.ndarray, start: float, end: float, duration: float) -> tuple[np.ndarray, float, float]:
    frame_step = duration / max(1, log_probs.shape[0])
    first = max(0, min(log_probs.shape[0] - 1, int(math.floor(start / frame_step))))
    last = max(first + 1, min(log_probs.shape[0], int(math.ceil(end / frame_step))))
    return log_probs[first:last], first * frame_step, (last - first) * frame_step


def _occurrence_key(item: dict[str, Any]) -> tuple[int, int]:
    """Identify one recited ayah occurrence, not just the ayah number.

    sequenceIndex is supplied by the frontend so repeated/backtracked ayahs remain
    separate local alignment windows.
    """
    return int(item.get("ayahNumber") or 0), int(item.get("sequenceIndex") or 0)


def local_realign_by_ayah(
    log_probs: np.ndarray,
    tokenizer: Any,
    words_payload: list[dict[str, Any]],
    target_words: list[str],
    coarse_words: list[dict[str, float]],
    duration: float,
    blank_id: int,
    normalizer=normalize_arabic,
) -> tuple[list[dict[str, float]], list[float]]:
    """Second-pass CTC alignment inside each coarse ayah window.

    A single long Viterbi pass is good at locating the passage but can accumulate
    small timing drift. Re-aligning each ayah in its own narrow acoustic window makes
    word boundaries substantially more stable while preserving the known transcript.
    """
    if len(words_payload) != len(target_words) or len(coarse_words) != len(target_words):
        raise ValueError("Local alignment inputs have inconsistent word counts.")

    groups: list[list[int]] = []
    current: list[int] = []
    current_ayah = None
    for index, item in enumerate(words_payload):
        ayah = _occurrence_key(item)
        if current and ayah != current_ayah:
            groups.append(current)
            current = []
        current.append(index)
        current_ayah = ayah
    if current:
        groups.append(current)

    output = [dict(word) for word in coarse_words]
    all_boundaries: list[float] = []
    for group_index, indexes in enumerate(groups):
        first_i, last_i = indexes[0], indexes[-1]
        coarse_start = max(0.0, coarse_words[first_i]["start"])
        coarse_end = min(duration, coarse_words[last_i]["end"])
        median_word = max(0.08, (coarse_end - coarse_start) / max(1, len(indexes)))
        pad = min(0.42, max(0.12, median_word * 0.52))
        # Keep the local window out of the core of neighboring ayahs. This is
        # especially important for reciters who connect ayahs without a pause.
        if group_index:
            previous_last = groups[group_index - 1][-1]
            # Use the actual inter-ayah gap, not the start of the previous last word.
            # The old expression could let a local re-alignment window reach into
            # the previous ayah and steal its final syllable.
            previous_edge = float(coarse_words[previous_last]["end"])
            left_limit = (previous_edge + coarse_start) / 2
        else:
            left_limit = 0.0
        if group_index + 1 < len(groups):
            next_first = groups[group_index + 1][0]
            # Likewise stop before the next ayah's first word rather than using its
            # end time, which previously allowed the current window to invade it.
            next_edge = float(coarse_words[next_first]["start"])
            right_limit = (coarse_end + next_edge) / 2
        else:
            right_limit = duration
        window_start = max(left_limit, coarse_start - pad)
        window_end = min(right_limit, coarse_end + pad)
        if window_end - window_start < 0.08:
            continue

        local_probs, absolute_start, local_duration = _frame_slice(log_probs, window_start, window_end, duration)
        layout = build_target_layout_custom(tokenizer, [target_words[i] for i in indexes], normalizer)
        unknown_ratio = layout.unknown_tokens / max(1, len(layout.ids))
        if unknown_ratio > 0.08:
            continue
        try:
            path, labels = ctc_viterbi(local_probs, layout.ids, blank_id)
            spans = target_token_spans(path, labels, layout.ids, local_probs)
            local_words, local_boundaries = word_timings_from_tokens(layout, spans, local_duration, local_probs.shape[0])
        except ValueError:
            continue
        for local_index, global_index in enumerate(indexes):
            item = dict(local_words[local_index])
            item["start"] += absolute_start
            item["end"] += absolute_start
            output[global_index] = item
        all_boundaries.extend([boundary + absolute_start for boundary in local_boundaries])

    # Rebuild one globally ordered boundary list from the refined word spans.
    boundaries = []
    for i in range(len(output) - 1):
        left_ayah = _occurrence_key(words_payload[i])
        right_ayah = _occurrence_key(words_payload[i + 1])
        if left_ayah == right_ayah:
            boundaries.append((output[i]["end"] + output[i + 1]["start"]) / 2)
        else:
            boundaries.append((coarse_words[i]["end"] + coarse_words[i + 1]["start"]) / 2)
    return output, boundaries


def fuse_forced_alignments(
    generic_words: list[dict[str, float]],
    generic_boundaries: list[float],
    quran_words: list[dict[str, float]] | None,
    quran_boundaries: list[float] | None,
    duration: float,
) -> tuple[list[dict[str, float]], list[float], list[float]]:
    """Fuse orthographic Arabic CTC with Qur'an-specific phonetic CTC.

    The generic Arabic model is better at continuous speech; the Qur'an-specific model
    is better matched to Qur'anic phones/tajweed but was trained on isolated words.
    Confidence- and disagreement-aware fusion gets the benefit of both without blindly
    trusting either model when it drifts.
    """
    n = len(generic_words)
    if not quran_words or len(quran_words) != n or not quran_boundaries or len(quran_boundaries) != max(0, n - 1):
        conf = [float(word.get("ctc_confidence", 0.0)) for word in generic_words]
        return [dict(word) for word in generic_words], list(generic_boundaries), conf

    fused_boundaries: list[float] = []
    agreement_scores: list[float] = []
    for i in range(n - 1):
        g = float(generic_boundaries[i])
        q = float(quran_boundaries[i])
        gconf = float(np.mean([generic_words[i].get("ctc_confidence", 0.0), generic_words[i + 1].get("ctc_confidence", 0.0)]))
        qconf = float(np.mean([quran_words[i].get("ctc_confidence", 0.0), quran_words[i + 1].get("ctc_confidence", 0.0)]))
        disagreement = abs(g - q)
        # Strong agreement lets the Quran-specific model contribute more. Large
        # disagreements are treated conservatively because its training audio is isolated.
        if disagreement <= 0.24:
            q_weight = 0.62 + 0.12 * qconf
        elif disagreement <= 0.55:
            q_weight = 0.48 + 0.12 * max(0.0, qconf - gconf)
        else:
            q_weight = 0.24 if qconf <= gconf + 0.12 else 0.38
        q_weight = float(np.clip(q_weight, 0.18, 0.76))
        boundary = g * (1.0 - q_weight) + q * q_weight
        if fused_boundaries:
            boundary = max(fused_boundaries[-1] + 0.025, boundary)
        boundary = min(duration - 0.025, boundary)
        fused_boundaries.append(boundary)
        agreement = math.exp(-disagreement / 0.34)
        agreement_scores.append(float(np.clip(agreement * 0.7 + min(gconf, qconf) * 0.3, 0.0, 1.0)))

    first_start = min(float(generic_words[0]["start"]), float(quran_words[0]["start"]))
    # Avoid pulling the caption onset far into leading noise due to one bad model.
    if abs(float(generic_words[0]["start"]) - float(quran_words[0]["start"])) > 0.45:
        first_start = float(generic_words[0]["start"])
    last_end = max(float(generic_words[-1]["end"]), float(quran_words[-1]["end"]))
    if abs(float(generic_words[-1]["end"]) - float(quran_words[-1]["end"])) > 0.45:
        last_end = float(generic_words[-1]["end"])
    first_start = float(np.clip(first_start, 0.0, duration))
    last_end = float(np.clip(last_end, first_start + 0.025, duration))
    edges = [first_start, *fused_boundaries, last_end]

    output: list[dict[str, float]] = []
    confidences: list[float] = []
    for i in range(n):
        gconf = float(generic_words[i].get("ctc_confidence", 0.0))
        qconf = float(quran_words[i].get("ctc_confidence", 0.0))
        left_agree = agreement_scores[i - 1] if i else (agreement_scores[0] if agreement_scores else 0.6)
        right_agree = agreement_scores[i] if i < len(agreement_scores) else left_agree
        agreement = (left_agree + right_agree) / 2
        combined = float(np.clip(gconf * 0.48 + qconf * 0.34 + agreement * 0.18, 0.0, 1.0))
        output.append({
            "start": edges[i], "end": max(edges[i] + 0.025, edges[i + 1]),
            "ctc_confidence": combined,
            "generic_confidence": gconf,
            "quran_phonetic_confidence": qconf,
            "model_agreement": agreement,
        })
        confidences.append(combined)
    return output, fused_boundaries, confidences


def rms_boundary_curve(audio: np.ndarray, sample_rate: int, step_ms: float = 10.0) -> tuple[np.ndarray, float]:
    step = max(32, int(sample_rate * step_ms / 1000))
    window = max(step * 2, int(sample_rate * 0.035))
    values = []
    for start in range(0, len(audio), step):
        segment = audio[start : min(len(audio), start + window)]
        if segment.size == 0:
            values.append(0.0)
        else:
            values.append(float(np.sqrt(np.mean(np.square(segment, dtype=np.float64)) + 1e-12)))
    rms = np.asarray(values, dtype=np.float32)
    if rms.size == 0:
        return rms, step / sample_rate
    p90 = float(np.percentile(rms, 90)) or 1.0
    energy = np.clip(rms / p90, 0.0, 1.5)
    quiet = np.clip(1.0 - energy, 0.0, 1.0)
    smooth = np.convolve(quiet, np.ones(5, dtype=np.float32) / 5, mode="same")
    return smooth.astype(np.float32), step / sample_rate


def ctc_blank_boundary_curve(
    log_probs: np.ndarray,
    blank_id: int,
    duration: float,
) -> tuple[np.ndarray | None, float | None]:
    """Return a normalized generic-CTC blank posterior for word-boundary refinement.

    The exact-text Viterbi path already provides the stable timing anchor. This curve
    is only a local cue: high blank probability between two forced words is evidence
    for the acoustic transition point. Keeping it separate from the Qur'an-specific
    model makes refinement more robust when one model is uncertain.
    """
    if log_probs.ndim != 2 or log_probs.shape[0] < 3 or blank_id < 0 or blank_id >= log_probs.shape[1]:
        return None, None
    blank = np.exp(log_probs[:, int(blank_id)]).astype(np.float32)
    if blank.size >= 5:
        blank = np.convolve(blank, np.ones(5, dtype=np.float32) / 5, mode="same")
    p20 = float(np.percentile(blank, 20))
    p95 = float(np.percentile(blank, 95))
    if p95 <= p20 + 1e-5:
        p20 = float(np.min(blank))
        p95 = float(np.max(blank))
    if p95 <= p20 + 1e-7:
        return None, None
    curve = np.clip((blank - p20) / (p95 - p20), 0.0, 1.0).astype(np.float32)
    return curve, duration / max(1, len(curve))


def refine_boundaries(
    words: list[dict[str, float]],
    boundaries: list[float],
    duration: float,
    acoustic_curve: np.ndarray,
    acoustic_step: float,
    quran_curve: np.ndarray | None = None,
    quran_step: float | None = None,
    generic_blank_curve: np.ndarray | None = None,
    generic_blank_step: float | None = None,
) -> tuple[list[dict[str, float]], list[float]]:
    if len(words) <= 1:
        return words, []
    refined: list[float] = []
    for i, initial in enumerate(boundaries):
        left = words[i]
        right = words[i + 1]
        # When the two CTC models already agree, refinement should only make a tiny
        # adjustment. Bigger searches are reserved for genuinely uncertain edges.
        edge_conf = float(np.clip(np.mean([
            left.get("ctc_confidence", 0.0), right.get("ctc_confidence", 0.0),
            left.get("model_agreement", 0.55), right.get("model_agreement", 0.55),
        ]), 0.0, 1.0))
        pair_span = max(0.12, right["end"] - left["start"])
        allowed = 0.09 + (1.0 - edge_conf) * 0.22
        local_span = max(0.07, min(allowed, pair_span * 0.22, 0.32))
        lo = max(left["start"] + 0.018, initial - local_span)
        hi = min(right["end"] - 0.018, initial + local_span)
        if hi <= lo:
            refined.append(initial)
            continue
        step = max(0.004, min(acoustic_step, generic_blank_step or acoustic_step, quran_step or acoustic_step, 0.010))
        candidate_times = np.arange(lo, hi + 1e-6, step)
        scores = np.zeros(candidate_times.size, dtype=np.float32)
        for j, time in enumerate(candidate_times):
            ai = min(len(acoustic_curve) - 1, max(0, int(round(time / acoustic_step)))) if len(acoustic_curve) else 0
            acoustic = float(acoustic_curve[ai]) if len(acoustic_curve) else 0.0
            generic_blank = 0.0
            if generic_blank_curve is not None and generic_blank_curve.size and generic_blank_step:
                gi = min(len(generic_blank_curve) - 1, max(0, int(round(time / generic_blank_step))))
                generic_blank = float(generic_blank_curve[gi])
            quran = 0.0
            if quran_curve is not None and quran_curve.size and quran_step:
                qi = min(len(quran_curve) - 1, max(0, int(round(time / quran_step))))
                quran = float(quran_curve[qi])
            distance = abs(time - initial) / max(local_span, 1e-6)
            # CTC evidence is primary; waveform quietness is deliberately weaker so
            # madd/ghunnah energy dips do not pull a boundary into the middle of a word.
            scores[j] = generic_blank * 1.45 + quran * 1.15 + acoustic * 0.42 - distance * (0.48 + edge_conf * 0.42)
        best = float(candidate_times[int(np.argmax(scores))])
        if refined:
            best = max(refined[-1] + 0.025, best)
        best = min(best, duration - 0.025)
        refined.append(best)

    # Convert the refined boundary sequence to contiguous word display spans.
    first_start = max(0.0, words[0]["start"])
    last_end = min(duration, words[-1]["end"])
    edges = [first_start, *refined, last_end]
    for i, word in enumerate(words):
        word["start"] = float(edges[i])
        word["end"] = float(max(edges[i] + 0.025, edges[i + 1]))
        if i < len(refined):
            ai = min(len(acoustic_curve) - 1, max(0, int(round(refined[i] / acoustic_step)))) if len(acoustic_curve) else 0
            acoustic = float(acoustic_curve[ai]) if len(acoustic_curve) else 0.0
            generic_blank = 0.0
            if generic_blank_curve is not None and generic_blank_curve.size and generic_blank_step:
                gi = min(len(generic_blank_curve) - 1, max(0, int(round(refined[i] / generic_blank_step))))
                generic_blank = float(generic_blank_curve[gi])
            quran = 0.0
            if quran_curve is not None and quran_curve.size and quran_step:
                qi = min(len(quran_curve) - 1, max(0, int(round(refined[i] / quran_step))))
                quran = float(quran_curve[qi])
            word["boundary_confidence"] = float(np.clip(generic_blank * 0.50 + quran * 0.32 + acoustic * 0.18, 0.0, 1.0))
        elif i:
            word["boundary_confidence"] = words[i - 1].get("boundary_confidence", 0.5)
        else:
            word["boundary_confidence"] = 0.5
        word["confidence"] = float(
            np.clip(word.get("ctc_confidence", 0.0) * 0.78 + word.get("boundary_confidence", 0.5) * 0.22, 0.0, 1.0)
        )
    return words, refined


def quran_delimiter_curve(log_probs: np.ndarray, tokenizer: Any, duration: float) -> tuple[np.ndarray | None, float | None]:
    """Build a Qur'an-recitation boundary cue from the phonetic CTC model.

    The model was trained on Qur'anic word audio. In continuous recitation its literal
    word-delimiter token may be weak, so we combine any real delimiter evidence with
    locally high CTC-blank probability instead of trusting a tiny noisy delimiter peak.
    """
    if log_probs.ndim != 2 or log_probs.shape[0] < 3:
        return None, None

    blank_id = getattr(tokenizer, "pad_token_id", None)
    blank_curve = None
    if blank_id is not None and 0 <= int(blank_id) < log_probs.shape[1]:
        blank = np.exp(log_probs[:, int(blank_id)]).astype(np.float32)
        if blank.size >= 7:
            blank = np.convolve(blank, np.ones(7, dtype=np.float32) / 7, mode="same")
        p45 = float(np.percentile(blank, 45))
        p95 = float(np.percentile(blank, 95))
        if p95 > p45 + 1e-4:
            blank_curve = np.clip((blank - p45) / (p95 - p45), 0.0, 1.0)

    delimiter_id = getattr(tokenizer, "word_delimiter_token_id", None)
    if delimiter_id is None:
        try:
            delimiter_id = tokenizer.convert_tokens_to_ids("|")
        except Exception:
            delimiter_id = None
    unk_id = getattr(tokenizer, "unk_token_id", None)
    delimiter_curve = None
    if delimiter_id is not None and delimiter_id != unk_id and 0 <= int(delimiter_id) < log_probs.shape[1]:
        delimiter = np.exp(log_probs[:, int(delimiter_id)]).astype(np.float32)
        if delimiter.size >= 5:
            delimiter = np.convolve(delimiter, np.ones(5, dtype=np.float32) / 5, mode="same")
        # Only trust this channel if the model actually emits a meaningful delimiter peak.
        peak = float(np.max(delimiter)) if delimiter.size else 0.0
        p95 = float(np.percentile(delimiter, 95)) if delimiter.size else 0.0
        if peak >= 0.02 and p95 >= 0.002:
            delimiter_curve = np.clip(delimiter / max(peak, 1e-6), 0.0, 1.0)

    if blank_curve is None and delimiter_curve is None:
        return None, None
    if blank_curve is None:
        curve = delimiter_curve
    elif delimiter_curve is None:
        curve = blank_curve
    else:
        curve = np.clip(blank_curve * 0.58 + delimiter_curve * 0.42, 0.0, 1.0)
    return np.asarray(curve, dtype=np.float32), duration / max(1, len(curve))
