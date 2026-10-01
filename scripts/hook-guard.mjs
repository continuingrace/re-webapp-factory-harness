// PreToolUse hook: node scripts/hook-guard.mjs [--expect-role <role>] [--scope project|agent]
// stdin의 hook 입력(JSON)을 판정한다. 허용이면 exit 0, 차단이면 exit 2 + stderr 사유.
// 입력을 해석할 수 없거나 판정 중 오류가 나면 차단한다(fail closed). hook 입력은 저장하거나 기록하지 않는다.
// 셸 명령 해석은 완전한 보안 경계가 아니다. 주 방어선은 subagent의 제한된 도구, 정확한 명령 allowlist,
// 스크립트 내부의 경로 검증이다.
import fs from 'node:fs';
import os from 'node:os';
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
// 비공개 local 설정(config/*.local.json). 내용을 읽지 않는 Git 상태 확인만 경로를 명령줄에 쓸 수 있다.
// 하네스 스크립트가 내부에서 로더로 읽는 것은 명령줄에 경로가 없으므로 막지 않는다.
const LOCAL_CONFIG_NAME = /\.local\.json$/i;
const LOCAL_CONFIG_KNOWN = ['identifiers.local.json', 'public-scan.local.json'];
const LOCAL_CANDIDATE = /[^\s"'`=(),;<>|&]*\.local\.json/gi;
const GLOB_CHARS = /[*?[]/;
const GIT_STATUS_ONLY = new Set(['status', 'check-ignore', 'ls-files']);
const RECURSIVE_READERS = new Set(['grep', 'egrep', 'fgrep', 'rgrep', 'findstr', 'select-string', 'sls', 'ag', 'ack']);
const RECURSIVE_FLAG = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|-recurse|\/s)$/i;
const LOCAL_DENY = 'local 설정 파일(config/*.local.json) 직접 접근';
// 판정 불가·내부 오류는 코드만 알리고 명령 원문이나 패턴 내용은 출력하지 않는다.
const GLOB_INVALID = '판정할 수 없는 glob 패턴 (HOOK_GLOB_INVALID)';
const BRACE_MAX_DEPTH = 32;
const BRACE_UNDECIDABLE = '판정할 수 없는 brace 패턴 (HOOK_BRACE_UNDECIDABLE)';
const BRACE_INVALID = 'brace 판정 오류 (HOOK_BRACE_INVALID)';
const PROTECTED_INVALID = '보호 경로 판정 오류 (HOOK_PROTECTED_INVALID)';
const WRITE_TARGET_UNDECIDABLE = '실행 시 정해지는 쓰기 대상 (HOOK_WRITE_TARGET_UNDECIDABLE)';
// 실행 시 값이 정해지는 구성요소: $X, ${X}, $(…), $env:X, 백틱, %X%
const DYNAMIC_PART = /[$`]|%[^%]+%/;
const SHORT_NAME = /~\d+(\.[^.]*)?$/;
const CD_VERBS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
const DELETE_VERBS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri']);
const MOVE_VERBS = new Set(['mv', 'move', 'move-item', 'mi', 'rename-item', 'ren', 'rni']);
const CMD_VERBS = new Set(['del', 'erase', 'rd', 'rmdir', 'move', 'ren']);
const DEST_PARAMS = new Set(['-destination', '-newname', '-t', '--target-directory']);
const PATH_PARAMS = new Set(['-path', '-literalpath', '-lp', '-pspath']);
const VALUE_PARAMS = new Set(['-filter', '-include', '-exclude', '-credential', '-stream', '--suffix']);
const UNKNOWN_CWD = Symbol('unknown-cwd');
const CWD_SET_LIMIT = 64;
const ANCESTOR_DENY = '보호 경로의 상위 경로 삭제·이동';

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
const SEGMENT_SPLIT = /&&|\|\||[;&|\n\r`]|\$\(|\)/;
// 쓰기 대상 판정용: $(…)·백틱을 토큰에 남겨 실행 시 값이 정해지는 인자를 알아볼 수 있게 한다.
const ARG_SEGMENT_SPLIT = /&&|\|\||[;&|\n\r()]/;
export function segments(command, depth = 0, split = SEGMENT_SPLIT) {
  const parts = String(command).split(split);
  const out = [];
  for (const p of parts) {
    const toks = tokenize(p);
    if (toks.length) out.push(toks);
    if (depth < 2) for (const t of toks) if (/\s/.test(t)) out.push(...segments(t, depth + 1, split));
  }
  return out;
}

const baseName = (t) => t.replace(/^.*[\\/]/, '').toLowerCase();

// git 하위 명령 위치. git 명령이 아니면 null.
function gitSubcommand(tokens) {
  const gi = tokens.findIndex((t) => /^git(\.exe)?$/.test(baseName(t)));
  if (gi < 0) return null;
  let i = gi + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i].split('=')[0];
    i += GIT_OPTS_WITH_VALUE.has(opt) && !tokens[i].includes('=') ? 2 : 1;
  }
  return { i, sub: (tokens[i] || '').toLowerCase() };
}

