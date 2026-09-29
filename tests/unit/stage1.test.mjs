import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO, goodInput, makeApp, withTemp } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { judgeIntake } from '../../scripts/stages/stage1-intake.mjs';

const { data } = loadChecks(REPO);
const run = (input, root = REPO) => judgeIntake({ root, checksData: data, input });

test('유효한 입력은 PASS, 실행 상태 IN_PROGRESS', () => withTemp((t) => {
  const r = run(goodInput(makeApp(t)));
  assert.equal(r.items[0].status, 'PASS');
  assert.equal(r.run_status, 'IN_PROGRESS');
  assert.equal(r.app_slug, 'test-app');
  assert.equal(r.app_slug_source, 'DERIVED');
}));

test('필수 입력 누락은 INPUT_INVALID', () => withTemp((t) => {
  const input = goodInput(makeApp(t));
  delete input.change_summary;
  const r = run(input);
  assert.equal(r.items[0].status, 'FAIL');
  assert.equal(r.items[0].failure_code, 'INPUT_INVALID');
  assert.equal(r.run_status, 'BLOCKED');
}));

test('목표 버전 형식 오류와 잘못된 플래그 값', () => withTemp((t) => {
  const r = run(goodInput(makeApp(t), { target_version: 'v1.0', flags: { sticky_preview: 'maybe', effect_font: 'no', local_state: 'no', pwa_installable: 'yes' } }));
  const fields = r.items[0].evidence.violations.map((v) => v.field);
  assert.ok(fields.includes('target_version'));
  assert.ok(fields.includes('flags.sticky_preview'));
}));

test('postdeploy인데 운영 URL이 없으면 실패', () => withTemp((t) => {
  const r = run(goodInput(makeApp(t), { release_phase: 'postdeploy' }));
  assert.ok(r.items[0].evidence.violations.some((v) => v.field === 'operating_url'));
}));

test('규칙에 맞지 않는 폴더명은 APP_SLUG_INVALID', () => withTemp((t) => {
  const r = run(goodInput(makeApp(t, undefined, 'Bad_App')));
  assert.equal(r.items[0].failure_code, 'APP_SLUG_INVALID');
}));
