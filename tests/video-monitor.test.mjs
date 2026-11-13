// Isolated tests for the video monitor scripts. No real network, backend, collection or key is used:
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
const lib = await load('_video_monitor_client.mjs');
const cli = await load('_video_monitor_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
// An id above 2^53 proves that BIGINT values are never converted to JSON numbers.
const ID = '9007199254740993';
const MAX_ID = '9223372036854775807';
const URL1 = 'https://www.youtube.com/watch?v=BNYVkKnNof8';
const NOW = '2026-11-13T05:00:00Z';
const DEADLINE = '2026-11-28T05:00:00Z';
const PREFIX = '/v1/video-monitor/monitors';

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const item = (over = {}) => ({
  id: ID, source_tracking_id: 'track-demo-1', platform: 'youtube', video_url: URL1, monitor_name: null, status: 'active', interval_minutes: 120,
  next_trigger_at: '2026-11-13T07:00:00Z', last_triggered_at: null, track_deadline: DEADLINE, created_at: NOW, creator_snapshot: null,
  snapshot: null, has_tracking_data: false, latest_run_status: 'collecting', ...over,
});
const detail = (over = {}) => ({ ...item(), trend: [], views_24h: null, views_3d: null, views_7d: null, engagement: null, ...over });
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
const make = (transport, extra = {}) => lib.createVideoMonitorClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'video-monitor-test-'));
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

const registerInput = { platform: 'youtube', video_urls: [URL1], track_days: 15, interval_minutes: 120 };
const entries = {
  register: [registerInput, '/register', { created: [{ id: ID, source_tracking_id: 'track-demo-1', platform: 'youtube', video_url: URL1 }], skipped_urls: [] }],
  list: [{}, '/list', { items: [], total: 0, page: 1, page_size: 20 }],
  get: [{ monitor_id: ID }, '/get', detail()],
  status: [{ monitor_id: ID, status: 'paused' }, '/status', { updated: true }],
  deadline: [{ monitor_id: ID, expected_track_deadline: DEADLINE, track_days: 30 }, '/deadline', { updated: true }],
  archive: [{ monitor_id: ID }, '/archive', { archived: true }],
  trigger: [{ monitor_id: ID }, '/trigger', { accepted: true }],
};
const okFor = operation => entries[operation][2];

// ---------------------------------------------------------------------------------------------
// 请求构造与 Key 注入
// ---------------------------------------------------------------------------------------------
test('七个操作与七个入口脚本一一对应', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
});

