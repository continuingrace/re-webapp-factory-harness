// Stage 2 정적 검사 (ST-01~06, DS-01~07). 판정 값은 checks.json에서만 읽는다.
// 네트워크를 사용하지 않고, 대상 앱과 기준 문서를 수정하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { appliesWhen, getCheck, getOverride, validateChecks } from '../lib/checks.mjs';
import { computeFingerprint, readAppFile } from '../lib/fingerprint.mjs';
import { normalizedFileHash } from '../lib/hash.mjs';
import { isInside } from '../lib/paths.mjs';
import { makeItem, policyCodes, stageRunStatus } from '../lib/result.mjs';
import { collectCss, CSS_KEYWORDS, normZero, selectorList, tokens } from '../lib/css.mjs';
import { ZERO_LENGTH_MATCH, countIdentifier, identifiersSummary, maskText } from '../lib/identifiers.mjs';

const STAGE = 2;
const FAIL_NEXT = '앱 수정 후 2단계부터 재실행';
const ATTN_NEXT = '사용자 확인 필요';
const IDENTIFIERS_NEXT = '식별자 설정(config/identifiers.local.json)을 사용자가 직접 확인한 뒤 1단계부터 재실행';

// 바이너리 판별과 비밀·식별자 검사 방식은 checks.json policies.content_scan에서 읽는다.
function buildContext(fp, scanPolicy) {
  const { root, files } = fp.walk;
  const set = new Set(files);
  const cache = new Map();
  const detect = scanPolicy.binary_detection;
  const isBinary = (b) => detect.null_byte_means_binary && b.subarray(0, detect.sample_bytes).includes(0);
  const ctx = {
    root,
    files,
    exists: (rel) => set.has(rel),
    buf: (rel) => readAppFile(root, rel),
    text: (rel) => {
      if (!cache.has(rel)) {
        const b = readAppFile(root, rel);
        let t = isBinary(b) ? null : b.toString('utf8');
        if (t && t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        cache.set(rel, t);
      }
      return cache.get(rel);
    },
    // 비밀·식별자 검사용: 바이너리도 건너뛰지 않고 latin1로 읽어 검사한다.
    scanText: (rel) => {
      const t = ctx.text(rel);
      if (t !== null) return { text: t, binary: false };
      if (scanPolicy.binary_files_in_secret_and_identifier_scan !== 'scan_as_latin1') return null;
      return { text: readAppFile(root, rel).toString('latin1'), binary: true };
    },
  };
  return ctx;
}

function expandBraces(p) {
  const m = /\{([^}]+)\}/.exec(p);
  if (!m) return [p];
  return m[1].split(',').flatMap((x) => expandBraces(p.replace(m[0], x)));
}

function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function linkTags(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    return { rel: rel ? rel[1].toLowerCase().split(/\s+/) : [], href: href ? href[1] : null };
  });
}

