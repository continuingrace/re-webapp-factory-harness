// 오케스트레이터 helper 공용 도구. 사용자 원문은 파일에서 읽으며 셸 명령 문자열에 넣지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const JUDGE_RUN_STATUS = ['IN_PROGRESS', 'AWAITING_APPROVAL', 'AWAITING_DEPLOYMENT', 'BLOCKED'];

export function out(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exitCode = code;
}

export function fail(code) {
  const e = new Error(code);
  e.code = code;
  throw e;
}

// --statement-file <path>: 사용자 메시지 원문을 바이트 그대로(BOM만 제거) 읽는다.
export function readStatement(argv) {
  const i = argv.indexOf('--statement-file');
  if (i < 0 || !argv[i + 1]) fail('STATEMENT_FILE_REQUIRED');
  let text = fs.readFileSync(argv[i + 1], 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') fail('EMPTY_STATEMENT');
  return text;
}

export function kstRunId() {
  const kst = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString();
  const stamp = `${kst.slice(0, 10).replace(/-/g, '')}-${kst.slice(11, 19).replace(/:/g, '')}`;
  return `${stamp}-KST-${crypto.randomBytes(3).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}
