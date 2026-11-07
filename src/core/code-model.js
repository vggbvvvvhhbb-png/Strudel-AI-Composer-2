// Разбор и точечные правки Strudel-кода: партии, mute/solo/gain, BPM, тональность.
// Микшер и транспорт работают только через эти функции — редактор остаётся источником истины.

const PART_LINE = /^[ \t]*([_S]?)\$[ \t]*([A-Za-z]\w*)?[ \t]*:/;

// Позиция // комментария вне строковых литералов (-1 если нет).
export function commentStart(text) {
  let inString = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
    } else if (c === '\'' || c === '"' || c === '`') inString = c;
    else if (c === '/' && text[i + 1] === '/') return i;
  }
  return -1;
}

// Все партии кода с диапазонами строк (заголовок + продолжение цепочки до следующей партии).
export function parseParts(code) {
  const lines = code.split('\n');
  const parts = [];
  lines.forEach((text, i) => {
    const m = text.match(PART_LINE);
    if (m) {
      parts.push({ label: m[2] || '', prefix: m[1], muted: m[1] === '_', startLine: i, endLine: i });
    } else if (parts.length && text.trim() && !/^[ \t]*\/\//.test(text)) {
      const last = parts[parts.length - 1];
      if (i === last.endLine + 1 || /^[ \t]*\./.test(text)) last.endLine = i;
    }
  });
  return parts;
}

function findPart(code, label) {
  return parseParts(code).find((p) => p.label === label) || null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Префикс mute у метки: `_$BASS:`. Пишем только `_`; чужой `S` при правке нормализуем.
function replacePrefix(line, prefix) {
  return line.replace(/^([ \t]*)(?:_|S)?(?=\$)/, `$1${prefix}`);
}

export function setPartMuted(code, label, muted) {
  const part = findPart(code, label);
  if (!part) return code;
  const lines = code.split('\n');
  lines[part.startLine] = replacePrefix(lines[part.startLine], muted ? '_' : '');
  return lines.join('\n');
}

// Solo через mute всех остальных: детерминированно работает в любой сборке Strudel.
// Возвращает { code, previous: [labels ранее заглушённых] } для восстановления при снятии solo.
export function setPartSolo(code, label) {
  const parts = parseParts(code);
  const previous = parts.filter((p) => p.muted && p.label !== label).map((p) => p.label);
  let out = code;
  for (const p of parts) out = setPartMuted(out, p.label, p.label !== label);
  return { code: out, previous };
}

export function unsoloAll(code, previousLabels) {
  let out = code;
  const labels = parseParts(code).map((p) => p.label);
  for (const label of labels) out = setPartMuted(out, label, previousLabels.includes(label));
  return out;
}

// Громкость партии: заменяет первый .gain(N) в её регионе или дописывает в конец строки партии
// (перед комментарием, если он есть). Остальная цепочка не трогается.
export function setPartGain(code, label, value) {
  const part = findPart(code, label);
  if (!part) return code;
  const lines = code.split('\n');
  const gainRe = /\.gain\s*\(\s*[\d.]+\s*\)/;
  for (let i = part.startLine; i <= part.endLine; i++) {
    if (gainRe.test(lines[i])) {
      lines[i] = lines[i].replace(gainRe, `.gain(${round2(value)})`);
      return lines.join('\n');
    }
  }
  const line = lines[part.startLine];
  const cIdx = commentStart(line);
  const head = (cIdx === -1 ? line : line.slice(0, cIdx)).trimEnd();
  const tail = cIdx === -1 ? '' : line.slice(cIdx);
  lines[part.startLine] = `${head}.gain(${round2(value)})${tail ? ` ${tail}` : ''}`;
  return lines.join('\n');
}

export function getPartGain(code, label) {
  const part = findPart(code, label);
  if (!part) return null;
  const m = code.split('\n').slice(part.startLine, part.endLine + 1).join('\n').match(/\.gain\s*\(\s*([\d.]+)\s*\)/);
  return m ? Number(m[1]) : null;
}

// BPM живёт в `setCpm(bpm/4)`; голое число трактуется как CPM и умножается на 4.
export function getBpm(code) {
  const m = code.match(/setCpm\s*\(\s*([\d.]+)\s*(\/\s*4\s*)?\)/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? n : n * 4;
}

export function setCpm(code, bpm) {
  const line = `setCpm(${Math.round(bpm)}/4)`;
  const re = /setCpm\s*\([^)]*\)/;
  if (re.test(code)) return code.replace(re, line);
  return `${line}\n${code}`;
}

export function getKey(code) {
  const m = code.match(/(?:const|let|var)?\s*key\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

export function setKey(code, key) {
  const re = /(?:const|let|var)?\s*key\s*=\s*["'][^"']+["']/;
  if (re.test(code)) return code.replace(re, `const key = "${key}"`);
  return `const key = "${key}"\n${code}`;
}

// Какие партии/шапка изменились между версиями кода (для diff-подтверждения в режиме improve).
export function changedRegions(oldCode, newCode) {
  const changed = { bpm: getBpm(oldCode) !== getBpm(newCode), key: getKey(oldCode) !== getKey(newCode), parts: [] };
  const regions = (code) => {
    const map = {};
    for (const p of parseParts(code)) {
      map[p.label] = code.split('\n').slice(p.startLine, p.endLine + 1).map((l) => l.trim()).filter(Boolean).join('\n');
    }
    return map;
  };
  const a = regions(oldCode);
  const b = regions(newCode);
  const labels = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const label of labels) if (a[label] !== b[label]) changed.parts.push(label);
  return changed;
}

// Построчный diff (LCS): [{type:'same'|'add'|'del', text}]
export function diffLines(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j] }); j++; }
  return out;
}

// Снимок состояния микшера для пресета: громкость и mute каждой партии.
export function captureMixer(code) {
  return parseParts(code).map((p) => ({
    label: p.label,
    gain: getPartGain(code, p.label) ?? 0.8,
    muted: p.muted,
  }));
}

// Применить снимок к коду (при загрузке пресета или трека по ссылке).
export function applyMixerState(code, snapshot) {
  let out = code;
  const labels = new Set(parseParts(out).map((p) => p.label));
  for (const ch of snapshot || []) {
    if (!labels.has(ch.label)) continue; // партии нет — пропускаем
    out = setPartGain(out, ch.label, Number(ch.gain ?? 0.8));
    out = setPartMuted(out, ch.label, Boolean(ch.muted));
  }
  return out;
}
