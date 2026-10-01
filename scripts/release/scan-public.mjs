// public export staging 검사.
//   node scripts/release/scan-public.mjs <staging_dir>
// allowlist(public-manifest.json) 밖 파일, 금지 경로, symlink·junction·특수 파일, .env 파일, 그리고 내용·경로 이름의
// 비밀 패턴(ST-03), 개인키 블록, 개인 절대경로, commit SHA(공개 이력 대응표·private 전체 이력, git rev-list --all),
// 비공개 식별자, public-scan 차단 목록을 찾는다. 차단 목록 검사만 policies.public_export.attribution_exemptions의
// 한 파일·해시 고정 한 줄(외부 참고 자료 출처 표기)을 건너뛴다.
// 비공개 식별자와 차단 목록은 하네스 루트의 ignored local 설정에서만 읽으며, 둘 중 하나라도 없으면 검사하지 않고 중단한다.
// 출력에는 규칙 id·가린 경로·건수만 담는다. 값, 일치한 문자열, 해당 줄은 출력하지 않는다.
// 파일을 만들거나 고치지 않으며 네트워크를 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeError, getCheck, loadChecks } from '../lib/checks.mjs';
import { countIdentifier, escapeRegExp, identifiersSummary, loadIdentifiers, maskText } from '../lib/identifiers.mjs';
import { loadPublicScan, publicScanSummary } from '../lib/public-scan.mjs';
import { privateHistoryShas } from '../lib/git-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- manifest ----------

const MANIFEST_KEYS = new Set(['schema_version', 'description', 'include', 'exclude', 'generated']);
const safeEntry = (e) => typeof e === 'string' && e !== '' && !e.startsWith('/') && !e.includes('\\') && !e.split('/').includes('..');

export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.schema_version !== '1.0.0') return false;
  if (Object.keys(m).some((k) => !MANIFEST_KEYS.has(k))) return false;
  return ['include', 'exclude', 'generated'].every((k) => Array.isArray(m[k]) && m[k].every(safeEntry)) && m.include.length > 0;
}

// 'dir/'는 그 아래 전체, '*'는 경로 한 단계 안의 임의 문자열, 그 밖은 정확한 경로.
function entryMatches(entry, rel, ignoreCase) {
  const e = ignoreCase ? entry.toLowerCase() : entry;
  const r = ignoreCase ? rel.toLowerCase() : rel;
  if (e.endsWith('/')) return r.startsWith(e);
  if (!e.includes('*')) return r === e;
  const source = e.split('*').map(escapeRegExp).join('[^/]*');
  return new RegExp(`^${source}$`).test(r);
}

export const manifestExcludes = (m, rel) => m.exclude.some((e) => entryMatches(e, rel, true));
export const manifestIncludes = (m, rel) => !manifestExcludes(m, rel) && m.include.some((e) => entryMatches(e, rel, false));
export const isGenerated = (m, rel) => m.generated.includes(rel);

// ---------- 검사 규칙 ----------

const entry = (id, source, flags) => Object.freeze({ id, regex: () => new RegExp(source, flags) });

// 앞뒤에 다른 영문자·숫자가 붙지 않은 7~40자리 hex 토큰. 64자리 해시 안의 일부나 영숫자에 붙은 문자열은 토큰이 아니다.
const HEX_TOKEN = '(?<![0-9A-Za-z])[0-9A-Fa-f]{7,40}(?![0-9A-Za-z])';

// commit SHA 규칙: hex 토큰이 주어진 SHA 중 하나의 prefix이면 일치로 센다(대소문자 무시).
// 토큰을 한 번 찾고 앞 7자리 색인으로 대조하므로 이력이 길어도 SHA마다 정규식을 만들지 않는다. SHA 값은 출력하지 않는다.
export function commitShaRule(shas) {
  const byPrefix = new Map();
  for (const s of new Set(shas.filter((x) => typeof x === 'string' && /^[0-9a-f]{40}$/i.test(x)).map((x) => x.toLowerCase()))) {
    if (!byPrefix.has(s.slice(0, 7))) byPrefix.set(s.slice(0, 7), []);
    byPrefix.get(s.slice(0, 7)).push(s);
  }
  const accept = (token) => {
    const t = token.toLowerCase();
    return (byPrefix.get(t.slice(0, 7)) || []).some((s) => s.startsWith(t));
  };
  return Object.freeze({ id: 'PUB-COMMIT-SHA', regex: () => new RegExp(HEX_TOKEN, 'g'), accept, empty: byPrefix.size === 0 });
}

// 규칙 하나의 일치 건수. accept가 있는 규칙은 후보 중 accept된 것만 센다.
export function countRule(rule, text) {
  if (!rule.accept) return countIdentifier(rule, text);
  let n = 0;
  for (const m of text.matchAll(rule.regex())) if (rule.accept(m[0])) n += 1;
  return n;
}

