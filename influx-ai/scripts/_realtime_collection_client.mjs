// Realtime collection only. No automatic submit, retry, abort, polling, task history or local ledger.
const base = '/v1/realtime-collection/tasks';
// `executes` marks operations that start, restart or stop collection work; their outcome stays unknown after an ambiguous failure.
// `managed` marks the five newer operations: strict fields, 64 KiB cap, null billing meta and controlled error reasons.
// The four original operations keep their own protocol: HTTP 400 with business codes 6001/6004/6005/6006.
export const operations = Object.freeze({
  submit: { path: `${base}/submit`, executes: true, managed: false },
  keyword_submit: { path: `${base}/keyword-submit`, executes: true, managed: false },
  status: { path: `${base}/status`, executes: false, managed: false },
  data: { path: `${base}/data`, executes: false, managed: false },
  columns: { path: `${base}/columns`, executes: false, managed: true },
  steps: { path: `${base}/steps`, executes: false, managed: true },
  download: { path: `${base}/download`, executes: false, managed: true },
  abort: { path: `${base}/abort`, executes: true, managed: true },
  retry: { path: `${base}/retry`, executes: true, managed: true },
});
export const SUCCESS_STATUS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
export const SUBMIT_TASK_TYPES = Object.freeze(['LINK_BATCH', 'FILE_UPLOAD', 'CREATOR_VIDEO', 'POST_VIDEO']);
export const COLUMN_TASK_TYPES = Object.freeze(['link_batch', 'file_upload', 'keyword', 'creator_video', 'post_video']);
export const PLATFORMS = Object.freeze(['tiktok', 'youtube', 'instagram', 'twitter']);
export const SIMPLE_STATUSES = Object.freeze(['processing', 'completed', 'failed', 'timeout']);
export const FULL_STATUSES = Object.freeze(['queued', 'crawl_processing', 'data_processing', 'completed', 'failed', 'timeout', 'aborted']);
// Original business codes on the four original operations (always HTTP 400).
export const BUSINESS_CODES = Object.freeze({ 6001: 'task_in_progress', 6004: 'all_links_invalid', 6005: 'insufficient_credits', 6006: 'queue_full' });

