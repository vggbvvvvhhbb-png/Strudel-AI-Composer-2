import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Промпты подгружаются один раз при старте сервера (раздел 5 ТЗ).
const promptsDir = join(dirname(fileURLToPath(import.meta.url)), 'prompts');

function load(name) {
  return readFileSync(join(promptsDir, name), 'utf8').trim();
}

export const prompts = {
  system: load('system.md'),
  improve: load('improve.md'),
  fix: load('fix.md'),
  critic: load('critic.md'),
};
