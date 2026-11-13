// Сохраняет метаданные существующего HTTP/SSE-протокола отдельно от
// строкового контракта компилятора. Это не преобразование старой спеки.
import { validateTrackSpec } from '../../../src/schemas/track-spec.schema.js';
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
      roles: Object.entries(spec.parts.roles)
        .filter(([, part]) => part.activeIn.includes(section.name))
        .map(([role]) => role),
      transition: null,
    };
  });
}

export function compileForProtocol(input) {
  const spec = validateTrackSpec(input);
  const code = compileTrackSpec(spec);
  const sections = sectionTimeline(spec);
  const parts = (code.match(/^\$[A-Z]+:.*$/gm) || []).map((line) => ({
    label: line.match(/^\$([A-Z]+):/)[1],
    code: line,
  }));
  const trace = sections.flatMap((section, index) => section.roles.map((role) => ({
    section: index,
    kind: section.kind,
    role,
    recipe: null,
    variant: null,
    pattern: spec.parts.roles[role].pattern,
    synth: spec.parts.roles[role].sound,
  })));
  return { code, sections, parts, warnings: [], trace };
}
