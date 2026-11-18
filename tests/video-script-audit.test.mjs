// Isolated tests for the script and video audit scripts. No real network, backend, IMM, model or key is used:
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
const lib = await load('_video_script_audit_client.mjs');
const cli = await load('_video_script_audit_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
const SESSION = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const PROJECT = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const URL1 = 'https://oss.example.com/skill-uploads/0519aea0602e444bba06fa3197f0fd29/0edb0a00-b96d-48c6-a840-c58f3df91fd2.pdf';
const PREFIX = '/v1/video-script-audit';

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const sessionView = (over = {}) => ({ session_id: SESSION, name: null, industry: 'ecommerce', category: null, session_type: 'video_script_audit', status: 'pending', created_at: '2026-11-16T12:00:00', updated_at: '2026-11-16T12:00:00', parent_id: null, ...over });
const stageView = (stage, status = 'processing', over = {}) => ({ session_id: SESSION, stage, status, error_code: null, ...over });
const STAGE_NAMES = ['brief_upload', 'brief_upload_script', 'brief_parse', 'script_qc', 'video_upload', 'video_analysis', 'content_audit'];
const allStagesOf = (status = 'pending', over = {}) => Object.fromEntries(STAGE_NAMES.map(name => [name, { status, error_code: null, ...(over[name] ?? {}) }]));
const resultView = (over = {}) => ({ session: { session_id: SESSION, name: null, session_type: 'video_script_audit', parent_id: null, industry: 'ecommerce', status: 'processing', created_at: '2026-11-16T12:00:00' }, materials: [], stages: allStagesOf('pending', { brief_parse: { status: 'completed' } }), brief_parse: {}, script_audit: { overall_score: null, final_report: { revision_plan: [] }, dimensions: {}, html_report_url: null }, video_audit: { status: null, overall_verdict: null, overall_score: null, final_report: { revision_plan: [] }, dimension_scores: {}, must_say: [], dont_say: [], must_show: [], dont_show: [], selling_point: [], html_report_url: null }, ...over });
const SCRIPT_REPORT = `https://oss.example.com/content-audit-demo/${'3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f'}/script-qc-report-a1b2.html`;
const VIDEO_REPORT = `https://oss.example.com/content-audit-demo/${'3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f'}/audit-report-c3d4.html`;
const withReports = (script = SCRIPT_REPORT, video = VIDEO_REPORT) => { const v = resultView(); v.script_audit.html_report_url = script; v.video_audit.html_report_url = video; v.video_audit.status = 'completed'; return v; };
const pageOf = items => ({ items, total: items.length, page: 1, size: 20 });
const entries = {
  create: [{ mode: 'independent', industry: 'ecommerce' }, '/sessions/create', sessionView()],
  projects_list: [{}, '/projects/list', pageOf([sessionView({ session_id: PROJECT, session_type: 'video_script_session_audit_project' })])],
  projects_get: [{ project_session_id: PROJECT }, '/projects/get', { project_session_id: PROJECT, name: 'Demo 项目', industry: 'game', category: null, session_type: 'video_script_session_audit_project', status: 'pending' }],
  sessions_list: [{ project_session_id: PROJECT, page: 1, size: 20 }, '/sessions/list', pageOf([sessionView({ parent_id: PROJECT, project_session_id: PROJECT })])],
  history: [{ page: 1, size: 20 }, '/sessions/history', pageOf([sessionView()])],
  import: [{ session_id: SESSION, material_type: 'brief', source_url: URL1, parameters: { doc_type: 'client' } }, '/sessions/materials/import', { session_id: SESSION, material_id: '11111111-2222-4333-8444-555555555555', material_type: 'brief', status: 'processing' }],
  execute: [{ session_id: SESSION, action: 'parse_brief' }, '/sessions/stages/execute', { session_id: SESSION, action: 'parse_brief', status: 'processing', task_id: null }],
  status: [{ session_id: SESSION, stage: 'brief_parse' }, '/sessions/stages/status', stageView('brief_parse', 'completed')],
  result: [{ session_id: SESSION }, '/sessions/result', resultView()],
};
const okFor = operation => entries[operation][2];
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const success = operation => reply(200, ok(okFor(operation)));

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createVideoScriptAuditClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'video-script-audit-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let counter = 0;
const json = value => JSON.stringify(value);
const writeInput = value => { const path = join(tempDir, `in-${counter++}.json`); writeFileSync(path, typeof value === 'string' ? value : json(value)); return path; };
const outPath = () => join(tempDir, `out-${counter++}.json`);
const argsFor = (operation, input = entries[operation][0]) => ['--input-file', writeInput(input)];
async function run(operation, args, responses, options = {}) {
  const rec = recorder(responses);
  const out = [];
  const err = [];
  const sleeps = [];
  const code = await cli.runCli(operation, { args, client: make(rec.transport), stdout: v => out.push(v), stderr: v => err.push(v), sleep: async ms => { sleeps.push(ms); }, ...options });
  const last = err.at(-1);
  return { code, out, err, sleeps, calls: rec.calls, diagnostic: last?.startsWith('{') ? JSON.parse(last) : null };
}

// ---------------------------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------------------------
test('九个操作与九个入口脚本一一对应；动作类分组正确；不开放增强审核和 reports', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => v.executes).map(([k]) => k).sort(), ['create', 'execute', 'import']);
  assert.equal(lib.ACTIONS.includes('run_enhancement'), false);
  assert.equal(lib.STAGES.includes('enhancement'), false);
  for (const { path } of Object.values(lib.operations)) assert.equal(/report|enhancement/.test(path), false, path);
});

