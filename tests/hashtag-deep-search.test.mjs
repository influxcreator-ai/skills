// Isolated tests for the Hashtag deep search scripts. No real network, backend or key is used:
// every request goes through an injected transport, and global fetch is replaced with a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('real network is blocked in isolated tests'); };

const scripts = resolve(fileURLToPath(new URL('..', import.meta.url)), 'influx-ai', 'scripts');
const load = name => import(pathToFileURL(join(scripts, name)).href);
const lib = await load('_hashtag_deep_search_client.mjs');
const cli = await load('_hashtag_deep_search_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
const ID = '00000000-0000-0000-0000-000000000042';
const NEXT_ID = '00000000-0000-0000-0000-000000000043';
const KEY = '00000000-0000-0000-0000-000000000009';
const NOW = '2026-11-13T00:00:00Z';

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const view = (over = {}) => ({
  id: ID, target_count: 50, search_round: 0, total_terms: 0, previous_task_id: null, batch_no: 1, excluded_count: 0,
  can_search_next: false, query: 'coffee creator content', locale: 'zh', title: 'coffee creator content',
  status: 'queued', stage: 'queued', revision: 0, attempt_no: 1, max_attempts: 3, can_retry: false, current_term: null,
  plan: null, completed_terms: 0, raw_count: 0, unique_count: 0, truncated_count: 0, candidates: [], selected_candidate_ids: [],
  decisions: [], groups: [], error_code: null, created_at: NOW, updated_at: NOW, started_at: null, finished_at: null, ...over,
});
const candidate = (id, hashtag = `#tag${id}`) => ({ id, hashtag, similarity: 0.81, total_count: 1200, platform_counts: { instagram: 1, tiktok: 2, youtube: 3, twitter: 4 }, last_seen_month: '2026-10', source_terms: ['coffee'] });
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const pathOf = call => call.url.split('/').pop();

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return list[Math.min(calls.length - 1, list.length - 1)];
  };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createHashtagSearchClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });

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
const json = value => JSON.stringify(value);
const submitInput = { query: 'coffee creator content', locale: 'zh', target_count: 50, idempotency_key: KEY };

// ---------------------------------------------------------------------------------------------
// 请求构造与 Key 注入
// ---------------------------------------------------------------------------------------------
const cases = [
  ['submit', submitInput, 202, submitInput],
  ['get', { task_id: ID }, 200, { task_id: ID }],
  ['list', {}, 200, { page: 1, page_size: 20 }],
  ['list', { page: 2, page_size: 100 }, 200, { page: 2, page_size: 100 }],
  ['next', { task_id: ID }, 202, { task_id: ID }],
  ['retry', { task_id: ID }, 202, { task_id: ID }],
];
const okFor = operation => (operation === 'list' ? ok({ items: [], total: 0, page: 1, page_size: 20 }) : ok(view()));

