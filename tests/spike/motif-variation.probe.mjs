// Проверка: варьируется ли мотив по секциям в скомпилированном коде?

import { planIR } from '../../src/ir/intent.js';
import { compileIR } from '../../src/ir/compiler.js';
import { symbolicReport } from '../../src/oracle/report.js';

const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
const compiled = compileIR(ir);

console.log('--- строки LEAD в коде ---');
for (const line of compiled.code.split('\n')) {
  if (line.startsWith('const LEAD')) console.log(line.slice(0, 110));
}

const report = symbolicReport(ir);
console.log('\n--- повторяемость мотива ---');
console.log(JSON.stringify(report.metrics.motifRecurrence, null, 2));
console.log('фразы:', JSON.stringify(report.metrics.phraseClosure, null, 2));
