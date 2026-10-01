// 사람이 읽는 실행 요약: node scripts/orchestrator/report-run.mjs <run_dir>
// 공식 JSON(input·run·approvals·단계 결과·closure)을 읽기만 하고 runs/<slug>/<run_id>/report.md를 만든다(파생 문서, 판정 근거 아님).
// 원본이 없거나 손상됐거나 닫기 기록 무결성이 맞지 않으면 보고서를 만들지 않는다(부분 보고서 없음).
// 같은 원본이면 같은 결과: UTF-8, LF, 생성 시각 없음, 정렬 고정. 앱 절대경로·사용자 원문·evidence 원문·local 설정 값·
// URL의 사용자정보·경로·query·fragment는 넣지 않는다. 규칙: checks.json policies.run_report.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadChecks } from '../lib/checks.mjs';
import { CLOSURE_FILE, readClosure } from '../lib/closure.mjs';
import { readRunJson, resolveRunDir } from '../lib/paths.mjs';
import { listAttempts, readStageResult, writeAtomic } from '../lib/result.mjs';
import { ROOT, fail, out } from './common.mjs';

export const REPORT_FILE = 'report.md';
const STAGES = [['01-intake', 1], ['02-static', 2], ['03-browser', 3], ['04-production', 4]];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// 표 칸에 들어갈 값: 줄바꿈·파이프를 없애 표 구조를 지킨다.
const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/[\r\n]+/g, ' ').replace(/\|/g, '/'));
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 운영 URL은 scheme과 host만 남긴다 (사용자정보·경로·query·fragment 제거).
export function safeOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(해석 불가)';
  }
}

function readJsonStrict(runDir, name) {
  const r = readRunJson(runDir, name);
  if (!r.ok) fail(r.code === 'RUN_FILE_MISSING' ? 'REPORT_SOURCE_MISSING' : 'REPORT_SOURCE_INVALID');
  return r.value;
}

// 단계 결과: 시도 파일이 하나라도 손상됐으면 보고서를 만들지 않는다.
function stageResults(runDir) {
  const out = [];
  for (const [prefix, stage] of STAGES) {
    const attempts = listAttempts(runDir, prefix);
    for (const a of attempts) if (!readStageResult(path.join(runDir, a.name))) fail('REPORT_SOURCE_INVALID');
    const last = attempts[attempts.length - 1];
    if (last) out.push({ stage, file: last.name, attempts: attempts.length, value: readStageResult(path.join(runDir, last.name)) });
  }
  const releases = listAttempts(runDir, '05-release');
  let release = null;
  for (const a of releases) {
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(runDir, a.name), 'utf8')); } catch { fail('REPORT_SOURCE_INVALID'); }
    if (!v || v.complete !== true || !v.verdict) fail('REPORT_SOURCE_INVALID');
    release = { file: a.name, attempts: releases.length, value: v };
  }
  return { stages: out, release };
}

// 보고서에 쓰는 원본 파일과 해시 (report.md 자체 제외). 보고서가 오래됐는지 확인하는 용도.
function sourceHashes(runDir) {
  const names = fs.readdirSync(runDir).filter((n) => n === CLOSURE_FILE || ['input.json', 'run.json', 'approvals.json'].includes(n) || /^0[1-5]-[a-z]+\.a\d+\.json$/.test(n));
  return names.sort(byName).map((n) => ({ path: n, sha256: sha256(fs.readFileSync(path.join(runDir, n))) }));
}

