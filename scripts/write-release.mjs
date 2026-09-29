// release-recorder: node scripts/write-release.mjs <run_dir>
// 실행 상태가 AWAITING_APPROVAL이고 가장 최근 pre_record 허가가 현재 결합값과 일치할 때만
// releases/<slug>/v<x.y.z>.md를 exclusive create로 새로 만든다. 실행 상태는 바꾸지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChecks } from './lib/checks.mjs';
import { computeJudgement } from './lib/judge-core.mjs';
import { resolveRunDir } from './lib/paths.mjs';
import { currentBinding, currentFingerprint, readRunState, releaseFileState, releasePath, sameBinding } from './lib/run-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function out(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exitCode = code;
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function ensureRealDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) fail('RELEASE_DIR_IS_LINK');
}

function main() {
  const rd = resolveRunDir(ROOT, process.argv[2]);
  if (!rd.ok) fail(rd.code);
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) fail('CHECKS_INVALID');
  const state = readRunState(rd.dir);
  if (!state.ok) fail(state.code);
  if (state.run.status !== 'AWAITING_APPROVAL') fail('RUN_STATUS_NOT_READY');
  const fingerprint = currentFingerprint(state.input, data);
  const binding = currentBinding({ run: state.run, input: state.input, fingerprint, checksData: data });
  const auths = state.run.pre_record_authorizations || [];
  const latest = auths[auths.length - 1];
  if (!latest || latest.release_record_allowed !== true) fail('NO_PRE_RECORD_AUTHORIZATION');
  if (!sameBinding(latest.binding, binding)) fail('PRE_RECORD_AUTHORIZATION_STALE');

  const file = releasePath(ROOT, state.run.app_slug, state.input.target_version);
  if (!file) fail('RELEASE_PATH_INVALID');
  if (releaseFileState(file).state !== 'ABSENT') fail('RELEASE_RECORD_EXISTS');
  ensureRealDir(path.join(ROOT, 'releases'));
  ensureRealDir(path.dirname(file));

  const record = { ...binding, recorded_at: new Date().toISOString() };
  const approvals = state.approvals.map((a) => `- ${a.approval_type}: ${a.decision} (${a.approved_at})`).join('\n');
  const body = [
    `# ${binding.app_slug} v${binding.target_version} 릴리스 기록`,
    '',
    '```json release-record',
    JSON.stringify(record, null, 2),
    '```',
    '',
    '## 변경 요약',
    '',
    String(state.input.change_summary),
    '',
    '## 승인 기록',
    '',
    approvals || '- 없음',
    '',
  ].join('\n');

  // 파일을 만들기 직전에 현재 run·fingerprint·목표 버전·운영 URL·approvals로 pre_record 조건을 다시 계산한다.
  // 허가 이후 거절이나 다른 변경이 생겼으면 만들지 않는다. 재계산과 exclusive create 사이에 다른 작업을 두지 않는다.
  const now = computeJudgement(ROOT, rd.dir);
  const v = now.verdict || {};
  if (v.phase !== 'pre_record' || v.release_record_allowed !== true) fail('PRE_RECORD_CONDITION_UNMET');
  if (!now.stage5 || !sameBinding(now.stage5.binding, latest.binding)) fail('PRE_RECORD_AUTHORIZATION_STALE');
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') fail('RELEASE_RECORD_EXISTS');
    throw e;
  }
  return out({ written: path.relative(ROOT, file).replace(/\\/g, '/') });
}

try {
  main();
} catch (e) {
  out({ written: null, error_code: e.code || 'WRITE_RELEASE_ERROR' }, 1);
}
