// sample-app을 가상 하네스 루트에서 1→2→3단계로 실행하고, judge의 원시 evidence 재판정을 검증한다.
// 실제 runs/, docs/, standards/, fixtures/sample-app은 변경하지 않는다.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, makeHarnessCopy, mkTemp, rm, runNode, snapshot, withTemp, makeApp } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { computeFingerprint } from '../../scripts/lib/fingerprint.mjs';
import { judgeIntake } from '../../scripts/stages/stage1-intake.mjs';
import { measureStage3 } from '../../scripts/stages/stage3-browser.mjs';
import { evaluateStage3 } from '../../scripts/stages/stage3-evaluate.mjs';

const SAMPLE = path.join(REPO, 'fixtures', 'sample-app');
const { data } = loadChecks(REPO);
const FLAGS = { sticky_preview: 'yes', effect_font: 'no', local_state: 'yes', pwa_installable: 'yes' };
const profileDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => /^playwright/i.test(n)).sort();

let tmp;
let root;
let runDir;
let fpBefore;
let profilesBefore;
let stage2Out;
let stage3Out;
let original3;

before(() => {
  fpBefore = computeFingerprint(SAMPLE, data.policies.fingerprint).value;
  profilesBefore = profileDirs();
  tmp = mkTemp();
  root = makeHarnessCopy(tmp);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const raw = { app_path: SAMPLE, target_version: '1.0.0', change_summary: '하네스 v1 검증', release_phase: 'predeploy', flags: FLAGS, overrides: [] };
  const intake = judgeIntake({ root, checksData: loadChecks(root).data, input: raw });
  assert.equal(intake.items[0].status, 'PASS');
  runDir = path.join(root, 'runs', intake.app_slug, '20260930-090000-KST-t3test');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'input.json'), JSON.stringify({ ...raw, app_slug: intake.app_slug, app_slug_source: intake.app_slug_source, app_path_canonical: intake.app_path_canonical }));
  const script = path.join(root, 'scripts', 'run-stage.mjs');
  stage2Out = JSON.parse(runNode(script, ['2', runDir]).stdout);
  stage3Out = JSON.parse(runNode(script, ['3', runDir], { timeout: 240000 }).stdout);
  original3 = fs.readFileSync(path.join(runDir, '03-browser.a1.json'), 'utf8');
});

// node_modules junction을 먼저 끊은 뒤에만 임시 폴더를 지운다 (실제 node_modules 보호).
after(() => {
  if (!tmp) return;
  const link = path.join(root, 'node_modules');
  if (fs.existsSync(link)) {
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  }
  if (fs.existsSync(link)) throw new Error('node_modules junction을 제거하지 못해 임시 폴더를 남긴다');
  rm(tmp);
});

const read3 = () => JSON.parse(fs.readFileSync(path.join(runDir, '03-browser.a1.json'), 'utf8'));
const write3 = (obj) => fs.writeFileSync(path.join(runDir, '03-browser.a1.json'), JSON.stringify(obj));
const judge = (nodeFlags = []) => spawnSync(process.execPath, [...nodeFlags, path.join(root, 'scripts', 'judge.mjs'), runDir], { encoding: 'utf8', windowsHide: true });

test('sample-app stage 2·3 적용 항목이 모두 PASS 또는 근거 있는 NOT_APPLICABLE이고, 상태는 AWAITING_DEPLOYMENT', () => {
  assert.equal(stage2Out.run_status, 'IN_PROGRESS');
  assert.equal(stage3Out.written, '03-browser.a1.json');
  const r = read3();
  const bad = r.items.filter((i) => !['PASS', 'NOT_APPLICABLE'].includes(i.status));
  assert.deepEqual(bad.map((i) => [i.check_id, i.status, i.failure_code]), []);
  for (const i of r.items.filter((x) => x.status === 'NOT_APPLICABLE')) assert.ok(i.evidence.reason);
  assert.equal(r.run_status, 'AWAITING_DEPLOYMENT');
});

