// Isolated tests for the brief analysis scripts. No real network, backend, model or key is used:
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
const lib = await load('_brief_analysis_client.mjs');
const cli = await load('_brief_analysis_cli.mjs');

const SECRET = 'test-secret-key-0123456789';
// An id above 2^53 proves BIGINT ids never pass through JSON numbers.
const ID = '9007199254740993';
const MAX_ID = '9223372036854775807';
const IDEM = 'brief-demo-0001';
const OSS = 'https://oss.example.com/skill-uploads/0519aea0602e444bba06fa3197f0fd29/0edb0a00-b96d-48c6-a840-c58f3df91fd2.docx';
const PREFIX = '/v1/brief-analysis';

const meta = (extra = {}) => ({ request_id: 'req-1', credits_consumed: null, billing_status: null, billing_operation_id: null, ...extra });
const progress = { stage: 'queued', total_pages: null, completed_pages: 0, total_batches: 0, completed_batches: 0, resume_attempts: 0, started_at: null, updated_at: null };
const report = { schema_version: 'brief-analysis/v2', data: { context: [{ id: 'fact-1', label: '品牌', concept: 'brand', text: 'DemoBrand' }] }, annotations: { 'fact-1': { status: 'needs_confirmation', review_status: 'unreviewed', source: 'document' } }, issues: [], sources: [], document_warnings: [], multiple_campaigns: false };
const taskView = (over = {}) => ({
  id: ID, file_name: 'brief.docx', file_type: 'docx', file_size_bytes: 41156, status: 'queued', stage: 'queued', attempt_no: 1, result_version: 0, current_result: null,
  error_code: null, error_message: null, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z', progress, retry_policy: null, ...over,
});
const doneView = (over = {}) => taskView({ status: 'succeeded', stage: 'completed', result_version: 1, current_result: report, ...over });
const draft = { task_id: ID, result_version: 1, draft: { schema_version: 'campaign-creation-draft/v1', basic_info: {} }, validation: { mode: 'submit', is_valid: false, missing_fields: ['basic_info.campaign_name', 'compensation'], issues: [{ field: 'compensation', code: 'missing', message: '至少启用一种报酬方式且金额有效' }] }, warnings: [], blocking_fields: [], source_result: report, unmapped_fact_ids: ['fact-1'] };
const editInput = { task_id: ID, schema_version: 'brief-analysis/v2', expected_version: 1, data: report.data, confirmed_fields: ['fact-1'] };
const entries = {
  options: [{}, '/options', { enabled: true, extensions: [...lib.BRIEF_EXTENSIONS], max_file_bytes: 52428800, max_pages: 30, max_attempts: 3 }],
  submit: [{ oss_url: OSS }, '/submit', taskView()],
  status: [{ task_id: ID }, '/status', doneView()],
  list: [{ page: 1, size: 20 }, '/list', { items: [taskView()], page: 1, size: 20, total: 1 }],
  edit: [editInput, '/edit', doneView({ result_version: 2 })],
  retry: [{ task_id: ID }, '/retry', taskView({ attempt_no: 2 })],
  campaign_draft: [{ task_id: ID, version: 1 }, '/campaign-draft', draft],
};
const okFor = operation => entries[operation][2];
const statusFor = operation => lib.operations[operation].success;
const ok = (data, extra) => ({ success: true, data, error: null, meta: meta(extra) });
const fail = (status, message, extra) => ({ success: false, data: null, error: { code: status * 100 + 1, message }, meta: meta(extra) });
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const success = operation => reply(statusFor(operation), ok(okFor(operation)));
const optsFor = operation => (operation === 'submit' ? { idempotencyKey: IDEM } : undefined);

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, transport };
}
const make = (transport, extra = {}) => lib.createBriefAnalysisClient({ baseUrl: 'https://scout.example.com', apiKey: SECRET, transport, ...extra });
const tempDir = mkdtempSync(join(tmpdir(), 'brief-analysis-test-'));
test.after(() => rmSync(tempDir, { recursive: true, force: true }));
let counter = 0;
const json = value => JSON.stringify(value);
const writeInput = value => { const path = join(tempDir, `in-${counter++}.json`); writeFileSync(path, typeof value === 'string' ? value : json(value)); return path; };
const outPath = () => join(tempDir, `out-${counter++}.json`);
const argsFor = (operation, input = entries[operation][0]) => ['--input-file', writeInput(input), ...(operation === 'submit' ? ['--idempotency-key', IDEM] : [])];
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
test('七个操作与七个入口脚本一一对应；动作类与 202 操作分组正确', () => {
  assert.deepEqual(Object.keys(lib.operations).sort(), Object.keys(entries).sort());
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => v.executes).map(([k]) => k).sort(), ['edit', 'retry', 'submit']);
  assert.deepEqual(Object.entries(lib.operations).filter(([, v]) => v.success === 202).map(([k]) => k).sort(), ['retry', 'submit']);
  assert.equal(lib.BRIEF_EXTENSIONS.length, 14);
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
    assert.equal(call.init.headers['Idempotency-Key'], operation === 'submit' ? IDEM : undefined);
    assert.deepEqual(call.body, input);
    for (const forbidden of ['user_id', 'team_id', 'api_key', 'idempotency_key']) assert.equal(forbidden in call.body, false);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.url.includes(SECRET) || call.init.body.includes(SECRET), false);
    assert.equal(result.success, true);
  });
}

