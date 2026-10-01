// D1: 글자 크기 단계(DS-07), radius 전환(DS-02), design contract 검사(MB-08~10)와 비차단 간격 진단.
// 판정 함수 단위 테스트(합성 원시 값)와 설치된 Chrome으로 실제 측정하는 테스트, 정상 레이아웃 반례를 함께 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_IDS, REPO, GOOD_CSS, goodApp, goodInput, makeApp, makeHarnessCopy, runNode, withTemp, writeFiles } from './helpers.mjs';
import { getCheck, loadChecks } from '../../scripts/lib/checks.mjs';
import { judgeStatic } from '../../scripts/stages/stage2-static.mjs';
import { evaluateStage3 } from '../../scripts/stages/stage3-evaluate.mjs';
import { measureStage3 } from '../../scripts/stages/stage3-browser.mjs';

const { data } = loadChecks(REPO);
const CONTRACT_IDS = ['MB-08', 'MB-09', 'MB-10'];

// ---------- DS-07·DS-02 (CSS) ----------

function staticItem(t, css, id) {
  const app = makeApp(t, { ...goodApp(), 'src/style.css': css });
  return judgeStatic({ root: REPO, checksData: data, input: goodInput(app), identifiers: FIXTURE_IDS }).items.find((i) => i.check_id === id);
}

test('DS-07: px 글자 크기는 토큰 단계만 허용하고, px 외 단위·var()·calc()는 다른 DS와 같이 NEEDS_ATTENTION', () => withTemp((t) => {
  assert.equal(staticItem(t, `${GOOD_CSS}h1 { font-size: 28px; }\np { font-size: 15px; }\nlabel { font-size: inherit; }\n`, 'DS-07').status, 'PASS');
  const bad = staticItem(t, `${GOOD_CSS}p { font-size: 16px; }\n`, 'DS-07');
  assert.deepEqual([bad.status, bad.failure_code], ['FAIL', 'DESIGN_FONT_SIZE']);
  assert.equal(bad.evidence.violations[0].token, '16px');
  for (const v of ['1rem', '1.2em', '80%', 'var(--fs)', 'calc(1rem + 2px)']) {
    const item = staticItem(t, `${GOOD_CSS}p { font-size: ${v}; }\n`, 'DS-07');
    assert.deepEqual([item.status, item.failure_code], ['NEEDS_ATTENTION', 'CHECK_INCONCLUSIVE'], v);
  }
  // 기존 DS 단위 정책과 같은지 (DS-03 간격의 rem도 같은 결과)
  assert.equal(staticItem(t, `${GOOD_CSS}p { margin: 1rem; }\n`, 'DS-03').status, 'NEEDS_ATTENTION');
  assert.equal(staticItem(t, GOOD_CSS, 'DS-07').status, 'PASS', '글자 크기 선언이 없으면 통과');
}));

test('DS-02: 역할별 radius 0·12px·16px·9999px만 허용하고, 이전 카드 24px과 토큰 밖 값은 거부', () => withTemp((t) => {
  for (const v of ['12px', '16px', '9999px']) assert.equal(staticItem(t, `${GOOD_CSS}.x { border-radius: ${v}; }\n`, 'DS-02').status, 'PASS', v);
  const card = staticItem(t, `${GOOD_CSS}.card { border-radius: 24px; }\n`, 'DS-02');
  assert.deepEqual([card.status, card.failure_code], ['FAIL', 'DESIGN_RADIUS'], '전환 기간 종료');
  assert.equal(staticItem(t, `${GOOD_CSS}.x { border-radius: 20px; }\n`, 'DS-02').failure_code, 'DESIGN_RADIUS');
  const rule = getCheck(data, 'DS-02').rule;
  assert.deepEqual(rule.allowed, ['0', '12px', '16px', '9999px']);
  assert.equal(rule.transitional, undefined);
}));

// ---------- 판정 함수 (합성 원시 값) ----------

