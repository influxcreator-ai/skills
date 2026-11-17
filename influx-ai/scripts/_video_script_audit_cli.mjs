import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain } from './_common.mjs';
import { ACTION_STAGE, createVideoScriptAuditClient, DONE, FAILED, operations, prepareRequest, VideoScriptAuditError } from './_video_script_audit_client.mjs';
export { isMain };

// status --wait polls one stage every 10 s, at most 60 times (10 min). The server gives no interval; video
// processing goes through IMM and Worker and can take minutes. Running out of budget loses nothing: the
// session_id stays valid for a later status call.
export const WAIT = Object.freeze({ intervalMs: 10000, attempts: 60 });
export const isTerminal = status => DONE.includes(status) || FAILED.includes(status);

// Reminders printed after a successful call. Each operation runs exactly once; nothing here chains another call.
const notes = {
  create: '会话已创建。保存 data.session_id（项目还要保存 data.project_session_id）；后续导入、执行、查询都用它。',
  import: '素材已导入，但还没解析或审核。用 status 查看对应上传阶段（client Brief→brief_upload，脚本→brief_upload_script，视频→video_upload），完成后再按用户要求执行下一阶段。',
  execute: '阶段已受理，不代表完成，可能调用模型或 IMM。用 status 查看对应阶段（可加 --wait），不要重复执行。',
};
const stageHint = (name, data) => {
  if (DONE.includes(data.status)) return `阶段 ${name} 已完成（${data.status}）。${data.status === 'partial' ? 'partial 表示部分完成，向用户说明哪些没完成。' : ''}`;
  if (FAILED.includes(data.status)) return `阶段 ${name} 失败（${data.status}${data.error_code ? `，error_code=${data.error_code}` : ''}）。停止后续阶段，告诉用户；是否修正素材后重新导入或重新执行由用户决定，不要自动重试。`;
  if (data.status === 'pending') return `阶段 ${name} 为 pending：还没有记录，不代表已入队。确认前置素材已导入、对应阶段已执行。`;
  return `阶段 ${name} 进行中（${data.status}）；稍后用同一个 session_id 再查。`;
};

const safe = error => (error instanceof VideoScriptAuditError
  ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]]))
  : { kind: 'local', message: '本地操作失败，未输出原始异常' });

async function emit(response, output, stdout, stderr, requestedStage) {
  if (output === undefined) { stdout(JSON.stringify(response, null, 2)); return; }
  try { await writeFile(output, `${JSON.stringify(response, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { throw new VideoScriptAuditError('local', error?.code === 'EEXIST' ? '输出文件已存在，换一个文件名，不覆盖已有结果' : '无法写入输出文件'); }
  const d = response.data;
  const summary = requestedStage === undefined && d.stages
    ? { session_id: d.session_id ?? d.session?.session_id ?? null, stages: Object.fromEntries(Object.entries(d.stages).map(([name, value]) => [name, value?.status ?? null])), report_status: d.report?.status ?? null }
    : { session_id: d.session_id ?? null, stage: requestedStage ?? null, status: d.status ?? null };
  stdout(JSON.stringify({ success: true, data: { output, ...summary }, meta: { request_id: response.meta.request_id } }, null, 2));
  stderr(`完整响应已写入 ${output}，stdout 只给摘要；只读取需要展示的部分，不要整份读进对话。`);
}

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error, sleep = delay, wait = WAIT } = {}) {
  try {
    if (!operations[operation]) throw new VideoScriptAuditError('input', '未知审核操作');
    const options = {};
    let inline;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const take = key => { if (options[key] !== undefined || !args[index + 1]) throw new VideoScriptAuditError('input', `${arg} 需要一个值`); options[key] = args[++index]; };
      if (arg === '--input-file') take('inputFile');
      else if (arg === '--output' && ['status', 'result'].includes(operation)) take('output');
      else if (arg === '--wait' && operation === 'status' && !options.wait) options.wait = true;
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new VideoScriptAuditError('input', '调用参数无效');
    }
    if ((options.inputFile === undefined) === (inline === undefined)) throw new VideoScriptAuditError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    let raw = inline;
    if (options.inputFile !== undefined) { try { raw = await readFile(options.inputFile, 'utf8'); } catch { throw new VideoScriptAuditError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new VideoScriptAuditError('input', '请求必须为 JSON 对象，UUID 使用字符串'); }
    if (options.wait) {
      prepareRequest('status', input);
      if (!input.stage) throw new VideoScriptAuditError('input', '--wait 需要指定 stage，只等待单个阶段');
    }
    const active = client ?? createVideoScriptAuditClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    let response = await active.execute(operation, input);
    if (options.wait) {
      for (let attempt = 1; attempt < wait.attempts && !isTerminal(response.data.status); attempt++) {
        await sleep(wait.intervalMs);
        response = await active.execute('status', input);
      }
    }
    await emit(response, options.output, stdout, stderr, operation === 'status' && input.stage ? input.stage : undefined);
    if (notes[operation]) stderr(notes[operation]);
    if (operation === 'execute') stderr(`对应阶段：stage=${ACTION_STAGE[response.data.action]}。`);
    if (operation === 'status' && input.stage) {
      stderr(stageHint(input.stage, response.data));
      if (options.wait && !isTerminal(response.data.status)) {
        stderr(JSON.stringify({ wait: { session_id: input.session_id, stage: input.stage, status: response.data.status, message: '等待预算已用完，阶段仍未结束；稍后用同一个 session_id 再运行 status（可加 --wait），不要重复执行' } }));
        return 2;
      }
      if (FAILED.includes(response.data.status)) return 1;
    }
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ error: safe(error) }));
    return 1;
  }
}
