import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config, hasAnyProvider, providerIds } from './config.js';
import generateRoute from './routes/generate.js';
import fixRoute from './routes/fix.js';
import transcribeRoute from './routes/transcribe.js';
import musicRoute from './routes/music.js';
import composeRoute from './routes/compose.js';
import irRoute from './routes/ir.js';
import skillsRoute from './routes/skills.js';
import preferenceRoute from './routes/preference.js';
import tasteRoute from './routes/taste.js';
import healthRoute from './routes/health.js';
import statsRoute from './routes/stats.js';
import deepdiveRoute from './routes/deepdive.js';
import agentRoute from './routes/agent.js';
import localRoute from './routes/local.js';
import { withUsageContext } from './llm/context.js';
import { cspHeaderFor } from './security/csp.js';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '../dist');

// Мок-режим LLM (MOCK_LLM=1): ответы детерминированные, сеть не нужна.
// В этом режиме ключ не требуется — иначе сервер не поднялся бы в CI.
const mockLlm = process.env.MOCK_LLM === '1';

// Без ключа LLM сервер принимает запросы и падает на каждом из них —
// лучше не стартовать вовсе и объяснить, что поправить.
if (!hasAnyProvider() && !mockLlm) {
  console.error('[config] Не настроен ни один провайдер LLM.');
  console.error('Заполните .env: задайте ключ и модель хотя бы для одного провайдера');
  console.error(`(доступны: ${config.llmProviders.join(', ')}) и перезапустите сервер.`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // за nginx: реальный IP клиента в X-Forwarded-For
app.disable('x-powered-by');

// CSP: wasm для аудио-движка, blob: для AudioWorklet, домены сэмплов dirt-samples.
//
// Политика зависит от пути: строгая для обложки и статики, послабленная для
// страниц, где исполняется сгенерированный код. Helmet умеет только одну
// политику на всё приложение, а два заголовка CSP означают пересечение
// правил — побеждает строгая. Поэтому считаем политику сами.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    permissionsPolicy: { microphone: ['(self)'] },
  }),
);

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', cspHeaderFor(req.path));
  next();
});

// 20 запросов/мин на IP на все /api/* (draft-7 заголовки RateLimit-*).
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Подождите минуту и попробуйте снова.' },
  }),
);

app.use(express.json({ limit: '100kb' }));

// Контекст учёта стоимости: одна операция = один запрос к серверу.
// sessionId приходит от браузера (X-Strudel-Session) — по нему считается
// «цена сессии»; group — необязательная группа (ночная партия, трек).
app.use('/api', (req, res, next) => {
  withUsageContext({
    operationId: randomUUID(),
    sessionId: req.get('X-Strudel-Session') || null,
    group: req.get('X-Strudel-Group') || null,
  }, next);
});

app.use(generateRoute);
app.use(fixRoute);
app.use(transcribeRoute);
app.use(musicRoute);
app.use(composeRoute);
app.use('/api/music/ir', irRoute);
app.use('/api/skills', skillsRoute);
app.use('/api/preference', preferenceRoute);
app.use('/api/taste', tasteRoute);
app.use(healthRoute);
app.use(statsRoute);
// Режим «Разбор» — отдельный контур, не трогает существующие пути студии.
app.use(deepdiveRoute);
// Помощник-агент: планирование, вызовы инструментов, ответ — потоком SSE.
app.use('/api/agent', agentRoute);
// Локальный демон: тяжёлое считается на машине владельца (D-097).
app.use('/api/local', localRoute);

if (existsSync(distDir)) {
  // index.html — без кэша: сборка кладёт в assets файлы с хэшем в имени, и
  // старый index.html после деплоя ссылается на удалённые файлы (404 в
  // консоли, пустая страница). Хэшированные assets кэшируются на час — их
  // имя и есть версия.
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(distDir, 'index.html'));
  });
  app.use(express.static(distDir, { maxAge: '1h', index: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Не найдено' });
      return;
    }
    // Внутренние страницы (tinder.html и подобные) — тоже без кэша.
    res.set('Cache-Control', 'no-cache');
    // Путь разрешаем внутрь dist: иначе «../» в URL ушёл бы за пределы
    // каталога сборки.
    const requested = resolve(distDir, `.${req.path}`);
    const inside = requested.startsWith(resolve(distDir));
    // Прямая ссылка на разбор открывает СТУДИЮ: панель разбора живёт
    // в studio.html, а на обложке её нет. Раньше /razbor/<id> отдавал
    // обложку, и ссылка просто ничего не делала.
    const fallback = req.path.startsWith('/razbor/')
      ? join(distDir, 'studio.html')
      : join(distDir, 'index.html');
    const target = inside && existsSync(requested) && requested.endsWith('.html')
      ? requested
      : fallback;
    res.sendFile(target);
  });
}

// Тела запросов и ключи не логируем — только метод, путь и статус.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (config.env !== 'test') console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

// Ошибки JSON-парсера и прочие — без деталей тела и без стектрейсов наружу.
app.use((err, req, res, next) => {
  const status = err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : 500;
  if (status === 500) console.error(err?.message || err);
  res.status(status).json({ error: status === 500 ? 'Внутренняя ошибка сервера' : err?.message || 'Ошибка запроса' });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Strudel AI Composer: http://${config.host}:${config.port}`);
  console.log(`Провайдеры LLM: ${providerIds().join(', ')}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