export function gitViolation(tokens) {
  const g = gitSubcommand(tokens);
  if (!g) return null;
  const { i, sub } = g;
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

// ---------- 보호 경로 (runs/, releases/, .git) ----------

// 경로 구성요소 하나가 보호 폴더 이름과 일치할 수 있는지 본다. 셸 확장·파일 열거 없이 넓게 판정한다.
function mayBeProtectedName(comp) {
  const c = comp.replace(/:.*$/, '').replace(/[. ]+$/, ''); // 대체 데이터 스트림, Windows 말미 점·공백
  if (c === '') return false;
  if (SHORT_NAME.test(c)) return true; // 8.3 짧은 이름은 실제 이름을 알 수 없다
  return globMatches(c, PROTECTED_DIRS);
}

// 구분자를 '/'로 바꾸고 맨 앞 '~'(hook 프로세스의 홈)와 Git Bash·Cygwin 드라이브 표기를 푼다.
// 다른 사용자의 홈(~name)은 알 수 없으므로 null.
function nativePath(token) {
  let t = token.replace(/\\/g, '/');
  if (t.startsWith('~')) {
    const [, user, rest] = /^~([^/]*)(.*)$/s.exec(t);
    if (user !== '') return null;
    t = os.homedir().replace(/\\/g, '/') + rest;
  }
  t = t.replace(/^\/cygdrive\/([A-Za-z])(?=\/|$)/i, '$1:').replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
  return /^[A-Za-z]:$/.test(t) ? `${t}/` : t;
}

function classifyWriteTarget(token, projectDir, widen) {
  let t = token.replace(/^[<>]+/, '').replace(/^-[A-Za-z]+:/, '');
  if (!t) return null;
  if (DYNAMIC_PART.test(t)) return 'undecidable';
  t = nativePath(t);
  if (t === null) return 'undecidable';
  const w = widen(t);
  if (typeof w !== 'string') deny(PROTECTED_INVALID);
  const comps = w.split('/');
  if (!/^[A-Za-z]:/.test(w) && !w.startsWith('/')) {
    // 상대경로: cd로 현재 폴더가 바뀌었을 수 있으므로 깊이와 관계없이 본다.
    return comps.some(mayBeProtectedName) ? 'protected' : null;
  }
  const root = path.resolve(projectDir).toLowerCase();
  const k = comps.findIndex((c, i) => i > 0 && (GLOB_CHARS.test(c) || SHORT_NAME.test(c)));
  if (k < 0) {
    const rel = path.relative(root, path.resolve(w).toLowerCase());
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(/[\\/]/).some(mayBeProtectedName) ? 'protected' : null;
  }
  // glob·8.3 이름 앞의 리터럴 부분이 저장소 안이거나 저장소의 상위일 때만 나머지 구성요소를 본다.
  let head = comps.slice(0, k).join('/') || '/';
  if (/^[A-Za-z]:$/.test(head)) head += '/';
  const prefix = path.resolve(head).toLowerCase();
  const withSep = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
  const related = root === prefix || root.startsWith(withSep) || prefix.startsWith(`${root}${path.sep}`);
  return related && comps.slice(k).some(mayBeProtectedName) ? 'protected' : null;
}

// 쓰기·삭제·이동·redirect 대상 토큰 하나를 판정한다.
// 반환: null(허용) | 'protected'(보호 경로일 수 있음) | 'undecidable'(실행 시 값이 정해지는 구성요소)
// 판정 중 오류는 명시적 코드로 차단하며 토큰 내용은 출력하지 않는다.
export function writeTargetViolation(token, projectDir, { widen = widenBraces } = {}) {
  try {
    return classifyWriteTarget(token, projectDir, widen);
  } catch (e) {
    if (e instanceof Deny) throw e;
    return deny(PROTECTED_INVALID);
  }
}

const writeVerbAt = (toks) => toks.findIndex((t) => WRITE_VERBS.has(baseName(t).replace(/\.exe$/, '')) || (baseName(t) === 'sed' && toks.includes('-i')));
const isAbsoluteLike = (t) => /^[A-Za-z]:/.test(t) || /^[\\/]/.test(t) || t.startsWith('~');

// ---------- 보호 경로의 상위 삭제·이동 ----------

// cd 계열 명령의 이동 대상. PowerShell -Path:x 형태도 포함하고, 이전 위치로 돌아가는 '-'는 그대로 둔다.
function cdTargets(toks) {
  const out = [];
  for (const t of toks.slice(1)) {
    const m = /^-(?:path|literalpath|lp|pspath):(.*)$/is.exec(t);
    if (m) out.push(m[1]);
    else if (t === '-' || !t.startsWith('-')) out.push(t);
  }
  return out;
}

// 삭제·이동 동사의 source 인자. 옵션과 그 값, 이동 목적지는 제외한다.
function sourceArgs(toks, verbAt) {
  const verb = baseName(toks[verbAt]).replace(/\.exe$/, '');
  const move = MOVE_VERBS.has(verb);
  const cmdStyle = CMD_VERBS.has(verb);
  const args = toks.slice(verbAt + 1);
  const explicit = [];
  const positional = [];
  let dest = null;
  let optionsDone = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!optionsDone && a === '--') { optionsDone = true; continue; }
    if (!optionsDone && cmdStyle && /^\/[-A-Za-z?]+$/.test(a)) continue; // cmd 옵션(/s /q)
    const m = !optionsDone && /^(-{1,2}[A-Za-z][A-Za-z-]*)(?:[:=](.*))?$/s.exec(a);
    if (m) {
      const name = m[1].toLowerCase();
      const value = () => (m[2] !== undefined ? m[2] : args[++i]);
      if (move && DEST_PARAMS.has(name)) dest = value();
      else if (PATH_PARAMS.has(name)) explicit.push(value());
      else if (VALUE_PARAMS.has(name)) value();
      continue;
    }
    if (!optionsDone && a.startsWith('-') && a.length > 1) continue;
    positional.push(a);
  }
  const sources = move && dest === null ? positional.slice(0, -1) : positional;
  return [...explicit, ...sources].filter((s) => typeof s === 'string' && s !== '');
}

