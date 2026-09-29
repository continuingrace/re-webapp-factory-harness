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

const MEASURERS = {
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
