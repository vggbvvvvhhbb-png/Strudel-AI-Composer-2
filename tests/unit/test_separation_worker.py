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


if __name__ == "__main__":
    unittest.main()
