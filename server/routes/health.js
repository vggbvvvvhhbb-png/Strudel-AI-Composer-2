import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const router = Router();

const pkg = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
);

router.get('/api/health', (req, res) => {
  res.json({ ok: true, version: pkg.version });
});

export default router;
