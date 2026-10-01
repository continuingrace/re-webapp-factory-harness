// hook-guard 단위 테스트. 모두 모의 hook 입력이며, 실제 push·삭제·보호 경로 쓰기를 실행하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, withTemp, writeFiles } from './helpers.mjs';
import { Deny, decide } from '../../scripts/hook-guard.mjs';
import * as guard from '../../scripts/hook-guard.mjs';

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

// ---------- local 설정 (config/*.local.json) ----------

const LOCAL_TARGETS = [
  'config/identifiers.local.json',
  'CONFIG\\Identifiers.Local.JSON',
  path.join(REPO, 'config', 'public-scan.local.json'),
  `${REPO.replace(/\\/g, '/')}/Config/Identifiers.local.json`,
  './config/../config/identifiers.local.json',
  'config/identifiers.local.json.',
  'config/identifiers.local.json::$DATA',
];

test('local 설정: 모든 역할의 Read·Grep·쓰기 도구 직접 접근 차단 (대소문자·구분자·절대·상대경로 정규화)', () => {
  for (const role of [null, 'harness-runner', 'release-recorder', 'gate-judge']) {
    for (const p of LOCAL_TARGETS) {
      assert.match(denied(tool('Read', { file_path: p }, role)) || '', /local 설정/, `${role} Read ${p}`);
      assert.match(denied(tool('Grep', { pattern: 'x', path: p }, role)) || '', /local 설정/, `${role} Grep ${p}`);
    }
  }
  for (const p of LOCAL_TARGETS) {
    assert.ok(denied(tool('Write', { file_path: p, content: 'x' })), p);
    assert.ok(denied(tool('Edit', { file_path: p, old_string: 'a', new_string: 'b' })), p);
    assert.ok(denied(tool('MultiEdit', { file_path: p, edits: [] })), p);
    assert.ok(denied(tool('NotebookEdit', { notebook_path: p, new_source: 'x' })), p);
  }
});

test('local 설정: schema·example·다른 폴더의 .local.json·일반 문서 Read와 config 폴더 Grep은 허용', () => {
  for (const role of [null, 'gate-judge']) {
    for (const p of ['config/identifiers.schema.json', 'config/identifiers.example.json', 'config/public-scan.schema.json', '.claude/settings.local.json', 'docs/PRD.md']) {
      assert.ok(allowed(tool('Read', { file_path: p }, role)), `${role} ${p}`);
    }
    assert.ok(allowed(tool('Grep', { pattern: 'x', path: 'config' }, role)));
    assert.ok(allowed(tool('Glob', { pattern: 'config/*' }, role)));
  }
});

test('local 설정: Bash·PowerShell로 읽기·출력·수정·복사·재귀 검색하는 명령 차단', () => {
  const cmds = [
    'cat config/identifiers.local.json',
    'type config\\identifiers.local.json',
    'Get-Content CONFIG/IDENTIFIERS.LOCAL.JSON',
    `cat "${REPO}/config/public-scan.local.json"`,
    'cat ./config/./identifiers.local.json',
    'head -c 100 config/identifiers.local.json',
    'cp config/identifiers.local.json x.json',
    'sed -i s/a/b/ config/identifiers.local.json',
    'node -e "console.log(require(\'fs\').readFileSync(\'config/identifiers.local.json\', \'utf8\'))"',
    'cd config && cat identifiers.local.json',
    `cd .. && cat "${path.basename(REPO)}/config/identifiers.local.json"`,
    'cat config/*.json',
    'cat config/*',
    'cat config/identifiers.l*',
    'cat c*/identifiers.local.json',
    'git add config/identifiers.local.json',
    'git show :config/identifiers.local.json',
    'git show HEAD:config/identifiers.local.json',
    'grep -r secret no-such-path',
    'git diff --no-index config/identifiers.local.json x.json',
    'git hash-object config/identifiers.local.json',
    'git ls-files --others --ignored --exclude-standard config | xargs cat',
    'git status --porcelain --ignored | xargs cat',
    'grep -r secret .',
    'grep -R secret config',
    'grep -rn secret',
    `grep -r secret "${REPO}"`,
    'findstr /s secret *',
  ];
  for (const cmd of cmds) {
    assert.match(denied(bash(cmd)) || '', /local 설정/, cmd);
  }
  assert.match(denied(tool('PowerShell', { command: 'Get-Content config\\identifiers.local.json' })) || '', /local 설정/);
  assert.match(denied(tool('PowerShell', { command: 'Copy-Item CONFIG/public-scan.local.json x.json' })) || '', /local 설정/);
});

