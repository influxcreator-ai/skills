import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isMain } from './_common.mjs';
import { BriefAnalysisError, createBriefAnalysisClient, operations, prepareRequest, TERMINAL } from './_brief_analysis_client.mjs';
export { isMain };

// status --wait polls every 5 s, at most 60 times (5 min). There is no server-provided interval; a run that
// outlasts the budget keeps the same task_id, so calling status again later loses nothing.
export const WAIT = Object.freeze({ intervalMs: 5000, attempts: 60 });

// Reminders printed after a successful call. Each operation runs exactly once; nothing here chains another call.
const notes = {
  submit: 'HTTP 202 只表示任务已创建，分析还没完成，可能调用模型。保存 data.id 和本次 Idempotency-Key；用 status（可加 --wait）查询，看 data.status，不要换键重提。',
  edit: '已保存为新版本（data.result_version）。之后再编辑时，expected_version 用这个新版本。',
  retry: 'HTTP 202 只表示已重新派发分析，可能再次调用模型。用 status 查看进度，不要重复 retry。',
};
// campaign_draft readiness comes only from validation.is_valid; empty blocking_fields does not mean ready.
export const draftNote = data => {
  const { is_valid, missing_fields, issues } = data.validation;
  const parts = ['这只是 Campaign 草稿投影，没有创建 Campaign。'];
  parts.push(is_valid
    ? 'validation.is_valid=true：通过创建校验，但仍需用户确认后再到创建页提交。'
    : `validation.is_valid=false：还不能创建。把 validation.missing_fields（${missing_fields.length} 项）和 validation.issues（${issues.length} 项）都告诉用户，缺项由用户补充，不要从文档臆造金额或名称。`);
  if (data.blocking_fields.includes('document')) parts.push('blocking_fields 含 document：报告里有多个独立活动，先让用户选定一个。');
  if (data.unmapped_fact_ids.length) parts.push(`unmapped_fact_ids 有 ${data.unmapped_fact_ids.length} 条：这些事实没进草稿但仍然有效，从 source_result 回查后展示给用户，不要丢弃，也不要自行补写进草稿。`);
  return parts.join('');
};
const statusNote = data => ({
  queued: '任务排队中；稍后再查同一个 task_id。',
  running: '分析进行中；稍后再查同一个 task_id。',
  succeeded: '分析完成。current_result 是模型从文档提取的事实：annotations.status=extracted 只表示有提取值，不代表用户已确认或识别无误，人工确认看 review_status；needs_confirmation 和 issues 要让用户确认。扫描件的 sources.text 可能为空，有 source_refs 不等于有可读原文证据。',
  failed: FILE_PROBLEMS.includes(data.error_code)
    ? `分析失败（error_code=${data.error_code}：${data.error_message}）。这是文件本身的问题，即使 retry_policy.can_retry 为 true，retry 也会得到同样结果并消耗一次尝试；请用户修正文件后重新上传，用新的 Idempotency-Key 提交。不要自动 retry。`
    : `分析失败（error_code=${data.error_code}）。${data.retry_policy?.can_retry ? '可以按用户要求 retry。' : '当前不可重试。'}不要自动 retry。`,
}[data.status]);
// Failures caused by the file itself; retrying the same file cannot succeed.
export const FILE_PROBLEMS = Object.freeze(['encrypted_file', 'invalid_file', 'invalid_image', 'too_many_pages', 'unsupported_format', 'file_too_large', 'empty_document']);

const safe = error => (error instanceof BriefAnalysisError
  ? Object.fromEntries(['kind', 'message', 'status', 'code', 'reason', 'request_id', 'retry_after', 'outcome'].filter(key => error[key] !== undefined).map(key => [key, error[key]]))
  : { kind: 'local', message: '本地操作失败，未输出原始异常' });