function judge(id, raw) {
  return evaluateStage3(data, goodInput('x'), { [id]: raw }, { fingerprint: 'fp', browser: null }).items.find((i) => i.check_id === id);
}
const kid = (element, role, top, bottom) => ({ element, role, top, bottom });

// 계약 선언 개수 (data-ui·data-type). 기본은 둘 다 선언한 완전한 계약.
const FULL = { ui: 3, type: 3 };

test('MB-08 필드 그룹: 라벨→field ≤ 8px, field→다음 ≥ 12px (허용 오차 0.5px), 계약이 전혀 없으면 N/A', () => {
  const group = (labelBottom, fieldTop, fieldBottom, nextTop) => ({ group: 'div.field', children: [kid('label', 'label', 0, labelBottom), kid('textarea#note', 'field', fieldTop, fieldBottom), kid('p#status', 'other', nextTop, nextTop + 20)] });
  const raw = (groups, contract = true) => ({ viewport: [390, 844], contract_present: contract, declared: contract ? FULL : { ui: 0, type: 0 }, declared_groups: groups.length, groups, fields_outside_group: [], spacing_variety: [] });
  assert.equal(judge('MB-08', raw([group(20, 28, 188, 200)])).status, 'PASS');
  assert.equal(judge('MB-08', raw([group(20, 28, 188, 199.5)])).status, 'PASS', '경계: 11.5px은 오차 안');
  const tight = judge('MB-08', raw([group(20, 28, 188, 196)]));
  assert.deepEqual([tight.status, tight.failure_code], ['FAIL', 'FIELD_SPACING']);
  assert.equal(tight.evidence.derived.results[0].field_to_next_px, 8);
  assert.equal(judge('MB-08', raw([group(20, 32, 188, 200)])).failure_code, 'FIELD_SPACING', '라벨→field 12px');
  assert.equal(judge('MB-08', raw([{ group: 'div.field', children: [kid('label', 'label', 0, 20), kid('p', 'other', 28, 48)] }])).failure_code, 'FIELD_GROUP_WITHOUT_FIELD');
  assert.equal(judge('MB-08', raw([{ group: 'div.field', children: [kid('label', 'label', 0, 20), kid('textarea', 'field', 28, 188)] }])).status, 'PASS', 'field가 마지막이면 다음 간격 없음');
  const na = judge('MB-08', raw([], false));
  assert.deepEqual([na.status, na.evidence.reason], ['NOT_APPLICABLE', 'DESIGN_CONTRACT_ABSENT']);
  assert.equal(judge('MB-08', raw([])).evidence.reason, 'NO_FIELD_GROUP', '계약은 있지만 입력 필드가 없는 화면');
});

test('MB-08 부분·잘못된 계약: 그룹 밖 field는 FAIL, 선언한 그룹이 보이지 않으면 NEEDS_ATTENTION', () => {
  const base = { viewport: [390, 844], contract_present: true, declared: FULL, spacing_variety: [] };
  const outside = judge('MB-08', { ...base, declared_groups: 0, groups: [], fields_outside_group: ['textarea#note'] });
  assert.deepEqual([outside.status, outside.failure_code], ['FAIL', 'FIELD_OUTSIDE_GROUP']);
  const hidden = judge('MB-08', { ...base, declared_groups: 1, groups: [], fields_outside_group: [] });
  assert.deepEqual([hidden.status, hidden.failure_code, hidden.evidence.reason], ['NEEDS_ATTENTION', 'CHECK_INCONCLUSIVE', 'NO_VISIBLE_FIELD_GROUP']);
  assert.equal(judge('MB-08', { ...base, groups: [] }).failure_code, 'CHECK_INCONCLUSIVE', '측정값 누락');
});

