// Creator profile tagging only. No automatic submission, retries or local ledger.
const base = '/v1/creator-profile-tagging';
// `executes` marks operations that start tagging or collection work and may be billed upstream;
// their outcome stays unknown after an ambiguous failure.
export const operations = Object.freeze({
  options: { path: `${base}/options`, status: 200, executes: false },
  submit: { path: `${base}/batches/submit`, status: 202, executes: true },
  list_batches: { path: `${base}/batches/list`, status: 200, executes: false },
  get_batch: { path: `${base}/batches/get`, status: 200, executes: false },
  list_items: { path: `${base}/items/list`, status: 200, executes: false },
  get_item: { path: `${base}/items/get`, status: 200, executes: false },
  retry: { path: `${base}/items/retry`, status: 202, executes: true },
});
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_INPUT_ROWS = 500;
export const BATCH_TERMINAL = Object.freeze(['completed', 'completed_with_errors']);
export const COLLECTION_ACTIVE = Object.freeze(['checking', 'pending', 'submitted']);

export class ProfileTaggingError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new ProfileTaggingError('input', message); };
const protocol = () => { throw new ProfileTaggingError('protocol', '画像打标响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const platforms = ['instagram', 'tiktok', 'youtube'];
const batchStates = ['queued', 'running', 'completed', 'completed_with_errors'];
const itemStates = ['checking_warehouse', 'tag_queued', 'tagging', 'retry_wait', 'succeeded', 'failed_retryable', 'failed_final', 'unknown'];
const resultSources = ['live', 'reused'];
const MAX_ID = 9223372036854775807n;
// Only these controlled reasons are surfaced; any other server message stays out of diagnostics.
const publicReasons = [
  'creator_profile_tagging_disabled', 'batch_input_row_limit_exceeded', 'batch_item_limit_exceeded', 'idempotency_key_conflict',
  'team_batch_already_running', 'batch_submit_conflict', 'batch_not_found', 'item_not_found', 'item_not_retryable', 'item_state_changed', 'payload_too_large',
];

function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求对象包含未开放字段或类型错误');
}
function wellFormed(value, label) { if (typeof value !== 'string' || !value.isWellFormed()) invalid(`${label} 必须为文本`); }
function length(value, min, max, label) {
  wellFormed(value, label);
  const size = [...value.trim()].length;
  if (size < min || size > max) invalid(`${label} 去首尾空白后需要 ${min}～${max} 个字符`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
// BIGINT ids travel as decimal strings; JSON numbers lose precision and are not accepted.
function bigintId(value, label) {
  if (typeof value !== 'string' || !/^[0-9]{1,19}$/.test(value) || BigInt(value) < 1n || BigInt(value) > MAX_ID) invalid(`${label} 必须为正整数的十进制字符串，不接受 JSON 数字`);
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知画像打标操作');
  const allowed = {
    options: [],
    submit: ['idempotency_key', 'items', 'force_refresh'],
    list_batches: ['page', 'page_size'],
    get_batch: ['batch_id'],
    list_items: ['batch_id', 'page', 'page_size', 'status', 'query'],
    get_item: ['batch_id', 'item_id'],
    retry: ['batch_id', 'item_id'],
  };
  fields(input, allowed[operation]);
  const request = structuredClone(input);
  if (operation === 'submit') {
    length(request.idempotency_key, 1, 128, 'idempotency_key');
    if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > MAX_INPUT_ROWS) invalid(`items 需要 1～${MAX_INPUT_ROWS} 项`);
    for (const item of request.items) {
      fields(item, ['platform', 'profile_url']);
      length(item.platform, 1, 16, 'platform');
      if (!platforms.includes(item.platform.trim().toLowerCase())) invalid('platform 只能是 instagram、tiktok 或 youtube');
      length(item.profile_url, 1, 1000, 'profile_url');
      // Trusted domains and profile shapes are checked by the server; the client only rejects clearly unusable input.
      if (!/^https:\/\//i.test(item.profile_url.trim())) invalid('profile_url 必须是 HTTPS 主页链接');
    }
    if (request.force_refresh !== undefined && typeof request.force_refresh !== 'boolean') invalid('force_refresh 必须为 boolean');
  } else if (operation === 'list_batches' || operation === 'list_items') {
    if (operation === 'list_items') {
      bigintId(request.batch_id, 'batch_id');
      if (request.status != null) length(request.status, 0, 32, 'status');
      if (request.query != null) length(request.query, 0, 255, 'query');
    }
    request.page ??= 1;
    request.page_size ??= 20;
    // Explicit null is not accepted for either pagination field.
    if (input.page === null || input.page_size === null) invalid('分页参数不能为 null');
    integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
    integer(request.page_size, 1, 100, 'page_size');
  } else if (operation !== 'options') {
    bigintId(request.batch_id, 'batch_id');
    if (operation !== 'get_batch') bigintId(request.item_id, 'item_id');
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const text = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const idString = value => typeof value === 'string' && /^[0-9]{1,19}$/.test(value);
const nullableText = value => value === null || text(value);
const counts = value => object(value) && Object.values(value).every(count);
function batch(value) {
  if (!object(value) || !idString(value.id) || !batchStates.includes(value.status) || !['item_count', 'submitted_count', 'succeeded_count', 'failed_count'].every(key => count(value[key]))
    || !counts(value.stage_counts) || !counts(value.collection_counts) || typeof value.force_refresh !== 'boolean' || !text(value.created_at) || !nullableText(value.finished_at)) protocol();
}
function item(value, detail) {
  if (!object(value) || !idString(value.id) || !idString(value.batch_id) || !Number.isSafeInteger(value.input_index) || value.input_index < 1
    || !text(value.platform) || !text(value.profile_url) || !text(value.normalized_profile_url) || !itemStates.includes(value.status) || !text(value.stage)
    || !text(value.collection_status) || !count(value.attempt_no) || !(value.result_source === null || resultSources.includes(value.result_source))
    || !['warehouse_detail_id', 'collection_error_code', 'collection_task_id', 'result_obtained_at', 'error_code', 'error_message'].every(key => nullableText(value[key]))
    || !text(value.updated_at)) protocol();
  // Detail carries `result` (a free-form JSON object or null); summaries never do.
  if (detail ? !('result' in value) || !(value.result === null || object(value.result)) : 'result' in value) protocol();
}
function page(value, rowCheck) {
  if (!object(value) || !Array.isArray(value.items) || !count(value.total) || !Number.isSafeInteger(value.page) || value.page < 1
    || !Number.isSafeInteger(value.page_size) || value.page_size < 1 || value.page_size > 100) protocol();
  value.items.forEach(rowCheck);
}
export function validateResult(operation, data) {
  if (operation === 'options') {
    if (!object(data) || typeof data.enabled !== 'boolean' || !['max_items', 'max_input_rows', 'reuse_days'].every(key => count(data[key]))) protocol();
  } else if (operation === 'submit' || operation === 'get_batch') batch(data);
  else if (operation === 'list_batches') page(data, batch);
  else if (operation === 'list_items') page(data, row => item(row, false));
  else if (operation === 'get_item') item(data, true);
  else if (operation === 'retry') item(data, false);
  else protocol();
}

export function createProfileTaggingClient({ baseUrl, apiKey, transport, timeoutMs = 30000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new ProfileTaggingError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new ProfileTaggingError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ProfileTaggingError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ProfileTaggingError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const executes = operations[operation].executes;
    const outcome = executes ? 'unknown' : 'unavailable';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProfileTaggingError('timeout', executes ? '请求超时；执行结果可能未知，可能已被受理或计费，保留原请求，不自动重发' : '请求超时', { outcome })); }, timeoutMs); });
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
          const reason = publicReasons.includes(result.error.message) ? result.error.message : undefined;
          throw new ProfileTaggingError('http', '画像打标请求被服务端拒绝；按 HTTP/code 核对权限、输入或服务状态', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetry ? { retry_after: retry } : {}),
            // A 5xx on an executing operation may have been accepted; the explicit "disabled" rejection happens before any work.
            outcome: executes && response.status >= 500 && reason !== 'creator_profile_tagging_disabled' ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== operations[operation].status || result.success !== true || result.error !== null) protocol();
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof ProfileTaggingError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new ProfileTaggingError('network', executes ? '连接中断；执行结果可能未知，可能已被受理或计费，保留原请求，不自动重发' : '连接中断', { outcome });
    } finally { clearTimeout(timer); }
  } };
}
