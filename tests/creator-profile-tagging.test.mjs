// Isolated tests for the creator profile tagging scripts. No real network, backend or key is used:
// every request goes through an injected transport, and global fetch is replaced with a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('real network is blocked in isolated tests'); };

const scripts = resolve(fileURLToPath(new URL('..', import.meta.url)), 'influx-ai', 'scripts');
const load = name => import(pathToFileURL(join(scripts, name)).href);
const lib = await load('_profile_tagging_client.mjs');
const cli = await load('_profile_tagging_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
// Ids above 2^53 prove that BIGINT values are never converted to JSON numbers.
const BATCH = '9007199254740993';
const ITEM = '9007199254740994';
const MAX_ID = '9223372036854775807';
const NOW = '2026-11-13T00:00:00Z';
const URL_YT = 'https://www.youtube.com/@example';
const submitInput = { idempotency_key: 'profile-example-1', items: [{ platform: 'youtube', profile_url: URL_YT }], force_refresh: false };

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const batchView = (over = {}) => ({
  id: BATCH, status: 'queued', item_count: 1, submitted_count: 1, succeeded_count: 0, failed_count: 0,
  stage_counts: { checking_warehouse: 1 }, collection_counts: { checking: 1 }, force_refresh: false, created_at: NOW, finished_at: null, ...over,
});
const itemView = (over = {}) => ({
  id: ITEM, batch_id: BATCH, input_index: 1, platform: 'youtube', profile_url: URL_YT, normalized_profile_url: URL_YT,
  status: 'checking_warehouse', stage: 'checking_warehouse', warehouse_detail_id: null, collection_status: 'checking', collection_error_code: null,
  collection_task_id: null, attempt_no: 0, result_source: null, result_obtained_at: null, error_code: null, error_message: null, updated_at: NOW, ...over,
});
const detailView = (over = {}) => ({ ...itemView(), result: null, ...over });
const page = rows => ({ items: rows, total: rows.length, page: 1, page_size: 20 });
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const pathOf = call => call.url.split('/openapi')[1];

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return list[Math.min(calls.length - 1, list.length - 1)];
  };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createProfileTaggingClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'profile-tagging-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;
