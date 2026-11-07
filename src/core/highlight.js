// Подсветка синтаксиса Strudel-кода в оттенках нефрита.
// Общий модуль: используется и редактором, и карточками партий в живой партитуре.

const ESC = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const TOKEN =
  /(\$[A-Za-z_]\w*:)|("[^"\n]*"|'[^'\n]*')|(\b\d+(?:\.\d+)?\b)|(\/\/.*$)|\b(const|let|var|await|async|import|export|function|return|true|false|null|undefined)\b|\b(setCpm|samples|note|chord|n|s|bank|gain|room|size|lpf|hpf|bpf|attack|decay|sustain|release|slow|fast|scale|voicing|pianoroll|scope|every|superimpose|when|often|beat|struct|off|press)\b/g;

export function highlightLine(line) {
  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(line))) {
    out += ESC(line.slice(last, m.index));
    const cls = m[1]
      ? 'hl-label'
      : m[2]
        ? 'hl-string'
        : m[3]
          ? 'hl-number'
          : m[4]
            ? 'hl-comment'
            : m[5]
              ? 'hl-keyword'
              : 'hl-func';
    out += `<span class="${cls}">${ESC(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += ESC(line.slice(last));
  return out;
}

// Несколько строк подряд (код партии в карточке живой партитуры).
export function highlightBlock(lines) {
  return lines.map((line) => highlightLine(line)).join('\n');
}