export function buildReport(runDir, checksData) {
  const closure = readClosure(runDir);
  if (closure.state === 'INVALID') fail(closure.code);
  const input = readJsonStrict(runDir, 'input.json');
  const run = readJsonStrict(runDir, 'run.json');
  const approvals = readJsonStrict(runDir, 'approvals.json');
  if (!Array.isArray(approvals) || !Array.isArray(run.deployment) || typeof run.run_id !== 'string') fail('REPORT_SOURCE_INVALID');
  const { stages, release } = stageResults(runDir);
  const policy = checksData.policies.run_report;
  const runLabel = (s) => `${s} (${policy.run_status_labels[s] || '알 수 없음'})`;
  const itemLabel = (s) => `${s} (${policy.item_status_labels[s] || '알 수 없음'})`;
  const closed = closure.state === 'CLOSED' ? closure.value : null;
  const status = closed ? closed.status : run.status;
  const lastStage = stages[stages.length - 1];
  const recordedVersion = lastStage ? lastStage.value.standards_version : null;
  const deployments = run.deployment;
  const current = deployments[deployments.length - 1] || null;

  const L = [];
  L.push(`# 실행 요약 보고서 — ${run.run_id}`, '');
  L.push('> **파생 문서입니다. 판정 근거가 아닙니다.** 공식 기록은 실행 폴더의 JSON 파일(`run.json`·`approvals.json`·단계 결과·`closure.json`)이며, 이 보고서는 그 내용을 사람이 읽기 쉽게 옮긴 것입니다.');
  L.push('> 같은 원본 파일이면 같은 내용으로 다시 만들어집니다. 앱 경로·사용자 원문·evidence 원문·설정 값은 넣지 않습니다.', '');

  L.push('## 1. 실행', '', '| 항목 | 값 |', '|---|---|');
  L.push(`| run_id | ${cell(run.run_id)} |`, `| app_slug | ${cell(run.app_slug)} |`, `| 목표 버전 | ${cell(input.target_version)} |`);
  L.push(`| 릴리스 단계 | ${cell(current ? current.release_phase : input.release_phase)} |`);
  L.push(`| 실행 상태 | ${cell(runLabel(status))} |`);
  L.push(`| 결과에 기록된 standards_version | ${cell(recordedVersion)} |`);
  L.push(`| 현재 standards_version | ${cell(checksData.standards_version)}${recordedVersion && recordedVersion !== checksData.standards_version ? ' (결과와 다름)' : ''} |`, '');

  if (closed) {
    L.push('## 2. 닫기 기록', '', '| 항목 | 값 |', '|---|---|');
    L.push(`| 상태 | ${cell(runLabel(closed.status))} |`, `| 근거 | ${cell(closed.basis)} |`, `| 대체한 실행 | ${cell(closed.superseded_by)} |`);
    L.push(`| 닫기 전 상태 | ${cell(runLabel(closed.previous_status))} |`, `| 기록 시각 | ${cell(closed.recorded_at)} |`, '| 사용자 원문 | `closure.json`에 보관 (보고서에 넣지 않음) |', '');
  }

  L.push('## 3. 단계별 결과', '', '| 단계 | 최신 결과 파일 | 시도 수 | 실행 상태 | standards_version |', '|---|---|---|---|---|');
  if (!stages.length) L.push('| — | — | 0 | — | — |');
  for (const s of stages) L.push(`| ${s.stage} | ${cell(s.file)} | ${s.attempts} | ${cell(runLabel(s.value.run_status))} | ${cell(s.value.standards_version)} |`);
  if (release) L.push(`| 5 | ${cell(release.file)} | ${release.attempts} | ${cell(runLabel(release.value.verdict.run_status))} (phase ${cell(release.value.verdict.phase)}) | — |`);
  L.push('');

  const items = stages.flatMap((s) => s.value.items.map((i) => ({ stage: s.stage, ...i })));
  items.sort((a, b) => a.stage - b.stage || byName(String(a.check_id), String(b.check_id)));
  L.push('## 4. 검사 항목 (최신 결과 기준)', '', '| 단계 | check_id | 상태 | failure_code | evidence |', '|---|---|---|---|---|');
  if (!items.length) L.push('| — | — | — | — | — |');
  for (const i of items) L.push(`| ${i.stage} | ${cell(i.check_id)} | ${cell(itemLabel(i.status))} | ${cell(i.failure_code)} | ${i.evidence ? '있음 (원문은 결과 파일)' : '없음'} |`);
  L.push('');

  L.push('## 5. 사람 승인·운영 URL 확인', '', '| 종류 | 결정 | 기록 시각 | deployment_id |', '|---|---|---|---|');
  if (!approvals.length) L.push('| — | — | — | — |');
  for (const a of approvals) L.push(`| ${cell(a.approval_type)} | ${cell(a.decision)} | ${cell(a.approved_at)} | ${cell(a.deployment_id)} |`);
  L.push('', '사용자 원문은 `approvals.json`에 보관하며 보고서에 넣지 않습니다.', '');

  L.push('## 6. 배포', '', '| deployment_id | 운영 주소 (scheme·host만) | 기록 시각 |', '|---|---|---|');
  if (!deployments.length) L.push('| — | — | — |');
  for (const d of deployments) L.push(`| ${cell(d.deployment_id)} | ${cell(safeOrigin(d.operating_url))} | ${cell(d.recorded_at)} |`);
  L.push('');

  const open = items.filter((i) => !['PASS', 'NOT_APPLICABLE'].includes(i.status)).map((i) => i.check_id);
  const next = closed || status === 'COMPLETE' ? '없음' : status === 'AWAITING_DEPLOYMENT' ? `배포했어 ${run.run_id} <url>` : '공식 판정(gate-judge·record-judgement)으로 확인 — 이 보고서는 판단하지 않음';
  L.push('## 7. 미해결 항목과 다음 문장', '', `- 미해결 항목: ${open.length ? [...new Set(open)].join(', ') : '없음'}`, `- 다음에 필요한 사용자 문장: ${next}`, '');

  // 비차단 진단 (판정·완료에 영향 없음): MB-08 측정에 함께 기록된 컨테이너별 세로 간격 종류 수
  const mb08 = items.find((i) => i.check_id === 'MB-08');
  const variety = mb08 && mb08.evidence && mb08.evidence.raw && Array.isArray(mb08.evidence.raw.spacing_variety) ? mb08.evidence.raw.spacing_variety : null;
  if (variety && variety.length) {
    L.push('## 7-1. 비차단 진단 — 컨테이너별 세로 간격 종류', '', '판정 근거가 아닙니다. 여백의 편안함·묶음·균형은 사람 검수(HA-01)가 판단합니다.', '', '| 컨테이너 | 간격(px) | 종류 수 |', '|---|---|---|');
    for (const v of variety.slice(0, 20)) L.push(`| ${cell(v.container)} | ${cell((v.gaps || []).join(', '))} | ${cell(v.distinct)} |`);
    L.push('');
  }

  L.push('## 8. 원본 파일', '', '| 파일 | sha256 |', '|---|---|');
  for (const f of sourceHashes(runDir)) L.push(`| ${f.path} | ${f.sha256} |`);
  L.push('');
  return `${L.join('\n')}`;
}

function main() {
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) fail('CHECKS_INVALID');
  const rd = resolveRunDir(ROOT, process.argv[2]);
  if (!rd.ok) fail(rd.code);
  const target = path.join(rd.dir, REPORT_FILE);
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) fail('REPORT_TARGET_INVALID');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const content = buildReport(rd.dir, data);
  writeAtomic(target, content);
  return out({ written: REPORT_FILE, sha256: sha256(Buffer.from(content, 'utf8')) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    out({ written: null, error_code: e.code || 'REPORT_ERROR' }, 1);
  }
}