const json = value => JSON.stringify(value);
function writeInput(value, { bom = false } = {}) {
  const path = join(tempDir, `input-${fileCounter++}.json`);
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${typeof value === 'string' ? value : json(value)}`);
  return path;
}

async function run(operation, args, responses, options = {}) {
  const rec = recorder(responses);
  const out = [];
  const err = [];
  const sleeps = [];
  const code = await cli.runCli(operation, {
    args, client: make(rec.transport, options.client), sleep: async ms => { sleeps.push(ms); },
    stdout: value => out.push(value), stderr: value => err.push(value), ...options.cli,
  });
  // Success notes are plain text; only JSON diagnostics are parsed.
  const last = err.at(-1);
  return { code, out, err, sleeps, calls: rec.calls, diagnostic: last?.startsWith('{') ? JSON.parse(last) : null };
}

// ---------------------------------------------------------------------------------------------
// 请求构造与 Key 注入
// ---------------------------------------------------------------------------------------------
const emptyPage = { items: [], total: 0, page: 1, page_size: 20 };
const cases = [
  ['options', {}, '/v1/creator-profile-tagging/options', 200, {}, { enabled: true, max_items: 100, max_input_rows: 500, reuse_days: 7 }],
  ['submit', submitInput, '/v1/creator-profile-tagging/batches/submit', 202, submitInput, batchView()],
  ['list_batches', {}, '/v1/creator-profile-tagging/batches/list', 200, { page: 1, page_size: 20 }, emptyPage],
  ['list_batches', { page: 2, page_size: 100 }, '/v1/creator-profile-tagging/batches/list', 200, { page: 2, page_size: 100 }, emptyPage],
  ['get_batch', { batch_id: BATCH }, '/v1/creator-profile-tagging/batches/get', 200, { batch_id: BATCH }, batchView()],
  ['list_items', { batch_id: BATCH }, '/v1/creator-profile-tagging/items/list', 200, { batch_id: BATCH, page: 1, page_size: 20 }, page([itemView()])],
  ['list_items', { batch_id: BATCH, status: 'unknown', query: 'example', page: 3, page_size: 50 }, '/v1/creator-profile-tagging/items/list', 200, { batch_id: BATCH, status: 'unknown', query: 'example', page: 3, page_size: 50 }, emptyPage],
  ['get_item', { batch_id: BATCH, item_id: ITEM }, '/v1/creator-profile-tagging/items/get', 200, { batch_id: BATCH, item_id: ITEM }, detailView()],
  ['retry', { batch_id: BATCH, item_id: ITEM }, '/v1/creator-profile-tagging/items/retry', 202, { batch_id: BATCH, item_id: ITEM }, itemView()],
];
for (const [operation, input, path, status, expectedBody, data] of cases) {
  test(`${operation}: 请求路径、方法、请求头和请求体符合契约 (${JSON.stringify(input).slice(0, 40)})`, async () => {
    const rec = recorder(reply(status, ok(data)));
    const result = await make(rec.transport).execute(operation, input);
    assert.equal(rec.calls.length, 1);
    const [call] = rec.calls;
    assert.equal(call.url, `https://scout.example.com/openapi${path}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, expectedBody);
    for (const forbidden of ['jwt', 'user_id', 'team_id', 'token', 'api_key', 'provider']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('submit: 未指定 force_refresh 时不替服务端填默认值', async () => {
  const rec = recorder(reply(202, ok(batchView())));
  await make(rec.transport).execute('submit', { idempotency_key: 'k', items: submitInput.items });
  assert.deepEqual(rec.calls[0].body, { idempotency_key: 'k', items: submitInput.items });
});

test('BIGINT：十进制字符串原样发送，包括超过 2^53 和 int64 最大值', async () => {
  for (const id of [BATCH, ITEM, MAX_ID, '1', '000123']) {
    const rec = recorder(reply(200, ok(detailView({ id, batch_id: id }))));
    await make(rec.transport).execute('get_item', { batch_id: id, item_id: id });
    assert.equal(rec.calls[0].body.batch_id, id);
    assert.equal(rec.calls[0].body.item_id, id);
    assert.equal(rec.calls[0].init.body.includes(`"${id}"`), true);
  }
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [
    ['https://scout.example.com', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/openapi', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/openapi/', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/api', 'https://scout.example.com/api/openapi'],
    ['http://127.0.0.1:8010', 'http://127.0.0.1:8010/openapi'],
  ]) {
    const rec = recorder(reply(200, ok({ enabled: true, max_items: 100, max_input_rows: 500, reuse_days: 7 })));
    await lib.createProfileTaggingClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('options', {});
    assert.equal(rec.calls[0].url, `${expected}/v1/creator-profile-tagging/options`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  const rec = recorder(reply(200, ok(batchView())));
  for (const options of [
    { baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: '   ' }, { baseUrl: 'not a url', apiKey: SECRET },
    { apiKey: SECRET }, { baseUrl: 'https://user:pass@scout.example.com', apiKey: SECRET }, { baseUrl: 'https://scout.example.com/?x=1', apiKey: SECRET },
    { baseUrl: 'ftp://scout.example.com', apiKey: SECRET },
  ]) assert.throws(() => lib.createProfileTaggingClient({ ...options, transport: rec.transport }), error => error.kind === 'configuration');
  assert.equal(rec.calls.length, 0);
});

test('Key 前后的空白会被去掉再注入请求头', async () => {
  const rec = recorder(reply(200, ok({ enabled: true, max_items: 100, max_input_rows: 500, reuse_days: 7 })));
  await lib.createProfileTaggingClient({ baseUrl: 'https://scout.example.com', apiKey: `  ${SECRET}\n`, transport: rec.transport }).execute('options', {});
  assert.equal(rec.calls[0].init.headers['X-API-Key'], SECRET);
});

// ---------------------------------------------------------------------------------------------
// 输入校验：非法输入在本地失败，不发请求
// ---------------------------------------------------------------------------------------------
const one = { platform: 'youtube', profile_url: URL_YT };
const rejected = [
  ['options', { extra: 1 }, 'options 带字段'],
  ['submit', { ...submitInput, extra: 1 }, '未开放字段'],
  ['submit', { items: submitInput.items }, '缺少 idempotency_key'],
  ['submit', { ...submitInput, idempotency_key: '   ' }, 'idempotency_key 全是空白'],
  ['submit', { ...submitInput, idempotency_key: 'k'.repeat(129) }, 'idempotency_key 超过 128 字符'],
  ['submit', { ...submitInput, idempotency_key: 12345 }, 'idempotency_key 不是文本'],
  ['submit', { ...submitInput, idempotency_key: null }, 'idempotency_key 为 null'],
  ['submit', { idempotency_key: 'k' }, '缺少 items'],
  ['submit', { ...submitInput, items: [] }, 'items 为空'],
  ['submit', { ...submitInput, items: Array.from({ length: 501 }, () => one) }, 'items 超过 500 行'],
  ['submit', { ...submitInput, items: 'x' }, 'items 不是数组'],
  ['submit', { ...submitInput, items: [{ platform: 'youtube' }] }, '条目缺少 profile_url'],
  ['submit', { ...submitInput, items: [{ profile_url: URL_YT }] }, '条目缺少 platform'],
  ['submit', { ...submitInput, items: [{ ...one, extra: 1 }] }, '条目带多余字段'],
  ['submit', { ...submitInput, items: [{ platform: 'twitter', profile_url: 'https://x.com/a' }] }, '不支持的平台'],
  ['submit', { ...submitInput, items: [{ platform: '', profile_url: URL_YT }] }, 'platform 为空'],
  ['submit', { ...submitInput, items: [{ platform: 'youtube', profile_url: 'http://www.youtube.com/@example' }] }, '非 HTTPS 链接'],
  ['submit', { ...submitInput, items: [{ platform: 'youtube', profile_url: '@example' }] }, '不是链接'],
  ['submit', { ...submitInput, items: [{ platform: 'youtube', profile_url: `https://www.youtube.com/@${'a'.repeat(1000)}` }] }, 'profile_url 超过 1000 字符'],
  ['submit', { ...submitInput, items: [{ platform: 'youtube', profile_url: 7 }] }, 'profile_url 不是文本'],
  ['submit', { ...submitInput, force_refresh: 'true' }, 'force_refresh 是字符串'],
  ['submit', { ...submitInput, force_refresh: 1 }, 'force_refresh 是数字'],
  ['submit', { ...submitInput, force_refresh: null }, 'force_refresh 为 null'],
  ['get_batch', {}, '缺少 batch_id'],
  ['get_batch', { batch_id: 9007199254740993 }, 'batch_id 是 JSON 数字'],
  ['get_batch', { batch_id: 42 }, 'batch_id 是小整数数字'],
  ['get_batch', { batch_id: '0' }, 'batch_id 为 0'],
  ['get_batch', { batch_id: '-5' }, 'batch_id 为负数'],
  ['get_batch', { batch_id: '12a' }, 'batch_id 含非数字'],
  ['get_batch', { batch_id: '' }, 'batch_id 为空'],
  ['get_batch', { batch_id: '9223372036854775808' }, 'batch_id 超过 int64'],
  ['get_batch', { batch_id: '1'.repeat(20) }, 'batch_id 超过 19 位'],
  ['get_batch', { batch_id: '٣' }, 'batch_id 含非 ASCII 数字'],
  ['get_batch', { batch_id: BATCH, item_id: ITEM }, 'get_batch 带 item_id'],
  ['get_item', { batch_id: BATCH }, '缺少 item_id'],
  ['get_item', { batch_id: BATCH, item_id: 7 }, 'item_id 是数字'],
  ['retry', { batch_id: BATCH }, 'retry 缺少 item_id'],
  ['retry', { batch_id: 7, item_id: ITEM }, 'retry 的 batch_id 是数字'],
  ['retry', { batch_id: BATCH, item_id: ITEM, force: true }, 'retry 带多余字段'],
  ['list_batches', { page: 0 }, 'page 为 0'],
  ['list_batches', { page_size: 0 }, 'page_size 为 0'],
  ['list_batches', { page_size: 101 }, 'page_size 超过 100'],
  ['list_batches', { page: null }, 'page 为 null'],
  ['list_batches', { page_size: null }, 'page_size 为 null'],
  ['list_batches', { page: 1.5 }, 'page 不是整数'],
  ['list_batches', { page: '1' }, 'page 是字符串'],
  ['list_batches', { status: 'queued' }, 'list_batches 不接受筛选字段'],
  ['list_items', { page: 1 }, 'list_items 缺少 batch_id'],
  ['list_items', { batch_id: BATCH, status: 's'.repeat(33) }, 'status 超过 32 字符'],
  ['list_items', { batch_id: BATCH, query: 'q'.repeat(256) }, 'query 超过 255 字符'],
  ['list_items', { batch_id: BATCH, status: 7 }, 'status 不是文本'],
  ['list_items', { batch_id: BATCH, extra: 1 }, 'list_items 带多余字段'],
  ['list_items', { batch_id: BATCH, page_size: 101 }, 'list_items 的 page_size 超过 100'],
];
const okFor = operation => ({
  options: { enabled: true, max_items: 100, max_input_rows: 500, reuse_days: 7 }, submit: batchView(), list_batches: emptyPage, get_batch: batchView(),
  list_items: emptyPage, get_item: detailView(), retry: itemView(),
}[operation]);
for (const [operation, input, label] of rejected) {
  test(`${operation} 拒绝：${label}`, async () => {
    const rec = recorder(reply(200, ok(okFor(operation))));
    await assert.rejects(make(rec.transport).execute(operation, input), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('submit 边界值通过：500 行、128 字符的键、platform 大小写与空白、force_refresh 为 true', async () => {
  for (const input of [
    { ...submitInput, items: Array.from({ length: 500 }, (_, index) => ({ platform: 'youtube', profile_url: `https://www.youtube.com/@creator${index}` })) },
    { ...submitInput, idempotency_key: 'k'.repeat(128) },
    { ...submitInput, idempotency_key: '  profile-1  ' },
    { ...submitInput, items: [{ platform: ' YouTube ', profile_url: `  ${URL_YT}  ` }] },
    { ...submitInput, items: [{ platform: 'instagram', profile_url: 'https://www.instagram.com/example' }, { platform: 'tiktok', profile_url: 'https://www.tiktok.com/@example' }] },
    { ...submitInput, force_refresh: true },
  ]) {
    const rec = recorder(reply(202, ok(batchView())));
    await make(rec.transport).execute('submit', input);
    assert.equal(rec.calls.length, 1);
  }
});

test('submit：本地不改写条目内容，也不去重（规范化和去重由服务端完成）', async () => {
  const items = [{ platform: 'YouTube', profile_url: 'https://www.youtube.com/@Example' }, { platform: 'youtube', profile_url: 'https://www.youtube.com/@example' }];
  const rec = recorder(reply(202, ok(batchView({ item_count: 1, submitted_count: 2 }))));
  await make(rec.transport).execute('submit', { idempotency_key: 'k', items });
  assert.deepEqual(rec.calls[0].body.items, items);
});

test('请求体超过 64 KiB 时本地拒绝，未超过时正常发送', async () => {
  const build = handleLength => ({ idempotency_key: 'k', items: Array.from({ length: 500 }, (_, index) => ({ platform: 'youtube', profile_url: `https://www.youtube.com/@${'a'.repeat(handleLength)}${index}` })) });
  const rec = recorder(reply(202, ok(batchView())));
  const fits = build(40);
  assert.ok(Buffer.byteLength(JSON.stringify(fits)) < 64 * 1024);
  await make(rec.transport).execute('submit', fits);
  const huge = build(190).items;
  assert.ok(Buffer.byteLength(JSON.stringify({ idempotency_key: 'k', items: huge })) > 64 * 1024);
  await assert.rejects(make(rec.transport).execute('submit', { idempotency_key: 'k', items: huge }), error => error.kind === 'input' && error.message.includes('64 KiB'));
  assert.equal(rec.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------
// 单层响应解析
// ---------------------------------------------------------------------------------------------
test('成功响应原样返回整个外壳，保留 request_id 和未知 meta 字段，ID 保持字符串', async () => {
  const body = ok(batchView(), { request_id: 'req-keep', future_field: 'kept' });
  const result = await make(recorder(reply(200, body)).transport).execute('get_batch', { batch_id: BATCH });
  assert.deepEqual(result, body);
  assert.equal(result.meta.request_id, 'req-keep');
  assert.equal(result.data.id, BATCH);
});

test('分页响应保留 meta.page / size / total', async () => {
  const body = ok(page([batchView()]), { page: 1, size: 20, total: 1 });
  const result = await make(recorder(reply(200, body)).transport).execute('list_batches', {});
  assert.deepEqual(result, body);
  assert.deepEqual([result.meta.page, result.meta.size, result.meta.total], [1, 20, 1]);
});

const badEnvelopes = [
  ['submit 返回 200 而不是 202', 'submit', submitInput, reply(200, ok(batchView()))],
  ['retry 返回 200 而不是 202', 'retry', { batch_id: BATCH, item_id: ITEM }, reply(200, ok(itemView()))],
  ['get_batch 返回 202 而不是 200', 'get_batch', { batch_id: BATCH }, reply(202, ok(batchView()))],
  ['success 为 true 但 error 非空', 'get_batch', { batch_id: BATCH }, reply(200, { ...ok(batchView()), error: { code: 1, message: 'x' } })],
  ['再包了一层 success/data', 'get_batch', { batch_id: BATCH }, reply(200, ok(ok(batchView())))],
  ['不是 JSON', 'get_batch', { batch_id: BATCH }, reply(200, '<html>bad gateway</html>')],
  ['缺少 meta', 'get_batch', { batch_id: BATCH }, reply(200, { success: true, data: batchView(), error: null })],
  ['credits_consumed 不是 null', 'get_batch', { batch_id: BATCH }, reply(200, ok(batchView(), { credits_consumed: 0 }))],
  ['billing_status 不是 null', 'get_batch', { batch_id: BATCH }, reply(200, ok(batchView(), { billing_status: 'settled' }))],
  ['billing_operation_id 不是 null', 'get_batch', { batch_id: BATCH }, reply(200, ok(batchView(), { billing_operation_id: 'op-1' }))],
  ['失败外壳的 data 非空', 'get_batch', { batch_id: BATCH }, reply(404, { ...fail(404, 'batch_not_found'), data: batchView() })],
  ['失败外壳的 code 与 HTTP 不一致', 'get_batch', { batch_id: BATCH }, reply(404, { success: false, data: null, error: { code: 40400, message: 'batch_not_found' }, meta: meta() })],
  ['失败外壳缺少 message', 'get_batch', { batch_id: BATCH }, reply(404, { success: false, data: null, error: { code: 40401 }, meta: meta() })],
  ['失败 HTTP 却声明 success', 'get_batch', { batch_id: BATCH }, reply(404, ok(batchView()))],
];
for (const [label, operation, input, response] of badEnvelopes) {
  test(`协议错误：${label}`, async () => {
    await assert.rejects(make(recorder(response).transport).execute(operation, input), error => error.kind === 'protocol');
  });
}

// ---------------------------------------------------------------------------------------------
// 批次与条目状态、结果来源
// ---------------------------------------------------------------------------------------------
test('批次状态：queued / running / completed / completed_with_errors 都能解析，部分失败保留计数', async () => {
  for (const status of ['queued', 'running', 'completed', 'completed_with_errors']) {
    const data = batchView({ status, item_count: 3, succeeded_count: 2, failed_count: 1, stage_counts: { succeeded: 2, failed_retryable: 1 }, finished_at: status.startsWith('completed') ? NOW : null });
    const result = await make(recorder(reply(200, ok(data))).transport).execute('get_batch', { batch_id: BATCH });
    assert.deepEqual(result.data, data);
  }
});

test('条目状态：阶段状态与四个终态都能解析', async () => {
  for (const status of ['checking_warehouse', 'tag_queued', 'tagging', 'retry_wait', 'succeeded', 'failed_retryable', 'failed_final', 'unknown']) {
    const result = await make(recorder(reply(200, ok(page([itemView({ status, stage: status })])))).transport).execute('list_items', { batch_id: BATCH });
    assert.equal(result.data.items[0].status, status);
  }
});

test('result_source 与 result_obtained_at 原样保留：reused 保留原结果时间，live 是本次新获得', async () => {
  const reused = detailView({ status: 'succeeded', stage: 'succeeded', result_source: 'reused', result_obtained_at: '2026-11-08T03:00:00Z', result: { note: 'older result' } });
  const live = detailView({ status: 'succeeded', stage: 'succeeded', result_source: 'live', result_obtained_at: '2026-11-13T00:05:00Z', result: { note: 'fresh result' } });
  for (const data of [reused, live]) {
    const out = await run('get_item', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(200, ok(data)));
    const printed = JSON.parse(out.out[0]).data;
    assert.equal(printed.result_source, data.result_source);
    assert.equal(printed.result_obtained_at, data.result_obtained_at);
  }
});

test('画像状态与采集状态各自保留，互不覆盖', async () => {
  const data = itemView({ status: 'succeeded', stage: 'succeeded', result_source: 'live', result_obtained_at: NOW, collection_status: 'submitted', collection_task_id: 'task-77', collection_error_code: null });
  const result = await make(recorder(reply(200, ok(page([data])))).transport).execute('list_items', { batch_id: BATCH });
  assert.equal(result.data.items[0].status, 'succeeded');
  assert.equal(result.data.items[0].collection_status, 'submitted');
  assert.equal(result.data.items[0].collection_task_id, 'task-77');
});

test('失败条目保留公开错误码与采集错误码', async () => {
  const data = itemView({ status: 'unknown', stage: 'unknown', error_code: 'upstream_unknown', error_message: 'upstream_unknown', collection_status: 'failed', collection_error_code: 'collection_timeout' });
  const result = await make(recorder(reply(200, ok(page([data])))).transport).execute('list_items', { batch_id: BATCH });
  assert.equal(result.data.items[0].error_code, 'upstream_unknown');
  assert.equal(result.data.items[0].collection_error_code, 'collection_timeout');
});

test('画像 result 是自由 JSON：嵌套结构、中文、数组、空对象都原样保留，不被改写', async () => {
  for (const result of [{}, { a: { b: [1, 2, { c: '中文' }] }, flag: true, none: null }, { 标签: ['咖啡', '户外'], score: 0.5 }]) {
    const data = detailView({ status: 'succeeded', stage: 'succeeded', result_source: 'live', result_obtained_at: NOW, result });
    const out = await run('get_item', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(200, ok(data)));
    assert.deepEqual(JSON.parse(out.out[0]).data.result, result);
  }
});

test('result 为 null 时原样返回 null，不被当作已有画像', async () => {
  const out = await run('get_item', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(200, ok(detailView({ status: 'failed_final', stage: 'failed_final', error_code: 'identity_ambiguous', error_message: 'identity_ambiguous' }))));
  assert.equal(out.code, 0);
  assert.equal(JSON.parse(out.out[0]).data.result, null);
});

test('options：enabled 为 false 时原样返回，不由脚本阻止后续调用', async () => {
  const result = await make(recorder(reply(200, ok({ enabled: false, max_items: 100, max_input_rows: 500, reuse_days: 7 }))).transport).execute('options', {});
  assert.equal(result.data.enabled, false);
});

const badViews = [
  ['批次 ID 是 JSON 数字（精度会丢失）', 'get_batch', { batch_id: BATCH }, batchView({ id: 9007199254740993 })],
  ['批次 ID 含非数字', 'get_batch', { batch_id: BATCH }, batchView({ id: 'abc' })],
  ['批次状态未知', 'get_batch', { batch_id: BATCH }, batchView({ status: 'done' })],
  ['批次计数为负', 'get_batch', { batch_id: BATCH }, batchView({ succeeded_count: -1 })],
  ['stage_counts 值不是整数', 'get_batch', { batch_id: BATCH }, batchView({ stage_counts: { tagging: 'many' } })],
  ['collection_counts 不是对象', 'get_batch', { batch_id: BATCH }, batchView({ collection_counts: [] })],
  ['force_refresh 不是布尔值', 'get_batch', { batch_id: BATCH }, batchView({ force_refresh: 'no' })],
  ['缺少 created_at', 'get_batch', { batch_id: BATCH }, { ...batchView(), created_at: undefined }],
  ['条目 ID 是 JSON 数字', 'list_items', { batch_id: BATCH }, page([itemView({ id: 42 })])],
  ['条目 batch_id 是 JSON 数字', 'list_items', { batch_id: BATCH }, page([itemView({ batch_id: 7 })])],
  ['条目状态未知', 'list_items', { batch_id: BATCH }, page([itemView({ status: 'done' })])],
  ['result_source 未知', 'list_items', { batch_id: BATCH }, page([itemView({ result_source: 'cache' })])],
  ['input_index 为 0', 'list_items', { batch_id: BATCH }, page([itemView({ input_index: 0 })])],
  ['attempt_no 为负', 'list_items', { batch_id: BATCH }, page([itemView({ attempt_no: -1 })])],
  ['摘要里出现 result', 'list_items', { batch_id: BATCH }, page([{ ...itemView(), result: null }])],
  ['retry 返回里出现 result', 'retry', { batch_id: BATCH, item_id: ITEM }, { ...itemView(), result: null }],
  ['详情缺少 result', 'get_item', { batch_id: BATCH, item_id: ITEM }, itemView()],
  ['详情 result 是数组', 'get_item', { batch_id: BATCH, item_id: ITEM }, detailView({ result: [] })],
  ['详情 result 是文本', 'get_item', { batch_id: BATCH, item_id: ITEM }, detailView({ result: 'ok' })],
  ['options 缺字段', 'options', {}, { enabled: true, max_items: 100 }],
  ['options 的 enabled 不是布尔值', 'options', {}, { enabled: 'yes', max_items: 100, max_input_rows: 500, reuse_days: 7 }],
  ['分页 page_size 超过 100', 'list_batches', {}, { items: [], total: 0, page: 1, page_size: 101 }],
  ['分页 total 为负', 'list_batches', {}, { items: [], total: -1, page: 1, page_size: 20 }],
  ['分页 items 不是数组', 'list_batches', {}, { items: {}, total: 0, page: 1, page_size: 20 }],
];
for (const [label, operation, input, data] of badViews) {
  test(`协议错误：${label}`, async () => {
    const status = lib.operations[operation].status;
    await assert.rejects(make(recorder(reply(status, ok(data))).transport).execute(operation, input), error => error.kind === 'protocol');
  });
}

// ---------------------------------------------------------------------------------------------
// CLI 输入与输出
// ---------------------------------------------------------------------------------------------
test('CLI：stdout 只有一层完整 JSON 外壳；submit 和 retry 在 stderr 提示 202 仅表示受理', async () => {
  const submit = await run('submit', ['--input-file', writeInput(submitInput)], reply(202, ok(batchView())));
  assert.equal(submit.code, 0);
  assert.equal(submit.out.length, 1);
  assert.deepEqual(JSON.parse(submit.out[0]), ok(batchView()));
  for (const text of ['202 仅表示已受理', '不代表画像完成', '后台采集独立推进']) assert.ok(submit.err[0].includes(text), text);
  const retry = await run('retry', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(202, ok(itemView())));
  assert.equal(retry.code, 0);
  for (const text of ['202 仅表示已受理', '外部调用成本']) assert.ok(retry.err[0].includes(text), text);
  for (const [operation, input] of [['options', {}], ['list_batches', {}], ['get_batch', { batch_id: BATCH }], ['list_items', { batch_id: BATCH }], ['get_item', { batch_id: BATCH, item_id: ITEM }]]) {
    const result = await run(operation, ['--input-file', writeInput(input)], reply(200, ok(okFor(operation))));
    assert.equal(result.code, 0);
    assert.deepEqual(result.err, [], operation);
  }
});

test('CLI：stdout 中的 ID 保持字符串，没有被转成数字', async () => {
  const result = await run('submit', ['--input-file', writeInput(submitInput)], reply(202, ok(batchView({ id: MAX_ID }))));
  assert.ok(result.out[0].includes(`"id": "${MAX_ID}"`));
});

test('CLI：支持内联 JSON、--input-file 和带 BOM 的文件', async () => {
  const input = { batch_id: BATCH };
  for (const args of [[json(input)], ['--input-file', writeInput(input)], ['--input-file', writeInput(input, { bom: true })]]) {
    const result = await run('get_batch', args, reply(200, ok(batchView())));
    assert.equal(result.code, 0);
    assert.equal(result.calls[0].body.batch_id, BATCH);
  }
});

test('CLI：调用方式错误返回 1 且不发请求', async () => {
  const file = writeInput({ batch_id: BATCH });
  for (const args of [
    [], [json({ batch_id: BATCH }), '--input-file', file], ['--input-file'], ['--input-file', join(tempDir, 'missing.json')],
    ['{not json'], ['--unknown'], ['--input-file', file, '--input-file', file], [json({ batch_id: BATCH }), json({ batch_id: BATCH })],
  ]) {
    const result = await run('get_batch', args, reply(200, ok(batchView())));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
    assert.equal(result.diagnostic.error.kind, 'input');
  }
});

test('CLI：输入错误不回显主页链接或本地路径', async () => {
  const secretUrl = 'https://www.youtube.com/@private-creator-handle';
  const file = writeInput({ idempotency_key: '', items: [{ platform: 'youtube', profile_url: secretUrl }] });
  const result = await run('submit', ['--input-file', file], reply(202, ok(batchView())));
  assert.equal(result.code, 1);
  const text = result.err.join('\n');
  assert.equal(text.includes(secretUrl) || text.includes(file), false);
  const missing = await run('submit', ['--input-file', join(tempDir, 'nope.json')], reply(202, ok(batchView())));
  assert.equal(missing.err.join('\n').includes(tempDir), false);
});

// ---------------------------------------------------------------------------------------------
// 轮询预算：只轮询 get_batch
// ---------------------------------------------------------------------------------------------
test('轮询参数固定为每 2 秒一次、最多 30 次', () => {
  assert.equal(cli.WAIT_INTERVAL_MS, 2000);
  assert.equal(cli.WAIT_MAX_ATTEMPTS, 30);
});

test('get_batch --wait：到达 completed 立即停止，间隔 2 秒，退出码 0', async () => {
  const responses = [
    reply(200, ok(batchView({ status: 'queued' }))),
    reply(200, ok(batchView({ status: 'running' }))),
    reply(200, ok(batchView({ status: 'completed', succeeded_count: 1, stage_counts: { succeeded: 1 }, collection_counts: { not_needed: 1 }, finished_at: NOW }))),
    reply(200, ok(batchView({ status: 'running' }))),
  ];
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], responses);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.sleeps, [2000, 2000]);
  assert.equal(result.out.length, 1);
  assert.equal(JSON.parse(result.out[0]).data.status, 'completed');
  assert.deepEqual(result.err, []);
});

test('get_batch --wait：completed_with_errors 也是终态，不会被报告成全部成功', async () => {
  const data = batchView({ status: 'completed_with_errors', item_count: 3, succeeded_count: 2, failed_count: 1, stage_counts: { succeeded: 2, failed_retryable: 1 }, collection_counts: { not_needed: 3 }, finished_at: NOW });
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], [reply(200, ok(batchView({ status: 'running' }))), reply(200, ok(data))]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 2);
  const printed = JSON.parse(result.out[0]).data;
  assert.equal(printed.status, 'completed_with_errors');
  assert.equal(printed.failed_count, 1);
});

test('get_batch --wait：首次就是终态时不等待', async () => {
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(batchView({ status: 'completed', collection_counts: { not_needed: 1 }, finished_at: NOW }))));
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.sleeps, []);
});

test('get_batch --wait：画像批次已结束但后台采集仍在进行时，提示两者分别解释', async () => {
  for (const collection_counts of [{ pending: 1 }, { submitted: 2, completed: 1 }, { checking: 1 }]) {
    const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(batchView({ status: 'completed', collection_counts, finished_at: NOW }))));
    assert.equal(result.code, 0);
    assert.equal(result.diagnostic.note.batch_id, BATCH);
    assert.deepEqual(result.diagnostic.note.collection_counts, collection_counts);
    assert.ok(result.diagnostic.note.message.includes('后台采集仍在进行'));
  }
  const quiet = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(batchView({ status: 'completed', collection_counts: { completed: 1, not_needed: 1, failed: 1, unknown: 1 }, finished_at: NOW }))));
  assert.deepEqual(quiet.err, []);
});

