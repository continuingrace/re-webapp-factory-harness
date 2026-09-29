// Stage 5 판정 (HA-01~03, JG-01, JG-02). 네트워크를 쓰지 않고 파일도 쓰지 않는다.
// JG-02 phase는 정확한 릴리스 경로의 일반 파일 존재 여부로 결정한다 (없음: pre_record, 있음: post_record).
import fs from 'node:fs';
import { getCheck } from '../lib/checks.mjs';
import { hasStatement, matchesBinding } from '../lib/approvals.mjs';
import { makeItem, policyCodes } from '../lib/result.mjs';
import { BINDING_FIELDS, parseReleaseRecord, releaseFileState, releasePath, sameBinding } from '../lib/run-state.mjs';

const OK = ['PASS', 'NOT_APPLICABLE'];

function judgeApprovals(checksData, input, approvals, binding, R) {
  const out = [];
  let prevBlocked = false;
  let prevPending = false;
  for (const id of ['HA-01', 'HA-02', 'HA-03']) {
    const check = getCheck(checksData, id);
    const r = R(check);
    const flag = /^([a-z_]+)\s*==\s*(\S+)$/.exec(check.applies_when);
    if (flag && String(input.flags && input.flags[flag[1]]) !== flag[2]) {
      out.push(r.na({ reason: `applies_when 불충족: ${check.applies_when}` }));
      continue;
    }
    // 앞 단계가 거절·만료면 뒤 승인은 받지 않는다(NOT_RUN). 앞 단계가 대기 중이면 뒤 단계도 대기다.
    if (prevBlocked) {
      out.push(r.notRun({ reason: 'PRIOR_APPROVAL_NOT_GRANTED' }));
      continue;
    }
    if (prevPending) {
      out.push(r.awaiting({ reason: 'PRIOR_APPROVAL_PENDING', approval_type: check.rule.approval_type }));
      continue;
    }
    const type = check.rule.approval_type;
    const all = approvals.map((rec, index) => ({ rec, index })).filter(({ rec }) => rec.approval_type === type);
    const current = all.filter(({ rec }) => hasStatement(rec) && matchesBinding(rec, binding));
    // 같은 결합값에서 REJECT가 한 번이라도 있으면 뒤이은 APPROVE로 뒤집히지 않는다.
    const rejected = current.find(({ rec }) => rec.decision === 'REJECT');
    if (rejected) {
      out.push(r.fail('APPROVAL_REJECTED', { approvals_index: rejected.index, decision: 'REJECT', sticky: true }));
      prevBlocked = true;
    } else if (current.length) {
      const last = current[current.length - 1];
      if (last.rec.decision === 'APPROVE') out.push(r.pass({ approvals_index: last.index, decision: 'APPROVE', approved_at: last.rec.approved_at }));
      else { out.push(r.fail('APPROVAL_REJECTED', { approvals_index: last.index, decision: last.rec.decision })); prevBlocked = true; }
    } else if (all.length) {
      out.push(r.fail('APPROVAL_STALE', { approvals_indexes: all.map((x) => x.index), reason: '현재 fingerprint·목표 버전·운영 URL·run_id와 일치하는 원문 승인 없음' }));
      prevBlocked = true;
    } else {
      out.push(r.awaiting({ reason: 'APPROVAL_MISSING', approval_type: type }));
      prevPending = true;
    }
  }
  return out;
}

// 불변 원칙 1: 근거 없는 통과, 오래된 fingerprint의 통과, 근거 없는 N/A, 원문 없는 승인이 0건이어야 한다.
function judgeEvidence(check, runnerItems, approvals, fingerprint, r) {
  const empty = (e) => e === null || e === undefined || (typeof e === 'object' && Object.keys(e).length === 0) || (typeof e === 'string' && e.trim() === '');
  const v = { pass_without_evidence: [], pass_with_stale_fingerprint: [], not_applicable_without_reason: [], approval_without_statement: [] };
  for (const i of runnerItems) {
    if (i.status === 'PASS' && empty(i.evidence)) v.pass_without_evidence.push(i.check_id);
    if (i.status === 'PASS' && i.fingerprint !== fingerprint) v.pass_with_stale_fingerprint.push(i.check_id);
    if (i.status === 'NOT_APPLICABLE' && empty(i.evidence)) v.not_applicable_without_reason.push(i.check_id);
  }
  approvals.forEach((a, idx) => { if (!hasStatement(a)) v.approval_without_statement.push(idx); });
  const rule = check.rule;
  const over = v.pass_without_evidence.length > rule.max_pass_without_evidence
    || v.pass_with_stale_fingerprint.length > rule.max_pass_with_stale_fingerprint
    || v.not_applicable_without_reason.length > rule.max_not_applicable_without_reason
    || v.approval_without_statement.length > rule.max_approval_without_statement;
  return over ? r.fail('UNVERIFIED_PASS', v) : r.pass({ ...v, runner_items_checked: runnerItems.length, approvals_checked: approvals.length });
}

function countStatuses(items) {
  const c = {};
  for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
  return c;
}