test('local 설정: 내용을 읽지 않는 Git 상태 확인과 경로 없는 하네스 스크립트 실행은 허용', () => {
  const cmds = [
    'git status --porcelain --ignored config',
    'git status --short config/identifiers.local.json',
    'git check-ignore -q config/identifiers.local.json',
    'git check-ignore -v CONFIG\\IDENTIFIERS.LOCAL.JSON',
    'git -C . ls-files config',
    'git ls-files --error-unmatch config/identifiers.local.json',
    'node scripts/orchestrator/start-run.mjs input.json',
    'node scripts/tools/scan-tracked-identifiers.mjs',
    `node scripts/judge.mjs ${RUN}`,
    'npm test',
    'cat config/identifiers.schema.json',
    'cat .claude/settings.local.json',
    'ls config',
    'grep -rn secret docs',
    'grep -r secret package.json',
  ];
  for (const cmd of cmds) assert.ok(allowed(bash(cmd)), cmd);
});

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
  const readLocal = run(JSON.stringify(tool('Read', { file_path: 'config/identifiers.local.json' }, 'gate-judge')), ['--scope', 'project']);
  assert.equal(readLocal.status, 2);
  assert.match(readLocal.stderr, /gate-judge: local 설정 파일/);
  assert.equal(run(JSON.stringify(tool('Read', { file_path: 'docs/PRD.md' }))).status, 0);
});

test('settings.json: project hook matcher가 Read·Grep도 검사한다', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  const matcher = settings.hooks.PreToolUse[0].matcher.split('|');
  for (const t of ['Read', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.ok(matcher.includes(t), t);
});

// ---------- glob·brace 판정 (fix: harden hook glob matching) ----------

const hookCli = (input, env = {}) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'hook-guard.mjs'), '--scope', 'project'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: REPO, ...env } });
// 오류 메시지에 새면 안 되는 표식 (원문에 그대로 두지 않고 런타임에 결합)
const MARKER = ['leak', 'marker', '7q'].join('-');

test('glob: 짝이 맞지 않는 [ ]가 든 정상 읽기 명령은 hook 내부 예외 없이 허용', () => {
  const cmds = ['grep -n "a[/b" docs/harness-roles.md', 'grep -n "[A-Za-z]:[/]+Users[/]" docs/x.md', 'grep -n "a]/b]" docs/x.md', 'grep -n "x/[y/[z" docs/x.md'];
  for (const c of cmds) {
    assert.ok(allowed(bash(c)), c);
    assert.ok(allowed(tool('PowerShell', { command: c })), `PS ${c}`);
    const r = hookCli(JSON.stringify(bash(c)));
    assert.equal(r.status, 0, c);
    assert.equal(r.stderr, '', c);
  }
});

test('glob: 정규식 메타문자는 리터럴, *·**·?·닫힌 [...]만 glob으로 해석 (대소문자 무시)', () => {
  const m = (p, s) => guard.globToRegExp(p).test(s);
  assert.ok(m('a(b)*', 'a(b)zz'));
  assert.ok(!m('a(b)*', 'ab'));
  assert.ok(!m('c.nfig', 'config'));
  assert.ok(m('c.nfig', 'c.nfig'));
  assert.ok(!m('x+', 'xx'));
  assert.ok(m('^a$', '^a$'));
  assert.ok(!m('a|b', 'a'));
  assert.ok(m('{a,b}', '{a,b}'));
  assert.ok(!m('{a,b}', 'a'));
  assert.ok(m('a\\b', 'a\\b'));
  assert.ok(m('a[', 'a['));
  assert.ok(m(']x[', ']x['));
  assert.ok(m('*', 'anything'));
  assert.ok(m('a**z', 'abcz'));
  assert.ok(m('c?nfig', 'config'));
  assert.ok(!m('c?nfig', 'cnfig'));
  for (const p of ['c[o]nfig', 'c[!x]nfig', 'c[]a]nfig', 'c[[:alpha:]]nfig', 'c[^x]nfig']) assert.ok(m(p, 'config'), p);
  assert.ok(m('CONFIG', 'config'));
});

