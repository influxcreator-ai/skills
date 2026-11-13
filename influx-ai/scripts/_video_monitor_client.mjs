// Video monitor only. No automatic registration, collection triggers, renewals or local ledger.
const base = '/v1/video-monitor/monitors';
// `executes` marks operations that create, change or dispatch work; their outcome stays unknown after an ambiguous failure.
export const operations = Object.freeze({
  register: { path: `${base}/register`, executes: true },
  list: { path: `${base}/list`, executes: false },
  get: { path: `${base}/get`, executes: false },
  status: { path: `${base}/status`, executes: true },
  deadline: { path: `${base}/deadline`, executes: true },
  archive: { path: `${base}/archive`, executes: true },
  trigger: { path: `${base}/trigger`, executes: true },
});
export const SUCCESS_STATUS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_TRACK_DAYS = 15;
// Server default, for reference only; the client never fills it in.
export const DEFAULT_INTERVAL_MINUTES = 1440;

export class VideoMonitorError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new VideoMonitorError('input', message); };
const protocol = () => { throw new VideoMonitorError('protocol', '视频监控响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const platforms = ['tiktok', 'youtube', 'instagram'];
const monitorStates = ['active', 'paused', 'stopped', 'archived'];
const MAX_ID = 9223372036854775807n;
// Only these controlled reasons are surfaced; any other server message stays out of diagnostics.
const publicReasons = ['monitor_not_found', 'monitor_state_changed', 'invalid_monitor_request', 'payload_too_large'];

function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求对象包含未开放字段或类型错误');
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
// BIGINT ids travel as decimal strings; JSON numbers lose precision and are not accepted.
function bigintId(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,19}$/.test(value) || BigInt(value) < 1n || BigInt(value) > MAX_ID) invalid('monitor_id 必须为正整数的十进制字符串，不接受 JSON 数字');
}
function calendarDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`${label} 必须为 YYYY-MM-DD 日期`);
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) invalid(`${label} 不是有效日期`);
}
function timezone(value) {
  if (typeof value !== 'string' || !value.trim()) invalid('timezone 必须为 IANA 时区，如 Asia/Shanghai');
  // Only a basic shape check; the server decides which zones it accepts.
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { invalid('timezone 必须为 IANA 时区，如 Asia/Shanghai'); }
}
function awareTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${label} 必须为带时区的 ISO 8601 时间，原样使用 get 或 list 返回的值`);
}
// Exactly one deadline mode: days, or a local date plus its IANA timezone.
function deadlineMode(request, { required }) {
  const hasDays = request.track_days != null;
  const hasDate = request.track_deadline_date != null;
  if (hasDays && hasDate) invalid('track_days 与 track_deadline_date 只能二选一');
  if (required && !hasDays && !hasDate) invalid('必须显式选择 track_days 或 track_deadline_date（加 timezone）之一，没有默认续期');
  if (hasDays) {
    integer(request.track_days, 1, 90, 'track_days');
    if (request.timezone != null) invalid('天数模式不接受 timezone');
  }
  if (hasDate) { calendarDate(request.track_deadline_date, 'track_deadline_date'); timezone(request.timezone); }
  if (!hasDate && request.timezone != null) invalid('只有日期模式接受 timezone');
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知视频监控操作');
  const allowed = {
    register: ['platform', 'video_urls', 'monitor_name', 'track_days', 'track_deadline_date', 'timezone', 'interval_minutes'],
    list: ['platform', 'page', 'page_size', 'days'],
    get: ['monitor_id', 'days'],
    status: ['monitor_id', 'status'],
    deadline: ['monitor_id', 'expected_track_deadline', 'track_days', 'track_deadline_date', 'timezone'],
    archive: ['monitor_id'],
    trigger: ['monitor_id'],
  };
  fields(input, allowed[operation]);
  const request = structuredClone(input);
  if (operation === 'register') {
    if (!platforms.includes(request.platform)) invalid('platform 只能是 tiktok、youtube 或 instagram');
    if (!Array.isArray(request.video_urls) || request.video_urls.length < 1 || request.video_urls.length > 20) invalid('video_urls 需要 1～20 条链接');
    if (request.video_urls.some(url => typeof url !== 'string' || !url.trim() || !url.isWellFormed())) invalid('video_urls 每一项必须是非空链接文本');
    if (request.monitor_name != null && (typeof request.monitor_name !== 'string' || [...request.monitor_name].length > 200)) invalid('monitor_name 最多 200 字符');
    if (request.interval_minutes !== undefined) integer(request.interval_minutes, 30, 1440, 'interval_minutes');
    deadlineMode(request, { required: false });
  } else if (operation === 'list') {
    if (request.platform != null && !platforms.includes(request.platform)) invalid('platform 只能是 tiktok、youtube 或 instagram');
    if (input.page === null || input.page_size === null || input.days === null) invalid('分页与 days 参数不能为 null');
    if (request.page !== undefined) integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
    if (request.page_size !== undefined) integer(request.page_size, 1, 100, 'page_size');
    if (request.days !== undefined) integer(request.days, 1, 365, 'days');
  } else {
    bigintId(request.monitor_id);
    if (operation === 'get' && request.days !== undefined) integer(request.days, 1, 365, 'days');
    if (operation === 'status' && !['active', 'paused'].includes(request.status)) invalid('status 只能是 active（恢复）或 paused（暂停）');
    if (operation === 'deadline') { awareTimestamp(request.expected_track_deadline, 'expected_track_deadline'); deadlineMode(request, { required: true }); }
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const isText = value => typeof value === 'string';
const idString = value => isText(value) && /^[0-9]{1,19}$/.test(value);
const nullable = check => value => value === null || value === undefined || check(value);
const nullableInt = nullable(Number.isSafeInteger);
function monitor(value, detail) {
  if (!object(value) || !idString(value.id) || 'team_id' in value || !isText(value.source_tracking_id) || !isText(value.platform) || !isText(value.video_url)
    || !nullable(isText)(value.monitor_name) || !monitorStates.includes(value.status) || !Number.isSafeInteger(value.interval_minutes)
    || !nullable(isText)(value.next_trigger_at) || !nullable(isText)(value.last_triggered_at) || !isText(value.track_deadline) || !nullable(isText)(value.created_at)
    || !nullable(object)(value.creator_snapshot) || !nullable(object)(value.snapshot) || typeof value.has_tracking_data !== 'boolean' || !isText(value.latest_run_status)) protocol();
  if (detail && (!Array.isArray(value.trend) || !['views_24h', 'views_3d', 'views_7d', 'engagement'].every(key => nullableInt(value[key])))) protocol();
}
const flag = (data, key) => { if (!object(data) || data[key] !== true) protocol(); };
export function validateResult(operation, data) {
  if (operation === 'register') {
    if (!object(data) || !Array.isArray(data.created) || !Array.isArray(data.skipped_urls) || data.skipped_urls.some(url => !isText(url))
      || data.created.some(item => !object(item) || !idString(item.id) || !isText(item.source_tracking_id) || !isText(item.platform) || !isText(item.video_url))) protocol();
  } else if (operation === 'list') {
    if (!object(data) || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.page) || data.page < 1
      || !Number.isSafeInteger(data.page_size) || data.page_size < 1 || data.page_size > 100) protocol();
    data.items.forEach(item => monitor(item, false));
  } else if (operation === 'get') monitor(data, true);
  else if (operation === 'status' || operation === 'deadline') flag(data, 'updated');
  else if (operation === 'archive') flag(data, 'archived');
  else if (operation === 'trigger') flag(data, 'accepted');
  else protocol();
}

export function createVideoMonitorClient({ baseUrl, apiKey, transport, timeoutMs = 30000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new VideoMonitorError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new VideoMonitorError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new VideoMonitorError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new VideoMonitorError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const executes = operations[operation].executes;
    const outcome = executes ? 'unknown' : 'unavailable';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new VideoMonitorError('timeout', executes ? '请求超时；动作结果可能未知，先用 list 或 get 查看现状，不自动重发' : '请求超时', { outcome })); }, timeoutMs); });
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
          throw new VideoMonitorError('http', '视频监控请求被服务端拒绝；按 HTTP/code 核对权限、输入或监控状态', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetry ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== SUCCESS_STATUS || result.success !== true || result.error !== null) protocol();
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof VideoMonitorError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new VideoMonitorError('network', executes ? '连接中断；动作结果可能未知，先用 list 或 get 查看现状，不自动重发' : '连接中断', { outcome });
    } finally { clearTimeout(timer); }
  } };
}
