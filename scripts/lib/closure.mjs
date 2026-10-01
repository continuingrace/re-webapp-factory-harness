// 실행 닫기 기록 closure.json (CANCELLED·SUPERSEDED). 한 번만 만들고 바꾸지 않는다. 기존 실행 파일은 건드리지 않는다.
// 규칙은 checks.json policies.run_closure에 있다. 닫힌 실행은 다시 열거나 진행할 수 없다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isInside } from './paths.mjs';

export const CLOSURE_FILE = 'closure.json';
export const CLOSED_STATUSES = ['CANCELLED', 'SUPERSEDED'];
export const KINDS = {
  cancel: { status: 'CANCELLED', basis: ['USER_CANCEL'] },
  supersede: { status: 'SUPERSEDED', basis: ['STANDARDS_CHANGED', 'REPLACED_BY_RUN'] },
};
const RUN_ID = /^\d{8}-\d{6}-KST-[0-9a-f]{6}$/;
const STAGE_RESULT = /^0[1-5]-[a-z]+\.a\d+\.json$/;
const INTEGRITY_ROOT_FILES = ['input.json', 'run.json', 'approvals.json'];
// 파생물과 닫기 기록 자체는 불변성 해시 대상이 아니다.
export const INTEGRITY_EXCLUDED = [CLOSURE_FILE, 'report.md'];

const codeErr = (code) => Object.assign(new Error(code), { code });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// 불변성 해시 대상: input.json·run.json·approvals.json·단계 결과(0N-*.aN.json)·evidence/ 아래 파일.
// 대상도 제외 목록도 아닌 파일, link, 특수 파일이 있으면 실패한다(조용히 건너뛰지 않음).
export function integrityFiles(runDir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) throw codeErr('CLOSURE_LINK_IN_RUN');
      if (st.isDirectory()) {
        if (r !== 'evidence' && !r.startsWith('evidence/')) throw codeErr('CLOSURE_UNEXPECTED_FILE');
        walk(a, r);
        continue;
      }
      if (!st.isFile()) throw codeErr('CLOSURE_UNEXPECTED_FILE');
      if (!rel && INTEGRITY_EXCLUDED.includes(name)) continue;
      if (rel.startsWith('evidence') || (!rel && (INTEGRITY_ROOT_FILES.includes(name) || STAGE_RESULT.test(name)))) {
        out.push({ path: r, sha256: sha256(fs.readFileSync(a)) });
        continue;
      }
      throw codeErr('CLOSURE_UNEXPECTED_FILE');
    }
  };
  walk(runDir, '');
  return out;
}

function validShape(c) {
  if (!c || typeof c !== 'object' || c.schema_version !== '1.0.0') return false;
  const kind = KINDS[c.kind];
  if (!kind || c.status !== kind.status || !kind.basis.includes(c.basis)) return false;
  if (!RUN_ID.test(c.run_id) || typeof c.app_slug !== 'string' || typeof c.statement !== 'string' || c.statement.trim() === '') return false;
  if (c.kind === 'cancel' && c.superseded_by !== null) return false;
  if (c.basis === 'REPLACED_BY_RUN' && !RUN_ID.test(c.superseded_by || '')) return false;
  if (c.superseded_by !== null && (!RUN_ID.test(c.superseded_by) || c.superseded_by === c.run_id)) return false;
  if (!Array.isArray(c.files) || c.files.some((f) => !f || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256))) return false;
  return typeof c.recorded_at === 'string' && typeof c.previous_status === 'string';
}

// 반환: { state: 'OPEN' } | { state: 'CLOSED', value } | { state: 'INVALID', code }
// 닫기 기록이 깨졌거나, 기록 뒤 기존 실행 파일이 바뀌었으면 INVALID(→ BLOCKED)다.
export function readClosure(runDir) {
  const file = path.join(runDir, CLOSURE_FILE);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? { state: 'OPEN' } : { state: 'INVALID', code: 'CLOSURE_UNREADABLE' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { state: 'INVALID', code: 'CLOSURE_INVALID' };
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { state: 'INVALID', code: 'CLOSURE_INVALID' }; }
  if (!validShape(value)) return { state: 'INVALID', code: 'CLOSURE_INVALID' };
  let now;
  try { now = integrityFiles(runDir); } catch (e) { return { state: 'INVALID', code: e.code || 'CLOSURE_INTEGRITY_MISMATCH' }; }
  if (JSON.stringify(now) !== JSON.stringify(value.files)) return { state: 'INVALID', code: 'CLOSURE_INTEGRITY_MISMATCH' };
  return { state: 'CLOSED', value };
}

// 같은 app_slug의 다른 실행 폴더(존재·열린 상태)인지 확인한다.
export function replacementRunValid(runDir, closure) {
  const target = path.join(path.dirname(runDir), closure.superseded_by);
  if (!isInside(path.dirname(runDir), target) || !fs.existsSync(path.join(target, 'run.json'))) return 'SUPERSEDED_BY_NOT_FOUND';
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(target, 'run.json'), 'utf8')); } catch { return 'SUPERSEDED_BY_INVALID'; }
  if (run.app_slug !== closure.app_slug || run.run_id !== closure.superseded_by) return 'SUPERSEDED_BY_OTHER_APP';
  if (readClosure(target).state !== 'OPEN') return 'SUPERSEDED_BY_CLOSED';
  return null;
}
