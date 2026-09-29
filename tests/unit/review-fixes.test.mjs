// 1차 리뷰(docs/harness-review.md) 보완 항목 회귀 테스트. 실제 외부 요청, 실제 runs/·releases/ 변경 없이 임시 폴더에서만 실행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GOOD_CSS, REPO, fakeToken, goodApp, goodInput, makeApp, makeHarnessCopy, makeRun, runNode, withTemp, writeFiles } from './helpers.mjs';
import { getCheck, loadChecks } from '../../scripts/lib/checks.mjs';
import { computeFingerprint } from '../../scripts/lib/fingerprint.mjs';
import { requestOptions } from '../../scripts/lib/netguard.mjs';
import { judgeIntake } from '../../scripts/stages/stage1-intake.mjs';
import { judgeStatic } from '../../scripts/stages/stage2-static.mjs';
import { measureStage4 } from '../../scripts/stages/stage4-production.mjs';
import { evaluateStage4 } from '../../scripts/stages/stage4-evaluate.mjs';
import { evaluateStage5 } from '../../scripts/stages/stage5-release.mjs';

const { data } = loadChecks(REPO);
const judge2 = (app, extra = {}) => judgeStatic({ root: REPO, checksData: data, input: goodInput(app, extra) });
const item = (r, id) => r.items.find((i) => i.check_id === id);
const withApp = (mutate, fn) => withTemp((t) => {
  const files = goodApp();
  mutate(files);
  return fn(makeApp(t, files), t);
});

// ---------- R2 ----------

test('R2: 버전이 JS 진입점에만 있어도 ST-05가 불일치를 잡는다', () => withApp((f) => {
  delete f['index.html'];
  f['src/main.js'] = "document.body.textContent = 'v0.9.0';\n";
}, (app) => {
  const i = item(judge2(app), 'ST-05');
  assert.equal(i.failure_code, 'VERSION_MISMATCH');
  assert.deepEqual(i.evidence.locations.ui.sources, ['src/main.js']);
}));

test('R2: index.html이 참조하는 로컬 JS와 그 import까지 검사한다', () => withApp((f) => {
  f['src/app.js'] = "import { label } from './version.js';\ndocument.title = label;\n";
  f['src/version.js'] = "export const label = 'v2.0.0';\n";
}, (app) => {
  const i = item(judge2(app), 'ST-05');
  assert.equal(i.failure_code, 'VERSION_MISMATCH');
  assert.deepEqual(i.evidence.locations.ui.sources, ['index.html', 'src/app.js', 'src/version.js']);
}));

test('R2: 참조 범위를 확정할 수 없으면 PASS가 아니라 NEEDS_ATTENTION, 패키지 import는 검색하지 않는다', () => {
  withApp((f) => { f['src/app.js'] = "import './missing.js';\n"; }, (app) => {
    const i = item(judge2(app), 'ST-05');
    assert.equal(i.status, 'NEEDS_ATTENTION');
    assert.equal(i.evidence.reason, 'UI_SOURCE_SCOPE_UNRESOLVED');
  });
  withApp((f) => { f['src/app.js'] = 'const m = await import(name);\n'; }, (app) => {
    assert.equal(item(judge2(app), 'ST-05').status, 'NEEDS_ATTENTION');
  });
  withApp((f) => { f['src/app.js'] = "import x from 'some-package';\nimport y from 'https://cdn.example/x.js';\n"; }, (app) => {
    const i = item(judge2(app), 'ST-05');
    assert.equal(i.status, 'PASS');
    assert.equal(i.evidence.locations.ui.external_refs_skipped, 2);
  });
});

// ---------- R3 ----------

test('R3: 깨끗한 git 저장소에서도 gitignore된 검사 대상 파일이 바뀌면 fingerprint가 바뀐다', () => withTemp((t) => {
  const app = makeApp(t);
  writeFiles(app, { '.gitignore': 'extra.css\n', 'extra.css': '.a { margin: 0; }\n' });
  const git = (...args) => spawnSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  assert.equal(git('status', '--porcelain').stdout.trim(), '');
  const before = computeFingerprint(app, data.policies.fingerprint);
  assert.equal(before.type, 'content_sha256');
  assert.ok(before.walk.files.includes('extra.css'));
  fs.appendFileSync(path.join(app, 'extra.css'), '.b { padding: 18px; }\n');
  assert.equal(git('status', '--porcelain').stdout.trim(), '');
  assert.notEqual(computeFingerprint(app, data.policies.fingerprint).value, before.value);
}));

// ---------- R4 ----------

test('R4: 요청 옵션은 검증된 주소로 고정하고 TLS 이름 확인을 끄지 않는다', () => {
  const url = new URL('https://sample.example:8443/a/b?x=1');
  const o = requestOptions(url, { address: '93.184.216.34', family: 4, timeoutMs: getCheck(data, 'PD-01').rule.request_timeout_ms });
  assert.equal(o.servername, 'sample.example');
  assert.equal(o.port, '8443');
  assert.equal(o.path, '/a/b?x=1');
  assert.equal('rejectUnauthorized' in o, false);
  let single;
  o.lookup('evil.example', {}, (err, address, family) => { single = [err, address, family]; });
  assert.deepEqual(single, [null, '93.184.216.34', 4]);
  let all;
  o.lookup('evil.example', { all: true }, (err, list) => { all = [err, list]; });
  assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]]);
});

