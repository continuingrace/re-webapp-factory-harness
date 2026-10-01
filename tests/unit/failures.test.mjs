// R8-e 실패 사례 F1~F10. tests/mutations.json의 정의를 OS 임시 폴더 복사본에 적용하고,
// tests/expected.json의 기대 결과와 "정확히" 같은지 확인한다. 원본 sample-app과 실제 runs/·releases/는 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_IDS, REPO, makeHarnessCopy, makeRun, mkTemp, publicCandidateFiles, rm, withTemp } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { computeFingerprint } from '../../scripts/lib/fingerprint.mjs';
import { judgeStatic } from '../../scripts/stages/stage2-static.mjs';
import { evaluateStage3 } from '../../scripts/stages/stage3-evaluate.mjs';
import { evaluateStage5 } from '../../scripts/stages/stage5-release.mjs';
import { Deny, decide } from '../../scripts/hook-guard.mjs';

const { data } = loadChecks(REPO);
const SAMPLE = path.join(REPO, 'fixtures', 'sample-app');
const MUTATIONS = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'mutations.json'), 'utf8')).cases;
const EXPECTED = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'expected.json'), 'utf8')).cases;
const FLAGS = { sticky_preview: 'yes', effect_font: 'no', local_state: 'yes', pwa_installable: 'yes' };
const ORIGINAL_FP = computeFingerprint(SAMPLE, data.policies.fingerprint).value;
const caseOf = (id) => MUTATIONS.find((c) => c.id === id);

const buildToken = (m) => m.token_fragments.join('') + m.token_fill.char.repeat(m.token_fill.count);

function applyAppMutations(app, mutations) {
  for (const m of mutations) {
    const file = path.join(app, ...m.path.split('/'));
    if (m.op === 'append') fs.appendFileSync(file, m.text);
    else if (m.op === 'replace') {
      const before = fs.readFileSync(file, 'utf8');
      assert.ok(before.includes(m.from), `${m.path}에 ${m.from} 없음`);
      fs.writeFileSync(file, before.split(m.from).join(m.to));
    } else if (m.op === 'delete') fs.rmSync(file);
    else if (m.op === 'write_token') fs.writeFileSync(file, m.template.replace('{TOKEN}', buildToken(m)));
    else throw new Error(`알 수 없는 op: ${m.op}`);
  }
}

function appCopy(tmp, c) {
  const app = path.join(tmp, 'sample-app');
  fs.cpSync(SAMPLE, app, { recursive: true });
  applyAppMutations(app, c.mutations);
  return app;
}

const input = (app) => ({ app_path: app, target_version: '1.0.1', change_summary: '실패 사례 검증', release_phase: 'predeploy', flags: FLAGS, overrides: [] });
const failures = (items) => items.filter((i) => i.status === 'FAIL' || i.status === 'NEEDS_ATTENTION').map((i) => [i.check_id, i.failure_code]).sort();
const expectedOf = (id) => [...EXPECTED[id].expected_failures].sort();

function checkPipeline(t, id, items) {
  const actual = failures(items);
  t.diagnostic(`${id} actual=${JSON.stringify(actual)}`);
  assert.deepEqual(actual, expectedOf(id));
  assert.equal(EXPECTED[id].end_to_end, false);
}

for (const id of ['F1', 'F3', 'F4', 'F6']) {
  test(`${id}: ${caseOf(id).verification_type} stage 2`, (t) => withTemp((tmp) => {
    const app = appCopy(tmp, caseOf(id));
    checkPipeline(t, id, judgeStatic({ root: REPO, checksData: data, input: input(app), identifiers: FIXTURE_IDS }).items);
  }));
}

test('F5: pipeline stage 2·3 (설치된 Chrome)', async (t) => withTemp(async (tmp) => {
  const app = appCopy(tmp, caseOf('F5'));
  const s2 = judgeStatic({ root: REPO, checksData: data, input: input(app), identifiers: FIXTURE_IDS });
  assert.deepEqual(failures(s2.items), []);
  const { measureStage3 } = await import('../../scripts/stages/stage3-browser.mjs');
  const m = await measureStage3({ checksData: data, input: input(app) });
  assert.deepEqual(m.network.external_origins, []);
  const s3 = evaluateStage3(data, input(app), m.raws, { fingerprint: s2.fingerprint, browser: m.browser });
  checkPipeline(t, 'F5', s3.items);
}));

