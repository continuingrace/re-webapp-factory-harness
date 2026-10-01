// 테스트 공용 도구. 모든 임시 파일은 OS 임시 폴더(rewf-test-*)에 만들고 테스트 끝에 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileIdentifiers } from '../../scripts/lib/identifiers.mjs';
import { isGenerated, manifestExcludes, manifestIncludes, validateManifest } from '../../scripts/release/scan-public.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TMP_PREFIX = 'rewf-test-';

// tripwire: 테스트 프로세스는 실제 저장소의 local 설정(config/*.local.json)을 읽을 수 없다.
// 모든 테스트 파일이 이 모듈을 import하므로 모든 테스트 프로세스에 적용된다. 걸리면 즉시 오류를 던진다.
export const TRIPWIRE_CODE = 'LOCAL_CONFIG_READ_BLOCKED';
export const tripwireHits = [];
const REPO_CONFIG = path.join(REPO, 'config').toLowerCase();
export function isRepoLocalConfig(p) {
  let s;
  if (typeof p === 'string') s = p;
  else if (p instanceof URL) s = fileURLToPath(p);
  else if (Buffer.isBuffer(p)) s = p.toString();
  else return false;
  const abs = path.resolve(s);
  return path.dirname(abs).toLowerCase() === REPO_CONFIG && /\.local\.json$/i.test(path.basename(abs).replace(/[. ]+$/, ''));
}
for (const name of ['readFileSync', 'openSync', 'lstatSync', 'statSync', 'createReadStream', 'copyFileSync', 'readFile', 'open']) {
  const original = fs[name];
  fs[name] = function guarded(p, ...rest) {
    if (isRepoLocalConfig(p)) {
      tripwireHits.push(name);
      throw Object.assign(new Error(TRIPWIRE_CODE), { code: TRIPWIRE_CODE });
    }
    return original.call(this, p, ...rest);
  };
}

// 자동 테스트는 이 fixture 식별자만 쓴다 (실제 식별자 아님).
export const FIXTURE_IDENTIFIERS_FILE = path.join(REPO, 'tests', 'fixtures', 'identifiers.fixture.json');
export const IDENTIFIERS_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'identifiers.schema.json'), 'utf8'));
export const FIXTURE_IDS = compileIdentifiers(JSON.parse(fs.readFileSync(FIXTURE_IDENTIFIERS_FILE, 'utf8')), IDENTIFIERS_SCHEMA);
if (!FIXTURE_IDS.ok) throw new Error('fixture 식별자 설정이 유효하지 않음');

export function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
}

export function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export async function withTemp(fn) {
  const dir = mkTemp();
  try {
    return await fn(dir);
  } finally {
    rm(dir);
  }
}

export function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export const GOOD_CSS = `:root { font-family: "Pretendard Variable", Pretendard, sans-serif; }
body { margin: 0; line-height: 1.5; letter-spacing: 0; }
h1 { line-height: 1.3; margin: 0 0 16px; }
p { line-height: 1.5; }
.card { padding: 24px; border-radius: 16px; box-shadow: none; }
`;

export function goodApp(version = '1.0.0') {
  return {
    'index.html': `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<link rel="icon" href="icons/favicon.svg">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<link rel="stylesheet" href="src/style.css">
<title>Test App</title>
</head>
<body><main class="card"><h1>Test App</h1><p>v${version}</p></main><script src="src/app.js"></script></body>
</html>
`,
    'src/style.css': GOOD_CSS,
    'src/app.js': "document.querySelector('h1');\n",
    'manifest.webmanifest': JSON.stringify({
      name: 'Test App',
      short_name: 'Test',
      start_url: './',
      display: 'standalone',
      theme_color: '#FFFFFF',
      background_color: '#FFFFFF',
      icons: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }),
    'icons/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n',
    'icons/apple-touch-icon.png': png(180, 180),
    'icons/icon-192.png': png(192, 192),
    'icons/icon-512.png': png(512, 512),
    'icons/icon-maskable-512.png': png(512, 512),
    'README.md': `# Test App\n\nVersion ${version}\n`,
    'CHANGELOG.md': `# Changelog\n\n## ${version}\n\n- 첫 버전\n`,
    'package.json': `${JSON.stringify({ name: 'test-app', version })}\n`,
  };
}

