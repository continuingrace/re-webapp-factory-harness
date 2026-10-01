// 단계 3: 재현 가능한 public export·scan. 임시 git 저장소(하네스 복사본)에서만 실행하고 fixture 설정만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_IDS, REPO, fakeToken, makeHarnessCopy, publicCandidateFiles, runNode, withTemp, writeFiles } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { SCAN_CONFIG_INVALID, SCAN_PATTERN_INVALID, compilePublicScan } from '../../scripts/lib/public-scan.mjs';
import { exportDigest, renderReleases, validExportId, validatePublicMap } from '../../scripts/release/export-public.mjs';
import { GIT_READ_ONLY, git, privateHistoryShas } from '../../scripts/lib/git-read.mjs';
import { attributionExemptionsOf, builtinRules, commitShaRule, lineSha256, countRule, envRuleOf, manifestIncludes, mapShas, scanStaging, validateManifest } from '../../scripts/release/scan-public.mjs';

const { data } = loadChecks(REPO);
const POLICY = data.policies.public_export;
const ID = 'pub-20261001-01';
const COMMIT_DATE = '2026-10-01T09:00:00+09:00';
const PUBLIC_SCAN_FIXTURE_FILE = path.join(REPO, 'tests', 'fixtures', 'public-scan.fixture.json');
const PUBLIC_SCAN_FIXTURE = JSON.parse(fs.readFileSync(PUBLIC_SCAN_FIXTURE_FILE, 'utf8'));
const PUBLIC_SCAN_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'public-scan.schema.json'), 'utf8'));
const FIXTURE_PS = compilePublicScan(PUBLIC_SCAN_FIXTURE, PUBLIC_SCAN_SCHEMA);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'release', 'public-manifest.json'), 'utf8'));
// 대응표는 private 전용 파일(ops/)이 아니라 일반 fixture로 검증한다 (public에서도 같은 테스트가 돈다).
const MAP_FIXTURE_FILE = path.join(REPO, 'tests', 'fixtures', 'public-map.fixture.json');
const MAP = JSON.parse(fs.readFileSync(MAP_FIXTURE_FILE, 'utf8'));
const MAP_SHAS = mapShas(MAP);
const SUBMISSION_ID = MAP.exports[0].export_id;
// private 운영 문서 경로의 제외를 확인하려고 임시 트리에만 만드는 테스트용 내용
const OPERATIONS_DOC = 'docs/harness-operations.md';
// 출력·staging에 나오면 안 되는 값: fixture 식별자·차단 목록 값, 대응표 SHA(앞 7자리로 비교)
const SECRET_VALUES = ['fixture-foreign-brand', 'fxword', ...PUBLIC_SCAN_FIXTURE.forbidden.filter((f) => f.match === 'literal').map((f) => f.value), 'fixture-codename'];

function gitRun(cwd, args, input) {
  const r = spawnSync('git', [
    '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${path.join(cwd, '.no-hooks')}`, ...args,
  ], { cwd, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE } });
  if (r.status !== 0) throw new Error(`git ${args[0]} 실패`);
  return r.stdout.trim();
}

// 하네스 복사본 + fixture local 설정 두 개 + 공개 이력 대응표로 임시 git 저장소를 만든다.
function makeExportRepo(t) {
  const root = makeHarnessCopy(t);
  fs.copyFileSync(PUBLIC_SCAN_FIXTURE_FILE, path.join(root, 'config', 'public-scan.local.json'));
  for (const f of ['.gitignore', 'CLAUDE.md', 'README.md', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  writeFiles(root, { 'ops/public-map.json': fs.readFileSync(MAP_FIXTURE_FILE), [OPERATIONS_DOC]: '# 운영 절차 (테스트용 private 문서)\n' });
  // tests/fixtures는 fixture 값 자체를 담고 있어 이 복사본의 local 설정(fixture)에 걸리므로 넣지 않는다.
  gitRun(root, ['init', '-q', '-b', 'main']);
  gitRun(root, ['add', '-A']);
  gitRun(root, ['commit', '-q', '-m', 'base']);
  return { root, sha: gitRun(root, ['rev-parse', 'HEAD']) };
}

function commitFiles(root, files, { force = false } = {}) {
  writeFiles(root, files);
  gitRun(root, ['add', ...(force ? ['-f'] : []), '--', ...Object.keys(files)]);
  gitRun(root, ['commit', '-q', '-m', 'change']);
  return gitRun(root, ['rev-parse', 'HEAD']);
}

function exportCli(root, args) {
  const r = runNode(path.join(root, 'scripts', 'release', 'export-public.mjs'), args, { cwd: root });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { status: r.status, json, text: r.stdout + r.stderr };
}

const blob = (root, spec) => spawnSync('git', ['cat-file', 'blob', spec], { cwd: root, windowsHide: true }).stdout;
const noLeak = (text) => SECRET_VALUES.every((v) => !text.toLowerCase().includes(v.toLowerCase())) && MAP_SHAS.every((s) => !text.toLowerCase().includes(s.slice(0, 7)));

// ---------- 재현성·commit 기준 ----------

test('export: 같은 commit·export ID·대응표면 다른 출력 경로에서 파일 목록과 내용 해시가 같고, 작업 트리 변경은 들어가지 않는다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  fs.appendFileSync(path.join(root, 'docs', 'harness-purpose.md'), '\nworking tree only\n');
  writeFiles(root, { 'docs/untracked-note.md': 'untracked' });
  const a = exportCli(root, [sha, ID, '--out', path.join(t, 'out-a')]);
  const b = exportCli(root, ['HEAD', ID, '--out', path.join(t, 'out-b', 'nested')]);
  assert.equal(a.status, 0, a.text);
  assert.equal(b.status, 0, b.text);
  assert.deepEqual(a.json.files, b.json.files);
  assert.equal(a.json.tree_sha256, b.json.tree_sha256);
  const dir = path.join(t, 'out-a', ID);
  assert.deepEqual(exportDigest(dir), { files: a.json.files, tree_sha256: a.json.tree_sha256 });
  assert.ok(fs.readFileSync(path.join(dir, 'docs', 'harness-purpose.md')).equals(blob(root, `${sha}:docs/harness-purpose.md`)));
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'untracked-note.md')));
  assert.ok(!fs.existsSync(path.join(t, 'out-a', `${ID}.partial`)));
  const paths = a.json.files.map((f) => f.path);
  assert.ok(paths.includes('PUBLIC_RELEASES.md') && paths.includes('scripts/release/export-public.mjs') && paths.includes('standards/checks.json'));
  for (const p of ['README.md', 'docs/PRD.md', 'docs/story-work.md', 'docs/harness-limitations.md']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.includes('docs/harness-operations.md'));
  assert.ok(paths.every((p) => p === 'PUBLIC_RELEASES.md' || manifestIncludes(MANIFEST, p)), 'allowlist 밖 파일 없음');
  assert.ok(paths.every((p) => !p.startsWith('ops/') && !/\.local\.json$/i.test(p) && !p.startsWith('runs/')));
  assert.ok(noLeak(a.text), 'stdout에 값·SHA 없음');
  assert.ok(!a.text.includes(sha.slice(0, 7)), 'stdout에 source commit SHA 없음');
}));

