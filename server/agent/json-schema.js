// Конвертер zod-схем в JSON Schema.
//
// ЗАЧЕМ. Инструменты описаны один раз — zod'ом: он же проверяет аргументы
// при вызове. Нативному function-calling нужен другой формат (JSON Schema,
// который понимает провайдер). Конвертер — единственное место, где эти два
// мира встречаются, поэтому источник истины остаётся один.
//
// ПОДДЕРЖИВАЕМЫЙ ПОДНАБОР. Ровно то, что реально есть в реестре
// инструментов: object, string, number, boolean, enum, array, record, any,
// optional, default, effects (preprocess), passthrough. Не поддержанное
// отдаётся пустым объектом схемы — провайдер примет такой аргумент как
// свободный, а zod всё равно проверит его на исполнении.
//
// ГРАНИЦА. zod различает «поле отсутствует» и «поле есть, но пусто».
// JSON Schema этого не умеет: optional-поле просто не попадает в required.
// Значение по умолчанию в схему не переносится — его подставляет zod при
// разборе аргументов.

/**
 * Снимает обёртки схемы: optional, default, effects, nullable, readonly.
 * Внутри них лежит настоящая форма, из которой строится JSON Schema.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('zod').ZodTypeAny}
 */
export function unwrapSchema(schema) {
  let current = schema;
  // Страховка от цикла: обёртка может ссылаться на себя.
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const def = current._def;
    const name = def?.typeName;
    if (name === 'ZodOptional' || name === 'ZodNullable' || name === 'ZodReadonly') {
      current = def.innerType;
      continue;
    }
    if (name === 'ZodDefault') {
      current = def.innerType;
      continue;
    }
    if (name === 'ZodEffects') {
      current = def.schema;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Имя типа zod-схемы.
 * @param {import('zod').ZodTypeAny} schema
 * @returns {string}
 */
function typeName(schema) {
  return schema?._def?.typeName ?? '';
}

/**
 * Поле необязательное? Для optional и default — да: поле можно не присылать.
 * @param {import('zod').ZodTypeAny} schema
 * @returns {boolean}
 */
export function isOptionalSchema(schema) {
  const name = typeName(schema);
  if (name === 'ZodOptional' || name === 'ZodDefault') return true;
  // Внутри effects лежит настоящая схема — смотрим её.
  const inner = unwrapSchema(schema);
  if (inner && inner !== schema) return isOptionalSchema(inner);
  return false;
}

/**
 * Плоский объект схемы (для описания аргументов в текстовом промте).
 * @param {import('zod').ZodTypeAny} schema
 * @returns {Record<string, import('zod').ZodTypeAny>}
 */
export function schemaShape(schema) {
  const inner = unwrapSchema(schema);
  const shape = inner?._def?.shape;
  if (typeof shape === 'function') return shape();
  return shape ?? {};
}

/**
 * zod-схема → JSON Schema.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {object}
 */
export function zodToJsonSchema(schema) {
  const inner = unwrapSchema(schema);
  const name = typeName(inner);

  switch (name) {
    case 'ZodString': {
      const out = { type: 'string' };
      for (const check of inner._def.checks ?? []) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
      }
      return out;
    }
    case 'ZodNumber': {
      const out = { type: 'number' };
      for (const check of inner._def.checks ?? []) {
        if (check.kind === 'int') out.type = 'integer';
        if (check.kind === 'min') out.minimum = check.value;
        if (check.kind === 'max') out.maximum = check.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...(inner._def.values ?? [])] };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(inner._def.type) };
    case 'ZodObject': {
      const shape = inner._def.shape();
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptionalSchema(value)) required.push(key);
      }
      const out = { type: 'object', properties };
      if (required.length) out.required = required;
      // zod по умолчанию молча отбрасывает лишние поля, поэтому дополнительные
      // свойства разрешаем: провайдер не должен ломаться на «лишнем» ключе.
      out.additionalProperties = true;
      return out;
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(inner._def.valueType) };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodUnion': {
      const options = (inner._def.options ?? []).map((option) => zodToJsonSchema(option));
      return options.length === 1 ? options[0] : { anyOf: options };
    }
    default:
      return {};
  }
}