test('glob: ?·[...]·*·** 기존 차단 범위 유지와 [!x] 차단 보강', () => {
  const cmds = [
    'cat config/identifiers.local.jso?',
    'cat config/identifiers.local.js[o]n',
    'cat config/identifiers.local.js[!x]n',
    'cat c[o]nfig/*.json',
    'cat co?fig/identifiers.l*',
    'cat config/**',
    'cat config/*',
  ];
  for (const c of cmds) assert.match(denied(bash(c)) || '', /local 설정/, c);
});

test('glob: 잘못된 내부 패턴은 명시적 코드로 fail-closed, 원문 비노출', () => {
  const tryMatch = (compile) => {
    try {
      guard.globMatches(MARKER, ['x'], compile);
      return null;
    } catch (e) {
      assert.ok(e instanceof Deny);
      return e.message;
    }
  };
  const thrown = tryMatch(() => { throw new SyntaxError(MARKER); });
  assert.match(thrown || '', /HOOK_GLOB_INVALID/);
  assert.ok(!thrown.includes(MARKER));
  assert.match(tryMatch(() => MARKER) || '', /HOOK_GLOB_INVALID/);
});

test('CLI: 판정 중 내부 오류는 HOOK_INTERNAL_ERROR로 차단하고 입력 원문을 출력하지 않음', () => withTemp((tmp) => {
  const missing = path.join(tmp, 'no-such-project');
  const r = hookCli(JSON.stringify(tool('Write', { file_path: `docs/${MARKER}.md`, content: MARKER })), { CLAUDE_PROJECT_DIR: missing });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HOOK_INTERNAL_ERROR/);
  assert.ok(!r.stderr.includes(MARKER));
  assert.ok(!r.stderr.includes('no-such-project'));
}));

const BRACE_BYPASS = [
  'cat config/identifiers.local.{json,x}',
  'cat config/{identifiers,public-scan}.local.json',
  'cat {config,docs}/identifiers.local.json',
  'cat config/identifiers.local.j{s,o}n',
  'cat config/identifiers.local.j{s{o,x},y}n',
  'cat {con{fig,x},docs}/identifiers.local.json',
  'cat config/identifiers.local.jso{m..o}',
  'cat {./config/identifiers,x}.local.json',
  'ls {config,docs}/*',
];

test('brace: 확장으로 local 설정을 가리키는 명령 차단 (Bash·PowerShell)', () => {
  for (const c of BRACE_BYPASS) {
    assert.match(denied(bash(c)) || '', /local 설정/, c);
    assert.match(denied(tool('PowerShell', { command: c })) || '', /local 설정/, `PS ${c}`);
  }
});

test('brace: 정상 리터럴 brace와 local 설정과 무관한 확장은 허용', () => {
  const cmds = ['cat docs/{a}.md', 'grep -n "function f() {" docs/x.md', 'grep -n "}" docs/x.md', 'node -e "console.log({a:1})"', 'cat docs/{a,b}.md', 'cat {config,docs}/README.md'];
  for (const c of cmds) assert.ok(allowed(bash(c)), c);
});

test('brace: 가장 바깥 확장 가능 그룹만 와일드카드로 넓히고 내용은 남기지 않음', () => {
  const w = guard.widenBraces;
  assert.equal(w('a{b,c}d'), 'a*d');
  assert.equal(w(`x{${MARKER},y}z`), 'x*z');
  assert.equal(w('a{b{c,d},e}f'), 'a*f');
  assert.equal(w('{a{b,c}}'), '*');
  assert.equal(w('a{1..9}'), 'a*');
  assert.equal(w('{./config/x,y}.json'), '*/*.json');
  assert.equal(w('a{b}c'), 'a{b}c');
  assert.equal(w('a{b,c'), 'a{b,c');
  assert.equal(w('a}b,c}'), 'a}b,c}');
  assert.equal(w('{a,b}-{c,d}'), '*-*');
});

test('brace: 과도한 중첩·판정 오류는 fail-closed, 원문 비노출', () => {
  const deep = `cat ${'{'.repeat(33)}${MARKER},x${'}'.repeat(33)}`;
  const msg = denied(bash(deep)) || '';
  assert.match(msg, /HOOK_BRACE_UNDECIDABLE/);
  assert.ok(!msg.includes(MARKER));
  const r = hookCli(JSON.stringify(bash(deep)));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HOOK_BRACE_UNDECIDABLE/);
  assert.ok(!r.stderr.includes(MARKER));
  assert.ok(allowed(bash(`cat docs/${'{'.repeat(32)}a,b${'}'.repeat(32)}.md`)));
  for (const widen of [() => { throw new TypeError(MARKER); }, () => 42]) {
    try {
      guard.shellViolation('cat docs/a.md', REPO, { widen });
      assert.fail('차단되어야 함');
    } catch (e) {
      assert.ok(e instanceof Deny, String(e));
      assert.match(e.message, /HOOK_BRACE_INVALID/);
      assert.ok(!e.message.includes(MARKER));
    }
  }
});

