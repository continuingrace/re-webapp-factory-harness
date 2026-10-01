// Stage 3 브라우저 측정 (harness-runner 전용). 설치된 Chrome을 channel로 실행하고,
// 사용자 프로필(userDataDir)을 쓰지 않으며 측정마다 새 임시 context를 쓴다.
// 판정은 하지 않고 원시 측정값만 반환한다 (판정은 stage3-evaluate.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { appliesWhen } from '../lib/checks.mjs';
import { startStaticServer } from '../lib/local-server.mjs';
import { stage3Checks } from './stage3-evaluate.mjs';
import { getCheck } from '../lib/checks.mjs';
import { redactText } from '../lib/redact.mjs';

// 백그라운드 통신 최소화용 실행 인자 (판정 값이 아님)
const QUIET_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
];

function browserTool(checksData) {
  return checksData.required_tools.find((t) => t.name === 'browser');
}

async function withContext(browser, options, track, fn) {
  const context = await browser.newContext(options);
  context.on('request', (req) => track(req.url()));
  try {
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

async function overflowOf(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    body_visible: Boolean(document.body) && document.body.getBoundingClientRect().height > 0
      && getComputedStyle(document.body).visibility !== 'hidden',
  }));
}

function shotPath(evidence, name) {
  return evidence ? { abs: path.join(evidence.dir, name), rel: `${evidence.rel}/${name}` } : null;
}

async function measureOverflow(ctx, check) {
  const rule = check.rule;
  const viewports = rule.viewports || [rule.viewport];
  const measurements = [];
  for (const vp of viewports) {
    measurements.push(await withContext(ctx.browser, { viewport: { width: vp[0], height: vp[1] } }, ctx.track, async (page) => {
      await page.goto(ctx.origin, { waitUntil: 'load' });
      const m = await overflowOf(page);
      const shot = shotPath(ctx.evidence, `${check.check_id}-${vp[0]}x${vp[1]}.png`);
      if (shot) await page.screenshot({ path: shot.abs, fullPage: false });
      return { viewport: vp, ...m, screenshot: shot ? shot.rel : null };
    }));
  }
  return { measurements };
}