for (const [operation, input, status, expectedBody] of cases) {
  test(`${operation}: 请求路径、方法、请求头和请求体符合契约`, async () => {
    const rec = recorder(reply(status, okFor(operation)));
    const result = await make(rec.transport).execute(operation, input);
    assert.equal(rec.calls.length, 1);
    const [call] = rec.calls;
    assert.equal(call.url, `https://scout.example.com/openapi/v1/hashtag-deep-search/tasks/${operation}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, expectedBody);
    for (const forbidden of ['jwt', 'user_id', 'team_id', 'token', 'api_key']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('submit: 未指定 locale 和 target_count 时不替服务端填默认值', async () => {
  const rec = recorder(reply(202, ok(view())));
  await make(rec.transport).execute('submit', { query: 'coffee creator content', idempotency_key: KEY });
  assert.deepEqual(rec.calls[0].body, { query: 'coffee creator content', idempotency_key: KEY });
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [
    ['https://scout.example.com', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/openapi', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/openapi/', 'https://scout.example.com/openapi'],
    ['https://scout.example.com/api', 'https://scout.example.com/api/openapi'],
  ]) {
    const rec = recorder(reply(200, ok(view())));
    await lib.createHashtagSearchClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('get', { task_id: ID });
    assert.equal(rec.calls[0].url, `${expected}/v1/hashtag-deep-search/tasks/get`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  const rec = recorder(reply(200, ok(view())));
  for (const options of [
    { baseUrl: 'https://scout.example.com' },
    { baseUrl: 'https://scout.example.com', apiKey: '   ' },
    { baseUrl: 'not a url', apiKey: SECRET },
    { apiKey: SECRET },
    { baseUrl: 'https://user:pass@scout.example.com', apiKey: SECRET },
    { baseUrl: 'https://scout.example.com/?x=1', apiKey: SECRET },
    { baseUrl: 'ftp://scout.example.com', apiKey: SECRET },
  ]) assert.throws(() => lib.createHashtagSearchClient({ ...options, transport: rec.transport }), error => error.kind === 'configuration');
  assert.equal(rec.calls.length, 0);
});

test('Key 前后的空白会被去掉再注入请求头', async () => {
  const rec = recorder(reply(200, ok(view())));
  await lib.createHashtagSearchClient({ baseUrl: 'https://scout.example.com', apiKey: `  ${SECRET}\n`, transport: rec.transport }).execute('get', { task_id: ID });
  assert.equal(rec.calls[0].init.headers['X-API-Key'], SECRET);
});

// ---------------------------------------------------------------------------------------------
// 输入校验：非法输入在本地失败，不发请求
// ---------------------------------------------------------------------------------------------
const rejected = [
  ['submit', { ...submitInput, extra: 1 }, '未开放字段'],
  ['submit', { query: 'coffee creator content' }, '缺少 idempotency_key'],
  ['submit', { ...submitInput, idempotency_key: 'not-a-uuid' }, 'idempotency_key 非 UUID'],
  ['submit', { ...submitInput, idempotency_key: null }, 'idempotency_key 为 null'],
  ['submit', { ...submitInput, query: 'abcd' }, 'query 只有 4 个字符'],
  ['submit', { ...submitInput, query: '  abcd  ' }, 'query 去空白后只有 4 个字符'],
  ['submit', { ...submitInput, query: 'a'.repeat(4001) }, 'query 超过 4000 个字符'],
  ['submit', { ...submitInput, query: 12345 }, 'query 不是文本'],
  ['submit', { ...submitInput, query: 'coffee \ud800 content' }, 'query 含无效 Unicode'],
  ['submit', { ...submitInput, locale: 'fr' }, 'locale 不在枚举内'],
  ['submit', { ...submitInput, locale: null }, 'locale 为 null'],
  ['submit', { ...submitInput, target_count: 0 }, 'target_count 为 0'],
  ['submit', { ...submitInput, target_count: 301 }, 'target_count 超过 300'],
  ['submit', { ...submitInput, target_count: '50' }, 'target_count 是字符串'],
  ['submit', { ...submitInput, target_count: 50.5 }, 'target_count 不是整数'],
  ['submit', { ...submitInput, target_count: null }, 'target_count 为 null'],
  ['submit', { ...submitInput, target_count: true }, 'target_count 是布尔值'],
  ['get', {}, '缺少 task_id'],
  ['get', { task_id: '42' }, 'task_id 非 UUID'],
  ['get', { task_id: ID, page: 1 }, 'get 带多余字段'],
  ['next', { task_id: ID, idempotency_key: KEY }, 'next 带 idempotency_key'],
  ['retry', { task_id: 42 }, 'task_id 是数字'],
  ['retry', [ID], '请求不是对象'],
  ['list', { page: 0 }, 'page 为 0'],
  ['list', { page_size: 0 }, 'page_size 为 0'],
  ['list', { page_size: 101 }, 'page_size 超过 100'],
  ['list', { page: null }, 'page 为 null'],
  ['list', { page_size: null }, 'page_size 为 null'],
  ['list', { page: 1.5 }, 'page 不是整数'],
  ['list', { status: 'failed' }, 'list 不接受筛选字段'],
];
for (const [operation, input, label] of rejected) {
  test(`${operation} 拒绝：${label}`, async () => {
    const rec = recorder(reply(200, okFor(operation)));
    await assert.rejects(make(rec.transport).execute(operation, input), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('submit 边界值通过：query 5 与 4000 个字符，target_count 1 与 300，locale en', async () => {
  for (const input of [
    { ...submitInput, query: 'abcde' },
    { ...submitInput, query: '  abcde  ' },
    { ...submitInput, query: '咖'.repeat(4000) },
    { ...submitInput, target_count: 1 },
    { ...submitInput, target_count: 300 },
    { ...submitInput, locale: 'en' },
  ]) {
    const rec = recorder(reply(202, ok(view())));
    await make(rec.transport).execute('submit', input);
    assert.equal(rec.calls.length, 1);
  }
});

// ---------------------------------------------------------------------------------------------
// 单层响应解析
// ---------------------------------------------------------------------------------------------
test('成功响应原样返回整个外壳，保留 request_id 和未知 meta 字段', async () => {
  const body = ok(view(), { request_id: 'req-keep', future_field: 'kept' });
  const result = await make(recorder(reply(200, body)).transport).execute('get', { task_id: ID });
  assert.deepEqual(result, body);
  assert.equal(result.meta.request_id, 'req-keep');
});

test('list 响应带分页 meta 并保持原样', async () => {
  const body = ok({ items: [{ id: ID, batch_no: 1, query: 'coffee creator content', title: 't', status: 'succeeded', stage: 'completed', created_at: NOW, updated_at: NOW }], total: 1, page: 1, page_size: 20 }, { page: 1, size: 20, total: 1 });
  const result = await make(recorder(reply(200, body)).transport).execute('list', {});
  assert.deepEqual(result, body);
  assert.deepEqual([result.meta.page, result.meta.size, result.meta.total], [1, 20, 1]);
});

const badEnvelopes = [
  ['submit 返回 200 而不是 202', 'submit', submitInput, reply(200, ok(view()))],
  ['get 返回 202 而不是 200', 'get', { task_id: ID }, reply(202, ok(view()))],
  ['next 返回 200 而不是 202', 'next', { task_id: ID }, reply(200, ok(view()))],
  ['success 为 true 但 error 非空', 'get', { task_id: ID }, reply(200, { ...ok(view()), error: { code: 1, message: 'x' } })],
  ['再包了一层 success/data', 'get', { task_id: ID }, reply(200, ok(ok(view())))],
  ['不是 JSON', 'get', { task_id: ID }, reply(200, '<html>bad gateway</html>')],
  ['缺少 meta', 'get', { task_id: ID }, reply(200, { success: true, data: view(), error: null })],
  ['credits_consumed 不是 null', 'get', { task_id: ID }, reply(200, ok(view(), { credits_consumed: 0 }))],
  ['billing_status 不是 null', 'get', { task_id: ID }, reply(200, ok(view(), { billing_status: 'settled' }))],
  ['billing_operation_id 不是 null', 'get', { task_id: ID }, reply(200, ok(view(), { billing_operation_id: 'op-1' }))],
  ['失败外壳的 data 非空', 'get', { task_id: ID }, reply(404, { ...fail(404, 'not_found'), data: view() })],
  ['失败外壳的 code 与 HTTP 不一致', 'get', { task_id: ID }, reply(404, { success: false, data: null, error: { code: 40400, message: 'not_found' }, meta: meta() })],
  ['失败外壳缺少 message', 'get', { task_id: ID }, reply(404, { success: false, data: null, error: { code: 40401 }, meta: meta() })],
  ['失败 HTTP 却声明 success', 'get', { task_id: ID }, reply(404, ok(view()))],
];
for (const [label, operation, input, response] of badEnvelopes) {
  test(`协议错误：${label}`, async () => {
    await assert.rejects(make(recorder(response).transport).execute(operation, input), error => error.kind === 'protocol');
  });
}

// ---------------------------------------------------------------------------------------------
// 任务状态与最终结果
// ---------------------------------------------------------------------------------------------
test('各任务状态与阶段组合都能解析', async () => {
  const states = [
    ['queued', 'queued'], ['running', 'planning'], ['running', 'retrieving'], ['running', 'reviewing'],
    ['running', 'organizing'], ['succeeded', 'completed'], ['failed', 'retrieving'], ['failed', 'organizing'],
  ];
  for (const [status, stage] of states) {
    const result = await make(recorder(reply(200, ok(view({ status, stage })))).transport).execute('get', { task_id: ID });
    assert.equal(result.data.status, status);
    assert.equal(result.data.stage, stage);
  }
});

test('succeeded 任务：selected_candidate_ids 与 candidates 原样保留，不被脚本筛选或改写', async () => {
  const data = view({
    status: 'succeeded', stage: 'completed', can_search_next: true, candidates: [candidate('1'), candidate('2'), candidate('3')],
    selected_candidate_ids: ['1', '3'], decisions: [{ candidate_id: '1', keep: true, reason: 'fit', group: 'g' }, { candidate_id: '2', keep: false, reason: 'off topic', group: null }],
    groups: [{ name: 'g', candidate_ids: ['1', '3'] }],
  });
  const run1 = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(200, ok(data)));
  const printed = JSON.parse(run1.out[0]);
  assert.deepEqual(printed.data.selected_candidate_ids, ['1', '3']);
  assert.equal(printed.data.candidates.length, 3);
  assert.deepEqual(printed, ok(data));
});

test('failed 任务保留错误码与 can_retry', async () => {
  const data = view({ status: 'failed', stage: 'retrieving', error_code: 'model_timeout', can_retry: true });
  const result = await make(recorder(reply(200, ok(data))).transport).execute('get', { task_id: ID });
  assert.equal(result.data.error_code, 'model_timeout');
  assert.equal(result.data.can_retry, true);
});

test('next 返回带 previous_task_id 与 batch_no 的新任务', async () => {
  const data = view({ id: NEXT_ID, previous_task_id: ID, batch_no: 2 });
  const result = await make(recorder(reply(202, ok(data))).transport).execute('next', { task_id: ID });
  assert.equal(result.data.id, NEXT_ID);
  assert.equal(result.data.previous_task_id, ID);
});

const badTasks = [
  ['未知 status', view({ status: 'done' })],
  ['未知 stage', view({ stage: 'finishing' })],
  ['未知 locale', view({ locale: 'fr' })],
  ['id 不是 UUID', view({ id: '42' })],
  ['缺少 query', { ...view(), query: undefined }],
  ['selected_candidate_ids 含非字符串', view({ selected_candidate_ids: [1] })],
  ['candidates 不是数组', view({ candidates: {} })],
  ['候选缺少 hashtag', view({ candidates: [{ id: '1', similarity: 0.5 }] })],
  ['候选 similarity 不是数字', view({ candidates: [{ ...candidate('1'), similarity: 'high' }] })],
  ['can_retry 不是布尔值', view({ can_retry: 'yes' })],
  ['attempt_no 为负数', view({ attempt_no: -1 })],
];
for (const [label, data] of badTasks) {
  test(`协议错误：任务视图 ${label}`, async () => {
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).execute('get', { task_id: ID }), error => error.kind === 'protocol');
  });
}

test('协议错误：list 响应不合规', async () => {
  const item = { id: ID, batch_no: 1, query: 'q', title: 't', status: 'queued', stage: 'queued', created_at: NOW, updated_at: NOW };
  for (const data of [
    { items: [{ ...item, title: undefined }], total: 1, page: 1, page_size: 20 },
    { items: [{ ...item, status: 'x' }], total: 1, page: 1, page_size: 20 },
    { items: [{ ...item, batch_no: 0 }], total: 1, page: 1, page_size: 20 },
    { items: [], total: -1, page: 1, page_size: 20 },
    { items: [], total: 0, page: 0, page_size: 20 },
    { items: [], total: 0, page: 1, page_size: 101 },
    { items: {}, total: 0, page: 1, page_size: 20 },
  ]) await assert.rejects(make(recorder(reply(200, ok(data))).transport).execute('list', {}), error => error.kind === 'protocol');
});

// ---------------------------------------------------------------------------------------------
// CLI 输入与输出
// ---------------------------------------------------------------------------------------------
const tempDir = mkdtempSync(join(tmpdir(), 'hashtag-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;
function writeInput(value, { bom = false } = {}) {
  const path = join(tempDir, `input-${fileCounter++}.json`);
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${typeof value === 'string' ? value : json(value)}`);
  return path;
}

test('CLI：stdout 只有一层完整 JSON 外壳；submit、next、retry 在 stderr 提示 202 仅表示受理', async () => {
  for (const [operation, input, note] of [['submit', submitInput, '保留 data.id'], ['next', { task_id: ID }, '新任务 ID'], ['retry', { task_id: ID }, '同一任务 ID']]) {
    const result = await run(operation, ['--input-file', writeInput(input)], reply(202, ok(view())));
    assert.equal(result.code, 0);
    assert.equal(result.out.length, 1);
    assert.deepEqual(JSON.parse(result.out[0]), ok(view()));
    assert.ok(result.err[0].includes('202 仅表示已受理'));
    assert.ok(result.err[0].includes(note));
  }
  for (const [operation, input] of [['get', { task_id: ID }], ['list', {}]]) {
    const result = await run(operation, ['--input-file', writeInput(input)], reply(200, okFor(operation)));
    assert.equal(result.code, 0);
    assert.deepEqual(result.err, []);
  }
});

test('CLI：支持内联 JSON、--input-file 和带 BOM 的文件', async () => {
  const inline = await run('get', [json({ task_id: ID })], reply(200, ok(view())));
  const file = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(200, ok(view())));
  const bom = await run('get', ['--input-file', writeInput({ task_id: ID }, { bom: true })], reply(200, ok(view())));
  for (const result of [inline, file, bom]) { assert.equal(result.code, 0); assert.equal(result.calls[0].body.task_id, ID); }
});

test('CLI：调用方式错误返回 1 且不发请求', async () => {
  const file = writeInput({ task_id: ID });
  for (const args of [
    [], [json({ task_id: ID }), '--input-file', file], ['--input-file'], ['--input-file', join(tempDir, 'missing.json')],
    ['{not json'], ['--unknown'], ['--input-file', file, '--input-file', file], [json({ task_id: ID }), json({ task_id: ID })],
  ]) {
    const result = await run('get', args, reply(200, ok(view())));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
    assert.equal(result.diagnostic.error.kind, 'input');
  }
});

test('CLI：输入错误不回显账号、查询文本或本地路径', async () => {
  const query = 'private secret coffee plan';
  const file = writeInput({ query, idempotency_key: 'bad' });
  const result = await run('submit', ['--input-file', file], reply(202, ok(view())));
  assert.equal(result.code, 1);
  const text = result.err.join('\n');
  assert.equal(text.includes(query) || text.includes(file), false);
  const missing = await run('submit', ['--input-file', join(tempDir, 'nope.json')], reply(202, ok(view())));
  assert.equal(missing.err.join('\n').includes(tempDir), false);
});

// ---------------------------------------------------------------------------------------------
// 轮询预算：只轮询 get
// ---------------------------------------------------------------------------------------------
test('轮询参数固定为每 2 秒一次、最多 30 次', () => {
  assert.equal(cli.WAIT_INTERVAL_MS, 2000);
  assert.equal(cli.WAIT_MAX_ATTEMPTS, 30);
});

test('get --wait：到达 succeeded 立即停止，间隔 2 秒，退出码 0', async () => {
  const responses = [
    reply(200, ok(view({ status: 'queued' }))),
    reply(200, ok(view({ status: 'running', stage: 'retrieving' }))),
    reply(200, ok(view({ status: 'succeeded', stage: 'completed', selected_candidate_ids: ['1'], candidates: [candidate('1')] }))),
    reply(200, ok(view({ status: 'failed' }))),
  ];
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], responses);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.sleeps, [2000, 2000]);
  assert.equal(result.out.length, 1);
  assert.equal(JSON.parse(result.out[0]).data.status, 'succeeded');
  assert.deepEqual(result.err, []);
});

