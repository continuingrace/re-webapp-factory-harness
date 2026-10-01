// gate-judge 결과 기록: node scripts/orchestrator/record-judgement.mjs <run_dir> [--judge-file <path>]
// 외부에서 받은 판정 JSON을 신뢰하지 않는다. 신뢰된 실행 파일과 단계 결과를 읽어 judge 순수 로직으로 직접 재계산하고,
// 그 결과만 기록한다. --judge-file이 주어지면 정규화된 전체 결과가 재계산 결과와 완전히 같을 때만 기록한다.
// COMPLETE는 post_record의 complete_allowed가 true이고, 합성(검증용) stage 4 결과가 아닐 때만 기록한다.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeJudgement, normalizeJudgement } from '../lib/judge-core.mjs';
import { resolveRunDir } from '../lib/paths.mjs';
import { readClosure } from '../lib/closure.mjs';
import { listAttempts, writeAtomic, writeNoClobber } from '../lib/result.mjs';
import { BINDING_FIELDS, currentBinding, currentDeployment, latestValidResult, readRunState, releaseFileState, releasePath, sameBinding } from '../lib/run-state.mjs';
import { JUDGE_RUN_STATUS, ROOT, fail, nowIso, out } from './common.mjs';

export function validateJudge(j, standardsVersion) {
  if (!j || j.judge !== 'gate-judge') return 'JUDGE_SCHEMA_INVALID';
  if (j.standards_version !== standardsVersion) return 'JUDGE_STANDARDS_MISMATCH';
  const v = j.verdict;
  if (!v || !JUDGE_RUN_STATUS.includes(v.run_status)) return 'JUDGE_SCHEMA_INVALID';
  if (![null, 'pre_record', 'post_record'].includes(v.phase)) return 'JUDGE_SCHEMA_INVALID';
  if (typeof v.release_record_allowed !== 'boolean' || typeof v.complete_allowed !== 'boolean') return 'JUDGE_SCHEMA_INVALID';
  if ((v.release_record_allowed || v.complete_allowed) && !(j.stage5 && j.stage5.binding)) return 'JUDGE_SCHEMA_INVALID';
  return null;
}

// 다음 실행 상태. 재계산한 판정값을 그대로 쓰되, COMPLETE는 모든 조건이 맞을 때만.
export function nextStatus(verdict, { previousStatus, releasePresent, syntheticStage4 }) {
  if (verdict.phase === 'post_record' && verdict.complete_allowed === true && verdict.run_status === 'AWAITING_APPROVAL'
    && previousStatus === 'AWAITING_APPROVAL' && releasePresent && !syntheticStage4) return 'COMPLETE';
  return verdict.run_status;
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function main() {
  const rd = resolveRunDir(ROOT, process.argv[2]);
  if (!rd.ok) fail(rd.code);
  // 닫힌 실행에는 판정을 기록하지 않는다. 닫기 기록이 깨졌으면 그 코드로 거부한다.
  const closure = readClosure(rd.dir);
  if (closure.state === 'CLOSED') fail('RUN_CLOSED');
  if (closure.state === 'INVALID') fail(closure.code);
  const judge = computeJudgement(ROOT, rd.dir);
  if (!judge.judge) fail(judge.error_code || 'JUDGE_UNAVAILABLE');
  const bad = validateJudge(judge, judge.standards_version);
  if (bad) fail(bad);

  const judgeFile = argValue('--judge-file');
  if (process.argv.includes('--judge-file')) {
    if (!judgeFile) fail('JUDGE_FILE_REQUIRED');
    let provided;
    try {
      provided = JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
    } catch {
      fail('JUDGE_JSON_INVALID');
    }
    if (JSON.stringify(normalizeJudgement(provided)) !== JSON.stringify(normalizeJudgement(judge))) fail('JUDGE_RESULT_MISMATCH');
  }

  const state = readRunState(rd.dir);
  if (!state.ok) fail(state.code);
  const fingerprint = judge.stage2 ? judge.stage2.fingerprint : null;
  const binding = currentBinding({ run: state.run, input: state.input, fingerprint, checksData: { standards_version: judge.standards_version } });
  if (judge.stage5 && !sameBinding(judge.stage5.binding, binding)) fail('JUDGE_BINDING_MISMATCH');

  const v = judge.verdict;
  const release = releaseFileState(releasePath(ROOT, state.run.app_slug, state.input.target_version));
  const s4 = latestValidResult(rd.dir, '04-production').value;
  const synthetic = Boolean(s4 && s4.verification && s4.verification.end_to_end === false);
  const status = nextStatus(v, { previousStatus: state.run.status, releasePresent: release.state === 'PRESENT', syntheticStage4: synthetic });

  const now = nowIso();
  const conflicts = [...state.run.conflicts];
  const dep = currentDeployment(state.run);
  const currentDeploymentId = dep ? dep.deployment_id : null;
  for (const [stage, list] of [['2', judge.runner_comparison && judge.runner_comparison.mismatches], ['3', judge.stage3 && judge.stage3.mismatches], ['4', judge.stage4 && judge.stage4.mismatches]]) {
    if (Array.isArray(list) && list.length) conflicts.push({ recorded_at: now, kind: 'RUNNER_JUDGE', stage, fingerprint, deployment_id: currentDeploymentId, mismatches: list });
  }
  const auths = [...state.run.pre_record_authorizations];
  if (v.phase === 'pre_record' && v.release_record_allowed === true) {
    auths.push({ recorded_at: now, release_record_allowed: true, binding: Object.fromEntries(BINDING_FIELDS.map((f) => [f, binding[f]])) });
  }
  const run = {
    ...state.run,
    status,
    updated_at: now,
    conflicts,
    pre_record_authorizations: auths,
    judgements: [...state.run.judgements, { recorded_at: now, ...v, recorded_status: status, synthetic_stage4: synthetic, source: 'recomputed' }],
  };
  if (judge.stage5) {
    const attempts = listAttempts(rd.dir, '05-release');
    const n = attempts.length ? attempts[attempts.length - 1].attempt + 1 : 1;
    writeNoClobber(rd.dir, `05-release.a${n}.json`, `${JSON.stringify({ recorded_at: now, verdict: v, stage5: judge.stage5, source: 'recomputed', complete: true }, null, 2)}\n`);
  }
  writeAtomic(path.join(rd.dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  return out({ recorded: true, run_status: status, synthetic_stage4: synthetic });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    out({ recorded: false, error_code: e.code || 'RECORD_JUDGEMENT_ERROR' }, 1);
  }
}