test('get_batch --wait：预算用完仍在执行，共 30 次查询、29 次等待，退出码 2，交付批次 ID、状态和后续查询方式', async () => {
  const running = batchView({ status: 'running', stage_counts: { tagging: 1 } });
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(running)));
  assert.equal(result.code, 2);
  assert.equal(result.calls.length, 30);
  assert.equal(result.sleeps.length, 29);
  assert.ok(result.sleeps.every(ms => ms === 2000));
  assert.deepEqual(JSON.parse(result.out[0]).data, running);
  assert.equal(result.diagnostic.wait.batch_id, BATCH);
  assert.equal(result.diagnostic.wait.status, 'running');
  assert.equal(result.diagnostic.wait.attempts, 30);
  assert.ok(result.diagnostic.wait.message.includes('get_batch'));
  assert.ok(result.diagnostic.wait.message.includes('不要重新提交'));
});

test('get_batch --wait：整个等待期间只访问 batches/get，每次都是同一个 batch_id', async () => {
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(batchView({ status: 'running' }))), { cli: { maxAttempts: 5 } });
  assert.equal(result.calls.length, 5);
  assert.ok(result.calls.every(call => pathOf(call) === '/v1/creator-profile-tagging/batches/get' && call.body.batch_id === BATCH && Object.keys(call.body).length === 1));
});

