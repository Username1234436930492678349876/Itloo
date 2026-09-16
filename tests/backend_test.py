from __future__ import annotations

import math
import subprocess
import tempfile
import time
from pathlib import Path
import sys

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.alignment import (  # noqa: E402
    build_target_layout,
    ctc_viterbi,
    ctc_blank_boundary_curve,
    normalize_arabic,
    refine_boundaries,
    fuse_forced_alignments,
    rms_boundary_curve,
    target_token_spans,
    word_timings_from_tokens,
)
from backend.audio_utils import ffmpeg_exe  # noqa: E402
from backend.render import render_video  # noqa: E402
from backend.phonetics import normalize_phonetic  # noqa: E402
import backend.phonetics as phonetics_module  # noqa: E402


class FakeTokenized:
    def __init__(self, ids): self.input_ids = ids


class FakeTokenizer:
    pad_token_id = 0
    unk_token_id = 99
    word_delimiter_token_id = 4
    word_delimiter_token = '|'
    vocab = {'ا': 1, 'ب': 2, 'ت': 3, '|': 4}
    def __call__(self, text, add_special_tokens=False):
        return FakeTokenized([self.vocab.get(ch, 99) for ch in text if ch != ' '])
    def convert_tokens_to_ids(self, token): return self.vocab.get(token, 99)


def test_alignment_core():
    assert normalize_arabic('ٱلرَّحْمَٰنِ') == 'الرحمن'
    assert normalize_phonetic('Bismi Hādhā') == 'bismi Hādhā'
    tok = FakeTokenizer()
    layout = build_target_layout(tok, ['اب', 'ت'])
    assert layout.ids == [1, 2, 4, 3]
    assert layout.token_to_word == [0, 0, None, 1]

    # Frames intentionally emit: blank, ا, ا, ب, delimiter, ت, ت, blank.
    frames, vocab = 8, 5
    probs = np.full((frames, vocab), 1e-5, dtype=np.float32)
    sequence = [0, 1, 1, 2, 4, 3, 3, 0]
    for t, token in enumerate(sequence): probs[t, token] = 0.999
    probs /= probs.sum(axis=1, keepdims=True)
    log_probs = np.log(probs)
    path, labels = ctc_viterbi(log_probs, layout.ids, 0)
    spans = target_token_spans(path, labels, layout.ids, log_probs)
    blank_curve, blank_step = ctc_blank_boundary_curve(log_probs, 0, 0.8)
    assert blank_curve is not None and blank_step is not None and len(blank_curve) == frames
    words, boundaries = word_timings_from_tokens(layout, spans, 0.8, frames)
    assert words[0]['start'] < .25 and words[0]['end'] <= .45
    assert .35 <= boundaries[0] <= .55
    assert words[1]['end'] > .55

    audio = np.concatenate([np.ones(3000, dtype=np.float32) * .2, np.zeros(1600, dtype=np.float32), np.ones(3400, dtype=np.float32) * .2])
    curve, step = rms_boundary_curve(audio, 16000)
    refined_words, refined = refine_boundaries(
        [{'start': .05, 'end': .30, 'ctc_confidence': .9}, {'start': .32, 'end': .48, 'ctc_confidence': .9}],
        [.30], .5, curve, step,
    )
    assert len(refined) == 1
    assert refined_words[0]['end'] == refined_words[1]['start']