export class RealtimeCollectionError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new RealtimeCollectionError('input', message); };
const protocol = () => { throw new RealtimeCollectionError('protocol', '实时采集响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Only these controlled messages become a `reason`; any other server text stays out of diagnostics.
const managedReasons = ['collection_task_not_found', 'collection_state_not_allowed', 'collection_provider_unavailable', 'payload_too_large'];
const legacyReasons = { 'Task not found': 'task_not_found', "Platform 'twitter' does not support video collection": 'twitter_video_unsupported' };

function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求对象包含未开放字段或类型错误');
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
const text = value => typeof value === 'string' && value.trim() !== '' && value.isWellFormed();
function taskId(value) {
  // A business string returned by submit. Its format is not guessed; database or provider ids are not accepted substitutes.
  if (!text(value) || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid('task_id 必须是提交时返回的 task_id 字符串（最多 200 字符）');
}
function list(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`${label} 需要 ${min}～${max} 项`);
  if (value.some(item => !text(item))) invalid(`${label} 每一项必须是非空文本`);
}
function optionalText(value, label) {
  if (value != null && typeof value !== 'string') invalid(`${label} 必须为文本或省略`);
}
function webhook(value) {
  if (value == null) return;
  let url;
  try { url = new URL(value); } catch { invalid('webhook_url 必须是 HTTPS 地址'); }
  if (url.protocol !== 'https:' || !url.hostname) invalid('webhook_url 必须是 HTTPS 地址');
}
// Seconds, not milliseconds: ten digits at most.
function timeWindow(request) {
  for (const key of ['start_time', 'end_time']) if (request[key] != null) integer(request[key], 0, 9999999999, `${key}（秒级时间戳）`);
  if (request.start_time != null && request.end_time != null && request.start_time > request.end_time) invalid('start_time 不能晚于 end_time');
}
const optionalBool = (value, label) => { if (value != null && typeof value !== 'boolean') invalid(`${label} 只能是 true、false 或省略`); };
const locale = value => { if (value !== undefined && !['zh', 'en'].includes(value)) invalid('locale 只能是 zh 或 en'); };

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知实时采集操作');
  const allowed = {
    submit: ['task_type', 'platform', 'values', 'task_name', 'webhook_url', 'start_time', 'end_time'],
    keyword_submit: ['platform', 'keywords', 'task_name', 'webhook_url', 'start_time', 'end_time'],
    status: ['task_id'],
    data: ['task_id', 'page', 'size', 'is_matched_video'],
    columns: ['task_type', 'platform', 'locale'],
    steps: ['task_id'],
    download: ['task_id', 'locale', 'is_matched_video', 'column_keys'],
    abort: ['task_id'],
    retry: ['task_id'],
  };
  fields(input, allowed[operation]);
  const request = structuredClone(input);
  if (operation === 'submit') {
    if (!SUBMIT_TASK_TYPES.includes(request.task_type)) invalid('task_type 只能是大写的 LINK_BATCH、FILE_UPLOAD、CREATOR_VIDEO 或 POST_VIDEO');
    if (!PLATFORMS.includes(request.platform)) invalid('platform 只能是 tiktok、youtube、instagram 或 twitter');
    if (request.platform === 'twitter' && ['CREATOR_VIDEO', 'POST_VIDEO'].includes(request.task_type)) invalid('twitter 只支持 LINK_BATCH 和 FILE_UPLOAD');
    list(request.values, 1, 200, 'values');
    if (request.task_type !== 'CREATOR_VIDEO' && (request.start_time != null || request.end_time != null)) invalid('start_time / end_time 只用于 CREATOR_VIDEO');
    timeWindow(request);
  } else if (operation === 'keyword_submit') {
    if (!PLATFORMS.includes(request.platform)) invalid('platform 只能是 tiktok、youtube、instagram 或 twitter');
    list(request.keywords, 1, 10, 'keywords');
    timeWindow(request);
  } else if (operation === 'columns') {
    if (!COLUMN_TASK_TYPES.includes(request.task_type)) invalid('columns 的 task_type 只能是小写的 link_batch、file_upload、keyword、creator_video 或 post_video');
    if (!PLATFORMS.includes(request.platform)) invalid('platform 只能是 tiktok、youtube、instagram 或 twitter');
    locale(request.locale);
  } else {
    taskId(request.task_id);
    if (operation === 'data') {
      if (input.page === null || input.size === null) invalid('page 与 size 不能为 null');
      if (request.page !== undefined) integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
      if (request.size !== undefined) integer(request.size, 1, 100, 'size');
      optionalBool(request.is_matched_video, 'is_matched_video');
    }
    if (operation === 'download') {
      locale(request.locale);
      optionalBool(request.is_matched_video, 'is_matched_video');
      if (request.column_keys != null && (typeof request.column_keys !== 'string' || request.column_keys.length > 4000)) invalid('column_keys 必须是逗号分隔的字段键文本，最多 4000 字符');
    }
  }
  if (['submit', 'keyword_submit'].includes(operation)) { optionalText(request.task_name, 'task_name'); webhook(request.webhook_url); }
  if (operations[operation].managed && Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const isText = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nullable = check => value => value === null || check(value);
const texts = value => Array.isArray(value) && value.every(isText);
function statusView(data, request) {
  if (!object(data) || data.task_id !== request.task_id || !FULL_STATUSES.includes(data.status) || !PLATFORMS.includes(data.platform) || !COLUMN_TASK_TYPES.includes(data.task_type)
    || !['total_count', 'submit_count', 'success_count', 'fail_count', 'invalid_count'].every(key => count(data[key]))
    || !isText(data.progress) || !finite(data.fail_rate) || !texts(data.fail_list) || !texts(data.invalid_list) || !isText(data.created_at) || !isText(data.updated_at)) protocol();
}
export function validateResult(operation, data, request) {
  if (operation === 'submit' || operation === 'keyword_submit') {
    if (!object(data) || !text(data.task_id) || !isText(data.status) || !isText(data.message) || !count(data.total_count)) protocol();
  } else if (operation === 'status') {
    if (!object(data) || data.task_id !== request.task_id || !SIMPLE_STATUSES.includes(data.status) || !['total', 'completed', 'failed'].every(key => count(data[key])) || !finite(data.progress)) protocol();
  } else if (operation === 'data') {
    if (!object(data) || !texts(data.columns_config) || !Array.isArray(data.items) || data.items.some(row => !object(row) || !Array.isArray(row.values))
      || !count(data.total) || !Number.isSafeInteger(data.page) || data.page < 1 || !Number.isSafeInteger(data.size) || data.size < 1) protocol();
  } else if (operation === 'columns') {
    if (!object(data) || !texts(data.columns)) protocol();
  } else if (operation === 'steps') {
    if (!object(data) || data.task_id !== request.task_id || !Array.isArray(data.steps) || !nullable(finite)(data.total_duration_seconds)
      || data.steps.some(step => !object(step) || !isText(step.step_name) || !Number.isSafeInteger(step.step_order) || !isText(step.status)
        || !nullable(isText)(step.started_at) || !nullable(isText)(step.ended_at) || !nullable(finite)(step.duration_seconds))) protocol();
  } else if (operation === 'download') {
    if (!object(data) || !texts(data.columns_config) || !Array.isArray(data.items) || data.items.some(row => !Array.isArray(row)) || !count(data.total)) protocol();
  } else if (operation === 'abort' || operation === 'retry') statusView(data, request);
  else protocol();
}

function validRetryAfter(value) {
  return value !== null && (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) || Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value);
}

export function createRealtimeCollectionClient({ baseUrl, apiKey, transport, timeoutMs = 30000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new RealtimeCollectionError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new RealtimeCollectionError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new RealtimeCollectionError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RealtimeCollectionError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  const redact = value => value.split(secret).join('[已隐藏]');
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const { executes, managed } = operations[operation];
    const outcome = executes ? 'unknown' : 'unavailable';
    const ambiguous = executes ? '；动作结果可能未知，不自动重发，按 SKILL 的“结果未知”处理' : '';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RealtimeCollectionError('timeout', `请求超时${ambiguous}`, { outcome })); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await (transport ?? globalThis.fetch)(`${root.toString().replace(/\/$/, '')}${operations[operation].path}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': secret }, body: JSON.stringify(request),
        });
        let result;
        try { result = JSON.parse(await response.text()); } catch { protocol(); }
        if (!object(result) || typeof result.success !== 'boolean' || !object(result.meta)) protocol();
        const requestId = typeof result.meta.request_id === 'string' ? { request_id: redact(result.meta.request_id) } : {};
        if (!response.ok) {
          if (result.success !== false || result.data !== null || !object(result.error) || !Number.isSafeInteger(result.error.code) || typeof result.error.message !== 'string') protocol();
          const { code, message } = result.error;
          // Original operations: business refusals come back as HTTP 400 with their own codes.
          if (!managed && response.status === 400 && BUSINESS_CODES[code]) {
            throw new RealtimeCollectionError('business', '实时采集业务拒绝；按 reason 处理，不自动重发', { status: 400, code, reason: BUSINESS_CODES[code], ...requestId, outcome: 'rejected' });
          }
          if (code !== response.status * 100 + 1) protocol();
          const reason = managed ? (managedReasons.includes(message) ? message : undefined) : legacyReasons[message];
          const retry = response.headers.get('Retry-After');
          throw new RealtimeCollectionError('http', '实时采集请求被服务端拒绝；按 HTTP/code 核对权限、输入或任务状态', {
            status: response.status, code,
            ...(reason ? { reason } : {}),
            ...requestId,
            ...(response.status === 429 && validRetryAfter(retry) ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== SUCCESS_STATUS || result.success !== true || result.error !== null) protocol();
        // Managed operations carry no settlement receipt. Original operations keep default meta; credits_consumed=0 there does not mean free.
        if (managed) for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data, request);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof RealtimeCollectionError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new RealtimeCollectionError('network', `连接中断${ambiguous}`, { outcome });
    } finally { clearTimeout(timer); }
  } };
}
