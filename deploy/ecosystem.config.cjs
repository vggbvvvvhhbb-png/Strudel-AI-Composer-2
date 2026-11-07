// Конфигурация pm2 для Strudel AI Composer.
// Запуск: pm2 start deploy/ecosystem.config.cjs
// Имя процесса: strudel (pm2 restart strudel)
module.exports = {
  apps: [
    {
      name: 'strudel',
      script: 'server/index.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      // Перезапуск при изменениях в коде сервера.
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      // .env лежит рядом и читается dotenv — ключи не попадают в pm2 ecosystem.
      error_file: '/var/log/pm2/strudel-error.log',
      out_file: '/var/log/pm2/strudel-out.log',
      time: true,
    },
  ],
};
