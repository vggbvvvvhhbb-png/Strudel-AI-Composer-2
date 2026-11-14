// Что видит модель: системный промпт, разбор её ответа и сборка payload.
//
// Модель получает ТОЛЬКО JSON измерений и JSON метрик. Никаких аудиофайлов,
// никаких стектрейсов, никаких путей к файлам (см. sanitize).

import { groupsOf, round4 } from './helpers.js';
import { LAYERS, OP_RULES } from './ops.js';
import { sanitize } from './sanitize.js';

/** Системный промпт цикла самоулучшения. */
export const REFINE_SYSTEM_PROMPT = `Ты — редактор ПЛАНА музыкального трека для Strudel (https://strudel.cc).

Тебе дают три вещи:
1. JSON измерений оригинала (темп, лад, громкость, сетка ударов, ноты баса, аккорды);
2. JSON метрик сравнения код-двойника с оригиналом (общая оценка и оценки по слоям);
3. краткую сводку плана (TrackSpec) и список допустимых значений.

Твоя задача — предложить ТИПИЗИРОВАННЫЕ ПРАВКИ ПЛАНА, чтобы двойник лучше совпадал с оригиналом.

Правила ответа:
- Отвечай ТОЛЬКО одним JSON-объектом вида {"operations": [ {...} ]}. Без пояснений, без markdown-обёрток, без текста вокруг.
- Каждая операция — объект {"op": "<имя операции>", ...поля}. Список операций и их поля — в блоке allowed_operations.
- НИКАКОГО Strudel-кода: код собирается из плана компилятором, а не тобой.
- НИКАКОГО свободного текста: план принимает только операции из белого списка.
- Не выдумывай числа. Значение операции должно подтверждаться тем, что есть в измерениях: темп — только из measurements.tempo, ноты — только из измеренных нот, шаги — только из измеренной сетки, громкость — в диапазоне 0..2. Операции вне этого будут отклонены и ничего не изменят.
- Правь только то, что видно по метрикам, и не ломай то, что уже хорошо.
- Если по метрикам нечего менять — верни {"operations": []}.

Примеры формата операций:
{"op": "set_bpm", "value": 92}
{"op": "set_layer_gain", "layer": "drums", "value": 0.7}
{"op": "set_group_gain", "layer": "drums", "role": "kick", "group": 0, "value": 0.85}
{"op": "set_group_late", "layer": "drums", "role": "snare", "group": 0, "value": 8}
{"op": "set_layer_enabled", "layer": "bass", "value": false}
{"op": "set_group_steps", "layer": "drums", "role": "hats", "group": 0, "steps": [0, 4, 8, 12]}
{"op": "set_note_pattern", "layer": "bass", "value": "c2 ~ c2 ~"}`;

/**
 * Разбор ответа модели в список операций.
 * @throws {Error} если ответ не JSON или в нём нет списка операций
 */
export function parseModelOperations(raw) {
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  text = String(text).trim();
  if (!text) throw new Error('пустой ответ модели');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`невалидный JSON: ${err?.message ?? err}`);
  }
  let operations = null;
  if (Array.isArray(data)) {
    operations = data;
  } else if (data && typeof data === 'object') {
    operations = data.operations ?? data.ops ?? data.changes ?? null;
    if (operations === null && typeof data.op === 'string') operations = [data];
  }
  if (!Array.isArray(operations)) {
    throw new Error('в ответе нет списка операций (ожидался ключ operations)');
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Что видит модель
// ---------------------------------------------------------------------------

function planSummary(plan) {
  const roles = {};
  for (const [role, part] of Object.entries(plan?.parts?.roles ?? {})) {
    roles[role] = {
      activeIn: part.activeIn,
      pattern: part.pattern,
      groups: groupsOf(part).map(({ group, index }) => ({
        index,
        sample: group.sample,
        steps: group.steps,
        gain: group.gain,
        lateMs: group.lateMs ?? 0,
      })),
    };
  }
  return {
    bpm: plan?.meta?.bpm,
    key: plan?.meta?.key,
    style: plan?.meta?.style,
    sections: (plan?.structure?.sections ?? []).map((section) => ({
      name: section.name,
      cycles: section.cycles,
      energy: section.energy,
    })),
    roles,
  };
}

/** Описание белого списка операций для промпта. */
function describeOperations() {
  return Object.entries(OP_RULES).map(([op, rule]) => ({
    op,
    fields: rule.fields,
    rule: rule.rule,
  }));
}

/**
 * Полезная нагрузка для модели: только JSON измерений и метрик плюс
 * разрешённые значения. Никакого аудио, никаких путей.
 */
export function buildModelPayload({ iteration, baseline, current, measurements, stems, plan, ctx }) {
  const tolerance = ctx.options.bpmTolerancePct / 100;
  const measured = ctx.measuredBpm;
  const bpmRange = measured === null
    ? null
    : { measured, min: round4(measured * (1 - tolerance)), max: round4(measured * (1 + tolerance)) };
  const stemView = {
    drums: {
      grid_step: stems?.drums?.onsets?.grid?.step ?? null,
      swing: stems?.drums?.onsets?.swing ?? null,
      hit_count: Number(stems?.drums?.onsets?.count ?? (stems?.drums?.onsets?.hits ?? []).length) || null,
      measured_steps_by_role: ctx.measuredStepsByRole,
    },
    bass: {
      measured_note_names: [...ctx.measuredBassNotes].sort(),
    },
    other: {
      chords: sanitize(stems?.other?.chords ?? []),
    },
  };
  return {
    iteration,
    task: 'предложить типизированные правки плана, чтобы код-двойник лучше совпадал с оригиналом',
    measurements: { ...sanitize(measurements ?? {}), stems: stemView },
    metrics: {
      baseline: { overall: baseline.overall, layers: baseline.layers },
      current: { overall: current.overall, layers: current.layers },
      improvement_vs_baseline: round4(current.overall - baseline.overall),
    },
    plan: planSummary(plan),
    allowed_values: {
      bpm: bpmRange,
      gain: { min: ctx.options.gainMin, max: ctx.options.gainMax },
      layers: LAYERS,
      roles: Object.keys(plan?.parts?.roles ?? {}),
      late_ms: { tolerance: ctx.options.lateToleranceMs },
    },
    allowed_operations: describeOperations(),
    rules: [
      'отвечай только JSON: {"operations": [...]}',
      'каждое значение должно подтверждаться измерениями',
      'операции вне белого списка будут отклонены',
      'не возвращай код и не возвращай текст',
    ],
  };
}