def test_dual_alignment_fusion():
    generic = [
        {"start": 0.10, "end": 0.80, "ctc_confidence": 0.82},
        {"start": 0.82, "end": 1.45, "ctc_confidence": 0.84},
        {"start": 1.48, "end": 2.10, "ctc_confidence": 0.80},
    ]
    quran = [
        {"start": 0.12, "end": 0.76, "ctc_confidence": 0.91},
        {"start": 0.79, "end": 1.42, "ctc_confidence": 0.93},
        {"start": 1.44, "end": 2.08, "ctc_confidence": 0.90},
    ]
    fused, boundaries, confidences = fuse_forced_alignments(
        generic, [0.81, 1.465], quran, [0.775, 1.43], 2.2
    )
    assert len(fused) == 3 and len(boundaries) == 2 and len(confidences) == 3
    assert 0.775 <= boundaries[0] <= 0.81
    assert 1.43 <= boundaries[1] <= 1.465
    assert all(fused[i]["end"] <= fused[i + 1]["start"] + 1e-9 for i in range(2))
    assert all(0 <= c <= 1 for c in confidences)


def test_frontend_is_served_without_vite():
    from fastapi.testclient import TestClient
    from backend.app import app
    client = TestClient(app)
    index = client.get('/')
    assert index.status_code == 200
    assert '<link rel="stylesheet" href="/src/style.css"' in index.text
    js = client.get('/src/main.js')
    css = client.get('/src/style.css')
    assert js.status_code == 200 and 'javascript' in js.headers.get('content-type', '')
    assert css.status_code == 200 and 'text/css' in css.headers.get('content-type', '')
    assert "import './style.css'" not in js.text
    health = client.get('/api/health')
    assert health.status_code == 200 and health.json().get('version') == '7.2.0'



def test_phonetic_metadata_mapping_prefers_word_index():
    rows = [
        {"word_index": 0, "word_id": "1:1:1", "word_ar": "قَالَ", "word_tr": "qāla"},
        {"word_index": 1, "word_id": "1:1:2", "word_ar": "قَالَ", "word_tr": "qāla-second"},
        {"word_index": 2, "word_id": "1:1:3", "word_ar": "هُوَ", "word_tr": "Huwa"},
    ]
    old_fetch = phonetics_module.fetch_ayah_phonetic_rows
    try:
        phonetics_module.fetch_ayah_phonetic_rows = lambda _s, _a: rows
        payload = [
            {"ayahNumber": 1, "wordIndex": 0, "text": "قَالَ"},
            {"ayahNumber": 1, "wordIndex": 1, "text": "قَالَ"},
            {"ayahNumber": 1, "wordIndex": 2, "text": "هُوَ"},
        ]
        mapped, info = phonetics_module.map_payload_to_phonetics(payload, 1)
        assert mapped == ['qāla', 'qāla-second', 'Huwa']
        assert info['coverage'] == 1.0
    finally:
        phonetics_module.fetch_ayah_phonetic_rows = old_fetch

def test_align_endpoint_with_mock_ctc():
    """Exercise multipart upload + endpoint wiring without downloading AI models."""
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    import backend.app as app_module

    class Processor:
        def __init__(self):
            self.tokenizer = FakeTokenizer()
        def batch_decode(self, _ids):
            return ['ابت']

    runtime = SimpleNamespace(
        processor=Processor(),
        model=SimpleNamespace(config=SimpleNamespace(pad_token_id=0)),
        device='cpu',
    )

    frames, vocab = 8, 5
    probs = np.full((frames, vocab), 1e-5, dtype=np.float32)
    for t, token in enumerate([0, 1, 1, 2, 4, 3, 3, 0]):
        probs[t, token] = 0.999
    probs /= probs.sum(axis=1, keepdims=True)
    fake_log_probs = np.log(probs)

    old_get = app_module.get_alignment_model
    old_emissions = app_module.emissions
    try:
        app_module.get_alignment_model = lambda: runtime
        app_module.emissions = lambda _runtime, _samples, _sr: fake_log_probs.copy()
        client = TestClient(app_module.app)
        with tempfile.TemporaryDirectory(prefix='qws-align-endpoint-') as td:
            wav = Path(td) / 'clip.wav'
            sf.write(wav, np.zeros(12800, dtype=np.float32), 16000)
            transcript = '{"surahNumber":1,"words":[{"index":0,"ayahNumber":1,"wordIndex":0,"text":"اب"},{"index":1,"ayahNumber":1,"wordIndex":1,"text":"ت"}]}'
            with wav.open('rb') as handle:
                response = client.post(
                    '/api/align',
                    files={'audio': ('clip.wav', handle, 'audio/wav')},
                    data={'transcript': transcript, 'quran_refine': 'false'},
                )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload['engine'] == 'ai-precise-hierarchical-dual-ctc-stable'
        assert len(payload['words']) == 2
        assert payload['words'][0]['start'] < payload['words'][0]['end'] <= payload['words'][1]['end']
        assert payload['words'][0]['end'] == payload['words'][1]['start']
    finally:
        app_module.get_alignment_model = old_get
        app_module.emissions = old_emissions

