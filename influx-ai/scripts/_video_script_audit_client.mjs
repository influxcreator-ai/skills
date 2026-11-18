// Script and video audit only. No automatic import, stage execution, enhancement audit or report generation.
// Materials reach this tool as a public oss_url from the shared media upload scripts; this client never uploads.
const base = '/v1/video-script-audit';
// `executes` marks operations that write data, dispatch work or may call IMM/models; their outcome stays unknown after an ambiguous failure.
export const operations = Object.freeze({
  create: { path: `${base}/sessions/create`, executes: true },
  projects_list: { path: `${base}/projects/list`, executes: false },
  projects_get: { path: `${base}/projects/get`, executes: false },
  sessions_list: { path: `${base}/sessions/list`, executes: false },
  history: { path: `${base}/sessions/history`, executes: false },
  import: { path: `${base}/sessions/materials/import`, executes: true },
  execute: { path: `${base}/sessions/stages/execute`, executes: true },
  status: { path: `${base}/sessions/stages/status`, executes: false },
  result: { path: `${base}/sessions/result`, executes: false },
});
export const SUCCESS_STATUS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
export const MODES = Object.freeze(['project', 'independent', 'collaboration']);
export const INDUSTRIES = Object.freeze(['ecommerce', 'game']);
export const ACTIONS = Object.freeze(['parse_brief', 'script_qc', 'analyze_video', 'run_audit']);
export const STAGES = Object.freeze(['brief_upload', 'brief_upload_script', 'brief_parse', 'script_qc', 'video_upload', 'video_analysis', 'content_audit']);
export const SESSION_TYPES = Object.freeze(['video_script_audit', 'video_script_session_audit_project']);
// Which stage to watch after each action, and after importing each material.
export const ACTION_STAGE = Object.freeze({ parse_brief: 'brief_parse', script_qc: 'script_qc', analyze_video: 'video_analysis', run_audit: 'content_audit' });
// Terminal stage statuses from the existing audit tables. `pending` means no record yet, not "queued".
export const DONE = Object.freeze(['completed', 'partial']);
export const FAILED = Object.freeze(['failed', 'upload_failed', 'download_failed', 'transcode_failed', 'slice_failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only these controlled messages become a `reason`; any other server text stays out of diagnostics.
const publicReasons = ['session_not_found', 'invalid_audit_request', 'audit_state_not_allowed', 'upload_reference_not_found', 'upload_reference_not_ready', 'upload_status_unavailable', 'payload_too_large'];

export class VideoScriptAuditError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new VideoScriptAuditError('input', message); };
const protocol = () => { throw new VideoScriptAuditError('protocol', '脚本与视频审核响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fields(value, allowed) {
  if (!object(value)) invalid('请求必须是 JSON 对象');
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) invalid(`请求包含未开放字段：${extra.join(', ')}`);
}
const has = value => value !== undefined && value !== null;
function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${label} 必须是 UUID 字符串，使用 create、list 或 history 返回的值`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 必须为 ${min}～${max} 的整数`);
}
function length(value, min, max, label) {
  if (typeof value !== 'string' || [...value.trim()].length < min || [...value.trim()].length > max) invalid(`${label} 必须是 ${min}～${max} 字符的文本`);
}
function page(request) {
  if (request.page === null || request.size === null) invalid('page 与 size 不能为 null');
  if (request.page !== undefined) integer(request.page, 1, Number.MAX_SAFE_INTEGER, 'page');
  if (request.size !== undefined) integer(request.size, 1, 100, 'size');
}
// Either the untouched oss_url from a succeeded public upload (the server checks the receipt), or a public external
// link the backend's importer supports. Which link types work is the server's decision; only HTTPS is required here.
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2000) invalid('source_url 必须是 1～2000 字符的 HTTPS 地址：公开上传回执里的 oss_url，或公开外部链接');
  let url;
  try { url = new URL(value); } catch { invalid('source_url 必须是 HTTPS 地址：公开上传回执里的 oss_url，或公开外部链接'); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid('source_url 必须是不含用户名或密码的 HTTPS 地址');
}