const lowerKey = (p) => p.toLowerCase();
const isAncestorOrSame = (a, b) => {
  const A = lowerKey(a);
  const B = lowerKey(b);
  return A === B || B.startsWith(A.endsWith(path.sep) ? A : `${A}${path.sep}`);
};

// 경로를 머리(드라이브·루트)와 구성요소로 나누고 Windows 규칙과 점 구성요소를 정규화한다.
// 드라이브 상대경로(C:foo)는 드라이브별 작업 위치를 알 수 없으므로 null.
function pathParts(p) {
  const raw = p.split('/');
  let head = null;
  if (/^[A-Za-z]:/.test(p)) {
    if (raw[0].length > 2) return null;
    head = `${raw[0]}/`;
    raw.shift();
  } else if (p.startsWith('/')) {
    head = '/';
    raw.shift();
  }
  const comps = raw.map((c) => {
    const s = c.replace(/ +$/, '');
    if (s === '') return '.';
    if (/^\.+$/.test(s)) return s.length === 1 ? '.' : '..'; // '...' 이상은 보수적으로 상위로 본다
    return s.replace(/:.*$/, '').replace(/[. ]+$/, '') || '.';
  });
  return { head, comps };
}

// source 하나가 cwds 중 어느 위치에서든 저장소 루트나 보호 폴더와 같거나 그 상위일 수 있는지 본다.
function classifyAncestor(token, cwds, projectDir, widen) {
  if (!token) return null;
  if (DYNAMIC_PART.test(token)) return 'undecidable';
  const t = nativePath(token);
  if (t === null) return 'undecidable';
  const w = widen(t);
  if (typeof w !== 'string') deny(PROTECTED_INVALID);
  const parts = pathParts(w);
  if (parts === null) return 'undecidable';
  const root = path.resolve(projectDir);
  const guarded = [root, ...PROTECTED_DIRS.map((d) => path.join(root, d))];
  const k = parts.comps.findIndex((c) => GLOB_CHARS.test(c) || SHORT_NAME.test(c));
  const literal = k < 0 ? parts.comps : parts.comps.slice(0, k);
  const tail = k < 0 ? [] : parts.comps.slice(k).filter((c) => c !== '.');
  if (tail.some((c) => c.includes('**') || c === '..')) return 'undecidable';
  for (const base of parts.head ? [parts.head] : cwds) {
    if (base === UNKNOWN_CWD) return 'undecidable';
    const abs = path.resolve(base, ...literal);
    for (const g of guarded) {
      if (k < 0) {
        if (isAncestorOrSame(abs, g)) return 'ancestor';
        continue;
      }
      // glob은 전개하지 않고, 남은 구성요소와 순서대로 일치할 수 있는지만 본다.
      if (lowerKey(abs) === lowerKey(g) || !isAncestorOrSame(abs, g)) continue;
      const remaining = path.relative(abs, g).split(path.sep);
      if (tail.length <= remaining.length && tail.every((c, i) => SHORT_NAME.test(c) || globMatches(c, [remaining[i]]))) return 'ancestor';
    }
  }
  return null;
}

