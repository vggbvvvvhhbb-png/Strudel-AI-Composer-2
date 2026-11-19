import { defineConfig } from 'vite';

/**
 * Прямая ссылка на разбор в dev-режиме.
 *
 * Панель разбора живёт в studio.html, а vite по умолчанию отдаёт на любой
 * неизвестный путь index.html — то есть ссылка /razbor/<id> открывала бы
 * обложку, где панели нет. Поэтому в dev тот же путь отдаёт studio.html.
 * В сборке этим же занимается сервер (server/index.js).
 */
function razborFallback() {
  return {
    name: 'razbor-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/razbor/')) req.url = '/studio.html';
        next();
      });
    },
  };
}

// В dev /api проксируется на локальный сервер (127.0.0.1:3001).
// Ключи живут только на сервере — фронт ходит исключительно на свой /api.
export default defineConfig({
  plugins: [razborFallback()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        // Три отдельные точки входа. Главная — обложка (лёгкая, без движка),
        // студия — рабочий бенч, «Тиндер» — страница суждения для рецензента.
        landing: 'index.html',
        studio: 'studio.html',
        tinder: 'tinder.html',
        // Скрытая страница изолированного офлайн-рендера (E-020/D-143):
        // грузится в iframe на один рендер, чанк движка общий со студией.
        realm: 'render-realm.html',
      },
    },
  },
  test: {
    // --expose-gc нужен тесту «в аудиопотоке нет аллокаций»: без принудительной
    // сборки мусора измеряется не работа кода, а очередь сборщика.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
        // Машина владельца хронически нагружена (браузер ~4.5 ГБ, Twitch,
        // llama-server; свободно ~1.1 ГБ): воркеры vitest умирают от OOM
        // при 12 (по числу CPU), 4 и даже 2 параллельных воркерах с Chromium.
        // 1 воркер — последовательный прогон, минимальный пик памяти (D-142).
        maxForks: 1,
        minForks: 1,
      },
    },
    // Клон донора `.scratch/shveyka-igolka` — чужой монорепо без наших
    // зависимостей. Без этого исключения vitest подхватывает его тесты
    // и роняет прогон: 26 файлов, 20 упавших тестов, все — не наши.
    // Каталог в .gitignore, но vitest смотрит на диск, а не на git.
    exclude: ['**/node_modules/**', '**/dist/**', '.scratch/**'],
  },
});
