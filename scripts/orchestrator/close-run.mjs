// 실행 닫기: node scripts/orchestrator/close-run.mjs <run_dir> <cancel|supersede> <basis> --statement-file <path> [--superseded-by <run_id>]
//   cancel    → CANCELLED, basis USER_CANCEL, --superseded-by 금지
//   supersede → SUPERSEDED, basis STANDARDS_CHANGED(실행 결과의 standards_version이 현재와 다름) 또는
//               REPLACED_BY_RUN(--superseded-by 필수, 같은 app_slug의 존재하는 열린 실행)
// 실행 폴더에 closure.json 하나만 exclusive create로 만든다. 기존 실행 파일과 사용자 원문 파일은 바꾸거나 지우지 않는다.
// COMPLETE이거나 이미 닫힌 실행은 닫을 수 없다. 사용자 원문은 출력하지 않는다.
import { loadChecks } from '../lib/checks.mjs';
import { CLOSED_STATUSES, CLOSURE_FILE, KINDS, integrityFiles, readClosure, replacementRunValid } from '../lib/closure.mjs';
import { readRunJson, resolveRunDir } from '../lib/paths.mjs';
import { writeNoClobber } from '../lib/result.mjs';
import { latestValidResult } from '../lib/run-state.mjs';
import { ROOT, fail, nowIso, out, readStatement } from './common.mjs';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// 실행 결과가 기록된 standards_version: 가장 뒤 단계의 최신 유효 결과 기준.
function runStandardsVersion(runDir) {
  for (const prefix of ['04-production', '03-browser', '02-static', '01-intake']) {
    const r = latestValidResult(runDir, prefix);
    if (r.value && typeof r.value.standards_version === 'string') return r.value.standards_version;
  }
  return null;
}

function main() {
  const [runDirArg, kindArg, basis] = process.argv.slice(2);
  const kind = KINDS[kindArg];
  if (!kind) fail('CLOSE_KIND_INVALID');
  if (!kind.basis.includes(basis)) fail('CLOSE_BASIS_INVALID');
  const supersededBy = process.argv.includes('--superseded-by') ? argValue('--superseded-by') : null;
  if (process.argv.includes('--superseded-by') && !supersededBy) fail('SUPERSEDED_BY_REQUIRED');
  if (kindArg === 'cancel' && supersededBy !== null) fail('SUPERSEDED_BY_NOT_ALLOWED');
  if (basis === 'REPLACED_BY_RUN' && !supersededBy) fail('SUPERSEDED_BY_REQUIRED');
  if (supersededBy !== null && !/^\d{8}-\d{6}-KST-[0-9a-f]{6}$/.test(supersededBy)) fail('SUPERSEDED_BY_INVALID');
  const statement = readStatement(process.argv);

  const { data, errors } = loadChecks(ROOT);
  if (errors.length) fail('CHECKS_INVALID');
  const rd = resolveRunDir(ROOT, runDirArg);
  if (!rd.ok) fail(rd.code);
  const existing = readClosure(rd.dir);
  if (existing.state === 'CLOSED') fail('RUN_ALREADY_CLOSED');
  if (existing.state === 'INVALID') fail(existing.code);
  const run = readRunJson(rd.dir, 'run.json');
  if (!run.ok) fail(run.code);
  const input = readRunJson(rd.dir, 'input.json');
  if (!input.ok) fail(input.code);
  if (run.value.status === 'COMPLETE') fail('RUN_COMPLETE_CANNOT_CLOSE');
  if (CLOSED_STATUSES.includes(run.value.status)) fail('RUN_ALREADY_CLOSED');
  if (supersededBy !== null && supersededBy === run.value.run_id) fail('SUPERSEDED_BY_SELF');

  const runVersion = runStandardsVersion(rd.dir);
  if (basis === 'STANDARDS_CHANGED' && (!runVersion || runVersion === data.standards_version)) fail('STANDARDS_NOT_CHANGED');
  const closure = {
    schema_version: '1.0.0',
    run_id: run.value.run_id,
    app_slug: run.value.app_slug,
    status: kind.status,
    kind: kindArg,
    basis,
    superseded_by: supersededBy,
    previous_status: run.value.status,
    run_standards_version: runVersion,
    current_standards_version: data.standards_version,
    statement,
    recorded_at: nowIso(),
    files: integrityFiles(rd.dir),
  };
  if (supersededBy !== null) {
    const bad = replacementRunValid(rd.dir, closure);
    if (bad) fail(bad);
  }
  writeNoClobber(rd.dir, CLOSURE_FILE, `${JSON.stringify(closure, null, 2)}\n`);
  const check = readClosure(rd.dir);
  if (check.state !== 'CLOSED') fail(check.code || 'CLOSURE_INVALID');
  return out({ recorded: true, run_status: kind.status, basis, superseded_by: supersededBy });
}

try {
  main();
} catch (e) {
  out({ recorded: false, error_code: e.code || 'CLOSE_RUN_ERROR' }, 1);
}
