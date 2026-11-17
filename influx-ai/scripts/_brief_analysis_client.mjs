// Brief analysis only. No automatic submit, retry, edit, polling-triggered actions or Campaign creation.
// Files reach this tool as an `oss_url` from the shared media upload scripts; this client never uploads.
const base = '/v1/brief-analysis';
// `executes` marks operations that dispatch analysis or change a report; their outcome stays unknown after an ambiguous failure.
export const operations = Object.freeze({
  options: { path: `${base}/options`, executes: false, success: 200 },
  submit: { path: `${base}/submit`, executes: true, success: 202 },
  status: { path: `${base}/status`, executes: false, success: 200 },
  list: { path: `${base}/list`, executes: false, success: 200 },
  edit: { path: `${base}/edit`, executes: true, success: 200 },
  retry: { path: `${base}/retry`, executes: true, success: 202 },
  campaign_draft: { path: `${base}/campaign-draft`, executes: false, success: 200 },
});
// Brief accepts these 14 extensions. The upload tool also takes pptx and video, which Brief rejects.
export const BRIEF_EXTENSIONS = Object.freeze(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp']);
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
export const STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed']);
export const TERMINAL = Object.freeze(['succeeded', 'failed']);
export const SCHEMA_VERSION = 'brief-analysis/v2';
// campaign-draft validates against the Campaign creation rules.
export const DRAFT_VALIDATION_MODE = 'submit';
export const REPORT_SECTIONS = Object.freeze(['context', 'goals', 'budget_items', 'creator_requirements', 'audience_requirements', 'deliverables', 'milestones', 'terms', 'additional_facts']);
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_EDIT_BODY_BYTES = 1100 * 1024;
export const MAX_EDIT_CHARS = 1000000;
const MAX_ID = 9223372036854775807n;
// Only these controlled messages become a `reason`; any other server text stays out of diagnostics.
const publicReasons = ['task_not_found', 'brief_service_unavailable', 'file_too_large', 'unsupported_format', 'invalid_brief_request', 'brief_state_conflict',
  'upload_reference_not_found', 'upload_reference_not_ready', 'upload_reference_integrity_failed', 'upload_status_unavailable', 'upload_storage_unavailable', 'unsupported_file_type', 'payload_too_large'];

export class BriefAnalysisError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new BriefAnalysisError('input', message); };
const protocol = () => { throw new BriefAnalysisError('protocol', 'Brief 分析响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fields(value, allowed) {
  if (!object(value)) invalid('请求必须是 JSON 对象');
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) invalid(`请求包含未开放字段：${extra.join(', ')}`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
const idString = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_ID;
function taskId(value) {
  if (!idString(value)) invalid('task_id 必须是正整数的十进制字符串（不接受 JSON 数字），使用 submit、list 返回的 id');
}
export function idempotencyKey(value) {
  // HTTP headers carry printable ASCII only, so the key is limited to that range.
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/\S/.test(value) || !/^[\x20-\x7e]+$/.test(value)) {
    throw new BriefAnalysisError('input', 'submit 必须提供 Idempotency-Key（1～128 个可打印 ASCII 字符，不能全是空白）；同一次提交重跑时用同一个键');
  }
  return value;
}
// The URL must be the untouched oss_url from a succeeded upload; the server matches it exactly.
function ossUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) invalid('oss_url 必须是上传成功回执里的原始 oss_url');
  let url;
  try { url = new URL(value); } catch { invalid('oss_url 必须是上传成功回执里的原始 oss_url'); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) invalid('oss_url 必须是不带查询参数或片段的 HTTPS 地址，原样使用上传回执的值');
  const ext = url.pathname.split('.').pop().toLowerCase();
  if (!BRIEF_EXTENSIONS.includes(ext)) invalid(`Brief 分析只接受 ${BRIEF_EXTENSIONS.join('、')}；pptx 和视频可以上传，但不能提交分析`);
}
function editRequest(request) {
  taskId(request.task_id);
  if (request.schema_version !== SCHEMA_VERSION) invalid(`schema_version 必须是 ${SCHEMA_VERSION}`);
  integer(request.expected_version, 1, Number.MAX_SAFE_INTEGER, 'expected_version');
  if (!object(request.data)) invalid('data 必须是完整的报告 data 对象（取自 status 返回的 current_result.data）');
  const extra = Object.keys(request.data).filter(key => !REPORT_SECTIONS.includes(key));
  if (extra.length) invalid(`data 只接受 ${REPORT_SECTIONS.join('、')}，多出：${extra.join(', ')}`);
  for (const key of Object.keys(request.data)) if (!Array.isArray(request.data[key])) invalid(`data.${key} 必须是数组`);
  if (request.confirmed_fields !== undefined && (!Array.isArray(request.confirmed_fields) || request.confirmed_fields.length > 1000 || request.confirmed_fields.some(item => typeof item !== 'string'))) invalid('confirmed_fields 必须是最多 1000 项的文本数组');
  const { task_id, ...edit } = request;
  if (JSON.stringify(edit).length > MAX_EDIT_CHARS) invalid('编辑内容序列化后超过 1,000,000 字符');
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知 Brief 分析操作');
  const allowed = {
    options: [],
    submit: ['oss_url'],
    status: ['task_id'],
    retry: ['task_id'],
    list: ['page', 'size'],
    edit: ['task_id', 'schema_version', 'expected_version', 'data', 'confirmed_fields'],
    campaign_draft: ['task_id', 'version'],
  }[operation];
  fields(input, allowed);
  const request = structuredClone(input);
  if (operation === 'submit') ossUrl(request.oss_url);
  else if (operation === 'list') {
    if (input.page === null || input.size === null) invalid('page 与 size 不能为 null');
    if (request.page !== undefined) integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
    if (request.size !== undefined) integer(request.size, 1, 100, 'size');
  } else if (operation === 'edit') editRequest(request);
  else if (operation !== 'options') {
    taskId(request.task_id);
    if (operation === 'campaign_draft') integer(request.version, 1, Number.MAX_SAFE_INTEGER, 'version');
  }
  const limit = operation === 'edit' ? MAX_EDIT_BODY_BYTES : MAX_BODY_BYTES;
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > limit) invalid(`请求体超过 ${limit / 1024} KiB`);
  return request;
}