test('BIGINT：task_id 以十进制字符串原样发送，包括超过 2^53 和 int64 最大值', async () => {
  for (const id of [ID, MAX_ID, '1']) {
    const rec = recorder(reply(200, ok(doneView({ id }))));
    await make(rec.transport).execute('status', { task_id: id });
    assert.ok(rec.calls[0].init.body.includes(`"${id}"`));
  }
});

test('不替服务端补默认值：list 不补分页，edit 不补 confirmed_fields', async () => {
  for (const [operation, input] of [['list', {}], ['edit', { ...editInput, confirmed_fields: undefined }]]) {
    const rec = recorder(success(operation));
    await make(rec.transport).execute(operation, input);
    assert.deepEqual(rec.calls[0].body, JSON.parse(JSON.stringify(input)), operation);
  }
});

test('Idempotency-Key：submit 必须提供且为 1～128 个可打印字符、不能全空白；其他操作不接受', async () => {
  for (const key of [undefined, '', '   ', 'x'.repeat(129), '中文键', 'a\nb']) {
    const rec = recorder(success('submit'));
    await assert.rejects(make(rec.transport).execute('submit', { oss_url: OSS }, { idempotencyKey: key }), error => error.kind === 'input', JSON.stringify(key));
    assert.equal(rec.calls.length, 0);
  }
  for (const key of ['a', ' a ', 'x'.repeat(128), 'brief:2026/11/16 #1']) {
    const rec = recorder(success('submit'));
    await make(rec.transport).execute('submit', { oss_url: OSS }, { idempotencyKey: key });
    assert.equal(rec.calls[0].init.headers['Idempotency-Key'], key);
  }
  await assert.rejects(make(recorder(success('status')).transport).execute('status', { task_id: ID }, { idempotencyKey: IDEM }), error => error.kind === 'input');
});

test('服务地址：根地址、已带 /openapi、带路径前缀都只拼接一次 /openapi', async () => {
  for (const [baseUrl, expected] of [['https://scout.example.com', 'https://scout.example.com/openapi'], ['http://127.0.0.1:8010/openapi', 'http://127.0.0.1:8010/openapi'], ['https://scout.example.com/api/', 'https://scout.example.com/api/openapi']]) {
    const rec = recorder(success('options'));
    await lib.createBriefAnalysisClient({ baseUrl, apiKey: SECRET, transport: rec.transport }).execute('options', {});
    assert.equal(rec.calls[0].url, `${expected}${PREFIX}/options`);
  }
});