// ---------- R6 ----------

test('R6: 바이너리 파일도 건너뛰지 않고 비밀·혼입 검사를 한다 (기준값은 checks.json)', () => {
  const token = fakeToken();
  withApp((f) => { f['assets/blob.bin'] = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`xx ${token} xx ihiri`, 'latin1')]); }, (app) => {
    const r = judge2(app);
    assert.equal(item(r, 'ST-03').failure_code, 'SECRET_DETECTED');
    assert.equal(item(r, 'ST-04').failure_code, 'FOREIGN_PROJECT_MIXED');
    assert.equal(item(r, 'ST-03').evidence.binary_scanned_as_latin1 >= 1, true);
    assert.equal(JSON.stringify(r).includes(token), false);
  });
  assert.equal(data.policies.content_scan.skip_allowed, false);
  assert.equal(typeof data.policies.content_scan.binary_detection.sample_bytes, 'number');
});

// ---------- R7·R11 (judge) ----------

function judgeRun(t, mutateApp) {
  const root = makeHarnessCopy(t);
  const app = makeApp(t);
  const runDir = makeRun(root, 'test-app', goodInput(app));
  runNode(path.join(root, 'scripts', 'run-stage.mjs'), ['2', runDir]);
  if (mutateApp) mutateApp(app);
  return { root, app, runDir, judge: () => JSON.parse(runNode(path.join(root, 'scripts', 'judge.mjs'), [runDir]).stdout) };
}

test('R7: runner가 측정 중 fingerprint 변경을 기록했으면 judge도 BLOCKED', () => withTemp((t) => {
  const s = judgeRun(t);
  const s2 = JSON.parse(fs.readFileSync(path.join(s.runDir, '02-static.a1.json'), 'utf8'));
  fs.writeFileSync(path.join(s.runDir, '03-browser.a1.json'), JSON.stringify({
    stage: 3, run_status: 'AWAITING_DEPLOYMENT', fingerprint: s2.fingerprint, standards_version: data.standards_version,
    fingerprint_changed_during_run: true, items: [], complete: true,
  }));
  const out = s.judge();
  assert.equal(out.stage3.reason, 'FINGERPRINT_CHANGED_DURING_RUN');
  assert.equal(out.verdict.run_status, 'BLOCKED');
}));

test('R11: 앱이 바뀐 뒤의 오래된 runner 결과는 충돌이 아니라 오래된 근거로 분류한다', () => withTemp((t) => {
  const s = judgeRun(t, (app) => fs.appendFileSync(path.join(app, 'README.md'), '\n추가\n'));
  const out = s.judge();
  assert.equal(out.runner_comparison.stale, true);
  assert.equal(out.runner_comparison.reason, 'EVIDENCE_STALE');
  assert.deepEqual(out.runner_comparison.mismatches, []);
  assert.equal(out.verdict.run_status, 'BLOCKED');
}));

// ---------- R8 (stage 4) ----------

test('R8: query·fragment·사용자정보가 있는 운영 URL은 요청 0건으로 거부되고 값이 evidence에 남지 않는다', async () => {
  let calls = 0;
  const resolver = async () => { calls += 1; return [{ address: '93.184.216.34', family: 4 }]; };
  const transport = async () => { calls += 1; return { status: 200, location: null, content_type: null, too_large: false, body: Buffer.from('') }; };
  const flags = { sticky_preview: 'no', effect_font: 'no', local_state: 'no', pwa_installable: 'yes' };
  for (const [url, code] of [['https://sample.example/?t=SECRETVALUE', 'URL_QUERY_OR_FRAGMENT_FORBIDDEN'], ['https://sample.example/#SECRETVALUE', 'URL_QUERY_OR_FRAGMENT_FORBIDDEN'],
    ['https://u:SECRETVALUE@sample.example/', 'URL_USERINFO_FORBIDDEN']]) {
    const input = { target_version: '1.0.0', release_phase: 'postdeploy', operating_url: url, deployment_id: 'd1', flags };
    const m = await measureStage4({ checksData: data, input, confirmation: { status: 'APPROVE' }, resolver, transport });
    const r = evaluateStage4(data, input, m.raws, { status: 'APPROVE' }, { fingerprint: 'fp' });
    assert.equal(item(r, 'PD-01').failure_code, code, url);
    assert.equal(m.requests, 0);
    assert.ok(!JSON.stringify(r).includes('SECRETVALUE'), url);
  }
  assert.equal(calls, 0);
});

// ---------- R9 ----------

