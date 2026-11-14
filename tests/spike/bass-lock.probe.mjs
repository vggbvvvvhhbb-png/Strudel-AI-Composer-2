// Отладка связки бас–кик: где расходится сетка?

import { planIR } from '../../src/ir/intent.js';
import { irEvents } from '../../src/oracle/ir-events.js';

const ir = planIR('мрачный трип-хоп про дождь', { seed: 42 });
const { events, sections } = irEvents(ir);

const kicks = events.filter((e) => e.role === 'kick').slice(0, 8);
const bass = events.filter((e) => e.role === 'bass').slice(0, 8);

console.log('секции:', sections.map((s) => `${s.id}[${s.startBar}..${s.endBar}] событий=${s.events}`).join('\n         '));
console.log('KICK:', kicks.map((e) => e.t.toFixed(4)).join(' '));
console.log('BASS:', bass.map((e) => e.t.toFixed(4)).join(' '));
console.log('роли:', [...new Set(events.map((e) => e.role))].join(','));
console.log('секция кика:', kicks[0]?.section, '| секция баса:', bass[0]?.section);
console.log('ритм баса:', ir.groove.bassRhythm ?? '(из жанра)');
console.log('шаблон грува:', ir.groove.template, 'свинг:', ir.groove.swing);

// Ручной пересчёт связки — чтобы увидеть, где расходится с формулой.
const kickTimes = events.filter((e) => e.role === 'kick').map((e) => e.t);
const bassEvents = events.filter((e) => e.role === 'bass' || e.role === 'sub');
let matched = 0;
const misses = [];
for (const event of bassEvents) {
  if (kickTimes.some((kick) => Math.abs(kick - event.t) < 1 / 32)) matched += 1;
  else if (misses.length < 6) misses.push(event.t.toFixed(4));
}
console.log(`бас=${bassEvents.length} кик=${kickTimes.length} совпало=${matched} доля=${(matched / bassEvents.length).toFixed(4)}`);
console.log('первые несовпавшие:', misses.join(' '));
console.log('первые кики:', kickTimes.slice(0, 6).map((t) => t.toFixed(4)).join(' '));
