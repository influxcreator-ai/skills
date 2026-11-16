// Isolated tests for the competitor tracking scripts. No real network, backend, model call or key is used:
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
const lib = await load('_competitor_tracking_client.mjs');
const cli = await load('_competitor_tracking_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
const STUDY = 'kms_demo_0001';
const GROUP_A = 'kmb_demo_a';
const GROUP_B = 'kmb_demo_b';
const REVISION = 'rev_demo_0001';
const IDEM = 'ct-demo-0001';
const PREFIX = '/v1/competitor-tracking/keyword-studies';

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, credits_remaining: -1, quota_remaining: -1, ...extra });
const groupView = (id, role, name) => ({ brand_id: id, group_id: id, brand_name: name, role: role === 'primary' ? 'own' : 'competitor', group_role: role, sort_order: 0, expanded_keywords: { default_keywords: [name.toLowerCase()] }, confirmed_keywords: [], status: 'expanded', match_mode: 'hashtag', seed_keywords: [name.toLowerCase()] });
const studyView = (over = {}) => ({
  brief: null, study_id: STUDY, status: 'running', stage: 'awaiting_keyword_confirm', platforms: ['tiktok'], time_window_days: 90,
  groups: [groupView(GROUP_A, 'primary', 'DemoBrand'), groupView(GROUP_B, 'comparison', 'DemoRival')], scope: { platforms: ['tiktok'] }, demand_name: null, intent: 'competitor',
  result: { report_state: 'pending' }, failure_reason: null, brand_context_revision: REVISION, created_at: '2026-11-15T05:00:00Z', completed_at: null, ...over,
});
const scheduled = { study_id: STUDY, execution_version: 2, scheduled: true };
const createInput = { groups: [{ name: 'DemoBrand', seed_keywords: ['demobrand'] }, { name: 'DemoRival', role: 'comparison', seed_keywords: ['demorival'] }], scope: { platforms: ['tiktok'] } };
const confirmInput = { study_id: STUDY, groups: [{ group_id: GROUP_A, keywords: ['demobrand'] }, { group_id: GROUP_B, keywords: ['demorival'] }], brand_context_reviewed: true, brand_context_revision: REVISION };
const entries = {
  create: [createInput, '/create', studyView()],
  list: [{}, '/list', { items: [studyView()], total: 1, page: 1, size: 20 }],
  get: [{ study_id: STUDY }, '/get', studyView()],
  confirm_keywords: [confirmInput, '/confirm-keywords', studyView({ stage: 'recalling' })],
  refresh_brand_context: [{ study_id: STUDY, source_urls_by_brand: { [GROUP_A]: ['https://demo.example.com/about'] } }, '/refresh-brand-context', studyView({ brand_context_revision: 'rev_demo_0002' })],
  report: [{ study_id: STUDY }, '/report', { summary: { headline: 'demo' }, marketing_videos: {} }],
  comments: [{ study_id: STUDY, term: 'texture' }, '/comments', { term: 'texture', total: 1, items: [{ comment_id: 'c1', text: 'nice texture', like_count: 3 }] }],
  brand_videos: [{ study_id: STUDY, brand_id: GROUP_A }, '/brand-videos', [{ brand_id: GROUP_A, platform: 'tiktok', video_id: 'v1', metrics: { views: 10 } }]],
  materialize: [{ study_id: STUDY }, '/materialize', { ...scheduled, execution_version: 1 }],
  regenerate: [{ study_id: STUDY }, '/regenerate', scheduled],
  refresh_existing_evidence: [{ study_id: STUDY }, '/refresh-existing-evidence', scheduled],
  archive: [{ study_id: STUDY }, '/archive', { study_id: STUDY, archived: true }],
};
const okFor = operation => entries[operation][2];
const statusFor = operation => lib.operations[operation].success;
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const success = operation => reply(statusFor(operation), ok(okFor(operation)));
const pathOf = call => call.url.split('/openapi')[1];
const optsFor = operation => (operation === 'create' ? { idempotencyKey: IDEM } : undefined);

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createCompetitorTrackingClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'competitor-tracking-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let fileCounter = 0;
const json = value => JSON.stringify(value);
function writeInput(value, { bom = false } = {}) {
  const path = join(tempDir, `input-${fileCounter++}.json`);
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${typeof value === 'string' ? value : json(value)}`);
  return path;
}
const outPath = () => join(tempDir, `out-${fileCounter++}.json`);
const argsFor = (operation, input = entries[operation][0]) => ['--input-file', writeInput(input), ...(operation === 'create' ? ['--idempotency-key', IDEM] : [])];
async function run(operation, args, responses) {
  const rec = recorder(responses);
  const out = [];
  const err = [];
  const code = await cli.runCli(operation, { args, client: make(rec.transport), stdout: v => out.push(v), stderr: v => err.push(v) });
  const last = err.at(-1);
  return { code, out, err, calls: rec.calls, diagnostic: last?.startsWith('{') ? JSON.parse(last) : null };
}

// ---------------------------------------------------------------------------------------------
// 请求构造与 Key 注入
// ---------------------------------------------------------------------------------------------
test('十二个操作与十二个入口脚本一一对应；动作类与 202 操作分组正确', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => v.executes).map(([k]) => k).sort(), ['archive', 'confirm_keywords', 'create', 'materialize', 'refresh_brand_context', 'refresh_existing_evidence', 'regenerate']);
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => v.success === 202).map(([k]) => k), ['refresh_existing_evidence']);
});

for (const [operation, [input, path]] of Object.entries(entries)) {
  test(`${operation}: 路径、方法、请求头、请求体原样发送，成功 HTTP ${lib.operations[operation].success}`, async () => {
    const rec = recorder(success(operation));
    const result = await make(rec.transport).execute(operation, input, optsFor(operation));
    const [call] = rec.calls;
    assert.equal(rec.calls.length, 1);
    assert.equal(call.url, `https://scout.example.com/openapi${PREFIX}${path}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(call.init.headers['Idempotency-Key'], operation === 'create' ? IDEM : undefined);
    assert.deepEqual(call.body, input);
    for (const forbidden of ['user_id', 'owner_user_id', 'jwt', 'api_key', 'idempotency_key']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('不替服务端补默认值：list 不补分页，create 不补时间窗口、top_n 等，confirm 不补 brand_context_reviewed', async () => {
  for (const [operation, input] of [['list', {}], ['create', createInput], ['comments', { study_id: STUDY, term: 'x' }], ['confirm_keywords', { study_id: STUDY, groups: [{ group_id: GROUP_A, keywords: ['a'] }] }]]) {
    const rec = recorder(success(operation));
    await make(rec.transport).execute(operation, input, optsFor(operation));
    assert.deepEqual(rec.calls[0].body, input, operation);
  }
});

test('Idempotency-Key：create 必须提供且格式合法；其他操作不接受', async () => {
  for (const key of [undefined, '', 'has space', 'x'.repeat(129), 'bad/slash']) {
    const rec = recorder(success('create'));
    await assert.rejects(make(rec.transport).execute('create', createInput, { idempotencyKey: key }), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  }
  for (const key of ['a', 'ct:2026-11-15_demo', 'x'.repeat(128)]) {
    const rec = recorder(success('create'));
    await make(rec.transport).execute('create', createInput, { idempotencyKey: key });
    assert.equal(rec.calls[0].init.headers['Idempotency-Key'], key);
  }
  await assert.rejects(make(recorder(success('get')).transport).execute('get', { study_id: STUDY }, { idempotencyKey: IDEM }), error => error.kind === 'input');
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['http://127.0.0.1:8010/openapi', 'http://127.0.0.1:8010/openapi'], ['https://scout.example.com/api/', 'https://scout.example.com/api/openapi']]) {
    const rec = recorder(success('list'));
    await lib.createCompetitorTrackingClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('list', {});
    assert.equal(rec.calls[0].url, `${expected}${PREFIX}/list`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: ' ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'ftp://x', apiKey: SECRET }, { baseUrl: 'https://scout.example.com#x', apiKey: SECRET }]) {
    assert.throws(() => lib.createCompetitorTrackingClient(options), error => error.kind === 'configuration');
  }
});

// ---------------------------------------------------------------------------------------------
// 请求校验：在发请求前拒绝
// ---------------------------------------------------------------------------------------------
const group = (over = {}) => ({ name: 'DemoBrand', seed_keywords: ['demobrand'], ...over });
const rejects = [
  ['create', { ...createInput, user_id: 'u1' }, '未开放字段'],
  ['create', { scope: { platforms: ['tiktok'] } }, '缺 groups'],
  ['create', { ...createInput, groups: [] }, '空 groups'],
  ['create', { ...createInput, groups: Array.from({ length: 6 }, (_, i) => group({ name: `g${i}`, role: i ? 'comparison' : 'primary' })) }, '6 组'],
  ['create', { ...createInput, groups: [group(), group({ name: 'B' })] }, '两个默认 primary'],
  ['create', { ...createInput, groups: [group({ role: 'comparison' })] }, '没有 primary'],
  ['create', { ...createInput, groups: [group(), group({ name: 'demobrand ', role: 'comparison' })] }, '重名'],
  ['create', { ...createInput, groups: [group({ seed_keywords: [] })] }, '空种子词'],
  ['create', { ...createInput, groups: [group({ seed_keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) })] }, '21 个种子词'],
  ['create', { ...createInput, groups: [group({ name: '' })] }, '空名称'],
  ['create', { ...createInput, groups: [group({ role: 'own' })] }, '旧角色名'],
  ['create', { ...createInput, groups: [group({ match_mode: 'fuzzy' })] }, '非 hashtag 匹配'],
  ['create', { ...createInput, groups: [group({ source_urls: ['ftp://x.example.com'] })] }, '非 HTTP 来源'],
  ['create', { ...createInput, groups: [group({ source_urls: Array.from({ length: 6 }, (_, i) => `https://e.example.com/${i}`) })] }, '6 条来源'],
  ['create', { ...createInput, groups: [group({ expansion: { mode: 'loose' } })] }, '未知扩词模式'],
  ['create', { ...createInput, groups: [group({ expansion: { max_expand_tags: 17 } })] }, '扩词上限 17'],
  ['create', { ...createInput, groups: [group({ expansion: { extra: 1 } })] }, '扩词未开放字段'],
  ['create', { ...createInput, groups: [group({ tags: ['x'] })] }, '词组未开放字段'],
  ['create', { groups: [group()] }, '缺平台'],
  ['create', { groups: [group()], scope: { platforms: ['twitter'] } }, '未知平台'],
  ['create', { groups: [group()], scope: { platforms: ['tiktok', 'instagram', 'youtube', 'tiktok'] } }, '4 个平台'],
  ['create', { groups: [group()], platforms: ['youtube'], time_window_days: 91 }, '相对窗口 91 天'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], time_window_days: 120 } }, 'scope 相对窗口 120 天'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], time_start: '2026-01-01' } }, '只有开始日'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], time_start: '2026-02-30', time_end: '2026-03-01' } }, '无效日期'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], time_start: '2026-03-02', time_end: '2026-03-01' } }, '结束早于开始'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], time_start: '2025-01-01', time_end: '2026-01-01' } }, '366 天'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], keywords: ['x'] } }, 'scope 未开放字段'],
  ['create', { groups: [group()], scope: { platforms: ['youtube'], follower_min: -1 } }, '负粉丝数'],
  ['create', { ...createInput, intent: 'other' }, '未知 intent'],
  ['create', { ...createInput, industry: 'beauty' }, '未知行业'],
  ['create', { ...createInput, recall_source: 'web' }, '未知召回源'],
  ['create', { ...createInput, realtime_sample_minimum: 501 }, '样本下限 501'],
  ['create', { ...createInput, comment_round_video_limit: 13 }, '评论视频 13'],
  ['create', { ...createInput, top_n: 0 }, 'top_n 0'],
  ['create', { ...createInput, top_n: 'some' }, 'top_n 文本'],
  ['create', { ...createInput, brief: 'x'.repeat(8001) }, 'brief 过长'],
  ['create', { ...createInput, demand_name: 'x'.repeat(161) }, '需求名过长'],
  ['create', { ...createInput, force_realtime_collection: 'yes' }, '字符串布尔'],
  ['list', { page: 0 }, 'page 0'],
  ['list', { size: 101 }, 'size 101'],
  ['list', { size: null }, 'size null'],
  ['list', { search: '' }, '空搜索词'],
  ['list', { status: 'archived' }, '归档状态'],
  ['list', { stage: 'done' }, '未知阶段'],
  ['list', { platform: 'twitter' }, '未知平台'],
  ['get', {}, '缺 study_id'],
  ['get', { study_id: '' }, '空 study_id'],
  ['get', { study_id: 'a b' }, '含空白'],
  ['get', { study_id: 'x'.repeat(257) }, '过长'],
  ['get', { study_id: 42 }, '数字'],
  ['get', { study_id: STUDY, include_report: true }, 'get 额外字段'],
  ['report', { study_id: STUDY, format: 'pdf' }, 'report 额外字段'],
  ['confirm_keywords', { study_id: STUDY }, '缺 groups'],
  ['confirm_keywords', { study_id: STUDY, groups: [] }, '空 groups'],
  ['confirm_keywords', { ...confirmInput, groups: [{ group_id: GROUP_A, keywords: ['a'] }, { group_id: GROUP_A, keywords: ['b'] }] }, '重复 group_id'],
  ['confirm_keywords', { ...confirmInput, groups: [{ group_id: '', keywords: ['a'] }] }, '空 group_id'],
  ['confirm_keywords', { ...confirmInput, groups: [{ group_id: GROUP_A, keywords: [] }] }, '空关键词'],
  ['confirm_keywords', { ...confirmInput, groups: [{ group_id: GROUP_A, keywords: Array.from({ length: 41 }, (_, i) => `k${i}`) }] }, '41 个关键词'],
  ['confirm_keywords', { ...confirmInput, groups: [{ group_id: GROUP_A, keywords: ['two words'] }] }, '带空格短语'],
  ['confirm_keywords', { ...confirmInput, groups: [{ group_id: GROUP_A, keywords: ['a'], expansion_mode: 'loose' }] }, '未知扩词模式'],
  ['confirm_keywords', { ...confirmInput, groups: [{ brand_id: GROUP_A, keywords: ['a'] }] }, '用 brand_id 代替 group_id'],
  ['confirm_keywords', { ...confirmInput, brand_context_revision: undefined }, '核对为 true 但没带 revision'],
  ['confirm_keywords', { ...confirmInput, brand_context_reviewed: 'true' }, '字符串布尔'],
  ['refresh_brand_context', { study_id: STUDY, source_urls_by_brand: [] }, '数组'],
  ['refresh_brand_context', { study_id: STUDY, source_urls_by_brand: { [GROUP_A]: ['javascript:alert(1)'] } }, '非 HTTP 链接'],
  ['refresh_brand_context', { study_id: STUDY, source_urls_by_brand: { ' ': ['https://e.example.com'] } }, '空键'],
  ['comments', { study_id: STUDY }, '缺 term'],
  ['comments', { study_id: STUDY, term: '   ' }, '空白 term'],
  ['comments', { study_id: STUDY, term: 'x'.repeat(129) }, 'term 过长'],
  ['comments', { study_id: STUDY, term: 'x', limit: 51 }, 'limit 51'],
  ['comments', { study_id: STUDY, term: 'x', brand_id: '' }, '空 brand_id'],
  ['brand_videos', { study_id: STUDY }, '缺 brand_id'],
  ['brand_videos', { study_id: STUDY, brand_id: GROUP_A, limit: 10 }, '不开放 limit'],
  ['materialize', { study_id: STUDY, force: true }, '额外字段'],
  ['regenerate', [STUDY], '数组请求'],
  ['archive', null, 'null 请求'],
];
for (const [operation, input, label] of rejects) {
  test(`输入校验 ${operation}：${label} 在本地拒绝且不发请求`, async () => {
    const rec = recorder(success(operation));
    await assert.rejects(make(rec.transport).execute(operation, input, optsFor(operation)), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('边界值放行：5 组、20 个种子词、相对 90 天、成对日期 365 天、40 个确认词、limit 50、study_id 256 字符', async () => {
  const groups = Array.from({ length: 5 }, (_, i) => group({ name: `g${i}`, role: i ? 'comparison' : 'primary', seed_keywords: Array.from({ length: 20 }, (_, k) => `s${i}${k}`), source_urls: ['https://e.example.com/a'], expansion: { mode: 'strict', brand_affinity: 'preferred', include_bare_stem: false, max_expand_tags: 16 } }));
  const cases = [
    ['create', { groups, platforms: ['tiktok', 'instagram', 'youtube'], time_window_days: 90, top_n: 'all', realtime_sample_minimum: 500, comment_round_video_limit: 12, industry: 'game', intent: 'brand', recall_source: 'legacy' }],
    ['create', { groups: [group()], scope: { platforms: ['youtube'], time_start: '2025-01-01', time_end: '2025-12-31', countries: ['us'], language: 'en', follower_min: 0, strict_geo: true } }],
    ['create', { groups: [group()], time_window_days: 200, scope: { platforms: ['youtube'], time_start: '2025-01-01', time_end: '2025-06-30' } }],
    ['confirm_keywords', { study_id: STUDY, groups: [{ group_id: GROUP_A, keywords: Array.from({ length: 40 }, (_, i) => `#k${i}`), match_mode: 'hashtag', expansion_mode: 'brand_broad' }] }],
    ['confirm_keywords', { study_id: STUDY, groups: [{ group_id: GROUP_A, keywords: ['a'] }], brand_context_reviewed: false }],
    ['comments', { study_id: STUDY, term: 'x'.repeat(128), brand_id: GROUP_A, limit: 50 }],
    ['list', { page: 3, size: 100, search: 'demo', status: 'completed', stage: 'report_ready', platform: 'instagram' }],
    ['refresh_brand_context', { study_id: STUDY }],
  ];
  for (const [operation, input] of cases) {
    const rec = recorder(success(operation));
    await make(rec.transport).execute(operation, input, optsFor(operation));
    assert.equal(rec.calls.length, 1, `${operation} ${JSON.stringify(input).slice(0, 80)}`);
  }
  const longId = 'k'.repeat(256);
  const rec = recorder(reply(200, ok(studyView({ study_id: longId }))));
  await make(rec.transport).execute('get', { study_id: longId });
});

test('请求体超过 64 KiB 时本地拒绝', async () => {
  const rec = recorder(success('create'));
  await assert.rejects(make(rec.transport).execute('create', { ...createInput, brief: 'x'.repeat(8000), groups: Array.from({ length: 5 }, (_, i) => group({ name: `${'n'.repeat(250)}${i}`, role: i ? 'comparison' : 'primary', seed_keywords: Array.from({ length: 20 }, () => 'k'.repeat(700)) })) }, { idempotencyKey: IDEM }), error => error.kind === 'input' && error.message.includes('64 KiB'));
  assert.equal(rec.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------------------------
test('账务字段必须为 null：credits_consumed、billing_status、billing_operation_id 任一非 null 视为协议错误', async () => {
  for (const operation of Object.keys(entries)) {
    for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) {
      const rec = recorder(reply(statusFor(operation), ok(okFor(operation), { [field]: field === 'credits_consumed' ? 0 : 'settled' })));
      await assert.rejects(make(rec.transport).execute(operation, entries[operation][0], optsFor(operation)), error => error.kind === 'protocol', `${operation} ${field}`);
    }
  }
});

test('成功状态码按操作区分：refresh_existing_evidence 只认 202，其余只认 200', async () => {
  await assert.rejects(make(recorder(reply(200, ok(scheduled))).transport).execute('refresh_existing_evidence', { study_id: STUDY }), error => error.kind === 'protocol');
  await assert.rejects(make(recorder(reply(202, ok(scheduled))).transport).execute('regenerate', { study_id: STUDY }), error => error.kind === 'protocol');
  await assert.rejects(make(recorder(reply(201, ok(studyView()))).transport).execute('create', createInput, { idempotencyKey: IDEM }), error => error.kind === 'protocol');
});

const badResults = [
  ['create', studyView({ study_id: '' })],
  ['create', studyView({ groups: [{ brand_id: GROUP_A }] })],
  ['create', studyView({ result: null })],
  ['get', studyView({ study_id: 'other' })],
  ['get', studyView({ brand_context_revision: 7 })],
  ['confirm_keywords', studyView({ study_id: 'other' })],
  ['list', { items: [studyView({ status: 1 })], total: 1, page: 1, size: 20 }],
  ['list', { items: [], total: -1, page: 1, size: 20 }],
  ['report', []],
  ['report', null],
  ['comments', { term: 'x', total: '1', items: [] }],
  ['brand_videos', { items: [] }],
  ['brand_videos', ['v1']],
  ['materialize', { study_id: STUDY, execution_version: 0, scheduled: true }],
  ['regenerate', { study_id: 'other', execution_version: 2, scheduled: true }],
  ['refresh_existing_evidence', { study_id: STUDY, execution_version: 2, scheduled: false }],
  ['archive', { study_id: STUDY, archived: false }],
];
for (const [operation, data] of badResults) {
  test(`响应校验 ${operation}：不符合契约的 data 视为协议错误`, async () => {
    const rec = recorder(reply(statusFor(operation), ok(data)));
    await assert.rejects(make(rec.transport).execute(operation, entries[operation][0], optsFor(operation)), error => error.kind === 'protocol');
  });
}

test('协议错误：非 JSON、缺 meta、success 与状态矛盾、错误 code 不是 HTTP×100+1', async () => {
  for (const response of [reply(200, '<html>'), reply(200, { success: true, data: studyView(), error: null }), reply(200, { ...ok(studyView()), success: false }), reply(404, { ...fail(404, 'study_not_found'), success: true }), reply(404, { ...fail(404, 'study_not_found'), error: { code: 6002, message: 'study_not_found' } })]) {
    await assert.rejects(make(recorder(response).transport).execute('get', { study_id: STUDY }), error => error.kind === 'protocol');
  }
});

// ---------------------------------------------------------------------------------------------
// 错误与结果未知
// ---------------------------------------------------------------------------------------------
const errorTable = [
  ['get', 401, 'API key authentication required', undefined],
  ['get', 403, 'OpenAPI access denied', undefined],
  ['get', 404, 'study_not_found', 'study_not_found'],
  ['create', 409, 'study_creation_conflict', 'study_creation_conflict'],
  ['create', 400, 'invalid_study_request', 'invalid_study_request'],
  ['confirm_keywords', 400, 'invalid_study_request', 'invalid_study_request'],
  ['report', 409, 'study_state_not_allowed', 'study_state_not_allowed'],
  ['archive', 409, 'study_state_not_allowed', 'study_state_not_allowed'],
  ['comments', 400, 'invalid_study_request', 'invalid_study_request'],
  ['list', 413, 'payload_too_large', 'payload_too_large'],
  ['create', 422, 'Request validation failed: body.groups: Invalid field value or combination', undefined],
  ['regenerate', 429, 'Rate limit exceeded', undefined],
  ['materialize', 500, 'Internal server error', undefined],
  ['refresh_existing_evidence', 503, 'Authentication unavailable', undefined],
];
for (const [operation, status, message, reason] of errorTable) {
  test(`错误 ${operation} HTTP ${status}（${message}）：外层 code ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run(operation, argsFor(operation), reply(status, fail(status, message, { request_id: 'req-err' })));
    const error = result.diagnostic.error;
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, status);
    assert.equal(error.code, status * 100 + 1);
    assert.equal(error.reason, reason);
    assert.equal(error.request_id, 'req-err');
    assert.equal(error.outcome, lib.operations[operation].executes && status >= 500 ? 'unknown' : 'rejected');
    if (reason === undefined) assert.equal(JSON.stringify(error).includes(message), false);
  });
}

test('429：合法 Retry-After 原样提示，非法值不输出，且不自动重试', async () => {
  for (const [header, expected] of [['30', '30'], ['Sun, 15 Nov 2026 00:00:30 GMT', 'Sun, 15 Nov 2026 00:00:30 GMT'], ['soon', undefined], [undefined, undefined]]) {
    const result = await run('create', argsFor('create'), reply(429, fail(429, 'Rate limit exceeded'), header === undefined ? {} : { 'Retry-After': header }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.retry_after, expected);
  }
});

test('结果未知：动作类超时、断连、5xx、无效响应标为 unknown 且只调用一次；create 提示用同一个键恢复', async () => {
  for (const operation of ['create', 'confirm_keywords', 'refresh_brand_context', 'materialize', 'regenerate', 'refresh_existing_evidence', 'archive']) {
    const input = entries[operation][0];
    const opts = optsFor(operation);
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, input, opts), error => error.kind === 'timeout' && error.outcome === 'unknown' && (operation !== 'create' || error.message.includes('同一个 Idempotency-Key')));
    let attempts = 0;
    await assert.rejects(make(async () => { attempts++; throw new Error(`socket ${SECRET}`); }).execute(operation, input, opts), error => error.kind === 'network' && error.outcome === 'unknown' && !error.message.includes(SECRET));
    assert.equal(attempts, 1);
    await assert.rejects(make(recorder(reply(200, '<html>')).transport).execute(operation, input, opts), error => error.kind === 'protocol' && error.outcome === 'unknown');
  }
  for (const operation of ['list', 'get', 'report', 'comments', 'brand_videos']) {
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, entries[operation][0]), error => error.outcome === 'unavailable');
    const read = await run(operation, argsFor(operation), reply(503, fail(503, 'Service unavailable')));
    assert.equal(read.diagnostic.error.outcome, 'rejected');
  }
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本、品牌名和异常堆栈不进入错误输出', async () => {
  const input = { groups: [group({ name: 'SecretBrandX', seed_keywords: ['secretbrandx'] })], scope: { platforms: ['tiktok'] } };
  const result = await run('create', ['--input-file', writeInput(input), '--idempotency-key', IDEM], reply(500, fail(500, 'Traceback: model token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2', 'SecretBrandX']) assert.equal(text.includes(leaked), false, leaked);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('get', { args: [json({ study_id: STUDY })], client: { execute: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI 与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI：支持内联 JSON、--input-file 和带 BOM 的文件；调用方式错误返回 1 且不发请求', async () => {
  for (const args of [[json({ study_id: STUDY })], ['--input-file', writeInput({ study_id: STUDY })], ['--input-file', writeInput({ study_id: STUDY }, { bom: true })]]) {
    assert.equal((await run('get', args, success('get'))).code, 0);
  }
  const file = writeInput({ study_id: STUDY });
  for (const args of [[], ['--input-file'], ['--input-file', join(tempDir, 'missing.json')], ['{bad'], ['--wait', '--input-file', file], ['--idempotency-key', IDEM, '--input-file', file], [json({}), '--input-file', file], ['--input-file', file, '--input-file', file]]) {
    const result = await run('get', args, success('get'));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
  }
  for (const args of [['--input-file', writeInput(createInput)], ['--input-file', writeInput(createInput), '--idempotency-key'], ['--input-file', writeInput(createInput), '--output', outPath(), '--idempotency-key', IDEM]]) {
    const result = await run('create', args, success('create'));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.calls.length, 0);
  }
  const listOutput = await run('list', ['--input-file', writeInput({}), '--output', outPath()], success('list'));
  assert.equal(listOutput.code, 1);
  assert.equal(listOutput.calls.length, 0);
});

test('create 成功：stdout 是完整响应，stderr 提醒保存 study_id 和键、由用户确认后再 confirm', async () => {
  const result = await run('create', argsFor('create'), success('create'));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out[0]).data.study_id, STUDY);
  assert.ok(result.err[0].includes('不要自动确认'));
  assert.equal(result.calls[0].init.headers['Idempotency-Key'], IDEM);
});

test('get：report_state 不是 ready 时提醒报告不可交付；ready 时不提醒', async () => {
  const pending = await run('get', argsFor('get'), success('get'));
  assert.equal(pending.err.length, 1);
  assert.ok(pending.err[0].includes('report_state=pending'));
  const stopped = await run('get', argsFor('get'), reply(200, ok(studyView({ status: 'completed', stage: 'report_ready', result: { report_state: 'regenerate_required' } }))));
  assert.ok(stopped.err[0].includes('regenerate'));
  const ready = await run('get', argsFor('get'), reply(200, ok(studyView({ status: 'completed', stage: 'report_ready', result: { report_state: 'ready', report: { summary: {} } } }))));
  assert.equal(ready.err.length, 0);
});

test('动作成功提醒：confirm 不代表报告可交付，refresh_existing_evidence 的 202 只是受理，archive 不删除事实', async () => {
  for (const [operation, phrase] of [['confirm_keywords', '不代表报告已可交付'], ['refresh_brand_context', '新的 revision'], ['materialize', '不要放进轮询'], ['regenerate', '正式交付校验'], ['refresh_existing_evidence', '202'], ['archive', '不会被删除']]) {
    const result = await run(operation, argsFor(operation), success(operation));
    assert.equal(result.code, 0, operation);
    assert.ok(result.err[0].includes(phrase), operation);
  }
});

test('report / get 的 --output：完整响应写入文件，stdout 只给摘要；文件已存在时不覆盖', async () => {
  const output = outPath();
  const report = { summary: { headline: 'demo-secret-insight' }, marketing_videos: { [GROUP_A]: [] } };
  const done = await run('report', ['--input-file', writeInput({ study_id: STUDY }), '--output', output], reply(200, ok(report)));
  assert.equal(done.code, 0);
  assert.deepEqual(JSON.parse(done.out[0]).data, { output, keys: ['summary', 'marketing_videos'] });
  assert.equal(done.out[0].includes('demo-secret-insight'), false);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).data, report);
  const getOut = outPath();
  const got = await run('get', ['--input-file', writeInput({ study_id: STUDY }), '--output', getOut], success('get'));
  assert.deepEqual(JSON.parse(got.out[0]).data, { output: getOut, study_id: STUDY, status: 'running', stage: 'awaiting_keyword_confirm', report_state: 'pending', brand_context_revision: REVISION });
  writeFileSync(output, 'keep');
  const again = await run('report', ['--input-file', writeInput({ study_id: STUDY }), '--output', output], reply(200, ok(report)));
  assert.equal(again.code, 1);
  assert.equal(readFileSync(output, 'utf8'), 'keep');
});

for (const [operation, [input]] of Object.entries(entries)) {
  test(`入口脚本 competitor_tracking_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`competitor_tracking_${operation}.mjs`);
    const rec = recorder(success(operation));
    assert.equal(await mod.main({ args: argsFor(operation, input), client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(pathOf(rec.calls[0]), lib.operations[operation].path);
    const proc = spawnSync(process.execPath, [join(scripts, `competitor_tracking_${operation}.mjs`), ...argsFor(operation, input)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('竞品追踪脚本不含硬编码地址、Key 或 Authorization 头', () => {
  const files = readdirSync(scripts).filter(name => name.includes('competitor_tracking'));
  assert.equal(files.length, 14);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s|influxai_/i.test(source), false, name);
  }
});
