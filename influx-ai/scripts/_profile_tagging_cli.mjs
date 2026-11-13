import { readFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { BATCH_TERMINAL, COLLECTION_ACTIVE, createProfileTaggingClient, operations, ProfileTaggingError } from './_profile_tagging_client.mjs';
export { isMain };

// Waiting budget for `get_batch --wait`: poll every 2 s, at most 30 times.
export const WAIT_INTERVAL_MS = 2000;
export const WAIT_MAX_ATTEMPTS = 30;
const notes = {
  submit: '202 仅表示已受理，不代表画像完成或已确认成功派发；保留 data.id（批次 ID），用 get_batch 查询。后台采集独立推进，批次完成不表示采集完成。',
  retry: '202 仅表示已受理，不代表画像完成；用 data.batch_id 和 data.id 通过 get_batch、get_item 查询。重试可能再次产生外部调用成本。',
};
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runCli(operation, {
  args = process.argv.slice(2), env = process.env, client, sleep = defaultSleep,
  intervalMs = WAIT_INTERVAL_MS, maxAttempts = WAIT_MAX_ATTEMPTS,
  stdout = console.log, stderr = console.error,
} = {}) {
  try {
    if (!operations[operation]) throw new ProfileTaggingError('input', '未知画像打标操作');
    let inline, file, wait = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--input-file') { if (file !== undefined || !args[index + 1]) throw new ProfileTaggingError('input', '--input-file 需要一个本地 JSON 文件'); file = args[++index]; }
      else if (arg === '--wait') wait = true;
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new ProfileTaggingError('input', '调用参数无效');
    }
    if ((file === undefined) === (inline === undefined)) throw new ProfileTaggingError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    if (wait && operation !== 'get_batch') throw new ProfileTaggingError('input', '--wait 只用于 get_batch；submit、retry 不会自动轮询');
    let raw = inline;
    if (file !== undefined) { try { raw = await readFile(file, 'utf8'); } catch { throw new ProfileTaggingError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new ProfileTaggingError('input', '请求必须为 JSON 对象，ID 应使用字符串'); }
    const active = client ?? createProfileTaggingClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    let response = await active.execute(operation, input);
    if (wait) {
      // Only `get_batch` is polled. The loop never submits, retries or changes an item.
      let attempts = 1;
      while (!BATCH_TERMINAL.includes(response.data.status) && attempts < maxAttempts) {
        await sleep(intervalMs);
        response = await active.execute('get_batch', input);
        attempts++;
      }
      stdout(JSON.stringify(response, null, 2));
      const { id, status, stage_counts, collection_counts } = response.data;
      if (!BATCH_TERMINAL.includes(status)) {
        stderr(JSON.stringify({ wait: { batch_id: id, status, stage_counts, attempts, message: '等待预算已用完，批次仍在执行；稍后再次运行 get_batch（可加 --wait）查询同一个 batch_id，不要重新提交' } }));
        return 2;
      }
      // Tagging finished; background collection is a separate line of state.
      if (COLLECTION_ACTIVE.some(key => collection_counts[key] > 0)) stderr(JSON.stringify({ note: { batch_id: id, collection_counts, message: '画像批次已结束，但后台采集仍在进行；采集状态以 collection_counts 和条目的 collection_status 为准' } }));
      return 0;
    }
    stdout(JSON.stringify(response, null, 2));
    if (notes[operation]) stderr(notes[operation]);
    return 0;
  } catch (error) {
    const safe = error instanceof ProfileTaggingError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
