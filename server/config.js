import 'dotenv/config';

// Чтение и проверка окружения. Значения никогда не логируются — только имена переменных.
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[config] Не задана обязательная переменная окружения ${name}.`);
    console.error('Заполните .env по образцу .env.example и перезапустите сервер.');
    process.exit(1);
  }
  return value.trim();
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  // Слушаем только localhost: наружу сервер отдаёт nginx.
  host: '127.0.0.1',
  openaiApiKey: required('OPENAI_API_KEY'),
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  openaiModel: required('OPENAI_MODEL'),
  // Резервная модель: если основная недоступна или вернула пустой ответ.
  openaiFallbackModel: (process.env.OPENAI_FALLBACK_MODEL || '').trim() || null,
  // Голосовой ввод — необязательный модуль: без ключа сервер работает,
  // а /api/transcribe отвечает 503 с понятным сообщением.
  groqApiKey: (process.env.GROQ_API_KEY || '').trim() || null,
  groqBaseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  groqTranscribeModel: (process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo').trim(),
};
