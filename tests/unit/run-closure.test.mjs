// 실행 닫기(CANCELLED·SUPERSEDED): closure.json만 새로 만들고 기존 실행 파일은 바꾸지 않는다. 닫힌 실행은 진행할 수 없다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, goodInput, makeHarnessCopy, runNode, snapshot, withTemp, writeFiles } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { readClosure } from '../../scripts/lib/closure.mjs';
import { Deny, decide } from '../../scripts/hook-guard.mjs';

const { data } = loadChecks(REPO);
const SLUG = 'sample-app';
const OLD = '20260930-090000-KST-aaa111';
const NEW = '20261001-090000-KST-bbb222';
const OTHER = '20261001-100000-KST-ccc333';
// 사용자 원문 표식 (출력에 나오면 안 됨)
const STATEMENT = ['실행 폐기', OLD, '이전 기준 실험', 'stmt-marker-9z'].join(' ');

function makeRunDir(root, runId, { status = 'AWAITING_DEPLOYMENT', version = '1.6.0', slug = SLUG, extra = {} } = {}) {
  const dir = path.join(root, 'runs', SLUG, runId);
  const result = (stage) => JSON.stringify({ stage, run_status: status, standards_version: version, items: [], attempt: 1, complete: true });
  writeFiles(dir, {
    'input.json': JSON.stringify(goodInput(path.join(root, 'app'))),
    'run.json': JSON.stringify({ run_id: runId, app_slug: slug, status, created_at: '2026-09-30T00:00:00.000Z', deployment: [], pre_record_authorizations: [], conflicts: [], judgements: [] }),
    'approvals.json': '[]\n',
    '01-intake.a1.json': result(1),
    '02-static.a1.json': result(2),
    '03-browser.a1.json': result(3),
    'evidence/03-browser.a1/console.json': '[]',
    ...extra,
  });
  return dir;
}

function setup(t) {
  const root = makeHarnessCopy(t);
  const stmt = path.join(t, 'statement.txt');
  fs.writeFileSync(stmt, STATEMENT);
  return { root, stmt };
}

const script = (root, rel) => path.join(root, 'scripts', ...rel.split('/'));
const close = (root, dir, args, stmt) => {
  const r = runNode(script(root, 'orchestrator/close-run.mjs'), [dir, ...args, ...(stmt ? ['--statement-file', stmt] : [])]);
  return { ...JSON.parse(r.stdout), status: r.status, text: r.stdout + r.stderr };
};
const withoutClosure = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => k !== 'closure.json'));

test('close-run: 취소는 CANCELLED, 기준 변경 폐기는 SUPERSEDED이며 closure.json만 새로 생기고 원문은 보존·비출력', () => withTemp((t) => {
  const { root, stmt } = setup(t);
  const a = makeRunDir(root, OLD);
  const before = snapshot(a);
  const r = close(root, a, ['supersede', 'STANDARDS_CHANGED'], stmt);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual([r.recorded, r.run_status, r.basis], [true, 'SUPERSEDED', 'STANDARDS_CHANGED']);
  assert.ok(!r.text.includes('stmt-marker-9z'));
  assert.deepEqual(withoutClosure(snapshot(a)), before, '기존 파일 바이트·수정 시각 불변');
  const c = JSON.parse(fs.readFileSync(path.join(a, 'closure.json'), 'utf8'));
  assert.equal(c.statement, STATEMENT);
  assert.deepEqual([c.status, c.kind, c.previous_status, c.run_standards_version, c.current_standards_version, c.superseded_by], ['SUPERSEDED', 'supersede', 'AWAITING_DEPLOYMENT', '1.6.0', data.standards_version, null]);
  assert.deepEqual(c.files.map((f) => f.path), ['01-intake.a1.json', '02-static.a1.json', '03-browser.a1.json', 'approvals.json', 'evidence/03-browser.a1/console.json', 'input.json', 'run.json']);
  assert.equal(fs.readFileSync(stmt, 'utf8'), STATEMENT, 'helper는 원문 파일을 지우거나 바꾸지 않음');
  assert.equal(readClosure(a).state, 'CLOSED');

  const b = makeRunDir(root, NEW, { version: data.standards_version, status: 'IN_PROGRESS' });
  const rc = close(root, b, ['cancel', 'USER_CANCEL'], stmt);
  assert.equal(rc.run_status, 'CANCELLED', rc.text);
}));

