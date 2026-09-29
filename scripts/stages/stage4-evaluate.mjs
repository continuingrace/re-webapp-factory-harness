// Stage 4 판정 (PD-01~03). 네트워크를 쓰지 않는 순수 함수이며 runner와 gate-judge가 함께 쓴다.
// 운영 URL 확인 상태는 raw가 아니라 approvals.json에서 판정 시점에 계산한다.
import { appliesWhen, getCheck } from '../lib/checks.mjs';
import { makeItem, policyCodes } from '../lib/result.mjs';

export const STAGE4 = 4;
const FAIL_NEXT = '원인 수정 후 재배포 또는 2단계부터 재실행';
const ATTN_NEXT = '사용자 확인 필요';

function evalUrl(check, raw, R, confirmation) {
  const rule = check.rule;
  const ev = { raw, confirmation };
  if (confirmation.status === 'REJECT' && rule.deny_user_marked_preview) return R.fail('URL_UNCONFIRMED', ev);
  if (raw.denied) return R.fail(raw.code, ev);
  if (raw.inconclusive || raw.limit_exceeded) return R.attention(R.inconclusive, ev);
  if (raw.final_status !== rule.final_status_after_redirect) return R.fail('URL_NOT_200', ev);
  if (raw.redirect_count > rule.max_redirects) return R.attention(R.inconclusive, ev);
  if (confirmation.status !== 'APPROVE') return R.awaiting(ev);
  return R.pass(ev);
}

function evalAssets(check, raw, R, _c, input) {
  if (raw.skipped) return R.notRun({ raw });
  if (!Array.isArray(raw.assets)) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (raw.assets.length === 0) return R.zero({ raw, reason: 'NO_MEASURED_TARGET' });
  const expected = check.rule.expected_status;
  const missing = [];
  if (input.flags && input.flags.pwa_installable === 'yes') {
    if (!raw.kinds_found.includes('manifest')) missing.push('manifest');
    if (!raw.kinds_found.includes('manifest_icon') && !raw.kinds_found.includes('icon')) missing.push('icons');
  }
  const bad = raw.assets.filter((a) => a.status !== expected);
  const unclear = raw.assets.filter((a) => a.inconclusive || a.limit_exceeded);
  const derived = { expected_status: expected, missing_kinds: missing, not_ok: bad.length };
  if (raw.truncated || unclear.length) return R.attention(R.inconclusive, { raw, derived });
  if (missing.length || bad.length) return R.fail('ASSET_NOT_200', { raw, derived });
  return R.pass({ raw, derived });
}

function evalVersion(check, raw, R, _c, input) {
  if (raw.skipped) return R.notRun({ raw });
  if (!Array.isArray(raw.versions_found)) return R.attention(R.inconclusive, { raw, reason: 'MEASUREMENT_MISSING' });
  if (!raw.versions_found.length) return R.attention(R.inconclusive, { raw, reason: 'NO_VERSION_ON_PAGE' });
  if (raw.versions_found.some((v) => v !== input.target_version)) return R.fail('DEPLOYED_VERSION_MISMATCH', { raw, target: input.target_version });
  return R.pass({ raw, target: input.target_version });
}

const EVALUATORS = { url_acceptance: evalUrl, http_assets_ok: evalAssets, deployed_version: evalVersion };

// input: 유효 입력(input.json + 최신 deployment). confirmation: approvals에서 계산한 운영 URL 확인 상태.
export function evaluateStage4(checksData, input, raws, confirmation, context) {
  const meta = { fingerprint: context.fingerprint, standards_version: checksData.standards_version, policy_codes: policyCodes(checksData) };
  const inconclusive = checksData.policies.inconclusive.failure_code;
  const items = checksData.checks.filter((c) => c.stage === STAGE4).map((check) => {
    const R = {
      inconclusive,
      zero: (ev) => makeItem(check, { status: checksData.policies.zero_targets.status, evidence: ev, failure_code: checksData.policies.zero_targets.failure_code, next_action: ATTN_NEXT }, meta),
      pass: (ev) => makeItem(check, { status: 'PASS', evidence: ev }, meta),
      fail: (code, ev) => makeItem(check, { status: 'FAIL', evidence: ev, failure_code: code, next_action: FAIL_NEXT }, meta),
      attention: (code, ev) => makeItem(check, { status: 'NEEDS_ATTENTION', evidence: ev, failure_code: code, next_action: ATTN_NEXT }, meta),
      awaiting: (ev) => makeItem(check, { status: 'AWAITING_APPROVAL', evidence: ev, next_action: '운영 URL 확인 필요' }, meta),
      notRun: (ev) => makeItem(check, { status: 'NOT_RUN', evidence: ev, next_action: 'PD-01 통과 후 재측정' }, meta),
    };
    const applies = appliesWhen(check.applies_when, input);
    if (applies === null) return R.attention(inconclusive, { reason: 'APPLIES_WHEN_UNPARSEABLE' });
    if (applies === false) return makeItem(check, { status: 'NOT_APPLICABLE', evidence: { reason: `applies_when 불충족: ${check.applies_when}` } }, meta);
    const raw = raws ? raws[check.check_id] : undefined;
    if (!raw || typeof raw !== 'object') return R.attention(inconclusive, { reason: 'RAW_MISSING' });
    return EVALUATORS[check.rule.type](check, raw, R, confirmation, input);
  });
  const statuses = items.map((i) => i.status);
  let runStatus = 'AWAITING_APPROVAL';
  if (statuses.some((s) => ['FAIL', 'NEEDS_ATTENTION', 'NOT_RUN'].includes(s))) runStatus = 'BLOCKED';
  return { stage: STAGE4, run_status: runStatus, items };
}

export function pd01Rule(checksData) {
  return getCheck(checksData, 'PD-01').rule;
}
