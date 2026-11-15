// Isolated tests for the realtime collection scripts. No real network, backend, collection or key is used:
// every request goes through an injected transport, and global fetch is replaced with a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('real network is blocked in isolated tests'); };

const scripts = resolve(fileURLToPath(new URL('..', import.meta.url)), 'influx-ai', 'scripts');
const load = name => import(pathToFileURL(join(scripts, name)).href);
const lib = await load('_realtime_collection_client.mjs');
const cli = await load('_realtime_collection_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
const TASK = 'collection_demo_0001';
const LINK = 'https://www.youtube.com/@demo_channel';
const PREFIX = '/v1/realtime-collection/tasks';

// Original four operations keep default meta (credits_consumed 0); the five managed ones return null billing fields.
const legacyMeta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: 0, billing_status: null, billing_operation_id: null, ...extra });
const managedMeta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const metaFor = operation => (lib.operations[operation].managed ? managedMeta : legacyMeta);
const ok = (operation, data, extra) => ({ success: true, data, error: null, meta: metaFor(operation)(extra) });
const fail = (operation, status, message, extra, code = status * 100 + 1) => ({ success: false, data: null, error: { code, message }, meta: metaFor(operation)(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const pathOf = call => call.url.split('/openapi')[1];

const view = (over = {}) => ({
  task_id: TASK, status: 'aborted', platform: 'youtube', task_type: 'link_batch', total_count: 1, submit_count: 1, success_count: 0, fail_count: 0,
  invalid_count: 0, progress: '0%', fail_rate: 0, fail_list: [], invalid_list: [], created_at: '2026-11-13 08:00:00', updated_at: '2026-11-13 08:05:00', ...over,
});
const submitted = { task_id: TASK, status: 'submitted', message: '已提交 1 个达人链接的采集任务', total_count: 1 };
const entries = {
  submit: [{ task_type: 'LINK_BATCH', platform: 'youtube', values: [LINK] }, '/submit', submitted],
  keyword_submit: [{ platform: 'tiktok', keywords: ['skincare'] }, '/keyword-submit', { ...submitted, message: '已提交 1 个关键词的采集任务' }],
  status: [{ task_id: TASK }, '/status', { task_id: TASK, status: 'processing', total: 1, completed: 0, failed: 0, progress: 0 }],
  data: [{ task_id: TASK, page: 1, size: 20 }, '/data', { columns_config: ['Username', 'Followers'], items: [{ values: ['demo_channel', 1200] }], total: 1, page: 1, size: 20 }],
  columns: [{ task_type: 'link_batch', platform: 'youtube' }, '/columns', { columns: ['Username', 'Followers'] }],
  steps: [{ task_id: TASK }, '/steps', { task_id: TASK, steps: [{ step_name: 'task_created', step_order: 1, status: 'completed', started_at: '2026-11-13 08:00:00', ended_at: '2026-11-13 08:00:01', duration_seconds: 1.2 }], total_duration_seconds: 1.2 }],
  download: [{ task_id: TASK }, '/download', { columns_config: ['Username', 'Followers'], items: [['demo_channel', 1200]], total: 1 }],
  abort: [{ task_id: TASK }, '/abort', view()],
  retry: [{ task_id: TASK }, '/retry', view({ status: 'crawl_processing' })],
};
const okFor = operation => entries[operation][2];

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createRealtimeCollectionClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'realtime-collection-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;
const json = value => JSON.stringify(value);
function writeInput(value, { bom = false } = {}) {
  const path = join(tempDir, `input-${fileCounter++}.json`);
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${typeof value === 'string' ? value : json(value)}`);
  return path;
}
const outPath = () => join(tempDir, `out-${fileCounter++}.json`);
async function run(operation, args, responses) {
  const rec = recorder(responses);
  const out = [];
  const err = [];
  const code = await cli.runCli(operation, { args, client: make(rec.transport), stdout: v => out.push(v), stderr: v => err.push(v) });
  const last = err.at(-1);
  return { code, out, err, calls: rec.calls, diagnostic: last?.startsWith('{') ? JSON.parse(last) : null };
}
const argsFor = (operation, input = entries[operation][0]) => (operation === 'download' ? ['--input-file', writeInput(input), '--output', outPath()] : ['--input-file', writeInput(input)]);

// ---------------------------------------------------------------------------------------------
// 请求构造与 Key 注入
// ---------------------------------------------------------------------------------------------
test('九个操作与九个入口脚本一一对应；原四项与新五项分组正确', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => !v.managed).map(([k]) => k).sort(), ['data', 'keyword_submit', 'status', 'submit']);
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => v.executes).map(([k]) => k).sort(), ['abort', 'keyword_submit', 'retry', 'submit']);
});

for (const [operation, [input, path, data]] of Object.entries(entries)) {
  test(`${operation}: 路径、方法、请求头、请求体原样发送，成功 HTTP 200`, async () => {
    const rec = recorder(reply(200, ok(operation, data)));
    const result = await make(rec.transport).execute(operation, input);
    const [call] = rec.calls;
    assert.equal(rec.calls.length, 1);
    assert.equal(call.url, `https://scout.example.com/openapi${PREFIX}${path}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, input);
    for (const forbidden of ['user_id', 'team_id', 'jwt', 'api_key', 'force']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('不替服务端补默认值：data 不补分页，columns / download 不补 locale，keyword_submit 不补时间窗口', async () => {
  for (const [operation, input] of [['data', { task_id: TASK }], ['columns', { task_type: 'keyword', platform: 'tiktok' }], ['download', { task_id: TASK }], ['keyword_submit', { platform: 'youtube', keywords: ['tech'] }]]) {
    const rec = recorder(reply(200, ok(operation, okFor(operation))));
    await make(rec.transport).execute(operation, input);
    assert.deepEqual(rec.calls[0].body, input, operation);
  }
});

test('submit：四种大写任务类型、可选字段原样发送；本地不去重、不改写 values', async () => {
  const values = [LINK, LINK, 'demo_user'];
  for (const task_type of lib.SUBMIT_TASK_TYPES) {
    const input = { task_type, platform: 'tiktok', values, task_name: '演示任务', webhook_url: 'https://hooks.example.com/collection' };
    if (task_type === 'CREATOR_VIDEO') Object.assign(input, { start_time: 1760000000, end_time: 1762600000 });
    const rec = recorder(reply(200, ok('submit', submitted)));
    await make(rec.transport).execute('submit', input);
    assert.deepEqual(rec.calls[0].body, input, task_type);
  }
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['http://127.0.0.1:8010/openapi', 'http://127.0.0.1:8010/openapi'], ['https://scout.example.com/api/', 'https://scout.example.com/api/openapi']]) {
    const rec = recorder(reply(200, ok('status', okFor('status'))));
    await lib.createRealtimeCollectionClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('status', { task_id: TASK });
    assert.equal(rec.calls[0].url, `${expected}${PREFIX}/status`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: ' ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'ftp://x', apiKey: SECRET }, { baseUrl: 'https://scout.example.com?x=1', apiKey: SECRET }]) {
    assert.throws(() => lib.createRealtimeCollectionClient(options), error => error.kind === 'configuration');
  }
});

// ---------------------------------------------------------------------------------------------
// 请求校验：在发请求前拒绝
// ---------------------------------------------------------------------------------------------
const rejects = [
  ['submit', { ...entries.submit[0], user_id: 'u1' }, '未开放字段'],
  ['submit', { ...entries.submit[0], task_type: 'link_batch' }, '小写任务类型'],
  ['submit', { ...entries.submit[0], task_type: 'KEYWORD' }, '关键词不走 submit'],
  ['submit', { ...entries.submit[0], platform: 'facebook' }, '未知平台'],
  ['submit', { task_type: 'CREATOR_VIDEO', platform: 'twitter', values: [LINK] }, 'twitter 达人视频'],
  ['submit', { task_type: 'POST_VIDEO', platform: 'twitter', values: [LINK] }, 'twitter 作品视频'],
  ['submit', { ...entries.submit[0], values: [] }, '空 values'],
  ['submit', { ...entries.submit[0], values: Array.from({ length: 201 }, (_, i) => `user_${i}`) }, '201 项'],
  ['submit', { ...entries.submit[0], values: [' '] }, '空白项'],
  ['submit', { ...entries.submit[0], values: [1] }, '非文本项'],
  ['submit', { ...entries.submit[0], values: LINK }, 'values 不是数组'],
  ['submit', { ...entries.submit[0], start_time: 1760000000 }, '非 CREATOR_VIDEO 带时间'],
  ['submit', { task_type: 'CREATOR_VIDEO', platform: 'youtube', values: [LINK], start_time: 1760000000000 }, '毫秒时间戳'],
  ['submit', { task_type: 'CREATOR_VIDEO', platform: 'youtube', values: [LINK], start_time: 1762600000, end_time: 1760000000 }, '开始晚于结束'],
  ['submit', { task_type: 'CREATOR_VIDEO', platform: 'youtube', values: [LINK], start_time: '1760000000' }, '字符串时间戳'],
  ['submit', { ...entries.submit[0], webhook_url: 'http://hooks.example.com/x' }, 'HTTP 回调'],
  ['submit', { ...entries.submit[0], webhook_url: 'not a url' }, '非法回调'],
  ['submit', { ...entries.submit[0], task_name: 123 }, '非文本名称'],
  ['keyword_submit', { platform: 'tiktok', keywords: [] }, '空关键词'],
  ['keyword_submit', { platform: 'tiktok', keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }, '11 个关键词'],
  ['keyword_submit', { platform: 'tiktok', keywords: ['a'], need_kol_info: true }, '未开放的 need_kol_info'],
  ['keyword_submit', { platform: 'tiktok', keywords: ['a'], start_time: -1 }, '负时间戳'],
  ['status', {}, '缺 task_id'],
  ['status', { task_id: '' }, '空 task_id'],
  ['status', { task_id: 42 }, '数字 task_id'],
  ['status', { task_id: 'x'.repeat(201) }, '过长 task_id'],
  ['status', { task_id: 'a\nb' }, '控制字符'],
  ['data', { task_id: TASK, page: 0 }, 'page 0'],
  ['data', { task_id: TASK, size: 101 }, 'size 101'],
  ['data', { task_id: TASK, size: null }, 'size null'],
  ['data', { task_id: TASK, is_matched_video: 'true' }, '字符串布尔'],
  ['columns', { task_type: 'LINK_BATCH', platform: 'youtube' }, '大写 columns 类型'],
  ['columns', { task_type: 'link_batch', platform: 'youtube', locale: 'fr' }, '未知语言'],
  ['columns', { task_type: 'link_batch' }, '缺平台'],
  ['download', { task_id: TASK, column_keys: 'k'.repeat(4001) }, 'column_keys 过长'],
  ['download', { task_id: TASK, column_keys: ['a'] }, 'column_keys 数组'],
  ['download', { task_id: TASK, page: 1 }, 'download 不分页'],
  ['steps', { task_id: TASK, page: 1 }, 'steps 额外字段'],
  ['abort', { task_id: TASK, force: true }, 'abort 额外字段'],
  ['retry', { task_id: TASK, force: true }, '不开放强制重试'],
  ['retry', [TASK], '数组请求'],
];
for (const [operation, input, label] of rejects) {
  test(`输入校验 ${operation}：${label} 在本地拒绝且不发请求`, async () => {
    const rec = recorder(reply(200, ok(operation, okFor(operation))));
    await assert.rejects(make(rec.transport).execute(operation, input), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('边界值放行：200 项 values、10 个关键词、size 100、column_keys 4000 字符、task_id 200 字符、is_matched_video 为 null', async () => {
  const cases = [
    ['submit', { task_type: 'FILE_UPLOAD', platform: 'instagram', values: Array.from({ length: 200 }, (_, i) => `user_${i}`) }],
    ['keyword_submit', { platform: 'twitter', keywords: Array.from({ length: 10 }, (_, i) => `k${i}`), start_time: 0, end_time: 9999999999 }],
    ['data', { task_id: TASK, page: 3, size: 100, is_matched_video: null }],
    ['download', { task_id: TASK, locale: 'zh', is_matched_video: false, column_keys: 'k'.repeat(4000) }],
    ['steps', { task_id: 'x'.repeat(200) }],
  ];
  for (const [operation, input] of cases) {
    const data = operation === 'steps' ? { ...okFor('steps'), task_id: input.task_id } : okFor(operation);
    const rec = recorder(reply(200, ok(operation, data)));
    await make(rec.transport).execute(operation, input);
    assert.equal(rec.calls.length, 1, operation);
  }
});

test('64 KiB 上限只用于新五项；原 submit 不加本地体积上限', async () => {
  const big = { task_id: TASK, column_keys: null };
  const rec = recorder(reply(200, ok('download', okFor('download'))));
  assert.ok(Buffer.byteLength(JSON.stringify({ task_id: TASK }), 'utf8') < lib.MAX_BODY_BYTES);
  await make(rec.transport).execute('download', big);
  const values = Array.from({ length: 200 }, (_, i) => `https://www.youtube.com/@${'c'.repeat(400)}${i}`);
  assert.ok(Buffer.byteLength(JSON.stringify({ values }), 'utf8') > lib.MAX_BODY_BYTES);
  const legacy = recorder(reply(200, ok('submit', submitted)));
  await make(legacy.transport).execute('submit', { task_type: 'LINK_BATCH', platform: 'youtube', values });
  assert.equal(legacy.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------------------------
test('新五项的账务字段必须为 null；原四项保留默认 meta（credits_consumed=0 不当作免费结论）', async () => {
  for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) {
    for (const operation of ['columns', 'steps', 'download', 'abort', 'retry']) {
      const rec = recorder(reply(200, { ...ok(operation, okFor(operation)), meta: managedMeta({ [field]: field === 'credits_consumed' ? 0 : 'settled' }) }));
      await assert.rejects(make(rec.transport).execute(operation, entries[operation][0]), error => error.kind === 'protocol', `${operation} ${field}`);
    }
  }
  for (const operation of ['submit', 'keyword_submit', 'status', 'data']) {
    const rec = recorder(reply(200, ok(operation, okFor(operation))));
    const result = await make(rec.transport).execute(operation, entries[operation][0]);
    assert.equal(result.meta.credits_consumed, 0);
  }
});

const badResults = [
  ['submit', { ...submitted, task_id: '' }],
  ['submit', { ...submitted, total_count: -1 }],
  ['status', { ...okFor('status'), task_id: 'other' }],
  ['status', { ...okFor('status'), status: 'aborted' }],
  ['status', { ...okFor('status'), status: 'queued' }],
  ['status', { ...okFor('status'), progress: '0%' }],
  ['data', { ...okFor('data'), items: [['row']] }],
  ['data', { ...okFor('data'), page: 0 }],
  ['columns', { columns: [{ key: 'a' }] }],
  ['steps', { ...okFor('steps'), task_id: 'other' }],
  ['steps', { ...okFor('steps'), steps: [{ step_name: 'x', step_order: '1', status: 'completed', started_at: null, ended_at: null, duration_seconds: null }] }],
  ['download', { ...okFor('download'), items: [{ values: [] }] }],
  ['abort', view({ status: 'processing' })],
  ['abort', view({ task_type: 'LINK_BATCH' })],
  ['retry', view({ task_id: 'other' })],
  ['retry', view({ fail_list: null })],
];
for (const [operation, data] of badResults) {
  test(`响应校验 ${operation}：不符合契约的 data 视为协议错误`, async () => {
    const rec = recorder(reply(200, ok(operation, data)));
    await assert.rejects(make(rec.transport).execute(operation, entries[operation][0]), error => error.kind === 'protocol');
  });
}

test('响应放行：空步骤与未知总耗时、完整状态视图的七个原状态、复用原任务时的非 submitted 状态', async () => {
  const steps = recorder(reply(200, ok('steps', { task_id: TASK, steps: [], total_duration_seconds: null })));
  await make(steps.transport).execute('steps', { task_id: TASK });
  for (const status of lib.FULL_STATUSES) {
    const rec = recorder(reply(200, ok('retry', view({ status }))));
    await make(rec.transport).execute('retry', { task_id: TASK });
  }
  const reused = recorder(reply(200, ok('submit', { ...submitted, status: 'crawl_processing' })));
  await make(reused.transport).execute('submit', entries.submit[0]);
});

test('协议错误：非 JSON、缺 meta、2xx 非 200、success 与状态矛盾', async () => {
  for (const response of [reply(200, '<html>'), reply(200, { success: true, data: okFor('status'), error: null }), reply(202, ok('status', okFor('status'))), reply(200, { ...ok('status', okFor('status')), success: false }), reply(404, { ...fail('status', 404, 'Task not found'), success: true })]) {
    await assert.rejects(make(recorder(response).transport).execute('status', { task_id: TASK }), error => error.kind === 'protocol');
  }
});

// ---------------------------------------------------------------------------------------------
// 错误：原四项与新五项分别处理
// ---------------------------------------------------------------------------------------------
for (const [code, reason] of [[6001, 'task_in_progress'], [6004, 'all_links_invalid'], [6005, 'insufficient_credits'], [6006, 'queue_full']]) {
  test(`原四项业务错误 HTTP 400 / ${code}：识别为 ${reason}，结果为被拒绝，不按 HTTP×100+1 解释`, async () => {
    for (const operation of ['submit', 'keyword_submit']) {
      const result = await run(operation, argsFor(operation), reply(400, fail(operation, 400, 'Insufficient credits to submit collection task', { request_id: 'req-biz' }, code)));
      const error = result.diagnostic.error;
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 1);
      assert.deepEqual([error.kind, error.status, error.code, error.reason, error.outcome, error.request_id], ['business', 400, code, reason, 'rejected', 'req-biz']);
    }
  });
}

test('新五项不接受原业务码：HTTP 400 / 6001 视为协议错误；原四项的未知 400 业务码也是协议错误', async () => {
  await assert.rejects(make(recorder(reply(400, fail('retry', 400, 'x', {}, 6001))).transport).execute('retry', { task_id: TASK }), error => error.kind === 'protocol');
  await assert.rejects(make(recorder(reply(400, fail('submit', 400, 'x', {}, 6002))).transport).execute('submit', entries.submit[0]), error => error.kind === 'protocol');
});

const legacyErrors = [
  ['status', 404, 'Task not found', 'task_not_found'],
  ['data', 404, 'Task not found', 'task_not_found'],
  ['submit', 400, "Platform 'twitter' does not support video collection", 'twitter_video_unsupported'],
  ['submit', 422, 'Request validation failed: values: Length outside allowed range', undefined],
  ['status', 401, 'API key authentication required', undefined],
  ['data', 403, 'OpenAPI access denied', undefined],
  ['data', 500, 'Internal server error', undefined],
  ['submit', 503, 'Internal server error', undefined],
];
const managedErrors = [
  ['steps', 404, 'collection_task_not_found', 'collection_task_not_found'],
  ['download', 409, 'collection_state_not_allowed', 'collection_state_not_allowed'],
  ['abort', 409, 'collection_state_not_allowed', 'collection_state_not_allowed'],
  ['retry', 502, 'collection_provider_unavailable', 'collection_provider_unavailable'],
  ['columns', 413, 'payload_too_large', 'payload_too_large'],
  ['download', 422, 'Request validation failed: column_keys: Length outside allowed range', undefined],
  ['retry', 400, 'Invalid request', undefined],
  ['abort', 500, 'Internal server error', undefined],
  ['retry', 503, 'OpenAPI access policy unavailable', undefined],
];
for (const [operation, status, message, reason] of [...legacyErrors, ...managedErrors]) {
  test(`错误 ${operation} HTTP ${status}（${message}）：外层 code ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run(operation, argsFor(operation), reply(status, fail(operation, status, message, { request_id: 'req-err' })));
    const error = result.diagnostic.error;
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, status);
    assert.equal(error.code, status * 100 + 1);
    assert.equal(error.reason, reason);
    assert.equal(error.request_id, 'req-err');
    assert.equal(error.outcome, lib.operations[operation].executes ? (status >= 500 ? 'unknown' : 'rejected') : 'rejected');
    if (reason === undefined) assert.equal(JSON.stringify(error).includes(message), false);
  });
}

test('受控 reason 不跨协议：原四项不识别 collection_task_not_found，新五项不识别 Task not found', async () => {
  const legacy = await run('status', argsFor('status'), reply(404, fail('status', 404, 'collection_task_not_found')));
  assert.equal(legacy.diagnostic.error.reason, undefined);
  const managed = await run('steps', argsFor('steps'), reply(404, fail('steps', 404, 'Task not found')));
  assert.equal(managed.diagnostic.error.reason, undefined);
});

test('429：合法 Retry-After 原样提示，非法值不输出，且不自动重试', async () => {
  for (const operation of ['submit', 'retry']) {
    for (const [header, expected] of [['30', '30'], ['Fri, 13 Nov 2026 00:00:30 GMT', 'Fri, 13 Nov 2026 00:00:30 GMT'], ['soon', undefined], [undefined, undefined]]) {
      const result = await run(operation, argsFor(operation), reply(429, fail(operation, 429, 'Rate limit exceeded'), header === undefined ? {} : { 'Retry-After': header }));
      assert.equal(result.calls.length, 1);
      assert.equal(result.diagnostic.error.retry_after, expected);
    }
  }
});

test('结果未知：动作类超时、断连、5xx、无效响应标为 unknown 且只调用一次；只读操作标为 unavailable', async () => {
  for (const operation of ['submit', 'keyword_submit', 'abort', 'retry']) {
    const input = entries[operation][0];
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, input), error => error.kind === 'timeout' && error.outcome === 'unknown');
    let attempts = 0;
    await assert.rejects(make(async () => { attempts++; throw new Error(`socket ${SECRET}`); }).execute(operation, input), error => error.kind === 'network' && error.outcome === 'unknown' && !error.message.includes(SECRET));
    assert.equal(attempts, 1);
    await assert.rejects(make(recorder(reply(200, '<html>')).transport).execute(operation, input), error => error.kind === 'protocol' && error.outcome === 'unknown');
  }
  for (const operation of ['status', 'data', 'columns', 'steps', 'download']) {
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, entries[operation][0]), error => error.outcome === 'unavailable');
    const read = await run(operation, argsFor(operation), reply(503, fail(operation, 503, 'Service unavailable')));
    assert.equal(read.diagnostic.error.outcome, 'rejected');
  }
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本、输入值和异常堆栈不进入错误输出', async () => {
  const result = await run('submit', ['--input-file', writeInput({ task_type: 'LINK_BATCH', platform: 'youtube', values: ['https://www.youtube.com/@privateChannel'] })], reply(500, fail('submit', 500, 'Traceback: MATL token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2', 'privateChannel']) assert.equal(text.includes(leaked), false, leaked);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('status', { args: [json({ task_id: TASK })], client: { execute: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI 与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI：支持内联 JSON、--input-file 和带 BOM 的文件；调用方式错误返回 1 且不发请求', async () => {
  for (const args of [[json({ task_id: TASK })], ['--input-file', writeInput({ task_id: TASK })], ['--input-file', writeInput({ task_id: TASK }, { bom: true })]]) {
    assert.equal((await run('status', args, reply(200, ok('status', okFor('status'))))).code, 0);
  }
  const file = writeInput({ task_id: TASK });
  for (const args of [[], ['--input-file'], ['--input-file', join(tempDir, 'missing.json')], ['{bad'], ['--wait', '--input-file', file], ['--output', outPath(), '--input-file', file], [json({}), '--input-file', file]]) {
    const result = await run('status', args, reply(200, ok('status', okFor('status'))));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
  }
});

test('submit 成功：stdout 是完整响应，stderr 提醒保存 task_id；复用原任务时另行说明', async () => {
  const fresh = await run('submit', argsFor('submit'), reply(200, ok('submit', submitted)));
  assert.equal(fresh.code, 0);
  assert.equal(JSON.parse(fresh.out[0]).data.task_id, TASK);
  assert.equal(fresh.err.length, 1);
  assert.ok(fresh.err[0].includes('保存 data.task_id'));
  const reused = await run('keyword_submit', argsFor('keyword_submit'), reply(200, ok('keyword_submit', { ...submitted, status: 'crawl_processing', message: '已提交 1 个关键词的采集任务，相同任务已存在，本次复用原任务' })));
  assert.equal(reused.err.length, 2);
  assert.ok(reused.err[1].includes('复用'));
});

test('abort / retry 成功：stderr 说明不保证撤销在途采集、retry 重置整个任务', async () => {
  const abort = await run('abort', argsFor('abort'), reply(200, ok('abort', view())));
  assert.ok(abort.err[0].includes('不保证撤销'));
  const retry = await run('retry', argsFor('retry'), reply(200, ok('retry', view({ status: 'crawl_processing' }))));
  assert.ok(retry.err[0].includes('不是只补失败条目'));
});

test('download：必须指定 --output；完整结果只写入文件，stdout 只有摘要', async () => {
  const missing = await run('download', ['--input-file', writeInput({ task_id: TASK })], reply(200, ok('download', okFor('download'))));
  assert.equal(missing.code, 1);
  assert.equal(missing.calls.length, 0);
  const output = outPath();
  const rows = Array.from({ length: 3 }, (_, i) => [`creator_${i}`, i]);
  const done = await run('download', ['--input-file', writeInput({ task_id: TASK }), '--output', output], reply(200, ok('download', { columns_config: ['Username', 'Followers'], items: rows, total: 3 })));
  assert.equal(done.code, 0);
  const summary = JSON.parse(done.out[0]);
  assert.deepEqual(summary.data, { output, total: 3, row_count: 3, columns_config: ['Username', 'Followers'] });
  assert.equal(done.out[0].includes('creator_1'), false);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).data.items, rows);
  assert.ok(done.err[0].includes('不要把整份文件读进对话'));
});

test('download：输出文件已存在时不覆盖', async () => {
  const output = outPath();
  writeFileSync(output, 'keep');
  const result = await run('download', ['--input-file', writeInput({ task_id: TASK }), '--output', output], reply(200, ok('download', okFor('download'))));
  assert.equal(result.code, 1);
  assert.equal(readFileSync(output, 'utf8'), 'keep');
  assert.equal(result.diagnostic.error.kind, 'local');
  assert.ok(existsSync(output));
});

for (const [operation, [input]] of Object.entries(entries)) {
  test(`入口脚本 realtime_collection_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`realtime_collection_${operation}.mjs`);
    const rec = recorder(reply(200, ok(operation, okFor(operation))));
    assert.equal(await mod.main({ args: argsFor(operation, input), client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(pathOf(rec.calls[0]), lib.operations[operation].path);
    const proc = spawnSync(process.execPath, [join(scripts, `realtime_collection_${operation}.mjs`), ...argsFor(operation, input)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('实时采集脚本不含硬编码地址、Key 或 Authorization 头，也不调用旧 /v1/collection 路径', () => {
  const files = readdirSync(scripts).filter(name => name.includes('realtime_collection'));
  assert.equal(files.length, 11);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s|influxai_/i.test(source), false, name);
    assert.equal(source.includes('/v1/collection/'), false, name);
  }
});
