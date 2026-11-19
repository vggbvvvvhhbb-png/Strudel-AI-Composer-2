# -*- coding: utf-8 -*-
"""
Память Demucs: классификация отказов, измерение запаса и лестница деградации.

ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Отказ из-за памяти — не «ещё одна ошибка»: это
особый класс отказа, где поведение должно быть заранее известно.
  * «DefaultCPUAllocator: not enough memory» — это НЕ RuntimeError и НЕ
    OutOfMemoryError: это отказ CPU-аллокатора, и обычный except его не ловит;
  * WinError 1455 («paging file is too small») — это лимит commit Windows,
    и никакой CUDA-аллокатор его не предотвращает;
  * нативное падение (процесс убит ОС) ловится НЕ внутри процесса, а по коду
    выхода дочернего — 0xC0000005 на Windows, 137/-9 на Linux.

Поэтому классификатор — чистая функция без импорта torch: его можно
протестировать без GPU, без Demucs и без сети.

ВАЖНО ПРО ТОЧКУ ПРИМЕНЕНИЯ. torch в этом проекте не импортируется в процессе
воркера: Demucs запускается ДОЧЕРНИМ процессом (`python -m demucs`). Значит
PYTORCH_CUDA_ALLOC_CONF задаётся в окружении ПОТОМКА (см. allocator_env),
а не в процессе воркера. Это измерено по коду (server/deepdive/analysis/
ddworker/http.py: handle_separate) — и потому важно: опция аллокатора
читается до инициализации CUDA, то есть только в свежем дочернем процессе.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# Известные классы отказа по памяти.
KIND_CUDA_OOM = "cuda_oom"
KIND_HOST_ALLOC = "host_alloc"
KIND_COMMIT_LIMIT = "commit_limit"
KIND_WORKER_CRASHED = "worker_crashed"

MEMORY_KINDS = (KIND_CUDA_OOM, KIND_HOST_ALLOC, KIND_COMMIT_LIMIT, KIND_WORKER_CRASHED)

# Порт отказа владельца ОС: процесс убит или упал нативно.
#   137 = 128 + 9 (SIGKILL, Linux OOM-killer), -9 = тот же сигнал;
#   3221225477 = 0xC0000005 (Windows access violation),
#   3221226505 = 0xC0000409 (Windows stack buffer overrun).
_CRASH_EXIT_CODES = {137, -9, 3221225477, 3221226505}

# Признаки отказа по памяти в тексте вывода процесса.
_CUDA_OOM_PATTERNS = (
    "cuda out of memory",
    "outofmemoryerror",
    "cublas_status_alloc_failed",
)
_HOST_ALLOC_PATTERNS = (
    "defaultcpuallocator",
    "not enough memory",
    "memoryerror",
    "bad_alloc",
)
_COMMIT_LIMIT_PATTERNS = (
    "paging file is too small",
    "winerror 1455",
    "1455",
    "cannot allocate memory",
)


def classify_memory_error(exc: BaseException) -> str | None:
    """Классифицирует исключение по памяти.

    Возвращает 'cuda_oom' | 'host_alloc' | 'commit_limit' либо None, если это
    НЕ отказ по памяти (тогда исключение надо пробрасывать дальше как есть).

    ЗАЧЕМ НЕ ТОЛЬКО ПО ТИПУ. CPU-аллокатор PyTorch поднимает обычный
    RuntimeError с текстом «DefaultCPUAllocator: not enough memory» — такой
    объект isinstance(exc, RuntimeError) даёт True, и «except (OutOfMemoryError,
    RuntimeError)» поймал бы вместе с настоящими сбоями движка. Классификатор
    различает их по тексту.
    """
    message = str(exc).lower()
    name = type(exc).__name__.lower()
    if name == "outofmemoryerror" or any(p in message for p in _CUDA_OOM_PATTERNS):
        return KIND_CUDA_OOM
    if getattr(exc, "winerror", None) == 1455 or any(p in message for p in _COMMIT_LIMIT_PATTERNS):
        return KIND_COMMIT_LIMIT
    if isinstance(exc, MemoryError) or any(p in message for p in _HOST_ALLOC_PATTERNS):
        return KIND_HOST_ALLOC
    return None


def classify_failure(returncode: int | None, text: str = "") -> str | None:
    """Классифицирует ОТКАЗ ДОЧЕРНЕГО процесса по памяти.

    Тот же словарь, что у classify_memory_error, но по коду выхода и тексту:
    нативное падение не оставляет ни exception, ни сообщения — только код.
    """
    if returncode in _CRASH_EXIT_CODES:
        return KIND_WORKER_CRASHED
    message = (text or "").lower()
    if any(p in message for p in _CUDA_OOM_PATTERNS):
        return KIND_CUDA_OOM
    if any(p in message for p in _COMMIT_LIMIT_PATTERNS):
        return KIND_COMMIT_LIMIT
    if any(p in message for p in _HOST_ALLOC_PATTERNS):
        return KIND_HOST_ALLOC
    return None


def available_memory() -> dict:
    """Измеряет запас памяти машины.

    Windows: GlobalMemoryStatusEx — ullAvailPageFile (свободный commit) и
    ullAvailPhys (свободная физическая RAM). Linux: /proc/meminfo —
    CommitLimit − Committed_AS (свободный commit) и MemAvailable (свободная RAM).

    Возвращает числа в МБ и источник. Если измерить не удалось — null с
    причиной: «нет данных» ≠ 0 (D-102).
    """
    if os.name == "nt":
        return _windows_memory()
    return _linux_memory()


def _windows_memory() -> dict:
    try:
        import ctypes
        from ctypes import wintypes
    except Exception as exc:  # noqa: BLE001
        return {"available_commit_mb": None, "available_physical_mb": None, "source": None, "reason": f"ctypes недоступен: {exc}"}

    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in (
                "total_physical", "available_physical", "total_commit", "available_commit",
                "total_virtual", "available_virtual", "available_extended_virtual",
            )
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    try:
        ok = ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    except Exception as exc:  # noqa: BLE001
        return {"available_commit_mb": None, "available_physical_mb": None, "source": None, "reason": f"GlobalMemoryStatusEx: {exc}"}
    if not ok:
        return {"available_commit_mb": None, "available_physical_mb": None, "source": None, "reason": "GlobalMemoryStatusEx вернул ошибку"}
    return {
        "available_commit_mb": status.available_commit // (1024 * 1024),
        "available_physical_mb": status.available_physical // (1024 * 1024),
        "total_commit_mb": status.total_commit // (1024 * 1024),
        "source": "GlobalMemoryStatusEx",
    }


def _linux_memory() -> dict:
    try:
        raw = Path("/proc/meminfo").read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        return {"available_commit_mb": None, "available_physical_mb": None, "source": None, "reason": f"/proc/meminfo недоступен: {exc}"}
    values: dict[str, int] = {}
    for line in raw.splitlines():
        match = re.match(r"^(\w+):\s+(\d+)\s*kB", line)
        if match:
            values[match.group(1)] = int(match.group(2))
    commit_limit = values.get("CommitLimit")
    committed = values.get("Committed_AS")
    available_commit = None
    if commit_limit is not None and committed is not None:
        available_commit = (commit_limit - committed) // 1024
    available_phys = values.get("MemAvailable")
    return {
        "available_commit_mb": available_commit,
        "available_physical_mb": available_phys // 1024 if available_phys is not None else None,
        "total_commit_mb": commit_limit // 1024 if commit_limit is not None else None,
        "source": "/proc/meminfo",
    }


def allocator_env(base_env: dict | None = None) -> dict:
    """Окружение дочернего процесса с настроенным аллокатором PyTorch.

    ЗАЧЕМ. Windows без overcommit: каждый импорт torch резервирует большой
    объём памяти, и неудачный размер cudaMalloc'а роняет всё. Набор опций
    зависит от версии torch: на 2.5.1 измерено, что
    `max_split_size_mb:256,garbage_collection_threshold:0.8` принимается
    молча, а `expandable_segments:True` на Windows даёт предупреждение
    «expandable_segments not supported on this platform» и ИГНОРИРУЕТСЯ
    (измерено на машине владельца, F:\\strudel-env, torch 2.5.1+cu121).
    Поэтому Windows и Linux получают разные наборы.

    Значение владельца сильнее: если PYTORCH_CUDA_ALLOC_CONF или
    PYTORCH_ALLOC_CONF уже заданы, они не перезаписываются.

    Имя переменной: PYTORCH_CUDA_ALLOC_CONF работает и в старых, и в новых
    torch (новый канонический — PYTORCH_ALLOC_CONF, старый — совместимый
    алиас). Задаются обе? Нет: только одна, чтобы не было расхождения.
    """
    env = dict(base_env if base_env is not None else os.environ)
    if env.get("PYTORCH_CUDA_ALLOC_CONF") or env.get("PYTORCH_ALLOC_CONF"):
        return env
    if sys.platform == "win32":
        options = ["max_split_size_mb:256", "garbage_collection_threshold:0.8"]
    else:
        options = ["expandable_segments:True", "garbage_collection_threshold:0.8"]
    env["PYTORCH_CUDA_ALLOC_CONF"] = ",".join(options)
    return env


def degradation_ladder(*, model: str, allow_cpu: bool) -> list[dict]:
    """Лестница деградации для Demucs.

    ПОРЯДОК (из README Demucs и измерения на машине владельца):
      1. как есть;
      2. shifts → 0 (каждый сдвиг кратно умножает время прогона);
      3. segment → 7 с (для htdemucs максимум 7.8 с);
      4. segment → 5 с + overlap → 0.1;
      5. PYTORCH_NO_CUDA_MEMORY_CACHING=1 (только свежим дочерним процессом —
         переменная читается до инициализации CUDA);
      6. CPU — только если свободного commit хватает (иначе падение не
         из-за памяти, а из-за её нехватки).

    -j > 0 не используется: он умножает RAM и число процессов.
    --two-stems не экономит память.
    """
    base = ["-n", model]
    attempts = [
        {"step": "baseline", "args": list(base), "env": {}, "degraded": False},
        {"step": "shifts0", "args": [*base, "--shifts", "0"], "env": {}, "degraded": True},
        {"step": "segment7", "args": [*base, "--shifts", "0", "--segment", "7"], "env": {}, "degraded": True},
        {
            "step": "segment5_overlap",
            "args": [*base, "--shifts", "0", "--segment", "5", "--overlap", "0.1"],
            "env": {},
            "degraded": True,
        },
        {
            "step": "no_cuda_cache",
            "args": [*base, "--shifts", "0", "--segment", "5", "--overlap", "0.1"],
            "env": {"PYTORCH_NO_CUDA_MEMORY_CACHING": "1"},
            "degraded": True,
        },
    ]
    if allow_cpu:
        attempts.append({
            "step": "cpu",
            "args": [*base, "--shifts", "0", "--segment", "5", "--overlap", "0.1", "-d", "cpu"],
            "env": {"PYTORCH_NO_CUDA_MEMORY_CACHING": "1"},
            "degraded": True,
        })
    return attempts
