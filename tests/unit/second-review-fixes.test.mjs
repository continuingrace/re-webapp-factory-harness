// 2차 리뷰(docs/harness-review.md 2절) 보완 항목 회귀 테스트. 실제 외부 요청, 실제 runs/·releases/ 변경 없이 임시 폴더에서만 실행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { REPO, fakeToken, makeApp, withTemp, writeFiles } from './helpers.mjs';
import { getCheck, loadChecks } from '../../scripts/lib/checks.mjs';
import { computeFingerprint } from '../../scripts/lib/fingerprint.mjs';
import { startStaticServer } from '../../scripts/lib/local-server.mjs';
import { redactText } from '../../scripts/lib/redact.mjs';
import { evaluateStage3 } from '../../scripts/stages/stage3-evaluate.mjs';
import { evaluateStage4 } from '../../scripts/stages/stage4-evaluate.mjs';

const { data } = loadChecks(REPO);
const FP = data.policies.fingerprint;
const item = (r, id) => r.items.find((i) => i.check_id === id);
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
});

// ---------- S3 ----------

test('S3: 로컬 서버는 fingerprint 제외 경로를 제공하지 않고, 요청 경로를 기록한다', () => withTemp(async (t) => {
  const app = makeApp(t);
  writeFiles(app, { 'dist/app.css': 'x', 'tmp/data.json': '{}', 'node_modules/p/i.js': '', 'debug.log': 'x', 'src/ok.css': 'x' });
  const srv = await startStaticServer(app, FP);
  try {
    for (const p of ['/dist/app.css', '/tmp/data.json', '/node_modules/p/i.js', '/debug.log', '/dist']) assert.equal(await get(srv.port, p), 403, p);
    assert.equal(await get(srv.port, '/src/ok.css'), 200);
    assert.deepEqual(srv.excludedRequests(), ['/dist/app.css', '/tmp/data.json', '/node_modules/p/i.js', '/debug.log', '/dist']);
  } finally {
    await srv.close();
  }
  // 제공하지 않는 파일은 fingerprint에도 없다 (같은 범위).
  const before = computeFingerprint(app, FP).value;
  fs.appendFileSync(path.join(app, 'dist', 'app.css'), 'y');
  assert.equal(computeFingerprint(app, FP).value, before);
}));

test('S3: app_path 자체가 dist·build 폴더여도 그 안의 파일은 검사·제공한다', () => withTemp(async (t) => {
  const app = makeApp(t, undefined, 'dist');
  const fp = computeFingerprint(app, FP);
  assert.ok(fp.walk.files.includes('index.html'));
  const srv = await startStaticServer(app, FP);
  try {
    assert.equal(await get(srv.port, '/'), 200);
    assert.equal(await get(srv.port, '/src/style.css'), 200);
  } finally {
    await srv.close();
  }
}));

test('S3: 정책 없이 로컬 서버를 시작할 수 없다 (fail closed)', async () => {
  await assert.rejects(() => startStaticServer(REPO), { code: 'FINGERPRINT_POLICY_REQUIRED' });
});

test('S3 추가: Windows에서 대소문자를 바꾼 제외 경로도 같은 정책으로 차단하고, fingerprint 범위와 일치한다', () => withTemp(async (t) => {
  const { resolveRequestPath } = await import('../../scripts/lib/local-server.mjs');
  const app = makeApp(t);
  writeFiles(app, { 'dist/app.css': 'x', 'debug.log': 'x' });
  for (const p of ['/dist/app.css', '/DIST/app.css', '/Dist/app.css', '/debug.log', '/debug.LOG', '/Node_Modules/x.js']) {
    assert.equal(resolveRequestPath(app, p, FP, 'win32').code, 403, `win32 ${p}`);
  }
  assert.equal(resolveRequestPath(app, '/index.html', FP, 'win32').code, 200);
  if (process.platform === 'win32') {
    const srv = await startStaticServer(app, FP);
    try {
      for (const p of ['/DIST/app.css', '/Dist/app.css', '/debug.LOG']) assert.equal(await get(srv.port, p), 403, p);
    } finally {
      await srv.close();
    }
    // 디스크에 대문자 이름으로 있어도 fingerprint에서 빠지고 서버도 제공하지 않는다.
    const app2 = makeApp(t, { 'index.html': 'x', 'BUILD/a.js': 'x', 'Trace.LOG': 'x' }, 'case-app');
    assert.deepEqual(computeFingerprint(app2, FP).walk.files, ['index.html']);
  }
}));

