// Сохраняет метаданные существующего HTTP/SSE-протокола отдельно от
// строкового контракта компилятора. Это не преобразование старой спеки.
import { validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';
import { listParts, roleOf } from '../../../src/schemas/parts.js';
import { compileTrackSpec } from '../compiler/index.js';

export function sectionTimeline(spec) {
  let bar = 0;
  return spec.structure.sections.map((section) => {
    const startBar = bar;
    bar += section.cycles;
    return {
      kind: section.name,
      bars: section.cycles,
      energy: section.energy,
      startBar,
      endBar: bar,
      roles: listParts(spec.parts)
        .filter((item) => item.part.activeIn.includes(section.name))
        .map((item) => item.id),
      transition: null,
    };
  });
}

export function compileForProtocol(input) {
  const spec = validateTrackSpec(input);
  const code = compileTrackSpec(spec);
  const sections = sectionTimeline(spec);
  const parts = (code.match(/^\$[A-Z][A-Z0-9_]*:.*$/gm) || []).map((line) => ({
    label: line.match(/^\$([A-Z][A-Z0-9_]*):/)[1],
    code: line,
  }));
  const trace = sections.flatMap((section, index) => section.roles.map((id) => ({
    section: index,
    kind: section.kind,
    id,
    role: roleOf(id, spec.parts.roles[id]),
    recipe: null,
    variant: null,
    pattern: spec.parts.roles[id].pattern,
    synth: spec.parts.roles[id].sound,
  })));
  return { code, sections, parts, warnings: [], trace };
}
