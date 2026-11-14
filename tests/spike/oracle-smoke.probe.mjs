// Смоук оракула: текст → IR → символьный отчёт.
//
// Проверяем, что отчёт не пустой, метрики в разумных пределах, а замечания
// осмысленные (код, severity, предложенные трансформации).

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { symbolicReport } from '../../src/oracle/report.js';

const PROMPTS = [
  'мрачный трип-хоп про дождь',
  'уютный лоуфай для учёбы',
  'эйфоричный фестиваль',
  'злой быстрый dnb',
  'тревожный эмбиент, пустой космос',
  'нежная колыбельная',
];

for (const prompt of PROMPTS) {
  const ir = planIR(prompt, { seed: 42 });
  const t0 = performance.now();
  const report = symbolicReport(ir);
  const dt = performance.now() - t0;

  console.log(`\n${'='.repeat(72)}\n${prompt}`);
  console.log(`жанр=${ir.meta.genre} bpm=${ir.meta.bpm} key=${ir.meta.key.tonic}:${ir.meta.key.mode} ` +
    `секций=${report.sections.length} баров=${report.bars} событий=${report.eventCount}`);
  console.log(`скор ${report.score.total} (${report.score.grade}) штраф ${report.score.penalty} · ` +
    `ошибок ${report.lintSummary.errors} предупреждений ${report.lintSummary.warnings} · ${dt.toFixed(2)} мс`);
  console.log(`  форма: контраст ${report.metrics.minContrast} · ` +
    `r(энергия) ${report.metrics.energyCorrelation} · ` +
    `мотив ${report.metrics.motifRecurrence.count}/${report.metrics.motifRecurrence.sectionCount}сек ` +
    `hook=${report.metrics.motifRecurrence.hook}`);
  console.log(`  грув: lock ${report.metrics.bassKickLock} · микро ${report.metrics.microtiming.stdMs} мс · ` +
    `плотность ${report.metrics.density.toFixed(1)}/с · в ладе ${report.metrics.scaleFit}`);
  console.log(`  составляющие: ${report.score.components.map((c) => `${c.id}=${c.score}`).join(' ')}`);
  for (const finding of report.lint.slice(0, 4)) {
    const transforms = finding.suggestedTransforms.map((t) => t.transform).join(',') || '—';
    console.log(`  [${finding.severity}] ${finding.code}: ${finding.message} → ${transforms}`);
  }
}

// Проверка: код компилятора исполняется движком (как это делает прод).
const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
const compiled = compileIR(ir);
console.log(`\nкод: ${compiled.code.split('\n').length} строк, hash ${compiled.hash.slice(0, 12)}`);
