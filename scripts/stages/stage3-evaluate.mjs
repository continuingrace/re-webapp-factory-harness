// Stage 3 판정 (MB-01~07, FA-01~04). 브라우저·네트워크를 쓰지 않는 순수 함수다.
// runner가 기록한 원시 측정값(raw)을 checks.json 기준으로 판정하며, runner와 gate-judge가 함께 쓴다.
import { appliesWhen } from '../lib/checks.mjs';
import { makeItem, policyCodes } from '../lib/result.mjs';

export const STAGE3 = 3;
const FAIL_NEXT = '앱 수정 후 2단계부터 재실행';
const ATTN_NEXT = '사용자 확인 필요';

const sameViewport = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
const requiredViewports = (rule) => (rule.viewports || [rule.viewport]).filter(Boolean);

function evalOverflow(check, raw, R) {
  const rule = check.rule;
  const list = Array.isArray(raw.measurements) ? raw.measurements : [];
  const results = [];
  for (const vp of requiredViewports(rule)) {
    const m = list.find((x) => sameViewport(x.viewport, vp));
    if (!m || typeof m.scrollWidth !== 'number' || typeof m.clientWidth !== 'number') {
      return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING', viewport: vp });
    }
    results.push({ viewport: vp, overflow_px: m.scrollWidth - m.clientWidth, body_visible: m.body_visible });
  }
  const derived = { results, max_overflow_px: rule.max_overflow_px };
  if (rule.body_visible && results.some((r) => r.body_visible !== true)) return R.fail('RENDER_FAILED', { raw, derived });
  if (results.some((r) => r.overflow_px > rule.max_overflow_px)) return R.fail(check.failure_code[0], { raw, derived });
  return R.pass({ raw, derived });
}

function evalTargetSize(check, raw, R) {
  const [minW, minH] = check.rule.min_px;
  if (!Array.isArray(raw.targets)) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (raw.targets.length === 0) return R.zero({ raw, reason: 'NO_MEASURED_TARGET' });
  const small = raw.targets.filter((t) => t.width < minW || t.height < minH);
  const derived = { targets_checked: raw.targets.length, too_small: small };
  if (small.length) return R.fail('TOUCH_TARGET_SMALL', { raw, derived });
  return R.pass({ raw, derived });
}

function evalSticky(check, raw, R) {
  const rule = check.rule;
  const list = Array.isArray(raw.per_viewport) ? raw.per_viewport : [];
  const results = [];
  for (const vp of rule.viewports) {
    const m = list.find((x) => sameViewport(x.viewport, vp));
    if (!m) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING', viewport: vp });
    if (!m.found) return R.fail('STICKY_TARGET_MISSING', { raw, derived: { viewport: vp } });
    if (typeof m.scroll_y !== 'number' || m.scroll_y < rule.scroll_px) {
      return R.attention(R.inconclusive, { raw, reason: 'SCROLL_NOT_REACHED', viewport: vp });
    }
    const drift = typeof m.css_top_px === 'number' && typeof m.rect_top_after === 'number'
      ? Math.abs(m.rect_top_after - m.css_top_px) : null;
    const overlap = (m.overlaps || []).filter((o) => rule.max_overlap_with.includes(o.with)).reduce((s, o) => s + o.area, 0);
    results.push({ viewport: vp, top_drift_px: drift, overlap_px: overlap });
  }
  const derived = { results, top_tolerance_px: rule.top_tolerance_px, max_overlap_px: rule.max_overlap_px };
  if (results.some((r) => r.top_drift_px === null || r.top_drift_px > rule.top_tolerance_px)) return R.fail('STICKY_NOT_FIXED', { raw, derived });
  if (results.some((r) => r.overlap_px > rule.max_overlap_px)) return R.fail('STICKY_OVERLAP', { raw, derived });
  return R.pass({ raw, derived });
}

function evalFontFallback(check, raw, R) {
  const rule = check.rule;
  if (!sameViewport(raw.viewport, rule.viewport) || typeof raw.scrollWidth !== 'number') {
    return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  }
  const derived = { overflow_px: raw.scrollWidth - raw.clientWidth, blocked_pattern: rule.block_requests_matching };
  if (derived.overflow_px > rule.max_overflow_px) return R.fail('FONT_FALLBACK_BROKEN', { raw, derived });
  return R.pass({ raw, derived });
}

function evalFontLoaded(check, raw, R) {
  if (!Array.isArray(raw.families) || raw.families.length === 0) return R.attention(R.inconclusive, { raw, reason: 'FONT_FAMILIES_NOT_PROVIDED' });
  const missing = raw.families.filter((f) => f.loaded !== true);
  if (missing.length) return R.fail('EFFECT_FONT_MISSING', { raw, derived: { missing } });
  return R.pass({ raw, derived: { checked: raw.families.length } });
}

function evalConsole(check, raw, R) {
  const rule = check.rule;
  if (typeof raw.console_errors !== 'number' || typeof raw.page_errors !== 'number') return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (raw.console_errors > rule.max_console_errors || raw.page_errors > rule.max_page_errors) return R.fail('CONSOLE_ERROR', { raw });
  return R.pass({ raw });
}