export function prepareRequest(operation, input) {
  if (!operations[operation]) invalid('未知审核操作');
  const allowed = {
    create: ['mode', 'industry', 'name', 'category', 'project_session_id'],
    projects_list: ['page', 'size'],
    projects_get: ['project_session_id'],
    sessions_list: ['project_session_id', 'page', 'size'],
    history: ['page', 'size', 'session_type', 'parent_id', 'root_only'],
    import: ['session_id', 'material_type', 'source_url', 'parameters'],
    execute: ['session_id', 'action'],
    status: ['session_id', 'stage'],
    result: ['session_id'],
  }[operation];
  fields(input, allowed);
  const request = structuredClone(input);
  if (operation === 'create') {
    if (!MODES.includes(request.mode)) invalid('mode 只能是 project、independent 或 collaboration');
    if (has(request.name)) length(request.name, 1, 256, 'name');
    if (request.mode === 'collaboration') {
      uuid(request.project_session_id, 'project_session_id');
      if (has(request.industry) || has(request.category)) invalid('collaboration 继承项目的 industry 和 category，不能另传');
    } else {
      if (!INDUSTRIES.includes(request.industry)) invalid('project 和 independent 必须提供 industry：ecommerce 或 game');
      if (has(request.project_session_id)) invalid('只有 collaboration 接受 project_session_id');
      if (has(request.category)) length(request.category, 1, 64, 'category');
    }
  } else if (operation === 'projects_list') page(request);
  else if (operation === 'projects_get') uuid(request.project_session_id, 'project_session_id');
  else if (operation === 'sessions_list') { uuid(request.project_session_id, 'project_session_id'); page(request); }
  else if (operation === 'history') {
    page(request);
    if (has(request.session_type) && !SESSION_TYPES.includes(request.session_type)) invalid('session_type 只能是 video_script_audit 或 video_script_session_audit_project');
    if (has(request.parent_id)) uuid(request.parent_id, 'parent_id');
    if (has(request.root_only) && typeof request.root_only !== 'boolean') invalid('root_only 只能是布尔值或省略');
    if (has(request.parent_id) && has(request.root_only)) invalid('parent_id 与 root_only 不能同时填写');
  } else {
    uuid(request.session_id, 'session_id');
    if (operation === 'import') {
      if (!['brief', 'video'].includes(request.material_type)) invalid('material_type 只能是 brief 或 video');
      sourceUrl(request.source_url);
      if (has(request.parameters)) fields(request.parameters, ['doc_type']);
      const docType = request.parameters?.doc_type ?? null;
      if (request.material_type === 'brief' && !['client', 'script'].includes(docType)) invalid('brief 必须带 parameters.doc_type：client（客户 Brief）或 script（脚本）');
      if (request.material_type === 'video' && docType !== null) invalid('video 不接受 doc_type');
    }
    if (operation === 'execute' && !ACTIONS.includes(request.action)) invalid(`action 只能是 ${ACTIONS.join('、')}；本工具不开放增强审核`);
    if (operation === 'status' && has(request.stage) && !STAGES.includes(request.stage)) invalid(`stage 只能是 ${STAGES.join('、')}，或省略查询全部`);
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) invalid('请求体超过 64 KiB');
  return request;
}

const isText = value => typeof value === 'string';
const count = value => Number.isSafeInteger(value) && value >= 0;
const sameId = (a, b) => isText(a) && isText(b) && a.toLowerCase() === b.toLowerCase();
function pageResult(data) {
  if (!object(data) || !Array.isArray(data.items) || data.items.some(item => !object(item)) || !count(data.total)
    || !Number.isSafeInteger(data.page) || data.page < 1 || !Number.isSafeInteger(data.size) || data.size < 1) protocol();
}
// Public stage projection: status and error_code only; video_upload may add duration_ms.
function stageState(value, name) {
  if (!object(value) || !isText(value.status) || !(value.error_code === null || value.error_code === undefined || isText(value.error_code))) protocol();
  if (value.duration_ms !== undefined && value.duration_ms !== null && (name !== 'video_upload' || !(typeof value.duration_ms === 'number' && value.duration_ms >= 0))) protocol();
}
// Every open stage must be present, and no other key.
function allStages(stages) {
  if (!object(stages) || Object.keys(stages).length !== STAGES.length || STAGES.some(name => !(name in stages))) protocol();
  for (const name of STAGES) stageState(stages[name], name);
}
const optionalObject = value => value === null || value === undefined || object(value);
// result.script_audit / video_audit: absent, null, or an object whose html_report_url is a string or null (never missing).
const auditReport = value => value === null || value === undefined
  || (object(value) && (value.html_report_url === null || typeof value.html_report_url === 'string'));
