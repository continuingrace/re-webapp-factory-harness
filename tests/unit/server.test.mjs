import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { makeApp, withTemp, writeFiles } from './helpers.mjs';
import { startStaticServer } from '../../scripts/lib/local-server.mjs';
import { loadChecks } from '../../scripts/lib/checks.mjs';
import { REPO } from './helpers.mjs';

const POLICY = loadChecks(REPO).data.policies.fingerprint;

function request(port, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

test('127.0.0.1에만 바인딩하고, GET·HEAD만 허용한다', () => withTemp(async (t) => {
  const srv = await startStaticServer(makeApp(t), POLICY);
  try {
    assert.equal(srv.address, '127.0.0.1');
    const get = await request(srv.port, 'GET', '/');
    assert.equal(get.status, 200);
    assert.ok(get.body.includes('<h1>'));
    const head = await request(srv.port, 'HEAD', '/index.html');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request(srv.port, 'POST', '/')).status, 405);
  } finally {
    await srv.close();
  }
}));

test('경로 이탈, null byte, 디렉터리 목록 요청을 거부한다', () => withTemp(async (t) => {
  writeFiles(t, { 'secret.txt': 'outside' });
  const srv = await startStaticServer(makeApp(t), POLICY);
  try {
    for (const p of ['/%2e%2e/secret.txt', '/src/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt', '/a%00b', '/C:%5cWindows']) {
      assert.equal((await request(srv.port, 'GET', p)).status, 400, p);
    }
    assert.equal((await request(srv.port, 'GET', '/src/')).status, 403);
    assert.equal((await request(srv.port, 'GET', '/src')).status, 403);
    assert.equal((await request(srv.port, 'GET', '/missing.txt')).status, 404);
  } finally {
    await srv.close();
  }
}));

test('app 안의 junction·symlink는 따라가지 않는다', (tc) => withTemp(async (t) => {
  const app = makeApp(t);
  writeFiles(t, { 'outside/data.txt': 'outside' });
  try {
    fs.symlinkSync(path.join(t, 'outside'), path.join(app, 'linked'), 'junction');
  } catch {
    tc.skip('이 환경에서 junction을 만들 수 없음');
    return;
  }
  const srv = await startStaticServer(app, POLICY);
  try {
    assert.equal((await request(srv.port, 'GET', '/linked/data.txt')).status, 403);
  } finally {
    await srv.close();
  }
}));

test('종료 후 포트가 닫힌다', () => withTemp(async (t) => {
  const srv = await startStaticServer(makeApp(t), POLICY);
  const { port } = srv;
  assert.equal(await canConnect(port), true);
  await srv.close();
  assert.equal(await canConnect(port), false);
}));
