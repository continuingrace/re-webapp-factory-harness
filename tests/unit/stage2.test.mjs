import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GOOD_CSS, REPO, fakeToken, goodApp, goodInput, makeApp, makeHarnessCopy, withTemp } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { judgeStatic } from '../../scripts/stages/stage2-static.mjs';

const { data } = loadChecks(REPO);
const judge = (app, extra = {}, root = REPO, checksData = data) => judgeStatic({ root, checksData, input: goodInput(app, extra) });
const item = (r, id) => r.items.find((i) => i.check_id === id);
const withApp = (mutate, fn) => withTemp((t) => {
  const files = goodApp();
  mutate(files);
  return fn(makeApp(t, files), t);
});

test('정상 앱은 stage 2의 모든 check가 PASS 또는 NOT_APPLICABLE', () => withApp(() => {}, (app) => {
  const r = judge(app);
  const bad = r.items.filter((i) => !['PASS', 'NOT_APPLICABLE'].includes(i.status));
  assert.deepEqual(bad.map((i) => [i.check_id, i.status, i.failure_code]), []);
  assert.equal(r.items.length, data.checks.filter((c) => c.stage === 2).length);
  assert.equal(r.run_status, 'IN_PROGRESS');
}));

test('ST-01: CHANGELOG 누락은 FAIL, 진입점 없음은 NEEDS_ATTENTION', () => {
  withApp((f) => delete f['CHANGELOG.md'], (app) => {
    assert.equal(item(judge(app), 'ST-01').failure_code, 'REQUIRED_DOC_MISSING');
  });
  withApp((f) => delete f['index.html'], (app) => {
    const i = item(judge(app), 'ST-01');
    assert.equal(i.status, 'NEEDS_ATTENTION');
    assert.equal(i.failure_code, 'UNSUPPORTED_APP_STRUCTURE');
  });
});

test('ST-01: src/main.tsx 진입점을 감지해 evidence에 기록한다', () => withApp((f) => {
  delete f['index.html'];
  f['src/main.tsx'] = 'export {};\n';
}, (app) => {
  const i = item(judge(app), 'ST-01');
  assert.equal(i.status, 'PASS');
  assert.deepEqual(i.evidence.detected_entries, ['src/main.tsx']);
}));

test('ST-02: 아이콘 누락, 크기 불일치, PWA 미적용', () => {
  withApp((f) => delete f['icons/icon-192.png'], (app) => assert.equal(item(judge(app), 'ST-02').failure_code, 'ICON_MISSING'));
  withApp((f) => { f['icons/icon-512.png'] = f['icons/icon-192.png']; }, (app) => assert.equal(item(judge(app), 'ST-02').failure_code, 'ICON_SIZE_MISMATCH'));
  withApp(() => {}, (app) => {
    const flags = { sticky_preview: 'no', effect_font: 'no', local_state: 'no', pwa_installable: 'no' };
    assert.equal(item(judge(app, { flags }), 'ST-02').status, 'NOT_APPLICABLE');
  });
});

test('ST-03: 비밀 문자열은 FAIL이고 결과에 문자열이 남지 않는다', () => {
  const token = fakeToken();
  withApp((f) => { f['src/config.js'] = `export const key = "${token}";\n`; }, (app) => {
    const r = judge(app);
    const i = item(r, 'ST-03');
    assert.equal(i.failure_code, 'SECRET_DETECTED');
    assert.deepEqual(i.evidence.hits, [{ path: 'src/config.js', rule_id: 'SEC-GH-CLASSIC', count: 1 }]);
    assert.equal(JSON.stringify(r).includes(token), false);
  });
});

test('ST-03: 실제 .env는 실패, 깨끗한 .env.example은 허용', () => {
  withApp((f) => { f['.env'] = 'A=1\n'; }, (app) => assert.equal(item(judge(app), 'ST-03').failure_code, 'ENV_FILE_PRESENT'));
  withApp((f) => { f['.env.example'] = 'A=\n'; }, (app) => assert.equal(item(judge(app), 'ST-03').status, 'PASS'));
});

