// 재현 가능한 public export.
//   node scripts/release/export-public.mjs <commit> <export_id> [--out <dir>]
// 작업 트리가 아니라 지정한 commit의 추적 파일만 읽는다(git 객체). manifest·공개 이력 대응표·standards_version도
// 그 commit의 것을 쓴다. 비공개 식별자와 public-scan 차단 목록은 하네스 루트의 ignored local 설정에서 읽는다.
// 결과는 <out>/<export_id>.partial/에 먼저 만들고, 모든 검사가 통과한 뒤에만 <out>/<export_id>/로 이름을 바꾼다.
// 실패하면 partial 경로와 실패 원인만 보고한다. 기존 export·partial이 있으면 아무것도 바꾸지 않고 중단한다.
// 같은 commit·export_id·(그 commit의) 대응표면 출력 경로와 관계없이 파일 목록과 내용 해시가 같다.
// git은 읽기 전용 하위 명령만 쓰며 원격 저장소·네트워크를 다루지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeError, loadChecks } from '../lib/checks.mjs';
import { git, privateHistoryShas } from '../lib/git-read.mjs';
import { attributionExemptionsOf, builtinRules, envRuleOf, isGenerated, loadScanConfigs, manifestIncludes, mapShas, scanStaging, validateManifest } from './scan-public.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASES_FILE = 'PUBLIC_RELEASES.md';

// ---------- git (읽기 전용, scripts/lib/git-read.mjs) ----------

function blobAt(root, sha, rel) {
  try { return git(root, ['cat-file', 'blob', `${sha}:${rel}`]); } catch { return null; }
}

// git cat-file --batch 출력: "<sha> blob <size>\n<내용>\n" 반복.
function readBlobs(root, shas) {
  if (shas.length === 0) return new Map();
  const out = git(root, ['cat-file', '--batch'], `${shas.join('\n')}\n`);
  const blobs = new Map();
  let pos = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl).toString('utf8').split(' ');
    if (header[0] !== sha || header[1] !== 'blob') throw codeError('BLOB_READ_FAILED');
    const size = Number(header[2]);
    blobs.set(sha, out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

// committer 줄의 시각과 시간대로 ISO 8601(오프셋 포함)을 만든다. 실행 시각과 무관하다.
function commitDate(root, sha) {
  const text = git(root, ['cat-file', 'commit', sha]).toString('utf8');
  const m = /^committer .* (\d+) ([+-])(\d{2})(\d{2})$/m.exec(text);
  if (!m) throw codeError('COMMIT_DATE_UNREADABLE');
  const offset = (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
  const local = new Date(Number(m[1]) * 1000 + offset * 60000).toISOString().slice(0, 19);
  return `${local}${m[2]}${m[3]}:${m[4]}`;
}

// ---------- 입력 검증 ----------

export function validExportId(id, pattern) {
  const m = typeof id === 'string' ? new RegExp(pattern).exec(id) : null;
  if (!m) return false;
  const [y, mo, d, n] = [m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6, 8), m[2]].map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return n >= 1 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const MAP_TOP = new Set(['schema_version', 'description', 'exports']);
const MAP_ENTRY = new Set(['export_id', 'kind', 'standards_version', 'private_standards_version', 'date', 'private_commit', 'public_commit',
  'scanner_standards_version', 'scanned_at', 'scan']);
const SCAN_META = ['scanner_standards_version', 'scanned_at', 'scan'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const SHA40 = /^[0-9a-f]{40}$/;
const isoOk = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));

// 선택 검사 기록: scanner의 standards_version·검사 시각·검사 결과. 세 필드는 함께 있거나 함께 없어야 한다.
// 결과는 통과한 export만 기록하므로 PASS·발견 0건이며, local 설정 값은 담을 수 없다(정해진 키만 허용).
function validScanMeta(e) {
  const present = SCAN_META.filter((k) => e[k] !== undefined);
  if (present.length === 0) return true;
  if (present.length !== SCAN_META.length) return false;
  const s = e.scan;
  if (!SEMVER.test(e.scanner_standards_version) || !isoOk(e.scanned_at)) return false;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (JSON.stringify(Object.keys(s).sort()) !== JSON.stringify(['file_count', 'findings', 'result', 'tree_sha256'])) return false;
  return s.result === 'PASS' && s.findings === 0 && Number.isInteger(s.file_count) && s.file_count > 0 && /^[0-9a-f]{64}$/.test(s.tree_sha256);
}

// 공개 이력 대응표 형식. 정해진 필드만 허용해 다른 값(메모·경로 등)이 PUBLIC_RELEASES.md로 흘러가지 않게 한다.
export function validatePublicMap(map, idPattern) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || map.schema_version !== '1.0.0' || !Array.isArray(map.exports)) return false;
  if (Object.keys(map).some((k) => !MAP_TOP.has(k))) return false;
  const seen = new Set();
  for (const e of map.exports) {
    if (!e || typeof e !== 'object' || Object.keys(e).some((k) => !MAP_ENTRY.has(k))) return false;
    if (!validExportId(e.export_id, idPattern) || seen.has(e.export_id)) return false;
    seen.add(e.export_id);
    if (!['submission', 'export'].includes(e.kind) || !SEMVER.test(e.standards_version)) return false;
    if (e.private_standards_version !== undefined && !SEMVER.test(e.private_standards_version)) return false;
    if (!isoOk(e.date)) return false;
    if (!SHA40.test(e.private_commit) || !SHA40.test(e.public_commit)) return false;
    if (!validScanMeta(e)) return false;
  }
  return true;
}