test('F7: 비밀 문자열은 SECRET_DETECTED이고 stdout·stderr·결과 파일·evidence에 완성 토큰 0건', (t) => {
  const tmp = mkTemp();
  try {
    const c = caseOf('F7');
    const token = buildToken(c.mutations[0]);
    const app = appCopy(tmp, c);
    const direct = judgeStatic({ root: REPO, checksData: data, input: input(app), identifiers: FIXTURE_IDS });
    checkPipeline(t, 'F7', direct.items);
    const root = makeHarnessCopy(tmp);
    const runDir = makeRun(root, 'sample-app', input(app));
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-stage.mjs'), '2', runDir], { encoding: 'utf8', windowsHide: true });
    const written = fs.readFileSync(path.join(runDir, '02-static.a1.json'), 'utf8');
    const occurrences = [r.stdout, r.stderr, written, JSON.stringify(direct)].reduce((n, s) => n + s.split(token).length - 1, 0);
    assert.equal(occurrences, EXPECTED.F7.complete_token_occurrences);
    // 공개 후보 파일 전체(allowlist 대상 일반 파일과 있으면 PUBLIC_RELEASES.md)를 Git 없이 직접 검사한다.
    const candidates = publicCandidateFiles(REPO);
    assert.ok(candidates.length > 50 && candidates.includes('README.md') && candidates.includes('tests/unit/failures.test.mjs'));
    const tokenFiles = candidates.filter((rel) => {
      const buf = fs.readFileSync(path.join(REPO, ...rel.split('/')));
      return /ghp_[A-Za-z0-9]{36}/.test(buf.includes(0) ? buf.toString('latin1') : buf.toString('utf8'));
    });
    assert.deepEqual(tokenFiles, [], '공개 후보 파일에 완성 토큰 형식 0건');
  } finally {
    rm(tmp);
  }
});

// ---------- 합성 실행 폴더 (judge_unit, end_to_end: false) ----------

const binding = { run_id: 'r1', app_slug: 'sample-app', target_version: '1.0.0', fingerprint: 'fp1', operating_url: 'https://sample.example/', standards_version: data.standards_version };
const approval = (type, fp = 'fp1') => ({ approval_type: type, decision: 'APPROVE', statement: '원문', approved_at: 't', run_id: 'r1', fingerprint: fp, target_version: '1.0.0', operating_url: 'https://sample.example/' });

function synthetic(root, c) {
  let runner = [{ check_id: 'ST-01', status: 'PASS', evidence: { ok: true }, fingerprint: 'fp1' }];
  let approvalsFp = 'fp1';
  let auths = [];
  for (const m of c.mutations) {
    if (m.op === 'runner_item') runner = [...runner, { ...m.item, fingerprint: 'fp1' }];
    else if (m.op === 'approvals_fingerprint') approvalsFp = m.value;
    else if (m.op === 'release_file') {
      const f = path.join(root, 'releases', 'sample-app', 'v1.0.0.md');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `# r\n\n\`\`\`json release-record\n${JSON.stringify(binding)}\n\`\`\`\n`);
    } else if (m.op === 'pre_record_binding') auths = [{ release_record_allowed: true, binding: { ...binding, operating_url: m.operating_url } }];
    else throw new Error(`알 수 없는 op: ${m.op}`);
  }
  const approvals = ['MOBILE_DEVICE_REVIEW', 'HOME_ICON_REVIEW', 'FINAL_RELEASE'].map((t) => approval(t, approvalsFp));
  const run = { run_id: 'r1', app_slug: 'sample-app', status: 'AWAITING_APPROVAL', pre_record_authorizations: auths, conflicts: [] };
  return evaluateStage5({ root, checksData: data, input: { target_version: '1.0.0', flags: FLAGS }, run, approvals, binding, fingerprint: 'fp1', stages_ready: true },
    [{ check_id: 'PD-01', status: 'PASS', evidence: { ok: true }, fingerprint: 'fp1' }], runner);
}

for (const id of ['F2', 'F8', 'F9']) {
  test(`${id}: judge_unit stage 5 (합성 실행 폴더, end_to_end: false)`, (t) => withTemp((tmp) => {
    const c = caseOf(id);
    assert.equal(c.verification_type, 'judge_unit');
    checkPipeline(t, id, synthetic(tmp, c).items);
  }));
}

test('F10: hook_unit 모의 입력 2건이 모두 차단된다 (실제 쓰기·push 0건)', (t) => {
  const denials = caseOf('F10').mutations.map((m) => {
    const hookInput = { hook_event_name: 'PreToolUse', tool_name: m.tool_name, tool_input: m.tool_input, cwd: REPO, ...(m.agent_type ? { agent_id: 'mock', agent_type: m.agent_type } : {}) };
    try {
      decide(hookInput, { projectDir: REPO });
      return null;
    } catch (e) {
      if (e instanceof Deny) return e.message;
      throw e;
    }
  });
  t.diagnostic(`F10 denials=${JSON.stringify(denials)}`);
  assert.equal(denials.filter(Boolean).length, EXPECTED.F10.expected_hook_denials);
});

test('모든 사례가 끝난 뒤 원본 sample-app fingerprint가 같다', () => {
  assert.equal(computeFingerprint(SAMPLE, data.policies.fingerprint).value, ORIGINAL_FP);
});