test('export: PUBLIC_RELEASES.md는 submission 이력과 이번 export의 ID·종류·버전·날짜만 담는다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const r = exportCli(root, [sha, ID, '--out', path.join(t, 'out')]);
  assert.equal(r.status, 0, r.text);
  const text = fs.readFileSync(path.join(t, 'out', ID, 'PUBLIC_RELEASES.md'), 'utf8');
  const rows = text.split('\n').filter((l) => l.startsWith('| pub-'));
  assert.deepEqual(rows, [
    `| ${SUBMISSION_ID} | submission | ${MAP.exports[0].standards_version} | ${MAP.exports[0].date.slice(0, 10)} |`,
    `| ${ID} | export | ${data.standards_version} | 2026-10-01 |`,
  ]);
  assert.ok(noLeak(text));
  assert.ok(!text.toLowerCase().includes(sha.slice(0, 7)));
  assert.ok(!/private|commit|[A-Za-z]:[\\/]/i.test(text));
  assert.equal(renderReleases([{ ...MAP.exports[0] }]).includes(MAP_SHAS[0].slice(0, 7)), false);
}));

test('export: 대응표에 정해지지 않은 필드·잘못된 값이 있으면 중단하고 staging을 만들지 않는다', () => withTemp((t) => {
  const { root } = makeExportRepo(t);
  const bad = JSON.parse(JSON.stringify(MAP));
  bad.exports[0].note = 'fixture-foreign-brand';
  const sha = commitFiles(root, { 'ops/public-map.json': JSON.stringify(bad) });
  const r = exportCli(root, [sha, ID, '--out', path.join(t, 'out')]);
  assert.equal(r.json.error_code, 'PUBLIC_MAP_INVALID');
  assert.ok(!fs.existsSync(path.join(t, 'out')));
  assert.ok(noLeak(r.text));
  const shaMissing = commitFiles(root, { 'ops/public-map.json': '{ not json' });
  assert.equal(exportCli(root, [shaMissing, ID, '--out', path.join(t, 'out')]).json.error_code, 'PUBLIC_MAP_INVALID');
  assert.equal(exportCli(root, [shaMissing, SUBMISSION_ID, '--out', path.join(t, 'out')]).json.error_code, 'PUBLIC_MAP_INVALID');
}));

test('대응표 형식: submission 항목을 가진 fixture 대응표는 유효하고, 정해진 형식을 벗어나면 거부된다', () => {
  assert.ok(validatePublicMap(MAP, POLICY.export_id_pattern));
  assert.deepEqual(MAP.exports.map((e) => e.kind), ['submission']);
  assert.ok(MAP.exports.every((e) => /^[0-9a-f]{40}$/.test(e.private_commit) && /^[0-9a-f]{40}$/.test(e.public_commit)));
  for (const bad of [{ ...MAP, extra: 1 }, { ...MAP, exports: [{ ...MAP.exports[0], kind: 'draft' }] }, { ...MAP, exports: [{ ...MAP.exports[0], private_commit: 'abc' }] },
    { ...MAP, exports: [MAP.exports[0], MAP.exports[0]] }, { ...MAP, exports: [{ ...MAP.exports[0], date: '2026-01-01' }] }]) {
    assert.equal(validatePublicMap(bad, POLICY.export_id_pattern), false);
  }
});

test('manifest: allowlist는 ops·local 설정·runs·releases·inbox·export·node_modules·.git을 제외한다', () => {
  assert.ok(validateManifest(MANIFEST));
  for (const p of ['docs/harness-purpose.md', 'scripts/release/scan-public.mjs', 'config/public-scan.schema.json', 'config/identifiers.example.json', 'tests/unit/helpers.mjs', '.claude/settings.json', 'CLAUDE.md',
    'README.md', 'docs/PRD.md', 'docs/story-work.md', 'docs/harness-limitations.md']) {
    assert.ok(manifestIncludes(MANIFEST, p), p);
  }
  for (const p of ['ops/public-map.json', 'OPS/public-map.json', 'config/identifiers.local.json', 'config/Public-Scan.LOCAL.json', 'runs/a/run.json', 'releases/a/v1.md', '.harness-inbox/x',
    '.export/pub-x/a', 'node_modules/x/index.js', '.git/config', 'notes/private.md', 'PUBLIC_RELEASES.md', 'docs/harness-operations.md', 'DOCS/Harness-Operations.md']) {
    assert.ok(!manifestIncludes(MANIFEST, p), p);
  }
});

