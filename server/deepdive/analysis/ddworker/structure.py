# -*- coding: utf-8 -*-
"""
Структура секций: самоподобие + новизна Фута → технические метки A/B/C.
"""

from __future__ import annotations

import math

from .common import HOP, _clamp, _librosa_version, _mod, _num, np, rms_envelope


def _foote_novelty(matrix: np.ndarray, window: int) -> np.ndarray:
    """Foote-подобная новизна по матрице самоподобия (диагональ → пики на стыках)."""
    n = matrix.shape[0]
    novelty = np.zeros(n, dtype=np.float64)
    if n < 4 * window:
        return novelty
    for t in range(window, n - window):
        far = matrix[t + window:t + 2 * window, t - window:t]
        near = matrix[t - window:t + window, t - window:t + window]
        novelty[t] = float(far.mean() - near.mean())
    if novelty.max() > novelty.min():
        novelty = (novelty - novelty.min()) / (novelty.max() - novelty.min())
    return novelty


def _section_centroids(feature: np.ndarray, boundaries_frames: np.ndarray) -> list:
    centroids = []
    for i in range(len(boundaries_frames) - 1):
        start, end = int(boundaries_frames[i]), int(boundaries_frames[i + 1])
        if end <= start:
            centroids.append(np.zeros(feature.shape[0]))
            continue
        centroids.append(feature[:, start:end].mean(axis=1))
    return centroids


def analyze_structure(y, sr: int) -> list:
    """Границы секций по самоподобию. Метки только A/B/C — без семантики."""
    librosa = _mod("librosa")
    scipy_signal = _mod("scipy.signal")

    duration = len(y) / float(sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=HOP)
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
    feature = np.vstack([
        np.nan_to_num(np.asarray(mfcc, dtype=np.float64)),
        np.nan_to_num(np.asarray(chroma, dtype=np.float64)),
    ])

    frames = feature.shape[1]
    stride = max(1, frames // 1200)
    reduced = feature[:, ::stride]
    reduced = reduced - reduced.mean(axis=1, keepdims=True)

    try:
        # Берём расстояния и сами переводим их в сходство: так гарантировано,
        # что больше = похоже (нужно для формулы новизны Фута).
        distance = librosa.feature.recurrence_matrix(
            reduced, mode="distance", sym=True, metric="cosine"
        )
        max_distance = float(np.max(distance))
        if not math.isfinite(max_distance) or max_distance <= 1e-12:
            raise ValueError("пустая матрица сходства")
        similarity = 1.0 - np.asarray(distance, dtype=np.float64) / max_distance
    except Exception:
        similarity = np.eye(reduced.shape[1])

    window = max(4, int(round(4.0 / (HOP * stride / sr))))
    novelty = _foote_novelty(similarity, window)

    frame_seconds = HOP * stride / sr
    min_gap_frames = max(1, int(round(8.0 / frame_seconds)))
    peak_indices, _properties = scipy_signal.find_peaks(
        novelty, distance=min_gap_frames, prominence=0.05
    )
    if len(peak_indices) > 24:
        order = np.argsort(novelty[peak_indices])[::-1][:24]
        peak_indices = np.sort(peak_indices[order])

    boundary_frames = [0]
    for index in peak_indices:
        boundary_frames.append(int(index))
    boundary_frames.append(reduced.shape[1])

    # Слишком короткие секции присоединяем к соседнему.
    kept = [boundary_frames[0]]
    for value in boundary_frames[1:-1]:
        if (value - kept[-1]) * frame_seconds >= 2.0:
            kept.append(value)
    if kept[-1] != boundary_frames[-1]:
        kept.append(boundary_frames[-1])
    if len(kept) < 2:
        kept = [0, reduced.shape[1]]

    times = [index * frame_seconds for index in kept]
    times[0] = 0.0
    times[-1] = duration

    rms, rms_times = rms_envelope(y, sr)
    rms_max = float(np.max(rms)) if len(rms) else 0.0

    centroids = _section_centroids(reduced, np.array(kept))
    labels: list = []
    groups: list = []
    group_counter = 0
    previous = None
    for centroid in centroids:
        same = False
        if previous is not None and len(centroid) == len(previous):
            norm_a = float(np.linalg.norm(centroid))
            norm_b = float(np.linalg.norm(previous))
            if norm_a > 1e-9 and norm_b > 1e-9:
                similarity_value = float(np.dot(centroid, previous) / (norm_a * norm_b))
                same = similarity_value >= 0.85
        if same and group_counter > 0:
            labels.append(labels[-1])
            groups.append(group_counter)
        else:
            group_counter += 1
            labels.append(chr(ord("A") + (len(labels) % 26)))
            groups.append(0)
        previous = centroid

    sections = []
    novelty_values = []
    for index in range(len(times) - 1):
        start_s = float(times[index])
        end_s = float(times[index + 1])
        if end_s - start_s < 0.5:
            continue
        mask = (rms_times >= start_s) & (rms_times < end_s)
        section_rms = float(np.mean(rms[mask])) if np.any(mask) else 0.0
        energy = _clamp(section_rms / rms_max) if rms_max > 1e-12 else 0.0

        start_frame = min(reduced.shape[1] - 1, int(start_s / frame_seconds)) if frame_seconds > 0 else 0
        novelty_value = float(novelty[start_frame]) if start_frame < len(novelty) else 0.0
        novelty_values.append(novelty_value)

        length_s = end_s - start_s
        length_plausible = _clamp(min(length_s, 30.0) / 30.0) * 0.5 + _clamp(min(length_s, 8.0) / 8.0) * 0.5
        confidence = _clamp(0.35 + 0.45 * novelty_value + 0.20 * length_plausible)

        sections.append({
            "index": len(sections),
            "start_s": _num(start_s, 3),
            "end_s": _num(end_s, 3),
            "label": labels[index],
            "energy": _num(energy, 3),
            "confidence": _num(confidence, 3),
            "novelty": _num(novelty_value, 3),
            "repeated_group": int(groups[index]),
        })

    method = (
        f"librosa.feature.recurrence_matrix (cosine) + новизна Фута "
        f"+ scipy.signal.find_peaks ({_librosa_version()})"
    )
    return sections, method