async function measureTargets(ctx, check) {
  const rule = check.rule;
  return withContext(ctx.browser, { viewport: { width: rule.viewport[0], height: rule.viewport[1] } }, ctx.track, async (page) => {
    await page.goto(ctx.origin, { waitUntil: 'load' });
    const targets = await page.evaluate((selectors) => [...document.querySelectorAll(selectors.join(','))]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`, width: r.width, height: r.height };
      }), rule.selectors);
    return { viewport: rule.viewport, targets };
  });
}

async function measureSticky(ctx, check) {
  const rule = check.rule;
  const perViewport = [];
  for (const vp of rule.viewports) {
    perViewport.push(await withContext(ctx.browser, { viewport: { width: vp[0], height: vp[1] } }, ctx.track, async (page) => {
      await page.goto(ctx.origin, { waitUntil: 'load' });
      const before = await page.evaluate(({ selector, others }) => {
        const el = document.querySelector(selector);
        if (!el) return { found: false };
        const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const r = el.getBoundingClientRect();
        const overlaps = [];
        for (const sel of others) {
          for (const o of document.querySelectorAll(sel)) {
            if (el.contains(o) || o.contains(el)) continue;
            const a = area(r, o.getBoundingClientRect());
            if (a > 0) overlaps.push({ with: sel, area: a, phase: 'initial' });
          }
        }
        const cs = getComputedStyle(el);
        const cssTop = (cs.position === 'sticky' || cs.position === 'fixed') && cs.top.endsWith('px') ? parseFloat(cs.top) : null;
        return { found: true, css_top_px: cssTop, position: cs.position, rect_top_before: r.top, overlaps };
      }, { selector: rule.selector, others: rule.max_overlap_with });
      if (!before.found) return { viewport: vp, found: false };
      await page.evaluate((y) => window.scrollTo(0, y), rule.scroll_px);
      await page.waitForTimeout(100);
      const after = await page.evaluate(({ selector, others }) => {
        const el = document.querySelector(selector);
        const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const r = el.getBoundingClientRect();
        const overlaps = [];
        for (const sel of others) {
          for (const o of document.querySelectorAll(sel)) {
            if (el.contains(o) || o.contains(el)) continue;
            const pos = getComputedStyle(o).position;
            if (pos !== 'fixed' && pos !== 'sticky') continue;
            const a = area(r, o.getBoundingClientRect());
            if (a > 0) overlaps.push({ with: sel, area: a, phase: 'after_scroll_fixed_or_sticky' });
          }
        }
        return { rect_top_after: r.top, scroll_y: window.scrollY, overlaps };
      }, { selector: rule.selector, others: rule.max_overlap_with });
      const shot = shotPath(ctx.evidence, `${check.check_id}-${vp[0]}x${vp[1]}.png`);
      if (shot) await page.screenshot({ path: shot.abs, fullPage: false });
      return {
        viewport: vp,
        found: true,
        position: before.position,
        css_top_px: before.css_top_px,
        rect_top_before: before.rect_top_before,
        rect_top_after: after.rect_top_after,
        scroll_y: after.scroll_y,
        overlaps: [...before.overlaps, ...after.overlaps],
        overlap_method: 'initial: 모든 대상 요소 / after_scroll: fixed·sticky 요소만',
        screenshot: shot ? shot.rel : null,
      };
    }));
  }
  return { per_viewport: perViewport };
}

async function measureFontFallback(ctx, check) {
  const rule = check.rule;
  const re = new RegExp(rule.block_requests_matching, 'i');
  let blocked = 0;
  return withContext(ctx.browser, { viewport: { width: rule.viewport[0], height: rule.viewport[1] } }, ctx.track, async (page, context) => {
    await context.route((url) => re.test(url.href), (route) => {
      blocked += 1;
      return route.abort();
    });
    await page.goto(ctx.origin, { waitUntil: 'load' });
    const m = await overflowOf(page);
    const shot = shotPath(ctx.evidence, `${check.check_id}-${rule.viewport[0]}x${rule.viewport[1]}.png`);
    if (shot) await page.screenshot({ path: shot.abs, fullPage: false });
    return { viewport: rule.viewport, blocked_requests: blocked, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, screenshot: shot ? shot.rel : null };
  });
}

async function measureFontLoaded(ctx, check) {
  const families = Array.isArray(ctx.input.effect_font_families) ? ctx.input.effect_font_families : [];
  if (!families.length) return { families: [] };
  return withContext(ctx.browser, {}, ctx.track, async (page) => {
    await page.goto(ctx.origin, { waitUntil: 'load' });
    const result = await page.evaluate(async (fams) => {
      await document.fonts.ready;
      return fams.map((f) => ({ family: f, loaded: document.fonts.check(`16px "${f}"`) }));
    }, families);
    return { families: result };
  });
}

async function measureConsole(ctx) {
  return withContext(ctx.browser, {}, ctx.track, async (page) => {
    const messages = [];
    let consoleErrors = 0;
    let pageErrors = 0;
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors += 1;
        messages.push(ctx.redact(msg.text()));
      }
    });
    page.on('pageerror', (err) => {
      pageErrors += 1;
      messages.push(ctx.redact(String(err.message)));
    });
    await page.goto(ctx.origin, { waitUntil: 'networkidle' });
    return { console_errors: consoleErrors, page_errors: pageErrors, messages };
  });
}

async function measureStorage(ctx, check) {
  const rule = check.rule;
  const value = 'RE QA 저장 확인';
  return withContext(ctx.browser, {}, ctx.track, async (page) => {
    await page.goto(ctx.origin, { waitUntil: 'load' });
    const target = page.locator(rule.input_selector).first();
    if (await target.count() === 0) return { target_found: false };
    await target.fill(value);
    await page.waitForTimeout(rule.wait_ms);
    await page.reload({ waitUntil: 'load' });
    const again = page.locator(rule.input_selector).first();
    const restored = await again.evaluate((el) => ('value' in el ? el.value : el.textContent));
    return { target_found: true, input_value: value, restored_value: restored, wait_ms: rule.wait_ms };
  });
}

async function measureFocus(ctx, check) {
  const rule = check.rule;
  return withContext(ctx.browser, {}, ctx.track, async (page) => {
    await page.goto(ctx.origin, { waitUntil: 'load' });
    const total = await page.evaluate((selector) => {
      const els = [...document.querySelectorAll(selector)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled && getComputedStyle(el).visibility !== 'hidden';
      });
      window.__rewfFocus = els.map((el) => ({ el, border: parseFloat(getComputedStyle(el).borderTopWidth) || 0 }));
      return els.length;
    }, rule.must_reach_all);
    const reached = new Map();
    for (let i = 0; i < total + 2; i += 1) {
      await page.keyboard.press('Tab');
      const m = await page.evaluate(() => {
        const list = window.__rewfFocus || [];
        const el = document.activeElement;
        const idx = list.findIndex((x) => x.el === el);
        if (idx < 0) return null;
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== 'none' ? parseFloat(cs.outlineWidth) || 0 : 0;
        let spread = 0;
        if (cs.boxShadow && cs.boxShadow !== 'none') {
          for (const part of cs.boxShadow.replace(/rgba?\([^)]*\)/g, '').split(',')) {
            const nums = [...part.matchAll(/(-?\d*\.?\d+)px/g)].map((x) => Number(x[1]));
            if (nums.length >= 4) spread = Math.max(spread, nums[3]);
          }
        }
        const border = Math.max(0, (parseFloat(cs.borderTopWidth) || 0) - list[idx].border);
        return {
          index: idx,
          element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`,
          outline_px: outline,
          box_shadow_spread_px: spread,
          border_delta_px: border,
          indicator_px: Math.max(outline, spread, border),
        };
      });
      if (m && !reached.has(m.index)) reached.set(m.index, m);
    }
    const all = await page.evaluate(() => (window.__rewfFocus || []).map((x) => `${x.el.tagName.toLowerCase()}${x.el.id ? `#${x.el.id}` : ''}`));
    const unreached = all.filter((_, i) => !reached.has(i));
    return { focusables_total: total, reached: [...reached.values()], unreached, method: 'Tab 키 이동 후 getComputedStyle' };
  });
}

