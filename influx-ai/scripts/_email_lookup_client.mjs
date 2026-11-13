// Independent email lookup only. No automatic submission, retries or local ledger.
export const operations = Object.freeze(Object.fromEntries(
  ['preview', 'create', 'get', 'items', 'list'].map(name => [name, {
    path: `/v1/creator-email-lookup/batches/${name}`, status: name === 'create' ? 202 : 200, scope: 'email-lookup',
  }]),
));
export class EmailLookupError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new EmailLookupError('input', message); };
const protocol = () => { throw new EmailLookupError('protocol', '邮箱查找响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求对象包含未开放字段或类型错误');
}
function text(value, max) {
  if (typeof value !== 'string' || [...value].length > max || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) invalid('文本类型、长度或字符不合法');
}
function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid('整数超出允许范围');
}
function choice(value, values) { if (!values.includes(value)) invalid('枚举值不合法'); }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value) { if (typeof value !== 'string' || !uuidPattern.test(value)) invalid('ID 或提交键必须为 UUID 字符串'); }
const platforms = ['tiktok', 'instagram', 'youtube', 'twitter'];
const batchStates = ['pending', 'running', 'completed', 'failed'];
const outcomes = ['success', 'partial', 'failed'];
const resultStates = ['pending', 'running', 'found', 'not_found', 'skipped', 'error'];
function timestamp(value) {
  text(value, 100);
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('时间必须为带时区 ISO 8601');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid('时间日期或时分秒不合法');
}
export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知邮箱查找操作');
  const base = ['input_source', 'input', 'default_platform'];
  const allowed = {
    preview: base, create: [...base, 'name', 'skip_invalid_rows', 'enable_external_lookup', 'idempotency_key'],
    get: ['batch_id'], items: ['batch_id', 'view', 'platform', 'q', 'page', 'page_size'],
    list: ['page', 'page_size', 'q', 'status', 'outcome', 'platform', 'created_from', 'created_to', 'submission_key'],
  };
  fields(input, allowed[operation]);
  const request = structuredClone(input);
  // Alias normalization belongs to the server; send the original platform text.
  for (const key of ['platform', 'default_platform']) if (request[key] != null) {
    text(request[key], 100);
    choice(request[key].trim().toLowerCase() === 'x' ? 'twitter' : request[key].trim().toLowerCase(), platforms);
  }
  if (['preview', 'create'].includes(operation)) {
    choice(request.input_source, ['paste']);
    const doc = request.input;
    fields(doc, ['filename', 'sheet_name', 'columns', 'mapping', 'rows']);
    if (doc.filename != null) text(doc.filename, 255);
    if (doc.sheet_name != null) text(doc.sheet_name, 128);
    if (!Array.isArray(doc.columns) || !doc.columns.length || doc.columns.length > 50) invalid('columns 需要 1～50 列');
    doc.columns.forEach(column => text(column, 128));
    fields(doc.mapping, ['identifier_column', 'platform_column']);
    integer(doc.mapping.identifier_column, 0, doc.columns.length - 1);
    if (doc.mapping.platform_column != null) {
      integer(doc.mapping.platform_column, 0, doc.columns.length - 1);
      if (doc.mapping.identifier_column === doc.mapping.platform_column) invalid('账号列与平台列必须不同');
    }
    if (!Array.isArray(doc.rows) || !doc.rows.length || doc.rows.length > 200) invalid('rows 需要 1～200 行');
    let previous = 0;
    for (const row of doc.rows) {
      fields(row, ['source_row_number', 'cells']); integer(row.source_row_number, previous + 1); previous = row.source_row_number;
      if (!Array.isArray(row.cells) || !row.cells.length || row.cells.length > doc.columns.length) invalid('行单元格数超出声明列数');
      row.cells.forEach(cell => text(cell, 2048));
    }
    if (operation === 'create') {
      uuid(request.idempotency_key);
      if (request.name != null) { text(request.name, 80); request.name = request.name.trim() || null; }
      for (const [key, fallback] of [['skip_invalid_rows', false], ['enable_external_lookup', true]]) {
        if (request[key] === undefined) request[key] = fallback;
        if (typeof request[key] !== 'boolean') invalid(`${key} 必须为 boolean`);
      }
    }
  } else {
    if (operation !== 'list') uuid(request.batch_id);
    if (operation !== 'get') {
      request.page ??= 1; request.page_size ??= operation === 'list' ? 20 : 50;
      // Explicit null is invalid for non-nullable pagination and query fields.
      if (input.page === null || input.page_size === null) invalid('分页参数不能为 null');
      integer(request.page, 1); integer(request.page_size, 1, operation === 'list' ? 50 : 100);
      if (request.q === undefined) request.q = '';
      text(request.q, operation === 'list' ? 80 : 200);
      if (operation === 'items') {
        if (request.view === undefined) request.view = 'all';
        choice(request.view, ['all', 'found', 'not_found', 'error', 'issues']);
      } else {
        if (request.status != null) choice(request.status, batchStates);
        if (request.outcome != null) choice(request.outcome, outcomes);
        for (const key of ['created_from', 'created_to']) if (request[key] != null) timestamp(request[key]);
        if (request.created_from && request.created_to && Date.parse(request.created_from) >= Date.parse(request.created_to)) invalid('时间起点必须早于终点');
        if (request.submission_key != null) {
          uuid(request.submission_key);
          if (request.page !== 1 || ['q', 'status', 'outcome', 'platform', 'created_from', 'created_to'].some(key => request[key])) invalid('submission_key 不能混用其他筛选或非首页');
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 1024 * 1024) invalid('请求体超过 1 MiB');
  return request;
}
function stats(value, keys) {
  if (!object(value) || keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) protocol();
}
const inputCounts = ['input_count', 'valid_row_count', 'invalid_row_count', 'duplicate_row_count', 'unique_count'];
const lookupCounts = ['unique_count', 'pending', 'running', 'found', 'not_found', 'skipped', 'error', 'processed_count', 'retryable_count'];
function batch(value) {
  if (!object(value) || !uuidPattern.test(value.batch_id) || !batchStates.includes(value.status) || !(value.outcome === null || outcomes.includes(value.outcome)) || typeof value.has_skipped !== 'boolean') protocol();
  stats(value.input_stats, inputCounts); stats(value.lookup_stats, lookupCounts);
}
export function validateResult(operation, data) {
  if (!object(data)) protocol();
  if (operation === 'preview') {
    if (typeof data.can_submit !== 'boolean' || !Array.isArray(data.rows)) protocol();
    stats(data.summary, inputCounts);
    for (const row of data.rows) if (!object(row) || !['valid', 'invalid'].includes(row.validation_status) || !Array.isArray(row.cells)) protocol();
  } else if (operation === 'create') batch(data);
  else if (operation === 'get') {
    batch(data.batch);
    if (!Array.isArray(data.input_columns) || !object(data.input_view_counts)) protocol();
  } else {
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.page) || data.page < 1 || !Number.isSafeInteger(data.page_size) || data.page_size < 1 || data.page_size > (operation === 'list' ? 50 : 100)) protocol();
    for (const row of data.items) {
      if (operation === 'list') batch(row);
      else {
        if (!object(row) || !['valid', 'invalid'].includes(row.validation) || !Array.isArray(row.original_cells) || !('result' in row)) protocol();
        if (row.result !== null && (!object(row.result) || !resultStates.includes(row.result.status) || !['stored', 'cache', 'external', 'none'].includes(row.result.source) || typeof row.result.retryable !== 'boolean' || (row.result.status === 'found' && (typeof row.result.email !== 'string' || !row.result.email.trim())))) protocol();
      }
    }
  }
}
export function createEmailLookupClient({ baseUrl, apiKey, transport, timeoutMs = 30000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new EmailLookupError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new EmailLookupError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new EmailLookupError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new EmailLookupError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const outcome = operation === 'create' ? 'unknown' : 'unavailable';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new EmailLookupError('timeout', '请求超时；创建结果可能未知，保留原提交键，不自动重发', { outcome })); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await (transport ?? globalThis.fetch)(`${base.toString().replace(/\/$/, '')}${operations[operation].path}`, {
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
          throw new EmailLookupError('http', '邮箱查找请求被服务端拒绝；按 HTTP/code 核对权限、输入或服务状态', {
            status: response.status, code: result.error.code,
            ...(['idempotency_conflict', 'all_inputs_invalid', 'invalid_rows_unconfirmed', 'batch_not_found', 'tool_permission_denied', 'permission_unavailable', 'invalid_pagination', 'payload_too_large'].includes(result.error.message) ? { reason: result.error.message } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetry ? { retry_after: retry } : {}),
            outcome: operation === 'create' && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== operations[operation].status || result.success !== true || result.error !== null) protocol();
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof EmailLookupError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new EmailLookupError('network', '连接中断；创建结果可能未知，保留原提交键，不自动重发', { outcome });
    } finally { clearTimeout(timer); }
  } };
}
