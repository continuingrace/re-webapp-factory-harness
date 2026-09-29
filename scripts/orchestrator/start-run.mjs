// 신규 실행: node scripts/orchestrator/start-run.mjs <input.json 경로>
// 접수(IN-01)를 통과한 경우에만 run_id와 실행 폴더를 만들고 input.json·run.json·01-intake.a1.json을 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { loadChecks } from '../lib/checks.mjs';
import { writeNoClobber } from '../lib/result.mjs';
import { judgeIntake } from '../stages/stage1-intake.mjs';
import { ROOT, fail, kstRunId, nowIso, out } from './common.mjs';

function main() {
  const file = process.argv[2];
  if (!file) fail('INPUT_FILE_REQUIRED');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) fail('CHECKS_INVALID');
  const intake = judgeIntake({ root: ROOT, checksData: data, input });
  if (intake.run_status !== 'IN_PROGRESS') return out({ created: false, run_status: intake.run_status, intake: intake.items[0] }, 1);

  const runId = kstRunId();
  const slugDir = path.join(ROOT, 'runs', intake.app_slug);
  fs.mkdirSync(slugDir, { recursive: true });
  const runDir = path.join(slugDir, runId);
  fs.mkdirSync(runDir);
  const stored = {
    ...input,
    app_slug: intake.app_slug,
    app_slug_source: intake.app_slug_source,
    app_path_canonical: intake.app_path_canonical,
  };
  writeNoClobber(runDir, 'input.json', `${JSON.stringify(stored, null, 2)}\n`);
  writeNoClobber(runDir, '01-intake.a1.json', `${JSON.stringify({ ...intake, attempt: 1, complete: true }, null, 2)}\n`);
  writeNoClobber(runDir, 'approvals.json', '[]\n');
  writeNoClobber(runDir, 'run.json', `${JSON.stringify({
    run_id: runId,
    app_slug: intake.app_slug,
    status: 'IN_PROGRESS',
    created_at: nowIso(),
    deployment: [],
    pre_record_authorizations: [],
    conflicts: [],
    judgements: [],
  }, null, 2)}\n`);
  return out({ created: true, run_id: runId, run_dir: path.relative(ROOT, runDir).replace(/\\/g, '/'), run_status: 'IN_PROGRESS' });
}

try {
  main();
} catch (e) {
  out({ created: false, error_code: e.code || 'START_RUN_ERROR' }, 1);
}