// ---------- S5 ----------

const redactPolicy = {
  patterns: getCheck(data, 'ST-03').rule.patterns,
  maxChars: data.policies.evidence_text.max_chars,
  privateKeyBlock: data.policies.evidence_text.private_key_block,
};

// 실제 개인키가 아닌 sentinel 본문. 머리글·본문은 실행 중에 조각을 결합해 만든다.
const SENTINEL = ['SENTI', 'NELKEY'].join('') + 'Q'.repeat(60) + ['BO', 'DY'].join('');
const pem = (kind) => [`-----BEGIN ${kind}PRI`, 'VATE KEY-----\n', SENTINEL, '\n', SENTINEL, `\n-----END ${kind}PRI`, 'VATE KEY-----'].join('');

test('추가 보안: 개인키 블록은 머리글부터 END까지 본문 전체를 하나로 가리고, 자르기 전에 적용한다', () => {
  for (const kind of ['RSA ', 'EC ', 'OPENSSH ', '']) {
    const out = redactText(`before ${pem(kind)} after`, redactPolicy);
    assert.equal(out, 'before [REDACTED:SEC-PRIVATE-KEY] after', kind);
    assert.ok(!out.includes('SENTINEL'), kind);
  }
  const unterminated = redactText(`x ${pem('RSA ').split('\n-----END')[0]}`, redactPolicy);
  assert.equal(unterminated, 'x [REDACTED:SEC-PRIVATE-KEY]');
  const long = redactText(`${'a'.repeat(190)} ${pem('')}`, redactPolicy);
  assert.ok(!long.includes('SENTI'));
  assert.ok(long.length <= redactPolicy.maxChars + 1);
  // 기존 ST-03 머리글 탐지 규칙은 그대로다.
  assert.equal(getCheck(data, 'ST-03').rule.patterns['SEC-PRIVATE-KEY'], '-----BEGIN [A-Z ]*PRIVATE KEY-----');
});

test('추가 보안: 실제 브라우저 콘솔의 개인키 본문·토큰이 run-stage 3의 stdout·stderr·결과 파일에 남지 않는다', () => withTemp(async (t) => {
  const { makeHarnessCopy, makeRun, runNode, goodApp, goodInput } = await import('./helpers.mjs');
  const root = makeHarnessCopy(t);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  try {
    const files = goodApp();
    // 정적 검사(ST-03)에 걸리지 않도록 앱 코드에서 실행 중 조각을 결합해 콘솔에 출력한다.
    files['src/app.js'] = [
      "const head = ['-----BEGIN RSA PRI', 'VATE KEY-----'].join('');",
      "const tail = ['-----END RSA PRI', 'VATE KEY-----'].join('');",
      `const body = ${JSON.stringify(SENTINEL)};`,
      "const tok = ['gh', 'p_'].join('') + 'Z'.repeat(36);",
      'console.error(`${head}\\n${body}\\n${tail} ${tok}`);',
      '',
    ].join('\n');
    const app = makeApp(t, files);
    const runDir = makeRun(root, 'test-app', goodInput(app, { flags: { sticky_preview: 'no', effect_font: 'no', local_state: 'no', pwa_installable: 'yes' } }));
    const script = path.join(root, 'scripts', 'run-stage.mjs');
    const r2 = runNode(script, ['2', runDir]);
    assert.equal(JSON.parse(r2.stdout).run_status, 'IN_PROGRESS', r2.stdout);
    const r3 = runNode(script, ['3', runDir], { timeout: 240000 });
    const written = fs.readFileSync(path.join(runDir, '03-browser.a1.json'), 'utf8');
    const token = fakeToken();
    for (const s of [r3.stdout, r3.stderr, written]) {
      assert.ok(!s.includes(SENTINEL), 'sentinel 본문 0건');
      assert.ok(!s.includes(token), '완성 토큰 0건');
    }
    const fa01 = JSON.parse(written).items.find((i) => i.check_id === 'FA-01');
    assert.equal(fa01.evidence.raw.console_errors, 1);
    assert.match(fa01.evidence.raw.messages[0], /\[REDACTED:SEC-PRIVATE-KEY\]/);
  } finally {
    const link = path.join(root, 'node_modules');
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  }
}));