test('get --wait：failed 也是终态，立即停止，退出码 0，保留错误码', async () => {
  const failed = view({ status: 'failed', stage: 'retrieving', error_code: 'task_timeout', can_retry: true });
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], [reply(200, ok(view({ status: 'running' }))), reply(200, ok(failed))]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 2);
  assert.equal(JSON.parse(result.out[0]).data.error_code, 'task_timeout');
});

test('get --wait：首次就是终态时不等待', async () => {
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], reply(200, ok(view({ status: 'succeeded', stage: 'completed' }))));
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.sleeps, []);
});

test('get --wait：预算用完仍在执行，共 30 次查询、29 次等待，退出码 2，交付任务 ID、状态和后续查询方式', async () => {
  const running = view({ status: 'running', stage: 'reviewing' });
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], reply(200, ok(running)));
  assert.equal(result.code, 2);
  assert.equal(result.calls.length, 30);
  assert.equal(result.sleeps.length, 29);
  assert.ok(result.sleeps.every(ms => ms === 2000));
  assert.deepEqual(JSON.parse(result.out[0]).data, running);
  assert.equal(result.diagnostic.wait.task_id, ID);
  assert.equal(result.diagnostic.wait.status, 'running');
  assert.equal(result.diagnostic.wait.stage, 'reviewing');
  assert.equal(result.diagnostic.wait.attempts, 30);
  assert.ok(result.diagnostic.wait.message.includes('get'));
  assert.ok(result.diagnostic.wait.message.includes('不要重新提交'));
});