test('get_batch --wait：等待中遇到错误立即停止，不再查询也不再等待', async () => {
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], [
    reply(200, ok(batchView({ status: 'running' }))), reply(503, fail(503, 'Service unavailable', { request_id: 'req-503' })), reply(200, ok(batchView({ status: 'completed' }))),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.sleeps.length, 1);
  assert.deepEqual(result.out, []);
  assert.equal(result.diagnostic.error.status, 503);
  assert.equal(result.diagnostic.error.request_id, 'req-503');
});

test('get_batch --wait：等待中遇到 429 按 Retry-After 提示，不自动再查', async () => {
  const result = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], [
    reply(200, ok(batchView({ status: 'running' }))), reply(429, fail(429, 'Too many requests'), { 'Retry-After': '30' }),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.diagnostic.error.retry_after, '30');
});

test('get_batch 不带 --wait 只查询一次', async () => {
  const result = await run('get_batch', ['--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(batchView({ status: 'running' }))));
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.sleeps, []);
});

test('--wait 只允许用于 get_batch：其他六个操作带 --wait 会被拒绝且不发请求', async () => {
  const inputs = { options: {}, submit: submitInput, list_batches: {}, list_items: { batch_id: BATCH }, get_item: { batch_id: BATCH, item_id: ITEM }, retry: { batch_id: BATCH, item_id: ITEM } };
  for (const [operation, input] of Object.entries(inputs)) {
    const result = await run(operation, ['--wait', '--input-file', writeInput(input)], reply(200, ok(okFor(operation))));
    assert.equal(result.code, 1, operation);
    assert.equal(result.calls.length, 0, operation);
    assert.ok(result.diagnostic.error.message.includes('--wait 只用于 get_batch'));
  }
});

// ---------------------------------------------------------------------------------------------
// retry 必须显式调用：unknown / failed_retryable 不会触发任何自动动作
// ---------------------------------------------------------------------------------------------
test('批次含 unknown 或 failed_retryable 条目时，读取与等待都不会自动 retry 或 submit', async () => {
  const withFailures = batchView({ status: 'completed_with_errors', item_count: 3, succeeded_count: 1, failed_count: 2, stage_counts: { succeeded: 1, unknown: 1, failed_retryable: 1 }, collection_counts: { not_needed: 3 }, finished_at: NOW });
  const waited = await run('get_batch', ['--wait', '--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(withFailures)));
  assert.equal(waited.code, 0);
  assert.deepEqual(waited.calls.map(pathOf), ['/v1/creator-profile-tagging/batches/get']);
  const rows = [itemView({ status: 'unknown', stage: 'unknown', error_code: 'upstream_unknown', error_message: 'upstream_unknown' }), itemView({ id: '9007199254740995', status: 'failed_retryable', stage: 'failed_retryable', error_code: 'upstream_retryable', error_message: 'upstream_retryable' })];
  const listed = await run('list_items', ['--input-file', writeInput({ batch_id: BATCH })], reply(200, ok(page(rows))));
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.calls.map(pathOf), ['/v1/creator-profile-tagging/items/list']);
  const detail = await run('get_item', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(200, ok(detailView({ status: 'unknown', stage: 'unknown', error_code: 'upstream_unknown', error_message: 'upstream_unknown' }))));
  assert.deepEqual(detail.calls.map(pathOf), ['/v1/creator-profile-tagging/items/get']);
});

test('retry：只在被调用时发一次请求，只带 batch_id 和 item_id', async () => {
  const result = await run('retry', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(202, ok(itemView({ attempt_no: 2 }))));
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map(pathOf), ['/v1/creator-profile-tagging/items/retry']);
  assert.deepEqual(result.calls[0].body, { batch_id: BATCH, item_id: ITEM });
  assert.equal(JSON.parse(result.out[0]).data.attempt_no, 2);
});

test('retry 被服务端拒绝时不自动换操作、不重试', async () => {
  for (const [status, message] of [[409, 'item_not_retryable'], [409, 'item_state_changed'], [409, 'team_batch_already_running'], [404, 'item_not_found'], [404, 'batch_not_found']]) {
    const result = await run('retry', ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], reply(status, fail(status, message)));
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.status, status);
    assert.equal(result.diagnostic.error.reason, message);
    assert.equal(result.diagnostic.error.outcome, 'rejected');
  }
});