const SCAN_META_ENTRY = {
  export_id: 'pub-20261001-05', kind: 'export', standards_version: '1.6.3', date: '2026-10-01T09:00:00+09:00',
  private_commit: 'a'.repeat(40), public_commit: 'b'.repeat(40),
  scanner_standards_version: '1.6.3', scanned_at: '2026-10-01T10:11:12+09:00',
  scan: { result: 'PASS', findings: 0, file_count: 120, tree_sha256: 'c'.repeat(64) },
};

test('대응표 검사 기록: 선택 필드는 함께 있을 때만, 정해진 형식일 때만 허용하고 submission 항목에는 없다', () => {
  const withMeta = { ...MAP, exports: [...MAP.exports, SCAN_META_ENTRY] };
  assert.ok(validatePublicMap(withMeta, POLICY.export_id_pattern));
  assert.ok(MAP.exports.filter((e) => e.kind === 'submission').every((e) => !('scan' in e) && !('scanned_at' in e) && !('scanner_standards_version' in e)));
  const { scan, ...noScan } = SCAN_META_ENTRY;
  const bads = [
    noScan,
    { ...SCAN_META_ENTRY, scanner_standards_version: 'x' },
    { ...SCAN_META_ENTRY, scanned_at: '2026-10-01' },
    { ...SCAN_META_ENTRY, scan: { ...scan, result: 'FAIL' } },
    { ...SCAN_META_ENTRY, scan: { ...scan, findings: 1 } },
    { ...SCAN_META_ENTRY, scan: { ...scan, file_count: 0 } },
    { ...SCAN_META_ENTRY, scan: { ...scan, tree_sha256: 'x' } },
    { ...SCAN_META_ENTRY, scan: { ...scan, value: 'fixture-foreign-brand' } },
    { ...SCAN_META_ENTRY, config_hash: 'd'.repeat(64) },
  ];
  for (const b of bads) assert.equal(validatePublicMap({ ...MAP, exports: [...MAP.exports, b] }, POLICY.export_id_pattern), false, JSON.stringify(Object.keys(b)));
});

test('export: 대응표에 검사 기록이 있어도 PUBLIC_RELEASES.md에는 ID·종류·버전·날짜만 나오고 SHA·검사 기록은 나오지 않는다', () => withTemp((t) => {
  const { root } = makeExportRepo(t);
  const sha = commitFiles(root, { 'ops/public-map.json': JSON.stringify({ ...MAP, exports: [...MAP.exports, SCAN_META_ENTRY] }) });
  const r = exportCli(root, [sha, ID, '--out', path.join(t, 'out')]);
  assert.equal(r.status, 0, r.text);
  const text = fs.readFileSync(path.join(t, 'out', ID, 'PUBLIC_RELEASES.md'), 'utf8');
  assert.ok(text.includes('| pub-20261001-05 | export | 1.6.3 | 2026-10-01 |'));
  for (const v of ['a'.repeat(7), 'b'.repeat(7), 'c'.repeat(7), '10:11:12', 'PASS', '120', 'scanner', 'scan']) assert.ok(!text.includes(v), v);
  assert.ok(noLeak(text) && noLeak(r.text));
}));

test('README: 상대 링크가 모두 존재하는 파일·폴더를 가리키고 private 전용 문서·대응표를 가리키지 않는다', () => {
  const text = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const links = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/i.test(l));
  assert.ok(links.length >= 10);
  for (const l of links) {
    assert.ok(fs.existsSync(path.join(REPO, ...l.split('/').filter(Boolean))), l);
    assert.ok(manifestIncludes(MANIFEST, l) || manifestIncludes(MANIFEST, `${l.replace(/\/$/, '')}/x`), `public에 없는 대상: ${l}`);
  }
  assert.ok(!/harness-operations|ops\/public-map|PUBLIC_RELEASES\.md\]\(/.test(text));
  assert.ok(/Node\.js 20 이상/.test(text) && /Node\.js 24/.test(text) && /Node\.js 20 직접 실행: `NOT_RUN`/.test(text));
});

test('private 운영 문서 경로는 커밋에 있어도 export 대상이 아니고, staging에 들어가면 FORBIDDEN_PATH로 막는다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  assert.ok(blob(root, `${sha}:${OPERATIONS_DOC}`).length > 0, '임시 커밋에 운영 문서가 있음');
  const r = exportCli(root, [sha, ID, '--out', path.join(t, 'out')]);
  assert.equal(r.status, 0, r.text);
  assert.ok(!r.json.files.some((f) => f.path.toLowerCase() === OPERATIONS_DOC));
  const staging = path.join(t, 'stage');
  writeFiles(staging, { [OPERATIONS_DOC]: 'x', 'DOCS/Harness-Operations.md': 'x' });
  const ctx = { manifest: MANIFEST, ids: FIXTURE_IDS, ps: FIXTURE_PS, rules: builtinRules(data, MAP_SHAS), env: envRuleOf(data) };
  const found = scanStaging(staging, ctx).findings.filter((f) => f.check === 'FORBIDDEN_PATH').map((f) => f.path.toLowerCase());
  assert.ok(found.includes(OPERATIONS_DOC));
}));