test('配置错误：缺少或空白的 Key、非法地址、含凭据的地址都在发请求前失败', () => {
  for (const options of [{ baseUrl: 'https://scout.example.com' }, { baseUrl: 'https://scout.example.com', apiKey: ' ' }, { baseUrl: 'nope', apiKey: SECRET }, { baseUrl: 'https://u:p@scout.example.com', apiKey: SECRET }, { baseUrl: 'ftp://x', apiKey: SECRET }]) {
    assert.throws(() => lib.createBriefAnalysisClient(options), error => error.kind === 'configuration');
  }
});

// ---------------------------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------------------------
const ossWith = ext => OSS.replace('.docx', `.${ext}`);
const rejects = [
  ['options', { verbose: true }, 'options 额外字段'],
  ['submit', {}, '缺 oss_url'],
  ['submit', { oss_url: '' }, '空 oss_url'],
  ['submit', { oss_url: 'http://oss.example.com/a.pdf' }, '非 HTTPS'],
  ['submit', { oss_url: `${OSS}?x-oss-signature=1` }, '带查询参数（签名 URL）'],
  ['submit', { oss_url: `${OSS}#p1` }, '带片段'],
  ['submit', { oss_url: 'not a url' }, '非 URL'],
  ['submit', { oss_url: `https://oss.example.com/${'a'.repeat(2048)}.pdf` }, '超过 2048 字符'],
  ['submit', { oss_url: ossWith('pptx') }, 'pptx 不能分析'],
  ['submit', { oss_url: ossWith('mp4') }, '视频不能分析'],
  ['submit', { oss_url: ossWith('mov') }, 'mov 不能分析'],
  ['submit', { oss_url: OSS, file_type: 'document' }, 'submit 额外字段'],
  ['status', {}, '缺 task_id'],
  ['status', { task_id: 1 }, 'JSON 数字'],
  ['status', { task_id: '0' }, '0'],
  ['status', { task_id: '01' }, '前导零'],
  ['status', { task_id: '-1' }, '负数'],
  ['status', { task_id: '9223372036854775808' }, '超过 int64'],
  ['status', { task_id: '12345678901234567890' }, '20 位'],
  ['status', { task_id: ID, include_result: true }, 'status 额外字段'],
  ['retry', { task_id: ID, force: true }, 'retry 额外字段'],
  ['list', { page: 0 }, 'page 0'],
  ['list', { size: 101 }, 'size 101'],
  ['list', { size: null }, 'size null'],
  ['list', { page: '1' }, '字符串页码'],
  ['list', { status: 'failed' }, '列表不开放状态筛选'],
  ['edit', { ...editInput, schema_version: 'brief-analysis/v1' }, '旧 schema'],
  ['edit', { ...editInput, expected_version: 0 }, 'expected_version 0'],
  ['edit', { ...editInput, expected_version: '1' }, '字符串版本'],
  ['edit', { ...editInput, data: null }, 'data null'],
  ['edit', { ...editInput, data: { summary: [] } }, 'data 未知分区'],
  ['edit', { ...editInput, data: { goals: {} } }, '分区不是数组'],
  ['edit', { ...editInput, confirmed_fields: 'fact-1' }, 'confirmed_fields 不是数组'],
  ['edit', { ...editInput, confirmed_fields: Array.from({ length: 1001 }, (_, i) => `f${i}`) }, '1001 个确认字段'],
  ['edit', { ...editInput, annotations: {} }, 'edit 额外字段'],
  ['edit', { ...editInput, data: { context: [{ text: 'x'.repeat(1000001) }] } }, '编辑内容过大'],
  ['campaign_draft', { task_id: ID }, '缺 version'],
  ['campaign_draft', { task_id: ID, version: 0 }, 'version 0'],
  ['campaign_draft', { task_id: ID, version: 1, create: true }, '额外字段'],
  ['status', null, 'null 请求'],
  ['status', [ID], '数组请求'],
];
for (const [operation, input, label] of rejects) {
  test(`输入校验 ${operation}：${label} 在本地拒绝且不发请求`, async () => {
    const rec = recorder(success(operation));
    await assert.rejects(make(rec.transport).execute(operation, input, optsFor(operation)), error => error.kind === 'input');
    assert.equal(rec.calls.length, 0);
  });
}