for (const [operation, [input, path]] of Object.entries(entries)) {
  test(`${operation}: 路径、方法、请求头、请求体原样发送，成功 HTTP 200`, async () => {
    const rec = recorder(success(operation));
    const result = await make(rec.transport).execute(operation, input);
    const [call] = rec.calls;
    assert.equal(rec.calls.length, 1);
    assert.equal(call.url, `https://scout.example.com/openapi${PREFIX}${path}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-API-Key'], SECRET);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, input);
    for (const forbidden of ['user_id', 'team_id', 'api_key']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('create 三种 mode：project 与 independent 带 industry，collaboration 带 project_session_id 且继承行业', async () => {
  const cases = [
    [{ mode: 'project', industry: 'game', name: 'Demo 项目', category: 'rpg' }, sessionView({ session_id: PROJECT, project_session_id: PROJECT, session_type: 'video_script_session_audit_project' })],
    [{ mode: 'independent', industry: 'ecommerce', name: '独立审核' }, sessionView()],
    [{ mode: 'collaboration', project_session_id: PROJECT, name: '达人 A' }, sessionView({ parent_id: PROJECT, project_session_id: PROJECT })],
  ];
  for (const [input, data] of cases) {
    const rec = recorder(reply(200, ok(data)));
    await make(rec.transport).execute('create', input);
    assert.deepEqual(rec.calls[0].body, input, input.mode);
  }
});

test('不替服务端补默认值：list、history 不补分页，status 不补 stage', async () => {
  for (const [operation, input, data] of [['projects_list', {}, pageOf([])], ['history', {}, pageOf([])], ['status', { session_id: SESSION }, { session_id: SESSION, stages: allStagesOf() }]]) {
    const rec = recorder(reply(200, ok(data)));
    await make(rec.transport).execute(operation, input);
    assert.deepEqual(rec.calls[0].body, input, operation);
  }
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['http://127.0.0.1:8010/openapi', 'http://127.0.0.1:8010/openapi'], ['https://scout.example.com/api/', 'https://scout.example.com/api/openapi']]) {
    const rec = recorder(success('history'));
    await lib.createVideoScriptAuditClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('history', {});
    assert.equal(rec.calls[0].url, `${expected}${PREFIX}/sessions/history`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: ' ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'ftp://x', apiKey: SECRET }]) {
    assert.throws(() => lib.createVideoScriptAuditClient(options), error => error.kind === 'configuration');
  }
});

// ---------------------------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------------------------
const rejects = [
  ['create', {}, '缺 mode'],
  ['create', { mode: 'team', industry: 'ecommerce' }, '未知 mode'],
  ['create', { mode: 'independent' }, 'independent 缺 industry'],
  ['create', { mode: 'project', industry: 'beauty' }, '未知行业'],
  ['create', { mode: 'project', industry: 'game', project_session_id: PROJECT }, 'project 带 project_session_id'],
  ['create', { mode: 'collaboration' }, 'collaboration 缺项目'],
  ['create', { mode: 'collaboration', project_session_id: PROJECT, industry: 'game' }, 'collaboration 带 industry'],
  ['create', { mode: 'collaboration', project_session_id: PROJECT, category: 'x' }, 'collaboration 带 category'],
  ['create', { mode: 'collaboration', project_session_id: 'abc' }, '项目 ID 不是 UUID'],
  ['create', { mode: 'independent', industry: 'ecommerce', name: '' }, '空名称'],
  ['create', { mode: 'independent', industry: 'ecommerce', name: 'n'.repeat(257) }, '名称过长'],
  ['create', { mode: 'independent', industry: 'ecommerce', category: 'c'.repeat(65) }, '分类过长'],
  ['create', { mode: 'independent', industry: 'ecommerce', user_id: 'u' }, '未开放字段'],
  ['projects_list', { page: 0 }, 'page 0'],
  ['projects_list', { size: 101 }, 'size 101'],
  ['projects_list', { size: null }, 'size null'],
  ['projects_get', {}, '缺项目 ID'],
  ['projects_get', { project_session_id: 42 }, '数字 ID'],
  ['sessions_list', { page: 1 }, '缺项目 ID'],
  ['history', { session_type: 'other' }, '未知 session_type'],
  ['history', { parent_id: 'x' }, 'parent_id 不是 UUID'],
  ['history', { root_only: 'true' }, '字符串布尔'],
  ['history', { parent_id: PROJECT, root_only: true }, 'parent_id 与 root_only 同时'],
  ['history', { parent_id: PROJECT, root_only: false }, 'parent_id 与 root_only=false 同时'],
  ['import', { session_id: SESSION, material_type: 'brief', source_url: URL1 }, 'brief 缺 doc_type'],
  ['import', { session_id: SESSION, material_type: 'brief', source_url: URL1, parameters: { doc_type: 'other' } }, '未知 doc_type'],
  ['import', { session_id: SESSION, material_type: 'video', source_url: URL1, parameters: { doc_type: 'client' } }, 'video 带 doc_type'],
  ['import', { session_id: SESSION, material_type: 'image', source_url: URL1 }, '未知素材类型'],
  ['import', { session_id: SESSION, material_type: 'video', source_url: 'http://oss.example.com/a.mp4' }, '非 HTTPS'],
  ['import', { session_id: SESSION, material_type: 'video', source_url: 'https://user:pass@drive.google.com/file/d/x/view' }, '带用户名密码'],
  ['import', { session_id: SESSION, material_type: 'video', source_url: 'not a url' }, '不是 URL'],
  ['import', { session_id: SESSION, material_type: 'video', source_url: `https://oss.example.com/${'a'.repeat(2000)}` }, '超过 2000 字符'],
  ['import', { session_id: SESSION, material_type: 'video', source_url: URL1, parameters: { doc_type: null, lang: 'en' } }, 'parameters 未开放字段'],
  ['import', { material_type: 'video', source_url: URL1 }, '缺 session_id'],
  ['execute', { session_id: SESSION, action: 'run_enhancement' }, '增强审核不开放'],
  ['execute', { session_id: SESSION, action: 'report' }, '未知动作'],
  ['execute', { session_id: SESSION }, '缺 action'],
  ['status', { session_id: SESSION, stage: 'enhancement' }, '增强阶段不开放'],
  ['status', { session_id: SESSION, stage: 'video' }, '未知阶段'],
  ['status', { session_id: 'not-a-uuid' }, 'session_id 不是 UUID'],
  ['result', { session_id: SESSION, include_raw: true }, 'result 额外字段'],
  ['result', null, 'null 请求'],
];
for (const [operation, input, label] of rejects) {
  test(`输入校验 ${operation}：${label} 在本地拒绝且不发请求`, async () => {
    const rec = recorder(success(operation));
    await assert.rejects(make(rec.transport).execute(operation, input), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('边界值放行：size 100、名称 256 字符、视频不带 parameters 或带空 parameters、history 只带 root_only', async () => {
  const cases = [
    ['projects_list', { page: 3, size: 100 }, pageOf([])],
    ['create', { mode: 'independent', industry: 'game', name: 'n'.repeat(256), category: 'c'.repeat(64) }, sessionView()],
    ['import', { session_id: SESSION, material_type: 'video', source_url: URL1.replace('.pdf', '.mp4') }, { ...okFor('import'), material_type: 'video' }],
    ['import', { session_id: SESSION, material_type: 'video', source_url: URL1.replace('.pdf', '.mp4'), parameters: {} }, { ...okFor('import'), material_type: 'video' }],
    ['import', { session_id: SESSION, material_type: 'brief', source_url: URL1, parameters: { doc_type: 'script' } }, okFor('import')],
    ['import', { session_id: SESSION, material_type: 'brief', source_url: 'https://docs.google.com/document/d/abc/edit?usp=sharing', parameters: { doc_type: 'client' } }, okFor('import')],
    ['import', { session_id: SESSION, material_type: 'video', source_url: 'https://drive.google.com/file/d/abc/view#t=1' }, { ...okFor('import'), material_type: 'video' }],
    ['history', { root_only: true, session_type: 'video_script_session_audit_project' }, pageOf([])],
    ['history', { parent_id: PROJECT, root_only: null }, pageOf([])],
  ];
  for (const [operation, input, data] of cases) {
    const rec = recorder(reply(200, ok(data)));
    await make(rec.transport).execute(operation, input);
    assert.equal(rec.calls.length, 1, `${operation} ${JSON.stringify(input).slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------------------------
test('账务字段必须为 null 或缺省：任一有值视为协议错误', async () => {
  for (const operation of Object.keys(entries)) {
    for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) {
      const rec = recorder(reply(200, ok(okFor(operation), { [field]: field === 'credits_consumed' ? 0 : 'settled' })));
      await assert.rejects(make(rec.transport).execute(operation, entries[operation][0]), error => error.kind === 'protocol', `${operation} ${field}`);
    }
  }
});

const badResults = [
  ['create', sessionView({ session_id: 'x' })],
  ['create', sessionView({ status: undefined })],
  ['projects_list', { items: [], total: -1, page: 1, size: 20 }],
  ['projects_list', { items: ['x'], total: 1, page: 1, size: 20 }],
  ['projects_get', { project_session_id: SESSION }],
  ['history', { items: [], total: 0, page: 0, size: 20 }],
  ['import', { ...okFor('import'), session_id: PROJECT }],
  ['import', { ...okFor('import'), material_type: 'video' }],
  ['import', { ...okFor('import'), material_id: 5 }],
  ['execute', { ...okFor('execute'), action: 'run_audit' }],
  ['execute', { ...okFor('execute'), task_id: 7 }],
  ['status', stageView('brief_parse', null)],
  ['status', stageView('script_qc', 'completed')],
  ['status', { ...stageView('brief_parse', 'completed'), session_id: PROJECT }],
  ['status', stageView('brief_parse', 'completed', { error_code: 5 })],
  ['status', stageView('brief_parse', 'completed', { duration_ms: 1000 })],
  ['status', { session_id: SESSION, stages: { brief_upload: { status: 'completed', error_code: null } } }],
  ['result', resultView({ stages: { ...allStagesOf(), enhancement: { status: 'pending', error_code: null } } })],
  ['result', resultView({ stages: { brief_parse: { status: 'completed' } } })],
  ['result', resultView({ session: { session_id: PROJECT } })],
  ['result', resultView({ session: null })],
  ['result', resultView({ materials: null })],
  ['result', resultView({ materials: [{ material_type: 'image' }] })],
  ['result', resultView({ video_audit: [] })],
  ['result', resultView({ script_audit: 'x' })],
  ['result', resultView({ script_audit: { overall_score: 1, final_report: {}, dimensions: {}, html_report_url: 5 } })],
  ['result', resultView({ video_audit: { status: 'completed', html_report_url: { url: 'x' } } })],
  ['result', resultView({ script_audit: { overall_score: 1, final_report: {}, dimensions: {} } })],
  ['result', resultView({ brief_parse: [] })],
  ['result', []],
];
for (const [operation, data] of badResults) {
  test(`响应校验 ${operation}：${JSON.stringify(data).slice(0, 70)} 视为协议错误`, async () => {
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).execute(operation, entries[operation][0]), error => error.kind === 'protocol');
  });
}

test('响应校验：create project 必须返回相同的 project_session_id 和 session_id；collaboration 返回所属项目', async () => {
  await assert.rejects(make(recorder(reply(200, ok(sessionView({ session_id: PROJECT })))).transport).execute('create', { mode: 'project', industry: 'game' }), error => error.kind === 'protocol');
  await assert.rejects(make(recorder(reply(200, ok(sessionView({ project_session_id: SESSION })))).transport).execute('create', { mode: 'collaboration', project_session_id: PROJECT }), error => error.kind === 'protocol');
});

test('响应校验：全部阶段的 status 不能含 enhancement 或未开放阶段', async () => {
  const input = { session_id: SESSION };
  await make(recorder(reply(200, ok({ session_id: SESSION, stages: allStagesOf('pending', { video_upload: { duration_ms: 81493 } }) }))).transport).execute('status', input);
  for (const stages of [{ ...allStagesOf(), enhancement: { status: 'pending', error_code: null } }, { ...allStagesOf(), report: { status: 'pending', error_code: null } }, { brief_parse: { status: 'pending', error_code: null } }, allStagesOf('pending', { brief_parse: { status: null } }), allStagesOf('pending', { script_qc: { duration_ms: 5 } })]) {
    await assert.rejects(make(recorder(reply(200, ok({ session_id: SESSION, stages }))).transport).execute('status', input), error => error.kind === 'protocol', JSON.stringify(stages));
  }
});

test('响应校验：video_upload 的 data.stage 必须是阶段名；返回处理步骤（如 completed）视为协议错误', async () => {
  const input = { session_id: SESSION, stage: 'video_upload' };
  const view = { session_id: SESSION, stage: 'video_upload', video_id: 'v', status: 'completed', error_code: null, failed_stage: null };
  await make(recorder(reply(200, ok(view))).transport).execute('status', input);
  await assert.rejects(make(recorder(reply(200, ok({ ...view, stage: 'completed' }))).transport).execute('status', input), error => error.kind === 'protocol');
  const result = await run('status', argsFor('status', input), reply(200, ok(view)));
  assert.equal(result.code, 0);
  assert.ok(result.err.at(-1).includes('阶段 video_upload 已完成'));
  const output = outPath();
  const saved = await run('status', [...argsFor('status', input), '--output', output], reply(200, ok(view)));
  assert.deepEqual(JSON.parse(saved.out[0]).data, { output, session_id: SESSION, stage: 'video_upload', status: 'completed' });
});

test('协议错误：非 JSON、缺 meta、2xx 非 200、success 与状态矛盾、错误 code 不是 HTTP×100+1', async () => {
  for (const response of [reply(200, '<html>'), reply(200, { success: true, data: okFor('history'), error: null }), reply(202, ok(okFor('history'))), reply(200, { ...ok(okFor('history')), success: false }), reply(404, { ...fail(404, 'session_not_found'), success: true }), reply(404, { ...fail(404, 'session_not_found'), error: { code: 40101, message: 'session_not_found' } })]) {
    await assert.rejects(make(recorder(response).transport).execute('history', {}), error => error.kind === 'protocol');
  }
});

// ---------------------------------------------------------------------------------------------
// 错误与结果未知
// ---------------------------------------------------------------------------------------------
const errorTable = [
  ['history', 401, 'API key authentication required', undefined],
  ['projects_list', 403, 'OpenAPI access denied', undefined],
  ['projects_get', 404, 'session_not_found', 'session_not_found'],
  ['projects_get', 400, 'invalid_audit_request', 'invalid_audit_request'],
  ['import', 404, 'upload_reference_not_found', 'upload_reference_not_found'],
  ['import', 409, 'upload_reference_not_ready', 'upload_reference_not_ready'],
  ['import', 400, 'invalid_audit_request', 'invalid_audit_request'],
  ['execute', 409, 'audit_state_not_allowed', 'audit_state_not_allowed'],
  ['execute', 500, 'Internal server error', undefined],
  ['create', 422, 'Request validation failed: body: Invalid field value or combination', undefined],
  ['status', 429, 'Rate limit exceeded', undefined],
  ['import', 503, 'upload_status_unavailable', 'upload_status_unavailable'],
  ['result', 413, 'payload_too_large', 'payload_too_large'],
];
for (const [operation, status, message, reason] of errorTable) {
  test(`错误 ${operation} HTTP ${status}（${message}）：外层 code ${status * 100 + 1}，只输出受控 reason`, async () => {
    const result = await run(operation, argsFor(operation), reply(status, fail(status, message, { request_id: 'req-err' })));
    const error = result.diagnostic.error;
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.deepEqual([error.kind, error.status, error.code, error.reason, error.request_id], ['http', status, status * 100 + 1, reason, 'req-err']);
    assert.equal(error.outcome, lib.operations[operation].executes && status >= 500 ? 'unknown' : 'rejected');
    if (reason === undefined) assert.equal(JSON.stringify(error).includes(message), false);
  });
}

test('429：合法 Retry-After 原样提示，非法值不输出，且不自动重试', async () => {
  for (const [header, expected] of [['30', '30'], ['Mon, 16 Nov 2026 00:00:30 GMT', 'Mon, 16 Nov 2026 00:00:30 GMT'], ['soon', undefined]]) {
    const result = await run('execute', argsFor('execute'), reply(429, fail(429, 'Rate limit exceeded'), { 'Retry-After': header }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.retry_after, expected);
  }
});

test('结果未知：create、import、execute 超时、断连、无效响应标 unknown 且只调用一次；只读操作标 unavailable', async () => {
  for (const [operation, hint] of [['create', 'history'], ['import', '不要重复导入'], ['execute', '不要重复执行']]) {
    const input = entries[operation][0];
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, input), error => error.kind === 'timeout' && error.outcome === 'unknown' && error.message.includes(hint));
    let attempts = 0;
    await assert.rejects(make(async () => { attempts++; throw new Error(`socket ${SECRET}`); }).execute(operation, input), error => error.kind === 'network' && error.outcome === 'unknown' && !error.message.includes(SECRET));
    assert.equal(attempts, 1);
    await assert.rejects(make(recorder(reply(200, '<html>')).transport).execute(operation, input), error => error.kind === 'protocol' && error.outcome === 'unknown');
  }
  for (const operation of ['projects_list', 'projects_get', 'sessions_list', 'history', 'status', 'result']) {
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, entries[operation][0]), error => error.outcome === 'unavailable');
  }
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本、素材地址和异常堆栈不进入错误输出', async () => {
  const result = await run('import', argsFor('import'), reply(500, fail(500, 'Traceback: imm token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2', 'skill-uploads']) assert.equal(text.includes(leaked), false, leaked);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('history', { args: [json({})], client: { execute: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI、轮询与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI 参数：内联 JSON 与 --input-file（可带 BOM）；参数错误返回 1 且不发请求', async () => {
  const bom = writeInput(`\uFEFF${json({})}`);
  for (const args of [[json({})], ['--input-file', bom]]) assert.equal((await run('history', args, success('history'))).code, 0);
  const file = writeInput({ session_id: SESSION });
  for (const [operation, args] of [['history', []], ['history', ['--input-file']], ['history', ['{bad']], ['history', ['--wait', '--input-file', bom]], ['history', ['--output', outPath(), '--input-file', bom]], ['result', ['--wait', '--input-file', file]], ['status', ['--input-file', file, '--wait']], ['execute', ['--input-file', writeInput(entries.execute[0]), '--wait']]]) {
    const result = await run(operation, args, success(operation));
    assert.equal(result.code, 1, `${operation} ${JSON.stringify(args)}`);
    assert.equal(result.calls.length, 0);
  }
});

test('动作成功提醒：create 保存 ID，import 指向对应上传阶段，execute 给出对应阶段且不要重复执行', async () => {
  const created = await run('create', argsFor('create'), success('create'));
  assert.ok(created.err[0].includes('保存 data.session_id'));
  const imported = await run('import', argsFor('import'), success('import'));
  assert.ok(imported.err[0].includes('brief_upload'));
  for (const [action, stage] of Object.entries(lib.ACTION_STAGE)) {
    const result = await run('execute', argsFor('execute', { session_id: SESSION, action }), reply(200, ok({ session_id: SESSION, action, status: 'processing', task_id: '9' })));
    assert.ok(result.err[0].includes('不要重复执行'));
    assert.ok(result.err[1].includes(`stage=${stage}`));
  }
});

test('status 单阶段提醒：completed、partial、各种失败、pending、进行中分别说明；失败退出码 1', async () => {
  const cases = [['completed', '已完成', 0], ['partial', '部分完成', 0], ['failed', '失败', 1], ['transcode_failed', '失败', 1], ['download_failed', '不要自动重试', 1], ['pending', '不代表已入队', 0], ['processing', '进行中', 0]];
  for (const [status, phrase, code] of cases) {
    const result = await run('status', argsFor('status', { session_id: SESSION, stage: 'video_analysis' }), reply(200, ok(stageView('video_analysis', status))));
    assert.equal(result.code, code, status);
    assert.ok(result.err.at(-1).includes(phrase), status);
  }
});

test('status --wait：每 10 秒查询一次，pending、processing 继续等，到完成或失败停止', async () => {
  const input = { session_id: SESSION, stage: 'video_analysis' };
  const result = await run('status', [...argsFor('status', input), '--wait'], [reply(200, ok(stageView('video_analysis', 'pending'))), reply(200, ok(stageView('video_analysis', 'processing'))), reply(200, ok(stageView('video_analysis', 'completed')))]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.sleeps, [10000, 10000]);
  assert.deepEqual(cli.WAIT, { intervalMs: 10000, attempts: 60 });
  const failed = await run('status', [...argsFor('status', input), '--wait'], [reply(200, ok(stageView('video_analysis', 'processing'))), reply(200, ok(stageView('video_analysis', 'slice_failed')))]);
  assert.equal(failed.code, 1);
  assert.equal(failed.calls.length, 2);
});

test('status --wait：预算用完仍未结束时退出码 2，提示用同一个 session_id 再查、不要重复执行', async () => {
  const result = await run('status', [...argsFor('status', { session_id: SESSION, stage: 'content_audit' }), '--wait'], reply(200, ok(stageView('content_audit', 'processing'))), { wait: { intervalMs: 10000, attempts: 3 } });
  assert.equal(result.code, 2);
  assert.equal(result.calls.length, 3);
  assert.ok(result.diagnostic.wait.message.includes('不要重复执行'));
});

test('--output：status 与 result 的完整响应写入文件，stdout 只给摘要；文件已存在时不覆盖', async () => {
  const output = outPath();
  const done = await run('result', [...argsFor('result'), '--output', output], success('result'));
  assert.equal(done.code, 0);
  assert.deepEqual(JSON.parse(done.out[0]).data, { output, session_id: SESSION, stages: Object.fromEntries(STAGE_NAMES.map(name => [name, name === 'brief_parse' ? 'completed' : 'pending'])), video_audit_status: null, script_audit_html_report_url: null, video_audit_html_report_url: null });
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).data, okFor('result'));
  const all = outPath();
  const stages = await run('status', ['--input-file', writeInput({ session_id: SESSION }), '--output', all], reply(200, ok({ session_id: SESSION, stages: allStagesOf('pending', { brief_upload: { status: 'completed' } }) })));
  assert.deepEqual(JSON.parse(stages.out[0]).data, { output: all, session_id: SESSION, stages: Object.fromEntries(STAGE_NAMES.map(name => [name, name === 'brief_upload' ? 'completed' : 'pending'])) });
  writeFileSync(output, 'keep');
  const again = await run('result', [...argsFor('result'), '--output', output], success('result'));
  assert.equal(again.code, 1);
  assert.equal(readFileSync(output, 'utf8'), 'keep');
});

test('result html_report_url：有效 URL 原样通过，--output 摘要直接给出两个报告链接', async () => {
  const data = withReports();
  const res = await make(recorder(reply(200, ok(data))).transport).execute('result', { session_id: SESSION });
  assert.equal(res.data.script_audit.html_report_url, SCRIPT_REPORT);
  assert.equal(res.data.video_audit.html_report_url, VIDEO_REPORT);
  const output = outPath();
  const done = await run('result', [...argsFor('result'), '--output', output], reply(200, ok(data)));
  assert.equal(done.code, 0);
  const summary = JSON.parse(done.out[0]).data;
  assert.equal(summary.script_audit_html_report_url, SCRIPT_REPORT);
  assert.equal(summary.video_audit_html_report_url, VIDEO_REPORT);
  assert.equal(summary.video_audit_status, 'completed');
});

test('result html_report_url：报告未生成时为 null，摘要给 null；报告对象缺省或为 null 也接受', async () => {
  const output = outPath();
  const done = await run('result', [...argsFor('result'), '--output', output], reply(200, ok(withReports(null, null))));
  assert.equal(done.code, 0);
  const summary = JSON.parse(done.out[0]).data;
  assert.equal(summary.script_audit_html_report_url, null);
  assert.equal(summary.video_audit_html_report_url, null);
  for (const over of [{ script_audit: null, video_audit: null }, { script_audit: undefined, video_audit: undefined }]) {
    const data = resultView(over);
    await make(recorder(reply(200, ok(data))).transport).execute('result', { session_id: SESSION });
    const out = outPath();
    const r = await run('result', [...argsFor('result'), '--output', out], reply(200, ok(data)));
    assert.equal(JSON.parse(r.out[0]).data.video_audit_html_report_url, null, JSON.stringify(over));
  }
});

test('result html_report_url：不是字符串或 null（数字、对象、缺失）视为协议错误，CLI 退出码 1 且不写文件', async () => {
  for (const bad of [5, { href: SCRIPT_REPORT }, undefined]) {
    const data = withReports();
    if (bad === undefined) delete data.video_audit.html_report_url; else data.video_audit.html_report_url = bad;
    await assert.rejects(make(recorder(reply(200, ok(data))).transport).execute('result', { session_id: SESSION }), error => error.kind === 'protocol', String(bad));
    const output = outPath();
    const r = await run('result', [...argsFor('result'), '--output', output], reply(200, ok(data)));
    assert.equal(r.code, 1);
    assert.equal(existsSync(output), false);
  }
});

for (const [operation, [input]] of Object.entries(entries)) {
  test(`入口脚本 video_script_audit_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`video_script_audit_${operation}.mjs`);
    const rec = recorder(success(operation));
    assert.equal(await mod.main({ args: argsFor(operation, input), client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.ok(rec.calls[0].url.endsWith(lib.operations[operation].path));
    const proc = spawnSync(process.execPath, [join(scripts, `video_script_audit_${operation}.mjs`), ...argsFor(operation, input)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('审核脚本不含硬编码地址、Key 或 Authorization 头，也不自己上传文件或调用增强审核与 reports', () => {
  const files = readdirSync(scripts).filter(name => name.includes('video_script_audit'));
  assert.equal(files.length, 11);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s|influxai_/i.test(source), false, name);
    assert.equal(/media_uoload|FormData|openAsBlob|\/reports\//.test(source), false, name);
  }
});
