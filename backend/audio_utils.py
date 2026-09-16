from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def convert_to_wav(input_path: Path, output_path: Path, sample_rate: int = 16000) -> None:
    cmd = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(input_path), "-vn", "-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_s16le", str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "FFmpeg could not decode the uploaded recitation.")


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return np.asarray(audio, dtype=np.float32), int(sample_rate)


def intro_sfx_source(style: str, duration: float) -> tuple[str, str]:
    """Return an FFmpeg lavfi audio source and matching post-filter.

    The source is generated locally, so the title card has synchronized sound
    design without requiring bundled/copyrighted SFX assets.
    """
    duration = max(0.2, float(duration))
    style = (style or "deep").strip().lower()
    if style in {"none", "off", "silent"}:
        return (
            f"anullsrc=r=48000:cl=stereo:d={duration:.3f}",
            "anull",
        )
    if style in {"swoosh", "whoosh"}:
        return (
            f"anoisesrc=color=pink:amplitude=0.32:sample_rate=48000:duration={duration:.3f}",
            f"highpass=f=260,lowpass=f=3600,afade=t=in:st=0:d={min(.28, duration * .22):.3f},"
            f"afade=t=out:st={max(0.0, duration - min(.55, duration * .35)):.3f}:d={min(.55, duration * .35):.3f},"
            "volume=0.38,aformat=sample_rates=48000:channel_layouts=stereo",
        )
    # Deep cinematic hit / bass drop.
    return (
        f"sine=frequency=58:sample_rate=48000:duration={duration:.3f}",
        f"lowpass=f=180,afade=t=in:st=0:d={min(.08, duration * .08):.3f},"
        f"afade=t=out:st={max(0.0, duration - min(1.05, duration * .55)):.3f}:d={min(1.05, duration * .55):.3f},"
        "volume=0.52,aformat=sample_rates=48000:channel_layouts=stereo",
    )
