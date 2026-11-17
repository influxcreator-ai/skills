// Isolated tests for the media upload scripts. No real network, backend, OSS or key is used:
// every request goes through an injected transport, and global fetch is replaced with a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('real network is blocked in isolated tests'); };

const scripts = resolve(fileURLToPath(new URL('..', import.meta.url)), 'influx-ai', 'scripts');
const load = name => import(pathToFileURL(join(scripts, name)).href);
const lib = await load('_media_upload_client.mjs');
const cli = await load('_media_upload_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
const UPLOAD = '0f8fad5b-d9cb-469f-a165-70867728950e';
const tempDir = mkdtempSync(join(tmpdir(), 'media-upload-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let counter = 0;
function file(name, content = 'hello brief') {
  const dir = join(tempDir, `d${counter++}`);
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return { path, size: Buffer.byteLength(content), sha: createHash('sha256').update(content).digest('hex') };
}
const DOC = file('brief.docx', 'docx-bytes-demo');

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, credits_remaining: -1, ...extra });
const record = (over = {}) => ({ upload_id: UPLOAD, status: 'uploading', filename: 'brief.docx', file_type: 'document', public: false, content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size_bytes: DOC.size, sha256: DOC.sha, oss_key: null, oss_url: null, failure_code: null, ...over });
const done = (over = {}) => record({ status: 'succeeded', oss_key: `skill-uploads/abc/${UPLOAD}.docx`, oss_url: `https://oss.example.com/skill-uploads/abc/${UPLOAD}.docx`, ...over });
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => { calls.push({ url, init }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createMediaUploadClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
async function run(operation, args, responses, options = {}) {
  const rec = recorder(responses);
  const out = [];
  const err = [];
  const sleeps = [];
  const code = await cli.runCli(operation, { args, client: make(rec.transport), stdout: v => out.push(v), stderr: v => err.push(v), sleep: async ms => { sleeps.push(ms); }, ...options });
  const last = err.at(-1);
  return { code, out, err, calls: rec.calls, sleeps, diagnostic: last?.startsWith('{') ? JSON.parse(last) : null };
}

// ---------------------------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------------------------
test('路径与 scope 拼写严格为 media_uoload；只有 submit 与 status 两个操作', () => {
  assert.equal(lib.SCOPE, 'media_uoload');
  assert.deepEqual(Object.keys(lib.operations), ['submit', 'status']);
  assert.equal(lib.operations.submit.path, '/v1/media_uoload/submit');
  assert.equal(lib.operations.status.path, '/v1/media_uoload/status');
  assert.equal(lib.operations.submit.success, 202);
  assert.equal(lib.operations.status.success, 200);
});

test('submit：multipart 只含一个 file 和一个 file_type，文件名为本地 basename，Key 只在请求头', async () => {
  const rec = recorder(reply(202, ok(record())));
  const result = await make(rec.transport).submit(DOC.path, 'document');
  const [call] = rec.calls;
  assert.equal(rec.calls.length, 1);
  assert.equal(call.url, 'https://scout.example.com/openapi/v1/media_uoload/submit');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers['X-API-Key'], SECRET);
  assert.equal(call.init.headers['Content-Type'], undefined, 'multipart 边界由 fetch 生成');
  assert.equal(call.init.headers.Authorization, undefined);
  assert.ok(call.init.body instanceof FormData);
  assert.deepEqual([...call.init.body.keys()].sort(), ['file', 'file_type']);
  assert.equal(call.init.body.get('file_type'), 'document');
  const sent = call.init.body.get('file');
  assert.equal(sent.name, 'brief.docx');
  assert.equal(sent.size, DOC.size);
  assert.equal(Buffer.from(await sent.arrayBuffer()).toString(), 'docx-bytes-demo');
  assert.equal(call.url.includes(SECRET), false);
  assert.equal(result.data.status, 'uploading');
});

test('public：默认不发送 public 字段（服务端默认私有）；--public 时发送 public=true，回执的 public 必须与请求一致', async () => {
  const priv = recorder(reply(202, ok(record())));
  await make(priv.transport).submit(DOC.path, 'document');
  assert.equal(priv.calls[0].init.body.has('public'), false);
  const pub = recorder(reply(202, ok(record({ public: true }))));
  await make(pub.transport).submit(DOC.path, 'document', { public: true });
  assert.equal(pub.calls[0].init.body.get('public'), 'true');
  assert.deepEqual([...pub.calls[0].init.body.keys()].sort(), ['file', 'file_type', 'public']);
  await assert.rejects(make(recorder(reply(202, ok(record({ public: false })))).transport).submit(DOC.path, 'document', { public: true }), error => error.kind === 'protocol' && error.outcome === 'unknown');
  await assert.rejects(make(recorder(reply(202, ok(record({ public: true })))).transport).submit(DOC.path, 'document'), error => error.kind === 'protocol');
  await assert.rejects(make(recorder(reply(202, ok(record()))).transport).submit(DOC.path, 'document', { public: 'yes' }), error => error.kind === 'input');
});

test('public：回执缺少 public 字段或不是布尔值时视为协议错误', async () => {
  for (const value of [undefined, 'true', null]) {
    const data = done();
    if (value === undefined) delete data.public; else data.public = value;
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).status({ upload_id: UPLOAD }), error => error.kind === 'protocol', String(value));
  }
});

