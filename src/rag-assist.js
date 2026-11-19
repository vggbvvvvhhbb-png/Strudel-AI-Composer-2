// Панель «Музыкальный интеллект» (D-140): образованный ассистент с RAG
// и петлёй self-correction + детерминированное объяснение кода.
// Шаги видны отдельно от обоснования; код применяется только по кнопке.

export function initRagAssist({ getCode, setCode }) {
  const $ = (id) => document.getElementById(id);
  const input = $('rag-input');
  const stepsEl = $('rag-steps');
  const rationaleEl = $('rag-rationale');
  const explainEl = $('rag-explain-out');
  const applyBtn = $('rag-apply');
  const generateBtn = $('rag-generate');
  const explainBtn = $('rag-explain');
  if (!input || !generateBtn) return;

  let pendingCode = null;

  fetch('/api/rag/status')
    .then((r) => r.json())
    .then((s) => {
      const store = s.store === 'supabase' ? 'Supabase + pgvector' : 'локальная база';
      const emb = s.embeddings ? 'эмбеддинги включены' : 'семантика недоступна — лексический поиск';
      const n = s.entries >= 0 ? `${s.entries} записей` : 'база недоступна';
      $('rag-status').textContent = `${store}, ${n}, ${emb}.`;
    })
    .catch(() => { $('rag-status').textContent = 'статус базы недоступен.'; });

  function step(text, kind = '') {
    const div = document.createElement('div');
    div.className = `agent-step ${kind}`.trim();
    div.textContent = text;
    stepsEl.appendChild(div);
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  generateBtn.addEventListener('click', async () => {
    const request = input.value.trim();
    if (!request) { input.focus(); return; }
    stepsEl.textContent = '';
    rationaleEl.textContent = '';
    explainEl.textContent = '';
    applyBtn.hidden = true;
    pendingCode = null;
    generateBtn.disabled = true;
    step('Ищу примеры в базе знаний…');
    try {
      const r = await post('/api/rag/assist', { request, currentCode: getCode() });
      if (r.search) {
        step(`Поиск: стадия ${r.search.stage}${r.search.degraded ? ' (фильтры ослаблены)' : ''}, примеры: ${(r.search.results || []).map((x) => x.entry.id).join(', ') || 'нет'}`);
      }
      for (const h of r.history || []) {
        step(`Попытка ${h.attempt}: ${h.ok ? 'код валиден' : `отклонена — ${(h.errors || []).map((e) => e.class).join(', ')}`}`, h.ok ? 'ok' : 'fail');
      }
      if (r.ok) {
        pendingCode = r.code;
        rationaleEl.textContent = r.rationale || 'Обоснование не получено.';
        applyBtn.hidden = false;
        step(`Готово за ${r.attempts} попыт.${r.semantic ? '' : ' Семантический поиск был недоступен — выдача лексическая.'}`, 'ok');
      } else {
        rationaleEl.textContent = `Честный отказ: ${r.reason || 'неизвестная причина'}`;
        step('Код не применён — валидатор не пропустил ни одну попытку.', 'fail');
      }
    } catch (err) {
      rationaleEl.textContent = `Ассистент недоступен: ${err.message}`;
    } finally {
      generateBtn.disabled = false;
    }
  });

  explainBtn.addEventListener('click', async () => {
    explainEl.textContent = '';
    const code = getCode();
    if (!code.trim()) { explainEl.textContent = 'Код пуст — объяснять нечего.'; return; }
    try {
      const r = await post('/api/rag/explain', { code });
      explainEl.textContent = r.ok ? r.lines.join('\n') : (r.reason || 'Не удалось разобрать код.');
    } catch (err) {
      explainEl.textContent = `Объяснение недоступно: ${err.message}`;
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!pendingCode) return;
    setCode(pendingCode);
    applyBtn.hidden = true;
    step('Код применён к редактору.', 'ok');
  });
}