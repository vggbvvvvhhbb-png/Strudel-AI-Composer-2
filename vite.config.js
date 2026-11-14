import { defineConfig } from 'vite';

// В dev /api проксируется на локальный сервер (127.0.0.1:3001).
// Ключи живут только на сервере — фронт ходит исключительно на свой /api.
export default defineConfig({
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
      },
    },
  },
});