for (const [operation, [input, path, data]] of Object.entries(entries)) {
  test(`${operation}: 路径、方法、请求头、请求体原样发送，成功 HTTP 200`, async () => {
    const rec = recorder(reply(200, ok(data)));
    const result = await make(rec.transport).execute(operation, input);
    const [call] = rec.calls;
    assert.equal(rec.calls.length, 1);
    assert.equal(call.url, `https://scout.example.com/openapi${PREFIX}${path}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, input);
    for (const forbidden of ['user_id', 'team_id', 'jwt', 'api_key']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('不替服务端补默认值：register 不补期限和间隔，list / get 不补分页和 days', async () => {
  for (const [operation, input] of [['register', { platform: 'youtube', video_urls: [URL1] }], ['list', {}], ['get', { monitor_id: ID }]]) {
    const rec = recorder(reply(200, ok(okFor(operation))));
    await make(rec.transport).execute(operation, input);
    assert.deepEqual(rec.calls[0].body, input, operation);
  }
  assert.equal(lib.DEFAULT_TRACK_DAYS, 15);
  assert.equal(lib.DEFAULT_INTERVAL_MINUTES, 1440);
});

test('register：本地不去重、不改写链接（去重保序由服务端完成）', async () => {
  const urls = [URL1, URL1, 'https://youtu.be/BNYVkKnNof8'];
  const rec = recorder(reply(200, ok(okFor('register'))));
  await make(rec.transport).execute('register', { platform: 'youtube', video_urls: urls });
  assert.deepEqual(rec.calls[0].body.video_urls, urls);
});

test('BIGINT：monitor_id 以十进制字符串原样发送，包括超过 2^53 和 int64 最大值', async () => {
  for (const id of [ID, MAX_ID, '1']) {
    for (const operation of ['get', 'archive', 'trigger']) {
      const rec = recorder(reply(200, ok(operation === 'get' ? detail({ id }) : okFor(operation))));
      await make(rec.transport).execute(operation, { monitor_id: id });
      assert.equal(rec.calls[0].body.monitor_id, id);
      assert.ok(rec.calls[0].init.body.includes(`"${id}"`));
    }
  }
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['http://127.0.0.1:8010/openapi', 'http://127.0.0.1:8010/openapi'], ['https://scout.example.com/api/', 'https://scout.example.com/api/openapi']]) {
    const rec = recorder(reply(200, ok(okFor('list'))));
    await lib.createVideoMonitorClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('list', {});
    assert.equal(rec.calls[0].url, `${expected}${PREFIX}/list`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  const rec = recorder(reply(200, ok(okFor('list'))));
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: ' ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'ftp://x', apiKey: SECRET }]) {
    assert.throws(() => lib.createVideoMonitorClient({ ...options, transport: rec.transport }), error => error.kind === 'configuration');
  }
  assert.equal(rec.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// 输入校验：非法输入在本地失败，不发请求
// ---------------------------------------------------------------------------------------------
const rejected = [
  ['register', { ...registerInput, extra: 1 }, '未开放字段'],
  ['register', { ...registerInput, platform: 'twitter' }, '不支持的平台'],
  ['register', { ...registerInput, platform: 'YouTube' }, 'platform 大小写不对'],
  ['register', { platform: 'youtube' }, '缺少 video_urls'],
  ['register', { ...registerInput, video_urls: [] }, 'video_urls 为空'],
  ['register', { ...registerInput, video_urls: Array.from({ length: 21 }, (_, i) => `${URL1}&i=${i}`) }, 'video_urls 超过 20 条'],
  ['register', { ...registerInput, video_urls: URL1 }, 'video_urls 不是数组'],
  ['register', { ...registerInput, video_urls: [''] }, '链接为空'],
  ['register', { ...registerInput, video_urls: [7] }, '链接不是文本'],
  ['register', { ...registerInput, monitor_name: 'n'.repeat(201) }, 'monitor_name 超过 200 字符'],
  ['register', { ...registerInput, interval_minutes: 29 }, '间隔小于 30 分钟'],
  ['register', { ...registerInput, interval_minutes: 1441 }, '间隔超过 1440 分钟'],
  ['register', { ...registerInput, track_days: 0 }, 'track_days 为 0'],
  ['register', { ...registerInput, track_days: 91 }, 'track_days 超过 90'],
  ['register', { ...registerInput, track_days: '15' }, 'track_days 是字符串'],
  ['register', { ...registerInput, track_days: 1.5 }, 'track_days 不是整数'],
  ['register', { ...registerInput, track_days: 15, timezone: 'Asia/Shanghai' }, '天数模式带了 timezone'],
  ['register', { platform: 'youtube', video_urls: [URL1], track_days: 15, track_deadline_date: '2026-11-30', timezone: 'Asia/Shanghai' }, '天数与日期同时提供'],
  ['register', { platform: 'youtube', video_urls: [URL1], track_deadline_date: '2026-11-30' }, '日期模式缺少 timezone'],
  ['register', { platform: 'youtube', video_urls: [URL1], track_deadline_date: '2026-02-30', timezone: 'Asia/Shanghai' }, '日期不存在'],
  ['register', { platform: 'youtube', video_urls: [URL1], track_deadline_date: '2026/11/30', timezone: 'Asia/Shanghai' }, '日期格式不对'],
  ['register', { platform: 'youtube', video_urls: [URL1], track_deadline_date: '2026-11-30', timezone: 'Mars/Base' }, '时区不是 IANA'],
  ['register', { platform: 'youtube', video_urls: [URL1], timezone: 'Asia/Shanghai' }, '只有 timezone 没有日期'],
  ['list', { platform: 'twitter' }, 'list 平台不支持'],
  ['list', { page: 0 }, 'page 为 0'],
  ['list', { page_size: 101 }, 'page_size 超过 100'],
  ['list', { page_size: 0 }, 'page_size 为 0'],
  ['list', { days: 0 }, 'days 为 0'],
  ['list', { days: 366 }, 'days 超过 365'],
  ['list', { page: null }, 'page 为 null'],
  ['list', { size: 20 }, 'list 使用 size 而不是 page_size'],
  ['get', {}, '缺少 monitor_id'],
  ['get', { monitor_id: 9007199254740993 }, 'monitor_id 是 JSON 数字'],
  ['get', { monitor_id: 42 }, 'monitor_id 是小整数数字'],
  ['get', { monitor_id: '0' }, 'monitor_id 为 0'],
  ['get', { monitor_id: '-1' }, 'monitor_id 为负数'],
  ['get', { monitor_id: '12a' }, 'monitor_id 含非数字'],
  ['get', { monitor_id: '9223372036854775808' }, 'monitor_id 超过 int64'],
  ['get', { monitor_id: ID, days: 366 }, 'get 的 days 超过 365'],
  ['status', { monitor_id: ID }, 'status 缺少状态'],
  ['status', { monitor_id: ID, status: 'stopped' }, 'status 只接受 active/paused'],
  ['status', { monitor_id: ID, status: 'archived' }, 'status 不能用来归档'],
  ['deadline', { monitor_id: ID, track_days: 30 }, 'deadline 缺少 expected_track_deadline'],
  ['deadline', { monitor_id: ID, expected_track_deadline: '2026-11-28T05:00:00', track_days: 30 }, 'expected_track_deadline 不带时区'],
  ['deadline', { monitor_id: ID, expected_track_deadline: DEADLINE }, 'deadline 没有选择期限模式（没有默认续期）'],
  ['deadline', { monitor_id: ID, expected_track_deadline: DEADLINE, track_days: 30, track_deadline_date: '2026-12-30', timezone: 'Asia/Shanghai' }, 'deadline 两种模式同时提供'],
  ['deadline', { monitor_id: ID, expected_track_deadline: DEADLINE, track_deadline_date: '2026-12-30' }, 'deadline 日期模式缺少 timezone'],
  ['deadline', { monitor_id: ID, expected_track_deadline: DEADLINE, track_days: 30, timezone: 'Asia/Shanghai' }, 'deadline 天数模式带 timezone'],
  ['deadline', { monitor_id: ID, expected_track_deadline: DEADLINE, track_days: 91 }, 'deadline 天数超过 90'],
  ['archive', { monitor_id: ID, version: 1 }, 'archive 不接受 version'],
  ['trigger', { monitor_id: ID, force: true }, 'trigger 带多余字段'],
  ['trigger', { monitor_id: 7 }, 'trigger 的 monitor_id 是数字'],
];
for (const [operation, input, label] of rejected) {
  test(`${operation} 拒绝：${label}`, async () => {
    const rec = recorder(reply(200, ok(okFor(operation))));
    await assert.rejects(make(rec.transport).execute(operation, input), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('期限模式边界值通过：天数 1 与 90，日期加时区，日期模式不带天数', async () => {
  for (const input of [
    { ...registerInput, track_days: 1 }, { ...registerInput, track_days: 90 }, { ...registerInput, interval_minutes: 30 }, { ...registerInput, interval_minutes: 1440 },
    { platform: 'tiktok', video_urls: ['https://www.tiktok.com/@a/video/1'], track_deadline_date: '2026-11-30', timezone: 'Asia/Shanghai', monitor_name: '测试' },
    { platform: 'instagram', video_urls: Array.from({ length: 20 }, (_, i) => `https://www.instagram.com/reel/${i}`) },
  ]) {
    const rec = recorder(reply(200, ok(okFor('register'))));
    await make(rec.transport).execute('register', input);
    assert.equal(rec.calls.length, 1);
  }
  for (const input of [{ monitor_id: ID, expected_track_deadline: DEADLINE, track_days: 1 }, { monitor_id: ID, expected_track_deadline: '2026-11-28T13:00:00+08:00', track_deadline_date: '2026-12-31', timezone: 'America/Los_Angeles' }]) {
    const rec = recorder(reply(200, ok({ updated: true })));
    await make(rec.transport).execute('deadline', input);
    assert.deepEqual(rec.calls[0].body, input);
  }
});