// PUBLIC_RELEASES.md: export ID·종류·standards_version·날짜만 담는다. SHA·경로·메모는 담지 않는다.
export function renderReleases(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.export_id.localeCompare(b.export_id));
  const lines = [
    '# 공개 이력',
    '',
    '이 저장소의 공개 버전 목록이다. export ID, 종류, standards_version, 날짜만 기록한다.',
    '',
    '| export ID | 종류 | standards_version | 날짜 |',
    '|---|---|---|---|',
    ...sorted.map((r) => `| ${r.export_id} | ${r.kind} | ${r.standards_version} | ${r.date.slice(0, 10)} |`),
  ];
  return `${lines.join('\n')}\n`;
}

// commit 경로는 그대로 staging에 쓰므로 이탈·Windows 특수 이름을 거부한다.
function safeRel(rel) {
  if (rel === '' || rel.includes('\\') || rel.includes(':') || rel.startsWith('/')) return false;
  return rel.split('/').every((c) => c !== '' && c !== '.' && c !== '..' && c.toLowerCase() !== '.git' && !/[. ]$/.test(c));
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function listFiles(dir, rel = '', out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.lstatSync(abs).isDirectory()) listFiles(abs, r, out);
    else out.push({ rel: r, abs });
  }
  return out;
}

// 파일 목록과 내용 해시. tree_sha256은 경로 순서로 "sha256  경로\n"을 이은 값의 해시다.
export function exportDigest(dir) {
  const files = listFiles(dir).map(({ rel, abs }) => ({ path: rel, sha256: sha256(fs.readFileSync(abs)) }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, tree_sha256: sha256(files.map((f) => `${f.sha256}  ${f.path}\n`).join('')) };
}

// ---------- export ----------

const fail = (code, error_code, extra = {}) => ({ code, out: { ok: false, error_code, ...extra } });

function parseArgs(argv) {
  const pos = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { out = argv[i + 1]; i += 1; } else pos.push(argv[i]);
  }
  if (pos.length !== 2 || (argv.includes('--out') && !out)) return null;
  return { commit: pos[0], exportId: pos[1], out };
}

function outDirOf(root, policy, outArg) {
  const repo = path.resolve(root);
  const def = path.join(repo, policy.export_dir);
  const out = outArg ? path.resolve(outArg) : def;
  const rel = path.relative(repo, out);
  const insideRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (insideRepo && out.toLowerCase() !== def.toLowerCase()) return null;
  return out;
}

