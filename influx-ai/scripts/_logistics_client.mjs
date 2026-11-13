// Logistics tracking only. No automatic registration, refresh, recovery or local ledger.
const base = '/v1/logistics';
// `executes` marks operations that change a shipment or call the tracking provider;
// their outcome stays unknown after an ambiguous failure.
export const operations = Object.freeze({
  carriers: { path: `${base}/carriers/list`, executes: false },
  register: { path: `${base}/shipments/register`, executes: true },
  list: { path: `${base}/shipments/list`, executes: false },
  stats: { path: `${base}/shipments/stats`, executes: false },
  get: { path: `${base}/shipments/get`, executes: false },
  refresh: { path: `${base}/shipments/refresh`, executes: true },
  retry: { path: `${base}/shipments/retry`, executes: true },
  change_carrier: { path: `${base}/shipments/change-carrier`, executes: true },
  follow_up: { path: `${base}/shipments/follow-up`, executes: true },
  stop: { path: `${base}/shipments/stop`, executes: true },
  delete: { path: `${base}/shipments/delete`, executes: true },
});
export const SUCCESS_STATUS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_CARRIER = 2147483647;

export class LogisticsError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new LogisticsError('input', message); };
const protocol = () => { throw new LogisticsError('protocol', '物流追踪响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const platforms = ['tiktok', 'instagram', 'youtube'];
export const USER_STATUSES = Object.freeze(['pending_ship', 'shipped', 'delivered_confirmed', 'content_creating', 'content_published', 'issue', 'completed']);
const listStatuses = ['pending', 'not_found', 'info_received', 'in_transit', 'out_for_delivery', 'available_for_pickup', 'delivered', 'exception', 'delivery_failure', 'expired', 'stopped', 'failed'];
const registerStates = ['pending', 'registering', 'unknown', 'registered', 'failed'];
const trackingStates = ['tracking', 'stopped'];
const billingStates = ['pending', 'settled', 'no_charge', 'settlement_failed'];
const pendingActions = ['register', 'refresh', 'carrier', 'stop', 'delete'];
const statsKeys = ['total', 'tracking', 'delivered', 'exception', 'overdue', 'pending', 'in_transit', 'out_for_delivery', 'stopped'];
// Only these controlled reasons are surfaced; any other server message stays out of diagnostics.
const publicReasons = [
  'shipment_not_found', 'shipment_busy', 'shipment_version_changed', 'shipment_action_needs_recovery', 'shipment_lease_lost',
  'operation_payload_changed', 'operation_already_deleted', 'tracking_number_already_active', 'invalid_carrier', 'billing_identity_required',
  'tracking_quote_required', 'tracking_number_rejected', 'registration_needs_confirmation', 'shipment_not_registered', 'shipment_tracking_stopped',
  'carrier_shared_subscription', 'carrier_change_needs_confirmation', 'tracking_provider_invalid_response', 'tracking_provider_unavailable',
  'tracking_provider_not_configured', 'tracking_provider_rejected', 'carrier_change_rejected', 'delete_tracking_rejected', 'stop_tracking_rejected',
  'insufficient_credits', 'tracking_rate_limit_unavailable', 'tracking_provider_rate_limited', 'logistics_unavailable', 'payload_too_large',
];
// Rejections that say the provider-side outcome must be confirmed before anything else is decided.
const uncertainReasons = ['registration_needs_confirmation', 'carrier_change_needs_confirmation'];

function fields(value, allowed, label = '请求对象') {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label}包含未开放字段或类型错误`);
}
function text(value, max, label, { min = 0 } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed()) invalid(`${label} 必须为文本`);
  const size = [...value.trim()].length;
  if (size < min || size > max) invalid(`${label} 去首尾空白后需要 ${min}～${max} 个字符`);
}
const optionalText = (value, max, label) => { if (value != null) text(value, max, label); };
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
function uuid(value, label) { if (typeof value !== 'string' || !uuidPattern.test(value)) invalid(`${label} 必须为 UUID 字符串`); }
function httpsUrl(value, label) {
  if (value == null || value === '') return;
  text(value, 2048, label);
  let parsed;
  try { parsed = new URL(value.trim()); } catch { invalid(`${label} 必须是 HTTPS 链接`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) invalid(`${label} 必须是不含凭据的 HTTPS 链接`);
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${label} 必须为带时区的 ISO 8601 时间`);
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知物流追踪操作');
  const filterFields = ['query', 'status', 'statuses', 'creator_keyword', 'recipient', 'tracking_number', 'overdue', 'date_from', 'date_to', 'page', 'size'];
  const allowed = {
    carriers: ['q'],
    register: ['operation_id', 'creator', 'tracking_number', 'carrier', 'recipient', 'remark'],
    list: filterFields, stats: filterFields,
    get: ['shipment_id'],
    refresh: ['shipment_id', 'version'], retry: ['shipment_id', 'version'], stop: ['shipment_id', 'version'], delete: ['shipment_id', 'version'],
    change_carrier: ['shipment_id', 'version', 'carrier'],
    follow_up: ['shipment_id', 'version', 'status'],
  };
  fields(input, allowed[operation]);
  const request = structuredClone(input);
  if (operation === 'carriers') {
    if (request.q !== undefined) text(request.q, 100, 'q');
  } else if (operation === 'register') {
    uuid(request.operation_id, 'operation_id');
    const creator = request.creator;
    fields(creator, ['platform', 'creator_uid', 'name', 'profile_url', 'user_name', 'avatar_url', 'followers_cnt', 'country_code'], 'creator ');
    if (typeof creator.platform !== 'string' || !platforms.includes(creator.platform.trim())) invalid('creator.platform 只能是 tiktok、instagram 或 youtube');
    text(creator.creator_uid, 150, 'creator.creator_uid', { min: 1 });
    if (creator.name !== undefined) text(creator.name, 150, 'creator.name');
    optionalText(creator.user_name, 150, 'creator.user_name');
    optionalText(creator.country_code, 10, 'creator.country_code');
    httpsUrl(creator.profile_url, 'creator.profile_url');
    httpsUrl(creator.avatar_url, 'creator.avatar_url');
    if (creator.followers_cnt != null) integer(creator.followers_cnt, 0, Number.MAX_SAFE_INTEGER, 'creator.followers_cnt');
    if (typeof request.tracking_number !== 'string' || !/^[A-Za-z0-9-]{5,50}$/.test(request.tracking_number.trim())) invalid('tracking_number 必须是 5～50 位字母、数字或连字符');
    if (request.carrier !== undefined) integer(request.carrier, 0, MAX_CARRIER, 'carrier');
    optionalText(request.recipient, 100, 'recipient');
    optionalText(request.remark, 500, 'remark');
  } else if (operation === 'list' || operation === 'stats') {
    for (const [key, max] of [['query', 150], ['creator_keyword', 150], ['recipient', 100], ['tracking_number', 50]]) if (request[key] !== undefined) text(request[key], max, key);
    optionalText(request.status, 40, 'status');
    if (request.statuses !== undefined && (!Array.isArray(request.statuses) || request.statuses.length > 12 || request.statuses.some(s => !listStatuses.includes(s)))) invalid('statuses 只能是最多 12 个受支持的物流展示状态');
    if (request.overdue !== undefined && typeof request.overdue !== 'boolean') invalid('overdue 必须为 boolean');
    for (const key of ['date_from', 'date_to']) if (request[key] != null) timestamp(request[key], key);
    if (request.date_from && request.date_to && Date.parse(request.date_from) > Date.parse(request.date_to)) invalid('date_from 不能晚于 date_to');
    if (operation === 'list') { request.page ??= 1; request.size ??= 20; }
    // Explicit null is not accepted for either pagination field.
    if (input.page === null || input.size === null) invalid('分页参数不能为 null');
    if (request.page !== undefined) integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
    if (request.size !== undefined) integer(request.size, 1, 100, 'size');
  } else {
    uuid(request.shipment_id, 'shipment_id');
    if (operation !== 'get') integer(request.version, 0, Number.MAX_SAFE_INTEGER, 'version');
    if (operation === 'change_carrier') integer(request.carrier, 1, MAX_CARRIER, 'carrier');
    if (operation === 'follow_up') {
      // `status` is required; null explicitly clears the manual follow-up status.
      if (!('status' in request) || !(request.status === null || USER_STATUSES.includes(request.status))) invalid(`status 必填，取值为 ${USER_STATUSES.join('、')} 或 null（null 表示清除）`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const isText = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullable = check => value => value === null || value === undefined || check(value);
function shipment(value) {
  if (!object(value) || !uuidPattern.test(value.id) || !uuidPattern.test(value.operation_id) || !object(value.creator) || !platforms.includes(value.creator.platform)
    || !isText(value.creator.creator_uid) || !isText(value.tracking_number) || !Number.isSafeInteger(value.carrier) || !registerStates.includes(value.register_status)
    || !isText(value.shipment_status) || !trackingStates.includes(value.tracking_status) || !nullable(s => USER_STATUSES.includes(s))(value.user_tracking_status)
    || !billingStates.includes(value.billing_status) || !nullable(Number.isSafeInteger)(value.charged_credits) || !Array.isArray(value.events) || !Array.isArray(value.milestones)
    || typeof value.overdue !== 'boolean' || !nullable(isText)(value.error_code) || !nullable(a => pendingActions.includes(a))(value.pending_action)
    || !count(value.version) || !isText(value.created_at) || !isText(value.updated_at)) protocol();
  // Event time may be unknown (null); time_raw then carries the provider's original values.
  for (const event of value.events) if (!object(event) || !isText(event.event_key) || !nullable(isText)(event.time) || !isText(event.description ?? '')) protocol();
}
export function validateResult(operation, data) {
  if (operation === 'carriers') {
    if (!object(data) || !Array.isArray(data.items) || data.items.some(c => !object(c) || !Number.isSafeInteger(c.key) || !isText(c.name) || !isText(c.name_zh) || !isText(c.country_iso))) protocol();
  } else if (operation === 'list') {
    if (!object(data) || !Array.isArray(data.items) || !count(data.total) || !Number.isSafeInteger(data.page) || data.page < 1 || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > 100) protocol();
    data.items.forEach(shipment);
  } else if (operation === 'stats') {
    if (!object(data) || !statsKeys.every(key => count(data[key]))) protocol();
  } else if (operation === 'delete') {
    if (!object(data) || data.deleted !== true) protocol();
  } else shipment(data);
}

export function createLogisticsClient({ baseUrl, apiKey, transport, timeoutMs = 30000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new LogisticsError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new LogisticsError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new LogisticsError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new LogisticsError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const executes = operations[operation].executes;
    const outcome = executes ? 'unknown' : 'unavailable';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LogisticsError('timeout', executes ? '请求超时；运单变更或供应商调用结果可能未知，先用 get 读取最新状态，不自动重发' : '请求超时', { outcome })); }, timeoutMs); });
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
          throw new LogisticsError('http', '物流追踪请求被服务端拒绝；按 HTTP/code 核对权限、输入、版本或服务状态', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetry ? { retry_after: retry } : {}),
            outcome: executes && (response.status >= 500 || uncertainReasons.includes(reason)) ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== SUCCESS_STATUS || result.success !== true || result.error !== null) protocol();
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof LogisticsError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new LogisticsError('network', executes ? '连接中断；运单变更或供应商调用结果可能未知，先用 get 读取最新状态，不自动重发' : '连接中断', { outcome });
    } finally { clearTimeout(timer); }
  } };
}