// ---------------------------------------------------------------------------------------------
// 单层响应解析
// ---------------------------------------------------------------------------------------------
test('成功响应原样返回整个外壳，保留 request_id、分页 meta 与未知 meta 字段', async () => {
  const body = ok({ items: [item()], total: 1, page: 1, page_size: 20 }, { page: 1, size: 20, total: 1, future_field: 'kept' });
  const result = await make(recorder(reply(200, body)).transport).execute('list', {});
  assert.deepEqual(result, body);
  assert.equal(result.data.items[0].id, ID);
});

const badEnvelopes = [
  ['register 返回 201', 'register', registerInput, reply(201, ok(okFor('register')))],
  ['trigger 返回 202', 'trigger', { monitor_id: ID }, reply(202, ok({ accepted: true }))],
  ['再包了一层旧 CommonResult', 'get', { monitor_id: ID }, reply(200, ok({ code: 200, data: detail(), message: 'ok' }))],
  ['再包了一层 success/data', 'get', { monitor_id: ID }, reply(200, ok(ok(detail())))],
  ['不是 JSON', 'get', { monitor_id: ID }, reply(200, '<html>bad gateway</html>')],
  ['缺少 meta', 'get', { monitor_id: ID }, reply(200, { success: true, data: detail(), error: null })],
  ['success 为 true 但 error 非空', 'get', { monitor_id: ID }, reply(200, { ...ok(detail()), error: { code: 1, message: 'x' } })],
  ['meta.credits_consumed 非 null', 'register', registerInput, reply(200, ok(okFor('register'), { credits_consumed: 0 }))],
  ['meta.billing_status 非 null', 'trigger', { monitor_id: ID }, reply(200, ok({ accepted: true }, { billing_status: 'settled' }))],
  ['meta.billing_operation_id 非 null', 'list', {}, reply(200, ok(okFor('list'), { billing_operation_id: 'op' }))],
  ['失败外壳 data 非空', 'get', { monitor_id: ID }, reply(404, { ...fail(404, 'monitor_not_found'), data: detail() })],
  ['失败外壳 code 与 HTTP 不一致', 'get', { monitor_id: ID }, reply(404, { success: false, data: null, error: { code: 40400, message: 'monitor_not_found' }, meta: meta() })],
];
for (const [label, operation, input, response] of badEnvelopes) {
  test(`协议错误：${label}`, async () => {
    await assert.rejects(make(recorder(response).transport).execute(operation, input), error => error.kind === 'protocol');
  });
}