export function validateResult(operation, data, request) {
  if (operation === 'create') {
    if (!object(data) || !isText(data.session_id) || !UUID.test(data.session_id) || !isText(data.status)) protocol();
    if (request.mode === 'project' && !sameId(data.project_session_id, data.session_id)) protocol();
    if (request.mode === 'collaboration' && !sameId(data.project_session_id, request.project_session_id)) protocol();
  } else if (['projects_list', 'sessions_list', 'history'].includes(operation)) pageResult(data);
  else if (operation === 'projects_get') { if (!object(data) || !sameId(data.project_session_id, request.project_session_id)) protocol(); }
  else if (operation === 'import') {
    if (!object(data) || !sameId(data.session_id, request.session_id) || data.material_type !== request.material_type || !isText(data.status) || !(data.material_id === null || isText(data.material_id))) protocol();
  } else if (operation === 'execute') {
    if (!object(data) || !sameId(data.session_id, request.session_id) || data.action !== request.action || !isText(data.status) || !(data.task_id === null || isText(data.task_id))) protocol();
  } else if (operation === 'status') {
    if (!object(data) || !sameId(data.session_id, request.session_id)) protocol();
    if (has(request.stage)) { if (data.stage !== request.stage) protocol(); stageState(data, request.stage); }
    else allStages(data.stages);
  } else if (operation === 'result') {
    if (!object(data) || !object(data.session) || !sameId(data.session.session_id, request.session_id) || !Array.isArray(data.materials)) protocol();
    if (data.materials.some(item => !object(item) || !['brief', 'video'].includes(item.material_type))) protocol();
    allStages(data.stages);
    if (!optionalObject(data.brief_parse) || ![data.script_audit, data.video_audit].every(auditReport)) protocol();
  } else protocol();
}

function validRetryAfter(value) {
  return value !== null && (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) || Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value);
}

export function createVideoScriptAuditClient({ baseUrl, apiKey, transport, timeoutMs = 60000 } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new VideoScriptAuditError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new VideoScriptAuditError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new VideoScriptAuditError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new VideoScriptAuditError('configuration', 'transport 或 timeoutMs 无效');
  const secret = apiKey.trim();
  return { async execute(operation, input) {
    const request = prepareRequest(operation, input);
    const { executes } = operations[operation];
    const outcome = executes ? 'unknown' : 'unavailable';
    const ambiguous = executes ? {
      create: '；会话可能已经创建。先运行 history 查看，不要直接重建',
      import: '；素材可能已经导入。先运行 status 查看对应上传阶段，不要重复导入',
      execute: '；阶段可能已经启动。先运行 status 查看对应阶段，不要重复执行',
    }[operation] : '';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new VideoScriptAuditError('timeout', `请求超时${ambiguous}`, { outcome })); }, timeoutMs); });
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
          const reason = publicReasons.includes(result.error.message) ? result.error.message : undefined;
          throw new VideoScriptAuditError('http', '审核请求被服务端拒绝；按 HTTP/code 和 reason 核对权限、输入或阶段前置条件', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetryAfter(retry) ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== SUCCESS_STATUS || result.success !== true || result.error !== null) protocol();
        // No settlement fact is available; null is not "free".
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if ((result.meta[field] ?? null) !== null) protocol();
        validateResult(operation, result.data, request);
        return result;
      })()]);
    } catch (error) {
      if (error instanceof VideoScriptAuditError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new VideoScriptAuditError('network', `连接中断${ambiguous}`, { outcome });
    } finally { clearTimeout(timer); }
  } };
}