test('ST-04: WORK_PROJECT·IHIRI 식별자는 내용과 경로 모두 FAIL', () => {
  withApp((f) => { f['README.md'] += '\nIHIRI 자료\n'; }, (app) => {
    const i = item(judge(app), 'ST-04');
    assert.equal(i.failure_code, 'FOREIGN_PROJECT_MIXED');
    assert.deepEqual(i.evidence.hits, [{ path: 'README.md', id: 'ID-IHIRI', target: 'content', count: 1 }]);
  });
  withApp((f) => { f['work_project/a.txt'] = 'x'; }, (app) => {
    assert.ok(item(judge(app), 'ST-04').evidence.hits.some((h) => h.target === 'path' && h.id === 'ID-WORK-PROJECT'));
  });
});

test('ST-04: 제외 폴더(node_modules) 안의 식별자는 검사하지 않는다', () => withApp((f) => {
  f['node_modules/pkg/readme.md'] = 'ihiri';
}, (app) => assert.equal(item(judge(app), 'ST-04').status, 'PASS')));

test('ST-05: README 버전만 다르면 VERSION_MISMATCH', () => withApp((f) => {
  f['README.md'] = '# Test App\n\nVersion 1.0.1\n';
}, (app) => assert.equal(item(judge(app), 'ST-05').failure_code, 'VERSION_MISMATCH')));

test('ST-06: 가상 하네스의 문서가 바뀌면 STANDARDS_DRIFT, 실제 문서는 그대로', () => withTemp((t) => {
  const before = fs.readFileSync(path.join(REPO, 'standards', 'default-gates.md'));
  const root = makeHarnessCopy(t);
  const app = makeApp(t);
  fs.appendFileSync(path.join(root, 'standards', 'default-gates.md'), '\n변경\n');
  const copyData = loadChecks(root).data;
  const i = item(judge(app, {}, root, copyData), 'ST-06');
  assert.equal(i.failure_code, 'STANDARDS_DRIFT');
  assert.deepEqual(fs.readFileSync(path.join(REPO, 'standards', 'default-gates.md')), before);
}));

test('DS-01~06: 기본값 위반은 각각 FAIL', () => {
  const cases = [
    ['DS-01', 'body { letter-spacing: -0.02em; }'],
    ['DS-02', '.x { border-radius: 18px; }'],
    ['DS-03', '.x { padding: 18px; }'],
    ['DS-04', 'h1 { line-height: 1.05; }'],
    ['DS-05', '.x { font-family: Arial, sans-serif; }'],
    ['DS-06', '.x { box-shadow: 0 2px 4px #000; }'],
  ];
  for (const [id, css] of cases) {
    withApp((f) => { f['src/style.css'] = `${GOOD_CSS}${css}\n`; }, (app) => {
      assert.equal(item(judge(app), id).status, 'FAIL', id);
    });
  }
});

test('DS: 승인된 override는 적용하고, 원문이 없는 override는 거부한다', () => withApp((f) => {
  f['src/style.css'] = `${GOOD_CSS}.x { border-radius: 18px; }\n`;
}, (app) => {
  const ov = { check_id: 'DS-02', value: { allowed: ['0', '16px', '18px', '24px', '9999px'] }, reason: '앱 전용 radius', approval_statement: 'DS-02 18px 승인', source_reference: 'app/design.md#radius' };
  const ok = item(judge(app, { overrides: [ov] }), 'DS-02');
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.evidence.basis, 'override');
  const rejected = item(judge(app, { overrides: [{ ...ov, approval_statement: '' }] }), 'DS-02');
  assert.equal(rejected.status, 'FAIL');
  assert.equal(rejected.evidence.override_rejected, true);
}));

test('DS: 인라인 style 속성이 있으면 추정하지 않고 NEEDS_ATTENTION', () => withApp((f) => {
  f['index.html'] = f['index.html'].replace('<main class="card">', '<main class="card" style="padding:18px">');
}, (app) => {
  const i = item(judge(app), 'DS-03');
  assert.equal(i.status, 'NEEDS_ATTENTION');
  assert.equal(i.failure_code, data.policies.inconclusive.failure_code);
}));
