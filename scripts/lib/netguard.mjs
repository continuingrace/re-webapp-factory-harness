// stage 4 전용 네트워크 가드. HTTPS만, 사용자정보 금지, 모든 A·AAAA 결과를 검사하고
// 검증된 주소로만 연결한다(DNS rebinding 방지). 거절된 URL에는 요청하지 않는다.
// 응답 본문·쿠키·Authorization 값은 반환하는 evidence에 넣지 않는다.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { maskUrl } from './redact.mjs';

// ---------- 주소 분류 ----------

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0);
}

function inCidr4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const n = Number(bits);
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

function classifyV4(ip) {
  if (inCidr4(ip, '127.0.0.0/8')) return 'loopback';
  if (inCidr4(ip, '0.0.0.0/8')) return 'unspecified';
  if (inCidr4(ip, '10.0.0.0/8') || inCidr4(ip, '172.16.0.0/12') || inCidr4(ip, '192.168.0.0/16')) return 'private';
  if (inCidr4(ip, '169.254.0.0/16')) return 'link_local';
  if (inCidr4(ip, '224.0.0.0/4')) return 'multicast';
  return 'public';
}

function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  let tail = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    tail = [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
    s = s.slice(0, -v4[1].length).replace(/:$/, '') || ':';
    if (s === ':') s = '::';
  }
  const [head, rest] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':').filter(Boolean) : [];
  const r = rest !== null && rest ? rest.split(':').filter(Boolean) : [];
  const fill = 8 - h.length - r.length - tail.length;
  const groups = rest !== null ? [...h, ...Array(Math.max(0, fill)).fill('0'), ...r, ...tail] : [...h, ...tail];
  return groups.map((g) => parseInt(g, 16));
}

export function classifyAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return classifyV4(ip);
  if (family !== 6) return 'invalid';
  const g = expandV6(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return 'invalid';
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return classifyV4(v4) === 'public' ? 'public' : 'ipv4_mapped_private';
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link_local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return 'public';
}

function hostDenied(host, denyHosts) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const d of denyHosts) {
    if (d.startsWith('*.')) { if (h.endsWith(d.slice(1))) return d; continue; }
    if (d.includes('/')) { if (net.isIP(h) === 4 && net.isIP(d.split('/')[0]) === 4 && inCidr4(h, d)) return d; continue; }
    if (h === d.toLowerCase()) return d;
  }
  return null;
}

// ---------- URL 검사 ----------

export { maskUrl };

export function checkUrl(raw, rule, policy) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: 'URL_NOT_HTTPS', reason: 'URL_PARSE_FAILED' };
  }
  const parts = { protocol: u.protocol, hostname: u.hostname, has_userinfo: Boolean(u.username || u.password) };
  if (u.protocol !== policy.protocol_only || u.protocol !== rule.protocol) return { ok: false, code: 'URL_NOT_HTTPS', parts };
  if (!policy.userinfo_allowed && rule.deny_userinfo && parts.has_userinfo) return { ok: false, code: 'URL_USERINFO_FORBIDDEN', parts };
  const denied = hostDenied(u.hostname, rule.deny_hosts);
  if (denied) return { ok: false, code: 'URL_PRIVATE_HOST', parts, matched: denied };
  const lit = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(lit) && policy.deny_address_categories.includes(classifyAddress(lit))) {
    return { ok: false, code: 'URL_PRIVATE_HOST', parts, matched: classifyAddress(lit) };
  }
  return { ok: true, parts, url: u };
}

// ---------- DNS와 연결 ----------

export const defaultResolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export async function resolveAndClassify(hostname, rule, policy, resolver) {
  const lit = hostname.replace(/^\[|\]$/g, '');
  const list = net.isIP(lit) ? [{ address: lit, family: net.isIP(lit) }] : await resolver(lit);
  const addrs = list.map((a) => ({ address: a.address, family: a.family, category: classifyAddress(a.address) }));
  const deniedAddr = addrs.find((a) => policy.deny_address_categories.includes(a.category) || a.category === 'invalid'
    || hostDenied(a.address, rule.deny_hosts));
  return {
    ok: addrs.length > 0 && (!policy.deny_if_any_address_denied || !deniedAddr),
    addresses: addrs,
    categories: addrs.map((a) => ({ family: a.family, category: a.category })),
  };
}

