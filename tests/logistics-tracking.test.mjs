// Isolated tests for the logistics tracking scripts. No real network, backend, provider or key is used:
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
const lib = await load('_logistics_client.mjs');
const cli = await load('_logistics_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
const SHIP = '00000000-0000-0000-0000-000000000042';
const OP = '00000000-0000-0000-0000-000000000009';
const NOW = '2026-11-13T00:00:00Z';
const PREFIX = '/v1/logistics';

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const creator = { platform: 'youtube', creator_uid: 'example' };
const shipment = (over = {}) => ({
  sub_status: null, latest_event_location: null, id: SHIP, operation_id: OP, creator: { ...creator, name: '', profile_url: null, user_name: null, avatar_url: null, followers_cnt: null, country_code: null },
  tracking_number: 'TEST12345', carrier: 0, carrier_name: null, recipient: null, remark: null, register_status: 'pending', shipment_status: 'pending',
  tracking_status: 'tracking', user_tracking_status: null, billing_status: 'pending', charged_credits: null, latest_event_time: null, latest_event_desc: null,
  provider_tips: null, milestones: [], events: [], overdue: false, error_code: null, pending_action: null, version: 0, created_at: NOW, updated_at: NOW, ...over,
});
const event = (over = {}) => ({ time_raw: { date: '2026-11-12', time: '08:00', timezone: '+08:00' }, provider_key: 100003, sub_status: null, event_key: 'a'.repeat(64), time: '2026-11-12T00:00:00Z', description: 'Picked up', location: 'Shenzhen', stage: 'PickedUp', provider_name: 'DHL', ...over });
const stats = (over = {}) => ({ total: 0, tracking: 0, delivered: 0, exception: 0, overdue: 0, pending: 0, in_transit: 0, out_for_delivery: 0, stopped: 0, ...over });
const carrierList = { items: [{ key: 100001, name: 'DHL Express', name_zh: 'DHL', country_iso: 'DE' }] };
const page = (items = [], over = {}) => ({ items, total: items.length, page: 1, size: 20, ...over });
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const pathOf = call => call.url.split('/openapi')[1];

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createLogisticsClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'logistics-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;
const json = value => JSON.stringify(value);
function writeInput(value, { bom = false } = {}) {
  const path = join(tempDir, `input-${fileCounter++}.json`);
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${typeof value === 'string' ? value : json(value)}`);
  return path;
}
async function run(operation, args, responses) {
  const rec = recorder(responses);
  const out = [];
  const err = [];
  const code = await cli.runCli(operation, { args, client: make(rec.transport), stdout: v => out.push(v), stderr: v => err.push(v) });
  const last = err.at(-1);
  return { code, out, err, calls: rec.calls, diagnostic: last?.startsWith('{') ? JSON.parse(last) : null };
}

const registerInput = { operation_id: OP, creator, tracking_number: 'TEST12345', carrier: 0 };
const mutation = { shipment_id: SHIP, version: 3 };
const entries = {
  carriers: [{ q: 'DHL' }, '/carriers/list', carrierList],
  register: [registerInput, '/shipments/register', shipment()],
  list: [{}, '/shipments/list', page()],
  stats: [{}, '/shipments/stats', stats()],
  get: [{ shipment_id: SHIP }, '/shipments/get', shipment()],
  refresh: [mutation, '/shipments/refresh', shipment({ version: 4 })],
  retry: [mutation, '/shipments/retry', shipment({ version: 4 })],
  change_carrier: [{ ...mutation, carrier: 100001 }, '/shipments/change-carrier', shipment({ carrier: 100001, version: 4 })],
  follow_up: [{ ...mutation, status: 'shipped' }, '/shipments/follow-up', shipment({ user_tracking_status: 'shipped', version: 4 })],
  stop: [mutation, '/shipments/stop', shipment({ tracking_status: 'stopped', version: 4 })],
  delete: [mutation, '/shipments/delete', { deleted: true }],
};
const okFor = operation => entries[operation][2];

// ---------------------------------------------------------------------------------------------
// 请求构造与 Key 注入
// ---------------------------------------------------------------------------------------------
test('十一个操作与十一个入口脚本一一对应', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
  assert.equal(Object.keys(lib.operations).length, 11);
});

for (const [operation, [input, path, data]] of Object.entries(entries)) {
  test(`${operation}: 路径、方法、请求头、请求体符合契约，成功 HTTP 200`, async () => {
    const rec = recorder(reply(200, ok(data)));
    const result = await make(rec.transport).execute(operation, input);
    const [call] = rec.calls;
    assert.equal(rec.calls.length, 1);
    assert.equal(call.url, `https://scout.example.com/openapi${PREFIX}${path}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    for (const forbidden of ['jwt', 'user_id', 'billing_user_id', 'team_id', 'api_key', 'provider']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('请求体：原样发送，不替服务端补默认值；list 补 page/size，stats 不补', async () => {
  const cases = [
    ['carriers', {}, {}],
    ['register', { operation_id: OP, creator, tracking_number: 'test12345' }, { operation_id: OP, creator, tracking_number: 'test12345' }],
    ['list', {}, { page: 1, size: 20 }],
    ['list', { page: 2, size: 100, statuses: ['in_transit', 'stopped'], overdue: true }, { page: 2, size: 100, statuses: ['in_transit', 'stopped'], overdue: true }],
    ['stats', {}, {}],
    ['stats', { query: 'abc', date_from: '2026-11-01T00:00:00Z', date_to: '2026-11-13T00:00:00+08:00' }, { query: 'abc', date_from: '2026-11-01T00:00:00Z', date_to: '2026-11-13T00:00:00+08:00' }],
    ['follow_up', { ...mutation, status: null }, { ...mutation, status: null }],
  ];
  for (const [operation, input, expected] of cases) {
    const rec = recorder(reply(200, ok(okFor(operation))));
    await make(rec.transport).execute(operation, input);
    assert.deepEqual(rec.calls[0].body, expected, operation);
  }
});

