// Маршруты «музыкального интеллекта» (D-140, фаза G): образованный
// ассистент с RAG и петлёй self-correction, детерминированное объяснение
// кода. Хранилище: Supabase при заданных env, иначе локальный датасет
// (честная деградация, статус виден в /api/rag/status).

import { Router } from 'express';
import { loadDataset } from '../rag/dataset.js';
import { LocalKnowledgeStore } from '../rag/store-local.js';
import { SupabaseKnowledgeStore } from '../rag/store-supabase.js';
import { withClient } from '../rag/db.js';
import { embedQuery, embeddingsAvailable } from '../rag/embeddings.js';
import { runCorrectionLoop } from '../rag/loop.js';
import { explainCode } from '../rag/explain.js';
import { loadTimbreCatalog } from '../samples/timbre.js';
import { completeChat } from '../llm/client.js';
import { PROMPT_VERSION } from '../rag/prompt.js';

const router = Router();
const catalog = loadTimbreCatalog();

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_USER && process.env.SUPABASE_DB_PASSWORD);
}

async function withStore(fn) {
  if (supabaseConfigured()) {
    return withClient((client) => fn(new SupabaseKnowledgeStore(client), 'supabase'));
  }
  const { entries } = loadDataset();
  return fn(new LocalKnowledgeStore(entries), 'local');
}

router.get('/api/rag/status', async (_req, res) => {
  const embeddings = await embeddingsAvailable();
  const store = supabaseConfigured() ? 'supabase' : 'local';
  let entries = 0;
  try {
    entries = await withStore((s) => s.count());
  } catch {
    entries = -1; // БД сконфигурирована, но недоступна — честно «нет данных»
  }
  res.json({ ok: true, store, embeddings, entries, promptVersion: PROMPT_VERSION });
});

router.post('/api/rag/assist', async (req, res) => {
  const { request, currentCode = '', filters = {}, maxAttempts = 3 } = req.body || {};
  if (typeof request !== 'string' || !request.trim() || request.length > 2000) {
    return res.status(400).json({ ok: false, error: 'request — непустая строка до 2000 символов' });
  }
  const attempts = Math.max(1, Math.min(5, Number(maxAttempts) || 3));
  try {
    const emb = await embedQuery(request);
    const result = await withStore((store, storeKind) => runCorrectionLoop({
      request: request.trim(),
      currentCode: typeof currentCode === 'string' ? currentCode.slice(0, 20000) : '',
      store,
      filters,
      queryEmbedding: emb.ok ? emb.embedding : null,
      catalog,
      maxAttempts: attempts,
      callModel: (messages) => completeChat({ messages, feature: 'rag-assist', temperature: 0.3 }),
    }).then((r) => ({ ...r, store: storeKind, semantic: emb.ok })));
    res.json(result);
  } catch (err) {
    res.status(503).json({ ok: false, error: `ассистент недоступен: ${err.message}` });
  }
});

router.post('/api/rag/explain', (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ ok: false, error: 'code — непустая строка' });
  }
  res.json(explainCode(code.slice(0, 20000)));
});

export default router;