async function measureAxe(ctx, check) {
  const rule = check.rule;
  const mod = await import('@axe-core/playwright');
  const AxeBuilder = mod.AxeBuilder || mod.default;
  return withContext(ctx.browser, {}, ctx.track, async (page) => {
    await page.goto(ctx.origin, { waitUntil: 'load' });
    const res = await new AxeBuilder({ page }).withTags(rule.tags).analyze();
    return {
      tags: rule.tags,
      violations: res.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })),
      incomplete: res.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
      axe_version: res.testEngine && res.testEngine.version,
    };
  });
}

// ---------- design contract (MB-08~10) ----------
// 앱이 data-ui·data-type으로 선언한 요소만 측정한다. 판정은 stage3-evaluate.mjs가 원시 값으로 한다.
// 페이지에 스크립트를 주입하지 않는다(CSP 영향 없음). 공용 도우미는 각 evaluate 안에서 정의한다.
async function contractPage(ctx, viewport, fn, arg) {
  return withContext(ctx.browser, { viewport: { width: viewport[0], height: viewport[1] } }, ctx.track, async (page) => {
    await page.goto(ctx.origin, { waitUntil: 'load' });
    return page.evaluate(fn, arg);
  });
}

// MB-08: 필드 그룹 자식의 위치와, 비차단 진단용 컨테이너별 세로 간격 종류.
async function measureFieldGroups(ctx, check) {
  const rule = check.rule;
  const raw = await contractPage(ctx, rule.viewport, (r) => {
    const visible = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + el.classList[0] : '');
    const groups = [...document.querySelectorAll(r.group_selector)].filter(visible).map((g) => ({
      group: name(g),
      children: [...g.children].filter(visible).map((k) => {
        const b = k.getBoundingClientRect();
        const role = k.matches(r.field_selector) ? 'field' : (k.matches(r.label_selector) ? 'label' : 'other');
        return { element: name(k), role, top: b.top, bottom: b.bottom };
      }),
    }));
    // 진단(판정 아님): main 안에서 보이는 흐름 자식이 3개 이상인 컨테이너의 연속 세로 간격
    const root = document.querySelector('main') || document.body;
    const containers = [root, ...root.querySelectorAll('*')].filter(visible);
    const spacing = [];
    for (const c of containers) {
      const kids = [...c.children].filter((k) => visible(k) && !['absolute', 'fixed'].includes(getComputedStyle(k).position));
      if (kids.length < 3) continue;
      const gaps = [];
      for (let i = 1; i < kids.length; i += 1) {
        const prev = kids[i - 1].getBoundingClientRect();
        const next = kids[i].getBoundingClientRect();
        if (next.top >= prev.bottom - 1) gaps.push(Math.round(next.top - prev.bottom));
      }
      if (gaps.length >= 2) spacing.push({ container: name(c), gaps, distinct: new Set(gaps).size });
      if (spacing.length >= 50) break;
    }
    // 부분 계약 확인: field-group 밖에 선언된 field
    const outside = [...document.querySelectorAll(r.field_selector)].filter((f) => visible(f) && !f.closest(r.group_selector)).map(name);
    const declared = { ui: document.querySelectorAll('[data-ui]').length, type: document.querySelectorAll('[data-type]').length };
    const declaredGroups = document.querySelectorAll(r.group_selector).length;
    return { contract_present: declared.ui + declared.type > 0, declared, declared_groups: declaredGroups, groups, fields_outside_group: outside, spacing_variety: spacing };
  }, rule);
  return { viewport: rule.viewport, ...raw };
}

