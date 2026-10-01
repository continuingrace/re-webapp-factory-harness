// 비공개 식별자 로더 (IN-01·ST-04). 실제 CLI는 하네스 루트의 policies.private_identifiers.config_path만 읽는다.
// 경로는 대상 앱 파일·CLI 인자·환경 변수로 바꿀 수 없다. 테스트는 compileIdentifiers로 만든 fixture를 주입한다.
// 결과·오류에는 id·항목 번호·사유 코드만 담는다. 설정 값·정규식 원문·JSON 파싱 오류 메시지는 담지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { codeError } from './checks.mjs';
import { validateSchemaSubset } from './config-schema.mjs';

export const CONFIG_MISSING = 'IDENTIFIERS_CONFIG_MISSING';
export const CONFIG_INVALID = 'IDENTIFIERS_CONFIG_INVALID';
export const PATTERN_INVALID = 'IDENTIFIERS_PATTERN_INVALID';
export const ZERO_LENGTH_MATCH = 'IDENTIFIER_ZERO_LENGTH_MATCH';

const unavailable = (failure_code, reason, extra = {}) => ({ ok: false, failure_code, reason, ...extra });

// 빈 문자열에 길이 0으로 일치하는 regex는 거부한다. 아래 probe 문자열 검사는 보조 방어일 뿐 완전한 증명이 아니다.
// 조건부로만 길이 0이 되는 regex(예: 앞보기)는 여기서 걸리지 않을 수 있으며, countIdentifier가 스캔 중에 막는다.
const EMPTY_PROBES = [' ', 'a', 'a b', 'a-b_c.1\n'];

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function zeroLengthAt(source, text) {
  const re = new RegExp(source, 'gi');
  const m = re.exec(text);
  return m !== null && m[0].length === 0;
}

export function compileIdentifiers(config, schema) {
  if (config && Array.isArray(config.identifiers) && config.identifiers.length === 0) return unavailable(CONFIG_INVALID, 'EMPTY_LIST');
  const violations = validateSchemaSubset(schema, config);
  if (violations.length) return unavailable(CONFIG_INVALID, 'SCHEMA', { violations });
  const seen = new Set();
  const entries = [];
  for (const [index, e] of config.identifiers.entries()) {
    if (seen.has(e.id)) return unavailable(CONFIG_INVALID, 'DUPLICATE_ID', { index });
    seen.add(e.id);
    if (e.value.trim() === '') return unavailable(CONFIG_INVALID, 'BLANK_VALUE', { index });
    const source = e.match === 'literal' ? escapeRegExp(e.value) : e.value;
    try { new RegExp(source, 'gi'); } catch { return unavailable(PATTERN_INVALID, 'REGEX_COMPILE', { index }); }
    if (zeroLengthAt(source, '')) return unavailable(PATTERN_INVALID, 'REGEX_MATCHES_EMPTY', { index });
    if (EMPTY_PROBES.some((p) => zeroLengthAt(source, p))) return unavailable(PATTERN_INVALID, 'REGEX_MATCHES_EMPTY', { index });
    // 원문은 클로저 안에만 두고, 호출할 때마다 새 인스턴스를 만들어 lastIndex가 파일·검사 사이에 이어지지 않게 한다.
    entries.push(Object.freeze({ id: e.id, match: e.match, regex: () => new RegExp(source, 'gi') }));
  }
  return { ok: true, count: entries.length, entries };
}

// 하네스 루트 기준 고정 경로만 읽는다. config 폴더가 symlink·junction이거나 루트 밖으로 풀리면 거부한다.
export function loadIdentifiers(root, policy) {
  if (!policy || typeof policy.config_path !== 'string' || typeof policy.schema_path !== 'string' || !Number.isInteger(policy.max_bytes)) {
    return unavailable(CONFIG_INVALID, 'POLICY_INVALID');
  }
  const configDir = path.join(root, 'config');
  const file = path.resolve(root, ...policy.config_path.split('/'));
  const schemaFile = path.resolve(root, ...policy.schema_path.split('/'));
  if (path.dirname(file) !== configDir || path.dirname(schemaFile) !== configDir) return unavailable(CONFIG_INVALID, 'UNSAFE_PATH');
  try {
    const dir = fs.lstatSync(configDir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return unavailable(CONFIG_INVALID, 'UNSAFE_PATH');
    if (path.relative(fs.realpathSync.native(root), fs.realpathSync.native(configDir)) !== 'config') return unavailable(CONFIG_INVALID, 'UNSAFE_PATH');
  } catch (e) {
    return e.code === 'ENOENT' ? unavailable(CONFIG_MISSING, 'NOT_FOUND') : unavailable(CONFIG_INVALID, 'UNREADABLE');
  }
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    return e.code === 'ENOENT' ? unavailable(CONFIG_MISSING, 'NOT_FOUND') : unavailable(CONFIG_INVALID, 'UNREADABLE');
  }
  if (st.isSymbolicLink() || !st.isFile()) return unavailable(CONFIG_INVALID, 'NOT_REGULAR_FILE');
  if (st.size > policy.max_bytes) return unavailable(CONFIG_INVALID, 'TOO_LARGE');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return unavailable(CONFIG_INVALID, 'UNREADABLE'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let config;
  try { config = JSON.parse(text); } catch { return unavailable(CONFIG_INVALID, 'JSON_PARSE'); }
  let schema;
  try { schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8')); } catch { return unavailable(CONFIG_INVALID, 'SCHEMA_UNAVAILABLE'); }
  return compileIdentifiers(config, schema);
}

// 결과·evidence에 넣을 수 있는 요약. entries(정규식)는 넣지 않는다.
export function identifiersSummary(ids) {
  if (!ids) return { status: 'UNAVAILABLE', failure_code: CONFIG_MISSING, reason: 'NOT_PROVIDED' };
  if (ids.ok) return { status: 'LOADED', count: ids.count };
  const { ok, ...rest } = ids;
  return { status: 'UNAVAILABLE', ...rest };
}

// 새 인스턴스로 센다. 길이 0 match가 나오면 반복하지 않고 즉시 중단한다.
export function countIdentifier(entry, text) {
  const re = entry.regex();
  let n = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) throw codeError(ZERO_LENGTH_MATCH);
    n += 1;
  }
  return n;
}

// evidence용: 일치 부분을 [id]로 가린다. 겹치는 일치는 한 구간으로 합친다.
export function maskText(text, ids) {
  const ranges = [];
  for (const e of ids.entries) {
    const re = e.regex();
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      ranges.push([m.index, m.index + m[0].length, e.id]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let pos = 0;
  for (const [start, end, id] of ranges) {
    if (start < pos) { pos = Math.max(pos, end); continue; }
    out += `${text.slice(pos, start)}[${id}]`;
    pos = end;
  }
  return out + text.slice(pos);
}
