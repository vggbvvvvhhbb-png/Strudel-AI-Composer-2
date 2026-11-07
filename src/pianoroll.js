// Нефритовая визуализация партий: собственный пианоролл (активные ноты со свечением),
// осциллограф ударных и алиасы фоновых методов Strudel.
//
// В бандле @strudel/web есть только Pattern.prototype.pianoroll и .scope:
// подчёркнутые варианты (._pianoroll, ._scope) в этой версии Strudel не определены,
// хотя именно их пишет генератор кода. Здесь мы их заводим и красим по-своему.
import { Pattern, noteToMidi, freqToMidi } from '@strudel/web';

export const PALETTE = {
  note: '#f2fff9',       // обычные ноты
  active: '#2fe0a0',     // активная нота
  glow: 'rgba(47,224,160,0.55)',
  grid: 'rgba(120,255,200,0.10)',
  playhead: 'rgba(181,255,225,0.5)',
};

// Прокси контекста: встроенный осциллограф Strudel рисует в своей теме —
// подменяем цвет линии на нефритовый, не трогая остальную геометрию.
function jadeCtx(ctx) {
  return new Proxy(ctx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === 'strokeStyle') {
        target.strokeStyle = PALETTE.active;
        return true;
      }
      target[prop] = value;
      return true;
    },
  });
}

// Высота ноты в MIDI: note/n/freq → число. Без высоты (сэмплы) — null.
function noteValue(hap) {
  const raw = hap?.value;
  const value = typeof raw === 'object' && raw !== null ? raw : { value: raw };
  const { note, n, freq } = value;
  if (freq) {
    try {
      return freqToMidi(freq);
    } catch {
      return null;
    }
  }
  const pitch = note ?? n;
  if (typeof pitch === 'string') {
    try {
      return noteToMidi(pitch);
    } catch {
      return null;
    }
  }
  if (typeof pitch === 'number') return pitch;
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Пианоролл партии: ноты светлые, активные — нефритовые со свечением.
export function paintPianoroll({ ctx, haps = [], time = 0, cycles = 4, playhead = 0.5 }) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (!w || !h) return;

  const from = -cycles * playhead;
  const to = cycles * (1 - playhead);
  const extent = to - from;

  ctx.clearRect(0, 0, w, h);

  const notes = [];
  let min = Infinity;
  let max = -Infinity;
  for (const hap of haps) {
    const v = noteValue(hap);
    if (v === null) continue;
    notes.push({ hap, v });
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 40;
    max = 76;
  }
  if (max - min < 8) {
    const mid = (min + max) / 2;
    min = mid - 4;
    max = mid + 4;
  }
  const valueExtent = max - min + 1;
  const row = h / valueExtent;

  // горизонтальная сетка — ориентир по высоте
  ctx.save();
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= valueExtent; i += 1) {
    const y = Math.round(i * row) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.restore();

  // ноты
  for (const { hap, v } of notes) {
    const begin = hap.whole.begin;
    const duration = hap.duration ?? 0.1;
    const x = ((begin - time) / extent) * w;
    const noteWidth = Math.max((duration / extent) * w, 3);
    if (x > w || x + noteWidth < 0) continue;
    const noteHeight = Math.max(row - 2, 3);
    const y = h - ((v - min) / valueExtent) * h - row;
    const active = begin <= time && hap.endClipped > time;

    ctx.save();
    if (active) {
      ctx.shadowColor = PALETTE.glow;
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = active ? PALETTE.active : PALETTE.note;
    ctx.globalAlpha = active ? 1 : 0.7;
    roundRect(ctx, x, y, noteWidth, noteHeight, Math.min(3, noteHeight / 2));
    ctx.fill();
    ctx.restore();
  }

  // playhead — там, где «сейчас»
  ctx.save();
  ctx.strokeStyle = PALETTE.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const px = (-from / extent) * w;
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
  ctx.restore();
}

// Устанавливает нефритовые визуализации поверх встроенных Strudel.
// drawTarget(kind) вызывается движком перед каждой отрисовкой и возвращает {ctx, id}.
export function installJadeVisuals({ drawTarget }) {
  const originalScope = Pattern.prototype.scope;
  const originalFscope = Pattern.prototype.fscope;

  Pattern.prototype.pianoroll = function (opts = {}) {
    const target = drawTarget('pianoroll');
    if (!target) return this;
    const { ctx, id } = target;
    const cycles = opts.cycles ?? 4;
    const playhead = opts.playhead ?? 0.5;
    const from = -cycles * playhead;
    const to = cycles * (1 - playhead);
    this.draw(
      (haps, time) => {
        paintPianoroll({ ctx, haps, time, cycles, playhead });
      },
      { lookbehind: from, lookahead: to, id },
    );
    return this;
  };

  // Осциллограф ударных: встроенный scope, но с нефритовой темой и без чёрной заливки.
  const scopeImpl = function (opts = {}) {
    const target = drawTarget('scope');
    if (!target) return this;
    const { ctx, id } = target;
    return originalScope.call(this, { ...opts, ctx: jadeCtx(ctx), id, pos: 0.5, scale: 0.4, thickness: 2, smear: 0 });
  };
  Pattern.prototype.scope = scopeImpl;

  if (originalFscope) {
    Pattern.prototype.fscope = function (opts = {}) {
      const target = drawTarget('scope');
      if (!target) return this;
      const { ctx, id } = target;
      return originalFscope.call(this, { ...opts, ctx: jadeCtx(ctx), id, pos: 0.5, scale: 0.4, smear: 0 });
    };
  }

  // Алиасы фоновых вариантов: ._pianoroll(), ._scope(), ._fscope().
  const aliases = { _pianoroll: 'pianoroll', _scope: 'scope', _fscope: 'fscope', _spectrum: 'scope' };
  for (const [alias, target] of Object.entries(aliases)) {
    if (typeof Pattern.prototype[alias] === 'function') continue;
    const impl = Pattern.prototype[target];
    if (typeof impl !== 'function') continue;
    Pattern.prototype[alias] = function (opts = {}) {
      return impl.call(this, opts);
    };
  }
}
