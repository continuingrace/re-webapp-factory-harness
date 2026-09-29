// Stage 4 운영 측정 (harness-runner 전용). netguard를 통해서만 요청한다.
// 판정은 하지 않고 원시 측정값(마스킹된 URL, 상태 코드, redirect 수, 자산 수, DNS 분류)만 반환한다.
import { getCheck } from '../lib/checks.mjs';
import { guardedFetch, maskUrl } from '../lib/netguard.mjs';
import { operatingUrlViolation } from '../lib/url-shape.mjs';

const HTML_LINK = /<link\b[^>]*>/gi;
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const FONT_URL = /@font-face\s*\{[^}]*?url\(\s*["']?([^"')]+)["']?\s*\)/gi;

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
  return m ? m[1] : null;
}

function discoverFromHtml(html, base) {
  const out = [];
  for (const m of html.matchAll(HTML_LINK)) {
    const rel = (attr(m[0], 'rel') || '').toLowerCase().split(/\s+/);
    const href = attr(m[0], 'href');
    if (!href) continue;
    if (rel.includes('manifest')) out.push({ kind: 'manifest', url: new URL(href, base).toString() });
    else if (rel.includes('stylesheet')) out.push({ kind: 'css', url: new URL(href, base).toString() });
    else if (rel.includes('icon') || rel.includes('apple-touch-icon')) out.push({ kind: 'icon', url: new URL(href, base).toString() });
  }
  for (const m of html.matchAll(SCRIPT_SRC)) out.push({ kind: 'js', url: new URL(m[1], base).toString() });
  return out;
}

// confirmation: approvals에서 계산한 운영 URL 확인 상태. 사용자가 미리보기로 표시(REJECT)한 URL은 요청하지 않는다.
export async function measureStage4({ checksData, input, confirmation, resolver, transport }) {
  const rule = getCheck(checksData, 'PD-01').rule;
  const policy = checksData.policies.production_network;
  const attemptsTotal = checksData.policies.inconclusive.network_attempts_total;
  const semver = new RegExp(`v?(${getCheck(checksData, 'IN-01').rule.target_version_regex.replace(/^\^|\$$/g, '')})`, 'g');
  const opts = { rule, policy, resolver, transport, attemptsTotal };
  const started = new Date().toISOString();

  const shape = operatingUrlViolation(input.operating_url, rule);
  if (shape) {
    const skipped = { skipped: 'PAGE_NOT_ACCEPTED' };
    return {
      raws: { 'PD-01': { denied: true, code: shape, masked_url: maskUrl(input.operating_url), deployment_id: input.deployment_id, requests: 0 }, 'PD-02': skipped, 'PD-03': skipped },
      started_at: started,
      ended_at: new Date().toISOString(),
      requests: 0,
    };
  }

  if (rule.deny_user_marked_preview && confirmation && confirmation.status === 'REJECT') {
    const skipped = { skipped: 'PAGE_NOT_ACCEPTED' };
    return {
      raws: { 'PD-01': { request_skipped: 'USER_MARKED_PREVIEW', masked_url: maskUrl(input.operating_url), deployment_id: input.deployment_id, requests: 0 }, 'PD-02': skipped, 'PD-03': skipped },
      started_at: started,
      ended_at: new Date().toISOString(),
      requests: 0,
    };
  }

  const page = await guardedFetch(input.operating_url, { ...opts, wantBody: true });
  const { body, final_url: finalUrl, ...pageRaw } = page;
  const raws = { 'PD-01': { ...pageRaw, deployment_id: input.deployment_id } };

  if (!(page.final_status === rule.final_status_after_redirect && body)) {
    const skipped = { skipped: 'PAGE_NOT_ACCEPTED' };
    raws['PD-02'] = skipped;
    raws['PD-03'] = skipped;
    return { raws, started_at: started, ended_at: new Date().toISOString(), requests: page.requests || 0 };
  }

  const html = body.toString('utf8');
  raws['PD-03'] = { versions_found: [...html.matchAll(semver)].map((m) => m[1]) };

  const discovered = discoverFromHtml(html, finalUrl);
  let requests = page.requests || 0;
  const assets = [];
  let truncated = false;
  const queue = [...discovered];
  const seen = new Set();
  while (queue.length) {
    const a = queue.shift();
    if (seen.has(a.url)) continue;
    if (seen.size >= rule.max_discovered_assets) { truncated = true; break; }
    seen.add(a.url);
    const needBody = a.kind === 'manifest' || a.kind === 'css';
    const r = await guardedFetch(a.url, { ...opts, wantBody: needBody });
    requests += r.requests || 0;
    assets.push({ kind: a.kind, masked_url: maskUrl(a.url), status: r.final_status ?? null, redirect_count: r.redirect_count ?? null, denied: r.denied ? r.code : null, limit_exceeded: r.limit_exceeded || null, inconclusive: r.inconclusive ? r.cause : null, dns: r.dns || [] });
    if (!r.body) continue;
    const text = r.body.toString('utf8');
    if (a.kind === 'manifest') {
      try {
        const m = JSON.parse(text);
        for (const icon of Array.isArray(m.icons) ? m.icons : []) if (icon.src) queue.push({ kind: 'manifest_icon', url: new URL(icon.src, r.final_url).toString() });
      } catch {
        assets[assets.length - 1].manifest_parse_error = true;
      }
    } else if (a.kind === 'css') {
      for (const m of text.matchAll(FONT_URL)) queue.push({ kind: 'font', url: new URL(m[1], r.final_url).toString() });
    }
  }
  raws['PD-02'] = { assets, asset_count: assets.length, truncated, kinds_found: [...new Set(assets.map((a) => a.kind))] };
  return { raws, started_at: started, ended_at: new Date().toISOString(), requests };
}
