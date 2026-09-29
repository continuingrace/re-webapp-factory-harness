// netguard 단위 테스트. 실제 DNS·네트워크를 쓰지 않고 모의 resolver·transport만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO } from './helpers.mjs';
import { getCheck, loadChecks } from '../../scripts/lib/checks.mjs';
import { checkUrl, classifyAddress, guardedFetch, maskUrl } from '../../scripts/lib/netguard.mjs';

const { data } = loadChecks(REPO);
const rule = getCheck(data, 'PD-01').rule;
const policy = data.policies.production_network;
const attemptsTotal = data.policies.inconclusive.network_attempts_total;

function mocks({ dns = { 'app.example': [{ address: '93.184.216.34', family: 4 }] }, routes = {} } = {}) {
  const calls = { resolve: [], transport: [] };
  const resolver = async (host) => {
    calls.resolve.push(host);
    if (!(host in dns)) throw Object.assign(new Error('nf'), { code: 'ENOTFOUND' });
    return dns[host];
  };
  const transport = async (url, opts) => {
    calls.transport.push({ url: url.toString(), address: opts.address });
    const r = routes[url.toString()];
    if (!r) return { status: 404, location: null, content_type: null, too_large: false, body: null };
    if (r.throw) throw Object.assign(new Error('t'), { code: r.throw });
    return { status: r.status, location: r.location || null, content_type: 'text/html', too_large: Boolean(r.too_large), body: r.body ? Buffer.from(r.body) : null };
  };
  return { resolver, transport, calls };
}

const fetchWith = (url, m) => guardedFetch(url, { rule, policy, resolver: m.resolver, transport: m.transport, attemptsTotal, wantBody: true });

test('주소 분류: loopback, private, link-local, unspecified, multicast, IPv4-mapped private', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.20.0.1'), 'private');
  assert.equal(classifyAddress('192.168.0.1'), 'private');
  assert.equal(classifyAddress('169.254.1.1'), 'link_local');
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('224.0.0.1'), 'multicast');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('::'), 'unspecified');
  assert.equal(classifyAddress('fd00::1'), 'private');
  assert.equal(classifyAddress('fe80::1'), 'link_local');
  assert.equal(classifyAddress('ff02::1'), 'multicast');
  assert.equal(classifyAddress('::ffff:10.0.0.1'), 'ipv4_mapped_private');
  assert.equal(classifyAddress('::ffff:93.184.216.34'), 'public');
  assert.equal(classifyAddress('93.184.216.34'), 'public');
  assert.equal(classifyAddress('2606:2800:220:1:248:1893:25c8:1946'), 'public');
});

test('URL 거절: http, 사용자정보, localhost, .local, 비공개 IP 리터럴', () => {
  assert.equal(checkUrl('http://app.example/', rule, policy).code, 'URL_NOT_HTTPS');
  assert.equal(checkUrl('https://u:p@app.example/', rule, policy).code, 'URL_USERINFO_FORBIDDEN');
  assert.equal(checkUrl('https://localhost/', rule, policy).code, 'URL_PRIVATE_HOST');
  assert.equal(checkUrl('https://my.local/', rule, policy).code, 'URL_PRIVATE_HOST');
  assert.equal(checkUrl('https://10.0.0.5/', rule, policy).code, 'URL_PRIVATE_HOST');
  assert.equal(checkUrl('https://[::1]/', rule, policy).code, 'URL_PRIVATE_HOST');
  assert.equal(checkUrl('https://app.example/', rule, policy).ok, true);
});

test('거절된 URL에는 DNS 조회와 요청이 0건', async () => {
  for (const url of ['http://app.example/', 'https://u:p@app.example/', 'https://localhost/', 'https://my.local/', 'https://192.168.0.10/', 'https://[::1]/']) {
    const m = mocks();
    const r = await fetchWith(url, m);
    assert.equal(r.denied, true, url);
    assert.equal(m.calls.transport.length, 0, url);
    assert.equal(m.calls.resolve.length, 0, url);
  }
});

test('DNS 결과 중 하나라도 비공개면 요청하지 않는다', async () => {
  const m = mocks({ dns: { 'app.example': [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 }] } });
  const r = await fetchWith('https://app.example/', m);
  assert.equal(r.code, 'URL_PRIVATE_HOST');
  assert.equal(m.calls.transport.length, 0);
  assert.deepEqual(r.dns[0].categories.map((c) => c.category), ['public', 'ipv4_mapped_private']);
});

test('검증한 주소로만 연결한다 (DNS rebinding 방지)', async () => {
  const m = mocks({ routes: { 'https://app.example/': { status: 200, body: '<p>v1.0.0</p>' } } });
  const r = await fetchWith('https://app.example/', m);
  assert.equal(r.final_status, 200);
  assert.equal(m.calls.resolve.length, 1);
  assert.deepEqual(m.calls.transport.map((c) => c.address), ['93.184.216.34']);
});

test('redirect 목적지는 요청 전에 다시 검증한다', async () => {
  const m = mocks({ routes: { 'https://app.example/': { status: 302, location: 'https://10.0.0.9/admin' } } });
  const r = await fetchWith('https://app.example/', m);
  assert.equal(r.code, 'URL_PRIVATE_HOST');
  assert.equal(m.calls.transport.length, 1);
});

test('redirect 수가 max_redirects를 넘으면 PASS로 추정하지 않는다', async () => {
  const routes = {};
  for (let i = 0; i <= rule.max_redirects + 1; i += 1) routes[`https://app.example/r${i}`] = { status: 302, location: `https://app.example/r${i + 1}` };
  const m = mocks({ routes });
  const r = await fetchWith('https://app.example/r0', m);
  assert.equal(r.limit_exceeded, 'max_redirects');
  assert.equal(m.calls.transport.length, rule.max_redirects + 1);
});

test('timeout은 정책 횟수만큼 시도한 뒤 판정 불가', async () => {
  const m = mocks({ routes: { 'https://app.example/': { throw: 'ETIMEDOUT' } } });
  const r = await fetchWith('https://app.example/', m);
  assert.equal(r.inconclusive, true);
  assert.equal(r.attempts, attemptsTotal);
  assert.equal(r.cause, 'ETIMEDOUT');
});

test('URL 마스킹: 사용자정보·쿼리 값·fragment 제거', () => {
  assert.equal(maskUrl('https://u:p@app.example/a?token=abc&x=1#frag'), 'https://app.example/a?token=***&x=***');
});
