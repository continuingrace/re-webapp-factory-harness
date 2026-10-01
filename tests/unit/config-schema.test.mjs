// config/ 스키마·예시와 schema subset 검사기, .gitignore 경계. 실제 로컬 설정(*.local.json)은 읽지 않는다.
// 공백만 있는 value, id 중복, 잘못된 regex 거부는 단계 2 로더의 책임이며 여기서는 예시의 id 중복만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, withTemp, writeFiles } from './helpers.mjs';
import { validateSchemaSubset, checkSchema } from '../../scripts/lib/config-schema.mjs';

const CONFIG = path.join(REPO, 'config');
const PAIRS = [
  { schema: 'identifiers.schema.json', example: 'identifiers.example.json', list: 'identifiers' },
  { schema: 'public-scan.schema.json', example: 'public-scan.example.json', list: 'forbidden' },
];
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CONFIG, name), 'utf8'));
const ID_SCHEMA = readJson('identifiers.schema.json');
const PS_SCHEMA = readJson('public-scan.schema.json');
const idConfig = (entry) => ({ schema_version: '1.0.0', identifiers: [entry] });
const psConfig = (entry) => ({ schema_version: '1.0.0', forbidden: [entry] });
const ID_OK = { id: 'ID-A', match: 'literal', value: 'a' };
const PS_OK = { id: 'PS-A', kind: 'email', match: 'literal', value: 'a' };