// 삭제·이동 source 하나를 판정한다. 반환: null | 'ancestor' | 'undecidable'. 오류는 HOOK_PROTECTED_INVALID.
export function ancestorViolation(token, cwds, projectDir, { widen = widenBraces } = {}) {
  try {
    return classifyAncestor(token, cwds, projectDir, widen);
  } catch (e) {
    if (e instanceof Deny) throw e;
    return deny(PROTECTED_INVALID);
  }
}

// 시작 위치와 명령 안의 cd 계열로 도달할 수 있는 모든 작업 위치. 서브셸·파이프로 되돌아가는 경우를
// 놓치지 않도록 순서대로 하나만 추적하지 않고 집합으로 모은다. 알 수 없는 위치는 UNKNOWN_CWD.
function possibleCwds(argSegs, startCwd, widen) {
  const set = new Map();
  const add = (p) => { if (set.size < CWD_SET_LIMIT) set.set(p === UNKNOWN_CWD ? p : lowerKey(p), p); else set.set(UNKNOWN_CWD, UNKNOWN_CWD); };
  add(startCwd ? path.resolve(startCwd) : UNKNOWN_CWD);
  for (const toks of argSegs) {
    const verb = baseName(toks[0] || '');
    if (verb === 'popd' || verb === 'pop-location') { add(UNKNOWN_CWD); continue; }
    if (!CD_VERBS.has(verb)) continue;
    const targets = cdTargets(toks);
    if (targets.length === 0) { add(os.homedir()); continue; }
    for (const target of targets) {
      const t = target === '-' || DYNAMIC_PART.test(target) ? null : nativePath(target);
      const w = t === null ? null : widen(t);
      const parts = typeof w === 'string' && !GLOB_CHARS.test(w) ? pathParts(w) : null;
      if (parts === null || parts.comps.some((c) => SHORT_NAME.test(c))) { add(UNKNOWN_CWD); continue; }
      for (const base of [...set.values()]) {
        if (parts.head) add(path.resolve(parts.head, ...parts.comps));
        else if (base === UNKNOWN_CWD) add(UNKNOWN_CWD);
        else add(path.resolve(base, ...parts.comps));
      }
    }
  }
  return [...set.values()];
}

// ---------- local 설정 경로 ----------

