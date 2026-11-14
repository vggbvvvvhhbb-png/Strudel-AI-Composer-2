#!/usr/bin/env node
// Сборка браузерного бандла рендер-воркера.
//
// В рантайме на сервере esbuild может быть недоступен (в прод-образ попадают
// только production-зависимости), поэтому бандл собирается НА ЭТАПЕ СБОРКИ
// образа, а воркер просто отдаёт готовый файл.
//
// Запуск: npm run build:render

import { buildRenderBundle } from '../server/deepdive/render/render-worker.mjs';

const outFile = await buildRenderBundle();
console.log('бандл рендера собран:', outFile);
