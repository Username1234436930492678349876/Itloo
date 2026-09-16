from __future__ import annotations

import mimetypes
import subprocess
from pathlib import Path
from typing import Any, Callable

from .audio_utils import ffmpeg_exe, intro_sfx_source

ProgressCallback = Callable[[float, str | None], None]


def _is_image(path: Path, content_type: str | None = None) -> bool:
    kind = content_type or mimetypes.guess_type(path.name)[0] or ""
    return kind.startswith("image/") or path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _position_expr(position: str, margin: int = 28) -> tuple[str, str]:
    if position == "top-left":
        return str(margin), str(margin)
    if position == "top-right":
        return f"W-w-{margin}", str(margin)
    if position == "bottom-left":
        return str(margin), f"H-h-{margin}"
    if position == "center":
        return "(W-w)/2", "(H-h)/2"
    return f"W-w-{margin}", f"H-h-{margin}"


def _time_seconds(value: str) -> float:
    try:
        hours, minutes, seconds = value.split(":", 2)
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except Exception:
        return 0.0


def _render_main_video(
    audio_path: Path,
    background_paths: list[Path] | None = None,
    overlay_paths: list[Path] | None = None,
    metadata: dict[str, Any] | None = None,
    output_path: Path | None = None,
    background_content_types: list[str | None] | None = None,
    watermark_path: Path | None = None,
    watermark_content_type: str | None = None,
    shadow_overlay_path: Path | None = None,
    shadow_overlay_content_type: str | None = None,
    progress_callback: ProgressCallback | None = None,
    background_path: Path | None = None,
    background_content_type: str | None = None,
) -> None:
    """Render the final video with one or more background clips."""
    metadata = metadata or {}
    overlay_paths = overlay_paths or []
    if background_paths is None:
        background_paths = [background_path] if background_path is not None else []
    if background_content_types is None:
        background_content_types = [background_content_type] if background_content_type is not None or background_path is not None else []
    if output_path is None:
        raise ValueError("An output path is required.")
    width = int(metadata["width"])
    height = int(metadata["height"])
    duration = float(metadata["duration"])
    backgrounds_meta = list(metadata.get("backgrounds") or [])
    if not background_paths:
        raise ValueError("At least one background clip is required.")
    if not backgrounds_meta:
        backgrounds_meta = [{} for _ in background_paths]
    if len(backgrounds_meta) < len(background_paths):
        backgrounds_meta.extend({} for _ in range(len(background_paths) - len(backgrounds_meta)))
    backgrounds_meta = backgrounds_meta[: len(background_paths)]
    bg_content_types = list(background_content_types or [])
    if len(bg_content_types) < len(background_paths):
        bg_content_types.extend([None] * (len(background_paths) - len(bg_content_types)))
    wm = metadata.get("watermark") or {}
    shadow = metadata.get("shadowOverlay") or {}
    global_fade = metadata.get("globalFade") or {}
    retention = metadata.get("retention") or {}
    audio_start_offset = max(0.0, float(retention.get("startOffset", 0.0) or 0.0))

    command = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error"]
    for bg_path, content_type in zip(background_paths, bg_content_types):
        if _is_image(bg_path, content_type):
            command += ["-loop", "1", "-i", str(bg_path)]
        else:
            command += ["-stream_loop", "-1", "-i", str(bg_path)]
    audio_input = len(background_paths)
    command += ["-i", str(audio_path)]

    watermark_input = None
    watermark_is_image = False
    next_input = audio_input + 1
    if watermark_path is not None:
        watermark_input = next_input
        next_input += 1
        watermark_is_image = _is_image(watermark_path, watermark_content_type)
        if watermark_is_image:
            command += ["-i", str(watermark_path)]
        else:
            command += ["-stream_loop", "-1", "-i", str(watermark_path)]

    shadow_input = None
    if shadow_overlay_path is not None:
        shadow_input = next_input
        next_input += 1
        command += ["-i", str(shadow_overlay_path)]

    overlay_inputs: list[int] = []
    for overlay in overlay_paths:
        overlay_inputs.append(next_input)
        next_input += 1
        command += ["-i", str(overlay)]

    filters: list[str] = []
    bg_labels: list[str] = []
    total_bg_duration = 0.0
    for meta in backgrounds_meta:
        total_bg_duration += max(0.05, float(meta.get("duration", 0.0) or 0.0))
    if total_bg_duration <= 0:
        total_bg_duration = duration

    consumed = 0.0
    for index, (bg_path, content_type, meta) in enumerate(zip(background_paths, bg_content_types, backgrounds_meta)):
        fit = str(meta.get("fit", "contain"))
        raw_zoom = max(0.6, min(2.5, float(meta.get("zoom", 1.0))))
        zoom = min(raw_zoom, 1.0) if fit == "contain" else max(raw_zoom, 1.0)
        offset_x = max(-1.0, min(1.0, float(meta.get("offsetX", 0.0))))
        offset_y = max(-1.0, min(1.0, float(meta.get("offsetY", 0.0))))
        brightness = max(0.5, min(1.8, float(meta.get("brightness", 1.0))))
        saturation = max(0.0, min(1.8, float(meta.get("saturation", 1.0))))
        blur = max(0.0, min(20.0, float(meta.get("blur", 0.0))))
        darkness = max(0.0, min(0.85, float(meta.get("darkness", 0.0))))
        auto_dim = bool(meta.get("autoDim", False))
        auto_dim_strength = max(0.0, min(1.0, float(meta.get("autoDimStrength", 0.0))))
        if auto_dim:
            darkness = max(0.0, min(0.9, darkness + max(0.0, brightness - 1.0) * 0.25 * auto_dim_strength))
        clip_duration = max(0.05, float(meta.get("duration", 0.0) or 0.0))
        if clip_duration <= 0.05 and index == len(background_paths) - 1:
            clip_duration = max(0.05, duration - consumed)
        if index == len(background_paths) - 1:
            clip_duration = max(0.05, duration - consumed)
        consumed += clip_duration
        fade_in = max(0.0, min(3.0, float(meta.get("fadeIn", 0.0))))
        fade_out = max(0.0, min(3.0, float(meta.get("fadeOut", 0.0))))
        motion = bool(meta.get("motion", False))

        eq_filter = f",eq=brightness={(brightness - 1.0) / 2.0:.4f}:saturation={saturation:.4f}"
        blur_filter = f",boxblur={blur:.2f}:1" if blur > 0.1 else ""
        target_w = max(2, round(width * zoom))
        target_h = max(2, round(height * zoom))
        if fit != "contain":
            target_w = max(width, target_w)
            target_h = max(height, target_h)
        pos_x = max(0.0, min(1.0, 0.5 + offset_x / 2.0))
        pos_y = max(0.0, min(1.0, 0.5 + offset_y / 2.0))
        if fit == "contain":
            common_bg = (
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease"
                f"{eq_filter}{blur_filter},pad={width}:{height}:"
                f"x=(ow-iw)*{pos_x:.4f}:y=(oh-ih)*{pos_y:.4f},format=yuv420p,"
                f"drawbox=x=0:y=0:w=iw:h=ih:color=black@{darkness:.4f}:t=fill,setsar=1"
            )
        else:
            common_bg = (
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase"
                f"{eq_filter}{blur_filter},crop={width}:{height}:"
                f"x=(in_w-out_w)*{pos_x:.4f}:y=(in_h-out_h)*{pos_y:.4f},format=yuv420p,"
                f"drawbox=x=0:y=0:w=iw:h=ih:color=black@{darkness:.4f}:t=fill,setsar=1"
            )
        fade_filters = []
        if fade_in > 0.001:
            fade_filters.append(f"fade=t=in:st=0:d={min(fade_in, max(0.0, clip_duration - 0.01)):.3f}")
        if fade_out > 0.001 and clip_duration > 0.06:
            start_out = max(0.0, clip_duration - fade_out)
            fade_filters.append(f"fade=t=out:st={start_out:.3f}:d={min(fade_out, clip_duration):.3f}")
        motion_filter = (
            f",zoompan=z='min(zoom+0.00010,1.055)':x='iw/2-(iw/zoom/2)':"
            f"y='ih/2-(ih/zoom/2)':d=1:s={width}x{height}:fps=30"
            if motion else ""
        )
        fade_suffix = ("," + ",".join(fade_filters)) if fade_filters else ""
        label = f"bg{index}"
        filters.append(
            f"[{index}:v]fps=30,trim=duration={clip_duration:.4f},{common_bg}{motion_filter}{fade_suffix},setpts=PTS-STARTPTS[{label}]"
        )
        bg_labels.append(f"[{label}]")

    if len(bg_labels) == 1:
        current = bg_labels[0][1:-1]
    else:
        filters.append(f"{''.join(bg_labels)}concat=n={len(bg_labels)}:v=1:a=0[base]")
        current = "base"

    if shadow_input is not None and shadow.get("enabled", True):
        size = max(0.2, min(2.2, float(shadow.get("size", 1.0))))
        opacity = max(0.0, min(1.0, float(shadow.get("opacity", 1.0))))
        center_x = max(-0.25, min(1.25, float(shadow.get("x", 0.5))))
        center_y = max(-0.25, min(1.25, float(shadow.get("y", 0.76))))
        shadow_width = max(20, round(width * size))
        filters.append(
            f"[{shadow_input}:v]scale={shadow_width}:-1,format=rgba,"
            f"colorchannelmixer=aa={opacity:.4f}[shadow]"
        )
        filters.append(
            f"[{current}][shadow]overlay=x=W*{center_x:.4f}-w/2:y=H*{center_y:.4f}-h/2:"
            f"eof_action=repeat:repeatlast=1:shortest=0[vshadow]"
        )
        current = "vshadow"

    if watermark_input is not None and wm.get("enabled", True):
        size = max(0.04, min(0.7, float(wm.get("size", 0.20))))
        opacity = max(0.05, min(1.0, float(wm.get("opacity", 0.65))))
        offset_x = max(-1.0, min(1.0, float(wm.get("offsetX", 0.0))))
        offset_y = max(-1.0, min(1.0, float(wm.get("offsetY", 0.0))))
        remove_black = bool(wm.get("removeBlack", False))
        wm_width = max(40, round(width * size))
        wm_fps = "fps=30," if not watermark_is_image else ""
        black_filter = "colorkey=0x000000:0.18:0.08," if remove_black else ""
        filters.append(
            f"[{watermark_input}:v]{wm_fps}scale={wm_width}:-1,format=rgba,"
            f"{black_filter}colorchannelmixer=aa={opacity:.4f}[wm]"
        )
        base_x, base_y = _position_expr(str(wm.get("position", "bottom-right")), max(18, round(width * 0.026)))
        x = f"({base_x})+((W-w)/2)*{offset_x:.4f}"
        y = f"({base_y})+((H-h)/2)*{offset_y:.4f}"
        filters.append(
            f"[{current}][wm]overlay=x={x}:y={y}:eof_action=repeat:repeatlast=1:shortest=0[vwm]"
        )
        current = "vwm"

    timings = metadata.get("overlays") or []
    if len(timings) != len(overlay_inputs):
        raise ValueError("Overlay timing metadata does not match uploaded phrase images.")
    for index, (input_index, timing) in enumerate(zip(overlay_inputs, timings)):
        start = max(0.0, float(timing["start"]))
        end = min(duration, max(start + 0.02, float(timing["end"])))
        filters.append(f"[{input_index}:v]format=rgba[ov{index}]")
        out = f"v{index}"
        filters.append(
            f"[{current}][ov{index}]overlay=x=(W-w)/2:y=(H-h)/2:"
            f"enable='between(t,{start:.4f},{end:.4f})':"
            f"eof_action=repeat:repeatlast=1:shortest=0[{out}]"
        )
        current = out

    clip_fade_in = max(0.0, min(5.0, float(global_fade.get("fadeIn", 0.0))))
    clip_fade_out = max(0.0, min(5.0, float(global_fade.get("fadeOut", 0.0))))
    if clip_fade_in > 0.001 or (clip_fade_out > 0.001 and duration > 0.06):
        vf = []
        if clip_fade_in > 0.001:
            vf.append(f"fade=t=in:st=0:d={min(clip_fade_in, max(0.0, duration - 0.01)):.3f}")
        if clip_fade_out > 0.001 and duration > 0.06:
            vf.append(f"fade=t=out:st={max(0.0, duration - clip_fade_out):.3f}:d={min(clip_fade_out, duration):.3f}")
        filters.append(f"[{current}]{','.join(vf)}[vfinal]")
        current = 'vfinal'

    filters.append(f"[{current}]setsar=1[vout_sar]")
    current = "vout_sar"

    max_dimension = max(width, height)
    default_preset = "superfast" if max_dimension <= 1280 else "veryfast"
    default_crf = 21 if max_dimension <= 1280 else 20
    preset = str(metadata.get("preset") or default_preset)
    crf = int(metadata.get("crf") or default_crf)

    audio_map = f"{audio_input}:a:0"
    if audio_start_offset > 0.001 or clip_fade_in > 0.001 or (clip_fade_out > 0.001 and duration > 0.06):
        af = [f"atrim=start={audio_start_offset:.4f}:duration={duration:.4f}", "asetpts=PTS-STARTPTS"]
        if clip_fade_in > 0.001:
            af.append(f"afade=t=in:st=0:d={min(clip_fade_in, max(0.0, duration - 0.01)):.3f}")
        if clip_fade_out > 0.001 and duration > 0.06:
            af.append(f"afade=t=out:st={max(0.0, duration - clip_fade_out):.3f}:d={min(clip_fade_out, duration):.3f}")
        filters.append(f"[{audio_input}:a]{','.join(af)}[afinal]")
        audio_map = "[afinal]"

    command += [
        "-filter_complex", ";".join(filters),
        "-map", f"[{current}]", "-map", audio_map,
        "-t", f"{duration:.4f}", "-r", "30",
        "-threads", "0",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        str(output_path),
    ]


    if progress_callback:
        progress_callback(0.0, None)

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    speed: str | None = None
    last_fraction = 0.0
    assert process.stdout is not None
    for raw in process.stdout:
        line = raw.strip()
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key == "speed":
            speed = value.strip()
        elif key == "out_time":
            seconds = _time_seconds(value)
            fraction = max(last_fraction, min(0.995, seconds / max(duration, 0.001)))
            if fraction - last_fraction >= 0.002 or fraction >= 0.99:
                last_fraction = fraction
                if progress_callback:
                    progress_callback(fraction, speed)
        elif key == "progress" and value == "end":
            if progress_callback:
                progress_callback(1.0, speed)

    stderr = process.stderr.read() if process.stderr is not None else ""
    returncode = process.wait()
    if returncode != 0:
        raise RuntimeError(stderr.strip() or "FFmpeg failed while rendering the video.")