test('close-run: 조건 위반은 기록하지 않고 기존 파일·원문을 바꾸지 않는다', () => withTemp((t) => {
  const { root, stmt } = setup(t);
  const a = makeRunDir(root, OLD);
  makeRunDir(root, NEW, { version: data.standards_version });
  const before = snapshot(a);
  const cases = [
    [['cancel', 'USER_CANCEL', '--superseded-by', NEW], 'SUPERSEDED_BY_NOT_ALLOWED'],
    [['cancel', 'STANDARDS_CHANGED'], 'CLOSE_BASIS_INVALID'],
    [['supersede', 'USER_CANCEL'], 'CLOSE_BASIS_INVALID'],
    [['archive', 'USER_CANCEL'], 'CLOSE_KIND_INVALID'],
    [['supersede', 'REPLACED_BY_RUN'], 'SUPERSEDED_BY_REQUIRED'],
    [['supersede', 'REPLACED_BY_RUN', '--superseded-by', '../x'], 'SUPERSEDED_BY_INVALID'],
    [['supersede', 'REPLACED_BY_RUN', '--superseded-by', OTHER], 'SUPERSEDED_BY_NOT_FOUND'],
    [['supersede', 'REPLACED_BY_RUN', '--superseded-by', OLD], 'SUPERSEDED_BY_SELF'],
  ];
  for (const [args, code] of cases) assert.equal(close(root, a, args, stmt).error_code, code, args.join(' '));
  assert.equal(close(root, a, ['cancel', 'USER_CANCEL']).error_code, 'STATEMENT_FILE_REQUIRED');
  const empty = path.join(t, 'empty.txt');
  fs.writeFileSync(empty, '  \n');
  assert.equal(close(root, a, ['cancel', 'USER_CANCEL'], empty).error_code, 'EMPTY_STATEMENT');
  // 다른 app_slug의 실행으로는 대체할 수 없다
  makeRunDir(root, OTHER, { slug: 'other-app', version: data.standards_version });
  assert.equal(close(root, a, ['supersede', 'REPLACED_BY_RUN', '--superseded-by', OTHER], stmt).error_code, 'SUPERSEDED_BY_OTHER_APP');
  // 기준이 바뀌지 않았으면 STANDARDS_CHANGED로 폐기할 수 없다
  const same = makeRunDir(root, '20261001-110000-KST-ddd444', { version: data.standards_version });
  assert.equal(close(root, same, ['supersede', 'STANDARDS_CHANGED'], stmt).error_code, 'STANDARDS_NOT_CHANGED');
  // 목록에 없는 파일이 있으면 닫지 않는다
  const odd = makeRunDir(root, '20261001-120000-KST-eee555', { extra: { 'notes.txt': 'x' } });
  assert.equal(close(root, odd, ['cancel', 'USER_CANCEL'], stmt).error_code, 'CLOSURE_UNEXPECTED_FILE');
  assert.ok(!fs.existsSync(path.join(odd, 'closure.json')));
  assert.deepEqual(snapshot(a), before);
  assert.ok(!fs.existsSync(path.join(a, 'closure.json')));
  assert.equal(fs.readFileSync(stmt, 'utf8'), STATEMENT);
}));

test('close-run: COMPLETE·이미 닫힌 실행은 닫을 수 없고, 닫힌 실행으로 대체할 수 없다', () => withTemp((t) => {
  const { root, stmt } = setup(t);
  const done = makeRunDir(root, '20261001-130000-KST-fff666', { status: 'COMPLETE' });
  assert.equal(close(root, done, ['cancel', 'USER_CANCEL'], stmt).error_code, 'RUN_COMPLETE_CANNOT_CLOSE');
  const a = makeRunDir(root, OLD);
  const b = makeRunDir(root, NEW, { version: data.standards_version });
  assert.equal(close(root, b, ['cancel', 'USER_CANCEL'], stmt).run_status, 'CANCELLED');
  assert.equal(close(root, b, ['cancel', 'USER_CANCEL'], stmt).error_code, 'RUN_ALREADY_CLOSED');
  assert.equal(close(root, a, ['supersede', 'REPLACED_BY_RUN', '--superseded-by', NEW], stmt).error_code, 'SUPERSEDED_BY_CLOSED');
  const flagged = makeRunDir(root, '20261001-140000-KST-abc777', { status: 'CANCELLED' });
  assert.equal(close(root, flagged, ['cancel', 'USER_CANCEL'], stmt).error_code, 'RUN_ALREADY_CLOSED');
}));

test('close-run: REPLACED_BY_RUN은 같은 app_slug의 열린 실행을 superseded_by로 기록', () => withTemp((t) => {
  const { root, stmt } = setup(t);
  const a = makeRunDir(root, OLD);
  makeRunDir(root, NEW, { version: data.standards_version, status: 'IN_PROGRESS' });
  const r = close(root, a, ['supersede', 'REPLACED_BY_RUN', '--superseded-by', NEW], stmt);
  assert.equal(r.status, 0, r.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'closure.json'), 'utf8')).superseded_by, NEW);
}));

