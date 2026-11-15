import { readFile, writeFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { createRealtimeCollectionClient, operations, RealtimeCollectionError } from './_realtime_collection_client.mjs';
export { isMain };

// Reminders printed after a successful call. Each operation runs exactly once; nothing here chains another call.
const SUBMITTED = '已受理，不代表采集完成。保存 data.task_id，后续 status / data / steps / download 都用它；没有任务历史列表，丢失后无法找回。';
const notes = {
  submit: SUBMITTED,
  keyword_submit: SUBMITTED,
  abort: '已中止本地状态流转；不保证撤销供应商在途采集，也不代表退款。',
  retry: '已对整个任务重新发起采集，计数已重置；这不是只补失败条目。费用由后端按原任务计费身份结算。用 status 查看进度。',
};
const REUSED = '服务端复用了同一 Key、相同参数且仍在进行中的原任务；data.status 是原任务的当前状态，不是新任务。';

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error } = {}) {
  try {
    if (!operations[operation]) throw new RealtimeCollectionError('input', '未知实时采集操作');
    let inline, file, output;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--input-file') { if (file !== undefined || !args[index + 1]) throw new RealtimeCollectionError('input', '--input-file 需要一个本地 JSON 文件'); file = args[++index]; }
      else if (arg === '--output' && operation === 'download') { if (output !== undefined || !args[index + 1]) throw new RealtimeCollectionError('input', '--output 需要一个本地文件路径'); output = args[++index]; }
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new RealtimeCollectionError('input', '调用参数无效');
    }
    if ((file === undefined) === (inline === undefined)) throw new RealtimeCollectionError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    // download returns the whole result set; it goes to a local file, never to stdout.
    if (operation === 'download' && output === undefined) throw new RealtimeCollectionError('input', 'download 必须指定 --output <本地文件>，完整结果只写入文件');
    let raw = inline;
    if (file !== undefined) { try { raw = await readFile(file, 'utf8'); } catch { throw new RealtimeCollectionError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new RealtimeCollectionError('input', '请求必须为 JSON 对象'); }
    const active = client ?? createRealtimeCollectionClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    const response = await active.execute(operation, input);
    if (operation === 'download') {
      try { await writeFile(output, `${JSON.stringify(response, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { throw new RealtimeCollectionError('local', error?.code === 'EEXIST' ? '输出文件已存在，换一个文件名，不覆盖已有结果' : '无法写入输出文件'); }
      const { columns_config, items, total } = response.data;
      stdout(JSON.stringify({ success: true, data: { output, total, row_count: items.length, columns_config }, meta: response.meta }, null, 2));
      stderr(`完整结果已写入 ${output}，stdout 只给摘要；不要把整份文件读进对话，需要时只读取所需行。`);
      return 0;
    }
    stdout(JSON.stringify(response, null, 2));
    if (notes[operation]) stderr(notes[operation]);
    if ((operation === 'submit' || operation === 'keyword_submit') && response.data.status !== 'submitted') stderr(REUSED);
    return 0;
  } catch (error) {
    const safe = error instanceof RealtimeCollectionError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
