// Competitor tracking keyword studies only. No automatic create, confirm, refresh, materialize, regenerate, archive or polling.
const base = '/v1/competitor-tracking/keyword-studies';
// `executes` marks operations that create, change or dispatch work; their outcome stays unknown after an ambiguous failure.
export const operations = Object.freeze({
  create: { path: `${base}/create`, executes: true, success: 200 },
  list: { path: `${base}/list`, executes: false, success: 200 },
  get: { path: `${base}/get`, executes: false, success: 200 },
  confirm_keywords: { path: `${base}/confirm-keywords`, executes: true, success: 200 },
  refresh_brand_context: { path: `${base}/refresh-brand-context`, executes: true, success: 200 },
  report: { path: `${base}/report`, executes: false, success: 200 },
  comments: { path: `${base}/comments`, executes: false, success: 200 },
  brand_videos: { path: `${base}/brand-videos`, executes: false, success: 200 },
  materialize: { path: `${base}/materialize`, executes: true, success: 200 },
  regenerate: { path: `${base}/regenerate`, executes: true, success: 200 },
  refresh_existing_evidence: { path: `${base}/refresh-existing-evidence`, executes: true, success: 202 },
  archive: { path: `${base}/archive`, executes: true, success: 200 },
});
export const MAX_BODY_BYTES = 64 * 1024;
export const PLATFORMS = Object.freeze(['tiktok', 'instagram', 'youtube']);
export const STATUSES = Object.freeze(['running', 'completed', 'failed']);
export const STAGES = Object.freeze(['created', 'expanding', 'awaiting_keyword_confirm', 'recalling', 'collecting_comments', 'analyzing', 'report_ready']);
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{1,128}$/;