test('닫힌 실행: 진행·기록 helper는 RUN_CLOSED로 거부하고 judge는 닫힌 상태와 허가 false를 보고하며 파일은 그대로', () => withTemp((t) => {
  const { root, stmt } = setup(t);
  const a = makeRunDir(root, OLD);
  assert.equal(close(root, a, ['supersede', 'STANDARDS_CHANGED'], stmt).status, 0);
  const before = snapshot(a);
  const node = (rel, args) => {
    const r = runNode(script(root, rel), args);
    return { ...JSON.parse(r.stdout), text: r.stdout + r.stderr };
  };
  for (const stage of ['2', '3', '4']) assert.equal(node('run-stage.mjs', [stage, a]).error_code, 'RUN_CLOSED', stage);
  assert.equal(node('write-release.mjs', [a]).error_code, 'RUN_CLOSED');
  assert.equal(node('orchestrator/record-judgement.mjs', [a]).error_code, 'RUN_CLOSED');
  assert.equal(node('orchestrator/record-approval.mjs', [a, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '--statement-file', stmt]).error_code, 'RUN_CLOSED');
  assert.equal(node('orchestrator/set-deployment.mjs', [a, 'https://sample.example/', '--statement-file', stmt]).error_code, 'RUN_CLOSED');
  const j = node('judge.mjs', [a]);
  assert.deepEqual(j.verdict, { run_status: 'SUPERSEDED', phase: null, release_record_allowed: false, complete_allowed: false });
  assert.equal(j.closure.basis, 'STANDARDS_CHANGED');
  assert.ok(!j.text.includes('stmt-marker-9z'));
  assert.deepEqual(snapshot(a), before, '거부 뒤에도 실행 폴더 불변');
}));

test('닫기 기록 무결성: 기존 파일이 바뀌거나 closure.json이 깨지면 BLOCKED 쪽으로 거부하고, report.md는 무결성에 영향이 없다', () => withTemp((t) => {
  const { root, stmt } = setup(t);
  const a = makeRunDir(root, OLD);
  close(root, a, ['supersede', 'STANDARDS_CHANGED'], stmt);
  fs.writeFileSync(path.join(a, 'report.md'), '# 파생 보고서\n');
  assert.equal(readClosure(a).state, 'CLOSED', 'report.md는 해시 대상이 아님');
  const judge = () => JSON.parse(runNode(script(root, 'judge.mjs'), [a]).stdout);
  fs.appendFileSync(path.join(a, 'run.json'), ' ');
  assert.deepEqual([readClosure(a).state, readClosure(a).code], ['INVALID', 'CLOSURE_INTEGRITY_MISMATCH']);
  const j = judge();
  assert.equal(j.verdict.status, 'NEEDS_ATTENTION');
  assert.equal(j.error_code, 'CLOSURE_INTEGRITY_MISMATCH');
  assert.equal(JSON.parse(runNode(script(root, 'orchestrator/record-approval.mjs'), [a, 'OPERATING_URL_CONFIRMATION', 'APPROVE', '--statement-file', stmt]).stdout).error_code, 'CLOSURE_INTEGRITY_MISMATCH');
  const b = makeRunDir(root, NEW, { version: data.standards_version });
  close(root, b, ['cancel', 'USER_CANCEL'], stmt);
  fs.writeFileSync(path.join(b, 'closure.json'), '{ broken');
  assert.deepEqual([readClosure(b).state, readClosure(b).code], ['INVALID', 'CLOSURE_INVALID']);
  assert.equal(JSON.parse(runNode(script(root, 'run-stage.mjs'), ['2', b]).stdout).error_code, 'CLOSURE_INVALID');
}));

test('hook: 메인 세션은 close-run을 실행할 수 있고 세 역할은 실행할 수 없다', () => {
  const cmd = `node scripts/orchestrator/close-run.mjs runs/${SLUG}/${OLD} supersede STANDARDS_CHANGED --statement-file .harness-inbox/${OLD}/s.txt`;
  const input = (agent) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: REPO, ...(agent ? { agent_id: 'a1', agent_type: agent } : {}) });
  decide(input(null), { projectDir: REPO });
  for (const role of ['harness-runner', 'release-recorder', 'gate-judge']) assert.throws(() => decide(input(role), { projectDir: REPO }), Deny, role);
});

test('checks.json: run_closure 정책과 1.7.0', () => {
  const p = data.policies.run_closure;
  assert.deepEqual(p.statuses, { CANCELLED: '취소됨', SUPERSEDED: '폐기(대체됨)' });
  assert.deepEqual(p.integrity.exclude, ['closure.json', 'report.md']);
  assert.equal(p.irreversible, true);
});
