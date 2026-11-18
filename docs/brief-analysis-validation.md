# Brief 分析 Skill 联调记录

环境：本机 `http://127.0.0.1:8010`，dev 专用 Key（`media_uoload` 与 `brief-analysis` 两项 scope），用户 zq340h8xqyh7，2026-11-16。脚本从 `influx-ai/` 通过 Skill CLI 运行。按交接要求，本轮**未调用 submit、retry、edit**，未上传 Brief 文件，未触发任何分析或模型调用。

## 隔离验证

`node --test tests/brief-analysis.test.mjs`：114 项全部通过（全量 1056 项通过）。全部使用注入的 transport，覆盖：

- 七个操作的路径、方法、请求头、成功状态码（submit、retry 只认 202）。
- Idempotency-Key 必填与格式；BIGINT `task_id` 字符串（含超过 2^53 与 int64 最大值）。
- 本地拒绝：pptx、视频、带查询参数或片段的 `oss_url`，JSON 数字或前导零的 `task_id`，edit 的 schema、版本、data 分区与大小。
- 响应校验：任务视图、列表不含报告、草稿投影 `task_id` 字符串、账务字段必须为 null。
- 错误映射（HTTP×100+1 与受控 reason）、429 `Retry-After`、结果未知、脱敏。
- CLI：`status --wait`（5 秒 × 60 次，预算用完退出码 2）、`--output` 写文件。

## 真实 HTTP 验证

| 操作 | 输入 | 结果 | request_id |
| --- | --- | --- | --- |
| options | `{}` | 200；`enabled: true`，14 个扩展名，`max_file_bytes: 52428800`，`max_pages: 30`，`max_attempts: 3`；账务字段 null | cb2c7836-3a22-4fe8-9d52-64388b21e821 |
| list | `{}` | 200；`items: []`，`page: 1`，`size: 20`，`total: 0` | be2f20f6-40ef-48e6-a889-34e3e713e55e |
| list | `{"page":2,"size":100}` | 200；0 条 | 1358b9d9-4041-42c1-8d40-ffadae2492d6 |
| status | `task_id` `"1"` | 404 / 40401 `task_not_found`（非本人或不存在） | 2af682a4-eeb6-400d-bd31-ff5d1657320c |
| status | `"2"` | 404 `task_not_found` | 29e816c8-1c3c-4027-aeed-997ef2225b40 |
| status | `"100"` | 404 `task_not_found` | 70002e8f-5372-4c43-bb50-252bfca367eb |
| status | `"9223372036854775807"` | 404 `task_not_found` | f539183b-99bd-453a-8877-55f02eb19a78 |
| campaign-draft | 同上，`version: 1` | 404 `task_not_found` | b6611dd9-d303-4598-bb31-619ed172d82f |
| status（直接 HTTP） | `task_id` 为 JSON 数字 | 422 / 42201，`Cache-Control: private, no-store` | 3e0b402c-3436-47c6-9ba0-ebe1e543657d |
| status（直接 HTTP） | `"01"` | 422 / 42201 | a7365fab-2ca0-48ac-963f-6c620fb2e286 |
| list（直接 HTTP） | `size: 101` | 422 / 42201 | e7e47649-2ecf-47dc-bbf3-c79d77d9bc6c |
| options（直接 HTTP） | 带未开放字段 | 422 / 42201 `Unknown field` | 7180bec6-03d3-43cf-908c-5d33820d24a8 |

说明：小 ID（1、2、100）在库里可能属于其他用户，返回与不存在相同的 404，符合“非本人与不存在不可区分”的契约；本轮无法区分两者。

## 全流程（用户授权，2026-11-16）

测试文件：`D:\xizi\work\work\skill-test-data\brief-sample-task-7.pdf`（199471 字节，2 页）。另在 `local-requests/` 临时生成 52 字节的非敏感 txt，只用于幂等冲突测试，测试后已删除。

