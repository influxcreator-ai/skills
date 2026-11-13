import { readFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { createHashtagSearchClient, HashtagSearchError, operations, TERMINAL_STATUSES } from './_hashtag_deep_search_client.mjs';
export { isMain };

// Waiting budget for `get --wait`: poll every 2 s, at most 30 times (about one minute).
export const WAIT_INTERVAL_MS = 2000;
export const WAIT_MAX_ATTEMPTS = 30;
const notes = {
  submit: '202 仅表示已受理，不代表任务完成或已成功派发；保留 data.id，用 get 查询进度。',
  next: '202 仅表示已受理，不代表任务完成；使用返回的新任务 ID（data.id）调用 get 查询，不要再用前批 ID。',
  retry: '202 仅表示已受理，不代表任务完成；用同一任务 ID 调用 get 查询新一轮进度。',
};
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runCli(operation, {
  args = process.argv.slice(2), env = process.env, client, sleep = defaultSleep,
  intervalMs = WAIT_INTERVAL_MS, maxAttempts = WAIT_MAX_ATTEMPTS,
  stdout = console.log, stderr = console.error,
} = {}) {
  try {
    if (!operations[operation]) throw new HashtagSearchError('input', '未知 Hashtag 深度搜索操作');
    let inline, file, wait = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--input-file') { if (file !== undefined || !args[index + 1]) throw new HashtagSearchError('input', '--input-file 需要一个本地 JSON 文件'); file = args[++index]; }
      else if (arg === '--wait') wait = true;
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new HashtagSearchError('input', '调用参数无效');
    }
    if ((file === undefined) === (inline === undefined)) throw new HashtagSearchError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    if (wait && operation !== 'get') throw new HashtagSearchError('input', '--wait 只用于 get；submit、next、retry 不会自动轮询');
    let raw = inline;
    if (file !== undefined) { try { raw = await readFile(file, 'utf8'); } catch { throw new HashtagSearchError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new HashtagSearchError('input', '请求必须为 JSON 对象'); }
    const active = client ?? createHashtagSearchClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    let response = await active.execute(operation, input);
    if (wait) {
      // Only `get` is polled. The loop never starts, retries or advances a task.
      let attempts = 1;
      while (!TERMINAL_STATUSES.includes(response.data.status) && attempts < maxAttempts) {
        await sleep(intervalMs);
        response = await active.execute('get', input);
        attempts++;
      }
      stdout(JSON.stringify(response, null, 2));
      if (!TERMINAL_STATUSES.includes(response.data.status)) {
        const { id, status, stage } = response.data;
        stderr(JSON.stringify({ wait: { task_id: id, status, stage, attempts, message: '等待预算已用完，任务仍在执行；稍后再次运行 get（可加 --wait）查询同一个 task_id，不要重新提交' } }));
        return 2;
      }
      return 0;
    }
    stdout(JSON.stringify(response, null, 2));
    if (notes[operation]) stderr(notes[operation]);
    return 0;
  } catch (error) {
    const safe = error instanceof HashtagSearchError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
