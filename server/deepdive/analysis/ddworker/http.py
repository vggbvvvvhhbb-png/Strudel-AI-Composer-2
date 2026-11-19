# -*- coding: utf-8 -*-
"""
HTTP-слой DD-воркера: маршруты /health, /analyze, /analyze-stems, /separate.

Здесь только транспорт: разбор запроса, вызов анализаторов и ответ в JSON.
Вся DSP-логика живёт в соседних модулях пакета.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:  # POSIX-only; на Linux-контейнере всегда есть
    import fcntl
except ImportError:  # pragma: no cover — dev на Windows
    fcntl = None

try:  # Windows-only; на POSIX его нет, там работает flock
    import msvcrt
except ImportError:  # pragma: no cover — POSIX
    msvcrt = None

from .chords import analyze_chords
from .common import _num, _require_file, _ver, load_audio, rms_envelope
from .key import analyze_key
from .loudness import analyze_loudness
from .memory import (
    allocator_env,
    available_memory,
    classify_failure,
    classify_memory_error,
    degradation_ladder,
)
from .pitch import analyze_bass_pitch
from .stems import _activity_by_section, _energy_curve
from .structure import analyze_structure
from .tempo import analyze_tempo

# Глобальный мьютекс тяжёлых операций. Файл общий с хостом и с приложением:
# пока он занят, Demucs не запускается (и деплой не собирает образ).
HEAVY_LOCK_PATH = os.environ.get("DD_HEAVY_LOCK", "/lock/heavy.lock")
HEAVY_LOCK_WAIT_S = int(os.environ.get("DD_HEAVY_LOCK_WAIT_S", "3600"))


def _heavy_lock_paths() -> list[Path]:
    """Куда пробовать взять мьютекс — по порядку.

    На POSIX путь по умолчанию общий с контейнером (/lock/heavy.lock).
    На Windows такого каталога нет, а fcntl отсутствует, поэтому по умолчанию
    берётся файл во временном каталоге пользователя. Если каталог недоступен,
    мьютекс честно не берётся (locked=False), а не делается вид, что он есть.
    """
    configured = os.environ.get("DD_HEAVY_LOCK")
    if configured:
        return [Path(configured)]
    if os.name == "nt":
        return [Path(tempfile.gettempdir()) / "strudel-heavy.lock"]
    return [Path(HEAVY_LOCK_PATH)]


def _lock_windows(handle, deadline: float, path: Path) -> None:
    """Эксклюзивная блокировка диапазона байтов средствами Windows.

    Аналог flock: блокировка держится ядром, снимается при закрытии дескриптора
    и при падении процесса — «залипший» мьютекс после краша невозможен.
    """
    handle.seek(0, os.SEEK_END)
    if handle.tell() < 1:
        handle.write(b"0")
        handle.flush()
    while True:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError:
            if time.time() >= deadline:
                raise RuntimeError(
                    f"мьютекс тяжёлых операций занят дольше {HEAVY_LOCK_WAIT_S} с ({path})"
                )
            time.sleep(1.0)


@contextmanager
def heavy_lock():
    """Взять общий мьютекс тяжёлых операций (эксклюзивно).

    Смысл — механический: на сервере 2 ядра и 3.8 ГБ RAM, Demucs занимает
    ~1.75 ГБ, две копии сразу — это OOM. Блокировка держится на уровне ядра,
    поэтому работает и между процессами, и между контейнерами (файл в общем
    томе).

    Ждём, а не падаем: если мьютекс занят, ждём до HEAVY_LOCK_WAIT_S и только
    потом отдаём понятную ошибку.

    Значение — признак того, что мьютекс действительно взят. На POSIX это
    flock, на Windows — msvcrt.locking (D-156): раньше fcntl на Windows не
    существовал, и мьютекс был no-op, то есть два тяжёлых задания могли
    пойти одновременно.
    """
    if fcntl is None and msvcrt is None:
        yield False
        return

    deadline = time.time() + HEAVY_LOCK_WAIT_S
    for path in _heavy_lock_paths():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        try:
            handle = open(path, "a+b")
        except OSError:
            continue
        try:
            if fcntl is not None:
                while True:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError:
                        if time.time() >= deadline:
                            raise RuntimeError(
                                f"мьютекс тяжёлых операций занят дольше {HEAVY_LOCK_WAIT_S} с ({path})"
                            )
                        time.sleep(1.0)
            else:
                _lock_windows(handle, deadline, path)
            try:
                # Владельца пишем в отдельный файл: на Windows запертый диапазон
                # (байт 0) нельзя прочитать, и сам файл мьютекса остался бы
                # нечитаемым для диагностики.
                owner = Path(str(path) + ".owner")
                owner.write_text(
                    f"pid={os.getpid()} since={int(time.time())} path={path}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass
            yield True
            return
        finally:
            try:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                else:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            handle.close()
            try:
                # Помечаем мьютекс свободным: оставшийся pid без этого вводил бы
                # в заблуждение — выглядел бы как занятый мьютекс.
                owner = Path(str(path) + ".owner")
                owner.write_text(f"pid=none released={int(time.time())} path={path}\n", encoding="utf-8")
            except OSError:
                pass


def health_payload() -> dict:
    demucs_available = False
    demucs_version = None
    try:
        spec = importlib.util.find_spec("demucs")
        demucs_available = spec is not None
        demucs_version = _ver("demucs") if demucs_available else None
    except Exception:
        demucs_available = False
    return {
        "ok": True,
        "versions": {
            "python": sys.version.split()[0],
            "librosa": _ver("librosa"),
            "numpy": _ver("numpy"),
            "scipy": _ver("scipy"),
            "soundfile": _ver("soundfile"),
            "demucs": demucs_version,
        },
        "models": {
            "separation": "htdemucs",
            "demucs_available": demucs_available,
            "default_separation_model": "htdemucs",
        },
    }


def handle_analyze(body: dict) -> dict:
    path = _require_file(body.get("path"))
    y, sr = load_audio(path)
    if len(y) == 0:
        raise ValueError("аудиофайл пуст")
    tempo = analyze_tempo(y, sr)
    key = analyze_key(y, sr)
    loudness = analyze_loudness(path, y, sr)
    structure, structure_method = analyze_structure(y, sr)
    return {
        "measurements": {
            "tempo": tempo,
            "key": key,
            "loudness": loudness,
        },
        "structure": structure,
        # Методы — отдельно от данных: в контракте у structure[] нет поля method
        # (additionalProperties: false), туда его положить нельзя.
        "methods": {
            "tempo": tempo.get("method"),
            "key": key.get("method"),
            "loudness": loudness.get("method"),
            "structure": structure_method,
        },
    }


def handle_analyze_stems(body: dict) -> dict:
    stems = body.get("stems") or {}
    if not isinstance(stems, dict) or not stems:
        raise ValueError("не указаны стемы (stems)")
    sections = body.get("sections") or []
    if not isinstance(sections, list):
        raise ValueError("sections должен быть списком")

    descriptors: dict = {}
    methods: dict = {}
    bass_notes: list = []

    for name in ("drums", "bass", "vocals", "other"):
        raw_path = stems.get(name)
        if not raw_path:
            continue
        path = _require_file(raw_path)
        y, sr = load_audio(path)
        rms, rms_times = rms_envelope(y, sr)
        activity = _activity_by_section(rms, rms_times, sections)
        energy = _energy_curve(rms, rms_times)
        descriptor = {"activity": activity, "energy": energy}

        if name == "bass":
            pitch = analyze_bass_pitch(y, sr)
            descriptor["pitch"] = {
                "notes": pitch["notes"],
                "median_f0_hz": pitch["median_f0_hz"],
            }
            methods["bass.pitch"] = pitch["method"]
            bass_notes = pitch["notes"]
        elif name == "other":
            chords, chords_method = analyze_chords(y, sr, bass_notes)
            descriptor["chords"] = chords
            methods["other.chords"] = chords_method

        descriptors[name] = descriptor

    return {
        "stem_descriptors": descriptors,
        # В контракте у stem_descriptors нет поля method (additionalProperties: false),
        # поэтому методы идут отдельным объектом.
        "methods": methods,
    }


def _venv_python() -> str:
    configured = os.environ.get("DD_PYTHON")
    if configured:
        return configured
    for candidate in ("/opt/dd-venv/bin/python", "/opt/dd-venv/bin/python3"):
        if os.path.exists(candidate):
            return candidate
    return sys.executable


def _check_separation_memory() -> None:
    """Предохранитель перед Demucs: нехватка commit memory — явный отказ.

    ИЗМЕРЕНИЕ (D-153, E-031): на машине владельца свободный commit падал до
    3352 МБ во время сепарации, и нативный краш случался при 12.22 МБ
    доступного commit при 2032 МБ свободной физической RAM. Поэтому меряется
    именно commit (ullAvailPageFile), а не «свободная RAM».

    Порог 3072 МБ — измеренный и консервативный (D-153). Его можно переопределить
    переменной DEMUCS_MIN_COMMIT_MB, но значение по умолчанию не «выдумано»:
    оно опирается на замеры E-031. Пробел памяти приходит в ответе с числами
    (available_commit_mb), а не словами.
    """
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in (
                "total_physical", "available_physical", "total_commit", "available_commit",
                "total_virtual", "available_virtual", "available_extended_virtual",
            )
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise RuntimeError("не удалось проверить запас commit memory Windows перед Demucs")
    available_mb = status.available_commit // (1024 * 1024)
    # Свободная физическая RAM не отражает оставшийся лимит выделения памяти Windows.
    threshold_mb = int(os.environ.get("DEMUCS_MIN_COMMIT_MB") or 3072)
    if available_mb < threshold_mb:
        raise RuntimeError(
            f"Demucs не запущен: запас commit memory Windows {available_mb} МБ, нужно не менее {threshold_mb} МБ. "
            "Закройте ненужные приложения и повторите задачу; наличие CUDA не гарантирует запас памяти."
        )


def _memory_status_payload(kind: str, message: str, attempts: list[dict], measured: dict | None) -> dict:
    """Терминальный ответ «не хватило памяти».

    Формат зафиксирован D-158: status, kind, message, attempts[], measured,
    degraded. Это НЕ ошибка HTTP и НЕ успех: разделения не состоялось, но
    разбор продолжается без стемов, а причина и числа видны клиенту.
    """
    return {
        "status": "insufficient_memory",
        "kind": kind,
        "message": message,
        "attempts": attempts,
        "measured": measured or {"available_commit_mb": None, "reason": "нет данных"},
        "degraded": True,
    }


class WorkerCrashError(RuntimeError):
    """Нативное падение дочернего процесса (D-153, D-158).

    Остаётся RuntimeError: полный native stderr сохраняется, а код выхода
    виден в сообщении — эта гарантия проверяется регрессией с 19.11.2026.
    Дополнительно несёт kind='worker_crashed', чтобы клиентская цепочка
    отличала нативный краш от прочих ошибок.

    Лестницу деградации краш НЕ проходит: он не «не хватило памяти» в смысле
    OOM, это сбой процесса. Повторять его пять раз с разными segment — трата
    минут без диагностической ценности.
    """

    def __init__(self, message: str, *, kind: str = "worker_crashed") -> None:
        super().__init__(message)
        self.kind = kind




def handle_separate(body: dict) -> dict:
    path = _require_file(body.get("path"))
    model = str(body.get("model") or "htdemucs")
    out_dir = body.get("out_dir")
    if not out_dir:
        raise ValueError("не указан out_dir")
    out_path = Path(str(out_dir)).expanduser()
    out_path.mkdir(parents=True, exist_ok=True)

    python = _venv_python()
    started = time.time()
    attempts: list[dict] = []
    measured = available_memory()

    # CPU-режим разрешён, только если свободного commit хватает: иначе мы бы
    # просто перенесли тот же отказ по памяти в другой оболочку.
    allow_cpu = bool(
        measured.get("available_commit_mb") is not None
        and measured["available_commit_mb"] >= (int(os.environ.get("DEMUCS_MIN_COMMIT_MB") or 3072))
    )
    ladder = degradation_ladder(model=model, allow_cpu=allow_cpu)

    with heavy_lock() as locked:
        _check_separation_memory()
        if locked:
            sys.stderr.write(
                json.dumps(
                    {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": "heavy-lock-acquired",
                     "model": model, "path": str(path)},
                    ensure_ascii=False,
                ) + "\n"
            )
            sys.stderr.flush()

        for attempt in ladder:
            env = allocator_env({**os.environ, **attempt["env"], "PYTHONIOENCODING": "utf-8"})
            command = [python, "-X", "faulthandler", "-m", "demucs", *attempt["args"], "-o", str(out_path), path]
            try:
                completed = subprocess.run(
                    command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                    env=env, timeout=7200, check=False
                )
            except FileNotFoundError as exc:
                raise RuntimeError(f"не найден интерпретатор для demucs: {python}") from exc
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("demucs не уложился в таймаут 7200 с") from exc

            if completed.returncode == 0:
                (out_path / "demucs.stderr.log").write_text(completed.stderr or "", encoding="utf-8")
                attempts.append({"step": attempt["step"], "params": attempt["args"], "ok": True, "error": None})
                found = _collect_stems(out_path)
                if not found:
                    raise RuntimeError("demucs отработал, но файлы стемов не найдены в out_dir")
                return {
                    "stems": found,
                    "seconds": _num(time.time() - started, 2),
                    "model": model,
                    "attempts": attempts,
                    "degraded": attempt["degraded"],
                    "measured": measured,
                }

            # Отказ: пишем полный stderr (как и раньше) и разбираем причину.
            (out_path / "demucs.stderr.log").write_text(completed.stderr or "", encoding="utf-8")
            tail = (completed.stderr or completed.stdout or "")[-800:]
            kind = classify_failure(completed.returncode, completed.stderr or completed.stdout or "")
            attempts.append({
                "step": attempt["step"],
                "params": attempt["args"],
                "ok": False,
                "error": f"код {completed.returncode}: {tail}",
                "kind": kind,
            })
            if kind == "worker_crashed":
                # Нативный краш: полный stderr уже сохранён, код выхода виден.
                # Это сбой процесса, а не нехватка памяти — лестница тут не поможет.
                raise WorkerCrashError(
                    f"demucs завершился с кодом {completed.returncode}: {tail}; полный stderr: demucs.stderr.log в out_dir",
                    kind=kind,
                )
            if kind is None:
                # Это не отказ по памяти — дальше идти незачем: причина другая.
                raise RuntimeError(
                    f"demucs завершился с кодом {completed.returncode}: {tail}; полный stderr: demucs.stderr.log в out_dir"
                )
            # Отказ по памяти: пробуем следующую ступень лестницы.

    # Лестница исчерпана — честный терминальный отказ с числами и попытками.
    last = attempts[-1] if attempts else {}
    return _memory_status_payload(
        kind=last.get("kind") or "host_alloc",
        message=(
            "Не хватило памяти для разделения: все экономные режимы Demucs исчерпаны "
            f"(последняя попытка — {last.get('step', '—')})."
        ),
        attempts=attempts,
        measured=measured,
    )


def _collect_stems(out_path: Path) -> dict:
    """Найти файлы стемов в каталоге результата (последняя версия каждого слоя)."""
    found: dict = {}
    for stem in ("drums", "bass", "vocals", "other"):
        matches = sorted(
            out_path.rglob(f"{stem}.wav"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        if matches:
            found[stem] = str(matches[0].resolve())
    return found



# --------------------------------------------------------------------------- #
# HTTP-сервер
# --------------------------------------------------------------------------- #

def _log(route: str, status: int, started: float, extra: dict | None = None) -> None:
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "route": route,
        "status": status,
        "ms": int((time.time() - started) * 1000),
    }
    if extra:
        record.update(extra)
    sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stderr.flush()


class DDHandler(BaseHTTPRequestHandler):
    server_version = "DDWorker/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 — глушим стандартный лог
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):  # noqa: N802 — имя задано базовым классом
        route = self.path.split("?")[0]
        if route == "/health":
            try:
                self._send_json(200, health_payload())
            except Exception as exc:  # noqa: BLE001
                self._send_json(500, {"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()})
            return
        self._send_json(404, {"error": f"неизвестный маршрут: {route}"})

    def do_POST(self):  # noqa: N802 — имя задано базовым классом
        started = time.time()
        route = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(body, dict):
                raise ValueError("тело запроса должно быть JSON-объектом")
            status, payload = self._dispatch(route, body)
        except Exception as exc:  # noqa: BLE001 — сервер не должен падать
            status = 500
            payload = {
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(),
            }
        self._send_json(status, payload)
        _log(route, status, started)

    def _dispatch(self, route: str, body: dict):
        if route == "/health":
            return 200, health_payload()
        if route == "/analyze":
            return 200, handle_analyze(body)
        if route == "/analyze-stems":
            return 200, handle_analyze_stems(body)
        if route == "/separate":
            return 200, handle_separate(body)
        return 404, {"error": f"неизвестный маршрут: {route}"}


class DDServer(ThreadingHTTPServer):
    """HTTP-сервер воркера без шумных трассировок на обычный разрыв.

    Клиент (демон) закрывает соединение, когда ответ уже получен — это
    нормальная жизнь, а не авария. Стандартный socketserver печатает на такое
    полную трассировку, и в логе воркера она выглядит как сбой.
    """

    daemon_threads = True

    def handle_error(self, request, client_address):  # noqa: D102 — как в socketserver
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def _port() -> int:
    try:
        return int(os.environ.get("DD_PORT") or 8010)
    except (TypeError, ValueError):
        return 8010


def main() -> None:
    port = _port()
    server = DDServer(("0.0.0.0", port), DDHandler)
    server.daemon_threads = True
    sys.stderr.write(f"DD worker listening on :{port}\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
