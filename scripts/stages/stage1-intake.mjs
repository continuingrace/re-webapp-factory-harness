// Stage 1 접수 판정 (IN-01). 결과는 반환·stdout으로만 내며 파일을 쓰지 않는다.
// 01-intake 파일은 오케스트레이터가 작성한다 (docs/harness-orchestrator.md 6절).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCheck, appliesWhen, loadChecks } from '../lib/checks.mjs';
import { makeItem, policyCodes } from '../lib/result.mjs';
import { canonicalAppPath, deriveAppSlug, findSlugCollision } from '../lib/paths.mjs';
import { computeFingerprint } from '../lib/fingerprint.mjs';

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

// required_tools의 node 최소 버전(major)을 실제 실행 중인 Node와 비교한다.
export function nodeRequirement(checksData, version) {
  const tool = checksData.required_tools.find((t) => t.name === 'node');
  const min = tool ? Number(String(tool.min_version).split('.')[0]) : null;
  const major = Number(String(version).split('.')[0]);
  return { required_min_major: min, actual: String(version), satisfied: min === null || (Number.isInteger(major) && major >= min) };
}

export function judgeIntake({ root, checksData, input, nodeVersion = process.versions.node }) {
  const check = getCheck(checksData, 'IN-01');
  const rule = check.rule;
  const violations = [];
  const checked = [];
  const need = (field) => {
    checked.push(field);
    if (blank(input[field])) violations.push({ field, problem: 'MISSING' });
  };

  rule.required.forEach(need);

  let canonical = null;
  if (!blank(input.app_path)) {
    const abs = path.resolve(input.app_path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) violations.push({ field: 'app_path', problem: 'NOT_A_DIRECTORY' });
    else canonical = canonicalAppPath(abs);
  }
  if (!blank(input.target_version) && !new RegExp(rule.target_version_regex).test(input.target_version)) {
    violations.push({ field: 'target_version', problem: 'FORMAT' });
  }
  if (!blank(input.change_summary)) {
    const lines = String(input.change_summary).split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').length;
    const [min, max] = rule.change_summary_lines;
    if (lines < min || lines > max) violations.push({ field: 'change_summary', problem: 'LINE_COUNT', lines });
  }
  if (!blank(input.release_phase) && !rule.release_phase.includes(input.release_phase)) {
    violations.push({ field: 'release_phase', problem: 'VALUE' });
  }
  for (const [flag, allowed] of Object.entries(rule.flags)) {
    checked.push(`flags.${flag}`);
    const v = input.flags ? input.flags[flag] : undefined;
    if (!allowed.includes(v)) violations.push({ field: `flags.${flag}`, problem: blank(v) ? 'MISSING' : 'VALUE' });
  }
  const urlCondition = rule.operating_url_required_when;
  if (appliesWhen(urlCondition, input) === true) need('operating_url');

  let slug = null;
  let failure = 'INPUT_INVALID';
  if (!blank(input.app_path)) {
    const provided = input.app_slug_source === 'USER_PROVIDED' ? input.app_slug : undefined;
    const s = deriveAppSlug(input.app_path, rule.app_slug_regex, provided);
    checked.push('app_slug');
    if (!s.ok) {
      violations.push({ field: 'app_slug', problem: 'FORMAT' });
      failure = 'APP_SLUG_INVALID';
    } else {
      slug = s;
      if (canonical) {
        const collision = findSlugCollision(root, s.slug, canonical);
        if (collision) {
          violations.push({ field: 'app_slug', problem: 'COLLISION', run_id: collision.run_id });
          failure = 'APP_SLUG_COLLISION';
        }
      }
    }
  }

  let fingerprint = null;
  if (canonical) {
    const fp = computeFingerprint(canonical, checksData.policies.fingerprint);
    if (fp.status === 'OK') fingerprint = fp.value;
  }
  const meta = { fingerprint, standards_version: checksData.standards_version, policy_codes: policyCodes(checksData) };
  const node = nodeRequirement(checksData, nodeVersion);
  const ok = violations.length === 0;
  let item;
  if (!ok) {
    item = makeItem(check, { status: 'FAIL', evidence: { checked_fields: checked, violations, node }, failure_code: failure, next_action: '입력 수정 후 1단계' }, meta);
  } else if (!node.satisfied) {
    const missing = checksData.policies.missing_tool;
    item = makeItem(check, { status: missing.status, evidence: { checked_fields: checked, violations: [], node }, failure_code: missing.failure_code, next_action: 'Node 버전 확인 필요' }, meta);
  } else {
    item = makeItem(check, { status: 'PASS', evidence: { checked_fields: checked, violations: [], node } }, meta);
  }

  return {
    stage: 1,
    run_status: ok && node.satisfied ? 'IN_PROGRESS' : 'BLOCKED',
    app_slug: slug ? slug.slug : null,
    app_slug_source: slug ? slug.source : null,
    app_path_canonical: canonical,
    fingerprint,
    standards_version: checksData.standards_version,
    items: [item],
  };
}

// CLI: node scripts/stages/stage1-intake.mjs <input.json>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const { data, errors } = loadChecks(root);
    if (errors.length) throw Object.assign(new Error('CHECKS_INVALID'), { code: 'CHECKS_INVALID' });
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(`${JSON.stringify(judgeIntake({ root, checksData: data, input }))}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ stage: 1, run_status: 'BLOCKED', error_code: e.code || 'INTAKE_ERROR' })}\n`);
    process.exitCode = 1;
  }
}