test('get --wait：整个等待期间只访问 get，且每次都是同一个 task_id', async () => {
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], reply(200, ok(view({ status: 'succeeded', stage: 'completed', can_search_next: true, can_retry: true }))));
  assert.equal(result.code, 0);
  const rec = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], reply(200, ok(view({ status: 'running' }))), { cli: { maxAttempts: 5 } });
  assert.equal(rec.calls.length, 5);
  assert.ok(rec.calls.every(call => pathOf(call) === 'get' && call.body.task_id === ID && Object.keys(call.body).length === 1));
});

test('get --wait：等待中遇到错误立即停止，不再查询也不再等待', async () => {
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], [
    reply(200, ok(view({ status: 'running' }))),
    reply(503, fail(503, 'unavailable', { request_id: 'req-503' })),
    reply(200, ok(view({ status: 'succeeded', stage: 'completed' }))),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.sleeps.length, 1);
  assert.deepEqual(result.out, []);
  assert.equal(result.diagnostic.error.status, 503);
  assert.equal(result.diagnostic.error.request_id, 'req-503');
});

test('get --wait：等待中遇到 429 按 Retry-After 提示，不自动再查', async () => {
  const result = await run('get', ['--wait', '--input-file', writeInput({ task_id: ID })], [
    reply(200, ok(view({ status: 'running' }))),
    reply(429, fail(429, 'Too many requests'), { 'Retry-After': '30' }),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.diagnostic.error.retry_after, '30');
});

test('get 不带 --wait 只查询一次', async () => {
  const result = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(200, ok(view({ status: 'running' }))));
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.sleeps, []);
});