test('publicCandidateFiles: production manifest 판정과 같은 파일 목록을 내고, 제외되지 않은 링크는 실패한다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const r = exportCli(root, [sha, ID, '--out', path.join(t, 'out')]);
  assert.equal(r.status, 0, r.text);
  const exported = r.json.files.map((f) => f.path).filter((p) => p !== 'PUBLIC_RELEASES.md').sort();
  assert.deepEqual(publicCandidateFiles(root).sort(), exported, 'export 선택과 동일');
  assert.ok(publicCandidateFiles(path.join(t, 'out', ID)).includes('PUBLIC_RELEASES.md'), 'staging에서는 생성 파일도 포함');
  fs.mkdirSync(path.join(t, 'outside'));
  fs.symlinkSync(path.join(t, 'outside'), path.join(root, 'node_modules'), 'junction');
  assert.deepEqual(publicCandidateFiles(root).sort(), exported, '제외 경로의 junction은 따라가지 않고 건너뜀');
  fs.symlinkSync(path.join(t, 'outside'), path.join(root, 'docs', 'linked'), 'junction');
  assert.throws(() => publicCandidateFiles(root), /PUBLIC_CANDIDATE_LINK/);
  // 임시 폴더 정리 전에 junction을 끊는다 (대상 폴더 보호)
  fs.unlinkSync(path.join(root, 'docs', 'linked'));
  fs.unlinkSync(path.join(root, 'node_modules'));
}));

// ---------- 위반 차단 ----------

