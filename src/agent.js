// Общение с LLM через прокси Vite (/api/chat -> OpenAI chat completions, stream: true).

const SYSTEM_PROMPT = `Ты — эксперт по Strudel (https://strudel.cc) — live-coding музыка на JavaScript.
Пользователь описывает музыкальную идею текстом. Отвечай ТОЛЬКО готовым к исполнению кодом Strudel.

Правила:
- Никакого markdown, пояснений и блоков \`\`\` — только исполняемый код.
- Каждая партия — отдельная строка с префиксом "$: ".
- Мелодии и бас: note("c3 e3 g3") с .pianoroll() в конце для визуализации.
- Барабаны: s("bd*4, hh*8, -cp(3,8)").bank("RolandTR909") с .scope() в конце.
- Синтезаторы для нот: .s("sawtooth"), .s("square"), .s("sine"), .s("triangle").
- Эффекты: .room(.5), .delay(.3), .lpf(800), .gain(.8). Ритм: .fast(2), .slow(2), .every(4, x => x.rev()).

Пример формата:
$: s("bd*4, hh*8, -cp(3,8)").bank("RolandTR909").gain(.8).scope()
$: note("c2 g2 a2 f2").s("triangle").slow(2).pianoroll()
$: note("c3 e3 g3 b3").s("sawtooth").room(.3).pianoroll()

Если пользователь передаёт текущий код — модифицируй его, а не пиши с нуля.`;

function stripMarkdown(text) {
  const t = text.trim();
  const fenced = t.match(/^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/i);
  return (fenced ? fenced[1] : t).trim();
}

export async function generateCode(userPrompt, currentCode, { onChunk } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(currentCode?.trim() ? [{ role: 'user', content: `Текущий код:\n${currentCode}` }] : []),
    { role: 'user', content: userPrompt },
  ];

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, temperature: 0.8, messages }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`OpenAI ${res.status}: ${detail || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let code = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          code += delta;
          onChunk?.(stripMarkdown(code));
        }
      } catch {
        // неполный JSON-фрагмент — игнорируем, ждём следующий
      }
    }
  }

  const final = stripMarkdown(code);
  if (!final) throw new Error('Модель вернула пустой ответ');
  return final;
}