test('14 类 Brief 扩展名都能提交（大小写不敏感）', async () => {
  for (const ext of [...lib.BRIEF_EXTENSIONS, 'PDF', 'Docx']) {
    const rec = recorder(success('submit'));
    await make(rec.transport).execute('submit', { oss_url: ossWith(ext) }, { idempotencyKey: IDEM });
    assert.equal(rec.calls.length, 1, ext);
  }
});

// ---------------------------------------------------------------------------------------------
// 响应校验
// ---------------------------------------------------------------------------------------------
test('账务字段必须为 null 或缺省：任一有值视为协议错误', async () => {
  for (const operation of Object.keys(entries)) {
    for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) {
      const rec = recorder(reply(statusFor(operation), ok(okFor(operation), { [field]: field === 'credits_consumed' ? 0 : 'settled' })));
      await assert.rejects(make(rec.transport).execute(operation, entries[operation][0], optsFor(operation)), error => error.kind === 'protocol', `${operation} ${field}`);
    }
  }
});

test('成功状态码按操作区分：submit、retry 只认 202，其余只认 200', async () => {
  await assert.rejects(make(recorder(reply(200, ok(taskView()))).transport).execute('submit', { oss_url: OSS }, { idempotencyKey: IDEM }), error => error.kind === 'protocol' && error.outcome === 'unknown');
  await assert.rejects(make(recorder(reply(200, ok(taskView()))).transport).execute('retry', { task_id: ID }), error => error.kind === 'protocol');
  await assert.rejects(make(recorder(reply(202, ok(doneView()))).transport).execute('status', { task_id: ID }), error => error.kind === 'protocol');
});

const badResults = [
  ['options', { enabled: 'yes', extensions: [], max_file_bytes: 1, max_pages: 1, max_attempts: 1 }],
  ['options', { enabled: true, extensions: [1], max_file_bytes: 1, max_pages: 1, max_attempts: 1 }],
  ['submit', taskView({ id: 1 })],
  ['submit', taskView({ status: 'pending' })],
  ['status', doneView({ id: '42' })],
  ['status', doneView({ current_result: { schema_version: 'brief-analysis/v1', data: {} } })],
  ['status', doneView({ result_version: -1 })],
  ['status', doneView({ progress: null })],
  ['status', doneView({ retry_policy: [] })],
  ['list', { items: [doneView()], page: 1, size: 20, total: 1 }],
  ['list', { items: [], page: 1, size: 20, total: '0' }],
  ['edit', doneView({ id: '43' })],
  ['retry', taskView({ attempt_no: -1 })],
  ['campaign_draft', { ...draft, task_id: Number(ID) }],
  ['campaign_draft', { ...draft, task_id: '44' }],
  ['campaign_draft', { ...draft, validation: null }],
  ['campaign_draft', { ...draft, blocking_fields: 'budget' }],
  ['campaign_draft', { ...draft, validation: { ...draft.validation, mode: 'draft' } }],
  ['campaign_draft', { ...draft, validation: { ...draft.validation, is_valid: 'false' } }],
  ['campaign_draft', { ...draft, validation: { ...draft.validation, missing_fields: 'compensation' } }],
  ['campaign_draft', { ...draft, validation: { ...draft.validation, issues: null } }],
  ['campaign_draft', { ...draft, unmapped_fact_ids: [1] }],
];
for (const [operation, data] of badResults) {
  test(`响应校验 ${operation}：${JSON.stringify(data).slice(0, 70)} 视为协议错误`, async () => {
    await assert.rejects(make(recorder(reply(statusFor(operation), ok(data))).transport).execute(operation, entries[operation][0], optsFor(operation)), error => error.kind === 'protocol');
  });
}