test('MB-09 글자 역할: 의미 역할 토큰과 계산된 크기·굵기 일치, 태그 이름·모르는 토큰 거부', () => {
  const raw = (elements, contract = true, declared = FULL) => ({ viewport: [390, 844], contract_present: contract, declared: contract ? declared : { ui: 0, type: 0 }, elements });
  const el = (token, size, weight) => ({ element: 'p', token, font_size_px: size, font_weight: weight });
  assert.equal(judge('MB-09', raw([el('body', 15, 400), el('body-sm', 13, 400), el('subsection', 20, 700), el('label', 12, 600), el('title', 28, 700), el('section', 24, 700), el('emphasis', 17, 600)])).status, 'PASS');
  const size = judge('MB-09', raw([el('body', 16, 400)]));
  assert.deepEqual([size.status, size.failure_code], ['FAIL', 'TYPE_TOKEN_MISMATCH']);
  assert.equal(judge('MB-09', raw([el('label', 12, 400)])).failure_code, 'TYPE_TOKEN_MISMATCH', '굵기 불일치');
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'subtitle']) assert.equal(judge('MB-09', raw([el(tag, 20, 700)])).failure_code, 'TYPE_TOKEN_UNKNOWN', tag);
  assert.equal(judge('MB-09', raw([el('body', 15.4, 400)])).status, 'PASS', '오차 0.5px');
  assert.equal(judge('MB-09', raw([], false)).status, 'NOT_APPLICABLE');
  const partial = judge('MB-09', raw([], true, { ui: 2, type: 0 }));
  assert.deepEqual([partial.status, partial.failure_code], ['FAIL', 'CONTRACT_INCOMPLETE'], 'data-ui만 선언');
  const hidden = judge('MB-09', raw([], true, { ui: 2, type: 1 }));
  assert.deepEqual([hidden.status, hidden.failure_code], ['NEEDS_ATTENTION', 'CHECK_INCONCLUSIVE'], '선언했지만 보이는 요소 없음');
  assert.deepEqual(Object.keys(getCheck(data, 'MB-09').rule.tokens).filter((k) => /^h\d$/.test(k)), [], '토큰에 태그 이름 없음');
});

test('MB-10 역할별 radius: 토큰 일치, pill 형태 버튼은 pill 역할 필요, 원형 아이콘 버튼은 제외', () => {
  const r4 = (v) => [v, v, v, v];
  const raw = (elements, pills = [], contract = true, declared = FULL) => ({ viewport: [390, 844], contract_present: contract, declared: contract ? declared : { ui: 0, type: 0 }, elements, pill_candidates: pills });
  const e = (role, radius, width = 300, height = 48) => ({ element: role, role, radii: r4(radius), width, height });
  assert.equal(judge('MB-10', raw([e('field', '12px'), e('button', '12px', 90, 48), e('card', '16px'), e('pill', '9999px', 80, 32), e('field-group', '0px')])).status, 'PASS');
  const card = judge('MB-10', raw([e('card', '24px')]));
  assert.deepEqual([card.status, card.failure_code], ['FAIL', 'RADIUS_ROLE_MISMATCH']);
  assert.equal(judge('MB-10', raw([e('button', '9999px', 90, 48)])).failure_code, 'RADIUS_ROLE_MISMATCH', '일반 버튼을 pill로');
  assert.equal(judge('MB-10', raw([], [{ element: 'button#clear', role: null, radii: r4('9999px'), width: 90, height: 48 }])).failure_code, 'PILL_ROLE_MISSING');
  assert.equal(judge('MB-10', raw([e('card', '16px')], [{ element: 'button.fab', role: null, radii: r4('50%'), width: 48, height: 48 }])).status, 'PASS', '반례: 원형 아이콘 버튼');
  assert.equal(judge('MB-10', raw([e('pill', '50%', 80, 32)])).status, 'PASS', '% radius 환산');
  assert.equal(judge('MB-10', raw([e('pill', '8px', 80, 32)])).failure_code, 'RADIUS_ROLE_MISMATCH', 'pill 역할인데 pill 형태가 아님');
  assert.equal(judge('MB-10', raw([], [], false)).status, 'NOT_APPLICABLE');
  assert.equal(judge('MB-10', raw([e('field-group', '0px')])).evidence.reason, 'NO_RADIUS_ROLE', 'field-group만 있으면 radius 대상 없음');
});

