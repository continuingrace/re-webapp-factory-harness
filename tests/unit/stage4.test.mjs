// stage 4 측정·판정. 실제 외부 URL로 요청하지 않고 모의 resolver·transport로 sample-app 파일을 돌려준다.
// 성공 경로 결과는 verification_type: judge_unit, end_to_end: false이며 실제 운영 PASS 근거가 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { measureStage4 } from '../../scripts/stages/stage4-production.mjs';
import { evaluateStage4 } from '../../scripts/stages/stage4-evaluate.mjs';

const { data } = loadChecks(REPO);
const SAMPLE = path.join(REPO, 'fixtures', 'sample-app');
const FLAGS = { sticky_preview: 'yes', effect_font: 'no', local_state: 'yes', pwa_installable: 'yes' };
const BASE = 'https://sample.example/';
const input = (url = BASE) => ({ app_path: SAMPLE, target_version: '1.0.0', release_phase: 'postdeploy', operating_url: url, deployment_id: 'd1', flags: FLAGS });
const APPROVED = { status: 'APPROVE', indexes: [0] };

function sampleMocks({ override = {} } = {}) {
  const calls = { resolve: 0, transport: 0 };
  const resolver = async () => { calls.resolve += 1; return [{ address: '93.184.216.34', family: 4 }]; };
  const transport = async (url) => {
    calls.transport += 1;
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (override[rel] === 404) return { status: 404, location: null, content_type: null, too_large: false, body: null };
    const file = path.join(SAMPLE, ...rel.split('/'));
    if (!fs.existsSync(file)) return { status: 404, location: null, content_type: null, too_large: false, body: null };
    const body = override[rel] !== undefined ? Buffer.from(override[rel]) : fs.readFileSync(file);
    return { status: 200, location: null, content_type: null, too_large: false, body };
  };
  return { resolver, transport, calls };
}

const item = (r, id) => r.items.find((i) => i.check_id === id);

test('[judge_unit, end_to_end:false] 모의 운영 응답으로 PD-01~03 판정 경로를 확인한다', async () => {
  const m = sampleMocks();
  const measured = await measureStage4({ checksData: data, input: input(), confirmation: APPROVED, resolver: m.resolver, transport: m.transport });
  const r = evaluateStage4(data, input(), measured.raws, APPROVED, { fingerprint: 'fp' });
  assert.deepEqual(r.items.map((i) => [i.check_id, i.status]), [['PD-01', 'PASS'], ['PD-02', 'PASS'], ['PD-03', 'PASS']]);
  const assets = item(r, 'PD-02').evidence.raw.assets;
  assert.ok(['manifest', 'css', 'js', 'icon', 'manifest_icon'].every((k) => assets.some((a) => a.kind === k)));
  const text = JSON.stringify(measured.raws);
  assert.ok(!text.includes('<html'));
  assert.ok(!text.includes('93.184.216.34'));
});

test('운영 URL 확인이 없으면 AWAITING_APPROVAL', async () => {
  const m = sampleMocks();
  const measured = await measureStage4({ checksData: data, input: input(), confirmation: { status: 'MISSING' }, resolver: m.resolver, transport: m.transport });
  const r = evaluateStage4(data, input(), measured.raws, { status: 'MISSING' }, { fingerprint: 'fp' });
  assert.equal(item(r, 'PD-01').status, 'AWAITING_APPROVAL');
});

test('거절 사례는 요청 0건이며 PD-02·PD-03은 NOT_RUN', async () => {
  const cases = [
    ['https://localhost/', APPROVED, 'URL_PRIVATE_HOST'],
    ['http://sample.example/', APPROVED, 'URL_NOT_HTTPS'],
    ['https://10.1.1.1/', APPROVED, 'URL_PRIVATE_HOST'],
    ['https://site.local/', APPROVED, 'URL_PRIVATE_HOST'],
    ['https://u:p@sample.example/', APPROVED, 'URL_USERINFO_FORBIDDEN'],
    [BASE, { status: 'REJECT', indexes: [0] }, 'URL_UNCONFIRMED'],
  ];
  for (const [url, conf, code] of cases) {
    const m = sampleMocks();
    const measured = await measureStage4({ checksData: data, input: input(url), confirmation: conf, resolver: m.resolver, transport: m.transport });
    const r = evaluateStage4(data, input(url), measured.raws, conf, { fingerprint: 'fp' });
    assert.equal(item(r, 'PD-01').failure_code, code, url);
    assert.equal(m.calls.transport, 0, url);
    assert.equal(item(r, 'PD-02').status, 'NOT_RUN');
    assert.equal(r.run_status, 'BLOCKED');
  }
});

test('운영 자산 404는 ASSET_NOT_200, 운영 화면 버전이 다르면 DEPLOYED_VERSION_MISMATCH', async () => {
  const m1 = sampleMocks({ override: { 'icons/icon-512.png': 404 } });
  const a = await measureStage4({ checksData: data, input: input(), confirmation: APPROVED, resolver: m1.resolver, transport: m1.transport });
  assert.equal(item(evaluateStage4(data, input(), a.raws, APPROVED, { fingerprint: 'fp' }), 'PD-02').failure_code, 'ASSET_NOT_200');
  const html = fs.readFileSync(path.join(SAMPLE, 'index.html'), 'utf8').replace('v1.0.0', 'v0.9.0');
  const m2 = sampleMocks({ override: { 'index.html': html } });
  const b = await measureStage4({ checksData: data, input: input(), confirmation: APPROVED, resolver: m2.resolver, transport: m2.transport });
  assert.equal(item(evaluateStage4(data, input(), b.raws, APPROVED, { fingerprint: 'fp' }), 'PD-03').failure_code, 'DEPLOYED_VERSION_MISMATCH');
});

test('predeploy 단계에서는 stage 4 check가 모두 NOT_APPLICABLE', () => {
  const pre = { ...input(), release_phase: 'predeploy' };
  const r = evaluateStage4(data, pre, {}, { status: 'MISSING' }, { fingerprint: 'fp' });
  assert.ok(r.items.every((i) => i.status === 'NOT_APPLICABLE'));
});
