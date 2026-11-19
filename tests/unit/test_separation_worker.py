import contextlib
import ctypes
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server" / "deepdive" / "analysis"))
from ddworker import http as worker
from ddworker import memory as mem


class MemoryClassifierTest(unittest.TestCase):
    """Классификатор отказов по памяти (P0.2).

    Главное: CPU-аллокатор PyTorch поднимает обычный RuntimeError с текстом
    «DefaultCPUAllocator: not enough memory». Такой объект isinstance(exc,
    RuntimeError) даёт True — «except (OutOfMemoryError, RuntimeError)» поймал
    бы вместе с настоящими сбоями движка. Классификатор различает их по
    тексту, и не-память возвращает None, чтобы исключение ушло дальше как есть.
    """

    def test_cuda_oom_is_detected(self):
        self.assertEqual(mem.classify_memory_error(RuntimeError("CUDA out of memory")), mem.KIND_CUDA_OOM)

    def test_out_of_memory_error_class_is_detected(self):
        self.assertEqual(mem.classify_memory_error(MemoryError("boom")), mem.KIND_HOST_ALLOC)

    def test_cpu_allocator_message_is_host_alloc(self):
        exc = RuntimeError("DefaultCPUAllocator: not enough memory: you tried to allocate 8 bytes")
        self.assertEqual(mem.classify_memory_error(exc), mem.KIND_HOST_ALLOC)

    def test_winerror_1455_is_commit_limit(self):
        exc = OSError("The paging file is too small for this operation to complete")
        exc.winerror = 1455
        self.assertEqual(mem.classify_memory_error(exc), mem.KIND_COMMIT_LIMIT)

    def test_paging_file_text_without_attribute_is_commit_limit(self):
        self.assertEqual(
            mem.classify_memory_error(RuntimeError("WinError 1455: The paging file is too small")),
            mem.KIND_COMMIT_LIMIT,
        )

    def test_unrelated_error_is_not_memory(self):
        self.assertIsNone(mem.classify_memory_error(ValueError("не указан out_dir")))
        self.assertIsNone(mem.classify_memory_error(RuntimeError("demucs завершился с кодом 1")))

    def test_native_crash_exit_codes_are_worker_crashed(self):
        for code in (137, -9, 3221225477, 3221226505):
            self.assertEqual(mem.classify_failure(code, ""), mem.KIND_WORKER_CRASHED)

    def test_failure_text_is_classified_like_exceptions(self):
        self.assertEqual(
            mem.classify_failure(1, "CUDA out of memory. Tried to allocate 2.00 GiB"),
            mem.KIND_CUDA_OOM,
        )
        self.assertIsNone(mem.classify_failure(1, "ModuleNotFoundError: No module named 'demucs'"))


class AllocatorEnvTest(unittest.TestCase):
    """Опции аллокатора задаются в окружении ДОЧЕРНЕГО процесса (P0.3).

    torch в этом проекте не импортируется в процессе воркера: Demucs запускается
    дочерним процессом, и опция читается до инициализации CUDA — то есть
    только в свежем потомке.
    """

    def test_windows_uses_split_size_without_expandable_segments(self):
        env = mem.allocator_env({"PATH": "x"})
        with patch.object(mem.sys, "platform", "win32"):
            env = mem.allocator_env({"PATH": "x"})
        self.assertIn("max_split_size_mb:256", env["PYTORCH_CUDA_ALLOC_CONF"])
        self.assertNotIn("expandable_segments", env["PYTORCH_CUDA_ALLOC_CONF"])
        self.assertIn("garbage_collection_threshold:0.8", env["PYTORCH_CUDA_ALLOC_CONF"])

    def test_linux_uses_expandable_segments(self):
        with patch.object(mem.sys, "platform", "linux"):
            env = mem.allocator_env({})
        self.assertIn("expandable_segments:True", env["PYTORCH_CUDA_ALLOC_CONF"])

    def test_owner_value_is_not_overwritten(self):
        with patch.object(mem.sys, "platform", "win32"):
            env = mem.allocator_env({"PYTORCH_CUDA_ALLOC_CONF": "max_split_size_mb:512"})
        self.assertEqual(env["PYTORCH_CUDA_ALLOC_CONF"], "max_split_size_mb:512")

    def test_canonical_alias_is_also_respected(self):
        with patch.object(mem.sys, "platform", "win32"):
            env = mem.allocator_env({"PYTORCH_ALLOC_CONF": "expandable_segments:True"})
        self.assertEqual(env["PYTORCH_ALLOC_CONF"], "expandable_segments:True")
        self.assertNotIn("PYTORCH_CUDA_ALLOC_CONF", env)