function evalStorage(check, raw, R) {
  if (typeof raw.target_found !== 'boolean') return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (!raw.target_found) return R.fail('STATE_TARGET_MISSING', { raw });
  if (check.rule.must_restore && raw.restored_value !== raw.input_value) return R.fail('STATE_NOT_RESTORED', { raw });
  return R.pass({ raw });
}

function evalFocus(check, raw, R) {
  const rule = check.rule;
  if (!Array.isArray(raw.reached) || !Array.isArray(raw.unreached)) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (raw.focusables_total === 0) return R.zero({ raw, reason: 'NO_FOCUSABLE_ELEMENT' });
  const weak = raw.reached.filter((r) => !(r.indicator_px >= rule.indicator_min_px));
  const derived = { indicator_min_px: rule.indicator_min_px, weak };
  if (raw.unreached.length) return R.fail('FOCUS_UNREACHABLE', { raw, derived });
  if (weak.length) return R.fail('FOCUS_INDICATOR_WEAK', { raw, derived });
  return R.pass({ raw, derived });
}

function evalAxe(check, raw, R) {
  const rule = check.rule;
  if (!Array.isArray(raw.violations) || !Array.isArray(raw.incomplete)) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  const tagsOk = Array.isArray(raw.tags) && rule.tags.every((t) => raw.tags.includes(t));
  if (!tagsOk) return R.attention(R.inconclusive, { raw, reason: 'AXE_TAGS_MISMATCH' });
  if (raw.violations.length > rule.max_violations) return R.fail('A11Y_VIOLATION', { raw });
  if (raw.incomplete.length && rule.incomplete_results === 'NEEDS_ATTENTION') return R.attention(R.inconclusive, { raw, reason: 'AXE_INCOMPLETE' });
  return R.pass({ raw });
}

const EVALUATORS = {
  browser_no_overflow: evalOverflow,
  browser_min_target_size: evalTargetSize,
  browser_sticky: evalSticky,
  browser_font_fallback: evalFontFallback,
  browser_font_loaded: evalFontLoaded,
  browser_console_clean: evalConsole,
  browser_storage_restore: evalStorage,
  browser_focus_visible: evalFocus,
  axe: evalAxe,
};

export function stage3Checks(checksData) {
  return checksData.checks.filter((c) => c.stage === STAGE3);
}

// raws: { [check_id]: raw }. context: { fingerprint, browser }
export function evaluateStage3(checksData, input, raws, context) {
  const meta = { fingerprint: context.fingerprint, standards_version: checksData.standards_version, policy_codes: policyCodes(checksData) };
  const inconclusive = checksData.policies.inconclusive.failure_code;
  const missingTool = checksData.policies.missing_tool.failure_code;
  const browser = context.browser || null;
  const items = stage3Checks(checksData).map((check) => {
    const withTool = (ev) => ({ ...ev, browser });
    const R = {
      inconclusive,
      zero: (ev) => makeItem(check, { status: checksData.policies.zero_targets.status, evidence: withTool(ev), failure_code: checksData.policies.zero_targets.failure_code, next_action: ATTN_NEXT }, meta),
      pass: (ev) => makeItem(check, { status: 'PASS', evidence: withTool(ev) }, meta),
      fail: (code, ev) => makeItem(check, { status: 'FAIL', evidence: withTool(ev), failure_code: code, next_action: FAIL_NEXT }, meta),
      attention: (code, ev) => makeItem(check, { status: 'NEEDS_ATTENTION', evidence: withTool(ev), failure_code: code, next_action: ATTN_NEXT }, meta),
    };
    const applies = appliesWhen(check.applies_when, input);
    if (applies === null) return R.attention(inconclusive, { reason: 'APPLIES_WHEN_UNPARSEABLE' });
    if (applies === false) {
      return makeItem(check, { status: 'NOT_APPLICABLE', evidence: { reason: `applies_when 불충족: ${check.applies_when}` } }, meta);
    }
    const raw = raws ? raws[check.check_id] : undefined;
    if (!raw || typeof raw !== 'object') return R.attention(inconclusive, { reason: 'RAW_MISSING' });
    if (raw.tool_error) return R.attention(missingTool, { raw, reason: 'TOOL_MISSING' });
    if (raw.error_code) return R.attention(inconclusive, { raw, reason: 'MEASUREMENT_ERROR' });
    const evaluate = EVALUATORS[check.rule.type];
    if (!evaluate) return R.attention(inconclusive, { reason: 'RULE_TYPE_UNSUPPORTED' });
    return evaluate(check, raw, R);
  });
  const allOk = items.every((i) => i.status === 'PASS' || i.status === 'NOT_APPLICABLE');
  return { stage: STAGE3, run_status: allOk ? 'AWAITING_DEPLOYMENT' : 'BLOCKED', items };
}

export function rawsFromItems(items) {
  const out = {};
  for (const i of items || []) if (i && i.evidence && i.evidence.raw) out[i.check_id] = i.evidence.raw;
  return out;
}
