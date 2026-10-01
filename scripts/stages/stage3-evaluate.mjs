// Stage 3 판정 (MB-01~10, FA-01~04). 브라우저·네트워크를 쓰지 않는 순수 함수다.
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

// ---------- design contract (MB-08~10) ----------
// data-ui·data-type을 하나도 선언하지 않은 앱만 적용 대상이 아니다 (NOT_APPLICABLE, 근거 기록).
// 일부만 선언했거나 잘못 선언한 계약은 FAIL, 선언했지만 보이는 대상이 없으면 NEEDS_ATTENTION이다.
const round2 = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

function contractPre(raw, R, listKey) {
  if (typeof raw.contract_present !== 'boolean' || !Array.isArray(raw[listKey])) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (!raw.contract_present) return R.na({ raw, reason: 'DESIGN_CONTRACT_ABSENT' });
  if (!raw.declared || typeof raw.declared.ui !== 'number' || typeof raw.declared.type !== 'number') return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  return null;
}

function evalFieldGroups(check, raw, R) {
  const rule = check.rule;
  const pre = contractPre(raw, R, 'groups');
  if (pre) return pre;
  if (!Array.isArray(raw.fields_outside_group) || typeof raw.declared_groups !== 'number') return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (raw.fields_outside_group.length) {
    return R.fail('FIELD_OUTSIDE_GROUP', { raw, derived: { fields_outside_group: raw.fields_outside_group } });
  }
  if (!raw.groups.length) {
    if (raw.declared_groups > 0) return R.zero({ raw, reason: 'NO_VISIBLE_FIELD_GROUP' });
    return R.na({ raw, reason: 'NO_FIELD_GROUP' });
  }
  const tol = rule.tolerance_px;
  const results = [];
  const withoutField = [];
  for (const g of raw.groups) {
    const kids = Array.isArray(g.children) ? g.children : [];
    const fieldIdx = kids.map((k, i) => (k.role === 'field' ? i : -1)).filter((i) => i >= 0);
    if (!fieldIdx.length) { withoutField.push(g.group); continue; }
    for (const i of fieldIdx) {
      const f = kids[i];
      const prev = kids[i - 1];
      const next = kids[i + 1];
      const labelGap = prev && prev.role === 'label' ? round2(f.top - prev.bottom) : null;
      const nextGap = next ? round2(next.top - f.bottom) : null;
      results.push({
        group: g.group,
        field: f.element,
        label_to_field_px: labelGap,
        field_to_next_px: nextGap,
        label_ok: labelGap === null || labelGap <= rule.max_label_to_field_px + tol,
        next_ok: nextGap === null || nextGap >= rule.min_field_to_next_px - tol,
      });
    }
  }
  const derived = { results, groups_without_field: withoutField, max_label_to_field_px: rule.max_label_to_field_px, min_field_to_next_px: rule.min_field_to_next_px };
  if (withoutField.length) return R.fail('FIELD_GROUP_WITHOUT_FIELD', { raw, derived });
  if (results.some((r) => !r.label_ok || !r.next_ok)) return R.fail('FIELD_SPACING', { raw, derived });
  return R.pass({ raw, derived });
}

function evalTypeTokens(check, raw, R) {
  const rule = check.rule;
  const pre = contractPre(raw, R, 'elements');
  if (pre) return pre;
  if (raw.declared.type === 0) return R.fail('CONTRACT_INCOMPLETE', { raw, derived: { reason: 'DATA_TYPE_NOT_DECLARED' } });
  if (!raw.elements.length) return R.zero({ raw, reason: 'NO_VISIBLE_TYPED_ELEMENT' });
  const unknown = [];
  const mismatch = [];
  for (const e of raw.elements) {
    const tok = rule.tokens[e.token];
    if (!tok) { unknown.push({ element: e.element, token: e.token }); continue; }
    if (!(Math.abs(e.font_size_px - tok[0]) <= rule.tolerance_px) || e.font_weight !== tok[1]) {
      mismatch.push({ element: e.element, token: e.token, expected: tok, actual: [e.font_size_px, e.font_weight] });
    }
  }
  const derived = { checked: raw.elements.length, unknown, mismatch };
  if (unknown.length) return R.fail('TYPE_TOKEN_UNKNOWN', { raw, derived });
  if (mismatch.length) return R.fail('TYPE_TOKEN_MISMATCH', { raw, derived });
  return R.pass({ raw, derived });
}