test('CLI --public：发送 public=true；成功提醒说明公开对象可被匿名读取', async () => {
  const result = await run('submit', ['--file', DOC.path, '--type', 'document', '--public', '--wait'], [reply(202, ok(record({ public: true }))), reply(200, ok(done({ public: true })))]);
  assert.equal(result.code, 0);
  assert.equal(result.calls[0].init.body.get('public'), 'true');
  assert.ok(result.err.at(-1).includes('匿名读取'));
  const priv = await run('status', [JSON.stringify({ upload_id: UPLOAD })], reply(200, ok(done())));
  assert.ok(priv.err.at(-1).includes('不能匿名下载'));
  const twice = await run('submit', ['--file', DOC.path, '--type', 'document', '--public', '--public'], reply(202, ok(record({ public: true }))));
  assert.equal(twice.code, 1);
  assert.equal(twice.calls.length, 0);
});

test('submit：文件以磁盘 Blob 方式发送（openAsBlob），不预先整份读入', async () => {
  const opened = [];
  const rec = recorder(reply(202, ok(record())));
  const client = make(rec.transport, { openBlob: async path => { opened.push(path); return new Blob([readFileSync(path)]); } });
  await client.submit(DOC.path, 'document');
  assert.deepEqual(opened, [DOC.path]);
});

test('status：JSON 请求体只含 upload_id', async () => {
  const rec = recorder(reply(200, ok(done())));
  await make(rec.transport).status({ upload_id: UPLOAD });
  const [call] = rec.calls;
  assert.equal(call.url, 'https://scout.example.com/openapi/v1/media_uoload/status');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), { upload_id: UPLOAD });
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['http://127.0.0.1:8010/openapi', 'http://127.0.0.1:8010/openapi'], ['https://scout.example.com/api/', 'https://scout.example.com/api/openapi']]) {
    const rec = recorder(reply(200, ok(done())));
    await lib.createMediaUploadClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).status({ upload_id: UPLOAD });
    assert.equal(rec.calls[0].url, `${expected}/v1/media_uoload/status`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: ' ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'ftp://x', apiKey: SECRET }]) {
    assert.throws(() => lib.createMediaUploadClient(options), error => error.kind === 'configuration');
  }
});

// ---------------------------------------------------------------------------------------------
// 本地文件准入
// ---------------------------------------------------------------------------------------------
test('文件准入：各分类允许的扩展名放行（大小写不敏感）', async () => {
  for (const [type, exts] of Object.entries(lib.FORMATS)) {
    for (const ext of exts) {
      const f = file(`sample.${ext.toUpperCase()}`);
      const info = await lib.inspectFile(f.path, type);
      assert.equal(info.ext, ext);
    }
  }
});