class DegradationLadderTest(unittest.TestCase):
    """Лестница деградации (P0.5): порядок и набор шагов."""

    def test_order_is_cheaper_first(self):
        steps = [item["step"] for item in mem.degradation_ladder(model="htdemucs", allow_cpu=False)]
        self.assertEqual(
            steps,
            ["baseline", "shifts0", "segment7", "segment5_overlap", "no_cuda_cache"],
        )

    def test_cpu_step_only_when_allowed(self):
        without = [item["step"] for item in mem.degradation_ladder(model="htdemucs", allow_cpu=False)]
        with_cpu = mem.degradation_ladder(model="htdemucs", allow_cpu=True)
        self.assertNotIn("cpu", without)
        self.assertEqual(with_cpu[-1]["step"], "cpu")
        self.assertIn("-d", with_cpu[-1]["args"])

    def test_segment_never_exceeds_htdemucs_limit(self):
        for item in mem.degradation_ladder(model="htdemucs", allow_cpu=True):
            if "--segment" in item["args"]:
                value = item["args"][item["args"].index("--segment") + 1]
                self.assertLessEqual(float(value), 7.8)

    def test_no_parallel_jobs_flag(self):
        for item in mem.degradation_ladder(model="htdemucs", allow_cpu=True):
            self.assertNotIn("-j", item["args"])

    def test_every_step_but_first_is_degraded(self):
        ladder = mem.degradation_ladder(model="htdemucs", allow_cpu=True)
        self.assertFalse(ladder[0]["degraded"])
        self.assertTrue(all(item["degraded"] for item in ladder[1:]))


class MemoryMeasurementTest(unittest.TestCase):
    def test_measurement_returns_numbers_or_none_with_reason(self):
        measured = mem.available_memory()
        self.assertIn("available_commit_mb", measured)
        self.assertIn("available_physical_mb", measured)
        if measured["available_commit_mb"] is None:
            # «Нет данных» ≠ 0: причина обязана быть.
            self.assertTrue(measured.get("reason"))
        else:
            self.assertGreater(measured["available_commit_mb"], 0)