test('brace: 전개하지 않고 선형으로 판정 (그룹 5천 개)', () => {
  const token = '{a,b}'.repeat(5000);
  const started = Date.now();
  assert.equal(guard.widenBraces(token), '*'.repeat(5000));
  assert.ok(allowed(bash(`cat docs/${token}.md`)));
  assert.ok(Date.now() - started < 5000);
});

test('회귀: 기존 허용·차단 규칙 대표 사례 유지', () => {
  for (const c of ['git status', 'npm test', 'ls config', 'cat config/identifiers.schema.json', 'rm -rf node_modules/.cache', `node scripts/judge.mjs ${RUN}`]) assert.ok(allowed(bash(c)), c);
  assert.match(denied(bash('git push origin main')) || '', /git push/);
  assert.match(denied(bash('echo x > runs/a/run.json')) || '', /보호 경로/);
  assert.match(denied(bash(`node scripts/run-stage.mjs 2 ${RUN}`)) || '', /역할 전용 스크립트/);
  assert.match(denied(tool('Write', { file_path: path.join(path.dirname(REPO), 'outside-x.md'), content: 'x' })) || '', /저장소 밖/);
  assert.match(denied(tool('Write', { file_path: 'runs/a/run.json', content: 'x' })) || '', /직접 쓰기 금지/);
  assert.match(denied(bash('cat config/*')) || '', /local 설정/);
  assert.ok(allowed(bash(`node scripts/run-stage.mjs 2 ${RUN}`, 'harness-runner')));
});

// ---------- 보호 경로 glob·brace·변수 판정 (fix: block protected path glob and brace bypass) ----------

const REPO_FWD = REPO.replace(/\\/g, '/');
const PROTECTED_BYPASS = [
  'rm -rf {runs,x}', 'rm -rf ru*', 'rm -rf r?ns', 'rm -rf r[au]ns', 'echo x > {runs,x}/a.json',
  'rm -rf {releases,x}', 'rm -rf rel*', 'mv a rele?ses/b', 'rm -rf .g?t', 'rm -rf {.git,x}/config', 'echo x > .gi[t]/config', 'cp a .GIT*/hooks/x',
  'del ru*\\x.json', 'rm -rf RUNS\\a', 'echo x > "RUNS\\a.json"', 'rm -rf "runs."', 'rm -rf "runs "', 'rm -rf RELEAS~1', 'rm -rf GIT~1',
  'rm -rf *', 'rm -rf **/x', 'rm -rf x/**', `rm -rf "${REPO}\\ru*"`, `rm -rf "${REPO_FWD}/{runs,x}"`, 'rm -rf "C:/Users/*/x"',
  'cd runs && rm -rf sub', 'cd r*s; echo x > a.json', 'pushd .g?t && rm -f x', '(rm -rf runs)',
  `rm -rf "/${REPO_FWD[0].toLowerCase()}${REPO_FWD.slice(2)}/runs"`, `echo x > "/cygdrive/${REPO_FWD[0].toLowerCase()}${REPO_FWD.slice(2)}/ru*/a"`,
];

test('보호 경로: glob·brace·구분자·대소문자·8.3 이름·cd 우회 차단 (Bash·PowerShell)', () => {
  const leaked = PROTECTED_BYPASS.filter((c) => !/보호 경로/.test(denied(bash(c)) || ''));
  const psOnly = ['Remove-Item -Recurse R?NS', 'Set-Location .g?t; Remove-Item x', 'Copy-Item a -Destination rel*/b'];
  const leakedPs = [...PROTECTED_BYPASS, ...psOnly].filter((c) => !/보호 경로/.test(denied(tool('PowerShell', { command: c })) || ''));
  assert.deepEqual({ leaked, leakedPs }, { leaked: [], leakedPs: [] });
});

