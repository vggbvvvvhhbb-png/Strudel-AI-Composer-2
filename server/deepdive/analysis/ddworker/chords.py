# -*- coding: utf-8 -*-
"""
Аккорды-гипотезы по стему other (не по миксу: 808 забивает хромаграмму).
"""

from __future__ import annotations

from .common import (
    CHORD_QUALITIES,
    HOP,
    MIN_CHORD_CONFIDENCE,
    NOTE_NAMES,
    _librosa_version,
    _mod,
    _num,
    np,
)


def analyze_chords(y, sr: int, bass_notes: list):
    """Аккорды-гипотезы по хрома-профилю (не по миксу: 808 забивает хромаграмму)."""
    librosa = _mod("librosa")
    method = (
        f"librosa.feature.chroma_cqt ({_librosa_version()}) + шаблоны аккордов "
        f"(major/minor/7/m7/sus4/dim), косинус к хрома-профилю"
    )
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
        source = "chroma_cqt"
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
        source = "chroma_stft"

    chroma = np.nan_to_num(np.asarray(chroma, dtype=np.float64))
    if chroma.shape[1] == 0:
        return [], method

    # Нормируем каждый кадр так, чтобы сумма = 1 (иначе тишина «победит»).
    sums = chroma.sum(axis=0, keepdims=True)
    norm = np.divide(chroma, sums, out=np.zeros_like(chroma), where=sums > 1e-12)

    labels = []
    scores = []
    best_per_frame = []
    second_per_frame = []
    for frame in range(norm.shape[1]):
        vector = norm[:, frame]
        if float(vector.sum()) <= 1e-9:
            labels.append(-1)
            scores.append(0.0)
            best_per_frame.append(None)
            second_per_frame.append(None)
            continue
        ranked = []
        for quality, intervals in CHORD_QUALITIES.items():
            for root in range(12):
                template = np.zeros(12, dtype=np.float64)
                for interval in intervals:
                    template[(root + interval) % 12] = 1.0
                denominator = float(np.linalg.norm(template))
                if denominator <= 1e-12:
                    continue
                value = float(np.dot(vector, template) / denominator)
                ranked.append((value, root, quality))
        ranked.sort(reverse=True)
        top = ranked[0]
        labels.append(top[1] * 100 + list(CHORD_QUALITIES).index(top[2]))
        scores.append(top[0])
        best_per_frame.append(top)
        second_per_frame.append(ranked[1] if len(ranked) > 1 else None)

    # Стабилизация: медианный фильтр по меткам (5 кадров).
    try:
        scipy_ndimage = _mod("scipy.ndimage")
        filtered = scipy_ndimage.median_filter(np.asarray(labels, dtype=np.float64), size=5)
    except Exception:
        filtered = np.asarray(labels, dtype=np.float64)

    times = librosa.frames_to_time(np.arange(len(filtered)), sr=sr, hop_length=HOP)
    frame_seconds = HOP / float(sr)

    spans = []
    start_index = None
    current_label = None
    for index, label in enumerate(filtered):
        value = int(label)
        if current_label is None or value != current_label:
            if current_label is not None and start_index is not None:
                spans.append((start_index, index - 1, current_label))
            start_index = index
            current_label = value
    if current_label is not None and start_index is not None:
        spans.append((start_index, len(filtered) - 1, current_label))

    chords = []
    for start_frame, end_frame, label in spans:
        if label < 0:
            continue
        quality_index = label % 100
        root = label // 100
        quality = list(CHORD_QUALITIES)[quality_index]
        window_scores = scores[start_frame:end_frame + 1]
        if not len(window_scores):
            continue
        confidence = float(np.mean(window_scores))
        if confidence < MIN_CHORD_CONFIDENCE:
            continue
        start_s = float(times[start_frame])
        end_s = float(times[min(end_frame, len(times) - 1)])
        if end_s - start_s < frame_seconds:
            end_s = start_s + frame_seconds
        if end_s - start_s < 0.4:
            continue

        runner_up = None
        for index in range(start_frame, end_frame + 1):
            candidate = second_per_frame[index] if index < len(second_per_frame) else None
            if candidate is None:
                continue
            if candidate[1] == root and candidate[2] == quality:
                continue
            if runner_up is None or candidate[0] > runner_up[0]:
                runner_up = candidate
        evidence = [
            "chroma cosine %.2f vs %s %s" % (
                confidence,
                NOTE_NAMES[runner_up[1]] if runner_up else "?",
                runner_up[2] if runner_up else "?",
            ),
            f"хрома ({source}), стем other",
        ]

        bass_note = None
        overlapping = [
            note for note in bass_notes
            if note["time_s"] < end_s and (note["time_s"] + (note["duration_s"] or 0)) > start_s
        ]
        if overlapping:
            lowest = min(overlapping, key=lambda note: note["midi"])
            bass_note = lowest["note_name"]

        chords.append({
            "start_s": _num(start_s, 3),
            "end_s": _num(end_s, 3),
            "root": NOTE_NAMES[root],
            "quality": quality,
            "confidence": _num(confidence, 3),
            "evidence": evidence,
        })
        if bass_note:
            chords[-1]["bass_note"] = bass_note

    return chords, method
