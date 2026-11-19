#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Проба качества лестницы деградации Demucs (P0.5 / P0.8).

ЗАЧЕМ. В журнале проекта было «качество лестницы деградации — нет данных»:
ступени лестницы реализованы (server/deepdive/analysis/ddworker/memory.py:
degradation_ladder), но ни одна из них не была прогнана на настоящем Demucs
с настоящим звуком. Поэтому нельзя было ответить на вопрос владельца:
«а что мы теряем, когда памяти не хватает и мы переходим на экономный
режим?».

ЧТО МЕРИТ ЭТА ПРОБА. Для каждой ступени лестницы — на одном и том же входе,
на одной и той же железе:
  * wall-clock времени ступени;
  * пик свободного commit (функция available_memory из ddworker.memory — та
    же, что в воркере) и пик занятой VRAM (nvidia-smi, если есть);
  * КАЧЕСТВО стемов.

ТРИ ЯКОРЯ КАЧЕСТВА (все честные, ни один не притворяется):
  1. SDR ПО ИСТИНЕ. Проба умеет синтезировать микс из известных
     компонентов (ударные / бас / мелодия+пэды) и знает каждый истинный
     стем. Тогда для каждого оценённого стема считается SDR в смысле
     BSS Eval: оценка проецируется на пространство истинных источников,
     SDR = 10·log10(||проекция||² / ||остаток||²). Это АБСОЛЮТНАЯ мера:
     «сколько сэмплов верно попало в стем».
  2. ОШИБКА ВОССТАНОВЛЕНИЯ МИКСА. Сумма стемов Demucs должна
     восстанавливать исходный микс; ||sum(stems) − mix|| / ||mix|| в дБ.
     Опора на истину (микс известен) и не зависит от baseline.
  3. ПОТЕРЯ ОТНОСИТЕЛЬНО BASELINE. Первая ступень (полный режим) — лучший
     доступный результат на этой железе; корреляция и SI-SDR к ней
     показывают, сколько ступень стоит. Это «потеря относительно полного
     режима», а НЕ «насколько хорошо»: истины у реального трека нет.

ЧТО ПРОБА НЕ ДЕЛАЕТ. Не вызывает настоящий OOM: для этого есть runbook
(docs/RUNBOOK-demucs-windows.md) и живой замер владельца.

ЗАПУСК (нужен Python с torch и demucs — окружение владельца F:\\strudel-env):
    F:\\strudel-env\\Scripts\\python.exe scripts\\probe-demucs-ladder.py \\
        --synth --out docs/evidence/deepdive/ladder-quality.json

Новые зависимости не добавляются: WAV пишется и читается стандартной
библиотекой (wave), numpy берётся из окружения Demucs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS_DIR = ROOT / "server" / "deepdive" / "analysis"
if str(ANALYSIS_DIR) not in sys.path:
    sys.path.insert(0, str(ANALYSIS_DIR))

from ddworker.memory import allocator_env, available_memory, degradation_ladder  # noqa: E402

STEM_NAMES = ("drums", "bass", "vocals", "other")


# --------------------------------------------------------------------------- #
# WAV: чтение и запись без новых зависимостей
# --------------------------------------------------------------------------- #
def write_wav(path: Path, signal: np.ndarray, rate: int) -> None:
    """Пишет моно WAV 16 бит PCM. Без новых зависимостей."""
    clipped = np.clip(signal, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())