test('协议错误：非 JSON、缺 meta、success 与状态矛盾、错误 code 不是 HTTP×100+1', async () => {
  for (const response of [reply(200, '<html>'), reply(200, { success: true, data: doneView(), error: null }), reply(200, { ...ok(doneView()), success: false }), reply(404, { ...fail(404, 'task_not_found'), success: true }), reply(404, { ...fail(404, 'task_not_found'), error: { code: 404, message: 'task_not_found' } })]) {
    await assert.rejects(make(recorder(response).transport).execute('status', { task_id: ID }), error => error.kind === 'protocol');
  }
});

// ---------------------------------------------------------------------------------------------
// 错误与结果未知
// ---------------------------------------------------------------------------------------------
const errorTable = [
  ['options', 401, 'API key authentication required', undefined],
  ['list', 403, 'OpenAPI access denied', undefined],
  ['status', 404, 'task_not_found', 'task_not_found'],
  ['submit', 404, 'upload_reference_not_found', 'upload_reference_not_found'],
  ['submit', 409, 'upload_reference_not_ready', 'upload_reference_not_ready'],
  ['submit', 409, 'brief_state_conflict', 'brief_state_conflict'],
  ['submit', 413, 'file_too_large', 'file_too_large'],
  ['submit', 415, 'unsupported_file_type', 'unsupported_file_type'],
  ['submit', 415, 'unsupported_format', 'unsupported_format'],
  ['submit', 422, 'upload_reference_integrity_failed', 'upload_reference_integrity_failed'],
  ['submit', 422, 'Request validation failed: header.Idempotency-Key: Field required', undefined],
  ['submit', 400, 'invalid_brief_request', 'invalid_brief_request'],
  ['edit', 409, 'brief_state_conflict', 'brief_state_conflict'],
  ['edit', 413, 'payload_too_large', 'payload_too_large'],
  ['retry', 409, 'brief_state_conflict', 'brief_state_conflict'],
  ['campaign_draft', 400, 'invalid_brief_request', 'invalid_brief_request'],
  ['retry', 429, 'brief_service_unavailable', 'brief_service_unavailable'],
  ['submit', 503, 'upload_storage_unavailable', 'upload_storage_unavailable'],
  ['submit', 500, 'Internal server error', undefined],
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
  for (const [header, expected] of [['30', '30'], ['Mon, 16 Nov 2026 00:00:30 GMT', 'Mon, 16 Nov 2026 00:00:30 GMT'], ['soon', undefined], [undefined, undefined]]) {
    const result = await run('submit', argsFor('submit'), reply(429, fail(429, 'Rate limit exceeded'), header === undefined ? {} : { 'Retry-After': header }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.diagnostic.error.retry_after, expected);
  }
});

test('结果未知：submit、edit、retry 超时、断连、无效响应标 unknown 且只调用一次；submit 提示用同一个键恢复', async () => {
  for (const operation of ['submit', 'edit', 'retry']) {
    const input = entries[operation][0];
    const opts = optsFor(operation);
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, input, opts), error => error.kind === 'timeout' && error.outcome === 'unknown' && (operation !== 'submit' || error.message.includes('同一个 Idempotency-Key')));
    let attempts = 0;
    await assert.rejects(make(async () => { attempts++; throw new Error(`socket ${SECRET}`); }).execute(operation, input, opts), error => error.kind === 'network' && error.outcome === 'unknown' && !error.message.includes(SECRET));
    assert.equal(attempts, 1);
    await assert.rejects(make(recorder(reply(statusFor(operation), '<html>')).transport).execute(operation, input, opts), error => error.kind === 'protocol' && error.outcome === 'unknown');
  }
  for (const operation of ['options', 'status', 'list', 'campaign_draft']) {
    await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 20 }).execute(operation, entries[operation][0]), error => error.outcome === 'unavailable');
  }
});

