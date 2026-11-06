import { defineConfig, loadEnv } from 'vite';

// Ключи API живут только на сервере разработки: клиент обращается к /api/*,
// а Vite проксирует запросы к OpenAI/Groq и подставляет Authorization из .env.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    server: {
      proxy: {
        '/api/chat': {
          // BASE_URL можно переопределить в .env (например, на совместимый прокси-эндпойнт),
          // если api.openai.com недоступен напрямую из региона.
          target: env.OPENAI_BASE_URL || 'https://api.openai.com',
          changeOrigin: true,
          rewrite: () => '/v1/chat/completions',
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${env.OPENAI_API_KEY || ''}`);
            });
          },
        },
        '/api/transcribe': {
          target: env.GROQ_BASE_URL || 'https://api.groq.com',
          changeOrigin: true,
          rewrite: () => '/openai/v1/audio/transcriptions',
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${env.GROQ_API_KEY || ''}`);
            });
          },
        },
      },
    },
  };
});
