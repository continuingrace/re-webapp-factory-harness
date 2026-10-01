// public export 차단 목록 로더. 실제 CLI는 하네스 루트의 policies.public_export.scan_config.config_path만 읽는다.
// 식별자 로더(identifiers.mjs)와 같은 안전 규칙을 쓴다: 고정 경로, config 폴더 symlink·경로 이탈 거부, 일반 파일만,
// 크기 제한, BOM 제거, 스키마 검증, 공백 값·id 중복·컴파일 불가 regex·빈 문자열 일치 regex 거부.
// 결과·오류에는 id·항목 번호·사유 코드만 담는다. 설정 값·정규식 원문·JSON 파싱 오류 메시지는 담지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { escapeRegExp } from './identifiers.mjs';
import { validateSchemaSubset } from './config-schema.mjs';

export const SCAN_CONFIG_MISSING = 'PUBLIC_SCAN_CONFIG_MISSING';
export const SCAN_CONFIG_INVALID = 'PUBLIC_SCAN_CONFIG_INVALID';
export const SCAN_PATTERN_INVALID = 'PUBLIC_SCAN_PATTERN_INVALID';

const unavailable = (failure_code, reason, extra = {}) => ({ ok: false, failure_code, reason, ...extra });

// identifiers.mjs와 같은 보조 방어: 빈 문자열과 몇 개의 probe에서 길이 0으로 일치하면 거부한다.
const EMPTY_PROBES = [' ', 'a', 'a b', 'a-b_c.1\n'];

function zeroLengthAt(source, text) {
  const m = new RegExp(source, 'gi').exec(text);
  return m !== null && m[0].length === 0;
}

export function compilePublicScan(config, schema) {
  if (config && Array.isArray(config.forbidden) && config.forbidden.length === 0) return unavailable(SCAN_CONFIG_INVALID, 'EMPTY_LIST');
  const violations = validateSchemaSubset(schema, config);
  if (violations.length) return unavailable(SCAN_CONFIG_INVALID, 'SCHEMA', { violations });
  const seen = new Set();
  const entries = [];
  for (const [index, e] of config.forbidden.entries()) {
    if (seen.has(e.id)) return unavailable(SCAN_CONFIG_INVALID, 'DUPLICATE_ID', { index });
    seen.add(e.id);
    if (e.value.trim() === '') return unavailable(SCAN_CONFIG_INVALID, 'BLANK_VALUE', { index });
    const source = e.match === 'literal' ? escapeRegExp(e.value) : e.value;
    try { new RegExp(source, 'gi'); } catch { return unavailable(SCAN_PATTERN_INVALID, 'REGEX_COMPILE', { index }); }
    if (zeroLengthAt(source, '') || EMPTY_PROBES.some((p) => zeroLengthAt(source, p))) return unavailable(SCAN_PATTERN_INVALID, 'REGEX_MATCHES_EMPTY', { index });
    // 원문은 클로저 안에만 둔다 (identifiers.mjs와 같은 모양이라 countIdentifier·maskText를 그대로 쓸 수 있다).
    entries.push(Object.freeze({ id: e.id, match: e.match, regex: () => new RegExp(source, 'gi') }));
  }
  return { ok: true, count: entries.length, entries };
}

// 하네스 루트 기준 고정 경로만 읽는다. config 폴더가 symlink·junction이거나 루트 밖으로 풀리면 거부한다.
export function loadPublicScan(root, policy) {
  if (!policy || typeof policy.config_path !== 'string' || typeof policy.schema_path !== 'string' || !Number.isInteger(policy.max_bytes)) {
    return unavailable(SCAN_CONFIG_INVALID, 'POLICY_INVALID');
  }
  const configDir = path.join(root, 'config');
  const file = path.resolve(root, ...policy.config_path.split('/'));
  const schemaFile = path.resolve(root, ...policy.schema_path.split('/'));
  if (path.dirname(file) !== configDir || path.dirname(schemaFile) !== configDir) return unavailable(SCAN_CONFIG_INVALID, 'UNSAFE_PATH');
  try {
    const dir = fs.lstatSync(configDir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return unavailable(SCAN_CONFIG_INVALID, 'UNSAFE_PATH');
    if (path.relative(fs.realpathSync.native(root), fs.realpathSync.native(configDir)) !== 'config') return unavailable(SCAN_CONFIG_INVALID, 'UNSAFE_PATH');
  } catch (e) {
    return e.code === 'ENOENT' ? unavailable(SCAN_CONFIG_MISSING, 'NOT_FOUND') : unavailable(SCAN_CONFIG_INVALID, 'UNREADABLE');
  }
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    return e.code === 'ENOENT' ? unavailable(SCAN_CONFIG_MISSING, 'NOT_FOUND') : unavailable(SCAN_CONFIG_INVALID, 'UNREADABLE');
  }
  if (st.isSymbolicLink() || !st.isFile()) return unavailable(SCAN_CONFIG_INVALID, 'NOT_REGULAR_FILE');
  if (st.size > policy.max_bytes) return unavailable(SCAN_CONFIG_INVALID, 'TOO_LARGE');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return unavailable(SCAN_CONFIG_INVALID, 'UNREADABLE'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let config;
  try { config = JSON.parse(text); } catch { return unavailable(SCAN_CONFIG_INVALID, 'JSON_PARSE'); }
  let schema;
  try { schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8')); } catch { return unavailable(SCAN_CONFIG_INVALID, 'SCHEMA_UNAVAILABLE'); }
  return compilePublicScan(config, schema);
}

// 결과에 넣을 수 있는 요약. entries(정규식)는 넣지 않는다.
export function publicScanSummary(ps) {
  if (ps.ok) return { status: 'LOADED', count: ps.count };
  const { ok, ...rest } = ps;
  return { status: 'UNAVAILABLE', ...rest };
}