test('보호 경로: 실행 시 값이 정해지는 쓰기 대상은 판정 불가로 차단, 변수명·경로 비노출', () => {
  const v = ['LEAK', 'VAR', '7Q'].join('');
  const cmds = [`rm -rf $${v}`, `rm -rf "\${${v}}/x"`, `echo x > "$${v}/run.json"`, `rm -rf $(pwd)/${v}`, `rm -rf \`echo ${v}\``,
    `del %${v}%\\x`, `Remove-Item $env:${v}`, `cp a "$${v}"`, `cd $${v} && rm -f a`, `rm -rf ~${v}/x`];
  const results = cmds.map((c) => denied(bash(c)) || 'ALLOW');
  assert.deepEqual(cmds.filter((c, i) => !/HOOK_WRITE_TARGET_UNDECIDABLE/.test(results[i])), []);
  assert.ok(results.every((m) => !m.includes(v)));
  const r = hookCli(JSON.stringify(bash(`rm -rf "$${v}/${MARKER}"`)));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HOOK_WRITE_TARGET_UNDECIDABLE/);
  assert.ok(!r.stderr.includes(v) && !r.stderr.includes(MARKER));
});

test('보호 경로: ~는 홈 폴더로 풀어 저장소 안 보호 경로이면 차단, 밖이면 허용', () => {
  assert.ok(allowed(bash('rm -rf ~/tmp-x')));
  const rel = path.relative(os.homedir(), REPO);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    assert.match(denied(bash(`rm -rf "~/${rel.replace(/\\/g, '/')}/runs"`)) || '', /보호 경로/);
    assert.match(denied(bash(`rm -rf "~/${rel.replace(/\\/g, '/')}/ru*"`)) || '', /보호 경로/);
  }
});

test('보호 경로: 보호 대상이 아닌 경로와 저장소 밖 절대경로 glob은 허용', () => {
  const cmds = ['rm -rf node_modules/.cache', 'cp README.md docs/README.md', 'cat runs/a/run.json', 'rm -rf "D:/tmp/*"', 'rm -f *.tmp', 'rm -rf build*',
    'echo x > docs/a.md', 'ls 2>/dev/null', 'cd docs && rm -f a.tmp', 'cd runs && cat a', 'cd runs && ls 2>/dev/null', 'mv docs/a.md docs/b.md'];
  for (const c of cmds) assert.ok(allowed(bash(c)), c);
});

test('보호 경로: 새로 차단되는 정상 명령 (승인된 보수적 판정)', () => {
  const cmds = ['rm -rf node_modules/*', 'rm -rf dist/*', "sed -i 's/a$/b/' docs/x.md", 'echo x > "$TMPDIR/x.txt"'];
  assert.deepEqual(cmds.filter((c) => !denied(bash(c))), []);
});

test('보호 경로: 판정 오류와 과도한 brace는 fail-closed, 원문 비노출', () => {
  for (const widen of [() => { throw new TypeError(MARKER); }, () => 42]) {
    try {
      guard.writeTargetViolation(`runs/${MARKER}`, REPO, { widen });
      assert.fail('차단되어야 함');
    } catch (e) {
      assert.ok(e instanceof Deny, String(e));
      assert.match(e.message, /HOOK_PROTECTED_INVALID/);
      assert.ok(!e.message.includes(MARKER));
    }
  }
  const deep = `rm -rf ${'{'.repeat(33)}runs,${MARKER}${'}'.repeat(33)}`;
  const msg = denied(bash(deep)) || '';
  assert.match(msg, /HOOK_BRACE_UNDECIDABLE/);
  assert.ok(!msg.includes(MARKER));
});

// ---------- 보호 경로 상위 삭제·이동 (fix: block protected path ancestor deletion) ----------