test('S5: evidence 문자열에서 토큰·사용자정보·query 값을 지우고 길이를 제한한다', () => {
  const token = fakeToken();
  const out = redactText(`fail ${token} at https://user:PASSWORDX@api.example/p?key=SECRETQ#FRAG and more`, redactPolicy);
  assert.ok(!out.includes(token));
  assert.ok(!/PASSWORDX|SECRETQ|FRAG|user:/.test(out));
  assert.match(out, /\[REDACTED:SEC-GH-CLASSIC\]/);
  assert.match(out, /https:\/\/api\.example\/p\?key=\*\*\*/);
  assert.equal(redactText('x'.repeat(500), redactPolicy).length, redactPolicy.maxChars + 1);
});

test('S5: 실제 브라우저 콘솔 오류 원문의 비밀값이 FA-01 evidence에 남지 않는다', () => withTemp(async (t) => {
  const token = fakeToken();
  const files = {
    'index.html': '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>t</title></head><body><main><h1>t</h1></main><script src="app.js"></script></body></html>\n',
    'app.js': `console.error(${JSON.stringify(`${token} https://u:PASSWORDX@api.example/?k=SECRETQ`)});\n`,
  };
  const app = makeApp(t, files, 'console-app');
  const { measureStage3 } = await import('../../scripts/stages/stage3-browser.mjs');
  const input = { app_path: app, flags: { sticky_preview: 'no', effect_font: 'no', local_state: 'no', pwa_installable: 'no' } };
  const m = await measureStage3({ checksData: data, input });
  const raw = m.raws['FA-01'];
  assert.equal(raw.console_errors, 1);
  const text = JSON.stringify(m);
  assert.ok(!text.includes(token));
  assert.ok(!/PASSWORDX|SECRETQ/.test(text));
  assert.match(raw.messages[0], /REDACTED:SEC-GH-CLASSIC/);
}));

// ---------- S6 ----------

test('S6: 적용 대상인데 측정 대상이 0개면 PASS가 아니라 NEEDS_ATTENTION, applies_when false만 NOT_APPLICABLE', () => {
  const flags = { sticky_preview: 'no', effect_font: 'no', local_state: 'no', pwa_installable: 'no' };
  const raws = {
    'MB-03': { viewport: [390, 844], targets: [] },
    'FA-03': { focusables_total: 0, reached: [], unreached: [] },
  };
  const r3 = evaluateStage3(data, { flags }, raws, { fingerprint: 'fp', browser: null });
  for (const id of ['MB-03', 'FA-03']) {
    assert.equal(item(r3, id).status, data.policies.zero_targets.status, id);
    assert.equal(item(r3, id).failure_code, data.policies.zero_targets.failure_code, id);
  }
  assert.equal(item(r3, 'MB-06').status, 'NOT_APPLICABLE');
  const input4 = { target_version: '1.0.0', release_phase: 'postdeploy', operating_url: 'https://s.example/', flags };
  const r4 = evaluateStage4(data, input4, { 'PD-01': { final_status: 200, redirect_count: 0 }, 'PD-02': { assets: [], asset_count: 0, truncated: false, kinds_found: [] }, 'PD-03': { versions_found: ['1.0.0'] } }, { status: 'APPROVE' }, { fingerprint: 'fp' });
  assert.equal(item(r4, 'PD-02').status, 'NEEDS_ATTENTION');
  assert.equal(item(r4, 'PD-02').evidence.reason, 'NO_MEASURED_TARGET');
  assert.deepEqual(data.policies.zero_targets.applies_to, ['MB-03', 'FA-03', 'PD-02']);
});

// ---------- S7 ----------

test('S7: 경로·내용·파일 경계가 모호한 트리도 서로 다른 fingerprint를 만든다', () => withTemp((t) => {
  const fp = (files, name) => computeFingerprint(makeApp(t, files, name), FP).value;
  assert.notEqual(fp({ ab: 'c' }, 'x1'), fp({ a: 'bc' }, 'x2'));
  assert.notEqual(fp({ a: '' }, 'x3'), fp({ a: '', b: '' }, 'x4'));
  assert.notEqual(fp({ 'a/b': 'c' }, 'x5'), fp({ 'a/bc': '' }, 'x6'));
  assert.equal(fp({ ab: 'c' }, 'x7'), fp({ ab: 'c' }, 'x8'));
  assert.equal(typeof FP.encoding, 'string');
}));