test('分页参数使用 page/size，不使用 page_size', async () => {
  for (const operation of ['list', 'stats']) {
    const rec = recorder(reply(200, ok(okFor(operation))));
    await assert.rejects(make(rec.transport).execute(operation, { page_size: 20 }), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  }
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['https://scout.example.com/openapi/', 'https://scout.example.com/openapi'], ['https://scout.example.com/api', 'https://scout.example.com/api/openapi'], ['http://127.0.0.1:8010', 'http://127.0.0.1:8010/openapi']]) {
    const rec = recorder(reply(200, ok(carrierList)));
    await lib.createLogisticsClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('carriers', {});
    assert.equal(rec.calls[0].url, `${expected}${PREFIX}/carriers/list`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  const rec = recorder(reply(200, ok(carrierList)));
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: '  ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'https://scout.example.com/?x=1', apiKey: SECRET }, { baseUrl: 'ftp://scout.example.com', apiKey: SECRET }]) {
    assert.throws(() => lib.createLogisticsClient({ ...options, transport: rec.transport }), error => error.kind === 'configuration');
  }
  assert.equal(rec.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// 输入校验：非法输入在本地失败，不发请求
// ---------------------------------------------------------------------------------------------
const rejected = [
  ['carriers', { q: 'x'.repeat(101) }, 'q 超过 100 字符'],
  ['carriers', { q: 7 }, 'q 不是文本'],
  ['carriers', { query: 'DHL' }, 'carriers 只接受 q'],
  ['register', { ...registerInput, extra: 1 }, '未开放字段'],
  ['register', { ...registerInput, operation_id: undefined }, '缺少 operation_id'],
  ['register', { ...registerInput, operation_id: 'not-a-uuid' }, 'operation_id 非 UUID'],
  ['register', { ...registerInput, creator: undefined }, '缺少 creator'],
  ['register', { ...registerInput, creator: { creator_uid: 'x' } }, 'creator 缺少 platform'],
  ['register', { ...registerInput, creator: { platform: 'twitter', creator_uid: 'x' } }, '不支持的平台'],
  ['register', { ...registerInput, creator: { platform: 'youtube' } }, 'creator 缺少 creator_uid'],
  ['register', { ...registerInput, creator: { platform: 'youtube', creator_uid: '   ' } }, 'creator_uid 全是空白'],
  ['register', { ...registerInput, creator: { platform: 'youtube', creator_uid: 'x'.repeat(151) } }, 'creator_uid 超过 150 字符'],
  ['register', { ...registerInput, creator: { ...creator, extra: 1 } }, 'creator 带多余字段'],
  ['register', { ...registerInput, creator: { ...creator, profile_url: 'http://example.com/a' } }, 'profile_url 非 HTTPS'],
  ['register', { ...registerInput, creator: { ...creator, avatar_url: 'https://u:p@example.com/a.png' } }, 'avatar_url 含凭据'],
  ['register', { ...registerInput, creator: { ...creator, followers_cnt: -1 } }, 'followers_cnt 为负'],
  ['register', { ...registerInput, creator: { ...creator, followers_cnt: '10' } }, 'followers_cnt 是字符串'],
  ['register', { ...registerInput, creator: { ...creator, country_code: 'X'.repeat(11) } }, 'country_code 超过 10 字符'],
  ['register', { ...registerInput, tracking_number: 'AB12' }, '运单号少于 5 位'],
  ['register', { ...registerInput, tracking_number: 'A'.repeat(51) }, '运单号超过 50 位'],
  ['register', { ...registerInput, tracking_number: 'AB 12345' }, '运单号含空格'],
  ['register', { ...registerInput, tracking_number: 'AB_12345' }, '运单号含下划线'],
  ['register', { ...registerInput, tracking_number: 12345678 }, '运单号是数字'],
  ['register', { ...registerInput, carrier: -1 }, 'carrier 为负'],
  ['register', { ...registerInput, carrier: 2147483648 }, 'carrier 超过上限'],
  ['register', { ...registerInput, carrier: '0' }, 'carrier 是字符串'],
  ['register', { ...registerInput, recipient: 'r'.repeat(101) }, 'recipient 超过 100 字符'],
  ['register', { ...registerInput, remark: 'r'.repeat(501) }, 'remark 超过 500 字符'],
  ['list', { size: 0 }, 'size 为 0'],
  ['list', { size: 101 }, 'size 超过 100'],
  ['list', { page: 0 }, 'page 为 0'],
  ['list', { page: null }, 'page 为 null'],
  ['list', { size: null }, 'size 为 null'],
  ['list', { statuses: ['shipped'] }, 'statuses 含不支持的值'],
  ['list', { statuses: 'in_transit' }, 'statuses 不是数组'],
  ['list', { statuses: Array.from({ length: 13 }, () => 'pending') }, 'statuses 超过 12 项'],
  ['list', { overdue: 'yes' }, 'overdue 不是布尔值'],
  ['list', { date_from: '2026-11-01' }, 'date_from 不带时间'],
  ['list', { date_from: '2026-11-01T00:00:00' }, 'date_from 不带时区'],
  ['list', { date_from: '2026-11-13T00:00:00Z', date_to: '2026-11-01T00:00:00Z' }, 'date_from 晚于 date_to'],
  ['list', { query: 'q'.repeat(151) }, 'query 超过 150 字符'],
  ['list', { status: 's'.repeat(41) }, 'status 超过 40 字符'],
  ['list', { tracking_number: 'T'.repeat(51) }, 'tracking_number 超过 50 字符'],
  ['list', { recipient: 'r'.repeat(101) }, 'recipient 超过 100 字符'],
  ['stats', { size: 101 }, 'stats 的 size 超过 100'],
  ['stats', { extra: 1 }, 'stats 带多余字段'],
  ['get', {}, '缺少 shipment_id'],
  ['get', { shipment_id: '42' }, 'shipment_id 非 UUID'],
  ['get', { shipment_id: SHIP, version: 1 }, 'get 带 version'],
  ['refresh', { shipment_id: SHIP }, 'refresh 缺少 version'],
  ['refresh', { ...mutation, version: -1 }, 'version 为负'],
  ['refresh', { ...mutation, version: '3' }, 'version 是字符串'],
  ['refresh', { ...mutation, version: 1.5 }, 'version 不是整数'],
  ['retry', { shipment_id: SHIP }, 'retry 缺少 version'],
  ['retry', { ...mutation, force: true }, 'retry 带多余字段'],
  ['stop', { version: 3 }, 'stop 缺少 shipment_id'],
  ['delete', { shipment_id: SHIP }, 'delete 缺少 version'],
  ['change_carrier', mutation, 'change_carrier 缺少 carrier'],
  ['change_carrier', { ...mutation, carrier: 0 }, 'change_carrier 的 carrier 为 0'],
  ['change_carrier', { ...mutation, carrier: 2147483648 }, 'change_carrier 的 carrier 超过上限'],
  ['follow_up', mutation, 'follow_up 缺少 status'],
  ['follow_up', { ...mutation, status: 'delivered' }, 'follow_up 的 status 不在人工状态内'],
  ['follow_up', { ...mutation, status: '' }, 'follow_up 的 status 为空字符串'],
];
for (const [operation, input, label] of rejected) {
  test(`${operation} 拒绝：${label}`, async () => {
    const rec = recorder(reply(200, ok(okFor(operation))));
    const body = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    await assert.rejects(make(rec.transport).execute(operation, body), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('register 边界值通过：运单号 5 与 50 位、小写与连字符、creator 可选字段、recipient/remark 为 null', async () => {
  for (const input of [
    { ...registerInput, tracking_number: 'AB123' },
    { ...registerInput, tracking_number: 'A'.repeat(50) },
    { ...registerInput, tracking_number: 'jd-0001-abc' },
    { ...registerInput, carrier: 2147483647 },
    { ...registerInput, recipient: null, remark: null },
    { ...registerInput, creator: { platform: 'tiktok', creator_uid: 'x'.repeat(150), name: '达人', profile_url: 'https://www.tiktok.com/@x', avatar_url: 'https://cdn.example.com/a.png', user_name: 'x', followers_cnt: 0, country_code: 'US' } },
  ]) {
    const rec = recorder(reply(200, ok(shipment())));
    await make(rec.transport).execute('register', input);
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(rec.calls[0].body, input);
  }
});

test('follow_up：七个人工状态和 null 都能发送', async () => {
  for (const status of [...lib.USER_STATUSES, null]) {
    const rec = recorder(reply(200, ok(shipment({ user_tracking_status: status }))));
    await make(rec.transport).execute('follow_up', { ...mutation, status });
    assert.equal(rec.calls[0].body.status, status);
  }
});

test('字段都取上限的登记请求仍低于 64 KiB 并正常发送（体积检查只作兜底）', async () => {
  const rec = recorder(reply(200, ok(shipment())));
  const big = {
    ...registerInput, tracking_number: 'A'.repeat(50), recipient: '收'.repeat(100), remark: '备'.repeat(500),
    creator: { platform: 'youtube', creator_uid: 'u'.repeat(150), name: '名'.repeat(150), user_name: 'n'.repeat(150), country_code: 'C'.repeat(10), followers_cnt: 1, profile_url: `https://example.com/${'a'.repeat(2020)}`, avatar_url: `https://example.com/${'b'.repeat(2020)}` },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < lib.MAX_BODY_BYTES);
  await make(rec.transport).execute('register', big);
  assert.equal(rec.calls.length, 1);
  assert.equal(lib.MAX_BODY_BYTES, 64 * 1024);
});

// ---------------------------------------------------------------------------------------------
// 单层响应解析
// ---------------------------------------------------------------------------------------------
test('成功响应原样返回整个外壳，保留 request_id、分页 meta 与未知 meta 字段', async () => {
  const body = ok(page([shipment()]), { page: 1, size: 20, total: 1, future_field: 'kept' });
  const result = await make(recorder(reply(200, body)).transport).execute('list', {});
  assert.deepEqual(result, body);
  assert.deepEqual([result.meta.page, result.meta.size, result.meta.total], [1, 20, 1]);
});

const badEnvelopes = [
  ['register 返回 202 而不是 200', 'register', registerInput, reply(202, ok(shipment()))],
  ['get 返回 201', 'get', { shipment_id: SHIP }, reply(201, ok(shipment()))],
  ['success 为 true 但 error 非空', 'get', { shipment_id: SHIP }, reply(200, { ...ok(shipment()), error: { code: 1, message: 'x' } })],
  ['再包了一层 success/data', 'get', { shipment_id: SHIP }, reply(200, ok(ok(shipment())))],
  ['不是 JSON', 'get', { shipment_id: SHIP }, reply(200, '<html>bad gateway</html>')],
  ['缺少 meta', 'get', { shipment_id: SHIP }, reply(200, { success: true, data: shipment(), error: null })],
  ['meta.credits_consumed 被填成运单历史扣费', 'get', { shipment_id: SHIP }, reply(200, ok(shipment({ billing_status: 'settled', charged_credits: 5 }), { credits_consumed: 5 }))],
  ['meta.billing_status 非 null', 'register', registerInput, reply(200, ok(shipment(), { billing_status: 'settled' }))],
  ['meta.billing_operation_id 非 null', 'register', registerInput, reply(200, ok(shipment(), { billing_operation_id: OP }))],
  ['失败外壳 data 非空', 'get', { shipment_id: SHIP }, reply(404, { ...fail(404, 'shipment_not_found'), data: shipment() })],
  ['失败外壳 code 与 HTTP 不一致', 'get', { shipment_id: SHIP }, reply(404, { success: false, data: null, error: { code: 40400, message: 'shipment_not_found' }, meta: meta() })],
  ['失败 HTTP 却声明 success', 'get', { shipment_id: SHIP }, reply(404, ok(shipment()))],
];
for (const [label, operation, input, response] of badEnvelopes) {
  test(`协议错误：${label}`, async () => {
    await assert.rejects(make(recorder(response).transport).execute(operation, input), error => error.kind === 'protocol');
  });
}

// ---------------------------------------------------------------------------------------------
// 运单的各条状态线与账务
// ---------------------------------------------------------------------------------------------
test('注册、运输、追踪生命周期、人工跟进、账务各自原样保留', async () => {
  const data = shipment({
    register_status: 'registered', shipment_status: 'in_transit', sub_status: 'InTransit_PickedUp', tracking_status: 'tracking', user_tracking_status: 'content_creating',
    billing_status: 'settled', charged_credits: 3, latest_event_time: '2026-11-12T00:00:00Z', latest_event_desc: 'Picked up', version: 7,
  });
  const result = await make(recorder(reply(200, ok(data))).transport).execute('get', { shipment_id: SHIP });
  for (const key of ['register_status', 'shipment_status', 'tracking_status', 'user_tracking_status', 'billing_status', 'charged_credits', 'version']) assert.equal(result.data[key], data[key], key);
  assert.equal(result.meta.credits_consumed, null);
});

test('各枚举取值都能解析：注册五态、追踪两态、账务四态、待恢复动作五种', async () => {
  for (const register_status of ['pending', 'registering', 'unknown', 'registered', 'failed']) await make(recorder(reply(200, ok(shipment({ register_status })))).transport).execute('get', { shipment_id: SHIP });
  for (const tracking_status of ['tracking', 'stopped']) await make(recorder(reply(200, ok(shipment({ tracking_status })))).transport).execute('get', { shipment_id: SHIP });
  for (const billing_status of ['pending', 'settled', 'no_charge', 'settlement_failed']) await make(recorder(reply(200, ok(shipment({ billing_status, charged_credits: billing_status === 'no_charge' ? 0 : null })))).transport).execute('get', { shipment_id: SHIP });
  for (const pending_action of ['register', 'refresh', 'carrier', 'stop', 'delete', null]) await make(recorder(reply(200, ok(shipment({ pending_action })))).transport).execute('get', { shipment_id: SHIP });
});

test('事件 time 未知时为 null，time_raw 原样保留，不被补成当前时间', async () => {
  const data = shipment({ events: [event({ time: null, time_raw: { date: '2026-11-12', time: null, timezone: null } }), event({ event_key: 'b'.repeat(64) })] });
  const out = await run('get', ['--input-file', writeInput({ shipment_id: SHIP })], reply(200, ok(data)));
  const printed = JSON.parse(out.out[0]).data.events;
  assert.equal(printed[0].time, null);
  assert.deepEqual(printed[0].time_raw, { date: '2026-11-12', time: null, timezone: null });
  assert.equal(printed[1].time, '2026-11-12T00:00:00Z');
});

test('列表空态：items=[]、total=0', async () => {
  const result = await make(recorder(reply(200, ok(page([], { total: 0 })))).transport).execute('list', {});
  assert.deepEqual(result.data.items, []);
  assert.equal(result.data.total, 0);
});

test('stats、carriers、delete 的结构原样保留', async () => {
  const s = stats({ total: 9, tracking: 3, delivered: 2, exception: 1, overdue: 1, pending: 1, in_transit: 2, out_for_delivery: 0, stopped: 1 });
  assert.deepEqual((await make(recorder(reply(200, ok(s))).transport).execute('stats', {})).data, s);
  assert.deepEqual((await make(recorder(reply(200, ok({ items: [] }))).transport).execute('carriers', { q: 'zzz' })).data, { items: [] });
  assert.deepEqual((await make(recorder(reply(200, ok({ deleted: true }))).transport).execute('delete', mutation)).data, { deleted: true });
});

const badViews = [
  ['运单 id 非 UUID', 'get', shipment({ id: '42' })],
  ['operation_id 非 UUID', 'get', shipment({ operation_id: 'x' })],
  ['register_status 未知', 'get', shipment({ register_status: 'ok' })],
  ['tracking_status 未知', 'get', shipment({ tracking_status: 'paused' })],
  ['user_tracking_status 未知', 'get', shipment({ user_tracking_status: 'delivered' })],
  ['billing_status 未知', 'get', shipment({ billing_status: 'free' })],
  ['charged_credits 是文本', 'get', shipment({ charged_credits: '3' })],
  ['pending_action 未知', 'get', shipment({ pending_action: 'resume' })],
  ['version 为负', 'get', shipment({ version: -1 })],
  ['events 不是数组', 'get', shipment({ events: {} })],
  ['事件缺少 event_key', 'get', shipment({ events: [{ ...event(), event_key: undefined }] })],
  ['overdue 不是布尔值', 'get', shipment({ overdue: 'no' })],
  ['creator 平台未知', 'get', shipment({ creator: { platform: 'x', creator_uid: 'a' } })],
  ['列表 size 超过 100', 'list', page([], { size: 101 })],
  ['列表 total 为负', 'list', page([], { total: -1 })],
  ['统计缺字段', 'stats', { total: 1 }],
  ['统计值为负', 'stats', stats({ tracking: -1 })],
  ['承运商 key 是文本', 'carriers', { items: [{ key: '1', name: 'a', name_zh: 'a', country_iso: '' }] }],
  ['delete 返回 deleted=false', 'delete', { deleted: false }],
];
for (const [label, operation, data] of badViews) {
  test(`协议错误：${label}`, async () => {
    const input = entries[operation][0];
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).execute(operation, input), error => error.kind === 'protocol');
  });
}

// ---------------------------------------------------------------------------------------------
// 显式动作：每个变更只调用一次，不会链式触发其他操作
// ---------------------------------------------------------------------------------------------
test('读取到 pending_action 或 registration 未确认时，get/list 不会自动 retry 或 refresh', async () => {
  for (const data of [shipment({ pending_action: 'register', register_status: 'unknown' }), shipment({ pending_action: 'delete' }), shipment({ register_status: 'registering', error_code: 'registration_needs_confirmation' })]) {
    const g = await run('get', ['--input-file', writeInput({ shipment_id: SHIP })], reply(200, ok(data)));
    assert.deepEqual(g.calls.map(pathOf), [`${PREFIX}/shipments/get`]);
    const l = await run('list', ['--input-file', writeInput({})], reply(200, ok(page([data]))));
    assert.deepEqual(l.calls.map(pathOf), [`${PREFIX}/shipments/list`]);
  }
});

for (const operation of ['register', 'refresh', 'retry', 'change_carrier', 'follow_up', 'stop', 'delete']) {
  test(`${operation}：只发一次请求，stderr 给出该动作的提醒`, async () => {
    const result = await run(operation, ['--input-file', writeInput(entries[operation][0])], reply(200, ok(okFor(operation))));
    assert.equal(result.code, 0);
    assert.deepEqual(result.calls.map(pathOf), [`${PREFIX}${entries[operation][1]}`]);
    assert.equal(result.err.length, 1);
    assert.ok(result.err[0].length > 10);
  });
}

test('提醒内容：register 说明 registered 不是送达与账务口径；stop 说明不等于删除；delete 说明不等于退款', async () => {
  const reg = await run('register', ['--input-file', writeInput(registerInput)], reply(200, ok(shipment())));
  for (const text of ['operation_id', '不是送达', 'meta 账务字段为 null 不代表免费']) assert.ok(reg.err[0].includes(text), text);
  const stop = await run('stop', ['--input-file', writeInput(mutation)], reply(200, ok(shipment({ tracking_status: 'stopped' }))));
  assert.ok(stop.err[0].includes('不等于删除'));
  const del = await run('delete', ['--input-file', writeInput(mutation)], reply(200, ok({ deleted: true })));
  assert.ok(del.err[0].includes('不等于退款'));
  const refresh = await run('refresh', ['--input-file', writeInput(mutation)], reply(200, ok(shipment())));
  assert.ok(refresh.err[0].includes('不要把 refresh 放进轮询'));
});

test('只读操作成功时 stderr 为空', async () => {
  for (const operation of ['carriers', 'list', 'stats', 'get']) {
    const result = await run(operation, ['--input-file', writeInput(entries[operation][0])], reply(200, ok(okFor(operation))));
    assert.equal(result.code, 0);
    assert.deepEqual(result.err, [], operation);
  }
});

test('版本冲突 409：不自动刷新 version 重放，只发一次请求', async () => {
  for (const operation of ['refresh', 'retry', 'change_carrier', 'follow_up', 'stop', 'delete']) {
    const result = await run(operation, ['--input-file', writeInput(entries[operation][0])], [reply(409, fail(409, 'shipment_version_changed')), reply(200, ok(shipment()))]);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1, operation);
    assert.equal(result.diagnostic.error.reason, 'shipment_version_changed');
    assert.equal(result.diagnostic.error.outcome, 'rejected');
  }
});

test('register 重放：保留原 operation_id，不换号；409 冲突不重发', async () => {
  for (const message of ['operation_payload_changed', 'tracking_number_already_active', 'operation_already_deleted']) {
    const result = await run('register', ['--input-file', writeInput(registerInput)], reply(409, fail(409, message)));
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].body.operation_id, OP);
    assert.equal(result.diagnostic.error.reason, message);
  }
});

test('registration_needs_confirmation：标为结果未知，而不是确定失败', async () => {
  for (const status of [409, 502]) {
    const result = await run('register', ['--input-file', writeInput(registerInput)], reply(status, fail(status, 'registration_needs_confirmation')));
    assert.equal(result.diagnostic.error.reason, 'registration_needs_confirmation');
    assert.equal(result.diagnostic.error.outcome, 'unknown');
    assert.equal(result.calls.length, 1);
  }
});

test('变更类操作超时或断连：结果未知，只发一次，不自动重发', async () => {
  for (const operation of ['register', 'refresh', 'retry', 'change_carrier', 'follow_up', 'stop', 'delete']) {
    let attempts = 0;
    const err = [];
    const code = await cli.runCli(operation, { args: [json(entries[operation][0])], client: make(() => { attempts++; return new Promise(() => {}); }, { timeoutMs: 20 }), stdout: () => {}, stderr: v => err.push(v) });
    assert.equal(code, 1);
    assert.equal(attempts, 1, operation);
    const diagnostic = JSON.parse(err.at(-1)).error;
    assert.equal(diagnostic.kind, 'timeout');
    assert.equal(diagnostic.outcome, 'unknown');
    assert.ok(diagnostic.message.includes('先用 get 读取最新状态'));
  }
  let attempts = 0;
  const err = [];
  await cli.runCli('register', { args: [json(registerInput)], client: make(async () => { attempts++; throw new Error(`socket hang up ${SECRET}`); }), stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(err.at(-1)).error.outcome, 'unknown');
  assert.equal(err.join('\n').includes(SECRET), false);
});

test('只读操作超时标为 unavailable', async () => {
  for (const operation of ['carriers', 'list', 'stats', 'get']) {
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, entries[operation][0]), error => error.kind === 'timeout' && error.outcome === 'unavailable');
  }
});

test('变更类操作的 5xx：结果未知；4xx：被拒绝；只读操作的 5xx：被拒绝', async () => {
  for (const [status, message, expected] of [[500, 'logistics_unavailable', 'unknown'], [502, 'tracking_provider_unavailable', 'unknown'], [503, 'tracking_provider_not_configured', 'unknown'], [402, 'insufficient_credits', 'rejected'], [409, 'shipment_busy', 'rejected'], [409, 'shipment_action_needs_recovery', 'rejected'], [422, 'invalid_carrier', 'rejected']]) {
    const result = await run('register', ['--input-file', writeInput(registerInput)], reply(status, fail(status, message)));
    assert.equal(result.diagnostic.error.outcome, expected, message);
  }
  const read = await run('get', ['--input-file', writeInput({ shipment_id: SHIP })], reply(503, fail(503, 'logistics_unavailable')));
  assert.equal(read.diagnostic.error.outcome, 'rejected');
});

// ---------------------------------------------------------------------------------------------
// 错误码、限流与脱敏
// ---------------------------------------------------------------------------------------------
const errorTable = [
  [400, 'logistics_unavailable', 'logistics_unavailable'], [401, 'Invalid API key', undefined], [402, 'insufficient_credits', 'insufficient_credits'],
  [403, 'Forbidden', undefined], [403, 'billing_identity_required', 'billing_identity_required'], [403, 'tracking_quote_required', 'tracking_quote_required'],
  [404, 'shipment_not_found', 'shipment_not_found'], [409, 'shipment_busy', 'shipment_busy'], [409, 'shipment_version_changed', 'shipment_version_changed'],
  [409, 'carrier_shared_subscription', 'carrier_shared_subscription'], [409, 'shipment_tracking_stopped', 'shipment_tracking_stopped'], [409, 'shipment_not_registered', 'shipment_not_registered'],
  [413, 'payload_too_large', 'payload_too_large'], [422, 'invalid_carrier', 'invalid_carrier'], [422, 'tracking_number_rejected', 'tracking_number_rejected'],
  [422, 'creator.creator_uid: field required', undefined], [429, 'tracking_provider_rate_limited', 'tracking_provider_rate_limited'], [500, 'Internal server error', undefined],
  [502, 'tracking_provider_rejected', 'tracking_provider_rejected'], [503, 'tracking_rate_limit_unavailable', 'tracking_rate_limit_unavailable'],
];
for (const [status, message, reason] of errorTable) {
  test(`错误 HTTP ${status}（${message}）：外层 code 为 ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run('get', ['--input-file', writeInput({ shipment_id: SHIP })], reply(status, fail(status, message, { request_id: 'req-err' })));
    const error = result.diagnostic.error;
    assert.equal(result.code, 1);
    assert.equal(error.status, status);
    assert.equal(error.code, status * 100 + 1);
    assert.equal(error.reason, reason);
    assert.equal(error.request_id, 'req-err');
    if (reason === undefined) assert.equal(JSON.stringify(error).includes(message), false);
  });
}

test('429：合法 Retry-After 原样提示，非法值不输出，且不自动重试', async () => {
  for (const [header, expected] of [['30', '30'], ['Fri, 13 Nov 2026 00:00:30 GMT', 'Fri, 13 Nov 2026 00:00:30 GMT'], ['soon', undefined], [undefined, undefined]]) {
    const result = await run('refresh', ['--input-file', writeInput(mutation)], reply(429, fail(429, 'tracking_provider_rate_limited'), header === undefined ? {} : { 'Retry-After': header }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.retry_after, expected);
  }
  const no = await run('get', ['--input-file', writeInput({ shipment_id: SHIP })], reply(503, fail(503, 'logistics_unavailable'), { 'Retry-After': '30' }));
  assert.equal('retry_after' in no.diagnostic.error, false);
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本和异常堆栈不进入输出', async () => {
  const result = await run('get', ['--input-file', writeInput({ shipment_id: SHIP })], reply(500, fail(500, 'Traceback: provider token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2']) assert.equal(text.includes(leaked), false);
});

test('脱敏：错误输出不含收件人、备注、运单号或 Key', async () => {
  const input = { ...registerInput, tracking_number: 'PRIV98765', recipient: 'Private Person', remark: 'secret remark text' };
  const result = await run('register', ['--input-file', writeInput(input)], reply(500, fail(500, 'Internal server error')));
  const text = result.err.join('\n');
  for (const leaked of ['PRIV98765', 'Private Person', 'secret remark text', SECRET, 'X-API-Key']) assert.equal(text.includes(leaked), false, leaked);
  const bad = await run('register', ['--input-file', writeInput({ ...input, tracking_number: 'X' })], reply(200, ok(shipment())));
  for (const leaked of ['Private Person', 'secret remark text']) assert.equal(bad.err.join('\n').includes(leaked), false);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('get', { args: [json({ shipment_id: SHIP })], client: { execute: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI 与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI：支持内联 JSON、--input-file 和带 BOM 的文件；调用方式错误返回 1 且不发请求', async () => {
  for (const args of [[json({ shipment_id: SHIP })], ['--input-file', writeInput({ shipment_id: SHIP })], ['--input-file', writeInput({ shipment_id: SHIP }, { bom: true })]]) {
    const result = await run('get', args, reply(200, ok(shipment())));
    assert.equal(result.code, 0);
  }
  const file = writeInput({ shipment_id: SHIP });
  for (const args of [[], ['--input-file'], ['--input-file', join(tempDir, 'missing.json')], ['{bad'], ['--wait', '--input-file', file], [json({}), '--input-file', file]]) {
    const result = await run('get', args, reply(200, ok(shipment())));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
  }
});

for (const [operation, [input]] of Object.entries(entries)) {
  test(`入口脚本 logistics_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`logistics_${operation}.mjs`);
    const rec = recorder(reply(200, ok(okFor(operation))));
    assert.equal(await mod.main({ args: [json(input)], client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(pathOf(rec.calls[0]), lib.operations[operation].path);
    const proc = spawnSync(process.execPath, [join(scripts, `logistics_${operation}.mjs`), '--input-file', writeInput(input)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('物流脚本不含硬编码地址、Key 或 Authorization 头', () => {
  const files = readdirSync(scripts).filter(name => name.includes('logistics'));
  assert.equal(files.length, 13);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s/i.test(source), false, name);
  }
});
