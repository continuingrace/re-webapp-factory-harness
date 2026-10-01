// Markdown 실행 요약 보고서: 공식 JSON을 바꾸지 않는 파생 문서. 결정적 출력, 민감 값 비포함, 원본 손상 시 실패.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, goodInput, makeHarnessCopy, runNode, snapshot, withTemp, writeFiles } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { readClosure } from '../../scripts/lib/closure.mjs';
import { safeOrigin } from '../../scripts/orchestrator/report-run.mjs';

const { data } = loadChecks(REPO);
const SLUG = 'sample-app';
const RUN = '20260930-090000-KST-aaa111';
// 보고서에 나오면 안 되는 표식 (런타임 결합)
const STMT = ['사용자', '원문', 'rpt-stmt-7k'].join(' ');
const EVIDENCE = ['evidence', 'body', 'rpt-ev-4m'].join('-');
const URL_SECRET = ['user', 'pw'].join(':');
const OP_URL = `https://${URL_SECRET}@ops.sample.example:8443/private/path?token=rpt-q-2x#frag`;

function makeRunDir(root, { status = 'AWAITING_APPROVAL', version = data.standards_version } = {}) {
  const dir = path.join(root, 'runs', SLUG, RUN);
  const item = (id, st, ev = null, fc = null) => ({ check_id: id, status: st, failure_code: fc, evidence: ev });
  const result = (stage, items) => JSON.stringify({ stage, run_status: status, standards_version: version, items, attempt: 1, complete: true });
  writeFiles(dir, {
    'input.json': JSON.stringify({ ...goodInput(path.join(root, 'secret-app-dir')), app_path_canonical: path.join(root, 'secret-app-dir') }),
    'run.json': JSON.stringify({
      run_id: RUN, app_slug: SLUG, status, created_at: '2026-09-30T00:00:00.000Z',
      deployment: [{ deployment_id: 'd1', release_phase: 'postdeploy', operating_url: OP_URL, recorded_at: '2026-09-30T01:00:00.000Z', statement: STMT, fingerprint: 'fp', target_version: '1.0.0' }],
      pre_record_authorizations: [], conflicts: [], judgements: [],
    }),
    'approvals.json': JSON.stringify([{ approval_type: 'MOBILE_DEVICE_REVIEW', decision: 'APPROVE', statement: STMT, approved_at: '2026-09-30T02:00:00.000Z', deployment_id: 'd1' }]),
    '01-intake.a1.json': result(1, [item('IN-01', 'PASS')]),
    '02-static.a1.json': result(2, [item('ST-03', 'PASS'), item('DS-01', 'FAIL', { text: EVIDENCE }, 'DESIGN_LETTER_SPACING')]),
    '02-static.a2.json': result(2, [item('ST-03', 'PASS'), item('DS-01', 'PASS', { text: EVIDENCE })]),
    '03-browser.a1.json': result(3, [item('MB-01', 'NEEDS_ATTENTION', null, 'CHECK_INCONCLUSIVE'), item('FA-01', 'PASS', { console: EVIDENCE })]),
    'evidence/03-browser.a1/console.json': JSON.stringify([EVIDENCE]),
  });
  return dir;
}

const report = (root, dir) => {
  const r = runNode(path.join(root, 'scripts', 'orchestrator', 'report-run.mjs'), [dir]);
  return { ...JSON.parse(r.stdout), status: r.status, text: r.stdout + r.stderr };
};
const officialSnapshot = (dir) => Object.fromEntries(Object.entries(snapshot(dir)).filter(([k]) => k !== 'report.md'));

test('report-run: 파생 문서 표시와 주요 내용을 담고, 공식 JSON은 바꾸지 않는다', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const dir = makeRunDir(root);
  const before = officialSnapshot(dir);
  const r = report(root, dir);
  assert.equal(r.status, 0, r.text);
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.ok(md.startsWith(`# 실행 요약 보고서 — ${RUN}\n\n> **파생 문서입니다. 판정 근거가 아닙니다.**`));
  for (const s of ['| 실행 상태 | AWAITING_APPROVAL (승인 대기) |', '| 2 | 02-static.a2.json | 2 |', '| 3 | MB-01 | NEEDS_ATTENTION (확인 필요) | CHECK_INCONCLUSIVE | 없음 |',
    '| 2 | DS-01 | PASS (통과) | — | 있음 (원문은 결과 파일) |', '| MOBILE_DEVICE_REVIEW | APPROVE |', '| d1 | https://ops.sample.example:8443 |', '- 미해결 항목: MB-01']) {
    assert.ok(md.includes(s), s);
  }
  assert.deepEqual(officialSnapshot(dir), before, '공식 파일 불변');
}));

