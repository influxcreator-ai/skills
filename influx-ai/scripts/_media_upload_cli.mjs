import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain } from './_common.mjs';
import { createMediaUploadClient, MediaUploadError, prepareStatus, SERVER_DEADLINE_SECONDS } from './_media_upload_client.mjs';
export { isMain };

// --wait polls status every 3 s, at most 100 times (5 min). The server gives an accepted upload up to
// SERVER_DEADLINE_SECONDS before it is marked failed/upload_timeout, so a run that outlasts the budget
// is still recoverable by calling status again with the same upload_id.
export const WAIT = Object.freeze({ intervalMs: 3000, attempts: 100 });

const safe = error => (error instanceof MediaUploadError
  ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome', 'upload_id', 'failure_code'].filter(key => error[key] !== undefined).map(key => [key, error[key]]))
  : { kind: 'local', message: '本地操作失败，未输出原始异常' });

// Fixed hints per known failure code; the server's free text is never echoed.
const FAILURE_HINTS = {
  upload_timeout: '上传超时，没有可用的 oss_url。文件已完整送到服务端，但传到存储时超时（大文件或网络慢时常见）；告诉用户超时，由用户决定是否重新上传',
  storage_upload_failed: '上传存储失败，没有可用的 oss_url；由用户决定是否重新上传，反复失败时带上 upload_id 反馈',
};
export const failureHint = code => FAILURE_HINTS[code] ?? '上传失败，没有可用的 oss_url；按 failure_code 报告，由用户决定是否重新上传';

async function waitFor(active, uploadId, { stdout, stderr, sleep, wait }) {
  let response;
  for (let attempt = 1; attempt <= wait.attempts; attempt++) {
    response = await active.status({ upload_id: uploadId });
    if (response.data.status !== 'uploading') break;
    if (attempt < wait.attempts) await sleep(wait.intervalMs);
  }
  stdout(JSON.stringify(response, null, 2));
  const { status, failure_code } = response.data;
  if (status === 'uploading') {
    stderr(JSON.stringify({ wait: { upload_id: uploadId, status, message: `等待预算已用完，上传仍在进行；稍后用同一个 upload_id 再运行 status（可加 --wait）。服务端受理后最多 ${SERVER_DEADLINE_SECONDS / 60} 分钟仍未完成会标为 upload_timeout。不要重新上传` } }));
    return 2;
  }
  if (status === 'failed') {
    stderr(JSON.stringify({ error: { kind: 'upload_failed', upload_id: uploadId, failure_code, message: failureHint(failure_code) } }));
    return 1;
  }
  stderr('上传完成。data.oss_url 是私有对象的稳定引用，不能匿名下载；只把它传给需要素材的工具。上传本身不会触发分析或审核。');
  return 0;
}

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error, sleep = delay, wait = WAIT } = {}) {
  try {
    if (!['submit', 'status'].includes(operation)) throw new MediaUploadError('input', '未知素材上传操作');
    const options = {};
    let inline;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const take = key => { if (options[key] !== undefined || !args[index + 1]) throw new MediaUploadError('input', `${arg} 需要一个值`); options[key] = args[++index]; };
      if (arg === '--wait' && !options.wait) options.wait = true;
      else if (operation === 'submit' && arg === '--file') take('file');
      else if (operation === 'submit' && arg === '--type') take('type');
      else if (operation === 'status' && arg === '--input-file') take('inputFile');
      else if (operation === 'status' && !arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new MediaUploadError('input', '调用参数无效');
    }
    const active = client ?? createMediaUploadClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    if (operation === 'submit') {
      if (options.file === undefined || options.type === undefined) throw new MediaUploadError('input', '使用 --file <本地文件> --type <document|image|video>');
      const response = await active.submit(options.file, options.type);
      if (options.wait) {
        stderr(JSON.stringify({ accepted: { upload_id: response.data.upload_id, message: '已受理，正在等待上传完成' } }));
        return await waitFor(active, response.data.upload_id, { stdout, stderr, sleep, wait });
      }
      stdout(JSON.stringify(response, null, 2));
      stderr('HTTP 202 只表示服务端已收到文件，上传 OSS 还在进行。保存 data.upload_id，用 status（可加 --wait）查询，拿到 succeeded 和 oss_url 后再使用。');
      return 0;
    }
    if ((options.inputFile === undefined) === (inline === undefined)) throw new MediaUploadError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    let raw = inline;
    if (options.inputFile !== undefined) { try { raw = await readFile(options.inputFile, 'utf8'); } catch { throw new MediaUploadError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new MediaUploadError('input', '请求必须为 JSON 对象'); }
    if (options.wait) return await waitFor(active, prepareStatus(input).upload_id, { stdout, stderr, sleep, wait });
    const response = await active.status(input);
    stdout(JSON.stringify(response, null, 2));
    const { status, failure_code } = response.data;
    if (status === 'uploading') stderr('仍在上传；稍后再查同一个 upload_id，不要重新上传。');
    else if (status === 'failed') stderr(`failure_code=${failure_code}：${failureHint(failure_code)}`);
    else stderr('上传完成。data.oss_url 是私有对象的稳定引用，不能匿名下载。');
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ error: safe(error) }));
    return 1;
  }
}