// MB-09: data-type 요소의 계산된 글자 크기·굵기.
async function measureTypeTokens(ctx, check) {
  const rule = check.rule;
  const raw = await contractPage(ctx, rule.viewport, (r) => {
    const visible = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + el.classList[0] : '');
    const declared = { ui: document.querySelectorAll('[data-ui]').length, type: document.querySelectorAll('[data-type]').length };
    return {
      contract_present: declared.ui + declared.type > 0,
      declared,
      elements: [...document.querySelectorAll(r.selector)].filter(visible).map((el) => {
        const cs = getComputedStyle(el);
        return { element: name(el), token: el.getAttribute(r.attribute), font_size_px: parseFloat(cs.fontSize), font_weight: Number(cs.fontWeight) };
      }),
    };
  }, rule);
  return { viewport: rule.viewport, ...raw };
}

// MB-10: data-ui 요소의 계산된 모서리 radius와, pill 형태일 수 있는 버튼 후보.
async function measureRadiusRoles(ctx, check) {
  const rule = check.rule;
  const raw = await contractPage(ctx, rule.viewport, (r) => {
    const visible = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + el.classList[0] : '');
    const corners = (el) => {
      const cs = getComputedStyle(el);
      return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
    };
    const box = (el) => { const b = el.getBoundingClientRect(); return { width: b.width, height: b.height }; };
    const declared = { ui: document.querySelectorAll('[data-ui]').length, type: document.querySelectorAll('[data-type]').length };
    return {
      contract_present: declared.ui + declared.type > 0,
      declared,
      elements: [...document.querySelectorAll(r.selector)].filter(visible)
        .map((el) => ({ element: name(el), role: el.getAttribute(r.attribute), radii: corners(el), ...box(el) })),
      pill_candidates: [...document.querySelectorAll(r.pill_candidates)].filter(visible)
        .map((el) => ({ element: name(el), role: el.getAttribute(r.attribute), radii: corners(el), ...box(el) })),
    };
  }, rule);
  return { viewport: rule.viewport, ...raw };
}