export class CompetitorTrackingError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new CompetitorTrackingError('input', message); };
const protocol = () => { throw new CompetitorTrackingError('protocol', '竞品追踪响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Only these controlled messages become a `reason`; any other server text stays out of diagnostics.
const publicReasons = ['study_not_found', 'study_creation_conflict', 'study_state_not_allowed', 'invalid_study_request', 'payload_too_large'];

function fields(value, allowed, label = '请求对象') {
  if (!object(value)) invalid(`${label}必须是 JSON 对象`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) invalid(`${label}包含未开放字段：${extra.join(', ')}`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
const text = value => typeof value === 'string' && value.trim() !== '' && value.isWellFormed();
function length(value, min, max, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length < min || [...value].length > max) invalid(`${label} 必须是 ${min}～${max} 字符的文本`);
}
const optional = (value, check) => { if (value !== undefined && value !== null) check(value); };
function studyId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /\s/.test(value)) invalid('study_id 必须是 create 或 list 返回的 study_id（1～256 字符，不含空白）');
}
function textList(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`${label} 需要 ${min}～${max} 项`);
  if (value.some(item => !text(item))) invalid(`${label} 每一项必须是非空文本`);
}
function httpUrls(value, max, label) {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} 最多 ${max} 条`);
  for (const url of value) {
    let parsed;
    try { parsed = new URL(url); } catch { invalid(`${label} 必须是公网 HTTP(S) 链接`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) invalid(`${label} 必须是公网 HTTP(S) 链接`);
  }
}
function isoDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`${label} 必须为 YYYY-MM-DD`);
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) invalid(`${label} 不是有效日期`);
  return probe.getTime();
}
function platforms(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || value.some(item => !PLATFORMS.includes(item))) invalid(`${label} 需要 1～3 个平台，取 tiktok、instagram、youtube`);
}
function group(value, index) {
  const label = `groups[${index}]`;
  fields(value, ['name', 'role', 'seed_keywords', 'match_mode', 'expansion', 'source_urls'], `${label} `);
  length(value.name, 1, 256, `${label}.name`);
  if (value.role !== undefined && !['primary', 'comparison'].includes(value.role)) invalid(`${label}.role 只能是 primary 或 comparison`);
  textList(value.seed_keywords, 1, 20, `${label}.seed_keywords`);
  if (value.match_mode !== undefined && value.match_mode !== 'hashtag') invalid(`${label}.match_mode 只能是 hashtag`);
  if (value.source_urls !== undefined) httpUrls(value.source_urls, 5, `${label}.source_urls`);
  if (value.expansion !== undefined) {
    const expansion = value.expansion;
    fields(expansion, ['mode', 'brand_affinity', 'include_bare_stem', 'max_expand_tags'], `${label}.expansion `);
    if (expansion.mode !== undefined && !['family', 'brand_broad', 'strict'].includes(expansion.mode)) invalid(`${label}.expansion.mode 只能是 family、brand_broad 或 strict`);
    if (expansion.brand_affinity !== undefined && !['required', 'preferred'].includes(expansion.brand_affinity)) invalid(`${label}.expansion.brand_affinity 只能是 required 或 preferred`);
    if (expansion.include_bare_stem !== undefined && typeof expansion.include_bare_stem !== 'boolean') invalid(`${label}.expansion.include_bare_stem 必须是布尔值`);
    if (expansion.max_expand_tags !== undefined) integer(expansion.max_expand_tags, 0, 16, `${label}.expansion.max_expand_tags`);
  }
}
function scope(value) {
  fields(value, ['platforms', 'time_window_days', 'time_start', 'time_end', 'countries', 'language', 'follower_min', 'follower_max', 'strict_geo'], 'scope ');
  if (value.platforms !== undefined && !(Array.isArray(value.platforms) && value.platforms.length === 0)) platforms(value.platforms, 'scope.platforms');
  optional(value.time_window_days, v => integer(v, 1, 365, 'scope.time_window_days'));
  if (value.countries !== undefined && (!Array.isArray(value.countries) || value.countries.some(item => typeof item !== 'string'))) invalid('scope.countries 必须是国家代码文本数组');
  optional(value.language, v => { if (typeof v !== 'string') invalid('scope.language 必须是语言代码文本'); });
  optional(value.follower_min, v => integer(v, 0, Number.MAX_SAFE_INTEGER, 'scope.follower_min'));
  optional(value.follower_max, v => integer(v, 0, Number.MAX_SAFE_INTEGER, 'scope.follower_max'));
  if (value.strict_geo !== undefined && typeof value.strict_geo !== 'boolean') invalid('scope.strict_geo 必须是布尔值');
  const hasStart = value.time_start != null && value.time_start !== '';
  const hasEnd = value.time_end != null && value.time_end !== '';
  if (hasStart !== hasEnd) invalid('scope.time_start 与 scope.time_end 必须成对传入 YYYY-MM-DD');
  if (hasStart) {
    const days = (isoDate(value.time_end, 'scope.time_end') - isoDate(value.time_start, 'scope.time_start')) / 86400000 + 1;
    if (days < 1) invalid('scope.time_end 不能早于 scope.time_start');
    if (days > 365) invalid('起止日范围不能超过 365 天（含首尾日期）');
  }
  return hasStart;
}
function createRequest(request) {
  if (!Array.isArray(request.groups) || request.groups.length < 1 || request.groups.length > 5) invalid('groups 需要 1～5 组');
  request.groups.forEach(group);
  if (request.groups.filter(item => (item.role ?? 'primary') === 'primary').length !== 1) invalid('groups 必须且只能有 1 个 primary（未写 role 时按 primary 计），其余为 comparison');
  const names = request.groups.map(item => item.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) invalid('groups 的 name 不能重复');
  const explicitDates = request.scope != null ? scope(request.scope) : false;
  if (request.platforms != null && !(Array.isArray(request.platforms) && request.platforms.length === 0)) platforms(request.platforms, 'platforms');
  const scopePlatforms = request.scope?.platforms?.length ? request.scope.platforms : null;
  if (!scopePlatforms && !(request.platforms?.length)) invalid('必须提供平台：scope.platforms（推荐）或 platforms');
  optional(request.time_window_days, v => integer(v, 1, 365, 'time_window_days'));
  if (!explicitDates) {
    const relative = request.time_window_days ?? request.scope?.time_window_days;
    if (relative != null && relative > 90) invalid('相对时间窗口最多 90 天；更长范围请用 scope.time_start / scope.time_end（最多 365 天）');
  }
  optional(request.demand_name, v => length(v, 0, 160, 'demand_name'));
  if (request.intent != null && !['competitor', 'brand'].includes(request.intent)) invalid('intent 只能是 competitor 或 brand');
  optional(request.brief, v => length(v, 0, 8000, 'brief'));
  if (request.industry != null && !['ecommerce', 'finance', 'game', 'general'].includes(request.industry)) invalid('industry 只能是 ecommerce、finance、game 或 general');
  if (request.recall_source !== undefined && !['unified', 'legacy'].includes(request.recall_source)) invalid('recall_source 只能是 unified 或 legacy');
  if (request.force_realtime_collection !== undefined && typeof request.force_realtime_collection !== 'boolean') invalid('force_realtime_collection 必须是布尔值');
  if (request.realtime_sample_minimum !== undefined) integer(request.realtime_sample_minimum, 1, 500, 'realtime_sample_minimum');
  if (request.top_n !== undefined && request.top_n !== null && request.top_n !== 'all') integer(request.top_n, 1, Number.MAX_SAFE_INTEGER, 'top_n');
  if (request.comment_round_video_limit !== undefined) integer(request.comment_round_video_limit, 1, 12, 'comment_round_video_limit');
}
function confirmRequest(request) {
  if (!Array.isArray(request.groups) || request.groups.length < 1) invalid('groups 需要为每个词组各提交一项');
  request.groups.forEach((item, index) => {
    const label = `groups[${index}]`;
    fields(item, ['group_id', 'keywords', 'match_mode', 'expansion_mode'], `${label} `);
    if (!text(item.group_id)) invalid(`${label}.group_id 必须是 get 返回的 group_id`);
    textList(item.keywords, 1, 40, `${label}.keywords`);
    if (item.keywords.some(keyword => /\s/.test(keyword.trim()))) invalid(`${label}.keywords 必须是 hashtag，不能包含空格`);
    if (item.match_mode != null && item.match_mode !== 'hashtag') invalid(`${label}.match_mode 只能是 hashtag`);
    if (item.expansion_mode != null && !['family', 'brand_broad', 'strict'].includes(item.expansion_mode)) invalid(`${label}.expansion_mode 只能是 family、brand_broad 或 strict`);
  });
  const ids = request.groups.map(item => item.group_id.trim());
  if (new Set(ids).size !== ids.length) invalid('groups 的 group_id 不能重复');
  if (request.brand_context_reviewed !== undefined && typeof request.brand_context_reviewed !== 'boolean') invalid('brand_context_reviewed 必须是布尔值');
  if (request.brand_context_revision != null && typeof request.brand_context_revision !== 'string') invalid('brand_context_revision 必须是 get 返回的文本');
  if (request.brand_context_reviewed === true && !text(request.brand_context_revision)) invalid('brand_context_reviewed 为 true 时必须带上 get 刚返回的 brand_context_revision');
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知竞品追踪操作');
  const allowed = {
    create: ['groups', 'platforms', 'time_window_days', 'scope', 'demand_name', 'intent', 'brief', 'industry', 'recall_source', 'force_realtime_collection', 'realtime_sample_minimum', 'top_n', 'comment_round_video_limit'],
    list: ['page', 'size', 'search', 'status', 'stage', 'platform'],
    confirm_keywords: ['study_id', 'groups', 'brand_context_reviewed', 'brand_context_revision'],
    refresh_brand_context: ['study_id', 'source_urls_by_brand'],
    comments: ['study_id', 'term', 'brand_id', 'limit'],
    brand_videos: ['study_id', 'brand_id'],
  }[operation] ?? ['study_id'];
  fields(input, allowed);
  const request = structuredClone(input);
  if (operation === 'create') createRequest(request);
  else if (operation === 'list') {
    if (input.page === null || input.size === null) invalid('page 与 size 不能为 null');
    if (request.page !== undefined) integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
    if (request.size !== undefined) integer(request.size, 1, 100, 'size');
    optional(request.search, v => length(v, 1, 100, 'search'));
    if (request.status != null && !STATUSES.includes(request.status)) invalid('status 只能是 running、completed 或 failed');
    if (request.stage != null && !STAGES.includes(request.stage)) invalid(`stage 只能是 ${STAGES.join('、')}`);
    if (request.platform != null && !PLATFORMS.includes(request.platform)) invalid('platform 只能是 tiktok、instagram 或 youtube');
  } else {
    studyId(request.study_id);
    if (operation === 'confirm_keywords') confirmRequest(request);
    if (operation === 'refresh_brand_context' && request.source_urls_by_brand !== undefined) {
      if (!object(request.source_urls_by_brand)) invalid('source_urls_by_brand 必须是 {group_id: [链接]} 对象');
      for (const [key, urls] of Object.entries(request.source_urls_by_brand)) {
        if (!key.trim()) invalid('source_urls_by_brand 的键必须是 get 返回的 group_id');
        httpUrls(urls, Number.MAX_SAFE_INTEGER, `source_urls_by_brand.${key}`);
      }
    }
    if (operation === 'comments') {
      length(request.term, 1, 128, 'term');
      if (!request.term.trim()) invalid('term 不能为空白');
      optional(request.brand_id, v => length(v, 1, 256, 'brand_id'));
      if (request.limit !== undefined) integer(request.limit, 1, 50, 'limit');
    }
    if (operation === 'brand_videos') length(request.brand_id, 1, 256, 'brand_id');
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const isText = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableText = value => value === null || value === undefined || isText(value);
function study(data, expectedId) {
  if (!object(data) || !text(data.study_id) || (expectedId !== undefined && data.study_id !== expectedId) || !isText(data.status) || !isText(data.stage)
    || !Array.isArray(data.groups) || !object(data.result) || !nullableText(data.brand_context_revision)
    || data.groups.some(item => !object(item) || !isText(item.group_id) || !isText(item.brand_id) || !isText(item.brand_name) || !isText(item.group_role))) protocol();
}
export function validateResult(operation, data, request) {
  if (operation === 'create') study(data);
  else if (['get', 'confirm_keywords', 'refresh_brand_context'].includes(operation)) study(data, request.study_id);
  else if (operation === 'list') {
    if (!object(data) || !Array.isArray(data.items) || !count(data.total) || !Number.isSafeInteger(data.page) || data.page < 1 || !Number.isSafeInteger(data.size) || data.size < 1) protocol();
    data.items.forEach(item => study(item));
  } else if (operation === 'report') { if (!object(data)) protocol(); }
  else if (operation === 'comments') { if (!object(data) || !isText(data.term) || !count(data.total) || !Array.isArray(data.items) || data.items.some(item => !object(item))) protocol(); }
  else if (operation === 'brand_videos') { if (!Array.isArray(data) || data.some(item => !object(item))) protocol(); }
  else if (['materialize', 'regenerate', 'refresh_existing_evidence'].includes(operation)) {
    if (!object(data) || data.study_id !== request.study_id || !Number.isSafeInteger(data.execution_version) || data.execution_version < 1 || data.scheduled !== true) protocol();
  } else if (operation === 'archive') { if (!object(data) || data.study_id !== request.study_id || data.archived !== true) protocol(); }
  else protocol();
}

function validRetryAfter(value) {
  return value !== null && (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) || Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value);
}

export function createCompetitorTrackingClient({ baseUrl, apiKey, transport, timeoutMs = 120000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new CompetitorTrackingError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new CompetitorTrackingError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new CompetitorTrackingError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new CompetitorTrackingError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input, { idempotencyKey } = {}) {
    const request = prepareRequest(operation, input);
    if (operation === 'create') {
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new CompetitorTrackingError('input', 'create 必须提供 Idempotency-Key（1～128 位字母、数字、冒号、下划线或连字符），同一次逻辑创建始终用同一个键');
    } else if (idempotencyKey !== undefined) throw new CompetitorTrackingError('input', '只有 create 接受 Idempotency-Key');
    const { executes, success } = operations[operation];
    const outcome = executes ? 'unknown' : 'unavailable';
    const ambiguous = executes ? (operation === 'create' ? '；研究可能已经创建，用同一个 Idempotency-Key 和同一份请求重新运行 create 恢复，不换键' : '；动作结果可能未知，先用 get 核对状态，不自动重发') : '';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CompetitorTrackingError('timeout', `请求超时${ambiguous}`, { outcome })); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': secret };
        if (operation === 'create') headers['Idempotency-Key'] = idempotencyKey;
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
          throw new CompetitorTrackingError('http', '竞品追踪请求被服务端拒绝；按 HTTP/code 和 reason 核对权限、输入或研究状态', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetryAfter(retry) ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== success || result.success !== true || result.error !== null) protocol();
        // No public settlement receipt on any of these operations; null is not "free".
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if (result.meta[field] !== null) protocol();
        validateResult(operation, result.data, request);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof CompetitorTrackingError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new CompetitorTrackingError('network', `连接中断${ambiguous}`, { outcome });
    } finally { clearTimeout(timer); }
  } };
}
