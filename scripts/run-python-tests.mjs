#!/usr/bin/env node
// Регрессии Python-воркера анализа (D-153).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ `python -m unittest` В package.json.
// На Windows команда называется `python`, на Linux в образе CI — `python3`,
// а `py -3` — третий вариант на Windows-системах без `python` в PATH.
// Скрипт сам находит интерпретатор и честно падает, если его нет: молча
// пропущенный шаг ворот — это дыра, а не «всё зеленое».
//
// ЧТО ПРОВЕРЯЕТСЯ. Регрессии сепарации: ресурсный отказ до запуска Demucs
// при нехватке Windows commit, порог включительно, ошибка WinAPI, полный
// native stderr, обязательные файлы стемов. Тесты не требуют numpy,
// torch, GPU и сети — тяжёлые зависимости в ddworker ленивые.
//
// ЗАПУСК: npm run test:python

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
  { cmd: 'python3', args: [] },
  { cmd: 'python', args: [] },
  { cmd: 'py', args: ['-3'] },
];

function findInterpreter() {
  for (const candidate of CANDIDATES) {
    // Без shell: с shell аргументы с кавычками и «;» переписываются оболочкой,
    // и проба возвращает пустоту вместо версии.
    const probe = spawnSync(candidate.cmd, [...candidate.args, '-c', 'import sys; print(sys.version_info[0])'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (probe.status === 0 && String(probe.stdout).trim() === '3') return candidate;
  }
  return null;
}

const interpreter = findInterpreter();
if (!interpreter) {
  console.error('Python 3 не найден: регрессии воркера сепарации не проверены.');
  console.error('Поставьте Python 3 (python3 / python / py -3) и повторите шаг ворот.');
  process.exit(1);
}

const result = spawnSync(
  interpreter.cmd,
  [...interpreter.args, '-m', 'unittest', 'discover', '-s', 'tests/unit', '-p', 'test_*.py', '-v'],
  { cwd: ROOT, stdio: 'inherit' },
);

process.exit(result.status === null ? 1 : result.status);