test('脱敏：request_id 中的 Key 被隐藏，服务端自由文本和异常堆栈不进入错误输出', async () => {
  const result = await run('submit', argsFor('submit'), reply(500, fail(500, 'Traceback: model token=hunter2', { request_id: `id-${SECRET}` })));
  const text = result.err.join('\n');
  assert.ok(result.diagnostic.error.request_id.includes('[已隐藏]'));
  for (const leaked of [SECRET, 'Traceback', 'hunter2', 'skill-uploads']) assert.equal(text.includes(leaked), false, leaked);
});

test('本地异常只输出通用信息', async () => {
  const err = [];
  const code = await cli.runCli('status', { args: [json({ task_id: ID })], client: { execute: async () => { throw new Error(`boom ${SECRET}`); } }, stdout: () => {}, stderr: v => err.push(v) });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), { error: { kind: 'local', message: '本地操作失败，未输出原始异常' } });
});

// ---------------------------------------------------------------------------------------------
// CLI、轮询与入口脚本
// ---------------------------------------------------------------------------------------------
test('CLI 参数：内联 JSON 与 --input-file（可带 BOM）；参数错误返回 1 且不发请求', async () => {
  const bom = writeInput(`\uFEFF${json({ task_id: ID })}`);
  for (const args of [[json({ task_id: ID })], ['--input-file', bom]]) assert.equal((await run('status', args, success('status'))).code, 0);
  const file = writeInput({ task_id: ID });
  for (const [operation, args] of [['status', []], ['status', ['--input-file']], ['status', ['{bad']], ['status', ['--idempotency-key', IDEM, '--input-file', file]], ['status', [json({ task_id: ID }), '--input-file', file]],
    ['submit', ['--input-file', writeInput({ oss_url: OSS })]], ['submit', ['--input-file', writeInput({ oss_url: OSS }), '--idempotency-key']], ['list', ['--input-file', file, '--wait']], ['list', ['--input-file', file, '--output', outPath()]], ['retry', ['--input-file', file, '--wait']]]) {
    const result = await run(operation, args, success(operation));
    assert.equal(result.code, 1, `${operation} ${JSON.stringify(args)}`);
    assert.equal(result.calls.length, 0);
  }
});

test('submit 成功：stdout 是 202 响应，stderr 提醒保存 id 和键、不要换键重提', async () => {
  const result = await run('submit', argsFor('submit'), success('submit'));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.out[0]).data.id, ID);
  assert.ok(result.err[0].includes('不要换键重提'));
  assert.equal(result.calls[0].init.headers['Idempotency-Key'], IDEM);
});

test('status：按 data.status 给出提醒；failed 时不自动 retry', async () => {
  for (const [data, phrase] of [[taskView(), '排队'], [taskView({ status: 'running', stage: 'extracting' }), '进行中'], [doneView(), 'needs_confirmation'], [taskView({ status: 'failed', error_code: 'brief_analysis_failed', error_message: 'Brief解析失败。', retry_policy: { mode: 'retry', can_retry: true, remaining_attempts: 2, maximum_attempts: 3 } }), '可以按用户要求 retry']]) {
    const result = await run('status', argsFor('status'), reply(200, ok(data)));
    assert.equal(result.code, 0);
    assert.ok(result.err.at(-1).includes(phrase), phrase);
    assert.equal(result.calls.length, 1);
  }
});

