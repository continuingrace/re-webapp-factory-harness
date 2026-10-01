// 비공개 식별자 로더와 IN-01·ST-04 상태 전이. fixture·임시 하네스 복사본만 쓰며 실제 local 설정은 읽지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_IDENTIFIERS_FILE, FIXTURE_IDS, IDENTIFIERS_SCHEMA, REPO, TRIPWIRE_CODE, goodApp, goodInput, isRepoLocalConfig,
  localIdentifiersPath, makeApp, makeHarnessCopy, runNode, tripwireHits, withTemp, writeFiles,
} from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import {
  CONFIG_INVALID, CONFIG_MISSING, PATTERN_INVALID, ZERO_LENGTH_MATCH, compileIdentifiers, countIdentifier, loadIdentifiers, maskText,
} from '../../scripts/lib/identifiers.mjs';
import { judgeIntake } from '../../scripts/stages/stage1-intake.mjs';
import { judgeStatic } from '../../scripts/stages/stage2-static.mjs';
import { scanFiles } from '../../scripts/tools/scan-tracked-identifiers.mjs';

const { data } = loadChecks(REPO);
const POLICY = data.policies.private_identifiers;
const SECRET = 'secret-value-must-not-leak';
const cfg = (...entries) => ({ schema_version: '1.0.0', identifiers: entries });
const compile = (c) => compileIdentifiers(c, IDENTIFIERS_SCHEMA);
const item = (r, id) => r.items.find((i) => i.check_id === id);
const OK_STATUS = ['PASS', 'NOT_APPLICABLE'];

const ERROR_CASES = [
  ['EMPTY_LIST', CONFIG_INVALID, cfg()],
  ['SCHEMA', CONFIG_INVALID, cfg({ id: 'ID-A', value: SECRET })],
  ['SCHEMA', CONFIG_INVALID, cfg({ id: 'ID-A', match: 'glob', value: SECRET })],
  ['SCHEMA', CONFIG_INVALID, cfg({ id: 'ID-A', match: 'literal', value: SECRET, extra: SECRET })],
  ['SCHEMA', CONFIG_INVALID, cfg({ id: 'ID-A', match: 'literal', value: SECRET.repeat(100) })],
  ['SCHEMA', CONFIG_INVALID, { schema_version: '1.0.0' }],
  ['DUPLICATE_ID', CONFIG_INVALID, cfg({ id: 'ID-A', match: 'literal', value: SECRET }, { id: 'ID-A', match: 'literal', value: 'other' })],
  ['BLANK_VALUE', CONFIG_INVALID, cfg({ id: 'ID-A', match: 'literal', value: ' \t ' })],
  ['REGEX_COMPILE', PATTERN_INVALID, cfg({ id: 'ID-A', match: 'regex', value: `${SECRET}(` })],
  ['REGEX_MATCHES_EMPTY', PATTERN_INVALID, cfg({ id: 'ID-A', match: 'regex', value: `(${SECRET})*` })],
  ['REGEX_MATCHES_EMPTY', PATTERN_INVALID, cfg({ id: 'ID-A', match: 'regex', value: '\\b' })],
];

// 임시 하네스 루트: config/ 폴더와 schema만 있고 local 설정은 테스트가 직접 쓴다.
function bareRoot(t, name = 'h') {
  const root = path.join(t, name);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'config', 'identifiers.schema.json'), path.join(root, 'config', 'identifiers.schema.json'));
  return root;
}

// ---------- 로더 ----------

test('literal은 regex escape 후 대소문자 무시로, regex는 명시한 항목만 정규식으로 비교한다', () => {
  const ids = compile(cfg({ id: 'ID-L', match: 'literal', value: 'a.b+c' }, { id: 'ID-R', match: 'regex', value: '\\bfxword\\b' }));
  assert.equal(ids.ok, true);
  const [l, r] = ids.entries;
  assert.equal(countIdentifier(l, 'x A.B+C y a.b+c'), 2);
  assert.equal(countIdentifier(l, 'axbbc'), 0);
  assert.equal(countIdentifier(r, 'one FXWORD two fxword'), 2);
  assert.equal(countIdentifier(r, 'fxwords'), 0);
  assert.equal(JSON.stringify(ids).includes('a.b+c'), false);
  assert.equal(JSON.stringify(ids).includes('fxword'), false);
});

