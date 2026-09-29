// run-stage.mjs와 judge.mjs를 가상 하네스 루트에서 실제 프로세스로 실행해 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeToken, goodApp, goodInput, makeApp, makeHarnessCopy, makeRun, runNode, snapshot, withTemp } from './helpers.mjs';

const setup = (t, files = goodApp()) => {
  const root = makeHarnessCopy(t);
  const app = makeApp(t, files);
  const runDir = makeRun(root, 'test-app', goodInput(app));
  return { root, app, runDir, runStage: path.join(root, 'scripts', 'run-stage.mjs'), judge: path.join(root, 'scripts', 'judge.mjs') };
};

test('run-stage는 a1, a2를 새로 만들고 기존 결과를 덮어쓰지 않는다', () => withTemp((t) => {
  const s = setup(t);
  const r1 = runNode(s.runStage, ['2', s.runDir]);
  assert.equal(r1.status, 0, r1.stdout);
  assert.equal(JSON.parse(r1.stdout).written, '02-static.a1.json');
  const a1 = fs.readFileSync(path.join(s.runDir, '02-static.a1.json'));
  const r2 = runNode(s.runStage, ['2', s.runDir]);
  assert.equal(JSON.parse(r2.stdout).written, '02-static.a2.json');
  assert.deepEqual(fs.readFileSync(path.join(s.runDir, '02-static.a1.json')), a1);
  const result = JSON.parse(fs.readFileSync(path.join(s.runDir, '02-static.a2.json'), 'utf8'));
  assert.equal(result.complete, true);
  assert.equal(result.run_status, 'IN_PROGRESS');
  assert.equal(fs.readdirSync(s.runDir).filter((n) => n.endsWith('.tmp')).length, 0);
}));

test('run-stage는 runs/ 밖의 실행 폴더를 거부하고 아무것도 쓰지 않는다', () => withTemp((t) => {
  const s = setup(t);
  const outside = path.join(t, 'outside-run');
  fs.mkdirSync(outside);
  fs.copyFileSync(path.join(s.runDir, 'input.json'), path.join(outside, 'input.json'));
  const r = runNode(s.runStage, ['2', outside]);
  assert.equal(JSON.parse(r.stdout).error_code, 'RUN_DIR_OUTSIDE_RUNS');
  assert.deepEqual(fs.readdirSync(outside), ['input.json']);
}));

test('비밀 문자열은 stdout, stderr, 결과 파일 어디에도 나오지 않는다', () => withTemp((t) => {
  const token = fakeToken();
  const files = goodApp();
  files['src/config.js'] = `const k = "${token}";\n`;
  const s = setup(t, files);
  const rs = runNode(s.runStage, ['2', s.runDir]);
  const jd = runNode(s.judge, [s.runDir]);
  const written = fs.readFileSync(path.join(s.runDir, '02-static.a1.json'), 'utf8');
  for (const text of [rs.stdout, rs.stderr, jd.stdout, jd.stderr, written]) assert.equal(text.includes(token), false);
  assert.equal(JSON.parse(jd.stdout).stage2.items.find((i) => i.check_id === 'ST-03').failure_code, 'SECRET_DETECTED');
}));

test('judge는 파일을 만들거나 고치지 않고 stdout에 JSON만 낸다', () => withTemp((t) => {
  const s = setup(t);
  runNode(s.runStage, ['2', s.runDir]);
  const before = snapshot(t);
  const r = runNode(s.judge, [s.runDir]);
  assert.deepEqual(snapshot(t), before);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict.run_status, 'IN_PROGRESS');
  assert.deepEqual(out.runner_comparison.mismatches, []);
}));

test('runner 결과가 judge와 다르면 덮어쓰지 않고 BLOCKED', () => withTemp((t) => {
  const s = setup(t);
  runNode(s.runStage, ['2', s.runDir]);
  const file = path.join(s.runDir, '02-static.a1.json');
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.items[0].status = 'FAIL';
  tampered.items[0].failure_code = 'REQUIRED_DOC_MISSING';
  fs.writeFileSync(file, JSON.stringify(tampered));
  const saved = fs.readFileSync(file);
  const out = JSON.parse(runNode(s.judge, [s.runDir]).stdout);
  assert.equal(out.verdict.run_status, 'BLOCKED');
  assert.equal(out.runner_comparison.mismatches.length, 1);
  assert.deepEqual(fs.readFileSync(file), saved);
}));

test('부분 작성된 결과 파일은 정상 결과로 인정하지 않는다', () => withTemp((t) => {
  const s = setup(t);
  runNode(s.runStage, ['2', s.runDir]);
  fs.writeFileSync(path.join(s.runDir, '02-static.a2.json'), '{"items":[');
  const out = JSON.parse(runNode(s.judge, [s.runDir]).stdout);
  assert.equal(out.runner_comparison.latest_file, '02-static.a1.json');
  assert.deepEqual(out.runner_comparison.invalid_files, ['02-static.a2.json']);
}));

test('judge는 runs/ 밖의 경로면 추정하지 않고 NEEDS_ATTENTION', () => withTemp((t) => {
  const s = setup(t);
  const out = JSON.parse(runNode(s.judge, [t]).stdout);
  assert.equal(out.verdict.status, 'NEEDS_ATTENTION');
  assert.equal(out.error_code, 'RUN_DIR_OUTSIDE_RUNS');
}));