test('retry 超时或连接中断：结果未知（可能已计费），只发一次请求，不自动重发', async () => {
  const calls = [];
  const out = [];
  const err = [];
  const code = await cli.runCli('retry', { args: ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], client: make((url, init) => { calls.push(init.body); return new Promise(() => {}); }, { timeoutMs: 20 }), stdout: v => out.push(v), stderr: v => err.push(v) });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  const diagnostic = JSON.parse(err.at(-1)).error;
  assert.equal(diagnostic.kind, 'timeout');
  assert.equal(diagnostic.outcome, 'unknown');
  assert.ok(diagnostic.message.includes('可能已被受理或计费'));
  assert.deepEqual(out, []);
  let attempts = 0;
  const networkErr = [];
  const networkCode = await cli.runCli('retry', { args: ['--input-file', writeInput({ batch_id: BATCH, item_id: ITEM })], client: make(async () => { attempts++; throw new Error(`socket hang up near ${SECRET}`); }), stdout: () => {}, stderr: v => networkErr.push(v) });
  assert.equal(networkCode, 1);
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(networkErr.at(-1)).error.outcome, 'unknown');
  assert.equal(networkErr.join('\n').includes(SECRET), false);
});

// ---------------------------------------------------------------------------------------------
// submit 的幂等键与失败：不自动重发、不换键
// ---------------------------------------------------------------------------------------------
test('submit 超时：只发一次请求，结果标为未知，保留原键，不自动重发', async () => {
  const bodies = [];
  const err = [];
  const out = [];
  const code = await cli.runCli('submit', { args: ['--input-file', writeInput(submitInput)], client: make((url, init) => { bodies.push(JSON.parse(init.body)); return new Promise(() => {}); }, { timeoutMs: 20 }), stdout: v => out.push(v), stderr: v => err.push(v) });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
  assert.equal(code, 1);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].idempotency_key, 'profile-example-1');
  const diagnostic = JSON.parse(err.at(-1)).error;
  assert.equal(diagnostic.kind, 'timeout');
  assert.equal(diagnostic.outcome, 'unknown');
  assert.deepEqual(out, []);
});