def _run_checked(command: list[str], message: str) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or message)


def _render_intro_clip(
    title_path: Path,
    output_path: Path,
    *,
    width: int,
    height: int,
    duration: float,
    sound: str,
    preset: str,
    crf: int,
) -> None:
    """Render the kinetic black title-card intro as its own H.264/AAC clip."""
    duration = max(1.0, min(5.0, float(duration)))
    reveal = min(0.72, duration * 0.32)
    title_fade_in = min(0.34, duration * 0.18)
    title_fade_out = min(0.42, duration * 0.22)
    title_fade_out_start = max(title_fade_in + 0.05, duration - title_fade_out)
    sfx_source, sfx_filter = intro_sfx_source(sound, duration)

    # The title PNG is created in the browser so Arabic shaping/font rendering
    # exactly matches the user's preview. FFmpeg only handles motion/compositing.
    title_motion = (
        "format=rgba,"
        f"scale=w='iw*(0.88+0.12*min(t/{reveal:.4f},1))':"
        f"h='ih*(0.88+0.12*min(t/{reveal:.4f},1))':eval=frame,"
        f"fade=t=in:st=0.08:d={title_fade_in:.4f}:alpha=1,"
        f"fade=t=out:st={title_fade_out_start:.4f}:d={title_fade_out:.4f}:alpha=1"
    )
    slide_expr = f"(H-h)/2+30*(1-min(t/{reveal:.4f},1))"
    filter_complex = (
        f"[1:v]{title_motion}[title];"
        f"[0:v][title]overlay=x=(W-w)/2:y='{slide_expr}':shortest=1,"
        f"fade=t=out:st={max(0.0, duration - 0.16):.4f}:d={min(0.16, duration):.4f}[v];"
        f"[2:a]{sfx_filter}[a]"
    )
    command = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=30:d={duration:.4f}",
        "-loop", "1", "-framerate", "30", "-i", str(title_path),
        "-f", "lavfi", "-i", sfx_source,
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "[a]",
        "-t", f"{duration:.4f}", "-r", "30",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        str(output_path),
    ]
    _run_checked(command, "FFmpeg failed while rendering the intro title card.")


