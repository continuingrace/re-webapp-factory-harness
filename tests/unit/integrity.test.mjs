// 저장소 자체의 불변 조건: 허용되지 않은 네트워크 코드 없음, judge·오케스트레이터·release-recorder는
// 브라우저·네트워크 모듈을 불러오지 않음, 실제 기준 문서 해시 일치.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { normalizedFileHash } from '../../scripts/lib/hash.mjs';

const SCRIPTS = path.join(REPO, 'scripts');
const LOCAL_SERVER = path.join(SCRIPTS, 'lib', 'local-server.mjs');
const NETGUARD = path.join(SCRIPTS, 'lib', 'netguard.mjs');
const NET_IMPORT = /from\s+['"](node:)?(https?|net|tls|dgram|http2|dns)['"]/;
const CLIENT_CALL = /\bfetch\s*\(|\bWebSocket\b|\bhttps?\.(request|get)\s*\(|\bnet\.connect\s*\(/;

function scriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? scriptFiles(p) : (/\.mjs$/.test(e.name) ? [p] : []);
  });
}

test('네트워크 모듈은 local-server.mjs(listen)와 netguard.mjs(stage 4 요청)에서만 쓴다', () => {
  const hits = scriptFiles(SCRIPTS).filter((f) => {
    if (f === NETGUARD) return false;
    const src = fs.readFileSync(f, 'utf8');
    if (CLIENT_CALL.test(src)) return true;
    return f !== LOCAL_SERVER && NET_IMPORT.test(src);
  });
  assert.deepEqual(hits.map((f) => path.relative(REPO, f)), []);
});

test('local-server.mjs는 node:http만 쓰고 127.0.0.1에만 listen한다', () => {
  const src = fs.readFileSync(LOCAL_SERVER, 'utf8');
  const imports = [...src.matchAll(/from\s+['"](node:[a-z]+)['"]/g)].map((m) => m[1]);
  assert.ok(imports.includes('node:http'));
  assert.ok(!imports.some((m) => ['node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns'].includes(m)));
  assert.match(src, /const HOST = '127\.0\.0\.1';/);
  assert.ok(!src.includes('0.0.0.0'));
  assert.match(src, /\.listen\(0, HOST,/);
});

test('netguard.mjs는 HTTPS 요청만 하고 검증된 주소로 고정 연결한다', () => {
  const src = fs.readFileSync(NETGUARD, 'utf8');
  assert.ok(!/from\s+['"]node:http['"]/.test(src));
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.match(src, /lookup: \(_h, opts, cb\)/);
});

function importGraph(entry) {
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) {
      if (s.startsWith('.')) visit(path.resolve(path.dirname(file), s));
      else external.add(s);
    }
  };
  visit(entry);
  return { files: [...seen].map((f) => path.relative(REPO, f).replace(/\\/g, '/')), external: [...external] };
}

const BANNED_EXTERNAL = ['playwright', '@axe-core/playwright', 'node:http', 'node:https', 'node:net', 'node:dns', 'node:tls'];
const BANNED_FILES = /local-server|stage3-browser|stage4-production|netguard/;

for (const entry of ['judge.mjs', 'write-release.mjs', 'orchestrator/start-run.mjs', 'orchestrator/record-approval.mjs', 'orchestrator/set-deployment.mjs', 'orchestrator/record-judgement.mjs']) {
  test(`${entry}는 브라우저·네트워크 모듈을 불러오지 않는다`, () => {
    const g = importGraph(path.join(SCRIPTS, ...entry.split('/')));
    assert.deepEqual(g.external.filter((m) => BANNED_EXTERNAL.includes(m)), []);
    assert.deepEqual(g.files.filter((f) => BANNED_FILES.test(f)), []);
  });
}

test('테스트는 실제 외부 요청 경로를 쓰지 않는다 (stage 4는 모의 resolver·transport만)', () => {
  const dir = path.join(REPO, 'tests', 'unit');
  const self = path.basename(fileURLToPath(import.meta.url));
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== self)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/run-stage\.mjs['"]\)?\s*,\s*['"]4['"]/.test(src) && !/\[\s*['"]4['"]\s*,/.test(src), `${f}: run-stage 4 호출 금지`);
    for (const m of src.matchAll(/measureStage4\(\{([^}]*)\}\)/g)) {
      assert.ok(/resolver/.test(m[1]) && /transport/.test(m[1]), `${f}: measureStage4는 모의 resolver·transport 필수`);
    }
    for (const m of src.matchAll(/guardedFetch\(([^;]*)\);/g)) {
      assert.ok(/resolver: m\.resolver/.test(m[1]) && /transport: m\.transport/.test(m[1]), `${f}: guardedFetch는 모의 객체와 함께만`);
    }
  }
});

test('실제 저장소의 source_documents 정규화 해시가 모두 일치한다', () => {
  const { data } = loadChecks(REPO);
  const policy = data.policies.source_document_hashing;
  const drift = data.source_documents.filter((d) => normalizedFileHash(path.join(REPO, d.path), policy) !== d.sha256);
  assert.deepEqual(drift.map((d) => d.path), []);
});