test('report-run: 절대경로·사용자 원문·evidence 원문·URL 사용자정보·경로·query·local 설정 값이 없다', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const dir = makeRunDir(root);
  const r = report(root, dir);
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  for (const bad of ['rpt-stmt-7k', 'rpt-ev-4m', URL_SECRET, '/private/path', 'rpt-q-2x', '#frag', 'secret-app-dir', root, root.replace(/\\/g, '/'), 'fixture-foreign-brand', 'fxword']) {
    assert.ok(!md.includes(bad) && !r.text.includes(bad), bad);
  }
  assert.ok(!/(?<![A-Za-z])[A-Za-z]:[\\/]/.test(md), '드라이브 절대경로 없음');
  assert.equal(safeOrigin('https://a:b@h.example/p?q=1#f'), 'https://h.example');
  assert.equal(safeOrigin('not a url'), '(해석 불가)');
}));

test('report-run: 같은 원본이면 같은 바이트(UTF-8·LF), 다시 만들어도 closure 무결성 유지', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const dir = makeRunDir(root, { status: 'AWAITING_DEPLOYMENT', version: '1.6.0' });
  const stmt = path.join(t, 'stmt.txt');
  fs.writeFileSync(stmt, STMT);
  const c = runNode(path.join(root, 'scripts', 'orchestrator', 'close-run.mjs'), [dir, 'supersede', 'STANDARDS_CHANGED', '--statement-file', stmt]);
  assert.equal(c.status, 0, c.stdout);
  const first = report(root, dir);
  const a = fs.readFileSync(path.join(dir, 'report.md'));
  const second = report(root, dir);
  const b = fs.readFileSync(path.join(dir, 'report.md'));
  assert.equal(first.sha256, second.sha256);
  assert.ok(a.equals(b));
  const text = a.toString('utf8');
  assert.ok(!text.includes('\r'), 'LF만');
  assert.ok(Buffer.from(text, 'utf8').equals(a), 'UTF-8');
  assert.ok(text.includes('| 실행 상태 | SUPERSEDED (폐기(대체됨)) |') && text.includes('| 근거 | STANDARDS_CHANGED |') && text.includes('(결과와 다름)'));
  assert.ok(text.includes('- 다음에 필요한 사용자 문장: 없음'));
  assert.ok(!text.includes('rpt-stmt-7k'));
  assert.equal(readClosure(dir).state, 'CLOSED', 'report.md 재생성 뒤에도 closure 무결성 유지');
}));

test('report-run: 원본이 없거나 손상됐거나 closure 무결성이 맞지 않으면 보고서를 만들지 않는다 (부분 보고서 없음)', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const cases = [
    ['run.json 손상', (d) => fs.writeFileSync(path.join(d, 'run.json'), '{ broken'), 'REPORT_SOURCE_INVALID'],
    ['approvals.json 없음', (d) => fs.rmSync(path.join(d, 'approvals.json')), 'REPORT_SOURCE_MISSING'],
    ['이전 시도 손상', (d) => fs.writeFileSync(path.join(d, '02-static.a1.json'), '{'), 'REPORT_SOURCE_INVALID'],
    ['closure 무결성 불일치', (d) => {
      const stmt = path.join(t, 's.txt');
      fs.writeFileSync(stmt, STMT);
      runNode(path.join(root, 'scripts', 'orchestrator', 'close-run.mjs'), [d, 'cancel', 'USER_CANCEL', '--statement-file', stmt]);
      fs.appendFileSync(path.join(d, 'input.json'), ' ');
    }, 'CLOSURE_INTEGRITY_MISMATCH'],
  ];
  for (const [name, breakIt, code] of cases) {
    const dir = makeRunDir(root);
    breakIt(dir);
    const r = report(root, dir);
    assert.equal(r.error_code, code, name);
    assert.ok(!fs.existsSync(path.join(dir, 'report.md')), `${name}: 보고서 없음`);
    assert.ok(!fs.readdirSync(dir).some((n) => n.includes('report.md')), `${name}: 임시 파일 없음`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('report-run: 기존 report.md가 link면 거부하고, 저장소 밖 실행 폴더는 거부한다', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const dir = makeRunDir(root);
  fs.mkdirSync(path.join(t, 'elsewhere'));
  fs.symlinkSync(path.join(t, 'elsewhere'), path.join(dir, 'report.md'), 'junction');
  assert.equal(report(root, dir).error_code, 'REPORT_TARGET_INVALID');
  fs.unlinkSync(path.join(dir, 'report.md'));
  assert.equal(report(root, path.join(t, 'elsewhere')).error_code, 'RUN_DIR_OUTSIDE_RUNS');
}));

test('checks.json: run_report 정책 (파생·제외 항목·라벨)', () => {
  const p = data.policies.run_report;
  assert.equal(p.authoritative, false);
  assert.ok(p.excluded.length >= 5);
  for (const s of ['IN_PROGRESS', 'AWAITING_APPROVAL', 'AWAITING_DEPLOYMENT', 'COMPLETE', 'BLOCKED', 'CANCELLED', 'SUPERSEDED']) assert.ok(p.run_status_labels[s], s);
});
