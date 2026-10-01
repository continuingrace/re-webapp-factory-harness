// gate-judge 순수 판정 로직. 파일을 쓰지 않고, 브라우저를 실행하거나 네트워크를 쓰지 않는다.
// judge.mjs(출력)와 record-judgement.mjs(재계산 후 기록)가 함께 쓴다.
// stage 1·2는 직접 재실행하고, stage 3·4는 runner가 남긴 원시 측정값을 checks.json 기준으로 재판정한다.
// stage 5는 approvals.json·run.json·릴리스 파일로 판정하며 phase(pre_record/post_record)를 명시한다.
import { loadChecks } from './checks.mjs';
import { urlConfirmation } from './approvals.mjs';
import { resolveRunDir, readRunJson } from './paths.mjs';
import { currentBinding, currentDeployment, deploymentValid, effectiveInput, latestValidResult, readRunState } from './run-state.mjs';
import { loadIdentifiers } from './identifiers.mjs';
import { readClosure } from './closure.mjs';
import { judgeIntake } from '../stages/stage1-intake.mjs';
import { judgeStatic } from '../stages/stage2-static.mjs';
import { evaluateStage3, rawsFromItems } from '../stages/stage3-evaluate.mjs';
import { evaluateStage4 } from '../stages/stage4-evaluate.mjs';
import { evaluateStage5 } from '../stages/stage5-release.mjs';

export const ATTENTION = { status: 'NEEDS_ATTENTION', failure_code: 'CHECK_INCONCLUSIVE' };
const OK = ['PASS', 'NOT_APPLICABLE'];

function compare(runner, judged) {
  if (!runner) return [];
  const byId = new Map(runner.items.map((i) => [i.check_id, i]));
  const diff = [];
  for (const j of judged.items) {
    const r = byId.get(j.check_id);
    if (!r || r.status !== j.status || r.failure_code !== j.failure_code) {
      diff.push({ check_id: j.check_id, runner: r ? [r.status, r.failure_code] : null, judge: [j.status, j.failure_code] });
    }
  }
  return diff;
}

// runner 결과가 오래된 근거인지 먼저 판정한다. 오래된 근거는 충돌이 아니라 재실행 대상이다.
function staleReason(runner, current) {
  if (runner.fingerprint !== current.fingerprint || runner.standards_version !== current.standards_version) return 'EVIDENCE_STALE';
  if (current.deployment_id !== undefined && runner.deployment_id !== current.deployment_id) return 'EVIDENCE_STALE';
  // stage 4는 측정 당시의 운영 URL 확인 상태에 묶인다. 확인 상태가 바뀌면 재측정 대상이지 충돌이 아니다.
  if (current.url_confirmation_status !== undefined && runner.url_confirmation_status !== current.url_confirmation_status) return 'URL_CONFIRMATION_CHANGED';
  if (runner.fingerprint_changed_during_run === true) return 'FINGERPRINT_CHANGED_DURING_RUN';
  return null;
}

function rejudge(runner, current, evaluate) {
  if (!runner.value) return { present: false, latest_file: null, invalid_files: runner.invalid };
  const base = { present: true, latest_file: runner.file, invalid_files: runner.invalid };
  const reason = staleReason(runner.value, current);
  if (reason) return { ...base, stale: true, run_status: 'BLOCKED', reason };
  const judged = evaluate(rawsFromItems(runner.value.items));
  const mismatches = compare(runner.value, judged);
  return { ...base, stale: false, items: judged.items, mismatches, run_status: mismatches.length ? 'BLOCKED' : judged.run_status };
}