test('MB-10 부분·잘못된 계약: 정해지지 않은 data-ui 값과 data-type만 선언한 계약은 FAIL, 보이는 대상이 없으면 NEEDS_ATTENTION', () => {
  const r4 = (v) => [v, v, v, v];
  const raw = (elements, declared = FULL) => ({ viewport: [390, 844], contract_present: true, declared, elements, pill_candidates: [] });
  const typo = judge('MB-10', raw([{ element: 'textarea', role: 'feild', radii: r4('12px'), width: 300, height: 120 }]));
  assert.deepEqual([typo.status, typo.failure_code], ['FAIL', 'CONTRACT_INVALID']);
  const typeOnly = judge('MB-10', raw([], { ui: 0, type: 4 }));
  assert.deepEqual([typeOnly.status, typeOnly.failure_code], ['FAIL', 'CONTRACT_INCOMPLETE']);
  const hidden = judge('MB-10', raw([], { ui: 2, type: 4 }));
  assert.deepEqual([hidden.status, hidden.failure_code], ['NEEDS_ATTENTION', 'CHECK_INCONCLUSIVE']);
});

test('비차단 진단: 간격 종류 수는 원시 값에만 남고 MB-08 판정에 영향을 주지 않는다', () => {
  const raw = { viewport: [390, 844], contract_present: true, declared: FULL, declared_groups: 1, fields_outside_group: [], groups: [{ group: 'div.field', children: [kid('label', 'label', 0, 20), kid('textarea', 'field', 28, 188), kid('p', 'other', 200, 220)] }],
    spacing_variety: [{ container: 'section.editor', gaps: [8, 16, 32, 24, 4], distinct: 5 }] };
  const item = judge('MB-08', raw);
  assert.equal(item.status, 'PASS');
  assert.equal(item.evidence.raw.spacing_variety[0].distinct, 5);
});

// ---------- 실제 브라우저 측정 (설치된 Chrome) ----------