| 步骤 | 结果 | request_id |
| --- | --- | --- |
| media_upload_submit `--wait`（pdf，document） | succeeded，7.8 s，大小与 SHA-256 一致 | 4ffa63ad-083f-4f4f-a6fc-a1e8113ca382 |
| submit（新键） | **202**，`id: "40"`，`queued`，`result_version: 0` | 569f3fce-b738-4240-959d-1495519b300f |
| submit 同键同 `oss_url` 重放 | 202，返回同一个任务 `40` | 1cd3009e-af77-4078-aa90-a39fc93cf6c8 |
| 重新上传同一 PDF，得到新 `oss_url` | succeeded | 4aa41f27-5f6b-441a-9d39-8882125bac82 |
| submit 同键、新 `oss_url`（同一文件内容） | 202，仍返回任务 `40`（已在 `analyzing`）——幂等按文件内容判断 | 8af9f212-f226-4f30-8dc4-d0013db3b683 |
| status（运行中） | `running`，`stage: analyzing`，`total_pages: 2`；`retry_policy` 为 `retry / can_retry: false` | 9a49d4f5-134c-4aca-bea5-7229353923bc |
| list（运行中） | 1 条，`current_result` 与 `retry_policy` 为 null | fcbc0101-cb54-4c25-8d6f-ad84876b97a0 |
| status `--wait` | **succeeded**，提交后约 64 s，`result_version: 1`；`retry_policy` 为 `resume / can_retry: false` | 8f5ea6c1-28a1-4576-b0e8-0c214887cc6a |
| status `--output` | 报告写入文件：context 3、creator_requirements 12、deliverables 3、terms 5，其余分区 0；23 条 annotations 均为 `extracted`；issues 0、sources 2、document_warnings 0、`multiple_campaigns: false` | 581ea8db-b9d1-4510-aecb-334671080ea9 |
| list（完成后） | 1 条，`current_result: null` | 9a139a50-a52d-4e59-9ca8-0c2e715d91c3 |
| campaign-draft `version: 1` | 200，`task_id: "40"`；`validation.mode: submit`、`is_valid: false`、`missing_fields: [basic_info.campaign_name, compensation]`、issues 2；`blocking_fields: []`；warnings 1、unmapped 1 | ca7d3198-fe90-477d-be5e-e96db10372de |
| campaign-draft `version: 6`（不存在） | 409 / 40901 `brief_state_conflict` | d38c7b20-ebc6-4c48-b76a-3e7ad773e811 |
| edit（`expected_version: 1`，原样 data，确认第一条事实） | 200，`result_version: 2`；该事实 `review_status` 由 `unreviewed` 变为 `confirmed`，仅这一条 annotation 变化 | b8aa9095-3c5a-44ad-94be-5f8434b4d264 |
| edit 再次用 `expected_version: 1` | 409 `brief_state_conflict` | ed751414-6dae-4b2c-86fc-4ce6aab6d7a2 |
| status（edit 后） | `result_version: 2` | 981c7cac-f7bc-4db0-a4e5-9f835c887d06 |
| submit 同键、不同文件（生成的 txt） | 409 `brief_state_conflict`，未创建新任务 | 9e6d6838-0a56-41a5-addc-c9ea933eb587 |
| retry（任务已 succeeded） | 409 `brief_state_conflict` | 73b2dec6-3116-4efc-9861-43dc400dc1e5 |
| submit 改写过的 `oss_url`（`.pdf` 改 `.docx`） | 404 `upload_reference_not_found` | bb70c352-92e8-4c98-9929-3e78438e537e |

所有成功响应的 `credits_consumed`、`billing_status`、`billing_operation_id` 均为 null。

## 尚未验证

- 失败任务的 `error_code`、`retry_policy.can_retry: true` 与 retry 成功（202）的路径：本次分析一次成功，没有失败任务。
- `upload_reference_not_ready`：上传通常几秒内完成，未能稳定在未完成时提交。
- 415、413、`upload_reference_integrity_failed`、429、503：本机难以自然触发，只有隔离测试。
- 图片类 Brief（png 等）：测试目录只有 PDF。

## 契约说明修正后的同步（2026-11-16）

后端修正对接说明，运行时与请求字段未变。Skill 侧只更新说明与客户端判断，未重新提交、retry、edit 或调用模型。

- campaign-draft：客户端校验 `validation.mode` 为 `submit`、`is_valid` 为布尔值、`missing_fields` 与 `issues` 为数组；CLI 摘要与提醒以 `is_valid` 判断能否创建，`blocking_fields` 仅在含 `document` 时提示多个独立活动，`unmapped_fact_ids` 提示从 `source_result` 回查、不丢弃不补写。
- status 成功提醒：`extracted` 不等于已确认，人工确认看 `review_status`；`source_refs` 不等于有可读原文证据。
- 任务 40 反馈的识别与投影问题已由后端记录为底层问题，本次未修复；Skill 不自行加规则补正。
- 隔离测试：brief-analysis 122 项通过（新增 8 项），全量 1064 项通过。

