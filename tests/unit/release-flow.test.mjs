// 오케스트레이터 helper·judge·release-recorder 흐름. 가상 하네스 루트에서만 실행하고 실제 runs/, releases/는 건드리지 않는다.
// stage 4 결과는 모의 응답으로 만든 합성값(verification_type: judge_unit, end_to_end: false)이며,
// 합성 결과로는 COMPLETE가 기록되지 않아야 한다.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, makeHarnessCopy, mkTemp, rm } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { urlConfirmation } from '../../scripts/lib/approvals.mjs';
import { writeNoClobber } from '../../scripts/lib/result.mjs';
import { currentBinding, currentDeployment, effectiveInput, readRunState } from '../../scripts/lib/run-state.mjs';
import { measureStage4 } from '../../scripts/stages/stage4-production.mjs';
import { evaluateStage4 } from '../../scripts/stages/stage4-evaluate.mjs';
import { nextStatus, validateJudge } from '../../scripts/orchestrator/record-judgement.mjs';

const SAMPLE = path.join(REPO, 'fixtures', 'sample-app');
const FLAGS = { sticky_preview: 'yes', effect_font: 'no', local_state: 'yes', pwa_installable: 'yes' };
let tmp;
let root;
let baseRun;
let data;

const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, ...opts });
const script = (rel) => path.join(root, 'scripts', ...rel.split('/'));
const json = (r) => JSON.parse(r.stdout);
let stmtN = 0;
function stmt(text) {
  stmtN += 1;
  const f = path.join(tmp, `statement-${stmtN}.txt`);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}
const approve = (dir, type, decision, text) => json(node([script('orchestrator/record-approval.mjs'), dir, type, decision, '--statement-file', stmt(text)]));
const deploy = (dir, url, text = `배포했어 ${url}`) => json(node([script('orchestrator/set-deployment.mjs'), dir, url, '--statement-file', stmt(text)]));
const judge = (dir) => node([script('judge.mjs'), dir]);
// judge 출력을 파일로 넘긴다. record-judgement는 이를 신뢰하지 않고 재계산 결과와 비교한다.
function recordJudgement(dir, judgeJson) {
  if (judgeJson === undefined) return json(node([script('orchestrator/record-judgement.mjs'), dir]));
  const f = stmt(judgeJson);
  return json(node([script('orchestrator/record-judgement.mjs'), dir, '--judge-file', f]));
}
const writeRelease = (dir) => json(node([script('write-release.mjs'), dir]));
const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

// 모의 운영 응답(sample-app 파일)으로 stage 4 결과를 합성해 runner 결과 자리에 쓴다.
async function writeSyntheticStage4(dir, { markSynthetic = true } = {}) {
  const state = readRunState(dir);
  const d = currentDeployment(state.run);
  const input = effectiveInput(state.input, state.run);
  const fp = readJson(dir, '03-browser.a1.json').fingerprint;
  const binding = currentBinding({ run: state.run, input: state.input, fingerprint: fp, checksData: data });
  const confirmation = urlConfirmation(state.approvals, binding, d.deployment_id);
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const transport = async (url) => {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(SAMPLE, ...rel.split('/'));
    return fs.existsSync(file) ? { status: 200, location: null, content_type: null, too_large: false, body: fs.readFileSync(file) }
      : { status: 404, location: null, content_type: null, too_large: false, body: null };
  };
  const m = await measureStage4({ checksData: data, input, confirmation, resolver, transport });
  const r = evaluateStage4(data, input, m.raws, confirmation, { fingerprint: fp });
  const existing = fs.readdirSync(dir).filter((n) => n.startsWith('04-production.a')).length;
  writeNoClobber(dir, `04-production.a${existing + 1}.json`, JSON.stringify({
    ...r, fingerprint: fp, standards_version: data.standards_version, deployment_id: d.deployment_id, url_confirmation_status: confirmation.status,
    ...(markSynthetic ? { verification: { verification_type: 'judge_unit', end_to_end: false } } : {}), attempt: existing + 1, complete: true,
  }));
  return r;
}

function cloneRun(src, newId) {
  const dir = path.join(path.dirname(src), newId);
  fs.mkdirSync(dir);
  for (const f of ['input.json', 'approvals.json', '01-intake.a1.json', '02-static.a1.json', '03-browser.a1.json']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  const run = readJson(src, 'run.json');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...run, run_id: newId }));
  return dir;
}