test('설정 오류는 모두 거부하고 결과에 설정 값·regex 원문이 없다', () => {
  for (const [reason, code, c] of ERROR_CASES) {
    const r = compile(c);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason, JSON.stringify(r));
    assert.equal(r.failure_code, code, reason);
    assert.equal(JSON.stringify(r).includes(SECRET), false, reason);
  }
});

test('파일 로딩: 없음·JSON 오류·일반 파일 아님·크기 초과·경로 이탈을 거부하고 BOM은 허용한다', () => withTemp((t) => {
  const root = bareRoot(t);
  const local = path.join(root, 'config', 'identifiers.local.json');
  assert.deepEqual([loadIdentifiers(root, POLICY).failure_code, loadIdentifiers(root, POLICY).reason], [CONFIG_MISSING, 'NOT_FOUND']);

  fs.writeFileSync(local, `{"schema_version":"1.0.0","identifiers":[{"id":"ID-A","match":"literal","value":"${SECRET}"`);
  let r = loadIdentifiers(root, POLICY);
  assert.deepEqual([r.failure_code, r.reason], [CONFIG_INVALID, 'JSON_PARSE']);
  assert.equal(JSON.stringify(r).includes(SECRET), false);

  fs.writeFileSync(local, JSON.stringify(cfg({ id: 'ID-A', match: 'literal', value: 'x'.repeat(2000) }, ...Array.from({ length: 40 }, (_, i) => ({ id: `ID-B${i}`, match: 'literal', value: 'y'.repeat(2000) })))));
  assert.equal(loadIdentifiers(root, POLICY).reason, 'TOO_LARGE');

  fs.writeFileSync(local, `﻿${fs.readFileSync(FIXTURE_IDENTIFIERS_FILE, 'utf8')}`);
  r = loadIdentifiers(root, POLICY);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);

  fs.rmSync(local);
  fs.mkdirSync(local);
  assert.equal(loadIdentifiers(root, POLICY).reason, 'NOT_REGULAR_FILE');

  assert.equal(loadIdentifiers(root, { ...POLICY, config_path: 'x.local.json' }).reason, 'UNSAFE_PATH');
  assert.equal(loadIdentifiers(root, { ...POLICY, config_path: 'config/../../x.local.json' }).reason, 'UNSAFE_PATH');
  assert.equal(loadIdentifiers(root, { config_path: POLICY.config_path }).reason, 'POLICY_INVALID');
  assert.deepEqual([loadIdentifiers(path.join(t, 'empty'), POLICY).failure_code], [CONFIG_MISSING]);
}));

test('파일 로딩: config 폴더가 저장소 밖을 가리키는 junction이면 거부한다', () => withTemp((t) => {
  const outside = bareRoot(t, 'outside');
  fs.copyFileSync(FIXTURE_IDENTIFIERS_FILE, path.join(outside, 'config', 'identifiers.local.json'));
  const root = path.join(t, 'h');
  fs.mkdirSync(root);
  fs.symlinkSync(path.join(outside, 'config'), path.join(root, 'config'), 'junction');
  try {
    const r = loadIdentifiers(root, POLICY);
    assert.deepEqual([r.ok, r.failure_code, r.reason], [false, CONFIG_INVALID, 'UNSAFE_PATH']);
  } finally {
    fs.unlinkSync(path.join(root, 'config'));
  }
}));

test('tripwire: 테스트 프로세스는 실제 저장소의 local 설정을 읽을 수 없다', () => {
  const before = tripwireHits.length;
  const targets = [
    path.join(REPO, 'config', 'identifiers.local.json'),
    path.join(REPO, 'CONFIG', 'IDENTIFIERS.LOCAL.JSON'),
    `${REPO.replace(/\\/g, '/')}/config/public-scan.local.json`,
  ];
  for (const p of targets) {
    assert.throws(() => fs.readFileSync(p), (e) => e.code === TRIPWIRE_CODE, p);
    assert.throws(() => fs.lstatSync(p), (e) => e.code === TRIPWIRE_CODE, p);
  }
  // 로더가 실제 저장소를 가리켜도 내용을 읽지 못하고 설정 오류로 끝난다.
  const r = loadIdentifiers(REPO, POLICY);
  assert.deepEqual([r.ok, r.reason], [false, 'UNREADABLE']);
  assert.ok(tripwireHits.length >= before + targets.length * 2 + 1);
  assert.equal(isRepoLocalConfig(path.join(REPO, 'config', 'identifiers.schema.json')), false);
  assert.throws(() => localIdentifiersPath(REPO));
});

// ---------- IN-01 ----------