test('R9: font 단축 속성과 외부 stylesheet는 PASS로 추정하지 않는다', () => {
  withApp((f) => { f['src/style.css'] = `${GOOD_CSS}.x { font: 16px/1.2 Arial; }\n`; }, (app) => {
    const r = judge2(app);
    for (const id of ['DS-04', 'DS-05']) {
      assert.equal(item(r, id).status, 'NEEDS_ATTENTION', id);
      assert.equal(item(r, id).evidence.reason, 'FONT_SHORTHAND', id);
    }
  });
  withApp((f) => { f['src/style.css'] = `${GOOD_CSS}.x { font: inherit; }\n`; }, (app) => {
    assert.equal(item(judge2(app), 'DS-05').status, 'PASS');
  });
  withApp((f) => { f['index.html'] = f['index.html'].replace('</head>', '<link rel="stylesheet" href="https://cdn.example/x.css">\n</head>'); }, (app) => {
    const r = judge2(app);
    for (const id of ['DS-01', 'DS-02', 'DS-03', 'DS-04', 'DS-05', 'DS-06']) assert.equal(item(r, id).status, 'NEEDS_ATTENTION', id);
  });
  withApp((f) => { f['src/style.css'] = `@import url("https://cdn.example/x.css");\n${GOOD_CSS}`; }, (app) => {
    assert.equal(item(judge2(app), 'DS-01').status, 'NEEDS_ATTENTION');
  });
});

// ---------- R10·R11 (stage 5) ----------

const binding = { run_id: 'r1', app_slug: 'sample-app', target_version: '1.0.0', fingerprint: 'fp1', operating_url: 'https://sample.example/', standards_version: data.standards_version };
const rec = (type, decision) => ({ approval_type: type, decision, statement: '원문', approved_at: 't', run_id: 'r1', fingerprint: 'fp1', target_version: '1.0.0', operating_url: 'https://sample.example/' });
function stage5(root, { approvals, conflicts = [], auths = [] }) {
  const run = { run_id: 'r1', app_slug: 'sample-app', status: 'AWAITING_APPROVAL', pre_record_authorizations: auths, conflicts };
  return evaluateStage5({ root, checksData: data, input: { target_version: '1.0.0', flags: { pwa_installable: 'yes' } }, run, approvals, binding, fingerprint: 'fp1', stages_ready: true },
    [{ check_id: 'PD-01', status: 'PASS', evidence: { ok: true }, fingerprint: 'fp1' }], [{ check_id: 'ST-01', status: 'PASS', evidence: { ok: true }, fingerprint: 'fp1' }]);
}
const allApproved = ['MOBILE_DEVICE_REVIEW', 'HOME_ICON_REVIEW', 'FINAL_RELEASE'].map((t) => rec(t, 'APPROVE'));

test('R10: 같은 결합값에서 REJECT 뒤 APPROVE를 추가해도 거절이 유지된다', () => withTemp((t) => {
  const r = stage5(t, { approvals: [rec('MOBILE_DEVICE_REVIEW', 'REJECT'), ...allApproved] });
  assert.equal(item(r, 'HA-01').failure_code, 'APPROVAL_REJECTED');
  assert.equal(item(r, 'HA-01').evidence.sticky, true);
  assert.equal(r.release_record_allowed, false);
}));

test('R11: 현재 fingerprint의 runner·judge 충돌은 RUNNER_JUDGE_CONFLICT, 오래된 fingerprint의 충돌은 세지 않는다', () => withTemp((t) => {
  const file = path.join(t, 'releases', 'sample-app', 'v1.0.0.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# r\n\n\`\`\`json release-record\n${JSON.stringify(binding)}\n\`\`\`\n`);
  const auths = [{ release_record_allowed: true, binding }];
  const current = stage5(t, { approvals: allApproved, auths, conflicts: [{ kind: 'RUNNER_JUDGE', stage: '2', fingerprint: 'fp1', mismatches: [{}] }] });
  assert.equal(item(current, 'JG-02').failure_code, 'RUNNER_JUDGE_CONFLICT');
  const old = stage5(t, { approvals: allApproved, auths, conflicts: [{ kind: 'RUNNER_JUDGE', stage: '2', fingerprint: 'old', mismatches: [{}] }] });
  assert.equal(old.complete_allowed, true);
}));

// ---------- R12 ----------

test('R12: required_tools의 Node 최소 버전을 접수 단계에서 검사한다', () => withTemp((t) => {
  const app = makeApp(t);
  const old = judgeIntake({ root: REPO, checksData: data, input: goodInput(app), nodeVersion: '18.19.0' });
  assert.equal(old.items[0].status, 'NEEDS_ATTENTION');
  assert.equal(old.items[0].failure_code, data.policies.missing_tool.failure_code);
  assert.equal(old.run_status, 'BLOCKED');
  const cur = judgeIntake({ root: REPO, checksData: data, input: goodInput(app) });
  assert.equal(cur.items[0].status, 'PASS');
  assert.equal(cur.items[0].evidence.node.satisfied, true);
}));