const badFiles = [
  ['分类不支持的扩展名', () => file('notes.txt'), 'image'],
  ['视频当文档', () => file('clip.mp4'), 'document'],
  ['无扩展名', () => file('README'), 'document'],
  ['伪装扩展名', () => file('photo.png.exe'), 'image'],
  ['未知分类', () => file('a.png'), 'audio'],
  ['空文件', () => file('empty.txt', ''), 'document'],
  ['不存在', () => ({ path: join(tempDir, 'missing.txt') }), 'document'],
  ['目录', () => { const dir = join(tempDir, `dir${counter++}.txt`); mkdirSync(dir); return { path: dir }; }, 'document'],
  ['空路径', () => ({ path: ' ' }), 'document'],
];
for (const [label, make, type] of badFiles) {
  test(`文件准入：${label} 在本地拒绝且不发请求`, async () => {
    const rec = recorder(reply(202, ok(record())));
    await assert.rejects(lib.createMediaUploadClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport: rec.transport }).submit(make().path, type), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('大小上限：文档、图片 50 MiB，视频 500 MiB；超出时本地拒绝', async () => {
  assert.deepEqual(lib.MAX_BYTES, { document: 50 * 1024 * 1024, image: 50 * 1024 * 1024, video: 500 * 1024 * 1024 });
  const { openSync, ftruncateSync, closeSync } = await import('node:fs');
  const sparse = (name, size) => { const path = join(tempDir, `s${counter++}-${name}`); const fd = openSync(path, 'w'); ftruncateSync(fd, size); closeSync(fd); return path; };
  await assert.rejects(lib.inspectFile(sparse('big.png', 50 * 1024 * 1024 + 1), 'image'), error => error.kind === 'input' && error.message.includes('50 MiB'));
  await lib.inspectFile(sparse('edge.png', 50 * 1024 * 1024), 'image');
  await lib.inspectFile(sparse('edge.mp4', 500 * 1024 * 1024), 'video');
  await assert.rejects(lib.inspectFile(sparse('big.mp4', 500 * 1024 * 1024 + 1), 'video'), error => error.kind === 'input' && error.message.includes('500 MiB'));
});

test('status 输入：只接受 UUID 形式的 upload_id', async () => {
  for (const input of [{}, { upload_id: '' }, { upload_id: 'abc' }, { upload_id: 42 }, { upload_id: UPLOAD, extra: 1 }, [UPLOAD], null]) {
    const rec = recorder(reply(200, ok(done())));
    await assert.rejects(make(rec.transport).status(input), error => error.kind === 'input', JSON.stringify(input));
    assert.equal(rec.calls.length, 0);
  }
  const rec = recorder(reply(200, ok(done({ upload_id: UPLOAD.toUpperCase() }))));
  await make(rec.transport).status({ upload_id: UPLOAD.toUpperCase() });
});

// ---------------------------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------------------------
test('submit 完整性：服务端回报的大小或 SHA-256 与本地不一致时报 integrity 错误', async () => {
  for (const over of [{ size_bytes: DOC.size + 1 }, { sha256: 'f'.repeat(64) }]) {
    await assert.rejects(make(recorder(reply(202, ok(record(over)))).transport).submit(DOC.path, 'document'), error => error.kind === 'integrity' && error.upload_id === UPLOAD);
  }
});

test('submit 只认 202 且状态为 uploading；status 只认 200', async () => {
  for (const response of [reply(200, ok(record())), reply(201, ok(record())), reply(202, ok(done()))]) {
    await assert.rejects(make(recorder(response).transport).submit(DOC.path, 'document'), error => error.kind === 'protocol' && error.outcome === 'unknown');
  }
  await assert.rejects(make(recorder(reply(202, ok(done()))).transport).status({ upload_id: UPLOAD }), error => error.kind === 'protocol');
});

test('账务字段必须为 null 或缺省：任一有值视为协议错误', async () => {
  for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) {
    await assert.rejects(make(recorder(reply(200, ok(done(), { [field]: field === 'credits_consumed' ? 0 : 'settled' }))).transport).status({ upload_id: UPLOAD }), error => error.kind === 'protocol', field);
  }
});

const badResults = [
  done({ upload_id: 'not-a-uuid' }),
  done({ upload_id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' }),
  done({ status: 'queued' }),
  done({ file_type: 'audio' }),
  done({ size_bytes: 0 }),
  done({ sha256: 'ABC' }),
  done({ oss_url: null }),
  done({ oss_key: null }),
  record({ oss_url: 'https://oss.example.com/x' }),
  record({ status: 'failed' }),
  record({ failure_code: 'storage_upload_failed' }),
  done({ failure_code: 'x' }),
];
for (const data of badResults) {
  test(`响应校验 status：${JSON.stringify(data).slice(0, 90)} 视为协议错误`, async () => {
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).status({ upload_id: UPLOAD }), error => error.kind === 'protocol');
  });
}

test('协议错误：非 JSON、缺 meta、success 与状态矛盾、错误 code 不是 HTTP×100+1', async () => {
  for (const response of [reply(200, '<html>'), reply(200, { success: true, data: done(), error: null }), reply(200, { ...ok(done()), success: false }), reply(404, { ...fail(404, 'upload_not_found'), success: true }), reply(404, { ...fail(404, 'upload_not_found'), error: { code: 404, message: 'upload_not_found' } })]) {
    await assert.rejects(make(recorder(response).transport).status({ upload_id: UPLOAD }), error => error.kind === 'protocol');
  }
});

// ---------------------------------------------------------------------------------------------
// 错误与结果未知
// ---------------------------------------------------------------------------------------------
const errorTable = [
  ['submit', 401, 'API key authentication required', undefined],
  ['submit', 403, 'OpenAPI access denied', undefined],
  ['submit', 413, 'file_too_large', 'file_too_large'],
  ['submit', 413, 'payload_too_large', 'payload_too_large'],
  ['submit', 415, 'unsupported_file_type', 'unsupported_file_type'],
  ['submit', 422, 'invalid_filename', 'invalid_filename'],
  ['submit', 422, 'empty_file', 'empty_file'],
  ['submit', 422, 'invalid_multipart', 'invalid_multipart'],
  ['submit', 429, 'upload_capacity_exceeded', 'upload_capacity_exceeded'],
  ['submit', 503, 'upload_storage_unavailable', 'upload_storage_unavailable'],
  ['submit', 500, 'Internal server error', undefined],
  ['status', 404, 'upload_not_found', 'upload_not_found'],
  ['status', 503, 'upload_status_unavailable', 'upload_status_unavailable'],
  ['status', 422, 'Request validation failed: body.upload_id: Invalid value type or format', undefined],
];
const argsFor = operation => (operation === 'submit' ? ['--file', DOC.path, '--type', 'document'] : [JSON.stringify({ upload_id: UPLOAD })]);
for (const [operation, status, message, reason] of errorTable) {
  test(`错误 ${operation} HTTP ${status}（${message}）：外层 code ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run(operation, argsFor(operation), reply(status, fail(status, message, { request_id: 'req-err' })));
    const error = result.diagnostic.error;
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.deepEqual([error.kind, error.status, error.code, error.reason, error.request_id], ['http', status, status * 100 + 1, reason, 'req-err']);
    assert.equal(error.outcome, operation === 'submit' && status >= 500 ? 'unknown' : 'rejected');
    if (reason === undefined) assert.equal(JSON.stringify(error).includes(message), false);
  });
}

test('429：合法 Retry-After 原样提示，非法值不输出，且不自动重试', async () => {
  for (const [header, expected] of [['30', '30'], ['Mon, 16 Nov 2026 00:00:30 GMT', 'Mon, 16 Nov 2026 00:00:30 GMT'], ['soon', undefined]]) {
    const result = await run('submit', argsFor('submit'), reply(429, fail(429, 'upload_capacity_exceeded'), { 'Retry-After': header }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.retry_after, expected);
  }
});

test('结果未知：submit 超时、断连只调用一次并标 unknown；status 超时标 unavailable', async () => {
  await assert.rejects(make(() => new Promise(() => {}), { uploadTimeoutMs: 20 }).submit(DOC.path, 'document'), error => error.kind === 'timeout' && error.outcome === 'unknown' && error.message.includes('重新上传会生成新的对象'));
  let attempts = 0;
  await assert.rejects(make(async () => { attempts++; throw new Error(`socket ${SECRET}`); }).submit(DOC.path, 'document'), error => error.kind === 'network' && error.outcome === 'unknown' && !error.message.includes(SECRET));
  assert.equal(attempts, 1);
  await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).status({ upload_id: UPLOAD }), error => error.kind === 'timeout' && error.outcome === 'unavailable');
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本、本地路径和异常堆栈不进入错误输出', async () => {
  const secretFile = file('PrivateClientBrief.txt');
  const result = await run('submit', ['--file', secretFile.path, '--type', 'document'], reply(500, fail(500, 'Traceback: oss token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2', 'PrivateClientBrief', tempDir]) assert.equal(text.includes(leaked), false, leaked);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('status', { args: [JSON.stringify({ upload_id: UPLOAD })], client: { status: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI、轮询与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI 参数：submit 需要 --file 和 --type；status 需要单个 JSON 或 --input-file；未知参数返回 1 且不发请求', async () => {
  const input = join(tempDir, 'status.json');
  writeFileSync(input, `\uFEFF${JSON.stringify({ upload_id: UPLOAD })}`);
  assert.equal((await run('status', ['--input-file', input], reply(200, ok(done())))).code, 0);
  for (const [operation, args] of [['submit', []], ['submit', ['--file', DOC.path]], ['submit', ['--type', 'document']], ['submit', ['--file', DOC.path, '--type', 'document', '--output', 'x']], ['submit', [DOC.path]], ['status', []], ['status', ['{bad']], ['status', ['--input-file']], ['status', ['--file', DOC.path]], ['status', [JSON.stringify({ upload_id: UPLOAD }), '--input-file', input]]]) {
    const result = await run(operation, args, reply(202, ok(record())));
    assert.equal(result.code, 1, `${operation} ${JSON.stringify(args)}`);
    assert.equal(result.calls.length, 0);
  }
});

test('submit 不带 --wait：stdout 是 202 响应，stderr 提醒保存 upload_id 后查询', async () => {
  const result = await run('submit', argsFor('submit'), reply(202, ok(record())));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out[0]).data.upload_id, UPLOAD);
  assert.ok(result.err[0].includes('保存 data.upload_id'));
});

test('submit --wait：受理后每 3 秒查询一次，succeeded 时退出码 0、stdout 为最终状态', async () => {
  const result = await run('submit', [...argsFor('submit'), '--wait'], [reply(202, ok(record())), reply(200, ok(record())), reply(200, ok(record())), reply(200, ok(done()))]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 4);
  assert.deepEqual(result.sleeps, [3000, 3000]);
  assert.equal(JSON.parse(result.out.at(-1)).data.oss_url, done().oss_url);
  assert.ok(result.err.at(-1).includes('私有对象'));
  assert.equal(cli.WAIT.intervalMs, 3000);
  assert.equal(cli.WAIT.attempts, 100);
});

test('status --wait：failed 时停止轮询、退出码 1 并给出 failure_code', async () => {
  const result = await run('status', [JSON.stringify({ upload_id: UPLOAD }), '--wait'], [reply(200, ok(record())), reply(200, ok(record({ status: 'failed', failure_code: 'upload_timeout', failure_message: '上传超时' })))]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.deepEqual([result.diagnostic.error.kind, result.diagnostic.error.failure_code], ['upload_failed', 'upload_timeout']);
  assert.ok(result.diagnostic.error.message.includes('上传超时'));
});

test('失败提示：已知 failure_code 给固定说明，未知码给通用说明，不回显服务端自由文本', async () => {
  assert.ok(cli.failureHint('upload_timeout').includes('超时'));
  assert.ok(cli.failureHint('storage_upload_failed').includes('存储失败'));
  assert.ok(cli.failureHint('something_new').includes('按 failure_code 报告'));
  const result = await run('status', argsFor('status'), reply(200, ok(record({ status: 'failed', failure_code: 'storage_upload_failed', failure_message: 'Traceback secret' }))));
  assert.equal(result.code, 0);
  assert.equal(result.err.join('\n').includes('Traceback'), false);
});

test('failure_message：可缺省、可为 null 或文本，其他类型视为协议错误', async () => {
  for (const value of [undefined, null, '上传超时']) {
    await make(recorder(reply(200, ok(record({ status: 'failed', failure_code: 'upload_timeout', failure_message: value })))).transport).status({ upload_id: UPLOAD });
  }
  await assert.rejects(make(recorder(reply(200, ok(record({ status: 'failed', failure_code: 'upload_timeout', failure_message: 1 })))).transport).status({ upload_id: UPLOAD }), error => error.kind === 'protocol');
});

test('status --wait：预算用完仍在上传时退出码 2，提示用同一个 upload_id 稍后再查、不要重新上传', async () => {
  const result = await run('status', [JSON.stringify({ upload_id: UPLOAD }), '--wait'], reply(200, ok(record())), { wait: { intervalMs: 3000, attempts: 4 } });
  assert.equal(result.code, 2);
  assert.equal(result.calls.length, 4);
  assert.equal(result.sleeps.length, 3);
  assert.ok(result.diagnostic.wait.message.includes('不要重新上传'));
});

test('status --wait：输入无效时不发请求；轮询中遇到错误立即停止', async () => {
  const bad = await run('status', [JSON.stringify({ upload_id: 'x' }), '--wait'], reply(200, ok(done())));
  assert.equal(bad.code, 1);
  assert.equal(bad.calls.length, 0);
  const broken = await run('status', [JSON.stringify({ upload_id: UPLOAD }), '--wait'], [reply(200, ok(record())), reply(404, fail(404, 'upload_not_found'))]);
  assert.equal(broken.code, 1);
  assert.equal(broken.calls.length, 2);
  assert.equal(broken.diagnostic.error.reason, 'upload_not_found');
});

test('status 不带 --wait：uploading / failed / succeeded 都退出码 0，并给出对应提醒', async () => {
  for (const [data, phrase] of [[record(), '不要重新上传'], [record({ status: 'failed', failure_code: 'storage_upload_failed' }), 'storage_upload_failed'], [done(), '稳定引用']]) {
    const result = await run('status', argsFor('status'), reply(200, ok(data)));
    assert.equal(result.code, 0);
    assert.ok(result.err[0].includes(phrase), phrase);
  }
});

for (const operation of ['submit', 'status']) {
  test(`入口脚本 media_upload_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`media_upload_${operation}.mjs`);
    const rec = recorder(reply(operation === 'submit' ? 202 : 200, ok(operation === 'submit' ? record() : done())));
    assert.equal(await mod.main({ args: argsFor(operation), client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.ok(rec.calls[0].url.endsWith(lib.operations[operation].path));
    const proc = spawnSync(process.execPath, [join(scripts, `media_upload_${operation}.mjs`), ...argsFor(operation)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('素材上传脚本不含硬编码地址、Key、Authorization 头，也不调用已取消的 /v1/files 路径或 files:upload scope', () => {
  const files = readdirSync(scripts).filter(name => name.includes('media_upload'));
  assert.equal(files.length, 4);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s|influxai_/i.test(source), false, name);
    assert.equal(/\/v1\/files|files:upload/.test(source), false, name);
  }
});
