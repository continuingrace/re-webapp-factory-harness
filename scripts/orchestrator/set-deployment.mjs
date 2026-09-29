// 배포 기록: node scripts/orchestrator/set-deployment.mjs <run_dir> <operating_url> --statement-file <path>
// input.json은 바꾸지 않고 run.json.deployment에 append한다. 현재 상태와 맞지 않으면 기록하지 않는다.
import path from 'node:path';
import { getCheck, loadChecks } from '../lib/checks.mjs';
import { operatingUrlViolation } from '../lib/url-shape.mjs';
import { resolveRunDir } from '../lib/paths.mjs';
import { writeAtomic } from '../lib/result.mjs';
import { currentFingerprint, latestValidResult, readRunState } from '../lib/run-state.mjs';
import { ROOT, fail, nowIso, out, readStatement } from './common.mjs';

function main() {
  const [runDirArg, url] = process.argv.slice(2);
  const statement = readStatement(process.argv);
  try {
    new URL(url);
  } catch {
    fail('URL_INVALID');
  }
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) fail('CHECKS_INVALID');
  const shape = operatingUrlViolation(url, getCheck(data, 'PD-01').rule);
  if (shape) fail(shape);
  const rd = resolveRunDir(ROOT, runDirArg);
  if (!rd.ok) fail(rd.code);
  const state = readRunState(rd.dir);
  if (!state.ok) fail(state.code);
  const fingerprint = currentFingerprint(state.input, data);
  const s3 = latestValidResult(rd.dir, '03-browser').value;
  if (!fingerprint || !s3 || s3.run_status !== 'AWAITING_DEPLOYMENT' || s3.fingerprint !== fingerprint
    || s3.standards_version !== data.standards_version) fail('STATE_MISMATCH');

  const list = state.run.deployment;
  const entry = {
    deployment_id: `d${list.length + 1}`,
    release_phase: 'postdeploy',
    operating_url: url,
    recorded_at: nowIso(),
    statement,
    fingerprint,
    target_version: state.input.target_version,
  };
  const run = { ...state.run, deployment: [...list, entry], status: 'IN_PROGRESS', updated_at: nowIso() };
  writeAtomic(path.join(rd.dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  return out({ recorded: true, deployment_id: entry.deployment_id, run_status: 'IN_PROGRESS' });
}

try {
  main();
} catch (e) {
  out({ recorded: false, run_status: 'BLOCKED', error_code: e.code || 'SET_DEPLOYMENT_ERROR' }, 1);
}
