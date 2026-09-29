// PreToolUse hook: node scripts/hook-guard.mjs [--expect-role <role>] [--scope project|agent]
// stdin의 hook 입력(JSON)을 판정한다. 허용이면 exit 0, 차단이면 exit 2 + stderr 사유.
// 입력을 해석할 수 없거나 판정 중 오류가 나면 차단한다(fail closed). hook 입력은 저장하거나 기록하지 않는다.
// 셸 명령 해석은 완전한 보안 경계가 아니다. 주 방어선은 subagent의 제한된 도구, 정확한 명령 allowlist,
// 스크립트 내부의 경로 검증이다.
import fs from 'node:fs';
import path from 'node:path';

export const ROLES = {
  'harness-runner': /^node scripts\/run-stage\.mjs [234] runs\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{8}-\d{6}-KST-[0-9a-f]{6}$/,
  'release-recorder': /^node scripts\/write-release\.mjs runs\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{8}-\d{6}-KST-[0-9a-f]{6}$/,
  'gate-judge': /^node scripts\/judge\.mjs runs\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{8}-\d{6}-KST-[0-9a-f]{6}$/,
};
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const SHELL_META = /[&|;<>`$()\r\n"'\\{}*?[\]!~]/;
const PROTECTED_DIRS = ['runs', 'releases', '.git'];
const WRITE_VERBS = new Set(['tee', 'cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'rename-item', 'ren', 'rni', 'truncate', 'dd', 'install', 'ln', 'mklink', 'new-symboliclink']);
const ROLE_ONLY_SCRIPTS = /(^|[\\/])(run-stage|write-release)\.mjs$/i;
const GIT_OPTS_WITH_VALUE =new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

export class Deny extends Error {}
const deny = (reason) => { throw new Deny(reason); };

// ---------- 역할 식별 ----------

export function resolveRole(input, expectRole) {
  const hasAgent = typeof input.agent_id === 'string' && input.agent_id !== '';
  let role;
  if (hasAgent) {
    if (!Object.prototype.hasOwnProperty.call(ROLES, input.agent_type)) deny(`알 수 없는 subagent (agent_type: ${String(input.agent_type || '없음')})`);
    role = input.agent_type;
  } else {
    role = 'main';
  }
  if (expectRole && role !== expectRole) deny(`역할 불일치 (예상 ${expectRole}, 실제 ${role})`);
  return role;
}

// ---------- 셸 명령 분해 ----------

function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) tokens.push(cur);
  return tokens;
}

// 명령 구분자와 서브셸·백틱 경계로 나눈 뒤, 따옴표 안의 문자열도 다시 명령으로 본다.
export function segments(command, depth = 0) {
  const parts = String(command).split(/&&|\|\||[;&|\n\r`]|\$\(|\)/);
  const out = [];
  for (const p of parts) {
    const toks = tokenize(p);
    if (toks.length) out.push(toks);
    if (depth < 2) for (const t of toks) if (/\s/.test(t)) out.push(...segments(t, depth + 1));
  }
  return out;
}

const baseName = (t) => t.replace(/^.*[\\/]/, '').toLowerCase();

export function gitViolation(tokens) {
  const gi = tokens.findIndex((t) => /^git(\.exe)?$/.test(baseName(t)));
  if (gi < 0) return null;
  let i = gi + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i].split('=')[0];
    i += GIT_OPTS_WITH_VALUE.has(opt) && !tokens[i].includes('=') ? 2 : 1;
  }
  const sub = (tokens[i] || '').toLowerCase();
  const args = tokens.slice(i + 1);
  const shortHas = (letter) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.slice(1).includes(letter));
  const longHas = (name) => args.some((a) => a.toLowerCase() === name || a.toLowerCase().startsWith(`${name}=`));
  if (sub === 'push') return 'git push';
  if (sub === 'reset' && longHas('--hard')) return 'git reset --hard';
  if (sub === 'checkout' && (shortHas('f') || longHas('--force'))) return 'git checkout --force';
  if (sub === 'switch' && (longHas('--discard-changes') || longHas('--force') || shortHas('f'))) return 'git switch --discard-changes/--force';
  if (sub === 'branch' && (shortHas('D') || (longHas('--delete') && (longHas('--force') || shortHas('f'))))) return 'git branch -D';
  if (sub === 'clean' && (shortHas('f') || longHas('--force'))) return 'git clean -f';
  if (longHas('--force') || longHas('--force-with-lease')) return `git ${sub} --force`;
  return null;
}

function refersToProtected(token, projectDir) {
  const t = token.replace(/^[<>]+/, '').replace(/^-[A-Za-z]+:/, '');
  if (!t) return false;
  const norm = t.replace(/\\/g, '/');
  if (/(^|\/)(runs|releases|\.git)(\/|$)/i.test(norm) && !path.isAbsolute(t)) return true;
  if (path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) {
    const rel = path.relative(projectDir, path.resolve(t));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return PROTECTED_DIRS.includes(rel.split(/[\\/]/)[0].toLowerCase());
  }
  return false;
}

