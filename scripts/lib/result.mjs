// 검사 항목 결과 생성. 근거 없는 PASS·NOT_APPLICABLE은 만들 수 없다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { codeError } from './checks.mjs';

export const ITEM_STATUS = ['NOT_RUN', 'IN_PROGRESS', 'PASS', 'NOT_APPLICABLE', 'NEEDS_ATTENTION', 'FAIL', 'AWAITING_APPROVAL'];
const EVIDENCE_REQUIRED = ['PASS', 'NOT_APPLICABLE'];

function isEmptyEvidence(e) {
  if (e === undefined || e === null) return true;
  if (typeof e === 'string') return e.trim() === '';
  if (Array.isArray(e)) return e.length === 0;
  if (typeof e === 'object') return Object.keys(e).length === 0;
  return false;
}

// policy 수준 failure code (판정 불가, 도구 없음)
export function policyCodes(checksData) {
  const p = checksData.policies;
  return [p.inconclusive.failure_code, p.missing_tool.failure_code];
}

export function makeItem(check, { status, evidence = null, failure_code = null, next_action = null }, meta) {
  if (!ITEM_STATUS.includes(status)) throw codeError('STATUS_INVALID');
  if (EVIDENCE_REQUIRED.includes(status) && isEmptyEvidence(evidence)) throw codeError('EVIDENCE_REQUIRED');
  const allowed = [...check.failure_code, ...(meta.policy_codes || [])];
  if (status === 'FAIL' && !check.failure_code.includes(failure_code)) throw codeError('FAILURE_CODE_INVALID');
  if (status === 'NEEDS_ATTENTION' && !allowed.includes(failure_code)) throw codeError('FAILURE_CODE_INVALID');
  return {
    check_id: check.check_id,
    status,
    evidence,
    checked_at: new Date().toISOString(),
    fingerprint: meta.fingerprint ?? null,
    standards_version: meta.standards_version,
    failure_code: ['FAIL', 'NEEDS_ATTENTION'].includes(status) ? failure_code : null,
    next_action,
  };
}

export function stageRunStatus(items) {
  return items.every((i) => i.status === 'PASS' || i.status === 'NOT_APPLICABLE') ? 'IN_PROGRESS' : 'BLOCKED';
}

// 새 파일만 만든다. 같은 이름이 있으면 실패하고 기존 파일을 건드리지 않는다.
// 임시 파일에 먼저 쓰고 hard link로 원자적으로 게시하므로 부분 작성 파일이 결과 이름으로 보이지 않는다.
export function writeNoClobber(dir, name, content) {
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.linkSync(tmp, target);
  } catch (e) {
    if (e.code === 'EEXIST') throw codeError('RESULT_FILE_EXISTS');
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return target;
}

// 기존 파일을 원자적으로 교체한다. 임시 파일에 먼저 쓰고 rename하므로 실패해도 원본이 보존된다.
export function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// 정상 결과로 인정되는 단계 결과만 반환 (JSON 파싱 가능 + complete === true + items 배열).
export function readStageResult(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && v.complete === true && Array.isArray(v.items)) return v;
  } catch {
    // 부분 작성·손상 파일은 인정하지 않는다
  }
  return null;
}

export function listAttempts(dir, prefix) {
  const re = new RegExp(`^${prefix.replace(/[.]/g, '\\.')}\\.a(\\d+)\\.json$`);
  return fs.readdirSync(dir)
    .map((n) => ({ name: n, m: re.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, attempt: Number(x.m[1]) }))
    .sort((a, b) => a.attempt - b.attempt);
}