## 补充真实测试（2026-11-16，用户授权，不考虑模型成本）

测试文件均为本地生成的非敏感内容，测试后已删除：伪装成 PDF 的文本、AES-256 加密 PDF、测试 PDF 第 1 页渲染的 PNG、信息齐全的虚构 txt Brief（DemoBrew）、含两个独立活动的虚构 txt Brief（DemoGlow）、上传未完成探测用 txt。

| 测试 | 任务 | 结果 | request_id |
| --- | --- | --- | --- |
| 文字存成 `.pdf` 提交 | 无 | submit 当场 400 / 40001 `invalid_brief_request`，不创建任务 | 68f257b1-5485-423b-9304-d8760119dafb |
| 加密 PDF | 41 | 202 → `failed`，`stage: reading`，`error_code: encrypted_file`，`error_message: 请先解除文件密码后再上传。`，`retry_policy: retry / can_retry: true / remaining 2 / maximum 2` | ffafd086-6a25-4d52-a379-6d6e029996ab / eb25d668-ad02-4510-a4a4-ab07ae7b9837 |
| retry 任务 41 | 41 | **202**，`attempt_no: 2`，`queued`，`retry_policy: null` | f7652bcc-6d20-4ef4-9613-7fb7c7e1611c |
| 立刻再次 retry | 41 | 409 `brief_state_conflict` | ad3f7a75-e6a0-4d24-a68d-53774f7af371 |
| retry 后 status | 41 | 仍 `failed / encrypted_file`，`remaining_attempts: 1`：文件问题重试无效且消耗次数 | e6f42cdc-b0e9-4200-a406-7d8f806883f7 |
| 图片 Brief（png，image） | 42 | 202 → succeeded（约 47 s）；context 3、creator_requirements 10，13 条 extracted；`sources` 一条 `上传图片`（visual，text 为空）；草稿 `is_valid: false`，缺活动名称和报酬，unmapped `f2` | 117faa71-c59c-443f-9f15-781f67e216b5 / cd56808c-544f-45aa-89a0-d14248627bcf |
| 信息齐全的 txt Brief | 43 | 202 → succeeded（约 69 s）；9 个分区中 7 个有内容，16 条 extracted；`sources` 一条 `全文`（text）；**草稿 `is_valid: true`**，`campaign_name`、起止日期、固定费用 500 USD 均映射；warnings `tiers_aggregated`、`source_retained`；unmapped 4 条 | 52cd78c9-b177-42d4-86fa-9587466763bc / c87c1a23-8400-4df5-960d-3bc3c8463a4e |
| 两个独立活动的 txt Brief | 44 | 202 → succeeded（约 109 s）；`multiple_campaigns: true`，`document_warnings` 含 `multiple_campaigns`；**草稿 `blocking_fields: ["document"]`**，`is_valid: false`，缺活动名称、品牌名、报酬；`basic_info` 全空；unmapped 13 条 | dc4b0f0c-2e88-4dae-8040-43964689f04b / 6595be29-9f23-4865-a3fa-405c0528d7d9 |
| 任务 40 改值（f10 `applies_to` 改为 `Micro, Mid, Macro`，`expected_version: 2`） | 40 | 200，`result_version: 3`；f10 `review_status: modified`、`source: user`；f1 仍为 `confirmed` | 3a1e6e1c-4416-4f96-9e54-97e4ae516c06 |
| 上传不等待即提交 | 45 | submit 202，**未能触发** `upload_reference_not_ready`：91 字节文件在提交前已上传完成 | c13c3a87-86ed-4aba-a667-e3903b5a9d24 |

据此修改：status 对文件本身问题的 `error_code`（encrypted_file、invalid_file、invalid_image、too_many_pages、unsupported_format、file_too_large、empty_document）提示修正文件后重新上传、用新键提交，不建议 retry；SKILL 与契约补充同步 400、多活动草稿、sources 形态、retry 后 `retry_policy` 为 null。

## 仍未验证

- `upload_reference_not_ready`（409）：小文件上传太快，未能卡在上传完成前。
- 415、413、`upload_reference_integrity_failed`、429、503：本机难以自然触发，只有隔离测试。
- 非文件问题导致的失败（`brief_analysis_failed`）后 retry 成功：没有能稳定制造的场景。
