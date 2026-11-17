// Shared media upload only. Uploading never starts analysis, review or any model call.
// The public path and scope are spelled `media_uoload` on purpose; that is the server's contract.
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const base = '/v1/media_uoload';
export const operations = Object.freeze({
  submit: { path: `${base}/submit`, executes: true, success: 202 },
  status: { path: `${base}/status`, executes: false, success: 200 },
});
export const SCOPE = 'media_uoload';
const MiB = 1024 * 1024;
// Server defaults. Downstream tools apply their own, usually stricter, limits.
export const MAX_BYTES = Object.freeze({ document: 50 * MiB, image: 50 * MiB, video: 500 * MiB });
// Extension decides the transfer category and MIME type; it is not a content check.
export const FORMATS = Object.freeze({
  document: Object.freeze(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'html', 'htm', 'pptx']),
  image: Object.freeze(['png', 'jpg', 'jpeg', 'webp']),
  video: Object.freeze(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']),
});
export const STATUSES = Object.freeze(['uploading', 'succeeded', 'failed']);
// Server-side execution deadline after acceptance; an upload still running past it ends as failed/upload_timeout.
export const FAILURE_CODES = Object.freeze(['upload_timeout', 'storage_upload_failed']);
export const SERVER_DEADLINE_SECONDS = 1800;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only these controlled messages become a `reason`; any other server text stays out of diagnostics.
const publicReasons = ['upload_capacity_exceeded', 'invalid_filename', 'unsupported_file_type', 'file_too_large', 'empty_file', 'upload_storage_unavailable', 'upload_status_unavailable', 'upload_not_found', 'invalid_multipart', 'payload_too_large'];