// 기본 전송 계층: 검증된 주소로 고정 연결한다. 본문은 maxBytes까지만 읽는다.
// 요청 옵션: 호스트 이름은 TLS 이름 확인(servername)에만 쓰고, 실제 연결은 검증된 주소로 고정한다.
// 인증서 검증을 끄는 옵션(rejectUnauthorized: false)은 두지 않는다.
export function requestOptions(url, { address, family, timeoutMs }) {
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    servername: url.hostname.replace(/^\[|\]$/g, ''),
    headers: { 'user-agent': 're-webapp-factory-harness', accept: '*/*' },
    lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    timeout: timeoutMs,
  };
}

export function defaultTransport(url, { address, family, timeoutMs, maxBytes, wantBody }) {
  return new Promise((resolve, reject) => {
    const req = https.request(requestOptions(url, { address, family, timeoutMs }), (res) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { tooLarge = true; res.destroy(); return; }
        if (wantBody) chunks.push(c);
      });
      const done = () => resolve({
        status: res.statusCode,
        location: res.headers.location || null,
        content_type: res.headers['content-type'] || null,
        too_large: tooLarge,
        body: wantBody && !tooLarge ? Buffer.concat(chunks) : null,
      });
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('TIMEOUT'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const INCONCLUSIVE = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

// URL을 검증하고 redirect를 따라간다. 거절되면 요청하지 않는다.
export async function guardedFetch(rawUrl, { rule, policy, resolver = defaultResolver, transport = defaultTransport, wantBody = false, attemptsTotal }) {
  let attempt = 0;
  let lastCause = null;
  while (attempt < attemptsTotal) {
    attempt += 1;
    try {
      const redirects = [];
      const dnsLog = [];
      let current = rawUrl;
      for (;;) {
        const chk = checkUrl(current, rule, policy);
        if (!chk.ok) return { denied: true, code: chk.code, masked_url: maskUrl(current), redirects, dns: dnsLog, attempts: attempt, requests: redirects.length };
        const r = await resolveAndClassify(chk.url.hostname, rule, policy, resolver);
        dnsLog.push({ host_masked: maskUrl(`${chk.url.protocol}//${chk.url.host}/`), categories: r.categories });
        if (!r.ok) return { denied: true, code: 'URL_PRIVATE_HOST', masked_url: maskUrl(current), redirects, dns: dnsLog, attempts: attempt, requests: redirects.length };
        const pick = r.addresses[0];
        const res = await transport(chk.url, { address: pick.address, family: pick.family, timeoutMs: rule.request_timeout_ms, maxBytes: rule.max_html_bytes, wantBody });
        if (res.status >= 300 && res.status < 400 && res.location) {
          if (redirects.length >= rule.max_redirects) {
            return { limit_exceeded: 'max_redirects', masked_url: maskUrl(current), redirects, dns: dnsLog, attempts: attempt, requests: redirects.length + 1 };
          }
          const next = new URL(res.location, chk.url).toString();
          redirects.push({ status: res.status, to_masked: maskUrl(next) });
          current = next;
          continue;
        }
        if (res.too_large) return { limit_exceeded: 'max_html_bytes', masked_url: maskUrl(current), redirects, dns: dnsLog, attempts: attempt, status: res.status, requests: redirects.length + 1 };
        return {
          final_status: res.status,
          final_url: current,
          masked_url: maskUrl(current),
          content_type: res.content_type,
          body: res.body,
          redirects,
          redirect_count: redirects.length,
          dns: dnsLog,
          attempts: attempt,
          requests: redirects.length + 1,
        };
      }
    } catch (e) {
      lastCause = e.code || 'NETWORK_ERROR';
      if (!INCONCLUSIVE.has(lastCause) && lastCause !== 'NETWORK_ERROR') break;
    }
  }
  return { inconclusive: true, cause: lastCause, attempts: attempt, masked_url: maskUrl(rawUrl) };
}
