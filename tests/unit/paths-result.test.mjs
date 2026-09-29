import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, withTemp, writeFiles } from './helpers.mjs';
import { getCheck, loadChecks } from '../../scripts/lib/checks.mjs';
import { deriveAppSlug, findSlugCollision, resolveRunDir } from '../../scripts/lib/paths.mjs';
import { makeItem, policyCodes, writeNoClobber, readStageResult } from '../../scripts/lib/result.mjs';

const { data } = loadChecks(REPO);
const slugRe = getCheck(data, 'IN-01').rule.app_slug_regex;
const meta = { fingerprint: 'fp', standards_version: data.standards_version, policy_codes: policyCodes(data) };

test('runs/ 밖의 경로와 .. 경로는 거부한다', () => withTemp((t) => {
  fs.mkdirSync(path.join(t, 'runs', 'a', 'r1'), { recursive: true });
  fs.mkdirSync(path.join(t, 'other'));
  assert.equal(resolveRunDir(t, path.join(t, 'other')).code, 'RUN_DIR_OUTSIDE_RUNS');
  assert.equal(resolveRunDir(t, path.join(t, 'runs', '..', 'other')).code, 'RUN_DIR_OUTSIDE_RUNS');
  assert.equal(resolveRunDir(t, path.join(t, 'runs')).code, 'RUN_DIR_OUTSIDE_RUNS');
  assert.equal(resolveRunDir(t, path.join(t, 'runs', 'a', 'r1')).ok, true);
}));

test('app_slug는 규칙에 맞으면 DERIVED, 아니면 자동 변환 없이 거부한다', () => {
  assert.deepEqual(deriveAppSlug('/x/sample-app', slugRe), { ok: true, slug: 'sample-app', source: 'DERIVED' });
  assert.equal(deriveAppSlug('/x/Sample_App', slugRe).code, 'APP_SLUG_INVALID');
  assert.equal(deriveAppSlug('/x/Sample_App', slugRe, 'my-app').source, 'USER_PROVIDED');
});

test('같은 slug가 다른 app_path를 가리키면 충돌', () => withTemp((t) => {
  writeFiles(t, { 'runs/app/r1/input.json': JSON.stringify({ app_path_canonical: 'C:/somewhere/else' }) });
  assert.ok(findSlugCollision(t, 'app', 'C:/here/app'));
  assert.equal(findSlugCollision(t, 'app', 'C:/somewhere/else'), null);
}));

test('근거 없는 PASS·NOT_APPLICABLE은 만들 수 없다', () => {
  const c = getCheck(data, 'ST-01');
  assert.throws(() => makeItem(c, { status: 'PASS', evidence: {} }, meta), { code: 'EVIDENCE_REQUIRED' });
  assert.throws(() => makeItem(c, { status: 'NOT_APPLICABLE', evidence: '' }, meta), { code: 'EVIDENCE_REQUIRED' });
});

test('check에 없는 failure_code의 FAIL은 만들 수 없다', () => {
  const c = getCheck(data, 'ST-01');
  assert.throws(() => makeItem(c, { status: 'FAIL', evidence: { x: 1 }, failure_code: 'NOT_A_CODE' }, meta), { code: 'FAILURE_CODE_INVALID' });
});

test('결과 파일은 덮어쓰지 않고, 부분 작성 파일은 인정하지 않는다', () => withTemp((t) => {
  writeNoClobber(t, '02-static.a1.json', '{"complete":true,"items":[]}');
  assert.throws(() => writeNoClobber(t, '02-static.a1.json', 'OTHER'), { code: 'RESULT_FILE_EXISTS' });
  assert.equal(fs.readFileSync(path.join(t, '02-static.a1.json'), 'utf8'), '{"complete":true,"items":[]}');
  assert.equal(fs.readdirSync(t).filter((n) => n.endsWith('.tmp')).length, 0);
  fs.writeFileSync(path.join(t, 'partial.json'), '{"items":[]');
  fs.writeFileSync(path.join(t, 'nocomplete.json'), '{"items":[]}');
  assert.equal(readStageResult(path.join(t, 'partial.json')), null);
  assert.equal(readStageResult(path.join(t, 'nocomplete.json')), null);
}));