test('--wait 只允许用于 get：submit、next、retry、list 带 --wait 会被拒绝且不发请求', async () => {
  for (const [operation, input] of [['submit', submitInput], ['next', { task_id: ID }], ['retry', { task_id: ID }], ['list', {}]]) {
    const result = await run(operation, ['--wait', '--input-file', writeInput(input)], reply(202, ok(view())));
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.ok(result.diagnostic.error.message.includes('不会自动轮询'));
  }
});

// ---------------------------------------------------------------------------------------------
// next / retry 必须显式调用
// ---------------------------------------------------------------------------------------------
test('即使任务提示 can_search_next 或 can_retry，脚本也不会自动调用 next、retry 或 submit', async () => {
  for (const hint of [
    { status: 'succeeded', stage: 'completed', can_search_next: true },
    { status: 'failed', stage: 'retrieving', can_retry: true, error_code: 'model_timeout' },
  ]) {
    for (const args of [['--wait'], []]) {
      const result = await run('get', [...args, '--input-file', writeInput({ task_id: ID })], reply(200, ok(view(hint))));
      assert.equal(result.code, 0);
      assert.deepEqual(result.calls.map(pathOf), ['get']);
    }
  }
});

test('next：只在被调用时发一次请求，返回新任务 ID；后续查询使用新 ID', async () => {
  const next = await run('next', ['--input-file', writeInput({ task_id: ID })], reply(202, ok(view({ id: NEXT_ID, previous_task_id: ID, batch_no: 2 }))));
  assert.equal(next.code, 0);
  assert.deepEqual(next.calls.map(pathOf), ['next']);
  assert.deepEqual(next.calls[0].body, { task_id: ID });
  const newId = JSON.parse(next.out[0]).data.id;
  assert.equal(newId, NEXT_ID);
  const follow = await run('get', ['--wait', '--input-file', writeInput({ task_id: newId })], reply(200, ok(view({ id: NEXT_ID, status: 'succeeded', stage: 'completed', batch_no: 2 }))));
  assert.equal(follow.calls[0].body.task_id, NEXT_ID);
});