before(() => {
  tmp = mkTemp();
  root = makeHarnessCopy(tmp);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  data = loadChecks(root).data;
  const inputFile = path.join(tmp, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ app_path: SAMPLE, target_version: '1.0.0', change_summary: '하네스 v1 흐름 검증', release_phase: 'predeploy', flags: FLAGS, overrides: [] }));
  const started = json(node([script('orchestrator/start-run.mjs'), inputFile]));
  assert.equal(started.created, true);
  baseRun = path.join(root, ...started.run_dir.split('/'));
  assert.equal(json(node([script('run-stage.mjs'), '2', baseRun])).run_status, 'IN_PROGRESS');
  assert.equal(json(node([script('run-stage.mjs'), '3', baseRun], { timeout: 240000 })).run_status, 'AWAITING_DEPLOYMENT');
});

after(() => {
  if (!tmp) return;
  const link = path.join(root, 'node_modules');
  if (fs.existsSync(link)) {
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  }
  if (fs.existsSync(link)) throw new Error('node_modules junction을 제거하지 못해 임시 폴더를 남긴다');
  rm(tmp);
});

test('start-run: 접수 실패 입력은 실행 폴더를 만들지 않는다', () => {
  const bad = path.join(tmp, 'bad-input.json');
  fs.writeFileSync(bad, JSON.stringify({ app_path: SAMPLE, target_version: 'v1', release_phase: 'predeploy', flags: FLAGS }));
  const before = fs.readdirSync(path.join(root, 'runs', 'sample-app')).length;
  const r = json(node([script('orchestrator/start-run.mjs'), bad]));
  assert.equal(r.created, false);
  assert.equal(fs.readdirSync(path.join(root, 'runs', 'sample-app')).length, before);
});

test('start-run: run_id 형식과 초기 파일', () => {
  assert.match(path.basename(baseRun), /^\d{8}-\d{6}-KST-[0-9a-f]{6}$/);
  for (const f of ['input.json', 'run.json', 'approvals.json', '01-intake.a1.json']) assert.ok(fs.existsSync(path.join(baseRun, f)), f);
  assert.deepEqual(readJson(baseRun, 'run.json').deployment, []);
});

test('set-deployment: 사용자정보 URL과 stage 3 미완료 실행은 기록하지 않는다', () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-aaaaaa');
  const beforeRun = fs.readFileSync(path.join(dir, 'run.json'), 'utf8');
  assert.equal(deploy(dir, 'https://u:p@sample.example/').error_code, 'URL_USERINFO_FORBIDDEN');
  fs.rmSync(path.join(dir, '03-browser.a1.json'));
  assert.equal(deploy(dir, 'https://sample.example/').error_code, 'STATE_MISMATCH');
  assert.equal(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'), beforeRun);
});

test('record-approval: 원문을 바이트 그대로 보존하고, 빈 원문은 거부한다', () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-bbbbbb');
  deploy(dir, 'https://sample.example/');
  const tricky = '운영 주소 맞아요\n두 번째 줄 "따옴표" \'작은따옴표\' `백틱` $(rm -rf /) && echo 끝 😀\r\n';
  assert.equal(approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', tricky).recorded, true);
  assert.equal(readJson(dir, 'approvals.json')[0].statement, tricky);
  const r = approve(dir, 'MOBILE_DEVICE_REVIEW', 'APPROVE', '   \n  ');
  assert.equal(r.error_code, 'EMPTY_STATEMENT');
  assert.equal(readJson(dir, 'approvals.json').length, 1);
});

test('record-approval: 같은 deployment에서 REJECT한 URL은 APPROVE로 덮어쓸 수 없고, 새 deployment 뒤에는 가능', () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-cccccc');
  deploy(dir, 'https://preview.example/');
  assert.equal(approve(dir, 'OPERATING_URL_CONFIRMATION', 'REJECT', '이건 미리보기 주소예요').recorded, true);
  assert.equal(approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '아니 운영 주소예요').error_code, 'URL_REJECTED_FOR_DEPLOYMENT');
  deploy(dir, 'https://sample.example/');
  assert.equal(approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '운영 주소 맞아요').recorded, true);
});