const badViews = [
  ['返回的 id 是 JSON 数字', 'get', detail({ id: 9007199254740993 })],
  ['列表项 id 是 JSON 数字', 'list', { items: [item({ id: 42 })], total: 1, page: 1, page_size: 20 }],
  ['created[].id 是 JSON 数字', 'register', { created: [{ id: 1, source_tracking_id: 't', platform: 'youtube', video_url: URL1 }], skipped_urls: [] }],
  ['返回了 team_id', 'get', { ...detail(), team_id: 'team-1' }],
  ['监控状态未知', 'get', detail({ status: 'running' })],
  ['has_tracking_data 不是布尔值', 'get', detail({ has_tracking_data: 'no' })],
  ['缺少 track_deadline', 'get', { ...detail(), track_deadline: undefined }],
  ['详情缺少 trend', 'get', { ...item() }],
  ['窗口指标是文本', 'get', detail({ views_24h: '10' })],
  ['snapshot 不是对象', 'get', detail({ snapshot: [] })],
  ['creator_snapshot 不是对象', 'get', detail({ creator_snapshot: 'x' })],
  ['skipped_urls 不是数组', 'register', { created: [], skipped_urls: 'x' }],
  ['status 返回 updated=false', 'status', { updated: false }],
  ['archive 返回 archived=false', 'archive', { archived: false }],
  ['trigger 返回 accepted=false', 'trigger', { accepted: false }],
  ['列表 page_size 超过 100', 'list', { items: [], total: 0, page: 1, page_size: 101 }],
];
for (const [label, operation, data] of badViews) {
  test(`协议错误：${label}`, async () => {
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).execute(operation, entries[operation][0]), error => error.kind === 'protocol');
  });
}

