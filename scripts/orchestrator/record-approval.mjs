// 승인·거절 기록: node scripts/orchestrator/record-approval.mjs <run_dir> <approval_type> <APPROVE|REJECT> --statement-file <path>
// approvals.json에 append만 한다. 결합값(run_id·fingerprint·목표 버전·운영 URL)은 스크립트가 현재 값으로 채운다.
import fs from 'node:fs';
import path from 'node:path';
import { getCheck, loadChecks } from '../lib/checks.mjs';
import { URL_CONFIRMATION, hasStatement, matchesBinding } from '../lib/approvals.mjs';
import { resolveRunDir } from '../lib/paths.mjs';
import { writeAtomic } from '../lib/result.mjs';
import { currentBinding, currentDeployment, currentFingerprint, deploymentValid, readRunState } from '../lib/run-state.mjs';
import { ROOT, fail, nowIso, out, readStatement } from './common.mjs';

const HA_IDS = ['HA-01', 'HA-02', 'HA-03'];

function main() {
  const [runDirArg, type, decision] = process.argv.slice(2);
  const statement = readStatement(process.argv);
  if (!['APPROVE', 'REJECT'].includes(decision)) fail('DECISION_INVALID');
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) fail('CHECKS_INVALID');
  const haTypes = HA_IDS.map((id) => getCheck(data, id).rule.approval_type);
  if (type !== URL_CONFIRMATION && !haTypes.includes(type)) fail('APPROVAL_TYPE_INVALID');

  const rd = resolveRunDir(ROOT, runDirArg);
  if (!rd.ok) fail(rd.code);
  const state = readRunState(rd.dir);
  if (!state.ok) fail(state.code);
  const d = currentDeployment(state.run);
  if (!d) fail('NO_DEPLOYMENT');
  const fingerprint = currentFingerprint(state.input, data);
  if (!deploymentValid(d, fingerprint, state.input)) fail('STATE_MISMATCH');
  const b = currentBinding({ run: state.run, input: state.input, fingerprint, checksData: data });
  const binding = { run_id: b.run_id, fingerprint: b.fingerprint, target_version: b.target_version, operating_url: b.operating_url };
  const approvals = state.approvals;
  const current = (t) => approvals.filter((r) => r.approval_type === t && hasStatement(r) && matchesBinding(r, binding));

  if (type === URL_CONFIRMATION) {
    const rejected = approvals.some((r) => r.approval_type === URL_CONFIRMATION && r.deployment_id === d.deployment_id && r.decision === 'REJECT');
    if (rejected && decision === 'APPROVE') fail('URL_REJECTED_FOR_DEPLOYMENT');
  } else {
    const idx = haTypes.indexOf(type);
    const check = getCheck(data, HA_IDS[idx]);
    const flag = /^([a-z_]+)\s*==\s*(\S+)$/.exec(check.applies_when);
    if (flag && String(state.input.flags && state.input.flags[flag[1]]) !== flag[2]) fail('APPROVAL_NOT_APPLICABLE');
    // 같은 결합값에서 REJECT가 기록되면 APPROVE를 추가해 뒤집을 수 없다. 새 실행이나 결합값 변경이 필요하다.
    if (decision === 'APPROVE' && current(type).some((r) => r.decision === 'REJECT')) fail('APPROVAL_REJECTED_FOR_BINDING');
    for (let i = 0; i < idx; i += 1) {
      const priorCheck = getCheck(data, HA_IDS[i]);
      const pf = /^([a-z_]+)\s*==\s*(\S+)$/.exec(priorCheck.applies_when);
      if (pf && String(state.input.flags && state.input.flags[pf[1]]) !== pf[2]) continue;
      const prior = current(haTypes[i]);
      if (!prior.length) fail('PRIOR_APPROVAL_MISSING');
      if (prior.some((r) => r.decision === 'REJECT') || prior[prior.length - 1].decision !== 'APPROVE') fail('PRIOR_APPROVAL_REJECTED');
    }
  }

  const record = { approval_type: type, decision, statement, approved_at: nowIso(), ...binding, deployment_id: d.deployment_id };
  const file = path.join(rd.dir, 'approvals.json');
  const before = fs.readFileSync(file, 'utf8');
  writeAtomic(file, `${JSON.stringify([...approvals, record], null, 2)}\n`);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (JSON.stringify(after.slice(0, approvals.length)) !== JSON.stringify(JSON.parse(before))) fail('APPEND_ONLY_VIOLATION');
  return out({ recorded: true, approval_type: type, decision, index: approvals.length });
}

try {
  main();
} catch (e) {
  out({ recorded: false, run_status: 'BLOCKED', error_code: e.code || 'RECORD_APPROVAL_ERROR' }, 1);
}
