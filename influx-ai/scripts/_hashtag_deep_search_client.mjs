// Hashtag deep search only. No automatic submission, retries or local ledger.
const base = '/v1/hashtag-deep-search/tasks';
// `executes` marks operations that start model/retrieval work; their outcome is unknown after an ambiguous failure.
export const operations = Object.freeze({
  submit: { path: `${base}/submit`, status: 202, executes: true },
  get: { path: `${base}/get`, status: 200, executes: false },
  list: { path: `${base}/list`, status: 200, executes: false },
  next: { path: `${base}/next`, status: 202, executes: true },
  retry: { path: `${base}/retry`, status: 202, executes: true },
});
export const MAX_BODY_BYTES = 64 * 1024;
export const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed']);

export class HashtagSearchError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new HashtagSearchError('input', message); };
const protocol = () => { throw new HashtagSearchError('protocol', 'Hashtag 深度搜索响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const locales = ['zh', 'en'];
const taskStates = ['queued', 'running', 'succeeded', 'failed'];
const stages = ['queued', 'planning', 'retrieving', 'reviewing', 'organizing', 'completed'];
// Only these controlled reasons are surfaced; any other server message stays out of diagnostics.
const publicReasons = ['unavailable', 'target_count_unavailable', 'not_found', 'idempotency_conflict', 'next_batch_unavailable', 'retry_unavailable', 'payload_too_large'];

function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求对象包含未开放字段或类型错误');
}
function uuid(value, label) { if (typeof value !== 'string' || !uuidPattern.test(value)) invalid(`${label} 必须为 UUID 字符串`); }
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知 Hashtag 深度搜索操作');
  const allowed = {
    submit: ['query', 'locale', 'target_count', 'idempotency_key'],
    get: ['task_id'], next: ['task_id'], retry: ['task_id'],
    list: ['page', 'page_size'],
  };
  fields(input, allowed[operation]);
  const request = structuredClone(input);
  if (operation === 'submit') {
    if (typeof request.query !== 'string' || !request.query.isWellFormed()) invalid('query 必须为文本');
    const length = [...request.query.trim()].length;
    if (length < 5 || length > 4000) invalid('query 去首尾空白后需要 5～4000 个字符');
    // The server fills locale/target_count defaults; send them only when the caller chose a value.
    if (request.locale !== undefined && !locales.includes(request.locale)) invalid('locale 只能是 zh 或 en');
    if (request.target_count !== undefined) integer(request.target_count, 1, 300, 'target_count');
    uuid(request.idempotency_key, 'idempotency_key');
  } else if (operation === 'list') {
    request.page ??= 1;
    request.page_size ??= 20;
    // Explicit null is not accepted for either pagination field.
    if (input.page === null || input.page_size === null) invalid('分页参数不能为 null');
    integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
    integer(request.page_size, 1, 100, 'page_size');
  } else uuid(request.task_id, 'task_id');
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const text = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const optionalArray = value => value === undefined || Array.isArray(value);
function task(value) {
  if (!object(value) || !uuidPattern.test(value.id) || !taskStates.includes(value.status) || !stages.includes(value.stage) || !text(value.query)
    || !locales.includes(value.locale) || !count(value.revision) || !count(value.attempt_no) || !count(value.max_attempts)
    || !['candidates', 'selected_candidate_ids', 'decisions', 'groups'].every(key => optionalArray(value[key]))
    || ['can_retry', 'can_search_next'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean')) protocol();
  if ((value.selected_candidate_ids ?? []).some(id => !text(id))) protocol();
  if ((value.candidates ?? []).some(item => !object(item) || !text(item.id) || !text(item.hashtag) || !Number.isFinite(item.similarity))) protocol();
}
function summary(value) {
  if (!object(value) || !uuidPattern.test(value.id) || !taskStates.includes(value.status) || !stages.includes(value.stage) || !text(value.query) || !text(value.title)
    || !Number.isSafeInteger(value.batch_no) || value.batch_no < 1) protocol();
}
export function validateResult(operation, data) {
  if (operation === 'list') {
    if (!object(data) || !Array.isArray(data.items) || !count(data.total) || !Number.isSafeInteger(data.page) || data.page < 1
      || !Number.isSafeInteger(data.page_size) || data.page_size < 1 || data.page_size > 100) protocol();
    data.items.forEach(summary);
  } else task(data);
}

export function createHashtagSearchClient({ baseUrl, apiKey, transport, timeoutMs = 30000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new HashtagSearchError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new HashtagSearchError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new HashtagSearchError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new HashtagSearchError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const executes = operations[operation].executes;
    const outcome = executes ? 'unknown' : 'unavailable';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HashtagSearchError('timeout', executes ? '请求超时；执行结果可能未知，保留原请求，不自动重发' : '请求超时', { outcome })); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await (transport ?? globalThis.fetch)(`${root.toString().replace(/\/$/, '')}${operations[operation].path}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': secret }, body: JSON.stringify(request),
        });
        let result;
        try { result = JSON.parse(await response.text()); } catch { protocol(); }
        if (!object(result) || typeof result.success !== 'boolean' || !object(result.meta)) protocol();
        if (!response.ok) {
          if (result.success !== false || result.data !== null || result.error?.code !== response.status * 100 + 1 || typeof result.error?.message !== 'string') protocol();
          const retry = response.headers.get('Retry-After');
          const validRetry = retry !== null && (/^\d+$/.test(retry) && Number.isSafeInteger(Number(retry)) || Number.isFinite(Date.parse(retry)) && new Date(Date.parse(retry)).toUTCString() === retry);
          throw new HashtagSearchError('http', 'Hashtag 深度搜索请求被服务端拒绝；按 HTTP/code 核对权限、输入或服务状态', {
            status: response.status, code: result.error.code,
            ...(publicReasons.includes(result.error.message) ? { reason: result.error.message } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetry ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== operations[operation].status || result.success !== true || result.error !== null) protocol();
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof HashtagSearchError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new HashtagSearchError('network', executes ? '连接中断；执行结果可能未知，保留原请求，不自动重发' : '连接中断', { outcome });
    } finally { clearTimeout(timer); }
  } };
}