function judgeCompletion(check, ctx, priorItems, r) {
  const rule = check.rule.phases;
  const file = releasePath(ctx.root, ctx.run.app_slug, ctx.input.target_version);
  const fileState = releaseFileState(file);
  const counts = countStatuses(priorItems);
  if (fileState.state === 'INVALID_PATH' || fileState.state === 'NOT_REGULAR') {
    return { phase: 'post_record', item: r.fail('RELEASE_RECORD_CONFLICT', { phase: 'post_record', release_file: fileState.state }) };
  }
  if (fileState.state === 'ABSENT') {
    const p = rule.pre_record;
    if (!ctx.stages_ready) {
      return { phase: 'pre_record', item: r.notRun({ phase: 'pre_record', reason: 'STAGE4_RESULT_NOT_CURRENT' }) };
    }
    if (ctx.run.status !== p.requires_run_status) {
      return { phase: 'pre_record', item: r.notRun({ phase: 'pre_record', reason: 'RUN_STATUS_NOT_READY', run_status: ctx.run.status }) };
    }
    const blocking = Object.entries(p.max_count).filter(([s, max]) => s !== 'AWAITING_APPROVAL' && (counts[s] || 0) > max);
    if (blocking.length) return { phase: 'pre_record', item: r.fail('COMPLETION_UNMET', { phase: 'pre_record', counts }) };
    if ((counts.AWAITING_APPROVAL || 0) > p.max_count.AWAITING_APPROVAL) {
      return { phase: 'pre_record', item: r.awaiting({ phase: 'pre_record', counts }) };
    }
    return { phase: 'pre_record', item: r.pass({ phase: 'pre_record', counts, release_record_exists: false, bind_to: ctx.binding }), release_record_allowed: true };
  }
  // post_record: 파일이 있으면 pre_record로 되돌리지 않는다.
  const p = rule.post_record;
  const auths = Array.isArray(ctx.run.pre_record_authorizations) ? ctx.run.pre_record_authorizations : [];
  const latest = auths.length ? auths[auths.length - 1] : null;
  const ev = { phase: 'post_record', counts, latest_authorization_index: latest ? auths.length - 1 : null };
  if (!latest || latest.release_record_allowed !== true) return { phase: 'post_record', item: r.fail('RELEASE_RECORD_EXISTS', ev) };
  if (!sameBinding(latest.binding, ctx.binding, p.pre_record_binding_must_match_current)) {
    const diff = BINDING_FIELDS.filter((f) => latest.binding[f] !== ctx.binding[f]);
    return { phase: 'post_record', item: r.fail('PRE_RECORD_AUTHORIZATION_STALE', { ...ev, mismatched_fields: diff }) };
  }
  if (!ctx.stages_ready || ctx.run.status !== p.requires_run_status) {
    return { phase: 'post_record', item: r.fail('COMPLETION_UNMET', { ...ev, run_status: ctx.run.status, stages_ready: Boolean(ctx.stages_ready) }) };
  }
  const record = parseReleaseRecord(fs.readFileSync(file, 'utf8'));
  const mismatch = record ? p.must_match.filter((f) => record[f] !== ctx.binding[f]) : p.must_match;
  if (mismatch.length) return { phase: 'post_record', item: r.fail('RELEASE_RECORD_MISMATCH', { ...ev, mismatched_fields: mismatch }) };
  // 현재 fingerprint·현재 deployment에서 기록된 runner·judge 충돌만 센다. 이전 입력 상태의 충돌은 재실행으로 대체된다.
  const currentDeploymentId = ctx.input.deployment_id ?? null;
  const conflicts = (Array.isArray(ctx.run.conflicts) ? ctx.run.conflicts : [])
    .filter((c) => c.fingerprint === ctx.fingerprint && (c.deployment_id ?? null) === currentDeploymentId);
  if (conflicts.length > p.max_conflict_records) return { phase: 'post_record', item: r.fail('RUNNER_JUDGE_CONFLICT', { ...ev, conflicts: conflicts.length }) };
  const notOk = priorItems.filter((i) => !OK.includes(i.status));
  if (notOk.length) return { phase: 'post_record', item: r.fail('COMPLETION_UNMET', ev) };
  return { phase: 'post_record', item: r.pass({ ...ev, release_record_count: p.release_record_count, fields_matched: p.must_match }), complete_allowed: true };
}

// ctx: { root, checksData, input(유효 입력), run, approvals, binding, fingerprint }
// priorItems: gate-judge가 재판정한 stage 1~4 항목. runnerItems: runner가 쓴 최신 결과 항목(JG-01 대상).
export function evaluateStage5(ctx, priorItems, runnerItems) {
  const { checksData } = ctx;
  const meta = { fingerprint: ctx.fingerprint, standards_version: checksData.standards_version, policy_codes: policyCodes(checksData) };
  const R = (check) => ({
    pass: (ev) => makeItem(check, { status: 'PASS', evidence: ev }, meta),
    fail: (code, ev) => makeItem(check, { status: 'FAIL', evidence: ev, failure_code: code, next_action: '사용자 확인 필요' }, meta),
    awaiting: (ev) => makeItem(check, { status: 'AWAITING_APPROVAL', evidence: ev, next_action: '사용자 승인 필요' }, meta),
    notRun: (ev) => makeItem(check, { status: 'NOT_RUN', evidence: ev }, meta),
    na: (ev) => makeItem(check, { status: 'NOT_APPLICABLE', evidence: ev }, meta),
  });
  const approvalItems = judgeApprovals(checksData, ctx.input, ctx.approvals, ctx.binding, R);
  const jg1 = judgeEvidence(getCheck(checksData, 'JG-01'), runnerItems, ctx.approvals, ctx.fingerprint, R(getCheck(checksData, 'JG-01')));
  const completion = judgeCompletion(getCheck(checksData, 'JG-02'), ctx, [...priorItems, ...approvalItems, jg1], R(getCheck(checksData, 'JG-02')));
  return {
    stage: 5,
    phase: completion.phase,
    items: [...approvalItems, jg1, completion.item],
    release_record_allowed: completion.release_record_allowed === true,
    complete_allowed: completion.complete_allowed === true,
    binding: ctx.binding,
  };
}
