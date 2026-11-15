// Задачи локального демона.
//
// ГЛАВНОЕ ПРАВИЛО: демон НЕ ПИШЕТ СВОЙ РЕНДЕР И НЕ ПИШЕТ СВОЙ АНАЛИЗ.
// Он вызывает те же модули, что и сервер:
//   • рендер  — server/deepdive/render/render-worker.mjs (headless Chromium,
//     тот же движок Strudel, тот же DSP, тот же renderFingerprint);
//   • анализ и разделение — server/deepdive/analysis/client.js (Python-воркер
//     с Demucs).
// Иначе «локальный» результат отличался бы от серверного, а сравнивать их
// было бы бессмысленно: гейт B требует совпадения fingerprint.
//
// ЧЕСТНОСТЬ ДОСТУПНОСТИ. Если Python-воркер на машине не запущен (нет numpy,
// нет torch, нет demucs), демон НЕ притворяется, что умеет разделение: задача
// падает с понятной причиной, а /health честно показывает, что разделение
// недоступно.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createRenderWorker } from '../server/deepdive/render/render-worker.mjs';
import { analyzeFile, analyzeStems, separateStems } from '../server/deepdive/analysis/client.js';

/**
 * sha256 файла — для побайтового сравнения рендеров.
 * @param {Buffer} buffer
 * @returns {string}
 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Проверяет, доступен ли Python-воркер анализа.
 * @param {{baseUrl?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{available:boolean, reason?:string, details?:object}>}
 */