const MEASURERS = {
  browser_field_group_spacing: measureFieldGroups,
  browser_type_tokens: measureTypeTokens,
  browser_radius_roles: measureRadiusRoles,
  browser_no_overflow: measureOverflow,
  browser_min_target_size: measureTargets,
  browser_sticky: measureSticky,
  browser_font_fallback: measureFontFallback,
  browser_font_loaded: measureFontLoaded,
  browser_console_clean: measureConsole,
  browser_storage_restore: measureStorage,
  browser_focus_visible: measureFocus,
  axe: measureAxe,
};

async function defaultLauncher() {
  const { chromium } = await import('playwright');
  return chromium;
}

// launcher 주입은 테스트에서 Chrome 없음 조건을 모의하기 위한 것이다.
export async function measureStage3({ checksData, input, evidence = null, launcher = defaultLauncher }) {
  const tool = browserTool(checksData);
  const started = new Date().toISOString();
  const checks = stage3Checks(checksData).filter((c) => appliesWhen(c.applies_when, input) === true);
  const allRaw = (raw) => Object.fromEntries(checks.map((c) => [c.check_id, raw]));
  const browserInfo = {
    provider: tool.provider,
    channel: tool.channel,
    fallback: tool.fallback,
    headless: tool.headless,
    version: null,
    profile: 'userDataDir 미사용, 측정마다 새 임시 context',
    started_at: started,
    ended_at: null,
  };
  const origins = new Set();

  if (!fs.existsSync(path.join(input.app_path, 'index.html'))) {
    browserInfo.ended_at = new Date().toISOString();
    return { browser: browserInfo, network: { origins: [], local_origin: null }, raws: allRaw({ error_code: 'NO_STATIC_ENTRY' }) };
  }

  let browser = null;
  try {
    const chromium = await launcher();
    browser = await chromium.launch({ channel: tool.channel, headless: tool.headless, args: QUIET_ARGS });
  } catch {
    browserInfo.ended_at = new Date().toISOString();
    return { browser: browserInfo, network: { origins: [], local_origin: null }, raws: allRaw({ tool_error: 'TOOL_MISSING' }) };
  }

  let server = null;
  const raws = {};
  try {
    server = await startStaticServer(input.app_path, checksData.policies.fingerprint);
    browserInfo.version = browser.version();
    const track = (url) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') origins.add(u.origin);
      } catch {
        // data:, blob: 등은 origin 기록 대상이 아니다
      }
    };
    const redactPolicy = {
      patterns: getCheck(checksData, 'ST-03').rule.patterns,
      maxChars: checksData.policies.evidence_text.max_chars,
      privateKeyBlock: checksData.policies.evidence_text.private_key_block,
    };
    const ctx = { browser, origin: `${server.origin}/`, track, evidence, input, redact: (t) => redactText(t, redactPolicy) };
    for (const check of checks) {
      const measure = MEASURERS[check.rule.type];
      if (!measure) continue;
      try {
        raws[check.check_id] = await measure(ctx, check);
      } catch (e) {
        raws[check.check_id] = { error_code: e.name === 'TimeoutError' ? 'TIMEOUT' : 'MEASUREMENT_FAILED' };
      }
    }
  } finally {
    await browser.close();
    if (server) await server.close();
    browserInfo.ended_at = new Date().toISOString();
  }
  const list = [...origins];
  return {
    browser: browserInfo,
    network: { local_origin: server.origin, origins: list, external_origins: list.filter((o) => o !== server.origin), excluded_path_requests: server.excludedRequests() },
    raws,
  };
}