def read_wav_mono(path: Path) -> tuple[np.ndarray, int]:
    """Читает WAV в моно float32. Стандартная библиотека + numpy.

    Порядок: wave (stdlib) → soundfile → torchaudio. Если ни один не
    справился — исключение, а не «нули»: «нет данных» ≠ 0.
    """
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            frames = handle.readframes(handle.getnframes())
            rate = handle.getframerate()
        if width == 2:
            data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
        elif width == 4:
            data = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
        elif width == 1:
            data = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif width == 3:
            raw = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            value = (raw[:, 0] | (raw[:, 1] << 8) | (raw[:, 2] << 16))
            value = np.where(value & 0x800000, value - 0x1000000, value)
            data = value.astype(np.float32) / 8388608.0
        else:
            raise ValueError(f"неподдерживаемая глубина WAV: {width} байт")
        data = data.reshape(-1, channels)
        return data.mean(axis=1), rate
    except (wave.Error, EOFError):
        pass

    try:  # soundfile ставится вместе с demucs
        import soundfile as sf

        data, rate = sf.read(str(path), always_2d=True)
        return data.mean(axis=1).astype(np.float32), rate
    except Exception:  # noqa: BLE001
        pass

    try:  # torchaudio ставится вместе с torch
        import torchaudio

        data, rate = torchaudio.load(str(path))
        return data.mean(dim=0).numpy().astype(np.float32), int(rate)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"не удалось прочитать WAV {path}: {exc}") from exc


# --------------------------------------------------------------------------- #
# Синтез тестового микса с ИСТИННЫМИ стемами
# --------------------------------------------------------------------------- #
def _add_at(buffer: np.ndarray, signal: np.ndarray, start: int) -> None:
    end = min(buffer.size, start + signal.size)
    if end > start:
        buffer[start:end] += signal[: end - start]


def _kick(sr: int) -> np.ndarray:
    """Кик: синус с падающей высотой 120→48 Гц плюс щелчок."""
    duration = 0.32
    t = np.arange(int(duration * sr)) / sr
    frequency = 48.0 + 90.0 * np.exp(-t / 0.025)
    phase = 2.0 * math.pi * np.cumsum(frequency) / sr
    body = np.sin(phase) * np.exp(-t / 0.11)
    click = (np.random.default_rng(7).standard_normal(t.size) * np.exp(-t / 0.004)) * 0.12
    return (body * 0.85 + click).astype(np.float32)


def _snare(sr: int) -> np.ndarray:
    """Малый барабан: шум + тон 185 Гц."""
    duration = 0.22
    t = np.arange(int(duration * sr)) / sr
    noise = np.random.default_rng(11).standard_normal(t.size) * np.exp(-t / 0.045)
    tone = np.sin(2.0 * math.pi * 185.0 * t) * np.exp(-t / 0.06) * 0.4
    return (noise * 0.5 + tone).astype(np.float32)


def _hat(sr: int) -> np.ndarray:
    """Хэт: короткий шумовой всплеск."""
    duration = 0.06
    t = np.arange(int(duration * sr)) / sr
    noise = np.random.default_rng(13).standard_normal(t.size) * np.exp(-t / 0.012)
    return (noise * 0.28).astype(np.float32)


def _sawish(frequency: float, duration: float, sr: int, harmonics: int = 8) -> np.ndarray:
    """Пилообразный сигнал из гармоник (без внешних зависимостей)."""
    t = np.arange(int(duration * sr)) / sr
    signal = np.zeros_like(t)
    for index in range(1, harmonics + 1):
        signal += np.sin(2.0 * math.pi * frequency * index * t) / index
    return (signal * (2.0 / math.pi)).astype(np.float32)


def _squareish(frequency: float, duration: float, sr: int) -> np.ndarray:
    """Меандр из нечётных гармоник."""
    t = np.arange(int(duration * sr)) / sr
    signal = np.zeros_like(t)
    for index in range(1, 8, 2):
        signal += np.sin(2.0 * math.pi * frequency * index * t) / index
    return (signal * (4.0 / math.pi)).astype(np.float32)