test('export: 커밋에 심은 식별자·차단 값·비밀·개인키·개인 경로·대응표 SHA·.env는 partial에서 멈추고 값을 출력하지 않는다', () => withTemp((t) => {
  const { root } = makeExportRepo(t);
  const sep = String.fromCharCode(92);
  const cases = [
    ['docs/leak-id.md', 'x fixture-foreign-brand y', 'CONTENT', 'ID-FIXTURE-1'],
    ['docs/fxword-name.md', 'clean', 'PATH_NAME', 'ID-FIXTURE-2'],
    ['docs/leak-email.md', 'mail leak-owner@example.invalid', 'CONTENT', 'PS-FIXTURE-EMAIL'],
    ['docs/leak-path.md', `dir D:${sep}fixture-private-workspace${sep}a`, 'CONTENT', 'PS-FIXTURE-PATH'],
    ['docs/leak-repo.md', 'repo example-org/fixture-private-repo', 'CONTENT', 'PS-FIXTURE-REPO'],
    ['docs/leak-codename.md', 'the fixture-codename plan', 'CONTENT', 'PS-FIXTURE-OTHER'],
    ['docs/leak-token.md', `token ${fakeToken()}`, 'CONTENT', 'SEC-GH-CLASSIC'],
    ['docs/leak-key.md', ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '), 'CONTENT', 'PUB-PRIVATE-KEY'],
    ['docs/leak-win.md', ['C:', 'Users', 'leakuser', 'x'].join(sep), 'CONTENT', 'PUB-ABS-PATH-WIN'],
    ['docs/leak-mac.md', ['', 'Users', 'leakuser', 'x'].join('/'), 'CONTENT', 'PUB-ABS-PATH-MAC'],
    ['docs/leak-linux.md', ['', 'home', 'leakuser', 'x'].join('/'), 'CONTENT', 'PUB-ABS-PATH-LINUX'],
    ['docs/leak-sha.md', `see ${MAP_SHAS[0]}`, 'CONTENT', 'PUB-COMMIT-SHA'],
    ['docs/leak-short-sha.md', `public ${MAP_SHAS[1].slice(0, 7)}`, 'CONTENT', 'PUB-COMMIT-SHA'],
    ['docs/.env', 'X=1', 'ENV_FILE', undefined],
  ];
  for (const [i, [rel, content, check, id]] of cases.entries()) {
    const sha = commitFiles(root, { [rel]: content });
    const exportId = `pub-20261001-${String(i + 10).padStart(2, '0')}`;
    const out = path.join(t, 'out');
    const r = exportCli(root, [sha, exportId, '--out', out]);
    assert.equal(r.status, 1, `${rel}: ${r.text}`);
    assert.equal(r.json.error_code, 'PUBLIC_SCAN_FAILED', rel);
    assert.ok(r.json.findings.some((f) => f.check === check && f.id === id), `${rel}: ${JSON.stringify(r.json.findings)}`);
    assert.equal(r.json.partial, path.join(out, `${exportId}.partial`));
    assert.ok(fs.existsSync(r.json.partial) && !fs.existsSync(path.join(out, exportId)), rel);
    assert.ok(noLeak(r.text), `${rel}: 출력에 값 없음`);
    assert.ok(!r.text.includes('leakuser') && !r.text.includes(fakeToken()), rel);
    gitRun(root, ['rm', '-q', '--', rel]);
    gitRun(root, ['commit', '-q', '-m', 'revert']);
  }
}));

test('export: allowlist 밖·제외 대상 추적 파일은 내보내지 않는다 (local 설정·대응표 강제 추가 포함)', () => withTemp((t) => {
  const { root } = makeExportRepo(t);
  const sha = commitFiles(root, { 'notes/private.md': 'fixture-foreign-brand', 'config/identifiers.local.json': fs.readFileSync(path.join(root, 'config', 'identifiers.local.json')) }, { force: true });
  const r = exportCli(root, [sha, ID, '--out', path.join(t, 'out')]);
  assert.equal(r.status, 0, r.text);
  const paths = r.json.files.map((f) => f.path);
  assert.ok(!paths.includes('notes/private.md') && !paths.includes('config/identifiers.local.json') && !paths.includes('ops/public-map.json'));
}));

test('export: allowlist 안의 symlink가 커밋에 있으면 중단한다', () => withTemp((t) => {
  const { root } = makeExportRepo(t);
  const target = gitRun(root, ['hash-object', '-w', '--stdin'], 'harness-purpose.md');
  gitRun(root, ['update-index', '--add', '--cacheinfo', `120000,${target},docs/link.md`]);
  gitRun(root, ['commit', '-q', '-m', 'link']);
  const r = exportCli(root, ['HEAD', ID, '--out', path.join(t, 'out')]);
  assert.equal(r.json.error_code, 'COMMIT_SYMLINK');
  assert.ok(!fs.existsSync(path.join(t, 'out')));
}));

test('scanStaging: allowlist 밖 파일·제외 경로·symlink·junction이 하나라도 있으면 실패', () => withTemp((t) => {
  const staging = path.join(t, 'stage');
  writeFiles(staging, { 'docs/a.md': 'ok', 'notes/x.md': 'x', 'ops/public-map.json': '{}', 'PUBLIC_RELEASES.md': '# x\n' });
  fs.mkdirSync(path.join(t, 'outside'));
  fs.symlinkSync(path.join(t, 'outside'), path.join(staging, 'docs', 'link'), 'junction');
  const ctx = { manifest: MANIFEST, ids: FIXTURE_IDS, ps: FIXTURE_PS, rules: builtinRules(data, MAP_SHAS), env: envRuleOf(data) };
  const r = scanStaging(staging, ctx);
  fs.unlinkSync(path.join(staging, 'docs', 'link'));
  const checks = r.findings.map((f) => `${f.check}:${f.path}`);
  assert.ok(checks.includes('NOT_ALLOWLISTED:notes/x.md'));
  assert.ok(checks.includes('FORBIDDEN_PATH:ops/public-map.json'));
  assert.ok(checks.includes('LINK:docs/link'));
  assert.ok(!checks.some((c) => c.endsWith(':docs/a.md') || c.endsWith(':PUBLIC_RELEASES.md')));
  const clean = path.join(t, 'clean');
  writeFiles(clean, { 'docs/a.md': 'ok', 'PUBLIC_RELEASES.md': '# x\n' });
  assert.deepEqual(scanStaging(clean, ctx).findings, []);
}));

test('scanStaging: 사용자 이름이 example이어도 개인 절대경로로 탐지하고, 예시 설정 파일은 중립 값으로 통과한다', () => withTemp((t) => {
  const sep = String.fromCharCode(92);
  const staging = path.join(t, 'stage');
  writeFiles(staging, {
    'docs/win.md': ['C:', 'Users', 'example', 'private'].join(sep),
    'docs/win-fwd.md': ['C:', 'Users', 'Example', 'private'].join('/'),
    'docs/mac.md': ['', 'Users', 'example', 'private'].join('/'),
    'docs/linux.md': ['', 'home', 'example', 'private'].join('/'),
    'config/public-scan.example.json': fs.readFileSync(path.join(REPO, 'config', 'public-scan.example.json')),
  });
  const ctx = { manifest: MANIFEST, ids: FIXTURE_IDS, ps: FIXTURE_PS, rules: builtinRules(data, MAP_SHAS), env: envRuleOf(data) };
  const found = scanStaging(staging, ctx).findings.map((f) => `${f.id}:${f.path}`);
  for (const expected of ['PUB-ABS-PATH-WIN:docs/win.md', 'PUB-ABS-PATH-WIN:docs/win-fwd.md', 'PUB-ABS-PATH-MAC:docs/mac.md', 'PUB-ABS-PATH-LINUX:docs/linux.md']) {
    assert.ok(found.includes(expected), expected);
  }
  assert.ok(!found.some((f) => f.endsWith(':config/public-scan.example.json')), found.join(','));
  assert.ok(!('placeholder_users' in POLICY));
  const src = ['scripts/release/scan-public.mjs', 'scripts/release/export-public.mjs', 'scripts/lib/public-scan.mjs'].map((f) => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
  assert.ok(!/example/i.test(src.replace(/example\.invalid/g, '')), '검사 코드에 특정 사용자 이름 예외 없음');
  assert.ok(!Object.values(POLICY.absolute_path_patterns).some((p) => /example/i.test(p)));
}));

// ---------- 외부 참고 자료 출처 표기 예외 (한 파일·해시 고정 한 줄) ----------

// fixture 차단 값(PS-FIXTURE-OTHER)을 출처 표기 속 고유명 대신 쓴다.
const CREDIT = 'Source: fixture-codename public material — https://example.invalid/';
const ATTR = [{ id: 'ATTR-TEST', path: 'docs/credit.md', line_sha256: lineSha256(CREDIT) }];
const attrCtx = () => ({ manifest: MANIFEST, ids: FIXTURE_IDS, ps: FIXTURE_PS, rules: builtinRules(data, MAP_SHAS), env: envRuleOf(data), attributions: ATTR });
const attrFindings = (t, name, files) => {
  const staging = path.join(t, name);
  writeFiles(staging, files);
  return scanStaging(staging, attrCtx()).findings.map((f) => `${f.check}:${f.id || ''}:${f.path}`);
};

test('출처 표기 예외: 정해진 파일의 해시가 같은 한 줄만 차단 목록 검사에서 빠지고, 다른 위치·수정된 줄·중복 줄은 막는다', () => withTemp((t) => {
  assert.deepEqual(attrFindings(t, 'ok', { 'docs/credit.md': `# credit\n\n${CREDIT}\n- 다른 줄\n` }), []);
  assert.deepEqual(attrFindings(t, 'crlf', { 'docs/credit.md': `# credit\r\n${CREDIT}\r\n` }), [], 'CRLF 줄도 같은 줄로 본다');
  assert.deepEqual(attrFindings(t, 'other-line', { 'docs/credit.md': `${CREDIT}\nsee fixture-codename again\n` }), ['CONTENT:PS-FIXTURE-OTHER:docs/credit.md']);
  assert.deepEqual(attrFindings(t, 'other-file', { 'docs/credit.md': `${CREDIT}\n`, 'docs/other.md': `${CREDIT}\n` }), ['CONTENT:PS-FIXTURE-OTHER:docs/other.md']);
  assert.deepEqual(attrFindings(t, 'case', { 'docs/Credit.md': `${CREDIT}\n` }), ['CONTENT:PS-FIXTURE-OTHER:docs/Credit.md'], '경로 대소문자가 다르면 예외 아님');
  assert.deepEqual(attrFindings(t, 'edited', { 'docs/credit.md': `${CREDIT} \n` }), ['CONTENT:PS-FIXTURE-OTHER:docs/credit.md'], '한 글자라도 바뀌면 예외 아님');
  assert.deepEqual(attrFindings(t, 'dup', { 'docs/credit.md': `${CREDIT}\n${CREDIT}\n` }), ['ATTRIBUTION_DUPLICATE:ATTR-TEST:docs/credit.md']);
}));

test('출처 표기 예외: 그 줄에도 비공개 식별자·개인 절대경로·비밀 검사는 그대로 적용된다', () => withTemp((t) => {
  const line = `Source: fixture-codename via fixture-foreign-brand at ${['', 'home', 'someone'].join('/')}`;
  const staging = path.join(t, 'stage');
  writeFiles(staging, { 'docs/credit.md': `${line}\n` });
  const ctx = { ...attrCtx(), attributions: [{ id: 'ATTR-TEST', path: 'docs/credit.md', line_sha256: lineSha256(line) }] };
  const ids = scanStaging(staging, ctx).findings.map((f) => f.id);
  assert.ok(ids.includes('ID-FIXTURE-1'), '비공개 식별자');
  assert.ok(ids.includes('PUB-ABS-PATH-LINUX'), '개인 절대경로');
  assert.ok(!ids.includes('PS-FIXTURE-OTHER'), '차단 목록만 예외');
  const token = fakeToken();
  const secretLine = `Source: fixture-codename ${token}`;
  writeFiles(staging, { 'docs/credit.md': `${secretLine}\n` });
  const secret = scanStaging(staging, { ...attrCtx(), attributions: [{ id: 'ATTR-TEST', path: 'docs/credit.md', line_sha256: lineSha256(secretLine) }] }).findings;
  assert.ok(secret.some((f) => f.check === 'CONTENT' && !String(f.id).startsWith('PS-')), '비밀 패턴');
}));

test('출처 표기 예외 정책: 정해진 형식만 허용하고, 현재 정책은 대상 파일의 정확히 한 줄과 일치한다', () => {
  const ok = { id: 'ATTR-A', path: 'docs/a.md', line_sha256: 'a'.repeat(64), applies_to: 'scan_config' };
  const withPolicy = (list) => ({ policies: { public_export: { attribution_exemptions: list } } });
  assert.deepEqual(attributionExemptionsOf({ policies: { public_export: {} } }), []);
  assert.equal(attributionExemptionsOf(withPolicy([ok])).length, 1);
  for (const bad of [
    'x', [{ ...ok, extra: 1 }], [{ ...ok, line_sha256: 'A'.repeat(64) }], [{ ...ok, line_sha256: 'a'.repeat(63) }],
    [{ ...ok, path: '../a.md' }], [{ ...ok, path: 'docs/' }], [{ ...ok, path: 'docs/*.md' }], [{ ...ok, applies_to: 'all' }],
    [{ ...ok, id: 'X-1' }], [ok, ok],
  ]) assert.throws(() => attributionExemptionsOf(withPolicy(bad)), (e) => e.code === 'ATTRIBUTION_POLICY_INVALID', JSON.stringify(bad));
  const current = attributionExemptionsOf(data);
  assert.equal(current.length, 1);
  for (const a of current) {
    const lines = fs.readFileSync(path.join(REPO, ...a.path.split('/')), 'utf8').split('\n');
    assert.equal(lines.filter((l) => lineSha256(l) === a.line_sha256).length, 1, `${a.id}: 대상 파일에 정확히 한 줄`);
  }
});

test('export·scan CLI: 출처 표기 예외 정책 형식이 틀리면 아무것도 만들지 않고 중단한다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const checksFile = path.join(root, 'standards', 'checks.json');
  const checks = JSON.parse(fs.readFileSync(checksFile, 'utf8'));
  checks.policies.public_export.attribution_exemptions = [{ id: 'ATTR-A', path: 'docs/a.md', line_sha256: 'bad', applies_to: 'scan_config' }];
  fs.writeFileSync(checksFile, JSON.stringify(checks));
  const out = path.join(t, 'out');
  assert.equal(exportCli(root, [sha, ID, '--out', out]).json.error_code, 'ATTRIBUTION_POLICY_INVALID');
  assert.ok(!fs.existsSync(out));
  const staging = path.join(t, 'stage');
  writeFiles(staging, { 'docs/a.md': 'ok', 'PUBLIC_RELEASES.md': '# x\n' });
  const r = runNode(path.join(root, 'scripts', 'release', 'scan-public.mjs'), [staging], { cwd: root });
  assert.equal(JSON.parse(r.stdout).error_code, 'ATTRIBUTION_POLICY_INVALID');
}));