async function emit(response, output, stdout, stderr) {
  if (output === undefined) { stdout(JSON.stringify(response, null, 2)); return; }
  try { await writeFile(output, `${JSON.stringify(response, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { throw new BriefAnalysisError('local', error?.code === 'EEXIST' ? '输出文件已存在，换一个文件名，不覆盖已有结果' : '无法写入输出文件'); }
  const d = response.data;
  const summary = d.id !== undefined
    ? { id: d.id, status: d.status, stage: d.stage, result_version: d.result_version, has_result: d.current_result !== null, error_code: d.error_code }
    : { task_id: d.task_id, result_version: d.result_version, is_valid: d.validation.is_valid, missing_fields: d.validation.missing_fields, issue_count: d.validation.issues.length, blocking_fields: d.blocking_fields, unmapped_fact_ids: d.unmapped_fact_ids };
  stdout(JSON.stringify({ success: true, data: { output, ...summary }, meta: { request_id: response.meta.request_id } }, null, 2));
  stderr(`完整响应已写入 ${output}，stdout 只给摘要；只读取需要展示的部分，不要整份读进对话。`);
}

export async function runCli(operation, { args = process.argv.slice(2), env = process.env, client, stdout = console.log, stderr = console.error, sleep = delay, wait = WAIT } = {}) {
  try {
    if (!operations[operation]) throw new BriefAnalysisError('input', '未知 Brief 分析操作');
    const options = {};
    let inline;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const take = key => { if (options[key] !== undefined || !args[index + 1]) throw new BriefAnalysisError('input', `${arg} 需要一个值`); options[key] = args[++index]; };
      if (arg === '--input-file') take('inputFile');
      else if (arg === '--idempotency-key' && operation === 'submit') take('idempotencyKey');
      else if (arg === '--output' && ['status', 'edit', 'campaign_draft'].includes(operation)) take('output');
      else if (arg === '--wait' && operation === 'status' && !options.wait) options.wait = true;
      else if (!arg.startsWith('--') && inline === undefined) inline = arg;
      else throw new BriefAnalysisError('input', '调用参数无效');
    }
    if ((options.inputFile === undefined) === (inline === undefined)) throw new BriefAnalysisError('input', '使用单个 JSON 或 --input-file <本地JSON文件>');
    if (operation === 'submit' && options.idempotencyKey === undefined) throw new BriefAnalysisError('input', 'submit 必须带 --idempotency-key <键>；同一次提交重跑时用同一个键');
    let raw = inline;
    if (options.inputFile !== undefined) { try { raw = await readFile(options.inputFile, 'utf8'); } catch { throw new BriefAnalysisError('input', '无法读取本地 JSON 请求文件'); } }
    let input;
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new BriefAnalysisError('input', '请求必须为 JSON 对象，task_id 应使用字符串'); }
    if (options.wait) prepareRequest('status', input);
    const active = client ?? createBriefAnalysisClient({ baseUrl: env.SCOUT_API_BASE_URL, apiKey: env.SCOUT_API_KEY });
    const extra = operation === 'submit' ? { idempotencyKey: options.idempotencyKey } : undefined;
    let response = await active.execute(operation, input, extra);
    if (options.wait) {
      for (let attempt = 1; attempt < wait.attempts && !TERMINAL.includes(response.data.status); attempt++) {
        await sleep(wait.intervalMs);
        response = await active.execute('status', input);
      }
    }
    await emit(response, options.output, stdout, stderr);
    if (notes[operation]) stderr(notes[operation]);
    if (operation === 'campaign_draft') stderr(draftNote(response.data));
    if (operation === 'status') {
      if (options.wait && !TERMINAL.includes(response.data.status)) {
        stderr(JSON.stringify({ wait: { task_id: response.data.id, status: response.data.status, stage: response.data.stage, message: '等待预算已用完，分析仍在进行；稍后用同一个 task_id 再运行 status（可加 --wait），不要重新提交' } }));
        return 2;
      }
      stderr(statusNote(response.data));
    }
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ error: safe(error) }));
    return 1;
  }
}