test('retry：只在被调用时发一次请求，返回同一任务的新尝试', async () => {
  const result = await run('retry', ['--input-file', writeInput({ task_id: ID })], reply(202, ok(view({ attempt_no: 2 }))));
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map(pathOf), ['retry']);
  assert.equal(JSON.parse(result.out[0]).data.attempt_no, 2);
});

test('next / retry 被服务端拒绝时不自动换操作、不重试', async () => {
  for (const [operation, message] of [['next', 'next_batch_unavailable'], ['retry', 'retry_unavailable']]) {
    const result = await run(operation, ['--input-file', writeInput({ task_id: ID })], reply(409, fail(409, message)));
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.status, 409);
    assert.equal(result.diagnostic.error.code, 40901);
    assert.equal(result.diagnostic.error.reason, message);
    assert.equal(result.diagnostic.error.outcome, 'rejected');
  }
});

// ---------------------------------------------------------------------------------------------
// submit 的幂等键与超时：不自动重发、不换键
// ---------------------------------------------------------------------------------------------
test('submit 超时：只发一次请求，结果标为未知，不自动重发', async () => {
  const calls = [];
  const transport = (url, init) => { calls.push(JSON.parse(init.body)); return new Promise(() => {}); };
  const out = [];
  const err = [];
  const code = await cli.runCli('submit', { args: ['--input-file', writeInput(submitInput)], client: make(transport, { timeoutMs: 20 }), stdout: v => out.push(v), stderr: v => err.push(v) });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotency_key, KEY);
  const diagnostic = JSON.parse(err.at(-1)).error;
  assert.equal(diagnostic.kind, 'timeout');
  assert.equal(diagnostic.outcome, 'unknown');
  assert.ok(diagnostic.message.includes('不自动重发'));
  assert.deepEqual(out, []);
});

