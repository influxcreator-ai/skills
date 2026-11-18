# 脚本与视频审核契约

脚本与视频审核九个操作的完整请求、返回、状态和错误规则。日常调用见 [脚本与视频审核子 Skill](../tools/video-script-audit/SKILL.md)。

## 目录

- [端点与调用](#端点与调用)
- [请求字段](#请求字段)
- [素材来源](#素材来源)
- [返回结构](#返回结构)
- [阶段与状态](#阶段与状态)
- [费用字段](#费用字段)
- [错误与恢复](#错误与恢复)

## 端点与调用

以下路径在 `{SCOUT_API_BASE_URL}/openapi/v1/video-script-audit/` 下，均为 POST JSON，使用 `X-API-Key`，要求 `video-script-audit` scope 和脚本视频审核功能权限，并校验会话归属。素材上传另需 `media_uoload` scope。

| 后缀 | 脚本 | 副作用 |
| --- | --- | --- |
| `sessions/create` | `scripts/video_script_audit_create.mjs` | 创建会话 |
| `projects/list` | `scripts/video_script_audit_projects_list.mjs` | 无 |
| `projects/get` | `scripts/video_script_audit_projects_get.mjs` | 无 |
| `sessions/list` | `scripts/video_script_audit_sessions_list.mjs` | 无 |
| `sessions/history` | `scripts/video_script_audit_history.mjs` | 无 |
| `sessions/materials/import` | `scripts/video_script_audit_import.mjs` | 写入素材，服务端下载并预处理 |
| `sessions/stages/execute` | `scripts/video_script_audit_execute.mjs` | 派发阶段处理，调用 IMM 或模型 |
| `sessions/stages/status` | `scripts/video_script_audit_status.mjs` | 无 |
| `sessions/result` | `scripts/video_script_audit_result.mjs` | 无，不执行审核 |

全部成功响应都是 HTTP 200。响应只有一层 `success` / `data` / `error` / `meta`，`meta.request_id` 是诊断号。未列出的字段服务端拒绝（422），字符串会去掉首尾空白。脚本限制请求体最多 64 KiB。本次不开放增强审核（`run_enhancement` 动作、`enhancement` 阶段），也没有 `/reports/*` 路径。

数据流：`media_upload_submit --public` → status 查到 `succeeded` 且 `public` 为 true → 原样取 `oss_url` → import → status 对应上传阶段 → execute → status 对应阶段 → result。

## 请求字段

ID 都是 UUID 字符串。分页：`page` 默认 1，至少 1；`size` 默认 20，1 到 100。脚本不替服务端补默认值。

**sessions/create**

| 字段 | 约束 |
| --- | --- |
| `mode` | 必填：`project`、`independent`、`collaboration` |
| `industry` | `project`、`independent` 必填：`ecommerce` 或 `game`；`collaboration` 不能传 |
| `name` | 可选，1 到 256 字符 |
| `category` | 可选，1 到 64 字符；`collaboration` 不能传 |
| `project_session_id` | `collaboration` 必填；其他 mode 不能传 |

`collaboration` 的行业和分类继承所属项目。

**projects/list**：`page`、`size`。

**projects/get**：`project_session_id`。

**sessions/list**：`project_session_id`、`page`、`size`。

**sessions/history**

| 字段 | 约束 |
| --- | --- |
| `page`、`size` | 分页 |
| `session_type` | 可选：`video_script_audit`（独立审核和项目下审核）、`video_script_session_audit_project`（项目） |
| `parent_id` | 可选，项目 ID |
| `root_only` | 可选，布尔值 |

`parent_id` 与 `root_only` 不能同时填写（`root_only: false` 也算填写）。

**sessions/materials/import**

| 字段 | 约束 |
| --- | --- |
| `session_id` | 必填 |
| `material_type` | 必填：`brief` 或 `video` |
| `source_url` | 必填，1 到 2000 字符，见“素材来源” |
| `parameters` | 可选对象，只含 `doc_type` |
| `parameters.doc_type` | `brief` 必填：`client` 或 `script`；`video` 不能传 |

会话与素材的归属：

| 会话 | 接受 |
| --- | --- |
| 项目（`project`） | 只接受 `brief` + `client` |
| 项目下审核（`collaboration`） | 只接受 `brief` + `script` 和 `video`；客户 Brief 读所属项目 |
| 独立审核（`independent`） | 客户 Brief、脚本、视频 |

不符合返回 400 `invalid_audit_request`。同一会话再导入视频会替换当前视频。

**sessions/stages/execute**：`session_id`、`action`（`parse_brief`、`script_qc`、`analyze_video`、`run_audit`）。

**sessions/stages/status**：`session_id`，可选 `stage`（见“阶段与状态”），省略返回全部开放阶段。

**sessions/result**：`session_id`。

## 素材来源

`source_url` 是 1 到 2000 字符的 HTTPS 地址，二选一：

- **公开外部链接**（如 Google Docs 文档、Google Drive 视频）：服务端交给已有的素材导入能力直接抓取，不要求上传回执。支持哪些链接类型由服务端决定，Skill 只检查 HTTPS 和不含用户名密码。链接要设置成“知道链接的人可查看”。Google Docs 文档会导出为 docx，`filename` 是文档标题。
- **本服务上传的 `oss_url`**：必须是当前 Key 所属用户一次**成功、公开**上传（`--public`）的原始地址，路径为 `/skill-uploads/<用户 ID 十六进制>/<upload_id>.<扩展名>`，与回执完全一致，回执保留 24 小时。回执不存在、不是本人的、不是公开上传、过期或地址被改写返回 404 `upload_reference_not_found`；上传还没成功返回 409 `upload_reference_not_ready`。公开对象可被任何拿到链接的人匿名读取。

素材格式：本地文件的 Brief 和脚本按 pdf、docx、txt 处理，其他格式返回 409 `audit_state_not_allowed`。视频用素材上传支持的 mp4、mov、m4v、webm、avi、mkv（上传上限 500 MiB）。外链打不开或格式不支持时，可能在导入时报错，也可能在对应上传阶段失败。

## 返回结构

**create**：会话字段 `session_id`、`status`（新会话 `pending`）、`session_type`、`name`、`industry`、`category`、`parent_id`、`created_at`、`updated_at`。`project` 另有 `project_session_id`（等于 `session_id`），`session_type` 为 `video_script_session_audit_project`；`collaboration` 另有 `project_session_id` 和 `parent_id`，`session_type` 与独立审核相同，都是 `video_script_audit`，只能靠 `parent_id` 区分。

**projects/list、sessions/list、sessions/history**：`{items[], total, page, size}`，按创建时间和 ID 倒序。`items[]` 字段：`session_id`、`name`、`session_type`、`parent_id`、`industry`、`category`、`status`、`current_stage`（目前总是 null）、`created_at`、`completed_at`。

**projects/get**：项目详情，含 `project_session_id`。

**import**：`session_id`、`material_id`（可为 null）、`material_type`、`status`（通常 `processing`）。

**execute**：`session_id`、`action`、`status`、`task_id`（可为 null）。

**status**（只报进度）：

- 指定阶段：`{session_id, stage, status, error_code}`；`video_upload` 可另有 `duration_ms`（处理完成前为 null）。`stage` 是工作流阶段名，脚本核对它等于请求的阶段。
- 省略阶段：`{session_id, stages}`，`stages` 的键固定是七个开放阶段，每项只有 `status`、`error_code`（`video_upload` 可另有 `duration_ms`）。脚本要求七个阶段都在、没有别的键。
- 不返回解析结果、任务或素材 ID、模型信息、错误原文和视频处理内部详情。

**result**（解析与审核结果的唯一出口）：

| 字段 | 内容 |
| --- | --- |
| `session` | `session_id`、`name`、`session_type`、`parent_id`、`industry`、`status`、`created_at` |
| `materials[]` | `material_type`（`brief` / `video`）、`doc_type`（`client` / `script`，视频为 null）、`filename`、`status`、`error_code` |
| `stages` | 七个开放阶段，每项 `status`、`error_code`，`video_upload` 可另有 `duration_ms` |
| `brief_parse` | `brand`、`product`、`selling_points`、`must_say`、`dont_say`、`must_show`、`dont_show`、`creative_requirements`、`publishing_requirements`；未解析时为空对象 |
| `script_audit` | `overall_score`、`final_report`、`dimensions`（各维度 `score`、`status`、`summary`）、`html_report_url` |
| `video_audit` | `status`、`overall_verdict`、`overall_score`、`final_report`、`dimension_scores`（各维度 `score`、`status`、`summary`、`issues`、`strengths`）、`must_say`、`dont_say`、`must_show`、`dont_show`、`selling_point`、`html_report_url` |

`final_report`：`overall_result`、`overall_direction`、`revision_plan[]`（每项 `title`、`section`、`issues`、`actions`；没有独立标题时 `title` 为 null；`issues` 每项 `issue`、`priority`（如 `P0`、`P1`、`P2`）；`actions` 每项 `suggestion`）。

`materials[].filename`：本服务上传的素材是上传时的原始文件名，Google Drive 视频是 Drive 里的文件名，Google Docs 是文档标题。较早导入、没有保存原名的素材仍是原来记录的名称（可能是 `<upload_id>.<扩展名>`），服务端不补写。

`html_report_url`：可直接分享的 OSS HTML 报告地址，字符串；报告未生成时为 null。阶段名仍是 `script_qc`、`content_audit`，只有 result 的报告字段改名为 `script_audit`、`video_audit`。

result 里的阶段状态与 status 来自同一处，两次请求之间可能因任务推进而不同。核对数组每项：`item`、`status`（如 `hit`、`partial_hit`、`miss`、`safe`）、`evidence`、`timestamp`。

脚本校验：`session.session_id` 等于请求、`materials` 是数组且类型只有 `brief` / `video`、`stages` 七个阶段齐全、`brief_parse` 是对象或为空；`script_audit` / `video_audit` 是对象或为空，是对象时 `html_report_url` 必须是字符串或 null。带 `--output` 时，stdout 摘要含 `session_id`、各阶段状态、`video_audit_status`、`script_audit_html_report_url`、`video_audit_html_report_url`。除 `html_report_url` 外，不返回原始 `result_data`、脚本全文和分段、重复的解析或质检结果、内部 ID 和 URL（素材、视频、`source_url`、`oss_url`）、计时、执行模式，以及可能与明细不一致的汇总指标。

## 阶段与状态

| 阶段 | 由什么产生 | 状态取值 |
| --- | --- | --- |
| `brief_upload` | 导入客户 Brief | `processing`、`completed`、`upload_failed` |
| `brief_upload_script` | 导入脚本 | 同上 |
| `brief_parse` | `parse_brief` | `processing`、`completed`、`failed` |
| `script_qc` | `script_qc` | `processing`、`completed`、`failed` |
| `video_upload` | 导入视频 | `processing`、`completed`、`upload_failed`、`download_failed`、`transcode_failed`、`slice_failed` |
| `video_analysis` | `analyze_video` | `processing`、`completed`、`partial`、`failed` |
| `content_audit` | `run_audit` | `processing`、`completed`、`failed` |

任何阶段还没有记录时为 `pending`，不代表已经入队。

脚本的判断：`completed`、`partial` 为完成；`failed`、`upload_failed`、`download_failed`、`transcode_failed`、`slice_failed` 为失败（status 退出码 1）；其他继续等待。`--wait` 每 10 秒查询一次，最多 60 次，预算用完退出码 2。服务端没有给出建议间隔。

## 费用字段

`meta.credits_consumed`、`billing_status`、`billing_operation_id` 为 null，表示没有结算回执，不代表免费。脚本发现这些字段有值时视为协议错误。

## 错误与恢复

`error.code` 是 HTTP 状态乘 100 加 1。客户端诊断只输出类别、HTTP 状态和 code、受控的 `reason`、`request_id`（其中的 Key 被隐藏）、合法的 `Retry-After`，以及结果是否未知；不输出素材地址、服务端自由文本或异常堆栈。

| HTTP | `reason` | 来源 |
| --- | --- | --- |
| 400 | `invalid_audit_request` | 业务参数不被接受：会话类型不接受该素材、地址不是 HTTPS 等 |
| 401 | | Key 缺失或失效 |
| 403 | | scope 或功能权限不允许，停止，不换 Key |
| 404 | `session_not_found` | 会话不存在或不属于本人 |
| 404 | `upload_reference_not_found` | 上传回执不可用，见“素材来源” |
| 409 | `upload_reference_not_ready` | 上传还没成功 |
| 409 | `audit_state_not_allowed` | Brief 或脚本阶段的前置条件不满足，或 Brief 格式不支持 |
| 413 | `payload_too_large` | 请求体超限 |
| 422 | 字段级说明 | 请求字段不合法 |
| 429 | | 限流，按 `Retry-After` 等待 |
| 500 | | 其他底层异常（例如视频地址无法访问），保留 `request_id` |
| 503 | `upload_status_unavailable` | 上传状态服务不可用 |

不是所有前置条件失败都返回 409，以实际响应为准。HTTP 200 不代表阶段完成。

**结果未知**：create、import、execute 遇到超时、断连、5xx 或无效响应时标为 `outcome: "unknown"`，只调用一次，不自动重发。create 先 history 核对；import、execute 先 status 查对应阶段。只读操作同样情况标为 `unavailable`，可以直接再查。