test('读操作超时标为 unavailable，而不是未知', async () => {
  await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute('get_batch', { batch_id: BATCH }), error => error.kind === 'timeout' && error.outcome === 'unavailable');
});

test('submit 的 5xx 与无效响应：结果未知；4xx：已被拒绝；服务关闭：已被拒绝；读操作的 5xx：被拒绝', async () => {
  for (const [response, expected] of [
    [reply(500, fail(500, 'Internal server error')), 'unknown'],
    [reply(503, fail(503, 'Service unavailable')), 'unknown'],
    [reply(202, '{"garbage":true}'), 'unknown'],
    [reply(202, ok(batchView({ status: 'bogus' }))), 'unknown'],
    [reply(503, fail(503, 'creator_profile_tagging_disabled')), 'rejected'],
    [reply(409, fail(409, 'idempotency_key_conflict')), 'rejected'],
    [reply(409, fail(409, 'team_batch_already_running')), 'rejected'],
    [reply(422, fail(422, 'Invalid request')), 'rejected'],
    [reply(422, fail(422, 'batch_item_limit_exceeded')), 'rejected'],
  ]) {
    const result = await run('submit', ['--input-file', writeInput(submitInput)], response);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.outcome, expected);
  }
  const read = await run('get_batch', ['--input-file', writeInput({ batch_id: BATCH })], reply(503, fail(503, 'Service unavailable')));
  assert.equal(read.diagnostic.error.outcome, 'rejected');
});