test('get 超时：读操作标为 unavailable，而不是未知', async () => {
  const client = make(() => new Promise(() => {}), { timeoutMs: 20 });
  await assert.rejects(client.execute('get', { task_id: ID }), error => error.kind === 'timeout' && error.outcome === 'unavailable');
});

test('submit 网络中断：结果未知，不重发，错误中不含 Key 与原始异常', async () => {
  let attempts = 0;
  const transport = async () => { attempts++; throw new Error(`socket hang up near ${SECRET}`); };
  const out = [];
  const err = [];
  const code = await cli.runCli('submit', { args: ['--input-file', writeInput(submitInput)], client: make(transport), stdout: v => out.push(v), stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.equal(attempts, 1);
  const text = err.join('\n');
  assert.equal(text.includes(SECRET) || text.includes('socket hang up'), false);
  const diagnostic = JSON.parse(err.at(-1)).error;
  assert.equal(diagnostic.kind, 'network');
  assert.equal(diagnostic.outcome, 'unknown');
});

test('submit 的 5xx 与无效响应：结果未知；4xx：已被拒绝；读操作的 5xx：被拒绝', async () => {
  for (const [response, expected] of [
    [reply(500, fail(500, 'Internal server error')), 'unknown'],
    [reply(503, fail(503, 'unavailable')), 'unknown'],
    [reply(202, '{"garbage":true}'), 'unknown'],
    [reply(202, ok(view({ status: 'bogus' }))), 'unknown'],
    [reply(409, fail(409, 'idempotency_conflict')), 'rejected'],
    [reply(422, fail(422, 'query: too short')), 'rejected'],
    [reply(400, fail(400, 'target_count_unavailable')), 'rejected'],
  ]) {
    const result = await run('submit', ['--input-file', writeInput(submitInput)], response);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.outcome, expected);
  }
  const read = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(503, fail(503, 'unavailable')));
  assert.equal(read.diagnostic.error.outcome, 'rejected');
});

test('submit 同键不同需求被拒绝（409）：保留原键，不换键重发', async () => {
  const result = await run('submit', ['--input-file', writeInput({ ...submitInput, query: 'a different research request' })], reply(409, fail(409, 'idempotency_conflict')));
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].body.idempotency_key, KEY);
  assert.equal(result.diagnostic.error.reason, 'idempotency_conflict');
});