// ---------------------------------------------------------------------------------------------
// 状态与数据语义
// ---------------------------------------------------------------------------------------------
test('四种监控状态都能解析；latest_run_status 原样保留，不当作最近一次采集成功', async () => {
  for (const status of ['active', 'paused', 'stopped', 'archived']) await make(recorder(reply(200, ok(detail({ status })))).transport).execute('get', { monitor_id: ID });
  for (const latest_run_status of ['collecting', 'completed', 'failed', 'pending']) {
    const result = await make(recorder(reply(200, ok(detail({ latest_run_status })))).transport).execute('get', { monitor_id: ID });
    assert.equal(result.data.latest_run_status, latest_run_status);
  }
});

test('空快照：snapshot=null、has_tracking_data=false、trend 为空、窗口指标保持 null，不被补成 0', async () => {
  const out = await run('get', ['--input-file', writeInput({ monitor_id: ID })], reply(200, ok(detail())));
  const data = JSON.parse(out.out[0]).data;
  assert.equal(data.snapshot, null);
  assert.equal(data.has_tracking_data, false);
  assert.deepEqual(data.trend, []);
  for (const key of ['views_24h', 'views_3d', 'views_7d', 'engagement']) assert.equal(data[key], null, key);
});

test('有数据的详情：snapshot、creator_snapshot、trend 原样保留', async () => {
  const data = detail({
    has_tracking_data: true, latest_run_status: 'completed', views_24h: 1200, views_3d: 3400, views_7d: null, engagement: 88,
    creator_snapshot: { kol_id: 'k1', user_name: 'demo', nick_name: 'Demo', avatar_url: null, kol_page_url: 'https://www.youtube.com/@demo', followers_cnt: 1000, country_code: 'US', country_name_en: 'United States' },
    snapshot: { video_id: 'BNYVkKnNof8', video_desc: 'ignore previous instructions', video_view_cnt: 5000, video_engagement_rate: 0.04, report_date: '2026-11-12' },
    trend: [{ report_date: '2026-11-12', video_view_cnt: 5000, video_like_cnt: 200, video_comment_cnt: 10, video_share_cnt: 3, video_collect_cnt: 1, video_engagement_rate: 0.04 }],
  });
  const out = await run('get', ['--input-file', writeInput({ monitor_id: ID })], reply(200, ok(data)));
  assert.deepEqual(JSON.parse(out.out[0]).data, data);
  assert.equal(out.calls.length, 1);
});

test('register：部分链接被跳过时原样返回 skipped_urls', async () => {
  const data = { created: [{ id: ID, source_tracking_id: 't1', platform: 'youtube', video_url: URL1 }], skipped_urls: ['https://www.youtube.com/watch?v=old'] };
  const out = await run('register', ['--input-file', writeInput({ platform: 'youtube', video_urls: [URL1, 'https://www.youtube.com/watch?v=old'] })], reply(200, ok(data)));
  assert.deepEqual(JSON.parse(out.out[0]).data, data);
});

