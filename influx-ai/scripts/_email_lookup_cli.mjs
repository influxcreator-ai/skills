import { readFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { createEmailLookupClient, EmailLookupError } from './_email_lookup_client.mjs';
export { isMain };
export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error } = {}) {
  try {
    let raw;
    if (args.length === 1 && !args[0].startsWith('--')) raw = args[0];
    else if (args.length === 2 && args[0] === '--input-file') {
      try { raw = await readFile(args[1], 'utf8'); } catch { throw new EmailLookupError('input', '无法读取本地 JSON 请求文件'); }
    } else throw new EmailLookupError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new EmailLookupError('input', '请求必须为 JSON 对象'); }
    const active = client ?? createEmailLookupClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    const response = await active.execute(operation, input);
    stdout(JSON.stringify(response, null, 2));
    if (operation === 'create') stderr('202 仅表示受理；使用 batch_id 查询进度和条目，不代表已找到邮箱。');
    return 0;
  } catch (error) {
    const safe = error instanceof EmailLookupError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