test('IN-01: 설정 오류마다 NEEDS_ATTENTION, 실행 BLOCKED, ST-04 NOT_RUN이며 값은 결과에 없다', () => withTemp((t) => {
  const app = makeApp(t);
  const cases = [undefined, loadIdentifiers(path.join(t, 'none'), POLICY), ...ERROR_CASES.map(([, , c]) => compile(c))];
  for (const ids of cases) {
    const r = judgeIntake({ root: REPO, checksData: data, input: goodInput(app), identifiers: ids });
    const i = r.items[0];
    assert.equal(i.status, 'NEEDS_ATTENTION');
    assert.ok([CONFIG_MISSING, CONFIG_INVALID, PATTERN_INVALID].includes(i.failure_code), i.failure_code);
    assert.equal(i.evidence.identifiers_config.status, 'UNAVAILABLE');
    assert.equal(r.run_status, 'BLOCKED');
    assert.deepEqual(r.blocked_checks.map((b) => [b.check_id, b.status, b.failure_code]), [['ST-04', 'NOT_RUN', null]]);
    assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
  // 입력 오류가 함께 있으면 입력 FAIL이 우선이지만 ST-04는 여전히 NOT_RUN이다.
  const both = judgeIntake({ root: REPO, checksData: data, input: goodInput(app, { target_version: 'v1' }), identifiers: undefined });
  assert.deepEqual([both.items[0].status, both.items[0].failure_code, both.run_status], ['FAIL', 'INPUT_INVALID', 'BLOCKED']);
  assert.equal(both.blocked_checks[0].status, 'NOT_RUN');

  const ok = judgeIntake({ root: REPO, checksData: data, input: goodInput(app), identifiers: FIXTURE_IDS });
  assert.deepEqual([ok.items[0].status, ok.run_status, ok.blocked_checks], ['PASS', 'IN_PROGRESS', []]);
  assert.deepEqual(ok.items[0].evidence.identifiers_config, { status: 'LOADED', count: 2 });
}));

// ---------- ST-04 ----------

test('stage 2 시점 설정 오류: ST-04만 NOT_RUN이고 다른 검사는 판정하며 실행은 BLOCKED', () => withTemp((t) => {
  const app = makeApp(t);
  for (const ids of [undefined, compile(cfg()), compile(cfg({ id: 'ID-A', match: 'regex', value: `${SECRET}(` }))]) {
    const r = judgeStatic({ root: REPO, checksData: data, input: goodInput(app), identifiers: ids });
    const st04 = item(r, 'ST-04');
    assert.deepEqual([st04.status, st04.failure_code, st04.evidence.reason], ['NOT_RUN', null, 'IDENTIFIERS_CONFIG_UNAVAILABLE']);
    const others = r.items.filter((i) => i.check_id !== 'ST-04');
    assert.deepEqual(others.filter((i) => !OK_STATUS.includes(i.status)).map((i) => i.check_id), []);
    assert.equal(others.length, data.checks.filter((c) => c.stage === 2).length - 1);
    assert.equal(r.run_status, 'BLOCKED');
    assert.equal(r.identifiers_config.status, 'UNAVAILABLE');
    assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
}));

test('ST-04: fixture 식별자는 FOREIGN_PROJECT_MIXED, 설정에 없는 단어는 탐지하지 않는다', () => withTemp((t) => {
  const hit = makeApp(t, { ...goodApp(), 'notes/a.txt': 'x Fixture-Foreign-Brand y', 'notes/b.txt': 'fixture-foreign-brand' }, 'hit-app');
  let r = judgeStatic({ root: REPO, checksData: data, input: goodInput(hit), identifiers: FIXTURE_IDS });
  const i = item(r, 'ST-04');
  assert.equal(i.failure_code, 'FOREIGN_PROJECT_MIXED');
  assert.deepEqual(i.evidence.hits, [
    { path: 'notes/a.txt', id: 'ID-FIXTURE-1', target: 'content', count: 1 },
    { path: 'notes/b.txt', id: 'ID-FIXTURE-1', target: 'content', count: 1 },
  ]);
  assert.deepEqual(i.evidence.identifiers, ['ID-FIXTURE-1', 'ID-FIXTURE-2']);
  // 같은 식별자 객체를 다시 써도 결과가 같다 (lastIndex가 이어지지 않는다).
  r = judgeStatic({ root: REPO, checksData: data, input: goodInput(hit), identifiers: FIXTURE_IDS });
  assert.deepEqual(item(r, 'ST-04').evidence.hits, i.evidence.hits);

  const clean = makeApp(t, { ...goodApp(), 'notes/a.txt': 'unlisted-private-word fxwords foreign-brand' }, 'clean-app');
  assert.equal(item(judgeStatic({ root: REPO, checksData: data, input: goodInput(clean), identifiers: FIXTURE_IDS }), 'ST-04').status, 'PASS');
}));

test('식별자 regex는 검사마다 새 인스턴스라 lastIndex가 이어지지 않는다', () => {
  const [e] = FIXTURE_IDS.entries;
  assert.notEqual(e.regex(), e.regex());
  assert.deepEqual([1, 2, 3].map(() => countIdentifier(e, 'fixture-foreign-brand')), [1, 1, 1]);
  assert.equal(maskText('a/fixture-foreign-brand/fxword.txt', FIXTURE_IDS), 'a/[ID-FIXTURE-1]/[ID-FIXTURE-2].txt');
});

test('스캔 중 길이 0 match((?=zz))는 즉시 중단하고 ST-04는 NEEDS_ATTENTION / CHECK_INCONCLUSIVE', () => withTemp((t) => {
  const ids = compile(cfg({ id: 'ID-LOOK', match: 'regex', value: '(?=zz)' }));
  assert.equal(ids.ok, true); // 로더 probe로는 걸리지 않는 조건부 길이 0 regex
  assert.throws(() => countIdentifier(ids.entries[0], 'aa zz'), (e) => e.code === ZERO_LENGTH_MATCH);
  const clean = judgeStatic({ root: REPO, checksData: data, input: goodInput(makeApp(t)), identifiers: ids });
  assert.equal(item(clean, 'ST-04').status, 'PASS');
  const app = makeApp(t, { ...goodApp(), 'notes.txt': 'aa zz bb' }, 'zz-app');
  const r = judgeStatic({ root: REPO, checksData: data, input: goodInput(app), identifiers: ids });
  const i = item(r, 'ST-04');
  assert.deepEqual([i.status, i.failure_code, i.evidence.reason], ['NEEDS_ATTENTION', 'CHECK_INCONCLUSIVE', 'ZERO_LENGTH_MATCH']);
  assert.equal(r.run_status, 'BLOCKED');
}));

// ---------- CLI (임시 하네스 복사본) ----------

test('CLI: local 설정이 없거나 잘못되면 start-run은 실행 폴더 없이 BLOCKED이고 값을 출력하지 않는다', () => withTemp((t) => {
  const root = makeHarnessCopy(t, { identifiers: null });
  const app = makeApp(t);
  const inputFile = path.join(t, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify(goodInput(app)));
  const startRun = path.join(root, 'scripts', 'orchestrator', 'start-run.mjs');
  const intake = path.join(root, 'scripts', 'stages', 'stage1-intake.mjs');
  const local = localIdentifiersPath(root);
  const variants = [
    [null, CONFIG_MISSING],
    [`{"schema_version":"1.0.0","identifiers":[{"id":"ID-A","match":"literal","value":"${SECRET}"`, CONFIG_INVALID],
    [JSON.stringify(cfg({ id: 'ID-A', match: 'regex', value: `${SECRET}(` })), PATTERN_INVALID],
    [JSON.stringify(cfg({ id: 'ID-A', match: 'literal', value: SECRET }, { id: 'ID-A', match: 'literal', value: SECRET })), CONFIG_INVALID],
  ];
  for (const [content, code] of variants) {
    if (content === null) fs.rmSync(local, { force: true });
    else fs.writeFileSync(local, content);
    for (const script of [startRun, intake]) {
      const r = runNode(script, [inputFile]);
      assert.equal(`${r.stdout}${r.stderr}`.includes(SECRET), false);
      const out = JSON.parse(r.stdout);
      const i = out.intake || out.items[0];
      assert.equal(out.run_status, 'BLOCKED');
      assert.deepEqual([i.status, i.failure_code], ['NEEDS_ATTENTION', code]);
      assert.deepEqual(out.blocked_checks.map((b) => [b.check_id, b.status]), [['ST-04', 'NOT_RUN']]);
    }
    assert.deepEqual(fs.readdirSync(path.join(root, 'runs')), []);
  }
}));

test('CLI: stage 2 전에 설정이 사라지면 ST-04만 NOT_RUN이고 stage 3·판정이 진행되지 않으며 결과 파일에 값이 없다', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const local = localIdentifiersPath(root);
  // 결과 파일에 설정 값이 남지 않는지 보기 위해 비밀 값 설정으로 실행한다.
  fs.writeFileSync(local, JSON.stringify(cfg({ id: 'ID-S1', match: 'literal', value: SECRET }, { id: 'ID-S2', match: 'regex', value: '\\bsecretword\\b' })));
  const app = makeApp(t);
  const inputFile = path.join(t, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify(goodInput(app)));
  const started = JSON.parse(runNode(path.join(root, 'scripts', 'orchestrator', 'start-run.mjs'), [inputFile]).stdout);
  assert.equal(started.created, true);
  const runDir = path.join(root, ...started.run_dir.split('/'));
  const stage = (n) => JSON.parse(runNode(path.join(root, 'scripts', 'run-stage.mjs'), [String(n), runDir]).stdout);
  const judge = () => JSON.parse(runNode(path.join(root, 'scripts', 'judge.mjs'), [runDir]).stdout);
  assert.equal(stage(2).run_status, 'IN_PROGRESS');
  assert.equal(judge().verdict.run_status, 'IN_PROGRESS');

  fs.rmSync(local);
  const s2 = stage(2);
  assert.equal(s2.run_status, 'BLOCKED');
  const res = JSON.parse(fs.readFileSync(path.join(runDir, s2.written), 'utf8'));
  assert.equal(item(res, 'ST-04').status, 'NOT_RUN');
  assert.deepEqual(res.items.filter((i) => i.check_id !== 'ST-04' && !OK_STATUS.includes(i.status)).map((i) => i.check_id), []);
  assert.deepEqual(res.identifiers_config, { status: 'UNAVAILABLE', failure_code: CONFIG_MISSING, reason: 'NOT_FOUND' });
  assert.equal(stage(3).error_code, 'STAGE_PREREQUISITE_UNMET');
  const j = judge();
  assert.equal(j.verdict.run_status, 'BLOCKED');
  assert.equal(j.stage1.items[0].failure_code, CONFIG_MISSING);
  assert.equal(j.stage2, null);
  assert.deepEqual([j.verdict.release_record_allowed, j.verdict.complete_allowed], [false, false]);

  for (const name of fs.readdirSync(runDir)) {
    const p = path.join(runDir, name);
    if (fs.statSync(p).isFile()) {
      const text = fs.readFileSync(p, 'utf8');
      assert.equal(text.includes(SECRET) || text.includes('secretword'), false, name);
    }
  }
}));