test('record-approval: HA 순서를 지키고, R10 같은 결합값의 REJECT는 APPROVE로 뒤집을 수 없으며 기록은 보존된다', () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-dddddd');
  deploy(dir, 'https://sample.example/');
  assert.equal(approve(dir, 'HOME_ICON_REVIEW', 'APPROVE', '아이콘 승인').error_code, 'PRIOR_APPROVAL_MISSING');
  approve(dir, 'MOBILE_DEVICE_REVIEW', 'REJECT', '모바일에서 상단 고정이 깨져요');
  const snapshot = fs.readFileSync(path.join(dir, 'approvals.json'), 'utf8');
  assert.equal(approve(dir, 'HOME_ICON_REVIEW', 'APPROVE', '아이콘 승인').error_code, 'PRIOR_APPROVAL_REJECTED');
  assert.equal(approve(dir, 'MOBILE_DEVICE_REVIEW', 'APPROVE', '다시 확인했고 괜찮아요').error_code, 'APPROVAL_REJECTED_FOR_BINDING');
  assert.equal(fs.readFileSync(path.join(dir, 'approvals.json'), 'utf8'), snapshot);
  // 결합값(배포 URL)이 바뀌면 다시 승인할 수 있고, 이전 거절 기록은 그대로 남는다.
  deploy(dir, 'https://sample-v2.example/');
  assert.equal(approve(dir, 'MOBILE_DEVICE_REVIEW', 'APPROVE', '새 배포에서 확인했어요').recorded, true);
  const after = readJson(dir, 'approvals.json');
  assert.deepEqual(after.slice(0, 1), JSON.parse(snapshot));
  assert.equal(after.length, 2);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('R1 record-judgement: 외부 판정 JSON을 신뢰하지 않고 재계산한다', () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-eeeeee');
  const beforeRun = fs.readFileSync(path.join(dir, 'run.json'), 'utf8');
  assert.equal(recordJudgement(dir, '{"judge":').error_code, 'JUDGE_JSON_INVALID');
  assert.equal(recordJudgement(dir, '{"judge":"someone"}').error_code, 'JUDGE_RESULT_MISMATCH');
  const out = JSON.parse(judge(dir).stdout);
  assert.equal(recordJudgement(dir, JSON.stringify({ ...out, standards_version: '0.0.0' })).error_code, 'JUDGE_RESULT_MISMATCH');
  assert.equal(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'), beforeRun);
  // 판정 없이 파일만으로 재계산해 기록할 수 있고, 기록의 출처는 재계산이다.
  assert.equal(recordJudgement(dir).recorded, true);
  assert.equal(readJson(dir, 'run.json').judgements.at(-1).source, 'recomputed');
});

test('R1 결합값만 맞춘 조작 판정 JSON은 pre_record 허가로 기록되지 않는다', async () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-e1e1e1');
  deploy(dir, 'https://sample.example/');
  approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '운영 주소 맞아요');
  await writeSyntheticStage4(dir);
  recordJudgement(dir);
  const real = JSON.parse(judge(dir).stdout);
  assert.equal(real.verdict.release_record_allowed, false);
  const forged = { ...real, verdict: { ...real.verdict, phase: 'pre_record', release_record_allowed: true } };
  forged.stage5 = { ...real.stage5, release_record_allowed: true, items: real.stage5.items.map((i) => ({ ...i, status: 'PASS', failure_code: null })) };
  const beforeRun = fs.readFileSync(path.join(dir, 'run.json'), 'utf8');
  assert.equal(recordJudgement(dir, JSON.stringify(forged)).error_code, 'JUDGE_RESULT_MISMATCH');
  assert.equal(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'), beforeRun);
  assert.equal(readJson(dir, 'run.json').pre_record_authorizations.length, 0);
  assert.equal(writeRelease(dir).error_code, 'NO_PRE_RECORD_AUTHORIZATION');
});

test('R8 set-deployment: 사용자정보·query·fragment가 있는 URL은 거부하고 값이 출력되지 않는다', () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-e2e2e2');
  const beforeRun = fs.readFileSync(path.join(dir, 'run.json'), 'utf8');
  for (const [url, code] of [['https://sample.example/?token=SECRETVALUE1', 'URL_QUERY_OR_FRAGMENT_FORBIDDEN'], ['https://sample.example/#SECRETVALUE2', 'URL_QUERY_OR_FRAGMENT_FORBIDDEN'],
    ['https://sample.example/?', 'URL_QUERY_OR_FRAGMENT_FORBIDDEN'], ['https://user:SECRETVALUE3@sample.example/', 'URL_USERINFO_FORBIDDEN']]) {
    const r = node([script('orchestrator/set-deployment.mjs'), dir, url, '--statement-file', stmt(`배포했어 ${url}`)]);
    assert.equal(JSON.parse(r.stdout).error_code, code, url);
    assert.ok(!/SECRETVALUE/.test(r.stdout + r.stderr), url);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'), beforeRun);
});