const REPO_PARENT_FWD = path.dirname(REPO).replace(/\\/g, '/');
const DRIVE = REPO_FWD[0].toLowerCase();
const gitBashPath = (p) => `/${p[0].toLowerCase()}${p.slice(2)}`;
const HOME_HAS_REPO = !path.relative(os.homedir(), REPO).startsWith('..');
const ANCESTOR_BYPASS = [
  'rm -rf .', 'rm -rf ..', 'rm -rf ./', 'rm -rf .../', 'rm -rf docs/..', 'rm -- .', 'rmdir /s /q .', 'del /s /q ..\\',
  `rm -rf "${REPO}"`, `rm -rf "${REPO_FWD}"`, `rm -rf "${REPO_FWD.toUpperCase()}"`, `rm -rf "${REPO_FWD}."`, `rm -rf "${REPO_FWD}/"`,
  `rm -rf "${REPO_PARENT_FWD}"`, `rm -rf "${REPO_FWD[0]}:\\"`, `rm -rf "${gitBashPath(REPO_FWD)}"`, `rm -rf /${DRIVE}`,
  `rm -rf "/cygdrive/${DRIVE}${REPO_PARENT_FWD.slice(2)}"`, ...(HOME_HAS_REPO ? ['rm -rf ~'] : []),
  'cd docs && rm -rf ..', 'cd runs && rm -rf ..', '(cd /tmp/a); rm -rf ..', 'cd && rm -rf ..',
  // 저장소 폴더 이름의 앞부분으로 만든 glob (폴더 이름을 하드코딩하지 않는다)
  'mv . ../backup', 'ren . x', 'rm -rf ../*', `rm -rf ../${path.basename(REPO).slice(0, 3)}*`,
];
const ANCESTOR_BYPASS_PS = ['Remove-Item . -Recurse', 'Remove-Item -Path:.. -Recurse', `Move-Item "${REPO}" D:/x`, 'Move-Item -Path . -Destination D:/x',
  'Rename-Item . x', 'Set-Location -Path:runs; Remove-Item x'];

test('상위 경로: 저장소 루트·상위·보호 폴더 상위를 지우거나 옮기는 명령 차단 (cwd·cd·표기 정규화)', () => {
  const blocked = (m) => /보호 경로|HOOK_WRITE_TARGET_UNDECIDABLE/.test(m || '');
  const leaked = ANCESTOR_BYPASS.filter((c) => !blocked(denied(bash(c))));
  const leakedPs = [...ANCESTOR_BYPASS, ...ANCESTOR_BYPASS_PS].filter((c) => !blocked(denied(tool('PowerShell', { command: c }))));
  assert.deepEqual({ leaked, leakedPs }, { leaked: [], leakedPs: [] });
});

test('상위 경로: 작업 위치를 알 수 없거나 판정할 수 없는 source는 fail-closed', () => {
  const noCwd = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -f a.tmp' } };
  const results = [
    denied(bash('cd node_mod* && rm -f a.tmp')), denied(bash('popd && rm -f a.tmp')), denied(bash('cd - && rm -f a.tmp')), denied(noCwd),
    denied(bash('rm -rf ../**/x.bak')), denied(bash('rm -rf docs/*.bak/../..')),
  ];
  assert.deepEqual(results.map((m) => /HOOK_WRITE_TARGET_UNDECIDABLE|보호 경로/.test(m || '')), results.map(() => true));
  assert.match(results[3] || '', /HOOK_WRITE_TARGET_UNDECIDABLE/);
});

test('상위 경로: 보호 폴더를 담지 않는 대상, 목적지만 상위, 읽기·생성은 허용', () => {
  const cmds = ['rm -rf ../*.bak', 'rm -rf /tmp/*', 'rm -f ../other/x.tmp', 'mv a ..', 'rm -rf docs', 'rm -rf node_modules/.cache', 'rm -f a.tmp',
    'cat ..', 'ls ..', 'cp -r . ../backup', 'echo x > a.txt', 'cd docs && rm -f a.tmp', 'mv docs/a.md docs/b.md', 'rm -rf ~/tmp-x'];
  assert.deepEqual(cmds.filter((c) => !allowed(bash(c))), []);
  assert.ok(allowed(tool('PowerShell', { command: 'Move-Item a -Destination ..' })));
});

test('상위 경로: 가능한 작업 위치 집합으로 인한 승인된 오탐', () => {
  assert.ok(denied(bash('cd docs/sub && rm -rf ..')));
});

test('상위 경로: 판정 오류는 HOOK_PROTECTED_INVALID, CLI 메시지에 경로 비노출', () => {
  for (const widen of [() => { throw new TypeError(MARKER); }, () => 42]) {
    try {
      guard.ancestorViolation(`../${MARKER}`, [REPO], REPO, { widen });
      assert.fail('차단되어야 함');
    } catch (e) {
      assert.ok(e instanceof Deny, String(e));
      assert.match(e.message, /HOOK_PROTECTED_INVALID/);
      assert.ok(!e.message.includes(MARKER));
    }
  }
  const r = hookCli(JSON.stringify(bash(`rm -rf "${REPO}"`)));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /보호 경로의 상위 경로 삭제·이동/);
  assert.ok(!r.stderr.includes(path.basename(REPO)) && !r.stderr.includes(REPO_FWD));
});
