// 실행 폴더 상태: run.json, 유효 입력(input.json + 최신 deployment), 현재 결합값, 릴리스 경로.
// 네트워크를 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { computeFingerprint } from './fingerprint.mjs';
import { readClosure } from './closure.mjs';
import { isInside, readRunJson } from './paths.mjs';
import { listAttempts, readStageResult } from './result.mjs';

export function latestValidResult(runDir, prefix) {
  const attempts = listAttempts(runDir, prefix);
  const invalid = [];
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const v = readStageResult(path.join(runDir, attempts[i].name));
    if (v) return { file: attempts[i].name, value: v, invalid };
    invalid.push(attempts[i].name);
  }
  return { file: null, value: null, invalid };
}

// 닫힌 실행(closure.json)은 진행 상태로 읽지 않는다: 쓰기·진행 helper는 모두 RUN_CLOSED로 거부한다.
// 닫기 기록이 깨졌거나 기존 파일이 바뀌었으면 그 코드(CLOSURE_*)로 거부한다.
export function readRunState(runDir) {
  const closure = readClosure(runDir);
  if (closure.state === 'CLOSED') return { ok: false, code: 'RUN_CLOSED', closure: closure.value };
  if (closure.state === 'INVALID') return { ok: false, code: closure.code };
  const input = readRunJson(runDir, 'input.json');
  if (!input.ok) return { ok: false, code: input.code };
  const run = readRunJson(runDir, 'run.json');
  if (!run.ok) return { ok: false, code: run.code };
  const approvalsFile = path.join(runDir, 'approvals.json');
  let approvals = [];
  if (fs.existsSync(approvalsFile)) {
    const a = readRunJson(runDir, 'approvals.json');
    if (!a.ok || !Array.isArray(a.value)) return { ok: false, code: 'APPROVALS_INVALID' };
    approvals = a.value;
  }
  if (!Array.isArray(run.value.deployment)) return { ok: false, code: 'RUN_STATE_INVALID' };
  return { ok: true, input: input.value, run: run.value, approvals };
}

export function currentDeployment(run) {
  const list = Array.isArray(run.deployment) ? run.deployment : [];
  return list.length ? list[list.length - 1] : null;
}

// 최초 입력은 바꾸지 않고, 가장 최근 deployment를 현재 입력으로 겹쳐 쓴다.
export function effectiveInput(input, run) {
  const d = currentDeployment(run);
  if (!d) return { ...input, deployment_id: null };
  return { ...input, release_phase: d.release_phase, operating_url: d.operating_url, deployment_id: d.deployment_id };
}

export function currentFingerprint(input, checksData) {
  const fp = computeFingerprint(input.app_path, checksData.policies.fingerprint);
  return fp.status === 'OK' ? fp.value : null;
}

export function deploymentValid(d, fingerprint, input) {
  return Boolean(d) && d.fingerprint === fingerprint && d.target_version === input.target_version;
}

// JG-02 pre_record 허가에 묶는 6개 값
export const BINDING_FIELDS = ['run_id', 'app_slug', 'target_version', 'fingerprint', 'operating_url', 'standards_version'];

export function currentBinding({ run, input, fingerprint, checksData }) {
  const d = currentDeployment(run);
  return {
    run_id: run.run_id,
    app_slug: run.app_slug,
    target_version: input.target_version,
    fingerprint,
    operating_url: d ? d.operating_url : null,
    standards_version: checksData.standards_version,
  };
}

export function sameBinding(a, b, fields = BINDING_FIELDS) {
  return Boolean(a && b) && fields.every((f) => a[f] === b[f]);
}

export function releasePath(root, slug, version) {
  const p = path.join(root, 'releases', slug, `v${version}.md`);
  if (!isInside(path.join(root, 'releases'), p)) return null;
  return p;
}

// 릴리스 기록은 정확한 경로의 일반 파일만 인정한다. link는 기록으로 인정하지 않는다.
export function releaseFileState(file) {
  if (!file) return { state: 'INVALID_PATH' };
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { state: 'ABSENT' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { state: 'NOT_REGULAR' };
  return { state: 'PRESENT' };
}

export function parseReleaseRecord(text) {
  const m = /```json release-record\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