test('nextStatus: COMPLETE는 post_record·complete_allowed·릴리스 파일·비합성 stage 4일 때만', () => {
  const v = { run_status: 'AWAITING_APPROVAL', phase: 'post_record', release_record_allowed: false, complete_allowed: true };
  const ok = { previousStatus: 'AWAITING_APPROVAL', releasePresent: true, syntheticStage4: false };
  assert.equal(nextStatus(v, ok), 'COMPLETE');
  assert.equal(nextStatus(v, { ...ok, syntheticStage4: true }), 'AWAITING_APPROVAL');
  assert.equal(nextStatus(v, { ...ok, releasePresent: false }), 'AWAITING_APPROVAL');
  assert.equal(nextStatus({ ...v, phase: 'pre_record' }, ok), 'AWAITING_APPROVAL');
  assert.equal(nextStatus({ ...v, complete_allowed: false }, ok), 'AWAITING_APPROVAL');
  assert.equal(validateJudge({ judge: 'gate-judge', standards_version: 'x', verdict: { run_status: 'COMPLETE', phase: null, release_record_allowed: false, complete_allowed: false } }, 'x'), 'JUDGE_SCHEMA_INVALID');
});

test('[judge_unit, end_to_end:false] pre_record → 릴리스 기록 → post_record, 합성 stage 4로는 COMPLETE가 되지 않는다', async () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-ffffff');
  assert.equal(deploy(dir, 'https://sample.example/').recorded, true);
  approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '운영 주소 맞아요');
  const s4 = await writeSyntheticStage4(dir);
  assert.ok(s4.items.every((i) => i.status === 'PASS'));

  let out = JSON.parse(judge(dir).stdout);
  assert.equal(out.verdict.run_status, 'AWAITING_APPROVAL');
  assert.equal(out.verdict.phase, 'pre_record');
  assert.equal(recordJudgement(dir, JSON.stringify(out)).run_status, 'AWAITING_APPROVAL');
  assert.equal(writeRelease(dir).error_code, 'NO_PRE_RECORD_AUTHORIZATION');

  approve(dir, 'MOBILE_DEVICE_REVIEW', 'APPROVE', '모바일 검수 승인 합니다');
  approve(dir, 'HOME_ICON_REVIEW', 'APPROVE', '아이콘 승인');
  approve(dir, 'FINAL_RELEASE', 'APPROVE', '최종 릴리스 승인');
  out = JSON.parse(judge(dir).stdout);
  assert.equal(out.verdict.phase, 'pre_record');
  assert.equal(out.verdict.release_record_allowed, true, JSON.stringify(out.stage5.items.map((i) => [i.check_id, i.status, i.failure_code])));
  recordJudgement(dir, JSON.stringify(out));
  assert.equal(readJson(dir, 'run.json').pre_record_authorizations.length, 1);

  const w = writeRelease(dir);
  assert.equal(w.written, 'releases/sample-app/v1.0.0.md');
  assert.equal(writeRelease(dir).error_code, 'RELEASE_RECORD_EXISTS');

  out = JSON.parse(judge(dir).stdout);
  assert.equal(out.verdict.phase, 'post_record');
  assert.equal(out.verdict.complete_allowed, true);
  const rec = recordJudgement(dir, JSON.stringify(out));
  assert.equal(rec.synthetic_stage4, true);
  assert.equal(rec.run_status, 'AWAITING_APPROVAL');
  assert.notEqual(readJson(dir, 'run.json').status, 'COMPLETE');
  assert.ok(fs.readdirSync(dir).some((n) => /^05-release\.a\d+\.json$/.test(n)));

  // 운영 URL이 바뀌면 이전 pre_record 허가는 재사용되지 않는다 (post_record로 남고 FAIL).
  deploy(dir, 'https://sample-new.example/');
  out = JSON.parse(judge(dir).stdout);
  const jg2 = out.stage5.items.find((i) => i.check_id === 'JG-02');
  assert.equal(out.verdict.phase, 'post_record');
  assert.equal(jg2.failure_code, 'PRE_RECORD_AUTHORIZATION_STALE');
  assert.deepEqual(jg2.evidence.mismatched_fields, ['operating_url']);
  assert.equal(out.verdict.run_status, 'BLOCKED');
  fs.rmSync(path.join(root, 'releases'), { recursive: true, force: true });
});

