// 테스트 공용 도구. 모든 임시 파일은 OS 임시 폴더(rewf-test-*)에 만들고 테스트 끝에 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TMP_PREFIX = 'rewf-test-';

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
.card { padding: 24px; border-radius: 24px; box-shadow: none; }
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

// 실제 저장소를 건드리지 않도록 scripts·standards·docs를 임시 하네스 루트로 복사한다.
export function makeHarnessCopy(parent) {
  const root = path.join(parent, 'harness');
  for (const d of ['scripts', 'standards', 'docs']) fs.cpSync(path.join(REPO, d), path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  return root;
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

// GitHub 비밀 탐지에 걸리지 않도록 가짜 토큰은 실행 중 메모리에서만 조각을 결합한다.
export function fakeToken() {
  return ['g', 'h', 'p', '_'].join('') + 'Z'.repeat(36);
}