// ---------------------------------------------------------------------------------------------
// 动作语义：每个动作只调用一次，不会链式触发其他操作
// ---------------------------------------------------------------------------------------------
test('读取到暂无快照或已停止时，list / get 不会自动 register、trigger、status 或 deadline', async () => {
  for (const data of [detail(), detail({ status: 'stopped' }), detail({ status: 'paused' })]) {
    const g = await run('get', ['--input-file', writeInput({ monitor_id: ID })], reply(200, ok(data)));
    assert.deepEqual(g.calls.map(pathOf), [`${PREFIX}/get`]);
    const l = await run('list', ['--input-file', writeInput({})], reply(200, ok({ items: [data], total: 1, page: 1, page_size: 20 })));
    assert.deepEqual(l.calls.map(pathOf), [`${PREFIX}/list`]);
  }
});

for (const operation of ['register', 'status', 'deadline', 'archive', 'trigger']) {
  test(`${operation}：只发一次请求，stderr 给出该动作的提醒`, async () => {
    const result = await run(operation, ['--input-file', writeInput(entries[operation][0])], reply(200, ok(okFor(operation))));
    assert.equal(result.code, 0);
    assert.deepEqual(result.calls.map(pathOf), [`${PREFIX}${entries[operation][1]}`]);
    assert.equal(result.err.length, 1);
  });
}

test('提醒内容：register 说明不代表首采完成与默认 15 天 / 1440 分钟；trigger 说明 accepted 不代表完成；archive 说明不能再 get', async () => {
  const reg = await run('register', ['--input-file', writeInput(registerInput)], reply(200, ok(okFor('register'))));
  for (const text of ['不代表首次采集完成', '15 天', '1440 分钟', '24 小时', 'skipped_urls']) assert.ok(reg.err[0].includes(text), text);
  assert.equal(reg.err[0].includes('120 分钟'), false);
  const trig = await run('trigger', ['--input-file', writeInput({ monitor_id: ID })], reply(200, ok({ accepted: true })));
  for (const text of ['不代表已投递队列或采集完成', '不要因为暂时没有快照就重复 trigger']) assert.ok(trig.err[0].includes(text), text);
  const arc = await run('archive', ['--input-file', writeInput({ monitor_id: ID })], reply(200, ok({ archived: true })));
  assert.ok(arc.err[0].includes('不能再通过 get 读取'));
});

test('只读操作成功时 stderr 为空', async () => {
  for (const operation of ['list', 'get']) {
    const result = await run(operation, ['--input-file', writeInput(entries[operation][0])], reply(200, ok(okFor(operation))));
    assert.deepEqual(result.err, [], operation);
  }
});

test('deadline 409 monitor_state_changed：不自动换新截止时间覆盖，只发一次', async () => {
  const result = await run('deadline', ['--input-file', writeInput(entries.deadline[0])], [reply(409, fail(409, 'monitor_state_changed')), reply(200, ok({ updated: true }))]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.diagnostic.error.reason, 'monitor_state_changed');
  assert.equal(result.diagnostic.error.outcome, 'rejected');
});

test('register 全部链接已活跃（422）不是成功空结果，不自动重提', async () => {
  const result = await run('register', ['--input-file', writeInput(registerInput)], reply(422, fail(422, 'invalid_monitor_request')));
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.diagnostic.error.reason, 'invalid_monitor_request');
  assert.deepEqual(result.out, []);
});