def synth_mix(seconds: float = 60.0, sr: int = 44100) -> tuple[np.ndarray, dict]:
    """Собирает микс в стиле EDM 4/4 и возвращает его с истинными стемами.

    Истинные стемы: drums (кик+снейр+хэты), bass, other (лид+пэд).
    Вокала нет — для оценки стема «vocals» истины не существует, и это
    будет записано как «нет данных», а не как ноль.
    """
    total = int(seconds * sr)
    drums = np.zeros(total, dtype=np.float32)
    bass = np.zeros(total, dtype=np.float32)
    other = np.zeros(total, dtype=np.float32)

    bpm = 128.0
    beat = 60.0 / bpm
    step = beat / 2.0  # восьмая

    kick = _kick(sr)
    snare = _snare(sr)
    hat = _hat(sr)

    # Кик — каждую долю; снейр — на 2 и 4; хэт — восьмыми.
    beat_index = 0
    for position in np.arange(0.0, seconds - 0.4, step):
        start = int(position * sr)
        if beat_index % 2 == 0:
            _add_at(drums, kick, start)
        if beat_index % 4 == 2:
            _add_at(drums, snare, start)
        _add_at(drums, hat, start)
        if beat_index % 4 == 1:
            _add_at(drums, hat, start + int(step * sr * 0.5))
        beat_index += 1

    # Бас: восьмыми по кругу C–G–A–F (октава C2 ≈ 65.4 Гц).
    bass_notes = [65.41, 65.41, 49.0, 55.0]
    for index, position in enumerate(np.arange(0.0, seconds - 0.4, step)):
        frequency = bass_notes[index % len(bass_notes)]
        note = _sawish(frequency, step * 0.9, sr) * 0.30
        envelope = np.exp(-np.arange(note.size) / (sr * 0.18))
        _add_at(bass, (note * envelope).astype(np.float32), int(position * sr))

    # Лид: мелодия квадратной волной по минорной пентатонике.
    lead_notes = [261.63, 311.13, 392.0, 466.16, 392.0, 311.13, 261.63, 233.08]
    for index, position in enumerate(np.arange(0.0, seconds - 0.4, beat)):
        frequency = lead_notes[index % len(lead_notes)]
        note = _squareish(frequency, beat * 0.85, sr) * 0.16
        envelope = np.exp(-np.arange(note.size) / (sr * 0.30))
        _add_at(other, (note * envelope).astype(np.float32), int(position * sr))

    # Пэд: мягкие тремолирующие треугольники на аккорде.
    for position in np.arange(0.0, seconds - 0.4, beat * 2):
        for frequency in (130.81, 155.56, 196.0):
            t = np.arange(int(beat * 2 * sr)) / sr
            pad = np.sin(2.0 * math.pi * frequency * t) * 0.05
            pad *= 1.0 + 0.08 * np.sin(2.0 * math.pi * 5.0 * t)
            _add_at(other, pad.astype(np.float32), int(position * sr))

    mix = drums + bass + other
    peak = float(np.max(np.abs(mix)))
    if peak > 0.95:
        mix = mix * (0.95 / peak)
        drums = drums * (0.95 / peak)
        bass = bass * (0.95 / peak)
        other = other * (0.95 / peak)

    return mix.astype(np.float32), {"drums": drums, "bass": bass, "other": other}


# --------------------------------------------------------------------------- #
# Метрики качества
# --------------------------------------------------------------------------- #
def correlation(a: np.ndarray, b: np.ndarray) -> float | None:
    """Пирсонова корреляция. None, если сигнал вырожден (постоянный)."""
    if a.size == 0 or b.size == 0:
        return None
    a_centered = a - a.mean()
    b_centered = b - b.mean()
    denominator = float(np.linalg.norm(a_centered) * np.linalg.norm(b_centered))
    if denominator < 1e-12:
        return None
    return float(np.dot(a_centered, b_centered) / denominator)


def si_sdr_db(reference: np.ndarray, estimate: np.ndarray) -> float | None:
    """SI-SDR в дБ: насколько estimate похож на reference с точностью до gain."""
    n = min(reference.size, estimate.size)
    if n == 0:
        return None
    reference = reference[:n].astype(np.float64)
    estimate = estimate[:n].astype(np.float64)
    energy = float(np.dot(estimate, estimate))
    if energy < 1e-20:
        return None
    alpha = float(np.dot(reference, estimate) / energy)
    projection = alpha * estimate
    error = reference - projection
    signal_energy = float(np.dot(projection, projection))
    error_energy = float(np.dot(error, error))
    if error_energy < 1e-20:
        return float("inf") if signal_energy > 0 else None
    return float(10.0 * np.log10(signal_energy / error_energy))