// 3단계 측정은 contract check만 하도록 줄인다 (마스킹용 ST-03 등 다른 단계 check는 유지).
const contractOnly = () => ({ ...data, checks: data.checks.filter((c) => c.stage !== 3 || CONTRACT_IDS.includes(c.check_id)) });
async function measure(t, html, css) {
  const app = makeApp(t, { ...goodApp(), 'index.html': html, 'src/style.css': css });
  const input = goodInput(app);
  const checksData = contractOnly();
  const m = await measureStage3({ checksData, input });
  const items = evaluateStage3(checksData, input, m.raws, { fingerprint: 'fp', browser: m.browser }).items;
  return { m, by: Object.fromEntries(items.map((i) => [i.check_id, i])) };
}
const page = (body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="src/style.css"><title>T</title></head><body data-type="body">${body}</body></html>`;
const BASE_CSS = `body { margin: 0; font-family: "Pretendard Variable", sans-serif; font-size: 15px; font-weight: 400; line-height: 1.5; }
main { padding: 16px; } p, h2, label { margin: 0; }
.field { display: flex; flex-direction: column; gap: 8px; } .status { margin-top: 4px; font-size: 13px; }
label { font-size: 12px; font-weight: 600; } h2 { font-size: 20px; font-weight: 700; }
textarea { display: block; min-height: 120px; margin: 0; border: 0; border-radius: 12px; padding: 12px; font: inherit; }
button { min-height: 44px; padding: 12px 24px; border: 1px solid #ccc; border-radius: 12px; background: #fff; font: inherit; }
.card { border-radius: 16px; padding: 16px; background: #f3f3f3; }
`;
const GOOD_BODY = `<main><section class="card" data-ui="card"><h2 data-type="subsection">미리보기</h2></section>
<div class="field" data-ui="field-group"><label for="n" data-type="label">메모</label><textarea id="n" data-ui="field"></textarea><p class="status" role="status" data-type="body-sm">준비됨</p></div>
<button type="button" data-ui="button">지우기</button></main>`;

test('브라우저: contract를 지킨 화면은 MB-08~10 PASS이고 간격 진단이 기록된다', { timeout: 120000 }, () => withTemp(async (t) => {
  const { by } = await measure(t, page(GOOD_BODY), BASE_CSS);
  for (const id of CONTRACT_IDS) assert.equal(by[id].status, 'PASS', `${id}: ${JSON.stringify(by[id].evidence.derived || by[id].evidence)}`);
  assert.ok(Array.isArray(by['MB-08'].evidence.raw.spacing_variety));
  assert.equal(by['MB-08'].evidence.derived.results[0].field_to_next_px, 12);
}));

test('브라우저: 입력 뒤 8px·body-sm 15px·카드 24px·pill 일반 버튼은 각각 정확한 코드로 FAIL', { timeout: 120000 }, () => withTemp(async (t) => {
  const css = `${BASE_CSS}.status { margin-top: 0; font-size: 15px; } .card { border-radius: 24px; } button { border-radius: 9999px; }\n`;
  const { by } = await measure(t, page(GOOD_BODY), css);
  assert.deepEqual([by['MB-08'].status, by['MB-08'].failure_code], ['FAIL', 'FIELD_SPACING']);
  assert.deepEqual([by['MB-09'].status, by['MB-09'].failure_code], ['FAIL', 'TYPE_TOKEN_MISMATCH']);
  assert.deepEqual([by['MB-10'].status, by['MB-10'].failure_code], ['FAIL', 'RADIUS_ROLE_MISMATCH']);
}));

test('브라우저: 부분·잘못된 계약은 N/A로 빠지지 않는다 (data-ui만·data-type만·그룹 밖 field·오타·태그 이름 토큰·숨긴 선언)', { timeout: 180000 }, () => withTemp(async (t) => {
  const noType = (body) => page(body).replace(' data-type="body"', '');
  const uiOnly = await measure(t, noType('<main><section class="card" data-ui="card"><h2>미리보기</h2></section><button type="button" data-ui="button">지우기</button></main>'), BASE_CSS);
  assert.deepEqual([uiOnly.by['MB-09'].status, uiOnly.by['MB-09'].failure_code], ['FAIL', 'CONTRACT_INCOMPLETE'], 'data-ui만');
  const typeOnly = await measure(t, page('<main><h2 data-type="subsection">제목</h2><p data-type="body-sm">설명</p></main>'), BASE_CSS);
  assert.deepEqual([typeOnly.by['MB-10'].status, typeOnly.by['MB-10'].failure_code], ['FAIL', 'CONTRACT_INCOMPLETE'], 'data-type만');
  const misc = await measure(t, page(`<main><label for="n" data-type="label">메모</label><textarea id="n" data-ui="feild"></textarea>
<input aria-label="검색" data-ui="field"><h2 data-type="h2">제목</h2></main>`), BASE_CSS);
  assert.deepEqual([misc.by['MB-08'].status, misc.by['MB-08'].failure_code], ['FAIL', 'FIELD_OUTSIDE_GROUP'], '그룹 밖 field');
  assert.deepEqual([misc.by['MB-09'].status, misc.by['MB-09'].failure_code], ['FAIL', 'TYPE_TOKEN_UNKNOWN'], '태그 이름 토큰');
  assert.deepEqual([misc.by['MB-10'].status, misc.by['MB-10'].failure_code], ['FAIL', 'CONTRACT_INVALID'], 'data-ui 오타');
  const hidden = await measure(t, noType(`<main><div data-ui="field-group" hidden><label for="n" data-type="label">메모</label><textarea id="n" data-ui="field"></textarea></div>
<section data-ui="card" style="display:none"><p data-type="body">숨김</p></section></main>`), BASE_CSS);
  for (const id of CONTRACT_IDS) assert.deepEqual([hidden.by[id].status, hidden.by[id].failure_code], ['NEEDS_ATTENTION', 'CHECK_INCONCLUSIVE'], `${id} 숨긴 선언`);
}));

test('브라우저 반례: contract 없는 앱은 N/A, 간격이 제각각인 grid·그룹 밖 검색창·원형 아바타·chip pill·rem 글자는 막지 않는다', { timeout: 120000 }, () => withTemp(async (t) => {
  const plain = await measure(t, page('<main><h1>제목</h1><p>본문</p><input aria-label="검색"><button type="button" style="border-radius:9999px">pill</button></main>').replace(' data-type="body"', ''), BASE_CSS);
  for (const id of CONTRACT_IDS) assert.deepEqual([plain.by[id].status, plain.by[id].evidence.reason], ['NOT_APPLICABLE', 'DESIGN_CONTRACT_ABSENT'], id);
  const body = `<header><input type="search" aria-label="검색" style="margin:0"><span>헤더</span></header>
<main style="display:grid; grid-template-columns: 1fr; row-gap: 0"><div style="margin-bottom:4px">a</div><div style="margin-bottom:32px">b</div><div style="margin-bottom:12px">c</div><div>d</div>
<img alt="" src="icons/favicon.svg" width="40" height="40" style="border-radius:50%">
<button type="button" class="fab" data-ui="pill" style="width:48px;height:48px;padding:0;border-radius:50%">+</button>
<span data-ui="pill" style="display:inline-block; padding:4px 12px; border-radius:9999px">chip</span>
<p data-type="body" style="font-size:1rem">rem 본문</p></main>`;
  const { by } = await measure(t, page(body), `${BASE_CSS}html { font-size: 15px; }\n`);
  assert.equal(by['MB-08'].evidence.reason, 'NO_FIELD_GROUP', '그룹 밖 검색창은 측정하지 않음');
  assert.equal(by['MB-09'].status, 'PASS', JSON.stringify(by['MB-09'].evidence.derived));
  assert.equal(by['MB-10'].status, 'PASS', JSON.stringify(by['MB-10'].evidence.derived));
  assert.ok(by['MB-08'].evidence.raw.spacing_variety.some((s) => s.distinct >= 3), '간격 다양성은 진단에만 기록');
}));

test('report-run: MB-08의 간격 진단은 비차단 절로만 표시되고 판정 근거가 아님을 밝힌다', () => withTemp((t) => {
  const root = makeHarnessCopy(t);
  const dir = path.join(root, 'runs', 'sample-app', '20261001-090000-KST-abc999');
  const result = (stage, items) => JSON.stringify({ stage, run_status: 'AWAITING_DEPLOYMENT', standards_version: data.standards_version, items, attempt: 1, complete: true });
  writeFiles(dir, {
    'input.json': JSON.stringify(goodInput(path.join(root, 'app'))),
    'run.json': JSON.stringify({ run_id: '20261001-090000-KST-abc999', app_slug: 'sample-app', status: 'AWAITING_DEPLOYMENT', deployment: [], pre_record_authorizations: [], conflicts: [], judgements: [] }),
    'approvals.json': '[]',
    '03-browser.a1.json': result(3, [{ check_id: 'MB-08', status: 'NOT_APPLICABLE', failure_code: null, evidence: { reason: 'DESIGN_CONTRACT_ABSENT', raw: { spacing_variety: [{ container: 'section.editor', gaps: [8, 16, 32], distinct: 3 }] } } }]),
  });
  const r = runNode(path.join(root, 'scripts', 'orchestrator', 'report-run.mjs'), [dir]);
  assert.equal(r.status, 0, r.stdout);
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.ok(md.includes('## 7-1. 비차단 진단') && md.includes('| section.editor | 8, 16, 32 | 3 |') && md.includes('판정 근거가 아닙니다'));
}));

test('checks.json: 새 check 4개의 출처·실패 코드·contract 정책', () => {
  for (const id of ['DS-07', ...CONTRACT_IDS]) {
    const c = getCheck(data, id);
    assert.ok(c.source_reference.startsWith('standards/default-design.md#'), id);
    assert.ok(c.failure_code.length >= 1, id);
  }
  for (const id of CONTRACT_IDS) assert.equal(getCheck(data, id).rule.no_contract, 'NOT_APPLICABLE');
  assert.deepEqual(getCheck(data, 'MB-10').rule.roles, { field: '12px', button: '12px', card: '16px', pill: '9999px' });
});
