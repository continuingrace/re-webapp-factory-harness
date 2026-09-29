import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO } from './helpers.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { normalizedHash } from '../../scripts/lib/hash.mjs';

const policy = loadChecks(REPO).data.policies.source_document_hashing;
const h = (s) => normalizedHash(Buffer.from(s, 'utf8'), policy);

test('LF, CRLF, CR, BOM이 달라도 같은 문서는 해시가 같다', () => {
  const lf = h('# 제목\n본문\n');
  assert.equal(h('# 제목\r\n본문\r\n'), lf);
  assert.equal(h('# 제목\r본문\r'), lf);
  assert.equal(h('﻿# 제목\r\n본문\r\n'), lf);
});

test('내용이 다르면 해시가 다르다', () => {
  assert.notEqual(h('a\n'), h('b\n'));
});

test('지원하지 않는 인코딩 정책은 거부한다', () => {
  assert.throws(() => normalizedHash(Buffer.from('a'), { ...policy, decode: 'latin1' }), { code: 'UNSUPPORTED_HASH_POLICY' });
});
