// hook-guard 단위 테스트. 모두 모의 hook 입력이며, 실제 push·삭제·보호 경로 쓰기를 실행하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, withTemp, writeFiles } from './helpers.mjs';
import { Deny, decide } from '../../scripts/hook-guard.mjs';

const RUN = 'runs/sample-app/20260930-090000-KST-abc123';
const bash = (command, agent = null) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: REPO, ...(agent ? { agent_id: 'a1', agent_type: agent } : {}) });
const tool = (name, input, agent = null) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, cwd: REPO, ...(agent ? { agent_id: 'a1', agent_type: agent } : {}) });
const allowed = (input, opts = {}) => { decide(input, { projectDir: REPO, ...opts }); return true; };
const denied = (input, opts = {}) => {
  try {
    decide(input, { projectDir: REPO, ...opts });
    return null;
  } catch (e) {
    if (e instanceof Deny) return e.message;
    throw e;
  }
};

test('역할별 허용 명령은 정확히 일치할 때만 허용', () => {
  assert.ok(allowed(bash(`node scripts/run-stage.mjs 2 ${RUN}`, 'harness-runner')));
  assert.ok(allowed(bash(`node scripts/run-stage.mjs 4 ${RUN}`, 'harness-runner')));
  assert.ok(allowed(bash(`node scripts/write-release.mjs ${RUN}`, 'release-recorder')));
  assert.ok(allowed(bash(`node scripts/judge.mjs ${RUN}`, 'gate-judge')));
});

test('한 글자라도 다르거나 셸 결합이 있으면 차단', () => {
  const variants = [
    `node scripts/judge.mjs ${RUN} `,
    ` node scripts/judge.mjs ${RUN}`,
    `node scripts/judge.mjs ${RUN}x`,
    `node scripts/judge.mjs ${RUN} && echo hi`,
    `node scripts/judge.mjs ${RUN}; rm -rf runs`,
    `node scripts/judge.mjs ${RUN} | tee out.txt`,
    `node scripts/judge.mjs ${RUN} > out.json`,
    `node scripts/judge.mjs $(echo ${RUN})`,
    `node scripts/judge.mjs \`echo ${RUN}\``,
    `node scripts/judge.mjs $RUN`,
    `node scripts/judge.mjs ${RUN}\nrm -rf docs`,
    `node scripts/judge.mjs "${RUN}"`,
    'node scripts/judge.mjs runs/sample-app/../../docs',
    `node  scripts/judge.mjs ${RUN}`,
    `node scripts/run-stage.mjs 2 ${RUN}`,
  ];
  for (const cmd of variants) assert.ok(denied(bash(cmd, 'gate-judge')), JSON.stringify(cmd));
});

test('세 역할은 쓰기 도구와 PowerShell을 쓸 수 없다', () => {
  for (const role of ['harness-runner', 'release-recorder', 'gate-judge']) {
    assert.ok(denied(tool('Write', { file_path: 'docs/x.md', content: 'x' }, role)), role);
    assert.ok(denied(tool('Edit', { file_path: `${RUN}/run.json`, old_string: 'a', new_string: 'b' }, role)), role);
    assert.ok(denied(tool('PowerShell', { command: 'Get-ChildItem' }, role)), role);
    assert.ok(allowed(tool('Read', { file_path: 'docs/PRD.md' }, role)), role);
  }
});

test('main / subagent / unknown 구분', () => {
  assert.ok(allowed(tool('Write', { file_path: 'docs/new.md', content: 'x' })));
  assert.match(denied(tool('Write', { file_path: 'docs/x.md' }, 'general-purpose')), /알 수 없는 subagent/);
  assert.match(denied({ ...bash('ls'), agent_id: 'a1' }), /알 수 없는 subagent/);
  assert.match(denied(bash(`node scripts/judge.mjs ${RUN}`), { expectRole: 'gate-judge' }), /역할 불일치/);
  assert.match(denied(bash(`node scripts/judge.mjs ${RUN}`, 'harness-runner'), { expectRole: 'gate-judge' }), /역할 불일치/);
  assert.match(denied({ tool_name: 42 }), /해석할 수 없음/);
});

test('F10: runner의 docs/ 쓰기와 main의 git push 요청은 차단', () => {
  assert.ok(denied(tool('Write', { file_path: 'docs/harness-roles.md', content: 'x' }, 'harness-runner')));
  assert.ok(denied(bash('git push origin main')));
});