const isText = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableText = value => value === null || isText(value);
function task(data, { id, listItem = false } = {}) {
  if (!object(data) || !idString(data.id) || (id !== undefined && data.id !== id) || !isText(data.file_name) || !isText(data.file_type) || !count(data.file_size_bytes)
    || !STATUSES.includes(data.status) || !isText(data.stage) || !count(data.attempt_no) || !count(data.result_version)
    || !(data.current_result === null || object(data.current_result)) || !nullableText(data.error_code) || !nullableText(data.error_message)
    || !isText(data.created_at) || !isText(data.updated_at) || !object(data.progress) || !(data.retry_policy === null || object(data.retry_policy))) protocol();
  if (listItem && data.current_result !== null) protocol();
  if (data.current_result !== null && (data.current_result.schema_version !== SCHEMA_VERSION || !object(data.current_result.data))) protocol();
}
export function validateResult(operation, data, request) {
  if (operation === 'options') {
    if (!object(data) || typeof data.enabled !== 'boolean' || !Array.isArray(data.extensions) || data.extensions.some(item => !isText(item))
      || !['max_file_bytes', 'max_pages', 'max_attempts'].every(key => count(data[key]))) protocol();
  } else if (operation === 'submit') task(data);
  else if (['status', 'edit', 'retry'].includes(operation)) task(data, { id: request.task_id });
  else if (operation === 'list') {
    if (!object(data) || !Array.isArray(data.items) || !count(data.total) || !Number.isSafeInteger(data.page) || data.page < 1 || !Number.isSafeInteger(data.size) || data.size < 1) protocol();
    data.items.forEach(item => task(item, { listItem: true }));
  } else if (operation === 'campaign_draft') {
    // Readiness is validation.is_valid; blocking_fields only flags multiple campaigns (["document"]) and is not a list of gaps.
    const v = data?.validation;
    if (!object(data) || data.task_id !== request.task_id || !count(data.result_version) || !object(data.draft) || !object(v) || !object(data.source_result)
      || v.mode !== DRAFT_VALIDATION_MODE || typeof v.is_valid !== 'boolean' || !Array.isArray(v.missing_fields) || v.missing_fields.some(item => !isText(item)) || !Array.isArray(v.issues)
      || !Array.isArray(data.warnings) || !Array.isArray(data.blocking_fields) || data.blocking_fields.some(item => !isText(item))
      || !Array.isArray(data.unmapped_fact_ids) || data.unmapped_fact_ids.some(item => !isText(item))) protocol();
  } else protocol();
}

function validRetryAfter(value) {
  return value !== null && (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) || Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value);
}

export function createBriefAnalysisClient({ baseUrl, apiKey, transport, timeoutMs = 60000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new BriefAnalysisError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new BriefAnalysisError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new BriefAnalysisError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new BriefAnalysisError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input, { idempotencyKey: key } = {}) {
    const request = prepareRequest(operation, input);
    if (operation === 'submit') idempotencyKey(key);
    else if (key !== undefined) throw new BriefAnalysisError('input', '只有 submit 接受 Idempotency-Key');
    const { executes, success } = operations[operation];
    const outcome = executes ? 'unknown' : 'unavailable';
    const ambiguous = executes ? {
      submit: '；任务可能已经创建。用同一个 Idempotency-Key 和同一个 oss_url 重跑 submit 恢复，不换键',
      edit: '；编辑可能已经生效。先运行 status 看 result_version，不自动重发',
      retry: '；重试可能已经派发。先运行 status 看 attempt_no 和 status，不自动重发',
    }[operation] : '';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BriefAnalysisError('timeout', `请求超时${ambiguous}`, { outcome })); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': secret };
        if (operation === 'submit') headers['Idempotency-Key'] = key;
        const response = await (transport ?? globalThis.fetch)(`${root.toString().replace(/\/$/, '')}${operations[operation].path}`, {
          method: 'POST', redirect: 'error', signal: controller.signal, headers, body: JSON.stringify(request),
        });
        let result;
        try { result = JSON.parse(await response.text()); } catch { protocol(); }
        if (!object(result) || typeof result.success !== 'boolean' || !object(result.meta)) protocol();
        if (!response.ok) {
          if (result.success !== false || result.data !== null || result.error?.code !== response.status * 100 + 1 || typeof result.error?.message !== 'string') protocol();
          const retry = response.headers.get('Retry-After');
          const reason = publicReasons.includes(result.error.message) ? result.error.message : undefined;
          throw new BriefAnalysisError('http', 'Brief 分析请求被服务端拒绝；按 HTTP/code 和 reason 核对权限、输入或任务状态', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetryAfter(retry) ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== success || result.success !== true || result.error !== null) protocol();
        // Billing is not wired up; null is not "free".
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if ((result.meta[field] ?? null) !== null) protocol();
        validateResult(operation, result.data, request);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof BriefAnalysisError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new BriefAnalysisError('network', `连接中断${ambiguous}`, { outcome });
    } finally { clearTimeout(timer); }
  } };
}