export async function probeAnalysisWorker(options = {}) {
  const baseUrl = options.baseUrl || process.env.DD_WORKER_URL || 'http://127.0.0.1:8010';
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (!res.ok) return { available: false, reason: `воркер ответил HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return {
      available: true,
      details: {
        demucs_available: Boolean(body?.models?.demucs_available),
        separation_model: body?.models?.separation ?? null,
        python: body?.python ?? null,
      },
    };
  } catch (err) {
    return {
      available: false,
      reason: `Python-воркер не отвечает (${baseUrl}): ${err?.message || err}`,
    };
  }
}

/**
 * Создаёт реестр задач демона.
 *
 * @param {{stateDir:string, renderFactory?:Function, analysisProbe?:Function}} options
 */
export function createTaskRegistry({ stateDir, renderFactory = createRenderWorker, analysisProbe = probeAnalysisWorker }) {
  /** @type {object|null} */
  let renderWorker = null;
  let renderWorkerPromise = null;

  /**
   * Chromium-воркер поднимается один раз и живёт: поднимать браузер на каждый
   * рендер — это минуты на старте, а рендеров ночью десятки.
   * @returns {Promise<object>}
   */
  async function getRenderWorker() {
    if (renderWorker) return renderWorker;
    if (!renderWorkerPromise) {
      renderWorkerPromise = renderFactory().then((worker) => {
        renderWorker = worker;
        return worker;
      }).catch((err) => {
        renderWorkerPromise = null;
        throw err;
      });
    }
    return renderWorkerPromise;
  }

  const tasks = {
    /**
     * Рендер кода в WAV тем же движком, что и на сервере.
     *
     * @param {object} payload {code, fromCycle, toCycle, sampleRate, cps, outPath}
     * @param {{progress:(event:object)=>void}} helpers
     */
    async render(payload, helpers) {
      const code = String(payload?.code ?? '');
      if (!code.trim()) throw new Error('render: нужен код трека (code)');
      const fromCycle = Number(payload?.fromCycle ?? 0);
      const toCycle = Number(payload?.toCycle ?? 16);
      helpers.progress({ stage: 'browser', message: 'Поднимаем браузер с движком' });
      const worker = await getRenderWorker();
      helpers.progress({
        stage: 'render',
        message: `Рендерим такты ${fromCycle}…${toCycle}`,
        eta: null,
        etaReason: 'ETA считается по факту: рендер идёт одним заходом, заранее он неизвестен',
      });
      const started = Date.now();
      const result = await worker.render({
        code,
        fromCycle,
        toCycle,
        sampleRate: payload?.sampleRate,
        cps: payload?.cps,
        wantWav: payload?.wantWav !== false,
        wantEvents: payload?.wantEvents !== false,
      });
      const wallMs = Date.now() - started;

      let wavPath = null;
      let wavSha256 = null;
      if (result.wav && payload?.outPath) {
        wavPath = path.resolve(String(payload.outPath));
        await mkdir(path.dirname(wavPath), { recursive: true });
        await writeFile(wavPath, result.wav);
        wavSha256 = sha256(result.wav);
      }

      return {
        ok: true,
        renderMs: result.renderMs,
        wallMs,
        durationS: result.durationS,
        sampleRate: result.sampleRate,
        report: result.report,
        events: result.events ?? null,
        fingerprint: result.fingerprint,
        wavPath,
        wavSha256,
        wavBytes: result.wav ? result.wav.length : 0,
      };
    },

    /**
     * Базовый анализ файла (темп, лад, громкость, структура) — Python-воркер.
     * @param {object} payload {path}
     */
    async analyze(payload) {
      const filePath = String(payload?.path ?? '');
      if (!filePath) throw new Error('analyze: нужен путь к файлу (path)');
      const result = await analyzeFile(filePath, {
        stage: 'analyze',
        timeoutMs: payload?.timeoutMs,
      });
      return { ok: true, ...result };
    },

    /**
     * Разделение на стемы (Demucs) — Python-воркер. Долгая операция.
     * @param {object} payload {path, outDir, model}
     * @param {{progress:(event:object)=>void}} helpers
     */
    async separate(payload, helpers) {
      const filePath = String(payload?.path ?? '');
      if (!filePath) throw new Error('separate: нужен путь к файлу (path)');
      const outDir = String(payload?.outDir ?? path.join(stateDir, 'stems'));
      helpers.progress({
        stage: 'separate',
        message: 'Разделяем на стемы (Demucs) — самая долгая операция',
        eta: null,
        etaReason: 'ETA неизвестен: скорость Demucs зависит от модели и железа, замеров на этой машине ещё нет',
      });
      const result = await separateStems(filePath, outDir, {
        model: payload?.model || 'htdemucs',
        stage: 'separate',
        timeoutMs: payload?.timeoutMs,
      });
      return { ok: true, ...result };
    },

    /**
     * Дескрипторы слоёв по стемам — Python-воркер.
     * Контракт как у сервера: карта «имя слоя → путь к файлу» и секции.
     * @param {object} payload {stems: Record<string,string>, sections: Array}
     */
    async analyze_stems(payload) {
      const stems = payload?.stems ?? null;
      if (!stems || typeof stems !== 'object' || !Object.keys(stems).length) {
        throw new Error('analyze_stems: нужна карта стемов (stems: {имя: путь})');
      }
      const result = await analyzeStems(stems, Array.isArray(payload?.sections) ? payload.sections : [], {
        stage: 'stems',
        timeoutMs: payload?.timeoutMs,
      });
      return { ok: true, ...result };
    },
  };

  return {
    tasks,

    /** @returns {string[]} */
    types() {
      return Object.keys(tasks);
    },

    /**
     * Здоровье демона: что умеем, что доступно на этой машине.
     * @returns {Promise<object>}
     */
    async health() {
      const analysis = await analysisProbe();
      return {
        tasks: Object.keys(tasks),
        analysis: {
          available: analysis.available,
          reason: analysis.reason ?? null,
          ...(analysis.details ?? {}),
        },
        render: {
          available: true,
          engine: 'strudel-engine в headless Chromium',
          note: 'тот же движок и тот же renderFingerprint, что и на сервере',
        },
      };
    },

    /** Закрывает браузер. */
    async close() {
      if (renderWorker) {
        await renderWorker.close().catch(() => {});
        renderWorker = null;
        renderWorkerPromise = null;
      }
    },
  };
}