def relative_error_db(reference: np.ndarray, estimate: np.ndarray) -> float | None:
    """Ошибка восстановления в дБ относительно сигнала reference."""
    n = min(reference.size, estimate.size)
    if n == 0:
        return None
    reference = reference[:n].astype(np.float64)
    estimate = estimate[:n].astype(np.float64)
    denominator = float(np.dot(reference, reference))
    if denominator < 1e-20:
        return None
    error = estimate - reference
    return float(10.0 * np.log10(float(np.dot(error, error)) / denominator))


def sdr_db(estimate: np.ndarray, references: dict) -> float | None:
    """SDR в смысле BSS Eval: оценка проецируется на истинные источники.

    references — словарь «имя истинного стема → сигнал». Проекция
    считается наименьшими квадратами по всем истинным стемам сразу, то
    же самое, что делает BSS Eval v4 для одного оценённого источника.
    """
    if not references:
        return None
    n = min(estimate.size, min(value.size for value in references.values()))
    if n == 0:
        return None
    estimate = estimate[:n].astype(np.float64)
    matrix = np.column_stack([value[:n].astype(np.float64) for value in references.values()])
    coefficients, *_ = np.linalg.lstsq(matrix, estimate, rcond=None)
    projection = matrix @ coefficients
    residual = estimate - projection
    signal_energy = float(np.dot(projection, projection))
    residual_energy = float(np.dot(residual, residual))
    if residual_energy < 1e-20:
        return float("inf") if signal_energy > 0 else None
    return float(10.0 * math.log10(signal_energy / residual_energy))