// ---------------------------------------------------------------------------------------------
// 错误码、限流与脱敏
// ---------------------------------------------------------------------------------------------
const errorTable = [
  [400, 'target_count_unavailable', 'target_count_unavailable'],
  [401, 'Invalid API key', undefined],
  [403, 'Forbidden', undefined],
  [404, 'not_found', 'not_found'],
  [409, 'idempotency_conflict', 'idempotency_conflict'],
  [409, 'next_batch_unavailable', 'next_batch_unavailable'],
  [409, 'retry_unavailable', 'retry_unavailable'],
  [413, 'payload_too_large', 'payload_too_large'],
  [422, 'body.query: String should have at least 5 characters', undefined],
  [429, 'Too many requests', undefined],
  [500, 'Internal server error', undefined],
  [503, 'unavailable', 'unavailable'],
];
for (const [status, message, reason] of errorTable) {
  test(`错误 HTTP ${status}（${message}）：外层 code 为 ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(status, fail(status, message, { request_id: 'req-err' })));
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
  const result = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(503, fail(503, 'unavailable'), { 'Retry-After': '30' }));
  assert.equal('retry_after' in result.diagnostic.error, false);
});

test('脱敏：request_id 里的 Key 被隐藏，服务端自由文本和异常堆栈不进入输出', async () => {
  const result = await run('get', ['--input-file', writeInput({ task_id: ID })], reply(500, fail(500, 'Traceback (most recent call last): secret db password=hunter2', { request_id: `id-${SECRET}-end` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2']) assert.equal(text.includes(leaked), false);
});

test('脱敏：成功与失败路径的 stdout、stderr 都不含 Key、认证头或查询文本', async () => {
  const query = 'confidential launch plan for new roast';
  const successRun = await run('submit', ['--input-file', writeInput({ ...submitInput, query })], reply(202, ok(view({ query: 'redacted' }))));
  const failureRun = await run('submit', ['--input-file', writeInput({ ...submitInput, query })], reply(500, fail(500, 'Internal server error')));
  for (const result of [successRun, failureRun]) {
    const text = [...result.out, ...result.err].join('\n');
    for (const leaked of [SECRET, 'X-API-Key', 'Authorization']) assert.equal(text.includes(leaked), false);
  }
  assert.equal(failureRun.err.join('\n').includes(query), false);
});

test('本地异常只输出通用信息', async () => {
  const boom = { execute: async () => { throw new Error(`disk path C:\\private\\${SECRET}`); } };
  const err = [];
  const code = await cli.runCli('get', { args: [json({ task_id: ID })], client: boom, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// 入口脚本
// ---------------------------------------------------------------------------------------------
const entries = { submit: submitInput, get: { task_id: ID }, list: {}, next: { task_id: ID }, retry: { task_id: ID } };
for (const [operation, input] of Object.entries(entries)) {
  test(`入口脚本 hashtag_deep_search_${operation}.mjs：语法正确，main 路由到对应操作`, async () => {
    const file = join(scripts, `hashtag_deep_search_${operation}.mjs`);
    assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
    const mod = await load(`hashtag_deep_search_${operation}.mjs`);
    const rec = recorder(reply(lib.operations[operation].status, okFor(operation)));
    const out = [];
    const code = await mod.main({ args: [json(input)], client: make(rec.transport), stdout: v => out.push(v), stderr: () => {} });
    assert.equal(code, 0);
    assert.equal(pathOf(rec.calls[0]), operation);
    assert.equal(typeof mod.prepareRequest, 'function');
  });

  test(`入口脚本 hashtag_deep_search_${operation}.mjs：作为进程运行时缺少 Key 在本地失败，不联网`, () => {
    const result = spawnSync(process.execPath, [join(scripts, `hashtag_deep_search_${operation}.mjs`), '--input-file', writeInput(input)], {
      env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.kind, 'configuration');
    assert.ok(result.stderr.includes('SCOUT_API_KEY 未配置'));
  });
}

test('scripts 目录内的 Hashtag 脚本不含硬编码的地址、Key 或 Authorization 头', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(scripts).filter(name => name.includes('hashtag_deep_search'));
  assert.equal(files.length, 7);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s/i.test(source), false, name);
  }
});
