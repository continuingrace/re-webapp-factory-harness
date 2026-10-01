// harness-runner 진입점: node scripts/run-stage.mjs <stage> <run_dir>
// 해당 실행 폴더에 새 시도 번호의 단계 결과 파일만 만든다. 기존 결과는 덮어쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChecks } from './lib/checks.mjs';
import { loadIdentifiers } from './lib/identifiers.mjs';
import { computeFingerprint } from './lib/fingerprint.mjs';
import { resolveRunDir, readRunJson } from './lib/paths.mjs';
import { listAttempts, readStageResult, writeNoClobber } from './lib/result.mjs';
import { judgeStatic } from './stages/stage2-static.mjs';
import { evaluateStage3 } from './stages/stage3-evaluate.mjs';
import { evaluateStage4 } from './stages/stage4-evaluate.mjs';
import { urlConfirmation } from './lib/approvals.mjs';
import { currentBinding, currentDeployment, deploymentValid, effectiveInput, readRunState } from './lib/run-state.mjs';
import { readClosure } from './lib/closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function out(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exitCode = code;
}

function nextAttempt(dir, prefix) {
  const attempts = listAttempts(dir, prefix);
  return attempts.length ? attempts[attempts.length - 1].attempt + 1 : 1;
}

function latestValid(dir, prefix) {
  const attempts = listAttempts(dir, prefix);
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const v = readStageResult(path.join(dir, attempts[i].name));
    if (v) return v;
  }
  return null;
}

// 식별자 설정은 하네스 루트의 고정 경로에서만 읽는다. 없거나 잘못되면 ST-04만 NOT_RUN이고 실행은 BLOCKED다.
async function runStage2({ data, input }) {
  const identifiers = loadIdentifiers(ROOT, data.policies.private_identifiers);
  return judgeStatic({ root: ROOT, checksData: data, input, identifiers });
}

// stage 3은 최신 stage 2 결과가 같은 fingerprint·standards_version에서 통과했을 때만 실행한다.
async function runStage3({ data, input, runDir, attempt }) {
  const prev = latestValid(runDir, '02-static');
  const fp = computeFingerprint(input.app_path, data.policies.fingerprint);
  if (!prev || prev.run_status !== 'IN_PROGRESS' || fp.status !== 'OK'
    || prev.fingerprint !== fp.value || prev.standards_version !== data.standards_version) {
    return { error_code: 'STAGE_PREREQUISITE_UNMET' };
  }
  const evidenceRel = `evidence/03-browser.a${attempt}`;
  const evidenceDir = path.join(runDir, ...evidenceRel.split('/'));
  fs.mkdirSync(path.dirname(evidenceDir), { recursive: true });
  fs.mkdirSync(evidenceDir);
  const { measureStage3 } = await import('./stages/stage3-browser.mjs');
  const measured = await measureStage3({ checksData: data, input, evidence: { dir: evidenceDir, rel: evidenceRel } });
  const after = computeFingerprint(input.app_path, data.policies.fingerprint);
  const result = evaluateStage3(data, input, measured.raws, { fingerprint: fp.value, browser: measured.browser });
  const changed = after.status !== 'OK' || after.value !== fp.value;
  return {
    ...result,
    run_status: changed ? 'BLOCKED' : result.run_status,
    fingerprint_changed_during_run: changed,
    fingerprint: fp.value,
    standards_version: data.standards_version,
    browser: measured.browser,
    network: measured.network,
  };
}

// stage 4는 최신 stage 3 결과가 같은 fingerprint에서 AWAITING_DEPLOYMENT이고,
// 현재 deployment가 현재 fingerprint·목표 버전과 일치할 때만 실행한다.
async function runStage4({ data, runDir }) {
  const state = readRunState(runDir);
  if (!state.ok) return { error_code: state.code };
  const fp = computeFingerprint(state.input.app_path, data.policies.fingerprint);
  const prev = latestValid(runDir, '03-browser');
  const d = currentDeployment(state.run);
  if (fp.status !== 'OK' || !prev || prev.run_status !== 'AWAITING_DEPLOYMENT' || prev.fingerprint !== fp.value
    || prev.standards_version !== data.standards_version || !deploymentValid(d, fp.value, state.input)) {
    return { error_code: 'STAGE_PREREQUISITE_UNMET' };
  }
  const input = effectiveInput(state.input, state.run);
  const binding = currentBinding({ run: state.run, input: state.input, fingerprint: fp.value, checksData: data });
  const confirmation = urlConfirmation(state.approvals, binding, d.deployment_id);
  const { measureStage4 } = await import('./stages/stage4-production.mjs');
  const measured = await measureStage4({ checksData: data, input, confirmation });
  const result = evaluateStage4(data, input, measured.raws, confirmation, { fingerprint: fp.value });
  return {
    ...result,
    fingerprint: fp.value,
    standards_version: data.standards_version,
    deployment_id: d.deployment_id,
    url_confirmation_status: confirmation.status,
    network: { requests: measured.requests, started_at: measured.started_at, ended_at: measured.ended_at },
  };
}

const STAGES = {
  2: { prefix: '02-static', run: runStage2 },
  3: { prefix: '03-browser', run: runStage3 },
  4: { prefix: '04-production', run: runStage4 },
};

async function main() {
  const [stageArg, runDirArg] = process.argv.slice(2);
  const stage = STAGES[stageArg];
  if (!stage) return out({ error_code: 'STAGE_UNSUPPORTED' }, 2);
  const rd = resolveRunDir(ROOT, runDirArg);
  if (!rd.ok) return out({ error_code: rd.code }, 1);
  // 닫힌 실행이나 닫기 기록이 깨진 실행은 어떤 단계도 실행하지 않는다.
  const closure = readClosure(rd.dir);
  if (closure.state === 'CLOSED') return out({ error_code: 'RUN_CLOSED', run_status: closure.value.status }, 1);
  if (closure.state === 'INVALID') return out({ error_code: closure.code }, 1);
  const input = readRunJson(rd.dir, 'input.json');
  if (!input.ok) return out({ error_code: input.code }, 1);
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) return out({ error_code: 'CHECKS_INVALID' }, 1);

  const attempt = nextAttempt(rd.dir, stage.prefix);
  const result = await stage.run({ data, input: input.value, runDir: rd.dir, attempt });
  if (result.error_code) return out({ error_code: result.error_code }, 1);
  const name = `${stage.prefix}.a${attempt}.json`;
  writeNoClobber(rd.dir, name, `${JSON.stringify({ ...result, attempt, complete: true }, null, 2)}\n`);
  return out({ written: name, run_status: result.run_status });
}

try {
  await main();
} catch (e) {
  out({ error_code: e.code || 'RUN_STAGE_ERROR' }, 1);
}
