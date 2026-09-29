import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, makeApp, withTemp, writeFiles } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { computeFingerprint } from '../../scripts/lib/fingerprint.mjs';

const policy = loadChecks(REPO).data.policies.fingerprint;

test('제외 폴더와 제외 파일은 fingerprint에 영향을 주지 않는다', () => withTemp((t) => {
  const app = makeApp(t);
  const before = computeFingerprint(app, policy).value;
  writeFiles(app, { 'node_modules/x/index.js': 'x', 'debug.log': 'log', 'runs/a.json': '{}', 'Thumbs.db': 'x', '.DS_Store': 'x' });
  assert.equal(computeFingerprint(app, policy).value, before);
}));

test('파일 1바이트 변경을 감지한다', () => withTemp((t) => {
  const app = makeApp(t);
  const before = computeFingerprint(app, policy).value;
  fs.appendFileSync(path.join(app, 'README.md'), ' ');
  assert.notEqual(computeFingerprint(app, policy).value, before);
}));

test('파일을 만든 순서와 무관하게 같은 값이다', () => withTemp((t) => {
  const a = path.join(t, 'a');
  const b = path.join(t, 'b');
  writeFiles(a, { 'x.txt': '1', 'dir/y.txt': '2' });
  writeFiles(b, { 'dir/y.txt': '2', 'x.txt': '1' });
  assert.equal(computeFingerprint(a, policy).value, computeFingerprint(b, policy).value);
}));

test('제외 폴더 밖의 junction·symlink는 따라가지 않고 BLOCKED', (t) => withTemp((tmp) => {
  const app = makeApp(tmp);
  const outside = path.join(tmp, 'outside');
  writeFiles(outside, { 'secret.txt': 'outside' });
  try {
    fs.symlinkSync(outside, path.join(app, 'linked'), 'junction');
  } catch {
    t.skip('이 환경에서 junction을 만들 수 없음');
    return;
  }
  const fp = computeFingerprint(app, policy);
  assert.equal(fp.status, policy.links_outside_excluded.status);
  assert.equal(fp.failure_code, policy.links_outside_excluded.failure_code);
  assert.deepEqual(fp.links, ['linked']);
}));

test('제외 폴더 안의 link는 건너뛴다', (t) => withTemp((tmp) => {
  const app = makeApp(tmp);
  const outside = path.join(tmp, 'outside');
  writeFiles(outside, { 'a.txt': 'a' });
  fs.mkdirSync(path.join(app, 'node_modules'));
  try {
    fs.symlinkSync(outside, path.join(app, 'node_modules', 'pkg'), 'junction');
  } catch {
    t.skip('이 환경에서 junction을 만들 수 없음');
    return;
  }
  assert.equal(computeFingerprint(app, policy).status, 'OK');
}));

test('checks.json 제외 목록과 docs/harness-artifacts.md 6절 목록이 같다', () => {
  const md = fs.readFileSync(path.join(REPO, 'docs', 'harness-artifacts.md'), 'utf8');
  const section = md.split(/^## 6\./m)[1].split(/^## 7\./m)[0];
  const block = /```text\r?\n([\s\S]*?)```/.exec(section.split('### 제외 목록')[1])[1];
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dirs = lines.filter((l) => l.endsWith('/')).map((l) => l.slice(0, -1));
  const globs = lines.filter((l) => !l.endsWith('/'));
  assert.deepEqual([...dirs].sort(), [...policy.exclude_dirs].sort());
  assert.deepEqual([...globs].sort(), [...policy.exclude_globs].sort());
});