test('browser evidence: provider, channel, 실제 버전, headless, 시작·종료 시각, 프로필 미사용', () => {
  const b = read3().browser;
  assert.equal(b.provider, 'installed_browser');
  assert.equal(b.channel, 'chrome');
  assert.equal(b.fallback, null);
  assert.equal(b.headless, true);
  assert.match(b.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(b.started_at && b.ended_at);
  assert.ok(!/User Data|AppData/i.test(JSON.stringify(b)));
});

test('외부 origin 요청 0건, 로컬 origin만 기록', () => {
  const n = read3().network;
  assert.deepEqual(n.external_origins, []);
  assert.deepEqual(n.origins, [n.local_origin]);
  assert.match(n.local_origin, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('원본 sample-app fingerprint는 검사 전후 같고, 임시 브라우저 프로필이 남지 않는다', () => {
  assert.equal(computeFingerprint(SAMPLE, data.policies.fingerprint).value, fpBefore);
  assert.deepEqual(profileDirs(), profilesBefore);
});

test('judge는 파일을 쓰지 않고, 자식 프로세스 없이(권한 모델) 같은 판정을 낸다', () => {
  const beforeSnap = snapshot(tmp);
  const r = judge(['--permission', '--allow-fs-read=*']);
  assert.deepEqual(snapshot(tmp), beforeSnap);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict.run_status, 'AWAITING_DEPLOYMENT', r.stdout.slice(0, 500));
  assert.deepEqual(out.stage3.mismatches, []);
});

test('judge는 조작된 runner status를 원시 측정값으로 바로잡고 BLOCKED', () => {
  try {
    const r = read3();
    const mb = r.items.find((i) => i.check_id === 'MB-01');
    mb.status = 'FAIL';
    mb.failure_code = 'MOBILE_OVERFLOW';
    write3(r);
    const out = JSON.parse(judge().stdout);
    assert.equal(out.stage3.items.find((i) => i.check_id === 'MB-01').status, 'PASS');
    assert.equal(out.verdict.run_status, 'BLOCKED');
  } finally {
    fs.writeFileSync(path.join(runDir, '03-browser.a1.json'), original3);
  }
});

test('원시 측정값이 넘침을 보이면 runner가 PASS라 해도 judge는 FAIL', () => {
  try {
    const r = read3();
    const mb = r.items.find((i) => i.check_id === 'MB-01');
    const m = mb.evidence.raw.measurements[0];
    m.scrollWidth = m.clientWidth + 50;
    write3(r);
    const out = JSON.parse(judge().stdout);
    assert.equal(out.stage3.items.find((i) => i.check_id === 'MB-01').failure_code, 'MOBILE_OVERFLOW');
    assert.equal(out.verdict.run_status, 'BLOCKED');
  } finally {
    fs.writeFileSync(path.join(runDir, '03-browser.a1.json'), original3);
  }
});

test('필수 측정값이 없거나 fingerprint가 다르면 추정하지 않는다', () => {
  try {
    const r = read3();
    delete r.items.find((i) => i.check_id === 'FA-01').evidence.raw;
    write3(r);
    const out = JSON.parse(judge().stdout);
    assert.equal(out.stage3.items.find((i) => i.check_id === 'FA-01').status, 'NEEDS_ATTENTION');
    assert.equal(out.verdict.run_status, 'BLOCKED');
    const s = JSON.parse(original3);
    s.fingerprint = 'stale';
    write3(s);
    const out2 = JSON.parse(judge().stdout);
    assert.equal(out2.stage3.reason, 'EVIDENCE_STALE');
    assert.equal(out2.verdict.run_status, 'BLOCKED');
  } finally {
    fs.writeFileSync(path.join(runDir, '03-browser.a1.json'), original3);
  }
});

test('Chrome을 찾지 못하면 stage 3 전체가 NEEDS_ATTENTION / TOOL_MISSING', async () => {
  const input = { app_path: SAMPLE, flags: FLAGS };
  const noChrome = async () => ({ launch: async () => { throw new Error('Chromium distribution chrome is not found'); } });
  const m = await measureStage3({ checksData: data, input, launcher: noChrome });
  const r = evaluateStage3(data, input, m.raws, { fingerprint: fpBefore, browser: m.browser });
  const applicable = r.items.filter((i) => i.status !== 'NOT_APPLICABLE');
  assert.ok(applicable.length > 0);
  for (const i of applicable) {
    assert.equal(i.status, 'NEEDS_ATTENTION');
    assert.equal(i.failure_code, data.policies.missing_tool.failure_code);
  }
  assert.equal(r.run_status, 'BLOCKED');
});

test('정적 index.html이 없으면 NEEDS_ATTENTION / CHECK_INCONCLUSIVE', () => withTemp(async (t) => {
  const app = makeApp(t, { 'README.md': '# x\n' });
  const input = { app_path: app, flags: FLAGS };
  const m = await measureStage3({ checksData: data, input });
  const r = evaluateStage3(data, input, m.raws, { fingerprint: 'fp', browser: m.browser });
  for (const i of r.items.filter((x) => x.status !== 'NOT_APPLICABLE')) {
    assert.equal(i.failure_code, data.policies.inconclusive.failure_code);
  }
}));

test('stage 2 결과 없이 stage 3을 실행하면 거부하고 아무것도 쓰지 않는다', () => withTemp((t) => {
  const r2 = makeHarnessCopy(t);
  const dir = path.join(r2, 'runs', 'sample-app', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({ app_path: SAMPLE, flags: FLAGS }));
  const out = JSON.parse(runNode(path.join(r2, 'scripts', 'run-stage.mjs'), ['3', dir]).stdout);
  assert.equal(out.error_code, 'STAGE_PREREQUISITE_UNMET');
  assert.deepEqual(fs.readdirSync(dir), ['input.json']);
}));