test('config 스키마는 subset 안에 있고 예시는 스키마를 만족하며 id가 겹치지 않는다', () => {
  for (const p of PAIRS) {
    const schema = readJson(p.schema);
    assert.deepEqual(checkSchema(schema), [], p.schema);
    const example = readJson(p.example);
    assert.deepEqual(validateSchemaSubset(schema, example), [], p.example);
    const ids = example[p.list].map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${p.example}: id 중복`);
  }
  const matches = readJson('identifiers.example.json').identifiers.map((e) => e.match);
  assert.ok(matches.includes('literal') && matches.includes('regex'));
});

test('잘못된 설정은 거부한다', () => {
  const bad = [
    [ID_SCHEMA, { schema_version: '1.0.0' }],
    [ID_SCHEMA, { schema_version: '2.0.0', identifiers: [ID_OK] }],
    [ID_SCHEMA, { schema_version: '1.0.0', identifiers: [] }],
    [ID_SCHEMA, { schema_version: '1.0.0', identifiers: [ID_OK], extra: 1 }],
    [ID_SCHEMA, idConfig({ id: 'id-a', match: 'literal', value: 'a' })],
    [ID_SCHEMA, idConfig({ id: 'ID-A', value: 'a' })],
    [ID_SCHEMA, idConfig({ id: 'ID-A', match: 'glob', value: 'a' })],
    [ID_SCHEMA, idConfig({ id: 'ID-A', match: 'literal', value: '' })],
    [ID_SCHEMA, idConfig({ id: 'ID-A', match: 'literal', value: 1 })],
    [ID_SCHEMA, idConfig({ id: 'ID-A', pattern: 'a' })],
    [ID_SCHEMA, idConfig({ ...ID_OK, extra: 1 })],
    [ID_SCHEMA, []],
    [PS_SCHEMA, psConfig({ ...PS_OK, kind: 'phone' })],
    [PS_SCHEMA, psConfig({ id: 'PS-A', kind: 'email', value: 'a' })],
    [PS_SCHEMA, psConfig({ ...PS_OK, id: 'ID-A' })],
    [PS_SCHEMA, { schema_version: '1.0.0', forbidden: 'a' }],
  ];
  for (const [schema, value] of bad) assert.notDeepEqual(validateSchemaSubset(schema, value), [], JSON.stringify(value));
});

test('알 수 없는 schema 키워드와 subset 밖 설정은 값 검사 전에 거부한다', () => {
  assert.match(validateSchemaSubset({ type: 'string', format: 'email' }, 'a').join('\n'), /지원하지 않는 키워드 format/);
  // 값에 없는 하위 필드의 스키마도 검사한다
  const nested = { type: 'object', properties: { a: { type: 'string', oneOf: [] } } };
  assert.match(validateSchemaSubset(nested, {}).join('\n'), /지원하지 않는 키워드 oneOf/);
  assert.notDeepEqual(validateSchemaSubset({ type: 'number' }, 1), []);
  assert.notDeepEqual(validateSchemaSubset({ type: 'object', additionalProperties: true }, {}), []);
  assert.notDeepEqual(validateSchemaSubset({ type: 'string', maxLength: -1 }, 'a'), []);
  assert.notDeepEqual(validateSchemaSubset({ type: 'string', pattern: '(' }, 'a'), []);
});

test('maxLength: id 100, value 2048, note 500을 넘으면 거부한다', () => {
  const cases = [
    [ID_SCHEMA, idConfig, ID_OK, 'ID-'],
    [PS_SCHEMA, psConfig, PS_OK, 'PS-'],
  ];
  for (const [schema, wrap, ok, prefix] of cases) {
    const pass = (entry) => assert.deepEqual(validateSchemaSubset(schema, wrap(entry)), [], JSON.stringify(entry).slice(0, 40));
    const fail = (entry) => assert.match(validateSchemaSubset(schema, wrap(entry)).join('\n'), /maxLength 초과/);
    pass({ ...ok, id: prefix + 'A'.repeat(100 - prefix.length) });
    fail({ ...ok, id: prefix + 'A'.repeat(101 - prefix.length) });
    pass({ ...ok, value: 'v'.repeat(2048) });
    fail({ ...ok, value: 'v'.repeat(2049) });
    pass({ ...ok, note: 'n'.repeat(500) });
    fail({ ...ok, note: 'n'.repeat(501) });
  }
  // 길이는 code point 수로 센다
  assert.deepEqual(validateSchemaSubset(ID_SCHEMA, idConfig({ ...ID_OK, note: '😀'.repeat(500) })), []);
});

test('검사기 오류 메시지에는 설정 값이 들어가지 않는다', () => {
  const secret = 'private-value-should-not-leak';
  const errs = validateSchemaSubset(PS_SCHEMA, psConfig({ ...PS_OK, kind: secret, value: secret.repeat(100) }));
  assert.notDeepEqual(errs, []);
  assert.ok(!errs.join('\n').includes(secret));
});

// 실제 식별자가 추적 파일에 없는지는 테스트가 알 수 없으므로 scripts/tools/scan-tracked-identifiers.mjs로 확인한다.
test('ST-04는 식별자를 checks.json에 두지 않고 local 설정 정책만 참조한다', () => {
  const checks = JSON.parse(fs.readFileSync(path.join(REPO, 'standards', 'checks.json'), 'utf8'));
  const rule = checks.checks.find((c) => c.check_id === 'ST-04').rule;
  assert.equal('patterns' in rule, false);
  assert.equal(rule.identifiers_from, 'policies.private_identifiers');
  const policy = checks.policies.private_identifiers;
  assert.equal(policy.config_path, 'config/identifiers.local.json');
  assert.equal(policy.schema_path, 'config/identifiers.schema.json');
  assert.equal(policy.case_insensitive, true);
});

// 저장소의 .gitignore를 임시 git 저장소에 복사해 검증한다 (실제 저장소의 .git·local 설정 없이도 같은 결과).
test('.gitignore는 local 설정과 .export/를 막고 schema·example은 추적한다', () => withTemp((t) => {
  fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(t, '.gitignore'));
  const files = { 'config/identifiers.local.json': '{}', 'config/public-scan.local.json': '{}', '.export/example-export/PUBLIC_RELEASES.md': 'x' };
  for (const p of PAIRS) {
    files[`config/${p.schema}`] = '{}';
    files[`config/${p.example}`] = '{}';
  }
  writeFiles(t, files);
  const git = (...args) => spawnSync('git', args, { cwd: t, encoding: 'utf8', windowsHide: true });
  assert.equal(git('init', '-q').status, 0);
  const ignored = (rel) => git('check-ignore', '-q', rel).status === 0;
  assert.ok(ignored('config/identifiers.local.json'));
  assert.ok(ignored('config/public-scan.local.json'));
  assert.ok(ignored('.export/example-export/PUBLIC_RELEASES.md'));
  for (const p of PAIRS) {
    assert.ok(!ignored(`config/${p.schema}`), p.schema);
    assert.ok(!ignored(`config/${p.example}`), p.example);
  }
  assert.equal(git('add', '-A').status, 0);
  const tracked = git('ls-files').stdout;
  assert.ok(!/\.local\.json$/m.test(tracked));
  assert.ok(!/^\.export\//m.test(tracked));
  for (const p of PAIRS) assert.ok(tracked.includes(`config/${p.schema}`) && tracked.includes(`config/${p.example}`), p.schema);
}));
