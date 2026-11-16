import { readFile, writeFile } from 'node:fs/promises';
import { isMain } from './_common.mjs';
import { CompetitorTrackingError, createCompetitorTrackingClient, operations } from './_competitor_tracking_client.mjs';
export { isMain };

// Reminders printed after a successful call. Each operation runs exactly once; nothing here chains another call.
const notes = {
  create: '研究已创建并完成扩词，尚未开始召回。保存 data.study_id 和本次 Idempotency-Key；把每组扩词候选和品牌依据给用户看，用户确认后再运行 confirm_keywords，不要自动确认。',
  confirm_keywords: '关键词已确认，后续召回、评论采集和分析已启动，通常需要较长时间；这不代表报告已可交付。稍后用 get 查看 stage 和 result.report_state。',
  refresh_brand_context: '品牌依据已刷新，brand_context_revision 已更新。重新向用户展示品牌依据；确认关键词时使用新的 revision。',
  materialize: 'scheduled=true 只表示已投递一次补偿推进，不是查询，也不代表研究完成。不要放进轮询。',
  regenerate: '已开始新一轮研究（新的 execution_version），会重新召回和生成。新报告通过正式交付校验后才可读取。',
  refresh_existing_evidence: 'HTTP 202 只表示已受理用现有证据重审报告，仍会调用模型和队列；报告就绪前用 get 查看 result.report_state。',
  archive: '研究已归档：list 和 get 不再返回它；已采证据和已分享内容不会被删除或撤销。',
};
const reportStateNote = state => (state === 'ready' ? null : `result.report_state=${state ?? '缺失'}：正式报告还不可交付${state === 'regenerate_required' ? '，研究已停止但报告没有通过交付校验，需用户决定是否 regenerate 或 refresh_existing_evidence' : '，研究仍在进行'}。不要用 result 里的进度或候选数据代替报告。`);

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error } = {}) {
  try {
    if (!operations[operation]) throw new CompetitorTrackingError('input', '未知竞品追踪操作');
    let inline, file, output, idempotencyKey;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const value = () => { if (!args[index + 1]) throw new CompetitorTrackingError('input', `${arg} 需要一个值`); return args[++index]; };
      if (arg === '--input-file' && file === undefined) file = value();
      else if (arg === '--idempotency-key' && operation === 'create' && idempotencyKey === undefined) idempotencyKey = value();
      else if (arg === '--output' && ['get', 'report'].includes(operation) && output === undefined) output = value();
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new CompetitorTrackingError('input', '调用参数无效');
    }
    if ((file === undefined) === (inline === undefined)) throw new CompetitorTrackingError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    if (operation === 'create' && idempotencyKey === undefined) throw new CompetitorTrackingError('input', 'create 必须带 --idempotency-key <键>；同一次逻辑创建重跑时用同一个键');
    let raw = inline;
    if (file !== undefined) { try { raw = await readFile(file, 'utf8'); } catch { throw new CompetitorTrackingError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new CompetitorTrackingError('input', '请求必须为 JSON 对象'); }
    const active = client ?? createCompetitorTrackingClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    const response = await active.execute(operation, input, operation === 'create' ? { idempotencyKey } : undefined);
    if (output !== undefined) {
      try { await writeFile(output, `${JSON.stringify(response, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { throw new CompetitorTrackingError('local', error?.code === 'EEXIST' ? '输出文件已存在，换一个文件名，不覆盖已有结果' : '无法写入输出文件'); }
      const data = response.data;
      const summary = operation === 'get'
        ? { study_id: data.study_id, status: data.status, stage: data.stage, report_state: data.result.report_state ?? null, brand_context_revision: data.brand_context_revision }
        : { keys: Object.keys(data) };
      stdout(JSON.stringify({ success: true, data: { output, ...summary }, meta: { request_id: response.meta.request_id } }, null, 2));
      stderr(`完整响应已写入 ${output}，stdout 只给摘要；只读取需要展示的部分，不要整份读进对话。`);
    } else stdout(JSON.stringify(response, null, 2));
    if (notes[operation]) stderr(notes[operation]);
    if (operation === 'get') { const note = reportStateNote(response.data.result.report_state); if (note) stderr(note); }
    return 0;
  } catch (error) {
    const safe = error instanceof CompetitorTrackingError ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) : { kind: 'local', message: '本地操作失败，未输出原始异常' };
    stderr(JSON.stringify({ error: safe }));
    return 1;
  }
}