def write_ppm(path: Path, w: int, h: int, rgb: tuple[int, int, int]):
    data = bytes(rgb) * (w * h)
    path.write_bytes(f'P6\n{w} {h}\n255\n'.encode() + data)


def test_render_video_watermark():
    with tempfile.TemporaryDirectory(prefix='qws-test-') as td:
        td = Path(td)
        bg = td / 'bg.ppm'
        overlay = td / 'overlay.ppm'
        shadow = td / 'shadow.ppm'
        write_ppm(bg, 90, 160, (30, 40, 35))
        write_ppm(overlay, 90, 40, (230, 230, 230))
        write_ppm(shadow, 90, 160, (0, 0, 0))
        t = np.arange(16000, dtype=np.float32) / 16000
        sf.write(td / 'audio.wav', np.sin(2 * np.pi * 330 * t).astype(np.float32) * .08, 16000)
        wm = td / 'wm.mp4'
        subprocess.run([
            ffmpeg_exe(), '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x32:r=15', '-t', '0.28',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(wm)
        ], check=True)
        out = td / 'out.mp4'
        render_video(
            audio_path=td/'audio.wav', background_path=bg, overlay_paths=[overlay],
            metadata={
                'width': 180, 'height': 320, 'duration': 1.0, 'darkness': .2, 'blur': 0,
                'overlays': [{'start': .05, 'end': .95}],
                'watermark': {'enabled': True, 'position': 'bottom-right', 'size': .18, 'opacity': .6},
                'shadowOverlay': {'enabled': True, 'x': .5, 'y': .76, 'size': 1.0, 'opacity': .35},
                'preset': 'ultrafast', 'crf': 28,
            },
            output_path=out, background_content_type='image/x-portable-pixmap', watermark_path=wm, watermark_content_type='video/mp4',
            shadow_overlay_path=shadow, shadow_overlay_content_type='image/x-portable-pixmap'
        )
        assert out.exists() and out.stat().st_size > 2000
        probe = subprocess.run([ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-i', str(out), '-f', 'null', '-'], capture_output=True, text=True)
        assert probe.returncode == 0, probe.stderr


def test_async_render_progress_endpoint():
    from fastapi.testclient import TestClient
    import backend.app as app_module

    with tempfile.TemporaryDirectory(prefix='qws-job-test-') as td_raw:
        td = Path(td_raw)
        bg = td / 'bg.ppm'
        overlay = td / 'overlay.ppm'
        write_ppm(bg, 90, 160, (20, 30, 25))
        write_ppm(overlay, 90, 40, (240, 240, 240))
        t = np.arange(12800, dtype=np.float32) / 16000
        audio = td / 'audio.wav'
        sf.write(audio, np.sin(2 * np.pi * 300 * t).astype(np.float32) * .05, 16000)
        meta = '{"width":180,"height":320,"duration":0.8,"darkness":0.1,"blur":0,"preset":"ultrafast","crf":28,"overlays":[{"start":0.05,"end":0.75}],"watermark":{"enabled":false}}'
        client = TestClient(app_module.app)
        with audio.open('rb') as ah, bg.open('rb') as bh, overlay.open('rb') as oh:
            response = client.post(
                '/api/render/start',
                files=[
                    ('audio', ('audio.wav', ah, 'audio/wav')),
                    ('background', ('bg.ppm', bh, 'image/x-portable-pixmap')),
                    ('overlays', ('phrase-000.png', oh, 'image/x-portable-pixmap')),
                ],
                data={'metadata': meta},
            )
        assert response.status_code == 200, response.text
        job_id = response.json()['jobId']
        seen = []
        status = None
        for _ in range(100):
            poll = client.get(f'/api/render/{job_id}/status')
            assert poll.status_code == 200, poll.text
            status = poll.json()
            seen.append(float(status.get('progress', 0)))
            if status.get('status') in {'done', 'error'}:
                break
            time.sleep(0.05)
        assert status and status.get('status') == 'done', status
        assert max(seen) == 1.0
        download = client.get(f'/api/render/{job_id}/download')
        assert download.status_code == 200, download.text
        assert download.headers.get('content-type', '').startswith('video/mp4')
        assert len(download.content) > 1000


if __name__ == '__main__':
    test_alignment_core()
    print('Python CTC forced-alignment core tests passed.')
    test_dual_alignment_fusion()
    print('Dual-model alignment fusion test passed.')
    test_frontend_is_served_without_vite()
    print('Native frontend/static backend test passed.')
    test_phonetic_metadata_mapping_prefers_word_index()
    print('Quran-MD phonetic metadata mapping test passed.')
    test_align_endpoint_with_mock_ctc()
    print('AI alignment HTTP endpoint wiring test passed.')
    test_render_video_watermark()
    print('Backend FFmpeg video-watermark render test passed.')
    test_async_render_progress_endpoint()
    print('Asynchronous FFmpeg progress/download endpoint test passed.')


def test_repeat_detection_helper():
    from backend.app import detect_repeated_ayah_sequence, expand_payload_to_ayah_sequence
    words = [
        {"index":0,"ayahNumber":1,"sequenceIndex":0,"wordIndex":0,"text":"الحمد"},
        {"index":1,"ayahNumber":1,"sequenceIndex":0,"wordIndex":1,"text":"لله"},
        {"index":2,"ayahNumber":2,"sequenceIndex":1,"wordIndex":0,"text":"الرحمن"},
        {"index":3,"ayahNumber":2,"sequenceIndex":1,"wordIndex":1,"text":"الرحيم"},
    ]
    seq = detect_repeated_ayah_sequence("الحمد لله الرحمن الرحيم الحمد لله الرحمن الرحيم", words)
    assert seq == [1, 2, 1, 2]
    expanded = expand_payload_to_ayah_sequence(words, seq)
    assert [w["ayahNumber"] for w in expanded if w["wordIndex"] == 0] == [1,2,1,2]
    assert expanded[4]["occurrenceIndex"] == 1


def test_safe_basmalah_helpers_do_not_shift_main_timings():
    from backend.app import _prefix_similarity_to_basmalah, prepend_basmalah_response

    assert _prefix_similarity_to_basmalah("بسم الله الرحمن الرحيم") > 0.95
    assert _prefix_similarity_to_basmalah("ذلك الكتاب لا ريب فيه") < 0.60

    main = [
        {
            "index": 0, "ayahNumber": 5, "sequenceIndex": 0, "occurrenceIndex": 0,
            "occurrenceKey": "5@0", "wordIndex": 0, "normalized": "ذلك",
            "start": 2.25, "end": 2.80, "confidence": .9, "confidenceLabel": "high",
        },
        {
            "index": 1, "ayahNumber": 5, "sequenceIndex": 0, "occurrenceIndex": 0,
            "occurrenceKey": "5@0", "wordIndex": 1, "normalized": "الكتاب",
            "start": 2.80, "end": 3.40, "confidence": .9, "confidenceLabel": "high",
        },
    ]
    basm = [
        {"start": 0.10, "end": 0.50, "ctc_confidence": .9},
        {"start": 0.50, "end": 0.95, "ctc_confidence": .9},
        {"start": 0.95, "end": 1.45, "ctc_confidence": .9},
        {"start": 1.45, "end": 2.05, "ctc_confidence": .9},
    ]
    combined = prepend_basmalah_response(main, basm)
    assert len(combined) == 6
    assert [w["ayahNumber"] for w in combined[:4]] == [0, 0, 0, 0]
    # The requested-ayah timings must be byte-for-byte unchanged; only metadata/indexes shift.
    assert combined[4]["start"] == main[0]["start"] and combined[4]["end"] == main[0]["end"]
    assert combined[5]["start"] == main[1]["start"] and combined[5]["end"] == main[1]["end"]
    assert combined[4]["sequenceIndex"] == 1 and combined[4]["occurrenceKey"] == "5@1"



def test_post_alignment_basmalah_auto_path():
    """Synthetic CTC: basmalah is aligned only inside the leading prefix."""
    from types import SimpleNamespace
    from backend.app import align_leading_basmalah, BASMALAH_WORDS
    from backend.alignment import build_target_layout

    chars = sorted(set(''.join(BASMALAH_WORDS)))
    vocab = {ch: i + 1 for i, ch in enumerate(chars)}
    delimiter_id = len(vocab) + 1
    vocab['|'] = delimiter_id
    blank_id = 0

    class Tok:
        pad_token_id = 0
        unk_token_id = 999
        word_delimiter_token_id = delimiter_id
        word_delimiter_token = '|'
        def __call__(self, value, add_special_tokens=False):
            return FakeTokenized([vocab.get(ch, 999) for ch in value if ch != ' '])
        def convert_tokens_to_ids(self, token):
            return vocab.get(token, 999)

    tok = Tok()
    layout = build_target_layout(tok, BASMALAH_WORDS)
    # Give every target state two very confident frames, surrounded by blanks.
    sequence = [blank_id, blank_id]
    for token in layout.ids:
        sequence.extend([token, token])
    sequence.extend([blank_id] * 12)
    frames = len(sequence)
    vocab_size = delimiter_id + 1
    probs = np.full((frames, vocab_size), 1e-6, dtype=np.float32)
    for frame, token in enumerate(sequence):
        probs[frame, token] = .999
    probs /= probs.sum(axis=1, keepdims=True)
    log_probs = np.log(probs)

    class Proc:
        tokenizer = tok
        def batch_decode(self, _ids):
            return ['بسم الله الرحمن الرحيم']

    runtime = SimpleNamespace(processor=Proc(), model=SimpleNamespace(config=SimpleNamespace(pad_token_id=0)))
    words, diagnostics = align_leading_basmalah(
        log_probs, runtime, duration=3.0, first_main_start=2.45, blank_id=blank_id, mode='auto'
    )
    assert words and len(words) == 4
    assert diagnostics['accepted'] is True
    assert words[-1]['end'] <= 2.61


def test_engagement_intro_render_segment():
    with tempfile.TemporaryDirectory(prefix='qws-intro-test-') as td_raw:
        td = Path(td_raw)
        bg = td / 'bg.ppm'
        overlay = td / 'overlay.ppm'
        title = td / 'intro.ppm'
        write_ppm(bg, 90, 160, (20, 45, 70))
        write_ppm(overlay, 90, 160, (0, 0, 0))
        write_ppm(title, 80, 48, (245, 245, 245))
        t = np.arange(16000, dtype=np.float32) / 16000
        audio = td / 'audio.wav'
        sf.write(audio, np.sin(2 * np.pi * 300 * t).astype(np.float32) * .04, 16000)
        out = td / 'out.mp4'
        render_video(
            audio_path=audio,
            background_path=bg,
            overlay_paths=[overlay],
            metadata={
                'width': 180, 'height': 320, 'duration': 1.0,
                'overlays': [{'start': 0.05, 'end': 0.95}],
                'watermark': {'enabled': False},
                'intro': {'enabled': True, 'duration': 1.2, 'sound': 'deep'},
                'preset': 'ultrafast', 'crf': 28,
            },
            output_path=out,
            background_content_type='image/x-portable-pixmap',
            intro_title_path=title,
            intro_title_content_type='image/x-portable-pixmap',
        )
        assert out.exists() and out.stat().st_size > 2000
        decoded = subprocess.run(
            [ffmpeg_exe(), '-hide_banner', '-i', str(out), '-f', 'null', '-'],
            capture_output=True, text=True,
        )
        assert decoded.returncode == 0, decoded.stderr
        assert 'Duration: 00:00:02.' in decoded.stderr, decoded.stderr
        assert '48000 Hz, stereo' in decoded.stderr, decoded.stderr


def test_background_discovery_endpoint_without_network():
    from fastapi.testclient import TestClient
    import backend.app as app_module

    fake_items = [
        {
            'id': str(i),
            'name': f'Calm clip {i}.webm',
            'url': f'https://upload.wikimedia.org/fake/clip-{i}.webm',
            'thumb': f'https://upload.wikimedia.org/fake/thumb-{i}.jpg',
            'mime': 'video/webm',
            'size': 1000 + i,
            'width': 1280,
            'height': 720,
            'source': f'https://commons.wikimedia.org/wiki/File:clip-{i}.webm',
            'license': 'CC0',
            'artist': 'Test artist',
        }
        for i in range(8)
    ]
    old = app_module._commons_search
    try:
        app_module._commons_search = lambda _query, _limit=18: list(fake_items)
        client = TestClient(app_module.app)
        response = client.get('/api/backgrounds/discover?theme=calm&seed=4')
        assert response.status_code == 200, response.text
        payload = response.json()
        assert 1 <= len(payload['items']) <= 5
        assert all(item['url'].startswith('https://upload.wikimedia.org/') for item in payload['items'])
    finally:
        app_module._commons_search = old


def test_background_fetch_rejects_non_commons_url():
    from fastapi.testclient import TestClient
    from backend.app import app
    client = TestClient(app)
    response = client.get('/api/backgrounds/fetch', params={'url': 'https://example.com/video.mp4'})
    assert response.status_code == 400


def test_recitation_library_url_catalog():
    import backend.app as app_module
    assert app_module._library_ayah_url('mishary_alafasi', 2, 255).endswith('/Alafasy_128kbps/002255.mp3')
    assert app_module._library_ayah_url('khalifa_altunaiji', 1, 1).endswith('/khalefa_al_tunaiji_64kbps/001001.mp3')
    assert app_module._library_ayah_url('yasser_aldosari', 36, 1).endswith('/Yasser_Ad-Dussary_128kbps/036001.mp3')
    assert [v['name'] for v in app_module.RECITATION_LIBRARY.values()] == [
        'Mishary Rashid Alafasy', 'Khalifa Al Tunaiji', 'Yasser Al Dosari'
    ]


def test_recitation_library_endpoint_without_network():
    from fastapi.testclient import TestClient
    import backend.app as app_module

    old_download = app_module._download_library_ayah
    old_concat = app_module._concat_library_audio
    with tempfile.TemporaryDirectory(prefix='qws-library-test-') as td_raw:
        td = Path(td_raw)
        dummy = td / 'ayah.mp3'
        dummy.write_bytes(b'fake-mp3-data' * 300)

        def fake_download(_reciter, _surah, _ayah):
            return dummy

        def fake_concat(paths, output_path):
            assert len(paths) == 3
            output_path.write_bytes(b'fake-m4a-data' * 400)

        try:
            app_module._download_library_ayah = fake_download
            app_module._concat_library_audio = fake_concat
            client = TestClient(app_module.app)
            response = client.get('/api/library/recitation?reciter=mishary_alafasi&surah=2&start=1&end=3')
            assert response.status_code == 200, response.text
            assert response.headers['content-type'].startswith('audio/mp4')
            assert response.headers.get('x-quran-reciter') == 'Mishary Rashid Alafasy'
            assert len(response.content) > 1000
        finally:
            app_module._download_library_ayah = old_download
            app_module._concat_library_audio = old_concat


def test_multi_background_sar_is_normalized():
    """Regression: mixed source SAR values must not break FFmpeg concat."""
    with tempfile.TemporaryDirectory(prefix='qws-sar-test-') as td_raw:
        td = Path(td_raw)
        bg1 = td / 'bg1.mp4'
        bg2 = td / 'bg2.mp4'
        overlay = td / 'overlay.ppm'
        write_ppm(overlay, 90, 40, (245, 245, 245))
        subprocess.run([
            ffmpeg_exe(), '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30',
            '-vf', 'setsar=10240/10239', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(bg1)
        ], check=True)
        subprocess.run([
            ffmpeg_exe(), '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=30',
            '-vf', 'setsar=1', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(bg2)
        ], check=True)
        t = np.arange(16000, dtype=np.float32) / 16000
        audio = td / 'audio.wav'
        sf.write(audio, np.sin(2 * np.pi * 220 * t).astype(np.float32) * .04, 16000)
        out = td / 'out.mp4'
        render_video(
            audio_path=audio,
            background_paths=[bg1, bg2],
            overlay_paths=[overlay],
            metadata={
                'width': 180, 'height': 320, 'duration': 1.0, 'preset': 'ultrafast', 'crf': 28,
                'backgrounds': [
                    {'duration': .5, 'fit': 'cover'},
                    {'duration': .5, 'fit': 'cover'},
                ],
                'overlays': [{'start': .05, 'end': .95}],
                'watermark': {'enabled': False},
                'intro': {'enabled': False},
            },
            output_path=out,
            background_content_types=['video/mp4', 'video/mp4'],
        )
        assert out.exists() and out.stat().st_size > 1000
        probe = subprocess.run([ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-i', str(out), '-f', 'null', '-'], capture_output=True, text=True)
        assert probe.returncode == 0, probe.stderr


def test_recitation_library_prefix_options_without_network():
    from fastapi.testclient import TestClient
    import backend.app as app_module

    old_download = app_module._download_library_ayah
    old_istiatha = app_module._extract_library_istiatha
    old_concat = app_module._concat_library_audio
    with tempfile.TemporaryDirectory(prefix='qws-library-prefix-test-') as td_raw:
        td = Path(td_raw)
        source = td / 'piece.mp3'
        source.write_bytes(b'fake-audio' * 400)
        calls = []
        def fake_download(reciter, surah, ayah):
            calls.append(('ayah', surah, ayah))
            return source
        def fake_istiatha(reciter):
            calls.append(('istiatha', reciter))
            return source
        def fake_concat(paths, out):
            out.write_bytes(b'm4a' * 1000)
        try:
            app_module._download_library_ayah = fake_download
            app_module._extract_library_istiatha = fake_istiatha
            app_module._concat_library_audio = fake_concat
            client = TestClient(app_module.app)
            response = client.get('/api/library/recitation?reciter=mishary_alafasi&surah=95&start=1&end=2&istiatha=true&basmalah=true')
            assert response.status_code == 200, response.text
            assert response.headers.get('X-Quran-Istiatha') == '1'
            assert response.headers.get('X-Quran-Basmalah') == '1'
            assert ('istiatha', 'mishary_alafasi') in calls
            assert ('ayah', 1, 1) in calls  # basmalah source
            assert ('ayah', 95, 1) in calls and ('ayah', 95, 2) in calls
        finally:
            app_module._download_library_ayah = old_download
            app_module._extract_library_istiatha = old_istiatha
            app_module._concat_library_audio = old_concat
