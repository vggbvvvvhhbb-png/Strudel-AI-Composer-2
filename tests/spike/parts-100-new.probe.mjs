#!/usr/bin/env node
// Проверка: после новой схемы идентичности (D-100) трек из 100 дорожек
// проходит схему и компилируется в 100 меток.
//
// ЗАПУСК: node tests/spike/parts-100-new.probe.mjs

import { TrackSpecSchema } from '../../src/schemas/track-spec.schema.js';
import { StudioSpecSchema, projectFromSpec } from '../../src/studio/model.js';
import { compileProject } from '../../src/studio/compile.js';
import { compileTrackSpec } from '../../server/music/compiler/index.js';
import { parseParts, captureMixer } from '../../src/core/code-model.js';

const TARGET = 100;

const spec = {
  meta: { style: 'cinematic', key: 'Cmin', bpm: 90 },
  structure: {
    sections: [
      { name: 'intro', cycles: 8, energy: 0.3, harmony: 'Cm' },
      { name: 'drop', cycles: 8, energy: 0.9, harmony: 'Cm Gm' },
    ],
  },
  parts: {
    roles: Object.fromEntries(Array.from({ length: TARGET }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return [`P${n}`, {
        role: i % 3 === 0 ? 'pad' : i % 3 === 1 ? 'lead' : 'bass',
        activeIn: ['intro', 'drop'],
        pattern: '0 ~ 2 ~',
        sound: 'sawtooth',
      }];
    })),
  },
};

const parsed = TrackSpecSchema.safeParse(spec);
console.log('TrackSpec 100 частей:', parsed.success ? 'ПРИНЯТО' : `ОТКЛОНЕНО — ${parsed.error?.issues?.[0]?.message}`);

const studio = StudioSpecSchema.safeParse(spec);
console.log('StudioSpec 100 частей:', studio.success ? 'ПРИНЯТО' : `ОТКЛОНЕНО — ${studio.error?.issues?.[0]?.message}`);

if (!parsed.success) process.exit(1);

const code = compileTrackSpec(parsed.data);
const labels = code.split('\n').filter((line) => /^\$[A-Z][A-Z0-9_]*:/.test(line));
console.log(`Компиляция: меток ${labels.length}, первые ${labels.slice(0, 3).join(' ')}`);

const parsedParts = parseParts(code);
console.log(`Разбор кода: партий ${parsedParts.length}, микшер ${captureMixer(code).length}`);

const model = projectFromSpec(parsed.data, { id: 'probe-100' });
const compiled = compileProject(model);
console.log(`Проект студии: частей в плане ${compiled.plan.parts.length}, mix-ключей ${Object.keys(model.mix.parts).length}`);
console.log(`Первые метки плана: ${compiled.plan.parts.slice(0, 3).map((p) => `${p.id}/${p.role}/${p.label}`).join(', ')}`);