function appRel(href) {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith('//')) return null;
  const clean = href.split(/[?#]/)[0].replace(/^\.\//, '').replace(/^\//, '');
  const norm = path.posix.normalize(clean);
  return norm.startsWith('..') ? null : norm;
}

// ---------- ST ----------

function judgeStructure(check, ctx, R) {
  const rule = check.rule;
  const missing = rule.required_all.filter((f) => !ctx.exists(f));
  const entries = rule.entry_any.flatMap(expandBraces).filter((f) => ctx.exists(f));
  if (missing.length) return R.fail('REQUIRED_DOC_MISSING', { missing, detected_entries: entries });
  if (!entries.length) {
    return R.attention(rule.on_no_entry.failure_code, { detected_entries: [], checked_patterns: rule.entry_any });
  }
  return R.pass({ detected_entries: entries, required_present: rule.required_all });
}

function judgeIconSet(check, ctx, R) {
  const rule = check.rule;
  const missing = [];
  const sizeMismatch = [];
  const sizes = {};
  for (const [rel, expected] of Object.entries(rule.files)) {
    if (!ctx.exists(rel)) { missing.push(rel); continue; }
    if (!expected) continue;
    const actual = pngSize(ctx.buf(rel));
    sizes[rel] = actual;
    if (!actual || actual[0] !== expected[0] || actual[1] !== expected[1]) sizeMismatch.push({ path: rel, expected, actual });
  }
  const html = ctx.exists('index.html') ? ctx.text('index.html') : null;
  if (html === null) return R.attention(R.inconclusive, { reason: 'HTML_ENTRY_NOT_FOUND', missing, size_mismatch: sizeMismatch });
  const links = linkTags(html);
  const htmlMissing = rule.html_links_required.filter((req) => {
    const want = req.split('=')[1].toLowerCase();
    return !links.some((l) => l.rel.includes(want));
  });
  const manifestLink = links.find((l) => l.rel.includes('manifest'));
  let manifestRel = manifestLink ? appRel(manifestLink.href) : null;
  if (!manifestRel) manifestRel = ['manifest.webmanifest', 'manifest.json'].find((f) => ctx.exists(f)) || null;
  const manifestProblems = [];
  if (!manifestRel || !ctx.exists(manifestRel)) {
    manifestProblems.push('MANIFEST_NOT_FOUND');
  } else {
    let m = null;
    try { m = JSON.parse(ctx.text(manifestRel)); } catch { manifestProblems.push('MANIFEST_INVALID_JSON'); }
    if (m) {
      for (const f of rule.manifest_fields_required) if (m[f] === undefined || m[f] === null || m[f] === '') manifestProblems.push(`FIELD:${f}`);
      const icons = Array.isArray(m.icons) ? m.icons : [];
      for (const req of rule.manifest_icons_required) {
        const [key, val] = req.startsWith('purpose:') ? ['purpose', req.slice('purpose:'.length)] : ['sizes', req];
        if (!icons.some((i) => String(i[key] || '').split(/\s+/).includes(val))) manifestProblems.push(`ICON:${req}`);
      }
    }
  }
  const evidence = { sizes, missing, size_mismatch: sizeMismatch, manifest: manifestRel, manifest_problems: manifestProblems, html_links_missing: htmlMissing };
  if (missing.length) return R.fail('ICON_MISSING', evidence);
  if (sizeMismatch.length) return R.fail('ICON_SIZE_MISMATCH', evidence);
  if (manifestProblems.length || htmlMissing.length) return R.fail('MANIFEST_INCOMPLETE', evidence);
  return R.pass(evidence);
}

function countMatches(re, text) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n += 1;
  return n;
}

// 비밀 문자열 자체는 저장·반환·출력하지 않는다. 경로·규칙 ID·건수만 남긴다.
function judgeSecretScan(check, ctx, R) {
  const rule = check.rule;
  const pats = Object.entries(rule.patterns).map(([id, src]) => [id, new RegExp(src, 'g')]);
  const envFail = new RegExp(rule.env_files_fail);
  const hits = [];
  const envFiles = [];
  const unscanned = [];
  let binaryScanned = 0;
  for (const rel of ctx.files) {
    const base = rel.split('/').pop();
    if (envFail.test(base) && !rule.env_files_allowed_if_clean.includes(base)) envFiles.push(rel);
    const s = ctx.scanText(rel);
    if (!s) { unscanned.push(rel); continue; }
    if (s.binary) binaryScanned += 1;
    for (const [id, re] of pats) {
      const n = countMatches(re, s.text);
      if (n) hits.push({ path: rel, rule_id: id, count: n });
    }
  }
  const total = hits.reduce((s, h) => s + h.count, 0);
  const evidence = { scanned_files: ctx.files.length, binary_scanned_as_latin1: binaryScanned, unscanned, rules: pats.map(([id]) => id), hits, env_files: envFiles };
  if (total > rule.max_hits) return R.fail('SECRET_DETECTED', evidence);
  if (unscanned.length) return R.attention(R.inconclusive, { ...evidence, reason: 'FILES_NOT_SCANNED' });
  if (envFiles.length) return R.fail('ENV_FILE_PRESENT', evidence);
  return R.pass(evidence);
}