export function shellViolation(command, projectDir) {
  const redirectTargets = [...String(command).matchAll(/(?:\d?>>?|>\|)\s*("([^"]*)"|'([^']*)'|[^\s;&|]+)/g)].map((m) => m[2] ?? m[3] ?? m[1]);
  if (redirectTargets.some((t) => refersToProtected(t, projectDir))) return '보호 경로로의 redirect';
  for (const toks of segments(command)) {
    const git = gitViolation(toks);
    if (git) return git;
    // runner·recorder 전용 스크립트는 메인 세션이 직접 실행하지 않는다 (역할 경계).
    const roleScript = toks.find((t) => ROLE_ONLY_SCRIPTS.test(t));
    if (roleScript) return `역할 전용 스크립트 직접 실행(${baseName(roleScript)})`;
    const verbAt = toks.findIndex((t) => WRITE_VERBS.has(baseName(t).replace(/\.exe$/, '')) || (baseName(t) === 'sed' && toks.includes('-i')));
    if (verbAt >= 0 && toks.slice(verbAt + 1).some((t) => refersToProtected(t, projectDir))) return `보호 경로를 대상으로 한 ${toks[verbAt]}`;
  }
  return null;
}

// ---------- 파일 경로 ----------

export function writePathViolation(filePath, projectDir) {
  if (typeof filePath !== 'string' || filePath === '') return '쓰기 경로 없음';
  const root = fs.realpathSync.native(projectDir);
  const abs = path.resolve(projectDir, filePath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    const rel2 = path.relative(projectDir, abs);
    if (rel2 === '' || rel2.startsWith('..') || path.isAbsolute(rel2)) return '저장소 밖 경로';
  }
  const parts = path.relative(projectDir, abs).split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === '.git')) return '.git/ 쓰기 금지';
  if (PROTECTED_DIRS.includes((parts[0] || '').toLowerCase())) return `${parts[0]}/ 직접 쓰기 금지 (승인된 스크립트만 사용)`;
  let cur = projectDir;
  for (const p of parts) {
    cur = path.join(cur, p);
    let st;
    try { st = fs.lstatSync(cur); } catch { break; }
    if (st.isSymbolicLink()) return 'symlink·junction 경로';
  }
  const real = fs.existsSync(abs) ? fs.realpathSync.native(abs) : null;
  if (real) {
    const r = path.relative(root, real);
    if (r.startsWith('..') || path.isAbsolute(r)) return '실제 경로가 저장소 밖';
  }
  return null;
}

// ---------- 판정 ----------

export function decide(input, { expectRole = null, projectDir }) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') deny('hook 입력을 해석할 수 없음');
  if (!projectDir) deny('프로젝트 경로를 알 수 없음');
  const role = resolveRole(input, expectRole);
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (role !== 'main') {
    if (WRITE_TOOLS.includes(tool)) deny(`${role}: 파일 쓰기 도구 금지`);
    if (tool === 'PowerShell') deny(`${role}: PowerShell 금지`);
    if (tool === 'Bash') {
      const cmd = typeof ti.command === 'string' ? ti.command : '';
      if (SHELL_META.test(cmd) || cmd !== cmd.trim()) deny(`${role}: 셸 결합·확장 문자 금지`);
      if (!ROLES[role].test(cmd)) deny(`${role}: 허용 명령과 정확히 일치하지 않음`);
    }
    return { allow: true, role };
  }

  if (SHELL_TOOLS.includes(tool)) {
    const v = shellViolation(typeof ti.command === 'string' ? ti.command : '', projectDir);
    if (v) deny(`main: ${v} 차단`);
  }
  if (WRITE_TOOLS.includes(tool)) {
    const v = writePathViolation(ti.file_path || ti.notebook_path, projectDir);
    if (v) deny(`main: ${v}`);
  }
  return { allow: true, role };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function main() {
  const scope = argValue('--scope') || 'project';
  try {
    let input;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      deny('hook 입력 JSON 오류');
    }
    decide(input, { expectRole: argValue('--expect-role'), projectDir: process.env.CLAUDE_PROJECT_DIR || input.cwd });
    process.exitCode = 0;
  } catch (e) {
    const reason = e instanceof Deny ? e.message : '판정 중 오류';
    process.stderr.write(`[hook-guard:${scope}] 차단: ${reason}\n`);
    process.exitCode = 2;
  }
}

// 스크립트로 실행되면 항상 판정한다 (경로 표기 차이로 판정을 건너뛰어 fail-open이 되지 않도록 파일 이름으로 확인).
if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === 'hook-guard.mjs') main();
