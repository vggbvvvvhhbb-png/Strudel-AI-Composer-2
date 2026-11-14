# -*- coding: utf-8 -*-
"""
Тональность: хромаграмма трека + профили Крумхансля–Кесслера (Pearson r).
"""

from __future__ import annotations

from .common import (
    HOP,
    KRUMHANSL,
    NOTE_NAMES,
    _clamp,
    _librosa_version,
    _mod,
    _num,
    np,
)


def _pearson(a, b) -> float:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.std() < 1e-12 or b.std() < 1e-12:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def _chroma_mean(y, sr: int):
    """Средняя хромаграмма трека (12 полутонов, сумма = 1) + число кадров."""
    librosa = _mod("librosa")
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
        source = "chroma_cqt"
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
        source = "chroma_stft"
    chroma = np.nan_to_num(np.asarray(chroma, dtype=np.float64))
    mean = chroma.mean(axis=1) if chroma.shape[1] else np.zeros(12)
    total = float(mean.sum())
    if total <= 0:
        return np.zeros(12), source, 0
    return mean / total, source, int(chroma.shape[1])


def _key_scores(chroma_mean: np.ndarray):
    """Корреляция хрома с профилями Крумхансля для 24 тональностей."""
    scores = []
    for mode, profile in KRUMHANSL.items():
        base = np.asarray(profile, dtype=np.float64)
        for root in range(12):
            rotated = np.zeros(12, dtype=np.float64)
            for offset, value in enumerate(base):
                rotated[(root + offset) % 12] = value
            scores.append((root, mode, _pearson(chroma_mean, rotated)))
    scores.sort(key=lambda item: item[2], reverse=True)
    return scores


def _key_confidence(correlation: float, runner_up: float) -> float:
    absolute = _clamp(correlation)
    margin = _clamp((correlation - runner_up) / 0.15)
    return _clamp(0.5 * absolute + 0.5 * margin)


def analyze_key(y, sr: int) -> dict:
    method = (
        f"librosa.feature.chroma_cqt ({_librosa_version()}) + профили Крумхансля–Кесслера (Pearson r)"
    )
    try:
        chroma_mean, source, frames = _chroma_mean(y, sr)
    except Exception as exc:
        return {
            "tonic": None,
            "mode": "unknown",
            "confidence": 0.0,
            "alternatives": [],
            "method": method,
            "evidence": [f"хромаграмма не построилась: {type(exc).__name__}: {exc}"],
        }

    method = method.replace("chroma_cqt", source)
    if frames == 0 or float(chroma_mean.sum()) <= 0:
        return {
            "tonic": None,
            "mode": "unknown",
            "confidence": 0.0,
            "alternatives": [],
            "method": method,
            "evidence": ["хромаграмма пуста — тональность не определена"],
        }

    scores = _key_scores(chroma_mean)
    root, mode, best = scores[0]
    root2, mode2, second = scores[1]
    confidence = _key_confidence(best, second)

    tonic = NOTE_NAMES[root]
    alternatives = []

    # Релятивная: мажор ↔ минор на 3 полутона выше/ниже.
    if mode == "major":
        rel_root, rel_mode = (root + 9) % 12, "minor"
    else:
        rel_root, rel_mode = (root + 3) % 12, "major"
    rel_corr = _corr_for(scores, rel_root, rel_mode)
    alternatives.append({
        "tonic": NOTE_NAMES[rel_root],
        "mode": rel_mode,
        "relation": "relative",
        "confidence": _num(_key_confidence(rel_corr, best)),
    })

    # Параллельная: тот же тоник, другой лад.
    par_mode = "minor" if mode == "major" else "major"
    par_corr = _corr_for(scores, root, par_mode)
    alternatives.append({
        "tonic": tonic,
        "mode": par_mode,
        "relation": "parallel",
        "confidence": _num(_key_confidence(par_corr, best)),
    })

    # Доминантная (квинта выше) — базовая гипотеза гармонии.
    fifth_root = (root + 7) % 12
    fifth_corr = _corr_for(scores, fifth_root, mode)
    alternatives.append({
        "tonic": NOTE_NAMES[fifth_root],
        "mode": mode,
        "relation": "fifth",
        "confidence": _num(_key_confidence(fifth_corr, best)),
    })

    alternatives.sort(key=lambda item: item["confidence"], reverse=True)

    evidence = [
        f"хрома ({source}), кадров: {frames}",
        f"лучшая корреляция {best:.3f} — {tonic} {mode}; вторая {second:.3f} — {NOTE_NAMES[root2]} {mode2}",
        "профили: Крумхансль–Кесслер, 6 ладов × 12 тоник",
    ]

    return {
        "tonic": tonic,
        "mode": mode,
        "confidence": _num(confidence),
        "alternatives": alternatives,
        "method": method,
        "evidence": evidence,
    }


def _corr_for(scores, root: int, mode: str) -> float:
    for item_root, item_mode, value in scores:
        if item_root == root and item_mode == mode:
            return value
    return -1.0