// ST-04: 식별자는 checks.json이 아니라 policies.private_identifiers의 local 설정에서 온다 (env.identifiers).
// 설정을 불러오지 못했으면 NOT_RUN만 남긴다. evidence에는 opaque id·가린 경로·건수만 담는다.
function judgePatternAbsent(check, ctx, R, env) {
  const rule = check.rule;
  const ids = env.identifiers;
  if (!ids || !ids.ok) {
    return R.notRun({ reason: 'IDENTIFIERS_CONFIG_UNAVAILABLE', failure_code: identifiersSummary(ids).failure_code }, IDENTIFIERS_NEXT);
  }
  const mask = (rel) => maskText(rel, ids);
  const hits = [];
  const unscanned = [];
  let binaryScanned = 0;
  try {
    for (const rel of ctx.files) {
      if (rule.targets.includes('path')) {
        for (const e of ids.entries) if (countIdentifier(e, rel)) hits.push({ path: mask(rel), id: e.id, target: 'path' });
      }
      if (rule.targets.includes('content')) {
        const s = ctx.scanText(rel);
        if (!s) { unscanned.push(mask(rel)); continue; }
        if (s.binary) binaryScanned += 1;
        for (const e of ids.entries) {
          const n = countIdentifier(e, s.text);
          if (n) hits.push({ path: mask(rel), id: e.id, target: 'content', count: n });
        }
      }
    }
  } catch (e) {
    if (e.code !== ZERO_LENGTH_MATCH) throw e;
    return R.attention(R.inconclusive, { reason: 'ZERO_LENGTH_MATCH', identifiers: ids.entries.map((x) => x.id) });
  }
  const evidence = { scanned_files: ctx.files.length, binary_scanned_as_latin1: binaryScanned, unscanned, identifiers: ids.entries.map((e) => e.id), hits };
  if (hits.length > rule.max_hits) return R.fail(check.failure_code[0], evidence);
  if (unscanned.length) return R.attention(R.inconclusive, { ...evidence, reason: 'FILES_NOT_SCANNED' });
  return R.pass(evidence);
}

