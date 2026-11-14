// Экспорт двойника в MIDI: ударные и бас.
//
// ЗАЧЕМ. Пользователь должен унести результат в DAW. MIDI — единственный
// формат, который понимают и Ableton, и FL Studio, и не требует от нас
// писать ни .als, ни .flp.
//
// ЧЕСТНО. Экспортируются ИЗМЕРЕННЫЕ ноты: удары с их GM-номерами и динамикой,
// ноты баса с питч-трека. Вокал не экспортируется — его нет.
//
// Формат: MIDI-файл типа 0, 480 тиков на четверть, нота 9 (ударные) и 0 (бас).

const TICKS_PER_QUARTER = 480;

function variableLength(value) {
  let buffer = value & 0x7f;
  let out = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return out;
}

function chunk(id, body) {
  const length = body.length;
  return [
    ...id.split('').map((char) => char.charCodeAt(0)),
    (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff,
    ...body,
  ];
}

function pushEvent(events, deltaTicks, data) {
  events.push(...variableLength(Math.max(0, Math.round(deltaTicks))), ...data);
}

/**
 * Собирает MIDI-файл из измерений.
 *
 * @param {{bpm?:number, drums?:{hits?:Array}, bass?:{notes?:Array}, name?:string}} input
 * @returns {Buffer}
 */
export function buildMidi(input = {}) {
  const bpm = Number.isFinite(input.bpm) && input.bpm > 0 ? input.bpm : 120;
  const hits = input.drums?.hits ?? [];
  const notes = input.bass?.notes ?? [];
  const secondsPerTick = 60 / bpm / TICKS_PER_QUARTER;

  // Собираем все события в один поток и сортируем по времени.
  const events = [];
  for (const hit of hits) {
    const time = Number(hit.time_s);
    if (!Number.isFinite(time)) continue;
    const gm = Number(hit.gm);
    if (!Number.isFinite(gm)) continue;
    const velocity = Math.max(1, Math.min(127, Math.round((hit.velocity ?? 0.8) * 127)));
    const start = Math.round(time / secondsPerTick);
    events.push({ tick: start, order: 1, data: [0x99, gm, velocity] });
    events.push({ tick: start + Math.round(0.08 / secondsPerTick), order: 0, data: [0x89, gm, 0] });
  }
  for (const note of notes) {
    const time = Number(note.time_s);
    const midi = Math.round(Number(note.midi));
    if (!Number.isFinite(time) || !Number.isFinite(midi)) continue;
    const duration = Number(note.duration_s) > 0 ? Number(note.duration_s) : 0.25;
    const start = Math.round(time / secondsPerTick);
    const end = Math.round((time + duration) / secondsPerTick);
    const pitch = Math.max(0, Math.min(127, midi));
    const velocity = Math.max(1, Math.min(127, Math.round((note.velocity ?? 0.8) * 127)));
    events.push({ tick: start, order: 1, data: [0x90, pitch, velocity] });
    events.push({ tick: end, order: 0, data: [0x80, pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const body = [];
  // Название дорожки.
  const name = String(input.name || 'Deep Dive twin');
  body.push(0x00, 0xff, 0x03, name.length, ...name.split('').map((c) => c.charCodeAt(0)));
  // Темп.
  const microseconds = Math.round(60000000 / bpm);
  body.push(
    0x00, 0xff, 0x51, 0x03,
    (microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff,
  );
  // Размер 4/4.
  body.push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);

  let previousTick = 0;
  for (const event of events) {
    pushEvent(body, event.tick - previousTick, event.data);
    previousTick = event.tick;
  }
  // Конец дорожки.
  pushEvent(body, 0, [0xff, 0x2f, 0x00]);

  // 480 тиков на четверть (0x01E0).
  const header = chunk('MThd', [0x00, 0x00, 0x00, 0x01, 0x01, 0xe0]);
  const track = chunk('MTrk', body);
  return Buffer.from([...header, ...track]);
}
