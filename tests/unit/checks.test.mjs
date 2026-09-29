import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO } from './helpers.mjs';
import { appliesWhen, getOverride, loadChecks, validateChecks } from '../../scripts/lib/checks.mjs';

const { data } = loadChecks(REPO);
const clone = () => JSON.parse(JSON.stringify(data));

test('현재 checks.json은 스키마 오류가 없고 check 32개다', () => {
  assert.deepEqual(validateChecks(data), []);
  assert.equal(data.checks.length, 32);
});

test('최상위 필드 누락을 오류로 보고한다', () => {
  const d = clone();
  delete d.source_documents;
  assert.ok(validateChecks(d).some((e) => e.startsWith('TOP_FIELD_MISSING:source_documents')));
});

test('check_id 중복을 오류로 보고한다', () => {
  const d = clone();
  d.checks.push({ ...d.checks[0] });
  assert.ok(validateChecks(d).some((e) => e.startsWith('CHECK_ID_DUPLICATE')));
});

test('등록되지 않은 source_reference를 오류로 보고한다', () => {
  const d = clone();
  d.checks[0].source_reference = 'docs/unregistered.md#1';
  assert.ok(validateChecks(d).some((e) => e.startsWith('SOURCE_NOT_REGISTERED')));
});

test('check 필드 누락을 오류로 보고한다', () => {
  const d = clone();
  delete d.checks[1].evidence_required;
  assert.ok(validateChecks(d).some((e) => e.endsWith(':evidence_required')));
});

test('applies_when은 always, flag 조건, 해석 불가를 구분한다', () => {
  const input = { release_phase: 'predeploy', flags: { pwa_installable: 'yes' } };
  assert.equal(appliesWhen('always', input), true);
  assert.equal(appliesWhen('pwa_installable == yes', input), true);
  assert.equal(appliesWhen('release_phase == postdeploy', input), false);
  assert.equal(appliesWhen('a > b', input), null);
});

test('override는 필수 필드가 모두 있을 때만 인정한다', () => {
  const full = { check_id: 'DS-02', value: { allowed: ['18px'] }, reason: 'r', approval_statement: '승인', source_reference: 'app/design.md#2' };
  assert.equal(getOverride(data, { overrides: [full] }, 'DS-02').rejected, false);
  const partial = { ...full, approval_statement: '' };
  assert.equal(getOverride(data, { overrides: [partial] }, 'DS-02').rejected, true);
  assert.equal(getOverride(data, { overrides: [] }, 'DS-02'), null);
});