// ---------- partial·덮어쓰기 ----------

test('export: 기존 export나 partial이 있으면 덮어쓰지 않고 중단한다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const out = path.join(t, 'out');
  assert.equal(exportCli(root, [sha, ID, '--out', out]).status, 0);
  const before = exportDigest(path.join(out, ID));
  const again = exportCli(root, [sha, ID, '--out', out]);
  assert.equal(again.json.error_code, 'EXPORT_EXISTS');
  assert.deepEqual(exportDigest(path.join(out, ID)), before);
  const id2 = 'pub-20261001-02';
  writeFiles(out, { [`${id2}.partial/keep.txt`]: 'previous' });
  assert.equal(exportCli(root, [sha, id2, '--out', out]).json.error_code, 'PARTIAL_EXISTS');
  assert.equal(fs.readFileSync(path.join(out, `${id2}.partial`, 'keep.txt'), 'utf8'), 'previous');
  assert.ok(!fs.existsSync(path.join(out, id2)));
}));

test('export: 비공개 탐지 설정이 없거나 잘못되면 아무것도 만들지 않고 중단하며 값을 출력하지 않는다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const out = path.join(t, 'out');
  const psLocal = path.join(root, 'config', 'public-scan.local.json');
  const idLocal = path.join(root, 'config', 'identifiers.local.json');
  fs.renameSync(psLocal, `${psLocal}.bak`);
  assert.equal(exportCli(root, [sha, ID, '--out', out]).json.error_code, 'PUBLIC_SCAN_CONFIG_MISSING');
  fs.renameSync(`${psLocal}.bak`, psLocal);
  fs.renameSync(idLocal, `${idLocal}.bak`);
  assert.equal(exportCli(root, [sha, ID, '--out', out]).json.error_code, 'IDENTIFIERS_CONFIG_MISSING');
  fs.renameSync(`${idLocal}.bak`, idLocal);
  const dup = { ...PUBLIC_SCAN_FIXTURE, forbidden: [...PUBLIC_SCAN_FIXTURE.forbidden, PUBLIC_SCAN_FIXTURE.forbidden[0]] };
  fs.writeFileSync(psLocal, JSON.stringify(dup));
  const r = exportCli(root, [sha, ID, '--out', out]);
  assert.equal(r.json.error_code, 'PUBLIC_SCAN_CONFIG_INVALID');
  assert.ok(noLeak(r.text));
  assert.ok(!fs.existsSync(out));
}));

