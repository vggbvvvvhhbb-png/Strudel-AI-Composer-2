// Реестр загрузчика каталога Timbre для общего компилятора (D-128).
//
// Компилятор импортируется и браузером (src/studio/compile.js), поэтому не
// имеет права тянуть node:fs. Сервер регистрирует загрузчик при импорте
// server/samples/timbre.js, клиент — после загрузки каталога по API
// (src/timbre/register.js). Без загрузчика и без опции timbreCatalog
// компиляция партии с instrumentId — честная ошибка, не тихая подмена.

let loader = null;

export function registerTimbreCatalogLoader(fn) {
  loader = fn;
}

export function loadRegisteredTimbreCatalog() {
  if (!loader) {
    throw new Error('Каталог Timbre Palette не подключён к компилятору: передайте timbreCatalog или зарегистрируйте загрузчик');
  }
  return loader();
}