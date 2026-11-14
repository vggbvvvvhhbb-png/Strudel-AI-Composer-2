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
        // Студия и страница суждения — две отдельные точки входа.
        // «Тиндер» тянет тот же движок, поэтому отдельная страница вместо
        // режима внутри студии: рецензенту не нужны редактор и микшер.
        main: 'index.html',
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
