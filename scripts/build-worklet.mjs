// Сборка мастер-worklet в один самодостаточный файл.
//
// Зачем это нужно: AudioWorklet не поддерживает `import` — модуль загружается
// в изолированную глобальную область, где нет системы модулей. Поэтому файл
// worklet'а должен быть самодостаточным.
//
// Чтобы не было двух копий DSP (одна в worklet, другая в Node), worklet
// собирается из src/audio/worklet/master-processor.js, который импортирует то
// же ядро src/audio/dsp/*. Выход — public/worklets/master-processor.js.
//
// Сборка детерминирована: при неизменных исходниках файл не переписывается
// (сверка по хешу), поэтому vite и git не видят шума.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'src', 'audio', 'worklet', 'master-processor.js');
const OUT_DIR = join(ROOT, 'public', 'worklets');
const OUT = join(OUT_DIR, 'master-processor.js');

const banner = `// Мастер-worklet студии — СГЕНЕРИРОВАННЫЙ ФАЙЛ, не редактировать.
// Источник: src/audio/worklet/master-processor.js
// Сборка: npm run build:worklet (esbuild)
//`;

async function main() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    banner: { js: banner },
  });

  const code = result.outputFiles[0].text;
  const hash = createHash('sha256').update(code).digest('hex');

  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(OUT)) {
    const current = readFileSync(OUT, 'utf8');
    const currentHash = createHash('sha256').update(current).digest('hex');
    if (currentHash === hash) {
      console.log(`✓ worklet не изменился (${(code.length / 1024).toFixed(1)} КБ)`);
      return;
    }
  }
  writeFileSync(OUT, code, 'utf8');
  console.log(`✓ worklet собран: ${(code.length / 1024).toFixed(1)} КБ → public/worklets/master-processor.js`);
}

main().catch((error) => {
  console.error('✗ не удалось собрать worklet:', error?.message || error);
  process.exit(1);
});