// gate-judge·record-judgement·write-release가 모두 이 함수를 쓴다. 판정할 때마다 현재 local 식별자 설정으로
// IN-01·ST-04를 다시 계산하므로, 설정이 바뀌어 runner 결과와 달라지면 BLOCKED가 된다.
// identifiers는 테스트용 주입값이며, 없으면 root의 고정 경로에서만 읽는다.
export function computeJudgement(root, runDirArg, { identifiers } = {}) {
  const rd = resolveRunDir(root, runDirArg);
  if (!rd.ok) return { verdict: ATTENTION, error_code: rd.code };
  const { data, errors } = loadChecks(root);
  if (errors.length) return { verdict: ATTENTION, error_code: 'CHECKS_INVALID' };
  // 닫힌 실행은 다시 판정하지 않고 닫힌 상태를 그대로 보고한다. 릴리스·완료 허가는 항상 false다.
  const closure = readClosure(rd.dir);
  if (closure.state === 'INVALID') return { verdict: ATTENTION, error_code: closure.code };
  if (closure.state === 'CLOSED') {
    const c = closure.value;
    return {
      judge: 'gate-judge',
      standards_version: data.standards_version,
      closure: { status: c.status, kind: c.kind, basis: c.basis, superseded_by: c.superseded_by, recorded_at: c.recorded_at },
      verdict: { run_status: c.status, phase: null, release_record_allowed: false, complete_allowed: false },
    };
  }
  const inputFile = readRunJson(rd.dir, 'input.json');
  if (!inputFile.ok) return { verdict: ATTENTION, error_code: inputFile.code };
  const rawInput = inputFile.value;
  const ids = identifiers ?? loadIdentifiers(root, data.policies.private_identifiers);

  const stage1 = judgeIntake({ root, checksData: data, input: rawInput, identifiers: ids });
  const stage2 = stage1.run_status === 'IN_PROGRESS' ? judgeStatic({ root, checksData: data, input: rawInput, identifiers: ids }) : null;
  const runner2 = latestValidResult(rd.dir, '02-static');
  const current2 = stage2 ? { fingerprint: stage2.fingerprint, standards_version: data.standards_version } : null;
  const stale2 = Boolean(stage2 && runner2.value && staleReason(runner2.value, current2));
  const mismatches2 = stage2 && !stale2 ? compare(runner2.value, stage2) : [];

  let runStatus = stage2 ? stage2.run_status : stage1.run_status;
  if (stale2 || mismatches2.length) runStatus = 'BLOCKED';
  const out = {
    judge: 'gate-judge',
    standards_version: data.standards_version,
    stage1,
    stage2,
    stage3: null,
    stage4: null,
    stage5: null,
    runner_comparison: { latest_file: runner2.file, invalid_files: runner2.invalid, stale: stale2, reason: stale2 ? staleReason(runner2.value, current2) : null, mismatches: mismatches2 },
  };
  const fingerprint = stage2 ? stage2.fingerprint : null;

  if (runStatus === 'IN_PROGRESS') {
    const runner3 = latestValidResult(rd.dir, '03-browser');
    out.stage3 = rejudge(runner3, { fingerprint, standards_version: data.standards_version },
      (raws) => evaluateStage3(data, rawInput, raws, { fingerprint, browser: runner3.value ? runner3.value.browser : null }));
    if (out.stage3.present) runStatus = out.stage3.run_status;
  }

  const state = readRunState(rd.dir);
  if (runStatus === 'AWAITING_DEPLOYMENT' && state.ok) {
    const d = currentDeployment(state.run);
    if (d) {
      if (!deploymentValid(d, fingerprint, rawInput)) {
        runStatus = 'BLOCKED';
        out.stage4 = { present: false, reason: 'DEPLOYMENT_STALE' };
      } else {
        const input = effectiveInput(rawInput, state.run);
        const binding = currentBinding({ run: state.run, input: rawInput, fingerprint, checksData: data });
        const confirmation = urlConfirmation(state.approvals, binding, d.deployment_id);
        out.stage4 = rejudge(latestValidResult(rd.dir, '04-production'), { fingerprint, standards_version: data.standards_version, deployment_id: d.deployment_id, url_confirmation_status: confirmation.status },
          (raws) => evaluateStage4(data, input, raws, confirmation, { fingerprint }));
        runStatus = out.stage4.present ? out.stage4.run_status : 'IN_PROGRESS';
        const priorItems = [stage1, stage2, out.stage3, out.stage4].flatMap((s) => (s && s.items) || []);
        const runnerItems = ['01-intake', '02-static', '03-browser', '04-production']
          .flatMap((p) => { const v = latestValidResult(rd.dir, p).value; return v ? v.items : []; });
        const stagesReady = Boolean(out.stage3 && out.stage3.present && !out.stage3.stale && out.stage4.present && !out.stage4.stale);
        out.stage5 = evaluateStage5({ root, checksData: data, input, run: state.run, approvals: state.approvals, binding, fingerprint, stages_ready: stagesReady }, priorItems, runnerItems);
        const s5 = out.stage5.items;
        if (s5.some((i) => i.status === 'FAIL')) runStatus = 'BLOCKED';
        else if (runStatus === 'AWAITING_APPROVAL' && !s5.every((i) => OK.includes(i.status) || i.status === 'AWAITING_APPROVAL' || i.status === 'NOT_RUN')) runStatus = 'BLOCKED';
      }
    }
  }

  out.verdict = {
    run_status: runStatus,
    phase: out.stage5 ? out.stage5.phase : null,
    release_record_allowed: Boolean(out.stage5 && out.stage5.release_record_allowed && runStatus !== 'BLOCKED'),
    complete_allowed: Boolean(out.stage5 && out.stage5.complete_allowed && runStatus !== 'BLOCKED'),
  };
  return out;
}

// 비교용 정규화: 실행마다 달라지는 checked_at만 제거한다.
export function normalizeJudgement(value) {
  if (Array.isArray(value)) return value.map(normalizeJudgement);
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value).sort()) if (k !== 'checked_at') o[k] = normalizeJudgement(value[k]);
    return o;
  }
  return value;
}
