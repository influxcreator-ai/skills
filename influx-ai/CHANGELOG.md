# Influx AI Skill 更新日志

> 每次发布新版本时，在顶部新增版本块，记录用户可感知的功能变化。

---

## v0.4.0 - preview（2026-11-12）

- 新增独立邮箱查找子 Skill、五个 POST 操作及契约参考，统一 `email-lookup` scope。
- 保留 create 202 受理、外查默认开启、原 UUID 提交键、输入/执行计数与条目状态语义；不自动重提或换键。
- 新增 Hashtag 深度搜索子 Skill、五个 POST 操作及契约参考，统一 `hashtag-deep-search` scope。
- submit、next、retry 返回 202 仅受理；`get --wait` 每 2 秒查询一次、最多 30 次，预算用完后返回任务 ID、状态和后续查询方式；next、retry 只按用户明确要求运行，不自动轮询或恢复。
- 最终结果以 `selected_candidate_ids` 为准；账务字段为 null，不代表免费。
- 新增达人画像打标子 Skill、七个 POST 操作及契约参考，统一 `creator-profile-tagging` scope；批次和条目 ID 一律使用十进制字符串。
- submit、retry 返回 202 仅受理；`get_batch --wait` 每 2 秒查询一次、最多 30 次；画像状态与后台采集状态分开报告；`reused` 结果保留原获得时间，不当作本次新分析；`unknown` 条目可能已计费，retry 只按用户明确要求运行。
- 新增物流追踪子 Skill、十一个 POST 操作及契约参考，统一 `logistics-tracking` scope；列表沿用 `page` / `size`。
- 登记保持原 `operation_id`，变更携带最新 `version`，409 后不自动重放；refresh 不作为普通查询或轮询；retry 执行原未完成动作，只按用户明确要求运行。注册、运输、追踪、人工跟进与账务分别报告，运单扣费可能是历史回执，`meta` 账务字段为 null 不代表免费。
- 新增视频监控子 Skill、七个 POST 操作及契约参考，统一 `video-monitor` scope；`monitor_id` 与返回的 `id` 使用十进制字符串。
- 注册成功或手动采集 `accepted=true` 不代表采集完成；默认监控 15 天、每 1440 分钟（24 小时）采集；修改期限必须显式选择新期限并携带读取到的截止时间，409 后不自动覆盖；list 与 get 不触发采集，get 可能回填达人快照；账务字段为 null 不代表免费。
- 新增实时采集子 Skill、九个 POST 操作及契约参考：提交、关键词提交、状态、分页数据、导出字段、步骤、全部导出、中止和重试；路径统一为 `/openapi/v1/realtime-collection/tasks/`，scope 统一为 `realtime-collection:submit`、`keyword-submit`、`status`、`data`、`manage`，不再使用 `collection:*`。
- 只在用户明确要求时提交、重试或中止，检索无结果不自动提交采集；提交后保存 `task_id`，没有任务历史列表；download 结果只写入本地文件；原四项与新增五项的错误格式分别处理；`credits_consumed` 为 0 或 null 都不代表免费。
- 新增竞品追踪子 Skill（关键词研究）、十二个 POST 操作及契约参考，统一 `competitor-tracking` scope：创建并扩词、列表、详情、确认关键词、刷新品牌依据、正式报告、来源评论、品牌视频、补偿推进、重新生成、用现有证据刷新和归档。
- create 必须带 Idempotency-Key，结果未知时用同一个键恢复；关键词和品牌依据由用户确认后才提交；读取不自动衔接动作；`completed` 不等于报告可交付，以 `report_state` 和正式交付校验为准；品牌视频只是展示，研究完成后每品牌最多六条；refresh-existing-evidence 返回 202 仅受理；账务字段为 null 不代表免费。
- 新增通用素材上传子 Skill、两个操作及契约参考，scope 为 `media_uoload`：multipart 上传单个文档、图片或视频（默认 50 / 50 / 500 MiB），查询状态并取得私有 `oss_url`；不再使用 `/v1/files/*` 和 `files:upload`。
- 文件以磁盘流发送并在本地比对大小与 SHA-256；submit 的 202 只表示受理，`--wait` 每 3 秒查询一次、最多 100 次；上传不触发分析或审核；账务字段为 null 不代表免费。
- 新增 Brief 分析子 Skill、七个 POST 操作及契约参考，统一 `brief-analysis` scope：读取选项、提交、状态与报告、本人列表、编辑、重试和 Campaign 草稿投影；文件经素材上传取得 `oss_url` 后原样提交，支持 14 类文档与图片。
- submit 必须带 Idempotency-Key，结果未知时用同一个键恢复；`task_id` 与 `id` 为十进制字符串；HTTP 200 不等于分析成功，以 `data.status` 为准；`status --wait` 每 5 秒查询一次、最多 60 次；edit 携带 `expected_version`；campaign-draft 不创建 Campaign，能否创建只看 `validation.is_valid`（`mode` 为 `submit`），`blocking_fields` 只标记多个独立活动，`unmapped_fact_ids` 的事实回查 `source_result`、不丢弃不补写；`annotations.status=extracted` 不等于已确认，人工确认看 `review_status`；账务字段为 null 不代表免费。
- 新增脚本与视频审核子 Skill、九个 POST 操作及契约参考，统一 `video-script-audit` scope：创建独立审核、项目或项目下审核，项目列表与详情、项目下审核列表、本人历史，导入素材，执行 `parse_brief`、`script_qc`、`analyze_video`、`run_audit`，查询阶段状态和结果；不开放增强审核，没有报告导出。
- 素材可以是公开外部链接，或以 `public=true` 上传后取得的原始 `oss_url`（导入时核对本人成功公开回执）；status 只报进度，result 是解析与审核结果的唯一出口；导入和执行成功不代表阶段完成，`status --wait` 每 10 秒查询一次、最多 60 次；`pending` 表示还没有记录；阶段失败即停，不自动重试；create、import、execute 结果未知时先查询再决定；账务字段为 null 不代表免费。
- 素材上传新增 `--public`：默认不发送 `public` 字段（私有），加 `--public` 时公开上传，对象可被匿名读取；回执的 `public` 必须与请求一致。
- 同步根路由、说明、元数据及完整性清单；保持 preview。