test('[judge_unit] S1 stage 4 선실행 → 확인·새 deployment → stage 4 재실행 → 정상 진행 (이전 입력 상태의 결과는 충돌이 아니라 stale)', async () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-5151a1');
  deploy(dir, 'https://sample.example/');
  await writeSyntheticStage4(dir);
  assert.equal(readJson(dir, '04-production.a1.json').url_confirmation_status, 'MISSING');
  approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '운영 주소 맞아요');
  let out = JSON.parse(judge(dir).stdout);
  assert.equal(out.stage4.stale, true);
  assert.equal(out.stage4.reason, 'URL_CONFIRMATION_CHANGED');
  recordJudgement(dir);
  assert.equal(readJson(dir, 'run.json').conflicts.length, 0);
  // 이전 deployment에서 기록된 충돌이 있어도 현재 deployment의 판정을 막지 않는다.
  const run = readJson(dir, 'run.json');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...run, conflicts: [{ kind: 'RUNNER_JUDGE', stage: '4', fingerprint: readJson(dir, '03-browser.a1.json').fingerprint, deployment_id: 'd1', mismatches: [{}] }] }));
  deploy(dir, 'https://sample-final.example/');
  approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '이 주소가 운영 주소예요');
  await writeSyntheticStage4(dir);
  assert.equal(recordJudgement(dir).run_status, 'AWAITING_APPROVAL');
  for (const t of ['MOBILE_DEVICE_REVIEW', 'HOME_ICON_REVIEW', 'FINAL_RELEASE']) approve(dir, t, 'APPROVE', `${t} 승인`);
  out = JSON.parse(judge(dir).stdout);
  assert.equal(out.verdict.release_record_allowed, true, JSON.stringify(out.stage5.items.map((i) => [i.check_id, i.status, i.failure_code])));
  recordJudgement(dir);
  assert.equal(writeRelease(dir).written, 'releases/sample-app/v1.0.0.md');
  out = JSON.parse(judge(dir).stdout);
  assert.equal(out.verdict.phase, 'post_record');
  assert.equal(out.verdict.complete_allowed, true);
  fs.rmSync(path.join(root, 'releases'), { recursive: true, force: true });
});

test('[judge_unit] S2 pre_record 허가 뒤 거절이 추가되면 릴리스 파일을 만들지 않는다', async () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-5252a2');
  deploy(dir, 'https://sample.example/');
  approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '운영 주소 맞아요');
  await writeSyntheticStage4(dir);
  recordJudgement(dir);
  for (const t of ['MOBILE_DEVICE_REVIEW', 'HOME_ICON_REVIEW', 'FINAL_RELEASE']) approve(dir, t, 'APPROVE', `${t} 승인`);
  recordJudgement(dir);
  assert.equal(readJson(dir, 'run.json').pre_record_authorizations.length, 1);
  assert.equal(approve(dir, 'FINAL_RELEASE', 'REJECT', '잠깐, 최종 릴리스 거절할게요').recorded, true);
  assert.equal(writeRelease(dir).error_code, 'PRE_RECORD_CONDITION_UNMET');
  assert.equal(fs.existsSync(path.join(root, 'releases', 'sample-app', 'v1.0.0.md')), false);
});

// R4: 외부 서비스 없이 COMPLETE 전이 로직을 결정적으로 검증한다. 모의 응답으로 만든 stage 4 결과에 합성 표시를 하지 않아
// 전이 조건만 확인하며, 실제 운영 URL·실제 기기 검수 근거가 아니다 (verification_type: judge_unit, end_to_end: false).
test('[judge_unit, end_to_end:false] R4 COMPLETE 전이는 post_record·complete_allowed·릴리스 파일이 모두 맞을 때만 일어난다', async () => {
  const dir = cloneRun(baseRun, '20260930-100000-KST-c0c0c0');
  deploy(dir, 'https://sample.example/');
  approve(dir, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '운영 주소 맞아요');
  await writeSyntheticStage4(dir, { markSynthetic: false });
  assert.equal(recordJudgement(dir).run_status, 'AWAITING_APPROVAL');
  for (const t of ['MOBILE_DEVICE_REVIEW', 'HOME_ICON_REVIEW', 'FINAL_RELEASE']) approve(dir, t, 'APPROVE', `${t} 승인`);
  assert.equal(recordJudgement(dir).run_status, 'AWAITING_APPROVAL');
  assert.notEqual(readJson(dir, 'run.json').status, 'COMPLETE');
  assert.equal(writeRelease(dir).written, 'releases/sample-app/v1.0.0.md');
  const record = fs.readFileSync(path.join(root, 'releases', 'sample-app', 'v1.0.0.md'), 'utf8');
  assert.ok(!/[?#@]/.test(record.match(/"operating_url": "([^"]*)"/)[1]));
  assert.equal(recordJudgement(dir).run_status, 'COMPLETE');
  assert.equal(readJson(dir, 'run.json').status, 'COMPLETE');
  fs.rmSync(path.join(root, 'releases'), { recursive: true, force: true });
});