test('public-scan 설정: 빈 목록·스키마 위반·id 중복·공백 값·컴파일 불가·빈 문자열 일치 regex 거부', () => {
  assert.ok(FIXTURE_PS.ok);
  const base = PUBLIC_SCAN_FIXTURE.forbidden[0];
  const cfg = (forbidden) => ({ schema_version: '1.0.0', forbidden });
  const cases = [
    [cfg([]), SCAN_CONFIG_INVALID, 'EMPTY_LIST'],
    [{ ...cfg([base]), extra: 1 }, SCAN_CONFIG_INVALID, 'SCHEMA'],
    [cfg([base, base]), SCAN_CONFIG_INVALID, 'DUPLICATE_ID'],
    [cfg([{ ...base, value: '   ' }]), SCAN_CONFIG_INVALID, 'BLANK_VALUE'],
    [cfg([{ ...base, match: 'regex', value: '(' }]), SCAN_PATTERN_INVALID, 'REGEX_COMPILE'],
    [cfg([{ ...base, match: 'regex', value: 'x*' }]), SCAN_PATTERN_INVALID, 'REGEX_MATCHES_EMPTY'],
  ];
  for (const [c, code, reason] of cases) {
    const r = compilePublicScan(c, PUBLIC_SCAN_SCHEMA);
    assert.equal(r.ok, false);
    assert.equal(r.failure_code, code, reason);
    assert.equal(r.reason, reason);
    assert.ok(!JSON.stringify(r).includes(base.value));
  }
});

test('export: 잘못된 인자·기록된 ID·저장소 안 출력 경로는 아무것도 만들지 않고 거부한다', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const out = path.join(t, 'out');
  for (const [args, code] of [
    [[sha, 'pub-2026101-01', '--out', out], 'EXPORT_ID_INVALID'],
    [[sha, 'pub-20261340-01', '--out', out], 'EXPORT_ID_INVALID'],
    [[sha, 'pub-20261001-00', '--out', out], 'EXPORT_ID_INVALID'],
    [['--output=x', ID, '--out', out], 'COMMIT_INVALID'],
    [['0123456789abcdef0123456789abcdef01234567', ID, '--out', out], 'COMMIT_NOT_FOUND'],
    [[sha, SUBMISSION_ID, '--out', out], 'EXPORT_ID_ALREADY_RECORDED'],
    [[sha, ID, '--out', path.join(root, 'docs', 'x')], 'OUT_INVALID'],
    [[sha], 'ARGS_INVALID'],
  ]) {
    assert.equal(exportCli(root, args).json.error_code, code, JSON.stringify(args.slice(0, 2)));
  }
  assert.ok(!fs.existsSync(out) && !fs.existsSync(path.join(root, 'docs', 'x')));
  assert.ok(validExportId('pub-20240229-01', POLICY.export_id_pattern) && !validExportId('pub-20230229-01', POLICY.export_id_pattern));
}));

test('scan-public CLI: 확정된 export는 통과, 파일을 더하면 실패, 설정이 없으면 중단', () => withTemp((t) => {
  const { root, sha } = makeExportRepo(t);
  const out = path.join(t, 'out');
  assert.equal(exportCli(root, [sha, ID, '--out', out]).status, 0);
  const scan = (dir) => runNode(path.join(root, 'scripts', 'release', 'scan-public.mjs'), [dir], { cwd: root });
  const ok = scan(path.join(out, ID));
  assert.equal(ok.status, 0, ok.stdout);
  writeFiles(path.join(out, ID), { 'notes/extra.md': 'x' });
  const bad = scan(path.join(out, ID));
  assert.equal(bad.status, 1);
  assert.ok(JSON.parse(bad.stdout).findings.some((f) => f.check === 'NOT_ALLOWLISTED'));
  fs.rmSync(path.join(root, 'config', 'public-scan.local.json'));
  const missing = scan(path.join(out, ID));
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).error_code, 'PUBLIC_SCAN_CONFIG_MISSING');
}));

// ---------- 안전 경계 ----------