// Windows 대소문자·구분자·말미 점/공백·대체 데이터 스트림(:)을 정규화해 config/*.local.json인지 본다.
function isLocalConfigAbs(abs, projectDir) {
  const base = path.basename(abs).replace(/:.*$/, '').replace(/[. ]+$/, '');
  const dir = path.dirname(abs).replace(/[\\/]+$/, '').toLowerCase();
  return LOCAL_CONFIG_NAME.test(base) && dir === path.join(projectDir, 'config').toLowerCase();
}

// 도구의 파일 경로가 local 설정을 가리키는지 확인한다. 존재하면 실제 경로(symlink·8.3 이름 해소)도 확인한다.
export function localConfigPathViolation(filePath, projectDir) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const abs = path.resolve(projectDir, filePath.replace(/\\/g, '/'));
  if (isLocalConfigAbs(abs, projectDir)) return LOCAL_DENY;
  try {
    const real = fs.realpathSync.native(abs);
    if (isLocalConfigAbs(real, fs.realpathSync.native(projectDir)) || isLocalConfigAbs(real, projectDir)) return LOCAL_DENY;
  } catch {
    // 없는 경로는 위의 문자열 검사로 충분하다
  }
  return null;
}

// 닫힌 [...] 괄호식의 끝 위치. 닫히지 않으면 -1 (셸처럼 '['를 리터럴로 본다).
function bracketEnd(p, start) {
  let j = start + 1;
  if (p[j] === '!' || p[j] === '^') j += 1;
  if (p[j] === ']') j += 1;
  while (j < p.length) {
    if (p[j] === '[' && ':=.'.includes(p[j + 1])) {
      const close = p.indexOf(`${p[j + 1]}]`, j + 2);
      if (close < 0) return -1;
      j = close + 2;
      continue;
    }
    if (p[j] === ']') return j;
    j += 1;
  }
  return -1;
}

// 셸 glob 한 조각을 정규식으로 바꾼다. 차단 판정용이므로 실제 셸보다 넓게 일치시킨다(좁히지 않는다).
// *·** → 임의 문자열, ? → 한 글자, 닫힌 [...] → 한 글자(내용 무관). 그 밖의 문자는 모두 리터럴이다.
export function globToRegExp(pattern) {
  let src = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      while (pattern[i + 1] === '*') i += 1;
      src += '.*';
      continue;
    }
    if (ch === '?') { src += '.'; continue; }
    if (ch === '[') {
      const end = bracketEnd(pattern, i);
      if (end > 0) { src += '.'; i = end; continue; }
    }
    src += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'i');
}

// 패턴을 만들 수 없으면 명시적 코드로 차단한다(fail closed). 패턴 원문은 출력하지 않는다.
export function globMatches(pattern, names, compile = globToRegExp) {
  let re;
  try { re = compile(pattern); } catch { deny(GLOB_INVALID); }
  if (!(re instanceof RegExp)) deny(GLOB_INVALID);
  return names.some((n) => re.test(n));
}

// 셸 brace 확장 {a,b}·{x..y}를 전개하지 않고 glob 와일드카드로 넓힌다(차단 판정 전용, 셸보다 좁히지 않는다).
// 가장 바깥의 확장 가능 그룹을 '*'(내용에 '/'가 있으면 '*/*')로 바꾸고, 닫히지 않은 '{'·'}'는 리터럴로 둔다.
export function widenBraces(token) {
  const stack = [];
  const groups = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === '{') {
      stack.push(i);
      if (stack.length > BRACE_MAX_DEPTH) deny(BRACE_UNDECIDABLE);
    } else if (token[i] === '}' && stack.length) {
      const s = stack.pop();
      const body = token.slice(s + 1, i);
      if (body.includes(',') || body.includes('..')) groups.push([s, i, body.includes('/')]);
    }
  }
  groups.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e, slash] of groups) {
    if (s < pos) continue; // 이미 바깥 그룹에 포함됨
    out += token.slice(pos, s) + (slash ? '*/*' : '*');
    pos = e + 1;
  }
  return out + token.slice(pos);
}

