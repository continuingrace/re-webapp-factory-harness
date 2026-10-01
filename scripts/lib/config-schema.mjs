// 프로젝트에서 허용한 JSON Schema subset 검사기. 전체 JSON Schema 구현이 아니다.
// config/*.schema.json이 실제로 쓰는 키워드만 지원하고, 그 밖의 키워드는 조용히 무시하지 않고 오류로 보고한다.
// 오류 메시지에는 위치와 위반 키워드만 담고 설정 값은 담지 않는다 (비공개 값이 출력에 새지 않게).

export const SUPPORTED_KEYWORDS = Object.freeze([
  '$schema', '$id', '$comment', 'title', 'description',
  'type', 'additionalProperties', 'required', 'properties', 'items',
  'const', 'enum', 'pattern', 'minItems', 'minLength', 'maxLength',
]);
export const SUPPORTED_TYPES = Object.freeze(['object', 'array', 'string']);

const KNOWN = new Set(SUPPORTED_KEYWORDS);

// 스키마 자체가 subset 안에 있는지 확인한다. 값이 없어 방문하지 않는 하위 스키마도 모두 검사한다.
export function checkSchema(schema, at = '#') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: 스키마가 object가 아님`];
  const errs = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) errs.push(`${at}: 지원하지 않는 키워드 ${k}`);
  if ('type' in schema && !SUPPORTED_TYPES.includes(schema.type)) errs.push(`${at}: 지원하지 않는 type`);
  if ('additionalProperties' in schema && schema.additionalProperties !== false) errs.push(`${at}: additionalProperties는 false만 지원`);
  if ('pattern' in schema) {
    try { new RegExp(schema.pattern, 'u'); } catch { errs.push(`${at}: pattern이 정규식이 아님`); }
  }
  for (const k of ['minItems', 'minLength', 'maxLength']) {
    if (k in schema && !(Number.isInteger(schema[k]) && schema[k] >= 0)) errs.push(`${at}: ${k}는 0 이상 정수`);
  }
  if ('enum' in schema && !Array.isArray(schema.enum)) errs.push(`${at}: enum은 배열`);
  if ('required' in schema && !Array.isArray(schema.required)) errs.push(`${at}: required는 배열`);
  for (const [k, sub] of Object.entries(schema.properties || {})) errs.push(...checkSchema(sub, `${at}/properties/${k}`));
  if ('items' in schema) errs.push(...checkSchema(schema.items, `${at}/items`));
  return errs;
}

function validateValue(schema, value, at) {
  const errs = [];
  if ('const' in schema && value !== schema.const) errs.push(`${at}: const 불일치`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: enum 밖의 값`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [...errs, `${at}: object가 아님`];
    for (const r of schema.required || []) if (!Object.hasOwn(value, r)) errs.push(`${at}.${r}: 필수 필드 없음`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, k)) errs.push(...validateValue(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: 허용되지 않은 필드`);
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [...errs, `${at}: array가 아님`];
    if (value.length < (schema.minItems ?? 0)) errs.push(`${at}: minItems 미달`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateValue(schema.items, v, `${at}[${i}]`)));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [...errs, `${at}: string이 아님`];
    const len = [...value].length; // JSON Schema처럼 code point 수로 센다
    if (len < (schema.minLength ?? 0)) errs.push(`${at}: minLength 미달`);
    if ('maxLength' in schema && len > schema.maxLength) errs.push(`${at}: maxLength 초과`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: pattern 불일치`);
  }
  return errs;
}

// 스키마가 subset 밖이면 값은 검사하지 않고 스키마 오류만 돌려준다. 오류가 없으면 빈 배열.
export function validateSchemaSubset(schema, value) {
  const schemaErrs = checkSchema(schema);
  if (schemaErrs.length) return schemaErrs;
  return validateValue(schema, value, '$');
}
