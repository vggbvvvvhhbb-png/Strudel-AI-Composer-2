# -*- coding: utf-8 -*-
"""Регрессии измерительного прибора «качество лестницы деградации».

ЗАЧЕМ. Проба scripts/probe-demucs-ladder.py — не демонстрация, а
ИЗМЕРИТЕЛЬ: её числа (SDR по истине, ошибка восстановления микса, потеря
к baseline) должны быть верными, иначе в журнал попадёт мусор вместо
фактов. Поэтому сами метрики проверяются на синтетических сигналах, где
ответ известен заранее.

Тесты не требуют torch, GPU, Demucs и сети: numpy достаточно. numpy берётся
из окружения владельца; если его нет — тест честно падает (пропущенный шаг
ворот — дыра, а не «всё зеленое»).
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PROBE_PATH = ROOT / "scripts" / "probe-demucs-ladder.py"


def _load_probe():
    """Грузит пробу как модуль (файл вне пакета scripts/)."""
    spec = importlib.util.spec_from_file_location("probe_demucs_ladder", PROBE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = _load_probe()


class LadderMetricsTest(unittest.TestCase):
    """Метрики качества на сигналах с известным ответом."""

    def setUp(self) -> None:
        self.rate = 44100
        self.t = np.arange(self.rate) / self.rate
        self.sine = np.sin(2.0 * np.pi * 220.0 * self.t).astype(np.float32)
        self.noise = np.random.default_rng(3).standard_normal(self.rate).astype(np.float32) * 0.1

    def test_si_sdr_identical_signal_is_infinite(self) -> None:
        """Сигнал с самим собой — бесконечное SI-SDR."""
        value = probe.si_sdr_db(self.sine, self.sine.copy())
        self.assertIsNotNone(value)
        self.assertEqual(value, float("inf"))

    def test_si_sdr_ignores_gain(self) -> None:
        """Масштаб не влияет на SI-SDR: одинаковая форма — высокий балл."""
        value = probe.si_sdr_db(self.sine, self.sine * 0.25)
        self.assertIsNotNone(value)
        self.assertGreater(value, 60.0)

    def test_si_sdr_of_noise_is_low(self) -> None:
        """Шум против чистого тона — низкий балл (иначе метрика ничего не значит)."""
        value = probe.si_sdr_db(self.sine, self.noise)
        self.assertIsNotNone(value)
        self.assertLess(value, 10.0)

    def test_si_sdr_of_none_is_none(self) -> None:
        """Пустой сигнал — «нет данных», а не ноль."""
        self.assertIsNone(probe.si_sdr_db(np.zeros(0, dtype=np.float32), self.sine))

    def test_correlation_of_identical_is_one(self) -> None:
        value = probe.correlation(self.sine, self.sine.copy())
        self.assertIsNotNone(value)
        self.assertAlmostEqual(value, 1.0, places=6)

    def test_correlation_of_constant_signal_is_none(self) -> None:
        """Вырожденный сигнал (постоянный) — нет данных, а не деление на ноль."""
        self.assertIsNone(probe.correlation(np.ones(100, dtype=np.float32), self.sine[:100]))

    def test_relative_error_of_exact_reconstruction_is_minus_infinity(self) -> None:
        value = probe.relative_error_db(self.sine, self.sine.copy())
        self.assertIsNotNone(value)
        self.assertEqual(value, float("-inf"))

    def test_relative_error_reports_decibels(self) -> None:
        """Ошибка 10 % по мощности — это −20 дБ."""
        error = self.sine * 0.1
        value = probe.relative_error_db(self.sine, self.sine + error)
        self.assertIsNotNone(value)
        self.assertAlmostEqual(value, -20.0, delta=0.01)

    def test_sdr_against_truth_beats_sdr_against_wrong_source(self) -> None:
        """Оценка, совпавшая с истиной, должна выигрывать у чужой.

        «Чужой» источник должен быть заведомо НЕ входящим в истину, иначе
        он проецируется на истину точно и обе оценки дают бесконечность.
        """
        truth = {"drums": self.sine}
        stranger = np.sin(2.0 * np.pi * 440.0 * self.t).astype(np.float32)
        good = probe.sdr_db(self.sine, truth)
        bad = probe.sdr_db(stranger, truth)
        self.assertIsNotNone(good)
        self.assertIsNotNone(bad)
        self.assertGreater(good, bad + 20.0)

    def test_sdr_of_exact_truth_is_infinite(self) -> None:
        """Оценка, совпавшая с истинным стемом, — бесконечный SDR."""
        value = probe.sdr_db(self.sine, {"drums": self.sine})
        self.assertIsNotNone(value)
        self.assertEqual(value, float("inf"))

    def test_sdr_without_references_is_none(self) -> None:
        self.assertIsNone(probe.sdr_db(self.sine, {}))


class SyntheticMixTest(unittest.TestCase):
    """Синтезированный микс должен быть пригоден для измерения."""

    def test_mix_has_three_truth_stems_and_signal(self) -> None:
        mix, truth = probe.synth_mix(seconds=4.0)
        self.assertEqual(sorted(truth.keys()), ["bass", "drums", "other"])
        self.assertEqual(mix.shape, truth["drums"].shape)
        peak = float(np.max(np.abs(mix)))
        self.assertGreater(peak, 0.1)
        self.assertLessEqual(peak, 1.0)

    def test_stems_sum_to_the_mix(self) -> None:
        """Микс — это ровно сумма истинных стемов (иначе «ошибка
        восстановления» мерила бы не то)."""
        mix, truth = probe.synth_mix(seconds=4.0)
        total = truth["drums"] + truth["bass"] + truth["other"]
        np.testing.assert_allclose(mix, total, atol=1e-6)

    def test_wav_roundtrip_keeps_signal(self) -> None:
        """Запись и чтение WAV не теряют сигнал (16 бит — своя точность)."""
        import tempfile

        mix, _ = probe.synth_mix(seconds=2.0)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "probe.wav"
            probe.write_wav(path, mix, 44100)
            restored, rate = probe.read_wav_mono(path)
        self.assertEqual(rate, 44100)
        self.assertEqual(restored.shape, mix.shape)
        self.assertLess(float(np.max(np.abs(restored - mix))), 1e-3)


if __name__ == "__main__":
    unittest.main()
