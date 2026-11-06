// Pre-commit: поиск секретов в индексе git. Ключи разрешены только в локальном .env (не коммитится).
import { spawnSync } from 'node:child_process';

const PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, why: 'OpenAI-совместимый ключ (sk-…)' },
  { re: /\bgsk_[A-Za-z0-9]{20,}\b/, why: 'Groq-ключ (gsk_…)' },
];

const out = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' });
const files = out.stdout.split('\0').filter(Boolean);
const offenders = [];

for (const file of files) {
  if (file === '.env' || file.startsWith('.env/')) continue; // локальный .env не должен коммититься вообще
  const blob = spawnSync('git', ['show', `:0:${file}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const text = blob.stdout;
  if (!text) continue;
  for (const { re, why } of PATTERNS) {
    if (re.test(text)) offenders.push(`${file}: ${why}`);
  }
}

if (files.includes('.env')) offenders.push('.env закоммичен — это запрещено');

if (offenders.length) {
  console.error('COMMIT ОТМЕНЁН — найдены секреты:');
  for (const line of offenders) console.error(`  ${line}`);
  console.error('Уберите ключи из кода, поместите их в .env и при необходимости РОТИРУЙТЕ ключ.');
  process.exit(1);
}