class HeavyLockTest(unittest.TestCase):
    """Мьютекс тяжёлых операций должен реально браться и быть эксклюзивным.

    На Windows fcntl отсутствует, и раньше heavy_lock был no-op: два тяжёлых
    задания могли выполняться одновременно (D-091 на этой платформе не работал).
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "heavy.lock"

    def test_lock_is_actually_taken_and_records_the_owner(self):
        with patch.dict(os.environ, {"DD_HEAVY_LOCK": str(self.path)}):
            with worker.heavy_lock() as locked:
                self.assertTrue(locked)
                owner = Path(str(self.path) + ".owner").read_text(encoding="utf-8")
                self.assertIn(f"pid={os.getpid()}", owner)

    def test_second_holder_waits_and_fails_with_a_clear_error(self):
        with patch.dict(os.environ, {"DD_HEAVY_LOCK": str(self.path)}), patch.object(worker, "HEAVY_LOCK_WAIT_S", 1):
            with worker.heavy_lock():
                with self.assertRaisesRegex(RuntimeError, "занят дольше"):
                    with worker.heavy_lock():
                        pass

    def test_lock_is_released_after_the_block(self):
        with patch.dict(os.environ, {"DD_HEAVY_LOCK": str(self.path)}):
            with worker.heavy_lock():
                pass
            with worker.heavy_lock() as locked:
                self.assertTrue(locked)
            owner = Path(str(self.path) + ".owner").read_text(encoding="utf-8")
            self.assertIn("pid=none", owner)


class SeparationResourcesTest(unittest.TestCase):
    def test_non_windows_does_not_apply_windows_commit_guard(self):
        with patch.object(worker.os, "name", "posix"):
            worker._check_separation_memory()

    def check_commit(self, available_mb, succeeds=True):
        def query(pointer):
            pointer._obj.available_commit = available_mb * 1024 * 1024
            return int(succeeds)

        kernel = SimpleNamespace(GlobalMemoryStatusEx=query)
        with patch.object(worker.os, "name", "nt"), patch.object(ctypes, "windll", SimpleNamespace(kernel32=kernel), create=True):
            worker._check_separation_memory()

    def test_low_commit_refuses_even_when_physical_memory_is_not_reported(self):
        with self.assertRaisesRegex(RuntimeError, "Demucs не запущен.*2013 МБ"):
            self.check_commit(2013)

    def test_threshold_is_inclusive(self):
        self.check_commit(3072)
        with self.assertRaisesRegex(RuntimeError, "3071 МБ"):
            self.check_commit(3071)

    def test_failed_memory_query_is_not_a_success(self):
        with self.assertRaisesRegex(RuntimeError, "не удалось проверить"):
            self.check_commit(0, succeeds=False)


class SeparationProcessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "owned.wav"
        self.source.write_bytes(b"fixture")
        self.output = self.root / "stems"
        self.body = {"path": str(self.source), "out_dir": str(self.output), "model": "htdemucs"}

    def test_resource_refusal_happens_before_process_launch(self):
        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory", side_effect=RuntimeError("resource refusal")), patch.object(worker.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "resource refusal"):
                worker.handle_separate(self.body)
            run.assert_not_called()

    def test_failure_saves_full_native_trace_and_enables_faulthandler(self):
        trace = "native stack\n" * 200
        completed = SimpleNamespace(returncode=3221225477, stderr=trace, stdout="")
        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker, "_venv_python", return_value="fixture-python"), patch.object(worker.subprocess, "run", return_value=completed) as run:
            with self.assertRaisesRegex(RuntimeError, "3221225477[\\s\\S]*полный stderr"):
                worker.handle_separate(self.body)
            self.assertEqual(run.call_args.args[0][:5], ["fixture-python", "-X", "faulthandler", "-m", "demucs"])
            self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")
            self.assertEqual(run.call_args.kwargs["env"]["PYTHONIOENCODING"], "utf-8")
            self.assertEqual((self.output / "demucs.stderr.log").read_text(encoding="utf-8"), trace)

    def test_native_crash_is_not_retried_by_the_ladder(self):
        """Нативный краш — сбой процесса, а не OOM: лестница тут не поможет.

        Пять повторов с разными segment — это минуты впустую. Крах
        классифицируется (kind=worker_crashed), но не повторяется.
        """
        completed = SimpleNamespace(returncode=3221225477, stderr="native stack", stdout="")
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            return completed

        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker.subprocess, "run", side_effect=fake_run):
            with self.assertRaises(worker.WorkerCrashError) as ctx:
                worker.handle_separate(self.body)

        self.assertEqual(len(calls), 1)
        self.assertEqual(ctx.exception.kind, mem.KIND_WORKER_CRASHED)

    def test_success_still_requires_actual_stem_files(self):
        self.output.mkdir()
        for layer in ("drums", "bass", "vocals", "other"):
            (self.output / f"{layer}.wav").write_bytes(b"fixture")
        completed = SimpleNamespace(returncode=0, stderr="diagnostic", stdout="")
        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker.subprocess, "run", return_value=completed):
            result = worker.handle_separate(self.body)
        self.assertEqual(set(result["stems"]), {"drums", "bass", "vocals", "other"})
        self.assertGreaterEqual(result["seconds"], 0)
        self.assertEqual((self.output / "demucs.stderr.log").read_text(encoding="utf-8"), "diagnostic")


class SeparationDegradationTest(unittest.TestCase):
    """Лестница деградации в живом коде воркера (P0.5).

    Проверяется порядок: сначала экономный режим, потом отказ по памяти, и
    только после исчерпания лестницы — терминальный статус с числами.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "owned.wav"
        self.source.write_bytes(b"fixture")
        self.output = self.root / "stems"
        self.body = {"path": str(self.source), "out_dir": str(self.output), "model": "htdemucs"}

    def test_memory_failure_moves_to_next_cheaper_step(self):
        oom = SimpleNamespace(returncode=1, stderr="CUDA out of memory. Tried to allocate 20.00 GiB", stdout="")
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            return oom

        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker.subprocess, "run", side_effect=fake_run):
            result = worker.handle_separate(self.body)

        self.assertEqual(result["status"], "insufficient_memory")
        self.assertEqual(result["kind"], mem.KIND_CUDA_OOM)
        self.assertTrue(result["degraded"])
        self.assertGreater(len(result["attempts"]), 1)
        # Шаги идут от дорогого к дешёвому: сначала без segment, потом короче.
        self.assertNotIn("--segment", calls[0])
        self.assertIn("--segment", calls[-1])
        self.assertTrue(all(item["ok"] is False for item in result["attempts"]))

    def test_successful_fallback_reports_degraded_but_works(self):
        self.output.mkdir()
        for layer in ("drums", "bass", "vocals", "other"):
            (self.output / f"{layer}.wav").write_bytes(b"fixture")
        oom = SimpleNamespace(returncode=1, stderr="CUDA out of memory", stdout="")
        ok = SimpleNamespace(returncode=0, stderr="", stdout="")
        results = [oom, ok]

        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker.subprocess, "run", side_effect=lambda *a, **k: results.pop(0)):
            result = worker.handle_separate(self.body)

        self.assertEqual(set(result["stems"]), {"drums", "bass", "vocals", "other"})
        self.assertTrue(result["degraded"])
        self.assertEqual(result["attempts"][0]["ok"], False)
        self.assertEqual(result["attempts"][-1]["ok"], True)

    def test_non_memory_failure_is_not_retried(self):
        broken = SimpleNamespace(returncode=1, stderr="ModuleNotFoundError: No module named 'demucs'", stdout="")
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            return broken

        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(RuntimeError, "No module named"):
                worker.handle_separate(self.body)

        self.assertEqual(len(calls), 1)

    def test_terminal_status_carries_numbers_not_zeros(self):
        oom = SimpleNamespace(returncode=1, stderr="CUDA out of memory", stdout="")
        with patch.object(worker, "heavy_lock", return_value=contextlib.nullcontext(False)), patch.object(worker, "_check_separation_memory"), patch.object(worker.subprocess, "run", return_value=oom):
            result = worker.handle_separate(self.body)

        self.assertIn("measured", result)
        commit = result["measured"].get("available_commit_mb")
        self.assertTrue(commit is None or commit > 0)
        if commit is None:
            self.assertTrue(result["measured"].get("reason"))


if __name__ == "__main__":
    unittest.main()
