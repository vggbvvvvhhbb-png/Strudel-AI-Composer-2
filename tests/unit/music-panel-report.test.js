import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ analyzeMusic: vi.fn(), fetchMusicStyles: vi.fn(async () => []) }));
vi.mock('../../src/api/client.js', () => ({ ...api, refineMusic: vi.fn(), musicVariants: vi.fn() }));

class Element {
  children = [];
  textContent = '';
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
}

function text(node) {
  return [node.textContent, ...node.children.map(text)].join(' ');
}

let elements;
beforeEach(() => {
  vi.resetModules();
  elements = new Map(['music-score', 'music-criteria', 'music-issues'].map(id => [id, new Element()]));
  vi.stubGlobal('document', {
    getElementById: id => elements.get(id) ?? null,
    createElement: () => new Element(),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function analyze(audio) {
  api.analyzeMusic.mockResolvedValue({ score: { total: 90, grade: 'A', criteria: [], issues: [] }, audio });
  const { initMusicPanel, analyzeCurrent } = await import('../../src/music-panel.js');
  initMusicPanel({ getCode: () => 's("bd")' });
  await analyzeCurrent();
}

describe('music report separates code findings from measured audio', () => {
  it('does not declare audio clean when the code has no issues but audio clips', async () => {
    await analyze({ report: { clipCount: 144 }, findings: [{ severity: 'error', label: 'Клиппинг', hint: '144 отсчёта' }] });
    expect(text(elements.get('music-score'))).toContain('Клиппинг');
    expect(text(elements.get('music-issues'))).toContain('По коду серьёзных замечаний нет');
    expect(text(elements.get('music-issues'))).toContain('замечания к звуку — выше');
    expect(text(elements.get('music-issues'))).not.toContain('✓');
  });

  it.each([undefined, null])('does not replace unmeasured clipping (%s) with zero', async clipCount => {
    await analyze({ report: { clipCount } });
    expect(text(elements.get('music-score'))).toContain('клиппинг: —');
    expect(text(elements.get('music-score'))).not.toContain('клиппинг: 0');
  });

  it('preserves a measured zero clipping count', async () => {
    await analyze({ report: { clipCount: 0 } });
    expect(text(elements.get('music-score'))).toContain('клиппинг: 0');
  });
});