def _concat_intro_and_main(intro_path: Path, main_path: Path, output_path: Path) -> None:
    """Fast stream-copy concat, with a re-encode fallback for unusual FFmpeg builds."""
    concat_file = output_path.with_name(output_path.stem + "-concat.txt")
    def esc(path: Path) -> str:
        return str(path.resolve()).replace("'", "'\\''")
    concat_file.write_text(
        f"file '{esc(intro_path)}'\nfile '{esc(main_path)}'\n",
        encoding="utf-8",
    )
    command = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-c", "copy", "-movflags", "+faststart", str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode == 0:
        return

    # Fallback normalizes both segments and re-encodes once if stream-copy concat
    # is rejected because of codec metadata/time-base differences.
    command = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(intro_path), "-i", str(main_path),
        "-filter_complex",
        "[0:v]fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v0];[1:v]fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v1];"
        "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];"
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];"
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
        "-map", "[v]", "-map", "[a]", "-r", "30",
        "-c:v", "libx264", "-preset", "superfast", "-crf", "21", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", str(output_path),
    ]
    _run_checked(command, "FFmpeg failed while concatenating the intro and recitation.")


def render_video(
    audio_path: Path,
    background_paths: list[Path] | None = None,
    overlay_paths: list[Path] | None = None,
    metadata: dict[str, Any] | None = None,
    output_path: Path | None = None,
    background_content_types: list[str | None] | None = None,
    watermark_path: Path | None = None,
    watermark_content_type: str | None = None,
    shadow_overlay_path: Path | None = None,
    shadow_overlay_content_type: str | None = None,
    progress_callback: ProgressCallback | None = None,
    background_path: Path | None = None,
    background_content_type: str | None = None,
    intro_title_path: Path | None = None,
    intro_title_content_type: str | None = None,
) -> None:
    """Render the recitation and optionally prepend an Engagement Title Card Intro.

    Crucially, word/ayah timings remain in recitation time. The intro is rendered
    as a separate segment and concatenated afterward, so enabling it can never
    disturb the existing word-sync engine.
    """
    metadata = metadata or {}
    if output_path is None:
        raise ValueError("An output path is required.")
    intro = metadata.get("intro") or {}
    intro_enabled = bool(intro.get("enabled", False))
    if not intro_enabled:
        return _render_main_video(
            audio_path=audio_path,
            background_paths=background_paths,
            overlay_paths=overlay_paths,
            metadata=metadata,
            output_path=output_path,
            background_content_types=background_content_types,
            watermark_path=watermark_path,
            watermark_content_type=watermark_content_type,
            shadow_overlay_path=shadow_overlay_path,
            shadow_overlay_content_type=shadow_overlay_content_type,
            progress_callback=progress_callback,
            background_path=background_path,
            background_content_type=background_content_type,
        )

    if intro_title_path is None:
        raise ValueError("Intro is enabled but the rendered intro title layer is missing.")

    width = int(metadata["width"])
    height = int(metadata["height"])
    intro_duration = max(1.0, min(5.0, float(intro.get("duration", 2.6))))
    sound = str(intro.get("sound", "deep"))
    max_dimension = max(width, height)
    preset = str(metadata.get("preset") or ("superfast" if max_dimension <= 1280 else "veryfast"))
    crf = int(metadata.get("crf") or (21 if max_dimension <= 1280 else 20))

    main_path = output_path.with_name(output_path.stem + "-main.mp4")
    intro_path = output_path.with_name(output_path.stem + "-intro.mp4")

    def main_progress(fraction: float, speed: str | None) -> None:
        if progress_callback:
            progress_callback(min(0.86, max(0.0, fraction) * 0.86), speed)

    main_metadata = dict(metadata)
    # With an intro, the final video already begins on black. Do not fade the
    # recitation in a second time at the splice point; keep only the requested
    # end fade on the recitation segment.
    global_fade = dict(metadata.get("globalFade") or {})
    main_metadata["globalFade"] = {"fadeIn": 0.0, "fadeOut": float(global_fade.get("fadeOut", 0.0) or 0.0)}

    _render_main_video(
        audio_path=audio_path,
        background_paths=background_paths,
        overlay_paths=overlay_paths,
        metadata=main_metadata,
        output_path=main_path,
        background_content_types=background_content_types,
        watermark_path=watermark_path,
        watermark_content_type=watermark_content_type,
        shadow_overlay_path=shadow_overlay_path,
        shadow_overlay_content_type=shadow_overlay_content_type,
        progress_callback=main_progress,
        background_path=background_path,
        background_content_type=background_content_type,
    )
    if progress_callback:
        progress_callback(0.88, None)
    _render_intro_clip(
        intro_title_path,
        intro_path,
        width=width,
        height=height,
        duration=intro_duration,
        sound=sound,
        preset=preset,
        crf=crf,
    )
    if progress_callback:
        progress_callback(0.97, None)
    _concat_intro_and_main(intro_path, main_path, output_path)
    if progress_callback:
        progress_callback(1.0, None)
