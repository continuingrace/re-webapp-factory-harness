// source document 정규화 해시. 규칙은 checks.json policies.source_document_hashing에서 읽는다.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { codeError } from './checks.mjs';

export function normalizedHash(buf, policy) {
  if (policy.decode !== 'utf-8' || policy.encode !== 'utf-8') throw codeError('UNSUPPORTED_HASH_POLICY');
  let text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
  if (policy.strip_bom && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const froms = [...policy.newline.from].sort((a, b) => b.length - a.length);
  for (const from of froms) text = text.split(from).join(policy.newline.to);
  return createHash(policy.algorithm).update(Buffer.from(text, 'utf8')).digest('hex');
}

export function normalizedFileHash(file, policy) {
  return normalizedHash(fs.readFileSync(file), policy);
}