// 셸 명령 한 조각이 local 설정을 직접 지정하는지 본다. 완전한 셸 해석이 아니며 보수적으로 막는다.
function localConfigShellViolation(toks, projectDir, widen) {
  const g = gitSubcommand(toks);
  if (g && GIT_STATUS_ONLY.has(g.sub)) return null;
  const configDir = path.join(projectDir, 'config').toLowerCase();
  for (const raw of toks) {
    let t;
    try {
      t = widen(raw.replace(/\\/g, '/'));
      if (typeof t !== 'string') deny(BRACE_INVALID);
    } catch (e) {
      if (e instanceof Deny) throw e;
      deny(BRACE_INVALID);
    }
    for (const cand of t.match(LOCAL_CANDIDATE) || []) {
      const dirPart = cand.includes('/') ? cand.slice(0, cand.lastIndexOf('/')) : '';
      // 폴더 없이 이름만 있거나 폴더 부분에 glob이 있으면 현재 폴더·확장 결과를 알 수 없으므로 막는다.
      if (!dirPart || GLOB_CHARS.test(dirPart)) return LOCAL_DENY;
      // cd 등으로 현재 폴더가 바뀌었을 수 있으므로 마지막 폴더 이름이 config이면 해석 결과와 관계없이 막는다.
      // git 객체 표기(:path, HEAD:path)와 드라이브 문자도 고려해 '/'와 ':'로 나눈다.
      if (dirPart.split(/[/:]/).pop().toLowerCase() === 'config') return LOCAL_DENY;
      if (isLocalConfigAbs(path.resolve(projectDir, cand), projectDir)) return LOCAL_DENY;
    }
    if (GLOB_CHARS.test(t)) {
      const slash = t.lastIndexOf('/');
      const dirPart = slash >= 0 ? t.slice(0, slash) : '';
      const basePart = slash >= 0 ? t.slice(slash + 1) : t;
      const inConfig = dirPart !== '' && !GLOB_CHARS.test(dirPart) && path.resolve(projectDir, dirPart).toLowerCase() === configDir;
      const dirGlob = GLOB_CHARS.test(dirPart) && globMatches(dirPart.split('/').pop(), ['config']);
      if ((inConfig || dirGlob) && globMatches(basePart, [...LOCAL_CONFIG_KNOWN, 'x.local.json'])) return LOCAL_DENY;
    }
  }
  // 재귀 검색은 .gitignore를 따르지 않으므로 config/를 포함하는 폴더(또는 현재 폴더)를 대상으로 하면 막는다.
  const verb = toks.find((t) => RECURSIVE_READERS.has(baseName(t).replace(/\.exe$/, '')));
  if (verb && toks.some((t) => RECURSIVE_FLAG.test(t))) {
    const targets = toks.filter((t) => !t.startsWith('-') && t !== verb).map((t) => path.resolve(projectDir, t.replace(/\\/g, '/')).toLowerCase());
    const kinds = targets.map((a) => { try { return [a, fs.statSync(a).isDirectory()]; } catch { return null; } }).filter(Boolean);
    const coversConfig = (a) => configDir === a || configDir.startsWith(`${a}${path.sep}`.toLowerCase());
    // 대상 경로가 하나도 없으면 현재 폴더를 재귀 검색하므로 막는다.
    if (kinds.length === 0 || kinds.some(([a, isDir]) => isDir && coversConfig(a))) return `${LOCAL_DENY} (재귀 검색)`;
  }
  return null;
}