# --------------------------------------------------------------------------- #
# Мониторинг памяти во время прогона
# --------------------------------------------------------------------------- #
class ResourceMonitor:
    """Снимает минимум свободного commit и максимум занятой VRAM."""

    def __init__(self, interval: float = 0.4) -> None:
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.min_available_commit_mb: int | None = None
        self.max_vram_mb: int | None = None
        self.samples = 0

    def _poll(self) -> None:
        while not self._stop.is_set():
            measured = available_memory()
            commit = measured.get("available_commit_mb")
            if isinstance(commit, (int, float)):
                if self.min_available_commit_mb is None or commit < self.min_available_commit_mb:
                    self.min_available_commit_mb = int(commit)
            self.samples += 1
            self._poll_vram()
            self._stop.wait(self.interval)

    def _poll_vram(self) -> None:
        executable = shutil.which("nvidia-smi")
        if not executable:
            return
        try:
            result = subprocess.run(
                [executable, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
            )
        except (subprocess.TimeoutExpired, OSError):
            return
        for line in (result.stdout or "").splitlines():
            value = line.strip()
            if value.isdigit():
                used = int(value)
                if self.max_vram_mb is None or used > self.max_vram_mb:
                    self.max_vram_mb = used

    def __enter__(self) -> "ResourceMonitor":
        self._thread = threading.Thread(target=self._poll, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)


# --------------------------------------------------------------------------- #
# Прогон ступени
# --------------------------------------------------------------------------- #
def collect_stems(out_dir: Path) -> dict:
    """Ищет свежие файлы стемов — так же, как это делает воркер."""
    found: dict = {}
    for stem in STEM_NAMES:
        matches = sorted(
            out_dir.rglob(f"{stem}.wav"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        if matches:
            found[stem] = matches[0]
    return found


def run_step(step: dict, wav_path: Path, work_dir: Path, timeout: float) -> dict:
    """Прогоняет одну ступень лестницы и возвращает числа."""
    out_dir = work_dir / step["step"]
    out_dir.mkdir(parents=True, exist_ok=True)
    env = allocator_env({**os.environ, **step.get("env", {}), "PYTHONIOENCODING": "utf-8"})
    command = [sys.executable, "-m", "demucs", *step["args"], "-o", str(out_dir), str(wav_path)]

    started = time.time()
    with ResourceMonitor() as monitor:
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=timeout,
            )
            returncode = completed.returncode
            stderr = completed.stderr or ""
            stdout = completed.stdout or ""
        except subprocess.TimeoutExpired as exc:
            returncode = -1
            stderr = f"таймаут {timeout} с: {exc}"
            stdout = ""
    elapsed = time.time() - started

    (out_dir / "demucs.stderr.log").write_text(stderr, encoding="utf-8")
    stems = collect_stems(out_dir) if returncode == 0 else {}
    return {
        "step": step["step"],
        "args": list(step["args"]),
        "env": dict(step.get("env", {})),
        "degraded": bool(step.get("degraded")),
        "ok": returncode == 0 and bool(stems),
        "returncode": returncode,
        "seconds": round(elapsed, 2),
        "min_available_commit_mb": monitor.min_available_commit_mb,
        "max_vram_mb": monitor.max_vram_mb,
        "monitor_samples": monitor.samples,
        "stems": {name: str(path) for name, path in stems.items()},
        "stderr_tail": stderr[-800:],
        "stdout_tail": stdout[-400:],
    }


def analyse_quality(
    step_result: dict,
    baseline_stems: dict,
    mix: np.ndarray,
    truth: dict | None,
) -> dict:
    """Считает качество ступени: SDR по истине, ошибку микса и потерю к baseline."""
    quality: dict = {"per_stem": {}, "mix_reconstruction_db": None}
    stems = step_result.get("stems") or {}

    for name in STEM_NAMES:
        if name not in stems:
            continue
        signal, _ = read_wav_mono(Path(stems[name]))
        entry: dict = {}
        if truth:
            # Истина для стема «vocals» отсутствует: честно «нет данных».
            if name in truth:
                entry["sdr_db_vs_truth"] = sdr_db(signal, {name: truth[name]})
            else:
                entry["sdr_db_vs_truth"] = None
                entry["sdr_db_vs_truth_reason"] = "истинного источника нет (вокала в миксе нет)"
        if baseline_stems and name in baseline_stems:
            reference, _ = read_wav_mono(Path(baseline_stems[name]))
            entry["correlation_vs_baseline"] = correlation(reference, signal)
            entry["si_sdr_db_vs_baseline"] = si_sdr_db(reference, signal)
        quality["per_stem"][name] = entry

    if all(name in stems for name in STEM_NAMES):
        total = np.zeros_like(mix)
        for name in STEM_NAMES:
            signal, _ = read_wav_mono(Path(stems[name]))
            length = min(total.size, signal.size)
            total[:length] += signal[:length]
        quality["mix_reconstruction_db"] = relative_error_db(mix, total)
    return quality


def main() -> int:
    parser = argparse.ArgumentParser(description="Проба качества лестницы деградации Demucs")
    parser.add_argument("--wav", default=None, help="входной WAV; если не задан — синтез микса")
    parser.add_argument("--out", required=True, help="куда писать JSON-доказательство")
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--work", default=None, help="каталог для промежуточных файлов")
    parser.add_argument("--timeout", type=float, default=3600.0)
    parser.add_argument("--steps", default="", help="через запятую: какие ступени (по умолчанию все)")
    parser.add_argument("--seconds", type=float, default=60.0, help="длительность синтеза")
    args = parser.parse_args()

    work_dir = Path(args.work).resolve() if args.work else Path(os.environ.get("TEMP", ".")) / "demucs-ladder"
    work_dir.mkdir(parents=True, exist_ok=True)

    truth: dict | None = None
    if args.wav:
        wav_path = Path(args.wav).resolve()
        if not wav_path.exists():
            print(f"НЕТ ДАННЫХ: файла {wav_path} не существует", file=sys.stderr)
            return 2
        mix, rate = read_wav_mono(wav_path)
    else:
        mix, truth = synth_mix(seconds=args.seconds)
        rate = 44100
        wav_path = work_dir / "synth-mix.wav"
        write_wav(wav_path, mix, rate)
        for name, signal in truth.items():
            write_wav(work_dir / f"truth-{name}.wav", signal, rate)
        print(f"Микс синтезирован: {wav_path} ({len(truth)} истинных стема)")

    ladder = degradation_ladder(model=args.model, allow_cpu=True)
    wanted = {name.strip() for name in args.steps.split(",") if name.strip()}
    if wanted:
        ladder = [step for step in ladder if step["step"] in wanted]

    before = available_memory()
    print(f"Вход: {wav_path.name}, {mix.size / rate:.1f} с, {rate} Гц")
    print(f"Свободный commit до прогона: {before.get('available_commit_mb')} МБ")
    print(f"Ступеней к прогону: {[step['step'] for step in ladder]}")

    results: list[dict] = []
    baseline_stems: dict = {}
    for step in ladder:
        print(f"\n=== ступень {step['step']} :: {' '.join(step['args'])} ===", flush=True)
        outcome = run_step(step, wav_path, work_dir, args.timeout)
        print(
            f"    ok={outcome['ok']} код={outcome['returncode']} время={outcome['seconds']} с "
            f"пик_свободный_commit={outcome['min_available_commit_mb']} МБ "
            f"пик_VRAM={outcome['max_vram_mb']} МБ",
            flush=True,
        )
        if outcome["ok"]:
            if not baseline_stems:
                baseline_stems = {name: Path(path) for name, path in outcome["stems"].items()}
            outcome["quality"] = analyse_quality(outcome, baseline_stems, mix, truth)
            outcome["quality"]["role"] = "baseline" if len(results) == 0 else "degraded"
        results.append(outcome)

    report = {
        "kind": "demucs-ladder-quality",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "input": {
            "path": str(wav_path),
            "synthetic": truth is not None,
            "truth_stems": sorted(truth.keys()) if truth else [],
            "seconds": round(mix.size / rate, 2),
            "sample_rate": rate,
        },
        "machine": {
            "python": sys.version.split()[0],
            "torch": _module_version("torch"),
            "demucs": _module_version("demucs"),
            "cuda_available": _cuda_available(),
            "platform": sys.platform,
        },
        "available_memory_before": before,
        "steps": results,
    }

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nДоказательство: {out_path}")
    print_summary(report)
    return 0


def _module_version(name: str) -> str | None:
    try:
        module = __import__(name)
        return getattr(module, "__version__", None)
    except Exception:  # noqa: BLE001
        return None


def _cuda_available() -> bool | None:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return None


def print_summary(report: dict) -> None:
    print("\n=== Итог по ступеням ===")
    print(f"{'ступень':<16}{'ok':<5}{'с':>8}{'commit':>9}{'VRAM':>8}{'микс dB':>10}{'SDR dB':>9}  потеря к baseline")
    for step in report["steps"]:
        quality = step.get("quality") or {}
        reconstruction = quality.get("mix_reconstruction_db")
        per_stem = quality.get("per_stem") or {}
        sdrs = [
            value.get("sdr_db_vs_truth")
            for value in per_stem.values()
            if value.get("sdr_db_vs_truth") is not None
        ]
        mean_sdr = round(sum(sdrs) / len(sdrs), 2) if sdrs else None
        losses = [
            value.get("si_sdr_db_vs_baseline")
            for value in per_stem.values()
            if value.get("si_sdr_db_vs_baseline") is not None
        ]
        mean_loss = round(sum(losses) / len(losses), 2) if losses else None
        print(
            f"{step['step']:<16}{str(step['ok']):<5}{step['seconds']:>8}"
            f"{str(step['min_available_commit_mb']):>9}{str(step['max_vram_mb']):>8}"
            f"{('%.2f' % reconstruction) if reconstruction is not None else '—':>10}"
            f"{('%.2f' % mean_sdr) if mean_sdr is not None else '—':>9}"
            f"  {mean_loss if mean_loss is not None else '—'}"
        )


if __name__ == "__main__":
    sys.exit(main())