const JS_SOURCE = /\.(m?js|jsx|ts|tsx)$/i;
const JS_CANDIDATES = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx', '/index.js', '/index.mjs', '/index.jsx', '/index.ts', '/index.tsx'];
const HTML_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const JS_IMPORT = /(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bexport\s+[^'"()]*?\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
const JS_DYNAMIC_NONLITERAL = /\bimport\s*\(\s*[^'"\s)]/;

// ST-05 UI 위치: ST-01이 감지한 진입점과, 그 진입점이 참조하는 앱 내부 로컬 JS 파일(정적 import·script src).
// 외부 URL과 패키지(bare import)는 검색하지 않고 개수만 기록한다. 범위를 확정할 수 없으면 unresolved에 남긴다.
function collectUiSources(ctx, env) {
  const entries = getCheck(env.checksData, 'ST-01').rule.entry_any.flatMap(expandBraces).filter((f) => ctx.exists(f));
  const queue = [...entries];
  const sources = [];
  const external = [];
  const unresolved = [];
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    sources.push(file);
    const text = ctx.text(file);
    if (text === null) { unresolved.push({ path: file, reason: 'NOT_TEXT' }); continue; }
    const isHtml = /\.html?$/i.test(file);
    if (!isHtml && JS_DYNAMIC_NONLITERAL.test(text)) unresolved.push({ path: file, reason: 'DYNAMIC_IMPORT' });
    const refs = [...text.matchAll(isHtml ? HTML_SCRIPT : JS_IMPORT)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) { external.push(ref); continue; }
      if (!isHtml && !ref.startsWith('.') && !ref.startsWith('/')) { external.push(ref); continue; }
      const clean = ref.split(/[?#]/)[0];
      const base = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(file), clean);
      const norm = path.posix.normalize(base);
      if (norm.startsWith('..')) { unresolved.push({ path: file, ref, reason: 'OUTSIDE_APP' }); continue; }
      const hit = JS_CANDIDATES.map((s) => `${norm}${s}`).find((c) => ctx.exists(c));
      if (!hit) { unresolved.push({ path: file, ref, reason: 'NOT_FOUND' }); continue; }
      if (JS_SOURCE.test(hit)) queue.push(hit);
    }
  }
  return { sources, external, unresolved };
}

function judgeVersionMatch(check, ctx, R, env) {
  const target = env.input.target_version;
  const semver = new RegExp(getCheck(env.checksData, 'IN-01').rule.target_version_regex.replace(/^\^|\$$/g, ''), 'g');
  const all = (text) => [...(text || '').matchAll(semver)].map((m) => m[0]);
  const locations = {};
  const na = (reason) => ({ status: 'NOT_APPLICABLE', reason });
  const found = (values) => ({ status: 'FOUND', values });

  if (ctx.exists('package.json')) {
    let v = null;
    try { v = JSON.parse(ctx.text('package.json')).version; } catch { v = null; }
    locations['package.json'] = typeof v === 'string' ? found([v]) : na('package.json에 version 없음');
  } else locations['package.json'] = na('package.json 없음');

  const ui = collectUiSources(ctx, env);
  if (ui.unresolved.length) {
    return R.attention(R.inconclusive, { target, reason: 'UI_SOURCE_SCOPE_UNRESOLVED', ui_sources: ui.sources, unresolved: ui.unresolved });
  }
  const uiValues = ui.sources.flatMap((f) => all(ctx.text(f)).map((v) => v.replace(/^v/, '')));
  locations.ui = uiValues.length
    ? { ...found(uiValues), sources: ui.sources, external_refs_skipped: ui.external.length }
    : { ...na('진입점과 참조 로컬 JS에 버전 표시 없음'), sources: ui.sources, external_refs_skipped: ui.external.length };

  const readme = ctx.exists('README.md') ? all(ctx.text('README.md')) : [];
  locations.README = readme.length ? found(readme) : na('README.md에 버전 없음');

  const heading = ctx.exists('CHANGELOG.md')
    ? (ctx.text('CHANGELOG.md') || '').split(/\r\n|\r|\n/).find((l) => /^#{1,6}\s/.test(l) && all(l).length)
    : null;
  locations.CHANGELOG = heading ? found([all(heading)[0]]) : na('CHANGELOG.md에 버전 제목 없음');

  const declared = env.input.declared_version_file;
  if (declared && ctx.exists(declared)) {
    const v = all(ctx.text(declared));
    locations.declared = v.length ? found([v[0]]) : na('선언된 버전 파일에 버전 없음');
  } else locations.declared = na(declared ? '선언된 버전 파일 없음' : '선언된 버전 파일 입력 없음');

  const foundLocs = Object.values(locations).filter((l) => l.status === 'FOUND');
  const evidence = { target, locations };
  if (!foundLocs.length) return R.attention(R.inconclusive, { ...evidence, reason: 'NO_VERSION_LOCATION' });
  if (foundLocs.some((l) => l.values.some((v) => v !== target))) return R.fail('VERSION_MISMATCH', evidence);
  return R.pass(evidence);
}

function judgeSourceHash(check, ctx, R, env) {
  const policy = env.checksData.policies.source_document_hashing;
  const docs = env.checksData.source_documents.map((d) => {
    const abs = path.resolve(env.root, d.path);
    if (!isInside(env.root, abs) || !fs.existsSync(abs)) return { path: d.path, recorded: d.sha256, current: null };
    return { path: d.path, recorded: d.sha256, current: normalizedFileHash(abs, policy) };
  });
  const drift = docs.filter((d) => d.current !== d.recorded);
  const unregistered = validateChecks(env.checksData).filter((e) => e.startsWith('SOURCE_NOT_REGISTERED'));
  const evidence = { base: 'harness_root', documents: docs, unregistered };
  if (drift.length) return R.fail('STANDARDS_DRIFT', evidence);
  if (unregistered.length) return R.fail('SOURCE_NOT_REGISTERED', evidence);
  return R.pass(evidence);
}

// ---------- DS ----------

function propMatches(prop, names) {
  return [].concat(names).some((p) => {
    if (prop === p || prop.startsWith(`${p}-`) || prop.endsWith(`-${p}`)) return true;
    const parts = p.split('-');
    return parts.length > 1 && prop.startsWith(`${parts[0]}-`) && prop.endsWith(`-${parts[parts.length - 1]}`);
  });
}

function effectiveRule(check, env) {
  const o = getOverride(env.checksData, env.input, check.check_id);
  if (o && !o.rejected) return { rule: { ...check.rule, ...o.value }, basis: 'override', override_rejected: false };
  return { rule: check.rule, basis: 'default', override_rejected: Boolean(o && o.rejected) };
}

// `font` 단축 속성은 line-height·font-family를 함께 바꿀 수 있어 추정하지 않는다 (CSS 키워드 값은 제외).
function fontShorthand(css) {
  return css.decls
    .filter((d) => d.prop === 'font' && !CSS_KEYWORDS.includes(d.value.toLowerCase()))
    .map((d) => ({ selector: d.selector, value: d.value, source: d.source }));
}

function cssPrecheck(ctx, R, css) {
  if (!css.sources.length) return R.attention(R.inconclusive, { reason: 'NO_CSS_SOURCE' });
  if (css.markers.length) return R.attention(R.inconclusive, { reason: 'UNSUPPORTED_STYLE_SOURCE', markers: css.markers });
  return null;
}

function judgeCssValues(check, ctx, R, env) {
  const css = env.css();
  const pre = cssPrecheck(ctx, R, css);
  if (pre) return pre;
  const { rule, basis, override_rejected } = effectiveRule(check, env);
  const decls = css.decls.filter((d) => !d.prop.startsWith('--') && propMatches(d.prop, rule.property));
  const violations = [];
  const inconclusive = [];
  const allowedStr = (rule.allowed || []).map((a) => normZero(String(a)));
  for (const d of decls) {
    for (const raw of tokens(d.value)) {
      const t = normZero(raw.toLowerCase());
      if (rule.unit === 'px') {
        if (CSS_KEYWORDS.includes(t)) continue;
        const px = t === '0' ? 0 : (/^(-?\d*\.?\d+)px$/.exec(t) || [])[1];
        if (px === undefined) { inconclusive.push({ ...d, token: raw }); continue; }
        if (!rule.allowed.includes(Number(px))) violations.push({ ...d, token: raw });
      } else {
        if (/\(/.test(t)) { inconclusive.push({ ...d, token: raw }); continue; }
        const iconOk = rule.allowed_for_icon && /icon/i.test(d.selector) && rule.allowed_for_icon.includes(t);
        if (!allowedStr.includes(t) && !iconOk) violations.push({ ...d, token: raw });
      }
    }
  }
  const evidence = { basis, override_rejected, sources: css.sources, declarations_checked: decls.length, violations, inconclusive };
  if (violations.length) return R.fail(check.failure_code[0], evidence);
  if (inconclusive.length) return R.attention(R.inconclusive, evidence);
  return R.pass(evidence);
}

function judgeLineHeight(check, ctx, R, env) {
  const css = env.css();
  const pre = cssPrecheck(ctx, R, css);
  if (pre) return pre;
  const { rule, basis, override_rejected } = effectiveRule(check, env);
  const shorthand = fontShorthand(css);
  if (shorthand.length) return R.attention(R.inconclusive, { basis, override_rejected, sources: css.sources, reason: 'FONT_SHORTHAND', declarations: shorthand });
  const lh = css.decls.filter((d) => d.prop === 'line-height');
  const htmlText = ctx.files.filter((f) => /\.html?$/i.test(f)).map((f) => ctx.text(f) || '').join('\n');
  const violations = [];
  const inconclusive = [];
  const judged = [];
  const valuesFor = (sel) => lh.filter((d) => selectorList(d.selector).includes(sel));
  const [lo, hi] = rule.headings.range;
  for (const sel of rule.headings.selectors) {
    const vals = valuesFor(sel);
    if (!vals.length) {
      if (new RegExp(`<${sel}\\b`, 'i').test(htmlText)) inconclusive.push({ selector: sel, reason: 'USED_WITHOUT_DECLARATION' });
      continue;
    }
    for (const d of vals) {
      const n = Number(d.value);
      judged.push({ selector: sel, value: d.value });
      if (!/^\d*\.?\d+$/.test(d.value) || n < lo || n > hi) violations.push({ selector: sel, value: d.value, source: d.source });
    }
  }
  const bodyDecls = rule.body.selectors.flatMap((sel) => valuesFor(sel).map((d) => ({ sel, d })));
  if (!bodyDecls.length) inconclusive.push({ selector: rule.body.selectors.join(','), reason: 'NOT_DECLARED' });
  for (const { sel, d } of bodyDecls) {
    judged.push({ selector: sel, value: d.value });
    if (Number(d.value) !== rule.body.value || !/^\d*\.?\d+$/.test(d.value)) violations.push({ selector: sel, value: d.value, source: d.source });
  }
  const evidence = { basis, override_rejected, sources: css.sources, judged, violations, inconclusive };
  if (violations.length) return R.fail(check.failure_code[0], evidence);
  if (inconclusive.length) return R.attention(R.inconclusive, evidence);
  return R.pass(evidence);
}

function judgeFontFamily(check, ctx, R, env) {
  const css = env.css();
  const pre = cssPrecheck(ctx, R, css);
  if (pre) return pre;
  const { rule, basis, override_rejected } = effectiveRule(check, env);
  const shorthand = fontShorthand(css);
  if (shorthand.length) return R.attention(R.inconclusive, { basis, override_rejected, sources: css.sources, reason: 'FONT_SHORTHAND', declarations: shorthand });
  const decls = css.decls.filter((d) => d.prop === 'font-family' && !CSS_KEYWORDS.includes(d.value.toLowerCase()));
  const first = new RegExp(rule.first_matches);
  const violations = [];
  for (const d of decls) {
    const fams = d.value.split(',').map((f) => f.trim().replace(/'/g, '"'));
    if (!first.test(fams[0]) || fams[fams.length - 1] !== rule.last_equals) violations.push({ selector: d.selector, value: d.value, source: d.source });
  }
  const evidence = { basis, override_rejected, sources: css.sources, declarations_checked: decls.length, violations };
  if (!decls.length) return R.attention(R.inconclusive, { ...evidence, reason: 'NO_FONT_FAMILY' });
  if (violations.length) return R.fail(check.failure_code[0], evidence);
  return R.pass(evidence);
}

const JUDGES = {
  structure: judgeStructure,
  icon_set: judgeIconSet,
  secret_scan: judgeSecretScan,
  pattern_absent: judgePatternAbsent,
  version_match: judgeVersionMatch,
  source_hash_match: judgeSourceHash,
  css_property_values: judgeCssValues,
  css_line_height: judgeLineHeight,
  css_font_family: judgeFontFamily,
};

// identifiers는 호출자가 주입한다 (CLI는 loadIdentifiers(ROOT), 테스트는 fixture). 없으면 설정 없음과 같다.
export function judgeStatic({ root, checksData, input, identifiers }) {
  const checks = checksData.checks.filter((c) => c.stage === STAGE);
  const fp = computeFingerprint(input.app_path, checksData.policies.fingerprint);
  const baseMeta = { standards_version: checksData.standards_version, policy_codes: policyCodes(checksData) };
  if (fp.status !== 'OK') {
    return {
      stage: STAGE,
      run_status: fp.status,
      blocked: { failure_code: fp.failure_code, links: fp.links },
      fingerprint: null,
      standards_version: checksData.standards_version,
      items: checks.map((c) => makeItem(c, { status: 'NOT_RUN', next_action: 'link 제거 후 2단계부터 재실행' }, { ...baseMeta, fingerprint: null })),
    };
  }
  const ctx = buildContext(fp, checksData.policies.content_scan);
  const meta = { ...baseMeta, fingerprint: fp.value };
  let cssCache = null;
  const env = { root, checksData, input, identifiers, css: () => (cssCache ||= collectCss(ctx)) };
  const inconclusive = checksData.policies.inconclusive.failure_code;

  const items = checks.map((check) => {
    const R = {
      inconclusive,
      pass: (evidence) => makeItem(check, { status: 'PASS', evidence }, meta),
      fail: (code, evidence) => makeItem(check, { status: 'FAIL', evidence, failure_code: code, next_action: FAIL_NEXT }, meta),
      attention: (code, evidence) => makeItem(check, { status: 'NEEDS_ATTENTION', evidence, failure_code: code, next_action: ATTN_NEXT }, meta),
      notRun: (evidence, next) => makeItem(check, { status: 'NOT_RUN', evidence, next_action: next }, meta),
    };
    const applies = appliesWhen(check.applies_when, input);
    if (applies === null) return R.attention(inconclusive, { reason: 'APPLIES_WHEN_UNPARSEABLE' });
    if (applies === false) {
      return makeItem(check, { status: 'NOT_APPLICABLE', evidence: { reason: `applies_when 불충족: ${check.applies_when}` } }, meta);
    }
    const judge = JUDGES[check.rule.type];
    if (!judge) return R.attention(inconclusive, { reason: 'RULE_TYPE_UNSUPPORTED' });
    try {
      return judge(check, ctx, R, env);
    } catch (e) {
      return R.attention(inconclusive, { reason: 'JUDGE_ERROR', error_code: e.code || 'UNEXPECTED' });
    }
  });

  return {
    stage: STAGE,
    run_status: stageRunStatus(items),
    fingerprint: fp.value,
    fingerprint_type: fp.type,
    standards_version: checksData.standards_version,
    identifiers_config: identifiersSummary(identifiers),
    items,
  };
}