// cwd: hook 입력의 현재 작업 위치. 없으면 알 수 없는 위치로 보고 상대경로 삭제·이동을 막는다.
export function shellViolation(command, projectDir, { widen = widenBraces, cwd = null } = {}) {
  const redirectTargets = [...String(command).matchAll(/(?:\d?>>?|>\|)\s*("([^"]*)"|'([^']*)'|[^\s;&|]+)/g)].map((m) => m[2] ?? m[3] ?? m[1]);
  for (const t of redirectTargets) {
    const v = writeTargetViolation(t, projectDir, { widen });
    if (v === 'undecidable') return WRITE_TARGET_UNDECIDABLE;
    if (v) return '보호 경로로의 redirect';
  }
  const segs = segments(command);
  // local 경로나 Git 상태 확인 결과(무시된 파일 목록 포함)를 xargs 등으로 다른 명령에 넘기는 경우는 허용하지 않는다.
  const fanOut = segs.some((toks) => toks.some((t) => /^(xargs|foreach-object|%)$/i.test(baseName(t))));
  const statusOnly = segs.some((toks) => { const g = gitSubcommand(toks); return Boolean(g && GIT_STATUS_ONLY.has(g.sub)); });
  if (fanOut && (/\.local\.json/i.test(String(command)) || statusOnly)) return LOCAL_DENY;
  for (const toks of segs) {
    const local = localConfigShellViolation(toks, projectDir, widen);
    if (local) return local;
    const git = gitViolation(toks);
    if (git) return git;
    // runner·recorder 전용 스크립트는 메인 세션이 직접 실행하지 않는다 (역할 경계).
    const roleScript = toks.find((t) => ROLE_ONLY_SCRIPTS.test(t));
    if (roleScript) return `역할 전용 스크립트 직접 실행(${baseName(roleScript)})`;
  }
  // 알려진 쓰기 동사의 인자는 보호 경로일 가능성이 있거나 실행 시 값이 정해지면 막는다.
  const argSegs = segments(command, 0, ARG_SEGMENT_SPLIT);
  let writes = redirectTargets.some((t) => !isAbsoluteLike(t));
  for (const toks of argSegs) {
    const verbAt = writeVerbAt(toks);
    if (verbAt < 0) continue;
    writes = true;
    for (const t of toks.slice(verbAt + 1)) {
      const v = writeTargetViolation(t, projectDir, { widen });
      if (v === 'undecidable') return WRITE_TARGET_UNDECIDABLE;
      if (v) return `보호 경로를 대상으로 한 ${baseName(toks[verbAt])}`;
    }
  }
  // 보호 경로(일 수 있는 곳)로 이동한 뒤의 상대경로 쓰기는 위 판정으로 알 수 없으므로 막는다.
  if (writes) {
    for (const toks of argSegs) {
      if (!CD_VERBS.has(baseName(toks[0]))) continue;
      for (const t of cdTargets(toks).filter((x) => x !== '-')) {
        const v = writeTargetViolation(t, projectDir, { widen });
        if (v === 'undecidable') return WRITE_TARGET_UNDECIDABLE;
        if (v) return '보호 경로로 이동한 뒤 쓰기';
      }
    }
  }
  // 삭제·이동의 source가 저장소 루트나 보호 폴더와 같거나 그 상위이면 막는다 (가능한 작업 위치 전체 기준).
  let cwds = null;
  for (const toks of argSegs) {
    const verbAt = writeVerbAt(toks);
    if (verbAt < 0) continue;
    const verb = baseName(toks[verbAt]).replace(/\.exe$/, '');
    if (!DELETE_VERBS.has(verb) && !MOVE_VERBS.has(verb)) continue;
    if (cwds === null) {
      try { cwds = possibleCwds(argSegs, cwd, widen); } catch (e) { if (e instanceof Deny) throw e; deny(PROTECTED_INVALID); }
    }
    for (const s of sourceArgs(toks, verbAt)) {
      const v = ancestorViolation(s, cwds, projectDir, { widen });
      if (v === 'undecidable') return WRITE_TARGET_UNDECIDABLE;
      if (v) return ANCESTOR_DENY;
    }
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

  // 모든 역할: local 설정 파일을 Read·Grep·쓰기 도구로 직접 지정할 수 없다.
  const localTarget = tool === 'Grep' ? ti.path : (ti.file_path ?? ti.notebook_path);
  const local = localConfigPathViolation(localTarget, projectDir);
  if (local) deny(`${role}: ${local} 차단`);

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
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : null;
    const v = shellViolation(typeof ti.command === 'string' ? ti.command : '', projectDir, { cwd });
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
    const reason = e instanceof Deny ? e.message : '판정 중 오류 (HOOK_INTERNAL_ERROR)';
    process.stderr.write(`[hook-guard:${scope}] 차단: ${reason}\n`);
    process.exitCode = 2;
  }
}

// 스크립트로 실행되면 항상 판정한다 (경로 표기 차이로 판정을 건너뛰어 fail-open이 되지 않도록 파일 이름으로 확인).
if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === 'hook-guard.mjs') main();
