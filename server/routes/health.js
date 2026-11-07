import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

const router = Router();

const pkg = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
);

router.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: pkg.version,
    // Фронт прячет кнопку микрофона, если ключа распознавания нет.
    features: { voice: Boolean(config.groqApiKey) },
  });
});

export default router;
