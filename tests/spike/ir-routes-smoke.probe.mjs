// Смоук IR-маршрутов: поднимаем сервер и бьём по /api/music/ir/*.
//
// Проверяем не «отвечает ли», а СОДЕРЖАТЕЛЬНО:
//   • план собирается из описания и проходит схему;
//   • код плана исполняется движком;
//   • правка «мрачнее» меняет лад/темп и показывает дельту;
//   • поиск выдаёт кандидатов лучше базы;
//   • критик не ухудшает трек.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MOCK_LLM: '1', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (data) => process.stderr.write(data));

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  // Ждём подъёма сервера.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      await sleep(250);
    }
  }

  console.log('\n=== POST /api/music/ir/plan');
  const plan = await post('/api/music/ir/plan', { prompt: 'мрачный трип-хоп про дождь', seed: 42 });
  check('статус 200', plan.status === 200, `статус ${plan.status}`);
  check('план собран', plan.data.ok === true, plan.data.error || '');
  check('есть код', typeof plan.data.code === 'string' && plan.data.code.includes('setCpm'));
  check('есть разбор', plan.data.report?.score?.total > 0, `скор ${plan.data.report?.score?.total}`);
  check('секций ≥ 3', plan.data.report?.sections?.length >= 3, `${plan.data.report?.sections?.length}`);
  const baseScore = plan.data.report?.score?.total;

  console.log('\n=== POST /api/music/ir/transform (darker)');
  const darker = await post('/api/music/ir/transform', {
    ir: plan.data.ir,
    transform: 'darker',
    amount: 0.8,
  });
  check('статус 200', darker.status === 200, `статус ${darker.status}`);
  check('лад стал темнее', darker.data.report?.key !== plan.data.report?.key,
    `${plan.data.report?.key} → ${darker.data.report?.key}`);
  check('дельта показана', typeof darker.data.delta?.scoreBefore === 'number');
  check('ошибок линтера не больше', darker.data.report?.lintSummary?.errors <= plan.data.report?.lintSummary?.errors);

  console.log('\n=== POST /api/music/ir/transform (неизвестная)');
  const bad = await post('/api/music/ir/transform', { ir: plan.data.ir, transform: 'нетТакой' });
  check('отклонена с 400', bad.status === 400, `статус ${bad.status}`);
  check('список доступных пришлёт', Array.isArray(bad.data.available));

  console.log('\n=== POST /api/music/ir/search');
  const search = await post('/api/music/ir/search', { ir: plan.data.ir, n: 16, topK: 3 });
  check('статус 200', search.status === 200, `статус ${search.status}`);
  check('проверено 16 кандидатов', search.data.evaluated === 16, `${search.data.evaluated}`);
  check('вернулось 3 лучших', search.data.candidates?.length === 3);
  check('лучший не хуже базы', (search.data.candidates?.[0]?.score ?? 0) >= baseScore,
    `база ${baseScore}, лучший ${search.data.candidates?.[0]?.score}`);
  check('поиск быстрый', search.data.elapsedMs < 16 * 50, `${search.data.elapsedMs} мс`);

  console.log('\n=== POST /api/music/ir/critique');
  const critique = await post('/api/music/ir/critique', { ir: plan.data.ir });
  check('статус 200', critique.status === 200, `статус ${critique.status}`);
  check('скор не упал', critique.data.report?.score?.total >= baseScore,
    `${baseScore} → ${critique.data.report?.score?.total}`);
  check('шагов не больше 3', (critique.data.steps?.length ?? 0) <= 3);

  console.log('\n=== POST /api/music/ir/plan (пустой промт)');
  const empty = await post('/api/music/ir/plan', { prompt: '   ' });
  check('отклонён с 400', empty.status === 400, `статус ${empty.status}`);
} finally {
  server.kill();
}

console.log(`\n${failures === 0 ? '✅ все проверки прошли' : `❌ провалено проверок: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