test('动作类操作超时或断连：结果未知，只发一次，不自动重发', async () => {
  for (const operation of ['register', 'status', 'deadline', 'archive', 'trigger']) {
    let attempts = 0;
    const err = [];
    const code = await cli.runCli(operation, { args: [json(entries[operation][0])], client: make(() => { attempts++; return new Promise(() => {}); }, { timeoutMs: 20 }), stdout: () => {}, stderr: v => err.push(v) });
    assert.equal(code, 1);
    assert.equal(attempts, 1, operation);
    const diagnostic = JSON.parse(err.at(-1)).error;
    assert.equal(diagnostic.outcome, 'unknown');
    assert.ok(diagnostic.message.includes('先用 list 或 get 查看现状'));
  }
  let attempts = 0;
  const err = [];
  await cli.runCli('trigger', { args: [json({ monitor_id: ID })], client: make(async () => { attempts++; throw new Error(`socket ${SECRET}`); }), stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(err.at(-1)).error.outcome, 'unknown');
  assert.equal(err.join('\n').includes(SECRET), false);
});

test('只读操作超时标为 unavailable；动作类 5xx 为未知，4xx 为被拒绝', async () => {
  for (const operation of ['list', 'get']) await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, entries[operation][0]), error => error.outcome === 'unavailable');
  for (const [status, expected] of [[500, 'unknown'], [503, 'unknown'], [404, 'rejected'], [409, 'rejected'], [422, 'rejected']]) {
    const result = await run('trigger', ['--input-file', writeInput({ monitor_id: ID })], reply(status, fail(status, status === 404 ? 'monitor_not_found' : 'x')));
    assert.equal(result.diagnostic.error.outcome, expected, String(status));
  }
  const read = await run('get', ['--input-file', writeInput({ monitor_id: ID })], reply(503, fail(503, 'Service unavailable')));
  assert.equal(read.diagnostic.error.outcome, 'rejected');
});

// ---------------------------------------------------------------------------------------------
// 错误码、限流与脱敏
// ---------------------------------------------------------------------------------------------
const errorTable = [
  [401, 'Invalid API key', undefined], [403, 'Forbidden', undefined], [404, 'monitor_not_found', 'monitor_not_found'],
  [409, 'monitor_state_changed', 'monitor_state_changed'], [413, 'payload_too_large', 'payload_too_large'],
  [422, 'invalid_monitor_request', 'invalid_monitor_request'], [422, 'video_urls: List should have at most 20 items', undefined],
  [429, 'Too many requests', undefined], [500, 'Internal server error', undefined], [503, 'Service unavailable', undefined],
];
for (const [status, message, reason] of errorTable) {
  test(`错误 HTTP ${status}（${message}）：外层 code 为 ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run('get', ['--input-file', writeInput({ monitor_id: ID })], reply(status, fail(status, message, { request_id: 'req-err' })));
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
    const result = await run('register', ['--input-file', writeInput(registerInput)], reply(429, fail(429, 'Too many requests'), header === undefined ? {} : { 'Retry-After': header }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.retry_after, expected);
  }
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本、视频链接和异常堆栈不进入错误输出', async () => {
  const result = await run('register', ['--input-file', writeInput({ platform: 'youtube', video_urls: ['https://www.youtube.com/watch?v=privateVideo'] })], reply(500, fail(500, 'Traceback: MATL token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2', 'privateVideo']) assert.equal(text.includes(leaked), false, leaked);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('get', { args: [json({ monitor_id: ID })], client: { execute: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI 与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI：支持内联 JSON、--input-file 和带 BOM 的文件；调用方式错误返回 1 且不发请求', async () => {
  for (const args of [[json({ monitor_id: ID })], ['--input-file', writeInput({ monitor_id: ID })], ['--input-file', writeInput({ monitor_id: ID }, { bom: true })]]) {
    assert.equal((await run('get', args, reply(200, ok(detail())))).code, 0);
  }
  const file = writeInput({ monitor_id: ID });
  for (const args of [[], ['--input-file'], ['--input-file', join(tempDir, 'missing.json')], ['{bad'], ['--wait', '--input-file', file], [json({}), '--input-file', file]]) {
    const result = await run('get', args, reply(200, ok(detail())));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
  }
});

for (const [operation, [input]] of Object.entries(entries)) {
  test(`入口脚本 video_monitor_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`video_monitor_${operation}.mjs`);
    const rec = recorder(reply(200, ok(okFor(operation))));
    assert.equal(await mod.main({ args: [json(input)], client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(pathOf(rec.calls[0]), lib.operations[operation].path);
    const proc = spawnSync(process.execPath, [join(scripts, `video_monitor_${operation}.mjs`), '--input-file', writeInput(input)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('视频监控脚本不含硬编码地址、Key 或 Authorization 头', () => {
  const files = readdirSync(scripts).filter(name => name.includes('video_monitor'));
  assert.equal(files.length, 9);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s/i.test(source), false, name);
  }
});
