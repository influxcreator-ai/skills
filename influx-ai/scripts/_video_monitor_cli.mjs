import { readFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { createVideoMonitorClient, operations, VideoMonitorError } from './_video_monitor_client.mjs';
export { isMain };

// Reminders printed after a successful action. Each operation runs exactly once; nothing here chains another call.
const notes = {
  register: 'created 只表示已建立监控，不代表首次采集完成；未指定时默认监控 15 天、每 1440 分钟（24 小时）采集一次。skipped_urls 是已有活跃监控而跳过的链接。保留 created[].id，用 get 查看数据。',
  status: '状态已更新；暂停不能撤销已经在途的采集任务。',
  deadline: '期限已更新；延长期限可能让已停止的监控恢复自动采集。再次修改前重新读取 expected_track_deadline。',
  archive: '已归档；历史快照保留，但归档后不能再通过 get 读取；已在途的采集任务不保证撤销。',
  trigger: 'accepted=true 只表示已接受本次手动采集，不代表已投递队列或采集完成；数据回流可能延迟，不要因为暂时没有快照就重复 trigger。',
};

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error } = {}) {
  try {
    if (!operations[operation]) throw new VideoMonitorError('input', '未知视频监控操作');
    let inline, file;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--input-file') { if (file !== undefined || !args[index + 1]) throw new VideoMonitorError('input', '--input-file 需要一个本地 JSON 文件'); file = args[++index]; }
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new VideoMonitorError('input', '调用参数无效');
    }
    if ((file === undefined) === (inline === undefined)) throw new VideoMonitorError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    let raw = inline;
    if (file !== undefined) { try { raw = await readFile(file, 'utf8'); } catch { throw new VideoMonitorError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new VideoMonitorError('input', '请求必须为 JSON 对象，monitor_id 应使用字符串'); }
    const active = client ?? createVideoMonitorClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    const response = await active.execute(operation, input);
    stdout(JSON.stringify(response, null, 2));
    if (notes[operation]) stderr(notes[operation]);
    return 0;
  } catch (error) {
    const safe = error instanceof VideoMonitorError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