test('status：文件本身的问题即使 can_retry 为 true 也提示修正文件重新上传，不建议 retry', async () => {
  for (const code of cli.FILE_PROBLEMS) {
    const result = await run('status', argsFor('status'), reply(200, ok(taskView({ status: 'failed', stage: 'reading', error_code: code, error_message: '示例', retry_policy: { mode: 'retry', can_retry: true, remaining_attempts: 2, maximum_attempts: 2 } }))));
    const note = result.err.at(-1);
    assert.ok(note.includes('文件本身的问题'), code);
    assert.ok(note.includes('新的 Idempotency-Key'), code);
    assert.equal(note.includes('可以按用户要求 retry'), false, code);
  }
  assert.deepEqual([...cli.FILE_PROBLEMS].sort(), ['empty_document', 'encrypted_file', 'file_too_large', 'invalid_file', 'invalid_image', 'too_many_pages', 'unsupported_format']);
});

test('status --wait：每 5 秒查询一次，到 succeeded 或 failed 停止', async () => {
  const result = await run('status', [...argsFor('status'), '--wait'], [reply(200, ok(taskView())), reply(200, ok(taskView({ status: 'running' }))), reply(200, ok(doneView()))]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.sleeps, [5000, 5000]);
  assert.equal(JSON.parse(result.out.at(-1)).data.status, 'succeeded');
  assert.deepEqual(cli.WAIT, { intervalMs: 5000, attempts: 60 });
  const failed = await run('status', [...argsFor('status'), '--wait'], [reply(200, ok(taskView({ status: 'running' }))), reply(200, ok(taskView({ status: 'failed', error_code: 'brief_analysis_failed', error_message: 'Brief解析失败。' })))]);
  assert.equal(failed.code, 0);
  assert.equal(failed.calls.length, 2);
});

test('status --wait：预算用完仍在分析时退出码 2，提示稍后用同一个 task_id 再查', async () => {
  const result = await run('status', [...argsFor('status'), '--wait'], reply(200, ok(taskView({ status: 'running' }))), { wait: { intervalMs: 5000, attempts: 4 } });
  assert.equal(result.code, 2);
  assert.equal(result.calls.length, 4);
  assert.ok(result.diagnostic.wait.message.includes('不要重新提交'));
});

test('status --wait：输入无效时不发请求；轮询中遇到错误立即停止', async () => {
  const bad = await run('status', [json({ task_id: 1 }), '--wait'], success('status'));
  assert.equal(bad.code, 1);
  assert.equal(bad.calls.length, 0);
  const broken = await run('status', [...argsFor('status'), '--wait'], [reply(200, ok(taskView())), reply(404, fail(404, 'task_not_found'))]);
  assert.equal(broken.code, 1);
  assert.equal(broken.calls.length, 2);
});

test('--output：status、edit、campaign_draft 的完整响应写入文件，stdout 只给摘要；文件已存在时不覆盖', async () => {
  const output = outPath();
  const done = await run('status', [...argsFor('status'), '--output', output], success('status'));
  assert.equal(done.code, 0);
  assert.deepEqual(JSON.parse(done.out[0]).data, { output, id: ID, status: 'succeeded', stage: 'completed', result_version: 1, has_result: true, error_code: null });
  assert.equal(done.out[0].includes('DemoBrand'), false);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).data.current_result, report);
  const draftOut = outPath();
  const drafted = await run('campaign_draft', [...argsFor('campaign_draft'), '--output', draftOut], success('campaign_draft'));
  assert.deepEqual(JSON.parse(drafted.out[0]).data, { output: draftOut, task_id: ID, result_version: 1, is_valid: false, missing_fields: ['basic_info.campaign_name', 'compensation'], issue_count: 1, blocking_fields: [], unmapped_fact_ids: ['fact-1'] });
  assert.ok(drafted.err.at(-1).includes('没有创建 Campaign'));
  writeFileSync(output, 'keep');
  const again = await run('status', [...argsFor('status'), '--output', output], success('status'));
  assert.equal(again.code, 1);
  assert.equal(readFileSync(output, 'utf8'), 'keep');
});

