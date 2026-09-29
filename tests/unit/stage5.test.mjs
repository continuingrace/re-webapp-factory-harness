// stage 5 판정 단위 테스트 (합성 입력, judge_unit). 파일은 임시 루트에만 만든다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, withTemp } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { evaluateStage5 } from '../../scripts/stages/stage5-release.mjs';

const { data } = loadChecks(REPO);
const binding = { run_id: 'r1', app_slug: 'sample-app', target_version: '1.0.0', fingerprint: 'fp1', operating_url: 'https://sample.example/', standards_version: data.standards_version };
const input = { target_version: '1.0.0', flags: { pwa_installable: 'yes' } };
const rec = (type, decision, extra = {}) => ({ approval_type: type, decision, statement: '원문', approved_at: 't', run_id: 'r1', fingerprint: 'fp1', target_version: '1.0.0', operating_url: 'https://sample.example/', ...extra });
const allApproved = [rec('MOBILE_DEVICE_REVIEW', 'APPROVE'), rec('HOME_ICON_REVIEW', 'APPROVE'), rec('FINAL_RELEASE', 'APPROVE')];
const passItem = (id) => ({ check_id: id, status: 'PASS', evidence: { ok: true }, fingerprint: 'fp1' });

function run5(root, { approvals = allApproved, status = 'AWAITING_APPROVAL', auths = [], runner = [passItem('ST-01')], ready = true } = {}) {
  const run = { run_id: 'r1', app_slug: 'sample-app', status, pre_record_authorizations: auths, conflicts: [] };
  return evaluateStage5({ root, checksData: data, input, run, approvals, binding, fingerprint: 'fp1', stages_ready: ready }, [passItem('PD-01')], runner);
}
const item = (r, id) => r.items.find((i) => i.check_id === id);

test('승인 3종이 현재 결합값으로 APPROVE면 PASS, pre_record 허가', () => withTemp((t) => {
  const r = run5(t);
  assert.deepEqual(['HA-01', 'HA-02', 'HA-03', 'JG-01', 'JG-02'].map((id) => item(r, id).status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(r.phase, 'pre_record');
  assert.equal(r.release_record_allowed, true);
}));

test('[judge_unit] 승인 뒤 fingerprint가 바뀌면 HA-01 APPROVAL_STALE, 뒤 승인은 NOT_RUN', () => withTemp((t) => {
  const r = run5(t, { approvals: allApproved.map((a) => ({ ...a, fingerprint: 'old' })) });
  assert.equal(item(r, 'HA-01').failure_code, 'APPROVAL_STALE');
  assert.equal(item(r, 'HA-02').status, 'NOT_RUN');
  assert.equal(r.release_record_allowed, false);
}));

test('앞 단계 REJECT는 APPROVAL_REJECTED, 승인이 없으면 AWAITING_APPROVAL', () => withTemp((t) => {
  assert.equal(item(run5(t, { approvals: [rec('MOBILE_DEVICE_REVIEW', 'REJECT')] }), 'HA-01').failure_code, 'APPROVAL_REJECTED');
  const r = run5(t, { approvals: [] });
  assert.equal(item(r, 'HA-01').status, 'AWAITING_APPROVAL');
  assert.equal(item(r, 'JG-02').status, 'AWAITING_APPROVAL');
}));

test('[judge_unit] 근거가 빈 PASS와 원문이 빈 승인은 JG-01 UNVERIFIED_PASS', () => withTemp((t) => {
  const r = run5(t, { runner: [{ check_id: 'ST-02', status: 'PASS', evidence: {}, fingerprint: 'fp1' }] });
  assert.equal(item(r, 'JG-01').failure_code, 'UNVERIFIED_PASS');
  const r2 = run5(t, { approvals: [...allApproved, rec('FINAL_RELEASE', 'APPROVE', { statement: '' })] });
  assert.equal(item(r2, 'JG-01').failure_code, 'UNVERIFIED_PASS');
}));

test('릴리스 파일: 허가 없음은 RELEASE_RECORD_EXISTS, 결합값 불일치는 PRE_RECORD_AUTHORIZATION_STALE', () => withTemp((t) => {
  const file = path.join(t, 'releases', 'sample-app', 'v1.0.0.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# r\n\n\`\`\`json release-record\n${JSON.stringify(binding)}\n\`\`\`\n`);
  assert.equal(item(run5(t), 'JG-02').failure_code, 'RELEASE_RECORD_EXISTS');
  const stale = [{ release_record_allowed: true, binding: { ...binding, operating_url: 'https://old.example/' } }];
  const r = run5(t, { auths: stale });
  assert.equal(r.phase, 'post_record');
  assert.equal(item(r, 'JG-02').failure_code, 'PRE_RECORD_AUTHORIZATION_STALE');
  const good = run5(t, { auths: [{ release_record_allowed: true, binding }] });
  assert.equal(good.complete_allowed, true);
}));

test('릴리스 경로의 junction은 기록으로 인정하지 않는다', (tc) => withTemp((t) => {
  const target = path.join(t, 'elsewhere');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(t, 'releases', 'sample-app'), { recursive: true });
  try {
    fs.symlinkSync(target, path.join(t, 'releases', 'sample-app', 'v1.0.0.md'), 'junction');
  } catch {
    tc.skip('이 환경에서 junction을 만들 수 없음');
    return;
  }
  assert.equal(item(run5(t), 'JG-02').failure_code, 'RELEASE_RECORD_CONFLICT');
}));

test('stage 4 결과가 현재 것이 아니면 pre_record 허가를 내지 않는다', () => withTemp((t) => {
  const r = run5(t, { ready: false });
  assert.equal(item(r, 'JG-02').status, 'NOT_RUN');
  assert.equal(r.release_record_allowed, false);
}));