// 내장 규칙: checks.json의 ST-03 패턴·개인키 블록 시작·개인 절대경로 패턴, 그리고 commit SHA 규칙
// (공개 이력 대응표·export 대상 commit·private 전체 이력의 SHA).
export function builtinRules(checksData, shas = []) {
  const policy = checksData.policies.public_export;
  const rules = [];
  for (const [id, src] of Object.entries(getCheck(checksData, 'ST-03').rule.patterns)) rules.push(entry(id, src, 'g'));
  rules.push(entry('PUB-PRIVATE-KEY', checksData.policies.evidence_text.private_key_block.begin, 'g'));
  for (const [id, src] of Object.entries(policy.absolute_path_patterns)) rules.push(entry(id, src, 'gi'));
  const sha = commitShaRule(shas);
  if (!sha.empty) rules.push(sha);
  return rules;
}

// local 설정 두 개를 불러온다. 하나라도 없거나 잘못되면 검사를 시작하지 않는다.
export function loadScanConfigs(root, checksData) {
  const policy = checksData.policies.public_export;
  const ids = loadIdentifiers(root, checksData.policies.private_identifiers);
  if (!ids.ok) return { ok: false, error_code: ids.failure_code, identifiers_config: identifiersSummary(ids) };
  const ps = loadPublicScan(root, policy && policy.scan_config);
  if (!ps.ok) return { ok: false, error_code: ps.failure_code, public_scan_config: publicScanSummary(ps) };
  return { ok: true, ids, ps };
}

// 외부 참고 자료 출처 표기 예외: 정해진 파일 하나의, 내용 해시가 정확히 같은 줄 하나만 scan_config 차단 목록 검사에서 뺀다.
// 비밀·개인키·개인 경로·commit SHA·비공개 식별자 규칙은 그 줄에도 그대로 적용한다. 정책 형식이 틀리면 검사하지 않는다.
const ATTRIBUTION_KEYS = ['id', 'path', 'line_sha256', 'applies_to'];
export function attributionExemptionsOf(checksData) {
  const list = checksData.policies.public_export.attribution_exemptions;
  if (list === undefined) return [];
  const valid = Array.isArray(list) && list.every((a) => a && typeof a === 'object'
    && Object.keys(a).sort().join() === [...ATTRIBUTION_KEYS].sort().join()
    && /^ATTR-[A-Z0-9-]+$/.test(a.id) && safeEntry(a.path) && !a.path.endsWith('/') && !a.path.includes('*')
    && /^[0-9a-f]{64}$/.test(a.line_sha256) && a.applies_to === 'scan_config')
    && new Set(list.map((a) => a.id)).size === list.length;
  if (!valid) throw codeError('ATTRIBUTION_POLICY_INVALID');
  return list.map((a) => Object.freeze({ id: a.id, path: a.path, line_sha256: a.line_sha256 }));
}

export const lineSha256 = (line) => createHash('sha256').update(line.replace(/\r$/, ''), 'utf8').digest('hex');

export function envRuleOf(checksData) {
  const r = getCheck(checksData, 'ST-03').rule;
  return { fail: new RegExp(r.env_files_fail), allowed: new Set(r.env_files_allowed_if_clean) };
}

// ---------- staging 검사 ----------

function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) out.push({ rel: r, kind: 'link' });
    else if (st.isDirectory()) walk(abs, r, out);
    else if (st.isFile()) out.push({ rel: r, kind: 'file', abs });
    else out.push({ rel: r, kind: 'special' });
  }
}

// 출처 표기 예외 줄을 빈 줄로 바꾼 본문과, 같은 예외 줄이 두 번 이상 나온 예외 id별 건수를 돌려준다.
function withoutAttributionLines(text, exemptions) {
  const hits = new Map();
  const lines = text.split('\n').map((line) => {
    const a = exemptions.find((x) => x.line_sha256 === lineSha256(line));
    if (!a) return line;
    hits.set(a.id, (hits.get(a.id) || 0) + 1);
    return '';
  });
  return { text: lines.join('\n'), duplicates: [...hits].filter(([, n]) => n > 1) };
}