// ---------- 기준·도구 ----------

test('checks.json: check 36개·ID 중복 0·IN-01 설정 코드·ST-04 정책 참조·1.8.3', () => {
  const ids = data.checks.map((c) => c.check_id);
  assert.equal(ids.length, 36);
  assert.equal(new Set(ids).size, 36);
  assert.equal(data.standards_version, '1.8.3');
  const in01 = data.checks.find((c) => c.check_id === 'IN-01');
  for (const code of [CONFIG_MISSING, CONFIG_INVALID, PATTERN_INVALID]) assert.ok(in01.failure_code.includes(code), code);
  assert.deepEqual(POLICY.on_unavailable, { 'IN-01': 'NEEDS_ATTENTION', run_status: 'BLOCKED', 'ST-04': 'NOT_RUN' });
  assert.deepEqual(POLICY.applies_to, ['IN-01', 'ST-04']);
});

test('scan-tracked-identifiers: opaque id·가린 경로·건수만 보고한다', () => withTemp((t) => {
  writeFiles(t, {
    'docs/a.md': 'x fixture-foreign-brand y FIXTURE-FOREIGN-BRAND',
    'fxword/b.txt': 'clean',
    'c.bin': Buffer.concat([Buffer.from([0, 1, 0]), Buffer.from('fxword', 'latin1')]),
    'd.txt': 'nothing here',
  });
  const r = scanFiles(t, ['docs/a.md', 'fxword/b.txt', 'c.bin', 'd.txt'], FIXTURE_IDS);
  assert.equal(r.scanned, 4);
  assert.deepEqual(r.hits, [
    { path: 'docs/a.md', id: 'ID-FIXTURE-1', target: 'content', count: 2 },
    { path: '[ID-FIXTURE-2]/b.txt', id: 'ID-FIXTURE-2', target: 'path', count: 1 },
    { path: 'c.bin', id: 'ID-FIXTURE-2', target: 'content', count: 1 },
  ]);
  const text = JSON.stringify(r);
  assert.equal(text.includes('fixture-foreign-brand') || text.includes('fxword'), false);
}));