export class MediaUploadError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}
const invalid = message => { throw new MediaUploadError('input', message); };
const protocol = () => { throw new MediaUploadError('protocol', '素材上传响应不符合公开契约'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Validate a local file against the server's transfer rules before sending anything.
export async function inspectFile(path, fileType) {
  if (!Object.hasOwn(FORMATS, fileType)) invalid('file_type 只能是 document、image 或 video');
  if (typeof path !== 'string' || !path.trim()) invalid('必须提供本地文件路径');
  let info;
  try { info = await stat(path); } catch { invalid('找不到本地文件，或没有读取权限'); }
  if (!info.isFile()) invalid('路径必须指向一个普通文件');
  const filename = basename(path);
  if (!filename || [...filename].length > 255 || /[\u0000-\u001f\\/]/.test(filename)) invalid('文件名必须是 1～255 字符，不含控制字符或路径分隔符');
  const ext = extname(filename).toLowerCase().replace(/^\./, '');
  if (!FORMATS[fileType].includes(ext)) invalid(`${fileType} 只接受扩展名：${FORMATS[fileType].join('、')}`);
  if (info.size < 1) invalid('文件为空');
  if (info.size > MAX_BYTES[fileType]) invalid(`${fileType} 最大 ${MAX_BYTES[fileType] / MiB} MiB，当前 ${(info.size / MiB).toFixed(1)} MiB`);
  return { path, filename, ext, size: info.size };
}

// Streamed SHA-256 so a 500 MiB video is never held in memory.
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

export function prepareStatus(input) {
  if (!object(input) || Object.keys(input).some(key => key !== 'upload_id')) invalid('请求对象只接受 upload_id');
  if (typeof input.upload_id !== 'string' || !UUID.test(input.upload_id)) invalid('upload_id 必须是 submit 返回的 UUID');
  return { upload_id: input.upload_id };
}

export function validateResult(data, { uploadId, expectStatus, expectPublic } = {}) {
  if (!object(data) || typeof data.upload_id !== 'string' || !UUID.test(data.upload_id) || (uploadId !== undefined && data.upload_id.toLowerCase() !== uploadId.toLowerCase())
    || typeof data.public !== 'boolean' || (expectPublic !== undefined && data.public !== expectPublic)
    || !STATUSES.includes(data.status) || typeof data.filename !== 'string' || !Object.hasOwn(FORMATS, data.file_type) || typeof data.content_type !== 'string'
    || !Number.isSafeInteger(data.size_bytes) || data.size_bytes < 1 || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) protocol();
  if (expectStatus && data.status !== expectStatus) protocol();
  const done = data.status === 'succeeded';
  if (done !== (typeof data.oss_url === 'string' && data.oss_url !== '') || done !== (typeof data.oss_key === 'string' && data.oss_key !== '')) protocol();
  if (!done && (data.oss_url ?? null) !== null) protocol();
  if ((data.status === 'failed') !== (typeof data.failure_code === 'string' && data.failure_code !== '')) protocol();
  if (data.failure_message !== undefined && data.failure_message !== null && typeof data.failure_message !== 'string') protocol();
}

function validRetryAfter(value) {
  return value !== null && (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) || Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value);
}

export function createMediaUploadClient({ baseUrl, apiKey, transport, timeoutMs = 30000, uploadTimeoutMs = 30 * 60 * 1000, openBlob = openAsBlob } = {}) {
  let root;
  try { root = new URL(baseUrl); } catch { throw new MediaUploadError('configuration', 'SCOUT_API_BASE_URL 必须为服务地址'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new MediaUploadError('configuration', '服务地址不接受凭据、查询或片段');
  const prefix = root.pathname.replace(/\/+$/, '');
  root.pathname = prefix.endsWith('/openapi') ? prefix : `${prefix}/openapi`;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new MediaUploadError('configuration', 'SCOUT_API_KEY 未配置');
  if ((transport !== undefined && typeof transport !== 'function') || ![timeoutMs, uploadTimeoutMs].every(v => Number.isSafeInteger(v) && v >= 1)) throw new MediaUploadError('configuration', 'transport 或超时设置无效');
  const secret = apiKey.trim();
  const url = path => `${root.toString().replace(/\/$/, '')}${path}`;

  async function call(operation, body, headers, limit) {
    const { executes, success } = operations[operation];
    const outcome = executes ? 'unknown' : 'unavailable';
    const ambiguous = executes ? '；服务端可能已经受理，但没有 upload_id 就无法查询。重新上传会生成新的对象，由用户决定' : '';
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MediaUploadError('timeout', `请求超时${ambiguous}`, { outcome })); }, limit); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await (transport ?? globalThis.fetch)(url(operations[operation].path), {
          method: 'POST', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', 'X-API-Key': secret, ...headers }, body,
        });
        let result;
        try { result = JSON.parse(await response.text()); } catch { protocol(); }
        if (!object(result) || typeof result.success !== 'boolean' || !object(result.meta)) protocol();
        if (!response.ok) {
          if (result.success !== false || result.data !== null || result.error?.code !== response.status * 100 + 1 || typeof result.error?.message !== 'string') protocol();
          const retry = response.headers.get('Retry-After');
          const reason = publicReasons.includes(result.error.message) ? result.error.message : undefined;
          throw new MediaUploadError('http', '素材上传请求被服务端拒绝；按 HTTP/code 和 reason 核对权限、文件或上传状态', {
            status: response.status, code: result.error.code,
            ...(reason ? { reason } : {}),
            ...(typeof result.meta.request_id === 'string' ? { request_id: result.meta.request_id.split(secret).join('[已隐藏]') } : {}),
            ...(response.status === 429 && validRetryAfter(retry) ? { retry_after: retry } : {}),
            outcome: executes && response.status >= 500 ? 'unknown' : 'rejected',
          });
        }
        if (response.status !== success || result.success !== true || result.error !== null) protocol();
        // No settlement receipt for uploads; null is not "free".
        for (const field of ['credits_consumed', 'billing_status', 'billing_operation_id']) if ((result.meta[field] ?? null) !== null) protocol();
        return result;
      })()]);
    } catch (error) {
      if (error instanceof MediaUploadError) { if (error.outcome === undefined) error.outcome = outcome; throw error; }
      throw new MediaUploadError('network', `连接中断${ambiguous}`, { outcome });
    } finally { clearTimeout(timer); }
  }

  return {
    // public=true makes the object anonymously readable by anyone holding the URL; only for materials the user agreed to publish.
    async submit(path, fileType, { public: isPublic = false } = {}) {
      if (typeof isPublic !== 'boolean') throw new MediaUploadError('input', 'public 只能是布尔值');
      const file = await inspectFile(path, fileType);
      const localSha = await sha256File(file.path);
      // File-backed Blob: the body is streamed from disk, not loaded into memory.
      const blob = await openBlob(file.path);
      const form = new FormData();
      form.append('file_type', fileType);
      // The field is sent only when public; omitting it keeps the server default (private).
      if (isPublic) form.append('public', 'true');
      form.append('file', blob, file.filename);
      const result = await call('submit', form, {}, uploadTimeoutMs);
      try { validateResult(result.data, { expectStatus: 'uploading', expectPublic: isPublic }); } catch (error) { error.outcome = 'unknown'; throw error; }
      if (result.data.size_bytes !== file.size || result.data.sha256 !== localSha) {
        throw new MediaUploadError('integrity', '服务端收到的大小或 SHA-256 与本地文件不一致；不要使用这次结果，确认文件没有在上传中被修改后重新上传', { outcome: 'rejected', upload_id: result.data.upload_id });
      }
      return result;
    },
    async status(input) {
      const request = prepareStatus(input);
      const result = await call('status', JSON.stringify(request), { 'Content-Type': 'application/json' }, timeoutMs);
      validateResult(result.data, { uploadId: request.upload_id });
      return result;
    },
  };
}
