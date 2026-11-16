// Панель локального счёта (фаза B/F, D-097).
//
// Кнопка «Считать локально» ставит рендер в очередь демона на машине
// владельца. Прогресс идёт по SSE, очередь видна, готовый WAV можно
// прослушать прямо здесь — токен демона остаётся на сервере, браузер
// ходит только через /api/local/*.
//
// ЧЕСТНОСТЬ. Демон не настроен или не отвечает — панель так и говорит.
// ETA не выдумывается: если демон его не прислал, показываем причину.

const STATE_LABELS = {
  queued: 'в очереди',
  running: 'считается',
  done: 'готово',
  error: 'ошибка',
};

/**
 * @param {{getCode:() => string}} options
 */
export function initLocalPanel({ getCode }) {
  const statusEl = document.getElementById('local-status');
  const button = document.getElementById('btn-local-render');
  const barsSelect = document.getElementById('local-bars');
  const progressWrap = document.getElementById('local-progress-wrap');
  const progressBar = document.getElementById('local-progress-bar');
  const stageEl = document.getElementById('local-stage');
  const queueEl = document.getElementById('local-queue');
  const audioEl = document.getElementById('local-audio');
  if (!statusEl || !button) return;

  let available = false;
  let activeSource = null;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/local/status');
      const body = await res.json();
      available = Boolean(body.available);
      button.disabled = !available;
      if (!body.configured) {
        setStatus('Демон не настроен: задайте LOCAL_DAEMON_URL и LOCAL_DAEMON_TOKEN (local/README.md).');
        return;
      }
      if (!available) {
        setStatus(`Демон настроен, но не отвечает: ${body.reason ?? 'причина неизвестна'}`);
        return;
      }
      const machine = body.machine
        ? `${body.machine.cpus} CPU, ${Math.round((body.machine.totalMemMb ?? 0) / 1024)} ГБ RAM`
        : 'машина не представилась';
      const analysis = body.analysis?.available
        ? 'анализ доступен'
        : `анализ недоступен (${body.analysis?.reason ?? 'Python-воркер не запущен'})`;
      setStatus(`Демон на связи: ${machine}; ${analysis}.`);
      await refreshQueue();
    } catch (err) {
      available = false;
      button.disabled = true;
      setStatus(`Статус демона не получен: ${err?.message || err}`);
    }
  }

  async function refreshQueue() {
    if (!queueEl) return;
    try {
      const res = await fetch('/api/local/tasks');
      if (!res.ok) return;
      const body = await res.json();
      const tasks = (body.tasks ?? []).slice(0, 6);
      queueEl.replaceChildren();
      if (!tasks.length) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'Очередь пуста.';
        queueEl.append(hint);
        return;
      }
      for (const task of tasks) {
        const row = document.createElement('div');
        row.className = `local-task${task.state === 'done' ? ' is-done' : ''}${task.state === 'error' ? ' is-error' : ''}`;
        const state = STATE_LABELS[task.state] ?? task.state;
        const position = task.state === 'queued' && task.position != null ? ` (место ${task.position + 1})` : '';
        const duration = task.finishedAt && task.startedAt
          ? ` · ${((task.finishedAt - task.startedAt) / 1000).toFixed(1)} с`
          : '';
        row.textContent = `${task.type} — ${state}${position}${duration}`;
        if (task.state === 'error' && task.error) row.title = task.error;
        // Готовый рендер можно прослушать и после перезагрузки страницы:
        // клик по строке очереди загружает WAV в плеер панели.
        if (task.state === 'done' && task.type === 'render' && task.result?.wavPath) {
          row.title = 'Нажмите, чтобы прослушать рендер';
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            if (audioEl) {
              audioEl.src = `/api/local/tasks/${encodeURIComponent(task.id)}/audio`;
              audioEl.hidden = false;
            }
          });
        }
        queueEl.append(row);
      }
    } catch {
      // Очередь не критична: статус демона уже показан.
    }
  }

  function showProgress(stage, message, eta, etaReason) {
    if (progressWrap) progressWrap.hidden = false;
    if (progressBar) {
      // Численного процента у рендера нет: полоска показывает стадию,
      // а не выдуманный прогресс. Финал — 100 %.
      progressBar.style.width = stage === 'done' ? '100%' : stage === 'render' ? '60%' : '20%';
    }
    if (stageEl) {
      const etaText = Number.isFinite(eta) ? ` · осталось ~${Math.round(eta)} с` : (etaReason ? ` · ${etaReason}` : '');
      stageEl.textContent = `${message ?? stage}${etaText}`;
    }
  }

  function finishTask(task) {
    button.disabled = !available;
    if (activeSource) {
      activeSource.close();
      activeSource = null;
    }
    if (task.state === 'done') {
      showProgress('done', 'Рендер готов', null, null);
      const result = task.result ?? {};
      const seconds = result.wallMs != null ? `${(result.wallMs / 1000).toFixed(1)} с` : 'время не замерено';
      // fingerprint — объект паспорта рендера; короткая подпись — хэш кода.
      const hash = result.fingerprint?.code_sha256;
      const fingerprint = hash ? ` · код ${String(hash).slice(0, 12)}` : '';
      if (stageEl) stageEl.textContent = `Готово за ${seconds}${fingerprint}`;
      if (audioEl) {
        audioEl.src = `/api/local/tasks/${encodeURIComponent(task.id)}/audio`;
        audioEl.hidden = false;
      }
    } else {
      if (progressWrap) progressWrap.hidden = true;
      setStatus(`Задача упала: ${task.error ?? 'причина неизвестна'}`);
    }
    refreshQueue();
  }

  function watchTask(id) {
    // SSE может оборваться (прокси, сон машины) — тогда опрашиваем статус,
    // а не притворяемся, что задача пропала.
    let settled = false;
    const source = new EventSource(`/api/local/tasks/${encodeURIComponent(id)}/stream`);
    activeSource = source;
    const handle = (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === 'progress') {
        showProgress(data.stage, data.message, data.eta, data.etaReason);
      } else if (data.type === 'snapshot' && data.task) {
        if (data.task.state === 'done' || data.task.state === 'error') {
          settled = true;
          finishTask(data.task);
        } else if (data.task.state === 'running') {
          showProgress('render', 'Задача в работе', null, null);
        }
      } else if ((data.type === 'done' || data.type === 'error') && data.task) {
        settled = true;
        finishTask(data.task);
      }
    };
    source.addEventListener('snapshot', handle);
    source.addEventListener('progress', handle);
    source.addEventListener('done', handle);
    source.addEventListener('error', (event) => {
      if (event.data) {
        handle(event);
        return;
      }
      // Обрыв соединения: переходим на опрос статуса.
      source.close();
      if (activeSource === source) activeSource = null;
      if (!settled) pollTask(id);
    });
  }

  async function pollTask(id) {
    if (stageEl) stageEl.textContent = 'Стрим прогресса оборвался — опрашиваем статус задачи…';
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const res = await fetch(`/api/local/tasks/${encodeURIComponent(id)}`);
        if (!res.ok) continue;
        const { task } = await res.json();
        if (task?.state === 'done' || task?.state === 'error') {
          finishTask(task);
          return;
        }
      } catch {
        // Демон мог уснуть — продолжаем опрос до дедлайна.
      }
    }
    button.disabled = !available;
    setStatus('Задача не завершилась за 15 минут опроса — проверьте демон.');
  }

  button.addEventListener('click', async () => {
    const code = String(getCode() ?? '').trim();
    if (!code) {
      setStatus('Редактор пуст: сначала опишите трек или вставьте код.');
      return;
    }
    button.disabled = true;
    if (audioEl) audioEl.hidden = true;
    showProgress('queue', 'Ставим задачу в очередь демона…', null, null);
    try {
      const res = await fetch('/api/local/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'render',
          payload: { code, fromCycle: 0, toCycle: Number(barsSelect?.value ?? 16) },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        button.disabled = !available;
        if (progressWrap) progressWrap.hidden = true;
        setStatus(`Демон отказал: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setStatus(`Задача ${body.id.slice(0, 8)} принята демоном.`);
      refreshQueue();
      watchTask(body.id);
    } catch (err) {
      button.disabled = !available;
      if (progressWrap) progressWrap.hidden = true;
      setStatus(`Задача не ушла: ${err?.message || err}`);
    }
  });

  refreshStatus();
}