test('git push와 파괴적 Git 변형을 차단', () => {
  const cmds = [
    'git push', 'git push origin main', 'git -C "C:/some path" push', 'git -c core.x=y push --tags',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push', 'git.exe push origin', '& git push', 'cmd /c git push',
    'sh -c "git push origin main"', 'echo ok && git push', 'git push --force', 'git push -f', 'git push --force-with-lease',
    'git reset --hard HEAD~1', 'git checkout -f main', 'git checkout -fb x', 'git switch --discard-changes main', 'git switch -f main',
    'git branch -D old', 'git branch -Dq old', 'git branch --delete --force old', 'git clean -f', 'git clean -fd', 'git clean -fx', 'git clean -xdf',
    'git commit --amend --force',
  ];
  for (const c of cmds) assert.ok(denied(bash(c)), c);
  for (const c of ['git status', 'git log --oneline -3', 'git add docs/x.md', 'git commit -m "docs: x"', 'git branch', 'git checkout main']) assert.ok(allowed(bash(c)), c);
});

test('보호 경로를 향한 redirect·tee·cp·mv·rm·Remove-Item 차단', () => {
  const cmds = [
    `echo x > ${RUN}/run.json`, 'echo x >> releases/sample-app/v1.0.0.md', 'cat a | tee runs/x.json', 'cp a.json runs/x/a.json',
    'copy a.json releases\\x.md', 'mv a runs/b', 'rm -rf runs', 'rm -rf .git', 'del releases\\x.md',
    'Remove-Item -Recurse runs', 'Set-Content -Path runs/x.json -Value 1', 'Out-File -FilePath releases/x.md', 'sed -i s/a/b/ runs/x/run.json',
  ];
  for (const c of cmds) {
    assert.ok(denied(bash(c)), c);
    assert.ok(denied(tool('PowerShell', { command: c })), `PS ${c}`);
  }
  for (const c of ['cat runs/a/run.json', `node scripts/judge.mjs ${RUN}`, 'rm -rf node_modules/.cache', 'cp README.md docs/README.md']) assert.ok(allowed(bash(c)), c);
});

test('R5: 메인 세션은 runner·recorder 전용 스크립트를 직접 실행할 수 없다', () => {
  for (const c of [`node scripts/run-stage.mjs 2 ${RUN}`, `node scripts/write-release.mjs ${RUN}`, `node "scripts/run-stage.mjs" 3 ${RUN}`,
    `cd x && node C:\\repo\\scripts\\write-release.mjs ${RUN}`, `node ./scripts/run-stage.mjs 4 ${RUN}`]) {
    assert.match(denied(bash(c)), /역할 전용 스크립트/, c);
    assert.match(denied(tool('PowerShell', { command: c })), /역할 전용 스크립트/, `PS ${c}`);
  }
  assert.ok(allowed(bash(`node scripts/run-stage.mjs 2 ${RUN}`, 'harness-runner')));
  assert.ok(allowed(bash(`node scripts/write-release.mjs ${RUN}`, 'release-recorder')));
});

test('Write·Edit: 저장소 밖, .git, runs·releases 직접 쓰기, symlink·junction 경로 차단', (t) => withTemp((tmp) => {
  const root = path.join(tmp, 'proj');
  writeFiles(root, { 'docs/a.md': 'a', '.git/HEAD': 'x' });
  writeFiles(tmp, { 'outside/x.md': 'x' });
  const w = (p) => tool('Write', { file_path: p, content: 'x' });
  const opts = { projectDir: root };
  assert.ok(allowed(w('docs/b.md'), opts));
  assert.ok(allowed(w(path.join(root, 'docs', 'c.md')), opts));
  assert.match(denied(w(path.join(tmp, 'outside', 'x.md')), opts), /저장소 밖/);
  assert.match(denied(w('../outside/x.md'), opts), /저장소 밖/);
  assert.match(denied(w('.git/config'), opts), /\.git/);
  assert.match(denied(w('runs/a/run.json'), opts), /직접 쓰기 금지/);
  assert.match(denied(w('releases/a/v1.md'), opts), /직접 쓰기 금지/);
  try {
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'linked'), 'junction');
  } catch {
    t.skip('이 환경에서 junction을 만들 수 없음');
    return;
  }
  assert.match(denied(w('linked/x.md'), opts), /symlink|저장소 밖/);
}));

test('CLI: 허용은 exit 0, 차단은 exit 2와 사유, 잘못된 JSON은 fail closed', () => {
  const run = (input, args = []) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'hook-guard.mjs'), ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: REPO } });
  const ok = run(JSON.stringify(bash(`node scripts/judge.mjs ${RUN}`, 'gate-judge')), ['--expect-role', 'gate-judge', '--scope', 'agent']);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout + ok.stderr, '');
  const blocked = run(JSON.stringify(bash('git push origin main')));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /\[hook-guard:project\] 차단: main: git push/);
  assert.equal(run('{not json').status, 2);
  assert.equal(run('').status, 2);
  const mismatch = run(JSON.stringify(bash(`node scripts/judge.mjs ${RUN}`)), ['--expect-role', 'gate-judge', '--scope', 'agent']);
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /\[hook-guard:agent\] 차단: 역할 불일치/);
});
