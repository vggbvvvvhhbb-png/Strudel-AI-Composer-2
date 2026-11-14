# -*- coding: utf-8 -*-
"""
Громкость: ffmpeg ebur128 (основной путь), librosa/numpy — только запасной.
"""

from __future__ import annotations

import math
import re
import subprocess

from .common import _num, np, rms_envelope


def _parse_ebur128(text: str) -> dict:
    """Разбор вывода ffmpeg ebur128: I (integrated), LRA, true peak, max M."""
    result = {"integrated": None, "range": None, "true_peak": None, "max_momentary": None}
    if not text:
        return result

    summary_at = text.rfind("Summary:")
    summary = text[summary_at:] if summary_at >= 0 else ""
    body = text if summary_at < 0 else text[:summary_at]

    momentary = [float(value) for value in re.findall(r"\bM:\s*(-?\d+(?:\.\d+)?)\s*LUFS", body)]
    if momentary:
        result["max_momentary"] = max(momentary)

    integrated = re.search(r"\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS", summary)
    if integrated:
        result["integrated"] = float(integrated.group(1))
    lra = re.search(r"\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU", summary)
    if lra:
        result["range"] = float(lra.group(1))
    peak = re.search(r"\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS", summary)
    if peak:
        result["true_peak"] = float(peak.group(1))
    return result


def analyze_loudness(path: str, y, sr: int) -> dict:
    """Громкость: ffmpeg ebur128 (основной путь), librosa — только запасной."""
    method = "ffmpeg ebur128 (peak=true)"
    reference = "ffmpeg ebur128"
    parsed = None
    fallback_reason = "ffmpeg недоступен или ebur128 не отработал"
    try:
        command = [
            "ffmpeg", "-nostats", "-hide_banner", "-i", path,
            "-filter_complex", "ebur128=peak=true", "-f", "null", "-",
        ]
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=900, check=False
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "ffmpeg вернул код %s: %s" % (
                    completed.returncode,
                    (completed.stderr or "")[-400:],
                )
            )
        parsed = _parse_ebur128(completed.stderr or "")
    except FileNotFoundError:
        parsed = None
        fallback_reason = "ffmpeg не найден в PATH"
    except Exception as exc:
        parsed = None
        fallback_reason = f"{type(exc).__name__}: {exc}"

    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    peak_dbfs = 20.0 * math.log10(peak) if peak > 1e-12 else None
    rms = rms_envelope(y, sr)[0]
    rms_mean = float(np.mean(rms)) if len(rms) else 0.0
    rms_db = 20.0 * math.log10(rms_mean) if rms_mean > 1e-12 else None
    crest = None
    if peak_dbfs is not None and rms_db is not None:
        crest = peak_dbfs - rms_db

    if parsed and parsed.get("integrated") is not None:
        return {
            "lufs_integrated": _num(parsed["integrated"], 2),
            "lufs_max": _num(parsed.get("max_momentary"), 2),
            "lufs_range": _num(parsed.get("range"), 2),
            "true_peak_dbtp": _num(parsed.get("true_peak"), 2),
            "peak_dbfs": _num(peak_dbfs, 2),
            "crest_db": _num(crest, 2),
            "method": method,
            "reference": reference,
        }

    # Запасной путь: честно отдаём только то, что реально измерили.
    return {
        "lufs_integrated": None,
        "lufs_max": None,
        "lufs_range": None,
        "true_peak_dbtp": None,
        "peak_dbfs": _num(peak_dbfs, 2),
        "crest_db": _num(crest, 2),
        "method": f"librosa.feature.rms + numpy peak (fallback): {fallback_reason}",
        "reference": "librosa rms (LUFS не измерены)",
    }
