// Pre-commit: блокирует коммиты, если в индекс попали значения, похожие на API-ключи.
// Запуск: node scripts/check-secrets.js (или хук из .githooks/, см. README).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { name: 'OpenAI-style key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Groq key (gsk_…)', re: /\bgsk_[A-Za-z0-9]{20,}\b/ },
];

const ALLOW = /(^|\/)(\.env(\.local)?|package-lock\.json)$/;

let staged = [];
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
} catch {
  // вне git-репозитория — проверяем всё рабочее дерево
  staged = null;
}

const files = staged === null ? ['.', 'src', 'server', 'scripts'] : staged;
const offenders = [];

for (const file of files) {
  if (file === '.' || file === 'src' || file === 'server' || file === 'scripts') continue;
  if (ALLOW.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(content)) offenders.push(`${file}: ${name}`);
  }
}

if (offenders.length) {
  console.error('Похоже, в коммит попали секреты:');
  for (const line of offenders) console.error(`  ${line}`);
  console.error('Уберите ключи из кода: они должны жить только в .env (не коммитится).');
  process.exit(1);
}
console.log('check-secrets: чисто');