// 계산된 모서리 값 → px. %는 요소의 짧은 변 기준으로 환산한다.
function radiusPx(value, box) {
  const s = String(value).trim().split(/\s+/)[0];
  const px = /^(-?\d*\.?\d+)px$/.exec(s);
  if (px) return Number(px[1]);
  const pct = /^(-?\d*\.?\d+)%$/.exec(s);
  if (pct) return (Number(pct[1]) / 100) * Math.min(box.width, box.height);
  return s === '0' ? 0 : NaN;
}
const isPillShape = (e, tol) => {
  const half = Math.min(e.width, e.height) / 2;
  return half > 0 && (e.radii || []).length === 4 && e.radii.every((v) => radiusPx(v, e) >= half - tol);
};

function evalRadiusRoles(check, raw, R) {
  const rule = check.rule;
  const pre = contractPre(raw, R, 'elements');
  if (pre) return pre;
  if (!Array.isArray(raw.pill_candidates)) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  const invalid = raw.elements.filter((e) => !rule.contract_roles.includes(e.role)).map((e) => ({ element: e.element, role: e.role }));
  if (invalid.length) return R.fail('CONTRACT_INVALID', { raw, derived: { invalid_roles: invalid, allowed_roles: rule.contract_roles } });
  if (raw.declared.ui === 0) return R.fail('CONTRACT_INCOMPLETE', { raw, derived: { reason: 'DATA_UI_NOT_DECLARED' } });
  const tol = rule.tolerance_px;
  // pill 형태의 버튼은 의도한 pill 역할로 선언해야 한다. 정사각형(원형 아이콘 버튼)은 제외한다.
  const pillMissing = raw.pill_candidates
    .filter((e) => Math.abs(e.width - e.height) > 1 && isPillShape(e, tol) && e.role !== rule.pill_role)
    .map((e) => ({ element: e.element, role: e.role, radii: e.radii, height: e.height }));
  if (!raw.elements.length && !pillMissing.length) return R.zero({ raw, reason: 'NO_VISIBLE_ROLE_ELEMENT' });
  const judged = [];
  const mismatch = [];
  for (const e of raw.elements) {
    const expected = rule.roles[e.role];
    if (!expected) continue; // field-group은 radius 역할이 아님 (MB-08이 검사)
    const ok = e.role === rule.pill_role
      ? isPillShape(e, tol)
      : (e.radii || []).length === 4 && e.radii.every((v) => Math.abs(radiusPx(v, e) - radiusPx(expected, e)) <= tol);
    judged.push({ element: e.element, role: e.role, expected, radii: e.radii });
    if (!ok) mismatch.push({ element: e.element, role: e.role, expected, radii: e.radii });
  }
  if (!judged.length && !pillMissing.length) return R.na({ raw, reason: 'NO_RADIUS_ROLE' });
  const derived = { judged: judged.length, mismatch, pill_role_missing: pillMissing };
  if (mismatch.length) return R.fail('RADIUS_ROLE_MISMATCH', { raw, derived });
  if (pillMissing.length) return R.fail('PILL_ROLE_MISSING', { raw, derived });
  return R.pass({ raw, derived });
}

const EVALUATORS = {
  browser_field_group_spacing: evalFieldGroups,
  browser_type_tokens: evalTypeTokens,
  browser_radius_roles: evalRadiusRoles,
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
      na: (ev) => makeItem(check, { status: 'NOT_APPLICABLE', evidence: withTool(ev) }, meta),
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