export function makeApp(parent, files = goodApp(), name = 'test-app') {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  writeFiles(dir, files);
  return dir;
}

export function goodInput(appPath, extra = {}) {
  return {
    app_path: appPath,
    target_version: '1.0.0',
    change_summary: '첫 검수',
    release_phase: 'predeploy',
    flags: { sticky_preview: 'no', effect_font: 'no', local_state: 'no', pwa_installable: 'yes' },
    overrides: [],
    ...extra,
  };
}

// 실제 저장소를 건드리지 않도록 scripts·standards·docs·config를 임시 하네스 루트로 복사한다.
// config/*.local.json은 복사하지 않고, identifiers가 'fixture'면 fixture를 복사본의 local 설정 자리에 쓴다.
export function makeHarnessCopy(parent, { identifiers = 'fixture' } = {}) {
  const root = path.join(parent, 'harness');
  for (const d of ['scripts', 'standards', 'docs']) fs.cpSync(path.join(REPO, d), path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  for (const name of fs.readdirSync(path.join(REPO, 'config'))) {
    if (/\.local\.json$/i.test(name)) continue;
    fs.copyFileSync(path.join(REPO, 'config', name), path.join(root, 'config', name));
  }
  if (identifiers === 'fixture') fs.copyFileSync(FIXTURE_IDENTIFIERS_FILE, localIdentifiersPath(root));
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  return root;
}

// 임시 하네스 복사본 안의 local 설정 경로 (실제 저장소 경로에는 쓰지 않는다).
export function localIdentifiersPath(root) {
  if (path.resolve(root).toLowerCase() === REPO.toLowerCase()) throw new Error('실제 저장소의 local 설정은 테스트에서 다루지 않는다');
  return path.join(root, 'config', 'identifiers.local.json');
}

export function makeRun(root, slug, input, runId = '20260929-120000-KST-abc123') {
  const dir = path.join(root, 'runs', slug, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input));
  return dir;
}

export function snapshot(dir) {
  const out = {};
  const rec = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) out[r] = 'link';
      else if (st.isDirectory()) rec(a, r);
      else out[r] = `${st.mtimeMs}:${createHash('sha256').update(fs.readFileSync(a)).digest('hex')}`;
    }
  };
  rec(dir, '');
  return out;
}

export function runNode(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
}

// public export 후보 파일: root의 파일 시스템을 순회해 production manifest 판정(scan-public의 manifestIncludes·
// manifestExcludes·isGenerated)으로 고른다. Git·private 파일 없이도 같은 기준으로 동작한다.
// 제외 경로는 lstat 전에 건너뛰므로(local 설정 tripwire 보호) 열지 않는다. 제외되지 않은 symlink·junction·특수 파일은
// 따라가지 않고 실패하며, 읽기·권한 오류도 그대로 던진다(조용히 건너뛰지 않음).
export function publicCandidateFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'release', 'public-manifest.json'), 'utf8'));
  if (!validateManifest(manifest)) throw new Error('MANIFEST_INVALID');
  const out = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (manifestExcludes(manifest, r) || manifestExcludes(manifest, `${r}/`)) continue;
      const a = path.join(abs, name);
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) throw Object.assign(new Error('PUBLIC_CANDIDATE_LINK'), { code: 'PUBLIC_CANDIDATE_LINK' });
      if (st.isDirectory()) walk(a, r);
      else if (!st.isFile()) throw Object.assign(new Error('PUBLIC_CANDIDATE_SPECIAL'), { code: 'PUBLIC_CANDIDATE_SPECIAL' });
      else if (manifestIncludes(manifest, r) || isGenerated(manifest, r)) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

// GitHub 비밀 탐지에 걸리지 않도록 가짜 토큰은 실행 중 메모리에서만 조각을 결합한다.
export function fakeToken() {
  return ['g', 'h', 'p', '_'].join('') + 'Z'.repeat(36);
}