test('release 스크립트에는 push·원격 변경·네트워크 요청 기능이 없고 git은 git-read의 읽기 전용 하위 명령만 쓴다', () => {
  const files = ['scripts/release/export-public.mjs', 'scripts/release/scan-public.mjs', 'scripts/lib/public-scan.mjs', 'scripts/lib/git-read.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    // commit·config 하위 명령은 아래 allowlist 실행 검사로 막는다 (cat-file의 객체 종류 'commit'과 구분).
    assert.ok(!/['"`](?:push|pull|fetch|clone|remote|ls-remote|send-pack)['"`]/.test(src), f);
    assert.ok(!/\bfetch\s*\(|node:(?:https?|http2|net|tls|dgram|dns)\b|XMLHttpRequest|WebSocket|\bremote\b/i.test(src), f);
  }
  for (const f of ['scripts/release/export-public.mjs', 'scripts/release/scan-public.mjs', 'scripts/lib/public-scan.mjs']) {
    assert.ok(!/child_process/.test(fs.readFileSync(path.join(REPO, f), 'utf8')), f);
  }
  const gitSrc = fs.readFileSync(path.join(REPO, 'scripts/lib/git-read.mjs'), 'utf8');
  assert.equal(gitSrc.match(/execFileSync\(/g).length, 1);
  assert.deepEqual([...GIT_READ_ONLY].sort(), ['cat-file', 'ls-tree', 'rev-list', 'rev-parse']);
  for (const sub of ['push', 'remote', 'fetch', 'commit', 'config', 'pull', 'clone']) assert.throws(() => git(REPO, [sub]), /GIT_COMMAND_NOT_ALLOWED/);
});

test('private 이력: git 저장소가 아니면 PRIVATE_HISTORY_UNAVAILABLE로 fail-closed', () => withTemp((t) => {
  assert.throws(() => privateHistoryShas(t), /PRIVATE_HISTORY_UNAVAILABLE/);
}));

test('commit SHA 규칙: 7~40자리 독립 hex 토큰이 SHA prefix일 때만 일치하고 6자리·영숫자 인접·64자리 해시는 통과', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const rule = commitShaRule([sha, MAP_SHAS[0]]);
  const hit = (s) => countRule(rule, s);
  for (const s of [sha, sha.slice(0, 7), sha.slice(0, 12), sha.toUpperCase(), `(${sha.slice(0, 7)})`, `x/${sha.slice(0, 9)}.md`, `\`${sha.slice(0, 7)}\``]) assert.equal(hit(s), 1, s);
  for (const s of [sha.slice(0, 6), `x${sha.slice(0, 7)}`, `${sha.slice(0, 7)}g`, `a${sha}`, `${'f'.repeat(24)}${sha}`, 'abcdef0', '0123457', '20261001', 'pub-20261001-02', '']) {
    assert.equal(hit(s), 0, s);
  }
  assert.equal(hit(`${sha.slice(0, 7)} and ${sha}`), 2);
  assert.equal(commitShaRule(['not-a-sha']).empty, true);
});

test('export: private 이력의 commit SHA가 내용이나 경로에 있으면 막고, 출력에 SHA를 내지 않는다', () => withTemp((t) => {
  const { root, sha: base } = makeExportRepo(t);
  const cases = [
    ['docs/history-full.md', `see ${base}`, 'CONTENT'],
    ['docs/history-short.md', `base ${base.slice(0, 7)} commit`, 'CONTENT'],
    ['docs/history-12.md', `base \`${base.slice(0, 12).toUpperCase()}\``, 'CONTENT'],
    [`docs/${base.slice(0, 8)}-notes.md`, 'clean', 'PATH_NAME'],
  ];
  for (const [i, [rel, content, check]] of cases.entries()) {
    const sha = commitFiles(root, { [rel]: content });
    const exportId = `pub-20261001-${String(i + 40)}`;
    const r = exportCli(root, [sha, exportId, '--out', path.join(t, 'out')]);
    assert.equal(r.json.error_code, 'PUBLIC_SCAN_FAILED', rel);
    assert.ok(r.json.findings.some((f) => f.check === check && f.id === 'PUB-COMMIT-SHA'), `${rel}: ${JSON.stringify(r.json.findings)}`);
    assert.ok(!r.text.toLowerCase().includes(base.slice(0, 7)) && !r.text.toLowerCase().includes(sha.slice(0, 7)), `${rel}: 출력에 SHA 없음`);
    gitRun(root, ['rm', '-q', '--', rel]);
    gitRun(root, ['commit', '-q', '-m', 'revert']);
  }
  const clean = commitFiles(root, { 'docs/hex-ok.md': `hash ${'c'.repeat(64)} id 20261001 short ${base.slice(0, 6)} x${base.slice(0, 7)}` });
  assert.equal(exportCli(root, [clean, 'pub-20261001-50', '--out', path.join(t, 'out')]).status, 0);
}));

test('현재 저장소의 public 후보 파일은 내장 규칙(비밀·개인키·개인 경로·대응표 SHA·.env)에 걸리지 않는다', () => {
  const rels = publicCandidateFiles(REPO);
  assert.ok(rels.length > 50);
  for (const p of ['README.md', 'standards/checks.json', 'scripts/release/export-public.mjs']) assert.ok(rels.includes(p), p);
  // 실제 commit SHA 대조는 export 시점에 private 이력으로 한다. 여기서는 fixture SHA(가짜 값)를 규칙에 넣지 않는다.
  const rules = builtinRules(data, []);
  const env = envRuleOf(data);
  const hits = [];
  for (const rel of rels) {
    const buf = fs.readFileSync(path.join(REPO, ...rel.split('/')));
    const text = buf.includes(0) ? buf.toString('latin1') : buf.toString('utf8');
    for (const r of rules) {
      const re = r.regex();
      if (re.test(text) || r.regex().test(rel)) hits.push(`${r.id}:${rel}`);
    }
    const base = rel.split('/').pop();
    if (env.fail.test(base) && !env.allowed.has(base)) hits.push(`ENV:${rel}`);
  }
  assert.deepEqual(hits, []);
});
