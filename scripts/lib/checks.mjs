// standards/checks.json 로더와 스키마 검증. 판정 값은 이 파일을 통해서만 읽는다.
import fs from 'node:fs';
import path from 'node:path';

export const TOP_FIELDS = ['schema_version', 'standards_version', 'source_documents', 'checks'];
export const CHECK_FIELDS = [
  'check_id', 'gate', 'stage', 'description', 'applies_when',
  'rule', 'failure_code', 'overrideable', 'evidence_required', 'source_reference',
];

export function codeError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export function checksPath(root) {
  return path.join(root, 'standards', 'checks.json');
}

export function loadChecks(root) {
  const data = JSON.parse(fs.readFileSync(checksPath(root), 'utf8'));
  return { data, errors: validateChecks(data) };
}

export function validateChecks(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['CHECKS_NOT_OBJECT'];
  for (const f of TOP_FIELDS) if (!(f in data)) errors.push(`TOP_FIELD_MISSING:${f}`);
  if (!Array.isArray(data.checks)) {
    errors.push('CHECKS_NOT_ARRAY');
    return errors;
  }
  const registered = new Set((data.source_documents || []).map((d) => d.path));
  const seen = new Set();
  for (const c of data.checks) {
    const id = c && c.check_id;
    for (const f of CHECK_FIELDS) if (!c || !(f in c)) errors.push(`CHECK_FIELD_MISSING:${id}:${f}`);
    if (seen.has(id)) errors.push(`CHECK_ID_DUPLICATE:${id}`);
    seen.add(id);
    if (!Number.isInteger(c.gate) || c.gate < 0 || c.gate > 5) errors.push(`GATE_OUT_OF_RANGE:${id}`);
    if (!Number.isInteger(c.stage) || c.stage < 1 || c.stage > 5) errors.push(`STAGE_OUT_OF_RANGE:${id}`);
    if (!Array.isArray(c.failure_code) || c.failure_code.length === 0) errors.push(`FAILURE_CODE_INVALID:${id}`);
    const ref = typeof c.source_reference === 'string' ? c.source_reference.split('#')[0] : null;
    if (!ref || !registered.has(ref)) errors.push(`SOURCE_NOT_REGISTERED:${id}`);
  }
  return errors;
}

export function getCheck(data, id) {
  const c = data.checks.find((x) => x.check_id === id);
  if (!c) throw codeError('CHECK_NOT_FOUND');
  return c;
}

export function inputValue(input, key) {
  if (input && Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  return input && input.flags ? input.flags[key] : undefined;
}

// "always" 또는 "<key> == <value>" 형식만 해석한다. 해석할 수 없으면 null.
export function appliesWhen(expr, input) {
  if (expr === 'always') return true;
  const m = /^([a-z_]+)\s*==\s*([A-Za-z0-9_-]+)$/.exec(String(expr).trim());
  if (!m) return null;
  return String(inputValue(input, m[1])) === m[2];
}

function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return String(v).trim() === '';
}

// 승인된 override: required_fields가 모두 채워진 경우에만 인정한다.
export function getOverride(data, input, checkId) {
  const required = data.policies.override.required_fields;
  const list = Array.isArray(input && input.overrides) ? input.overrides : [];
  const o = list.find((x) => x && x.check_id === checkId);
  if (!o) return null;
  if (required.some((f) => isBlank(o[f]))) return { rejected: true };
  return { rejected: false, value: o.value, source_reference: o.source_reference };
}