// ctx: { manifest, ids, ps, rules(builtinRules), env(envRuleOf), attributions?(attributionExemptionsOf) }
// 반환: { scanned, files: [rel], findings: [{ check, id?, path, count? }] }. path는 모든 규칙으로 가린 값이다.
export function scanStaging(dir, ctx) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw codeError('STAGING_INVALID');
  const items = [];
  walk(dir, '', items);
  const textRules = [...ctx.rules, ...ctx.ids.entries, ...ctx.ps.entries];
  const psEntries = new Set(ctx.ps.entries);
  const plain = textRules.filter((r) => !r.accept);
  const filtered = textRules.filter((r) => r.accept);
  // 경로 표시는 모든 규칙으로 가린다. accept 규칙은 실제로 일치한 토큰만 가린다.
  const mask = (rel) => filtered.reduce((s, r) => s.replace(r.regex(), (m) => (r.accept(m) ? `[${r.id}]` : m)), maskText(rel, { entries: plain }));
  const findings = [];
  for (const it of items) {
    const shown = mask(it.rel);
    if (it.kind !== 'file') {
      findings.push({ check: it.kind === 'link' ? 'LINK' : 'SPECIAL_FILE', path: shown });
      continue;
    }
    if (manifestExcludes(ctx.manifest, it.rel)) findings.push({ check: 'FORBIDDEN_PATH', path: shown });
    else if (!manifestIncludes(ctx.manifest, it.rel) && !isGenerated(ctx.manifest, it.rel)) findings.push({ check: 'NOT_ALLOWLISTED', path: shown });
    const base = it.rel.split('/').pop();
    if (ctx.env.fail.test(base) && !ctx.env.allowed.has(base)) findings.push({ check: 'ENV_FILE', path: shown });
    for (const r of textRules) {
      const n = countRule(r, it.rel);
      if (n) findings.push({ check: 'PATH_NAME', id: r.id, path: shown, count: n });
    }
    // 바이너리(NUL 포함)도 건너뛰지 않고 latin1로 읽는다.
    const buf = fs.readFileSync(it.abs);
    const text = buf.includes(0) ? buf.toString('latin1') : buf.toString('utf8');
    // 출처 표기 예외는 정확히 같은 경로(대소문자 구분)에서 scan_config 차단 목록에만 적용한다.
    const exemptions = (ctx.attributions || []).filter((a) => a.path === it.rel);
    let psText = text;
    if (exemptions.length) {
      const w = withoutAttributionLines(text, exemptions);
      psText = w.text;
      for (const [id, n] of w.duplicates) findings.push({ check: 'ATTRIBUTION_DUPLICATE', id, path: shown, count: n });
    }
    for (const r of textRules) {
      const n = countRule(r, psEntries.has(r) ? psText : text);
      if (n) findings.push({ check: 'CONTENT', id: r.id, path: shown, count: n });
    }
  }
  return { scanned: items.length, files: items.filter((i) => i.kind === 'file').map((i) => i.rel), findings };
}

// 공개 이력 대응표의 모든 commit SHA (private·public). 없으면 빈 목록.
export const mapShas = (map) => (map && Array.isArray(map.exports) ? map.exports.flatMap((e) => [e.private_commit, e.public_commit]) : []);

// ---------- CLI ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function runScan(root, stagingArg) {
  if (typeof stagingArg !== 'string' || stagingArg === '') return { code: 2, out: { ok: false, error_code: 'ARGS_INVALID' } };
  const { data, errors } = loadChecks(root);
  if (errors.length || !data.policies || !data.policies.public_export) return { code: 2, out: { ok: false, error_code: 'CHECKS_INVALID' } };
  const policy = data.policies.public_export;
  const manifest = readJson(path.join(root, ...policy.manifest_path.split('/')));
  if (!validateManifest(manifest)) return { code: 2, out: { ok: false, error_code: 'MANIFEST_INVALID' } };
  const cfg = loadScanConfigs(root, data);
  if (!cfg.ok) return { code: 2, out: cfg };
  const map = readJson(path.join(root, ...policy.map_path.split('/')));
  let history;
  try { history = privateHistoryShas(root); } catch { return { code: 2, out: { ok: false, error_code: 'PRIVATE_HISTORY_UNAVAILABLE' } }; }
  let attributions;
  try { attributions = attributionExemptionsOf(data); } catch { return { code: 2, out: { ok: false, error_code: 'ATTRIBUTION_POLICY_INVALID' } }; }
  const staging = path.resolve(stagingArg);
  let r;
  try {
    r = scanStaging(staging, { manifest, ids: cfg.ids, ps: cfg.ps, rules: builtinRules(data, [...mapShas(map), ...history]), env: envRuleOf(data), attributions });
  } catch (e) {
    return { code: 2, out: { ok: false, error_code: e.code === 'ENOENT' ? 'STAGING_INVALID' : e.code || 'SCAN_ERROR' } };
  }
  return { code: r.findings.length ? 1 : 0, out: { ok: r.findings.length === 0, scanned: r.scanned, findings: r.findings } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { code, out } = runScan(ROOT, process.argv[2]);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = code;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error_code: e.code || 'SCAN_ERROR' })}\n`);
    process.exitCode = 2;
  }
}
