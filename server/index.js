import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, hasAnyProvider, providerIds } from './config.js';
import generateRoute from './routes/generate.js';
import fixRoute from './routes/fix.js';
import transcribeRoute from './routes/transcribe.js';
import musicRoute from './routes/music.js';
import composeRoute from './routes/compose.js';
import healthRoute from './routes/health.js';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '../dist');

// Без ключа LLM сервер принимает запросы и падает на каждом из них —
// лучше не стартовать вовсе и объяснить, что поправить.
if (!hasAnyProvider()) {
  console.error('[config] Не настроен ни один провайдер LLM.');
  console.error('Заполните .env: задайте ключ и модель хотя бы для одного провайдера');
  console.error(`(доступны: ${config.llmProviders.join(', ')}) и перезапустите сервер.`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // за nginx: реальный IP клиента в X-Forwarded-For
app.disable('x-powered-by');

// CSP: wasm для аудио-движка, blob: для AudioWorklet, домены сэмплов dirt-samples.
// unsafe-eval нужен компилятору паттернов Strudel — без него живой код не исполняется.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        // data: нужен Strudel: его AudioWorklet-модули (sample-generator,
        // recorder, эффекты) приходят как data:text/javascript;base64.
        // Без него в консоли «could not load AudioWorklet effects».
        'script-src': [
          "'self'",
          "'unsafe-eval'",
          "'wasm-unsafe-eval'",
          "'unsafe-inline'",
          'blob:',
          'data:',
        ],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:', 'https://raw.githubusercontent.com'],
        'connect-src': [
          "'self'",
          'blob:',
          'https://raw.githubusercontent.com',
          'https://shabda.ndre.gr',
          'https://*.githubusercontent.com',
        ],
        'worker-src': ["'self'", 'blob:'],
        'child-src': ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    permissionsPolicy: { microphone: ['(self)'] },
  }),
);

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

app.use(generateRoute);
app.use(fixRoute);
app.use(transcribeRoute);
app.use(musicRoute);
app.use(composeRoute);
app.use(healthRoute);

if (existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h' }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Не найдено' });
      return;
    }
    res.sendFile(join(distDir, 'index.html'));
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
