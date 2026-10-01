// public export·scan이 쓰는 읽기 전용 git 호출. 허용한 하위 명령 밖이면 실행하지 않는다.
// 원격 저장소·네트워크·쓰기 기능은 두지 않는다. 결과 값(SHA 등)은 호출한 쪽이 출력하지 않는다.
import { execFileSync } from 'node:child_process';
import { codeError } from './checks.mjs';

export const GIT_READ_ONLY = new Set(['rev-parse', 'ls-tree', 'cat-file', 'rev-list']);

export function git(root, args, input) {
  if (!GIT_READ_ONLY.has(args[0])) throw codeError('GIT_COMMAND_NOT_ALLOWED');
  return execFileSync('git', args, {
    cwd: root, input, maxBuffer: 1 << 30, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

// private 저장소에서 도달 가능한 모든 commit SHA (git rev-list --all). 읽지 못하거나 형식이 다르면 fail-closed.
export function privateHistoryShas(root) {
  let text;
  try { text = git(root, ['rev-list', '--all']).toString('utf8'); } catch { throw codeError('PRIVATE_HISTORY_UNAVAILABLE'); }
  const shas = text.split(/\s+/).filter(Boolean);
  if (shas.length === 0 || shas.some((s) => !/^[0-9a-f]{40}$/.test(s))) throw codeError('PRIVATE_HISTORY_UNAVAILABLE');
  return shas;
}