## v0.3.0 - preview

### 达人发现契约同步（2026-11-11）
- 同步自然语言搜索、相似达人和四平台结构化列表的 Key、scope、服务端策略及 Scout Discover 权限说明。
- 补充积分准入、实际交付用量和计费 meta 解释；待结算或登记失败不自动重搜，不自行计算或执行扣费。
- 补充 402 积分不足、429 Retry-After 及 401/403/503 提示，保留完整 JSON，区分空结果、部分成功和业务失败。
- 增加仓库级离线协议测试；保留 preview，不代表目标环境部署或真实扣费已验证。

### 文档组织（2026-11-11）
- 邮件参数、调用与确认流程集中到邮件子 Skill，接口及响应统一收录于 API 参考，错误与重试统一收录于错误码参考。

### 新增能力

#### 达人邮件建联
- 新增首封单发、批量发送、Smart Send 预约、已有会话回复、台账和沟通历史查询。
- 支持用户自定义文案、当前 Agent 起草和 Scout 模板三种内容来源；可按用户意图读取模板、预览或生成保存内容。
- 发送前展示目标、主题、完整正文和发送模式，经用户确认后提交；prepare 不发送，confirm 才可能产生真实发送或预约。
- 超时或结果未知时不自动换幂等键重发；sent 不等于 delivered，也不代表用户已收到。

### 发布整理（2026-11-10）
- 补充独立仓库安装、列出可用 Skill 和更新说明，保留父 Skill 与子 Skill 的相对结构。
- 修正脚本示例，以安装后的 influx-ai 根目录定位 scripts/。
- 补充个人服务配置及 Key 配置方式，区分安装工具和脚本的 Node.js 要求。
- 增加本地文件排除规则，更新项目文件清单与实际 SHA-256，内部交流资料不列入发布清单。
- 当前维持 preview；正式仓库、服务配置和许可证尚待确定。