export function runExport(root, argv) {
  const args = parseArgs(argv);
  if (!args) return fail(2, 'ARGS_INVALID');
  const { data, errors } = loadChecks(root);
  if (errors.length || !data.policies || !data.policies.public_export) return fail(2, 'CHECKS_INVALID');
  const policy = data.policies.public_export;
  if (!validExportId(args.exportId, policy.export_id_pattern)) return fail(2, 'EXPORT_ID_INVALID');
  if (!/^[0-9A-Za-z][0-9A-Za-z._/~^-]*$/.test(args.commit)) return fail(2, 'COMMIT_INVALID');
  const out = outDirOf(root, policy, args.out);
  if (!out) return fail(2, 'OUT_INVALID');

  // 비공개 탐지 설정이 없으면 아무것도 만들지 않고 중단한다.
  const cfg = loadScanConfigs(root, data);
  if (!cfg.ok) return { code: 2, out: cfg };
  let attributions;
  try { attributions = attributionExemptionsOf(data); } catch { return fail(2, 'ATTRIBUTION_POLICY_INVALID'); }

  let sha;
  try { sha = git(root, ['rev-parse', '--verify', '--quiet', `${args.commit}^{commit}`]).toString('utf8').trim(); } catch { return fail(2, 'COMMIT_NOT_FOUND'); }
  if (!SHA40.test(sha)) return fail(2, 'COMMIT_NOT_FOUND');
  // private 전체 이력의 commit SHA는 staging 검사에만 쓰고 출력하지 않는다.
  let history;
  try { history = privateHistoryShas(root); } catch { return fail(2, 'PRIVATE_HISTORY_UNAVAILABLE'); }

  const manifestBlob = blobAt(root, sha, policy.manifest_path);
  let manifest = null;
  try { manifest = manifestBlob && JSON.parse(manifestBlob.toString('utf8')); } catch { manifest = null; }
  if (!manifestBlob) return fail(2, 'MANIFEST_MISSING');
  if (!validateManifest(manifest)) return fail(2, 'MANIFEST_INVALID');

  const mapBlob = blobAt(root, sha, policy.map_path);
  let map = null;
  try { map = mapBlob && JSON.parse(mapBlob.toString('utf8')); } catch { map = null; }
  if (!mapBlob) return fail(2, 'PUBLIC_MAP_MISSING');
  if (!validatePublicMap(map, policy.export_id_pattern)) return fail(2, 'PUBLIC_MAP_INVALID');
  if (map.exports.some((e) => e.export_id === args.exportId)) return fail(2, 'EXPORT_ID_ALREADY_RECORDED');

  let commitChecks = null;
  try { commitChecks = JSON.parse((blobAt(root, sha, 'standards/checks.json') || '').toString('utf8')); } catch { commitChecks = null; }
  if (!commitChecks || !SEMVER.test(commitChecks.standards_version)) return fail(2, 'COMMIT_CHECKS_INVALID');

  // commit의 추적 파일 중 allowlist에 드는 것만 고른다.
  const tree = git(root, ['ls-tree', '-r', '-z', '--full-tree', sha]).toString('utf8').split('\0').filter(Boolean);
  const selected = [];
  const lower = new Set();
  for (const line of tree) {
    const tab = line.indexOf('\t');
    const [mode, type, object] = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1);
    if (!manifestIncludes(manifest, rel)) continue;
    if (isGenerated(manifest, rel)) return fail(2, 'GENERATED_PATH_TRACKED');
    if (mode === '120000') return fail(2, 'COMMIT_SYMLINK');
    if (type !== 'blob') return fail(2, 'COMMIT_SUBMODULE');
    if (!safeRel(rel)) return fail(2, 'UNSAFE_PATH_IN_COMMIT');
    if (lower.has(rel.toLowerCase())) return fail(2, 'CASE_COLLISION');
    lower.add(rel.toLowerCase());
    selected.push({ rel, object });
  }

  const finalDir = path.join(out, args.exportId);
  const partialDir = path.join(out, `${args.exportId}.partial`);
  if (fs.existsSync(finalDir)) return fail(2, 'EXPORT_EXISTS');
  if (fs.existsSync(partialDir)) return fail(2, 'PARTIAL_EXISTS');

  const date = commitDate(root, sha);
  const releases = renderReleases([
    ...map.exports.map((e) => ({ export_id: e.export_id, kind: e.kind, standards_version: e.standards_version, date: e.date })),
    { export_id: args.exportId, kind: 'export', standards_version: commitChecks.standards_version, date },
  ]);
  const blobs = readBlobs(root, [...new Set(selected.map((s) => s.object))]);

  fs.mkdirSync(out, { recursive: true });
  if (fs.lstatSync(out).isSymbolicLink()) return fail(2, 'OUT_INVALID');
  try { fs.mkdirSync(partialDir); } catch { return fail(2, 'PARTIAL_EXISTS'); }
  const shownPartial = path.relative(path.resolve(root), partialDir).startsWith('..') ? partialDir : path.relative(path.resolve(root), partialDir).split(path.sep).join('/');
  try {
    for (const s of selected) {
      const file = path.join(partialDir, ...s.rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, blobs.get(s.object), { flag: 'wx' });
    }
    fs.writeFileSync(path.join(partialDir, RELEASES_FILE), releases, { flag: 'wx' });
  } catch {
    return fail(1, 'WRITE_FAILED', { partial: shownPartial });
  }

  let scan;
  try {
    scan = scanStaging(partialDir, {
      manifest, ids: cfg.ids, ps: cfg.ps, rules: builtinRules(data, [...mapShas(map), sha, ...history]), env: envRuleOf(data),
      attributions,
    });
  } catch (e) {
    return fail(1, 'PUBLIC_SCAN_INCONCLUSIVE', { partial: shownPartial, reason: e.code || 'SCAN_ERROR' });
  }
  if (scan.findings.length) return fail(1, 'PUBLIC_SCAN_FAILED', { partial: shownPartial, findings: scan.findings });
  const expected = [...selected.map((s) => s.rel), RELEASES_FILE].sort();
  if (JSON.stringify([...scan.files].sort()) !== JSON.stringify(expected)) return fail(1, 'STAGING_MISMATCH', { partial: shownPartial });

  const digest = exportDigest(partialDir);
  try { fs.renameSync(partialDir, finalDir); } catch { return fail(1, 'FINALIZE_FAILED', { partial: shownPartial }); }
  const shownFinal = shownPartial.replace(/\.partial$/, '');
  return { code: 0, out: { ok: true, export_id: args.exportId, dir: shownFinal, file_count: digest.files.length, tree_sha256: digest.tree_sha256, files: digest.files } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { code, out } = runExport(ROOT, process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = code;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error_code: e.code && /^[A-Z_]+$/.test(e.code) ? e.code : 'EXPORT_ERROR' })}\n`);
    process.exitCode = 2;
  }
}