test('submit 同键不同需求被拒绝（409）：保留原键，不换键重发', async () => {
  const input = { ...submitInput, force_refresh: true };
  const result = await run('submit', ['--input-file', writeInput(input)], reply(409, fail(409, 'idempotency_key_conflict')));
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].body.idempotency_key, 'profile-example-1');
  assert.equal(result.diagnostic.error.reason, 'idempotency_key_conflict');
});

// ---------------------------------------------------------------------------------------------
// 错误码、限流与脱敏
// ---------------------------------------------------------------------------------------------
const errorTable = [
  [401, 'Invalid API key', undefined],
  [403, 'Forbidden', undefined],
  [404, 'batch_not_found', 'batch_not_found'],
  [404, 'item_not_found', 'item_not_found'],
  [409, 'idempotency_key_conflict', 'idempotency_key_conflict'],
  [409, 'team_batch_already_running', 'team_batch_already_running'],
  [409, 'batch_submit_conflict', 'batch_submit_conflict'],
  [409, 'item_not_retryable', 'item_not_retryable'],
  [409, 'item_state_changed', 'item_state_changed'],
  [413, 'payload_too_large', 'payload_too_large'],
  [422, 'batch_input_row_limit_exceeded', 'batch_input_row_limit_exceeded'],
  [422, 'batch_item_limit_exceeded', 'batch_item_limit_exceeded'],
  [422, 'Invalid request', undefined],
  [429, 'Too many requests', undefined],
  [500, 'Internal server error', undefined],
  [503, 'creator_profile_tagging_disabled', 'creator_profile_tagging_disabled'],
  [503, 'Service unavailable', undefined],
];
for (const [status, message, reason] of errorTable) {
  test(`错误 HTTP ${status}（${message}）：外层 code 为 ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run('get_batch', ['--input-file', writeInput({ batch_id: BATCH })], reply(status, fail(status, message, { request_id: 'req-err' })));
    const error = result.diagnostic.error;
    assert.equal(result.code, 1);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, status);
    assert.equal(error.code, status * 100 + 1);
    assert.equal(error.reason, reason);
    assert.equal(error.request_id, 'req-err');
    assert.equal(result.calls.length, 1);
    if (reason === undefined) assert.equal(JSON.stringify(error).includes(message), false);
  });
}

test('429：合法 Retry-After（秒数或 HTTP 日期）原样提示，非法值不输出，且不自动重试', async () => {
  for (const [header, expected] of [['30', '30'], ['0', '0'], ['Fri, 13 Nov 2026 00:00:30 GMT', 'Fri, 13 Nov 2026 00:00:30 GMT'], ['soon', undefined], ['-5', undefined], ['', undefined], [undefined, undefined]]) {
    const result = await run('submit', ['--input-file', writeInput(submitInput)], reply(429, fail(429, 'Too many requests'), header === undefined ? {} : { 'Retry-After': header }));
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.sleeps.length, 0);
    assert.equal(result.diagnostic.error.retry_after, expected);
    assert.equal(result.diagnostic.error.outcome, 'rejected');
  }
});

test('只有 429 才输出 Retry-After', async () => {
  const result = await run('get_batch', ['--input-file', writeInput({ batch_id: BATCH })], reply(503, fail(503, 'Service unavailable'), { 'Retry-After': '30' }));
  assert.equal('retry_after' in result.diagnostic.error, false);
});

test('脱敏：request_id 里的 Key 被隐藏，服务端自由文本和异常堆栈不进入输出', async () => {
  const result = await run('get_batch', ['--input-file', writeInput({ batch_id: BATCH })], reply(500, fail(500, 'Traceback (most recent call last): vendor token=hunter2', { request_id: `id-${SECRET}-end` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2']) assert.equal(text.includes(leaked), false);
});

test('脱敏：成功与失败路径的 stdout、stderr 都不含 Key、认证头、主页链接或幂等键', async () => {
  const privateUrl = 'https://www.tiktok.com/@very-private-handle';
  const input = { idempotency_key: 'internal-intent-key-777', items: [{ platform: 'tiktok', profile_url: privateUrl }] };
  const successRun = await run('submit', ['--input-file', writeInput(input)], reply(202, ok(batchView())));
  const failureRun = await run('submit', ['--input-file', writeInput(input)], reply(500, fail(500, 'Internal server error')));
  for (const result of [successRun, failureRun]) {
    const text = [...result.out, ...result.err].join('\n');
    for (const leaked of [SECRET, 'X-API-Key', 'Authorization']) assert.equal(text.includes(leaked), false);
  }
  const failureText = failureRun.err.join('\n');
  assert.equal(failureText.includes(privateUrl) || failureText.includes('internal-intent-key-777'), false);
});

test('本地异常只输出通用信息', async () => {
  const boom = { execute: async () => { throw new Error(`disk path C:\\private\\${SECRET}`); } };
  const err = [];
  const code = await cli.runCli('get_batch', { args: [json({ batch_id: BATCH })], client: boom, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// 入口脚本
// ---------------------------------------------------------------------------------------------
const entries = {
  options: {}, submit: submitInput, list_batches: {}, get_batch: { batch_id: BATCH }, list_items: { batch_id: BATCH },
  get_item: { batch_id: BATCH, item_id: ITEM }, retry: { batch_id: BATCH, item_id: ITEM },
};
for (const [operation, input] of Object.entries(entries)) {
  test(`入口脚本 profile_tagging_${operation}.mjs：语法正确，main 路由到对应操作`, async () => {
    const file = join(scripts, `profile_tagging_${operation}.mjs`);
    assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
    const mod = await load(`profile_tagging_${operation}.mjs`);
    const rec = recorder(reply(lib.operations[operation].status, ok(okFor(operation))));
    const code = await mod.main({ args: [json(input)], client: make(rec.transport), stdout: () => {}, stderr: () => {} });
    assert.equal(code, 0);
    assert.equal(pathOf(rec.calls[0]), lib.operations[operation].path);
    assert.equal(typeof mod.prepareRequest, 'function');
  });

  test(`入口脚本 profile_tagging_${operation}.mjs：作为进程运行时缺少 Key 在本地失败，不联网`, () => {
    const result = spawnSync(process.execPath, [join(scripts, `profile_tagging_${operation}.mjs`), '--input-file', writeInput(input)], {
      env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.kind, 'configuration');
    assert.ok(result.stderr.includes('SCOUT_API_KEY 未配置'));
  });
}

test('七个操作与七个入口脚本一一对应，且不含硬编码的地址、Key 或 Authorization 头', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
  const files = readdirSync(scripts).filter(name => name.includes('profile_tagging'));
  assert.equal(files.length, 9);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s/i.test(source), false, name);
  }
});