test('campaign_draft 就绪判断只看 validation.is_valid：blocking_fields 为空也不能当作可创建', async () => {
  const notReady = await run('campaign_draft', argsFor('campaign_draft'), success('campaign_draft'));
  assert.equal(notReady.code, 0);
  const note = notReady.err.at(-1);
  assert.ok(note.includes('没有创建 Campaign'));
  assert.ok(note.includes('is_valid=false'));
  assert.ok(note.includes('missing_fields（2 项）'));
  assert.ok(note.includes('issues（1 项）'));
  assert.ok(note.includes('不要从文档臆造'));
  assert.equal(note.includes('多个独立活动'), false);
  const ready = await run('campaign_draft', argsFor('campaign_draft'), reply(200, ok({ ...draft, validation: { mode: 'submit', is_valid: true, missing_fields: [], issues: [] }, unmapped_fact_ids: [] })));
  assert.ok(ready.err.at(-1).includes('is_valid=true'));
  assert.equal(ready.err.at(-1).includes('unmapped_fact_ids'), false);
});

test('campaign_draft：blocking_fields 含 document 时提示多个独立活动；unmapped_fact_ids 提示回查 source_result、不丢弃不补写', async () => {
  const result = await run('campaign_draft', argsFor('campaign_draft'), reply(200, ok({ ...draft, blocking_fields: ['document'] })));
  const note = result.err.at(-1);
  assert.ok(note.includes('多个独立活动'));
  assert.ok(note.includes('source_result'));
  assert.ok(note.includes('不要丢弃'));
  assert.ok(note.includes('不要自行补写'));
  assert.equal(lib.DRAFT_VALIDATION_MODE, 'submit');
});

test('status 成功提醒：extracted 不等于已确认，人工确认看 review_status；source_refs 不等于有原文证据', async () => {
  const result = await run('status', argsFor('status'), success('status'));
  const note = result.err.at(-1);
  assert.ok(note.includes('extracted 只表示有提取值'));
  assert.ok(note.includes('review_status'));
  assert.ok(note.includes('source_refs'));
});

test('动作成功提醒：edit 给出新版本，retry 不要重复', async () => {
  const edited = await run('edit', argsFor('edit'), success('edit'));
  assert.ok(edited.err[0].includes('result_version'));
  const retried = await run('retry', argsFor('retry'), success('retry'));
  assert.ok(retried.err[0].includes('不要重复 retry'));
});

for (const [operation, [input]] of Object.entries(entries)) {
  test(`入口脚本 brief_analysis_${operation}.mjs：main 路由到对应操作；作为进程运行缺少 Key 时本地失败`, async () => {
    const mod = await load(`brief_analysis_${operation}.mjs`);
    const rec = recorder(success(operation));
    assert.equal(await mod.main({ args: argsFor(operation, input), client: make(rec.transport), stdout: () => {}, stderr: () => {} }), 0);
    assert.ok(rec.calls[0].url.endsWith(lib.operations[operation].path));
    const proc = spawnSync(process.execPath, [join(scripts, `brief_analysis_${operation}.mjs`), ...argsFor(operation, input)], { env: { ...process.env, SCOUT_API_BASE_URL: 'https://scout.example.com', SCOUT_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout, '');
    assert.equal(JSON.parse(proc.stderr).error.kind, 'configuration');
  });
}

test('Brief 分析脚本不含硬编码地址、Key 或 Authorization 头，也不自己上传文件', () => {
  const files = readdirSync(scripts).filter(name => name.includes('brief_analysis'));
  assert.equal(files.length, 9);
  for (const name of files) {
    const source = readFileSync(join(scripts, name), 'utf8');
    assert.equal(/https?:\/\/(?!scout\.example)/.test(source), false, name);
    assert.equal(/Authorization|Bearer\s|influxai_/i.test(source), false, name);
    assert.equal(/media_uoload|FormData|openAsBlob/.test(source), false, name);
  }
});
