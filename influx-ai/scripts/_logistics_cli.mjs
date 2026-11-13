import { readFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { createLogisticsClient, LogisticsError, operations } from './_logistics_client.mjs';
export { isMain };

// Reminders printed after a successful mutation. Each operation runs exactly once; nothing here chains another call.
const notes = {
  register: '登记请求已完成；保留原 operation_id。register_status=registered 只表示注册成功，不是送达。账务以 Shipment.billing_status 为准，meta 账务字段为 null 不代表免费。',
  refresh: '已向供应商刷新一次；不要把 refresh 放进轮询。再次变更前使用返回的 version。',
  retry: '已恢复原未完成动作；实际执行的动作以执行前的 pending_action 为准。再次变更前使用返回的 version。',
  change_carrier: '已更换承运商；再次变更前使用返回的 version。',
  follow_up: '已更新人工跟进状态；它不是承运商确认的物流事实。再次变更前使用返回的 version。',
  stop: '已停止追踪；停止不等于删除，没有独立的恢复追踪接口。',
  delete: '已软删除；不等于退款，也不等于物理清除。',
};

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error } = {}) {
  try {
    if (!operations[operation]) throw new LogisticsError('input', '未知物流追踪操作');
    let inline, file;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--input-file') { if (file !== undefined || !args[index + 1]) throw new LogisticsError('input', '--input-file 需要一个本地 JSON 文件'); file = args[++index]; }
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new LogisticsError('input', '调用参数无效');
    }
    if ((file === undefined) === (inline === undefined)) throw new LogisticsError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    let raw = inline;
    if (file !== undefined) { try { raw = await readFile(file, 'utf8'); } catch { throw new LogisticsError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new LogisticsError('input', '请求必须为 JSON 对象'); }
    const active = client ?? createLogisticsClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    const response = await active.execute(operation, input);
    stdout(JSON.stringify(response, null, 2));
    if (notes[operation]) stderr(notes[operation]);
    return 0;
  } catch (error) {
    const safe = error instanceof LogisticsError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
