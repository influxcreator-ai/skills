# Hashtag 深度搜索契约

Hashtag 深度搜索五个操作的完整字段约束、任务视图、状态和错误处理。日常调用方式和流程见 [Hashtag 深度搜索子 Skill](../tools/hashtag-deep-search/SKILL.md)。

## 目录

- [端点与调用](#端点与调用)
- [请求字段](#请求字段)
- [任务视图](#任务视图)
- [状态与阶段](#状态与阶段)
- [候选、决策与分组](#候选决策与分组)
- [任务错误码](#任务错误码)
- [费用字段](#费用字段)
- [错误与恢复](#错误与恢复)

## 端点与调用

以下路径在 `{SCOUT_API_BASE_URL}/openapi` 下，均为 POST JSON，统一要求 `hashtag-deep-search` scope。服务端另外校验 Key、scope 策略和 `Scout Hashtag Deep Search` 权限，并只返回属于当前用户的任务。旧 Key 不会自动获得新 scope。

| 后缀 `/v1/hashtag-deep-search/tasks/` | 脚本 | 成功 HTTP | `data` |
| --- | --- | --- | --- |
| submit | `scripts/hashtag_deep_search_submit.mjs` | 202 | 任务视图 |
| get | `scripts/hashtag_deep_search_get.mjs` | 200 | 任务视图 |
| list | `scripts/hashtag_deep_search_list.mjs` | 200 | `items`、`total`、`page`、`page_size` |
| next | `scripts/hashtag_deep_search_next.mjs` | 202 | 后续批次的任务视图 |
| retry | `scripts/hashtag_deep_search_retry.mjs` | 202 | 原任务新一次尝试的任务视图 |

从包根目录调用，传单个 JSON 参数，或 `--input-file <本地 JSON 路径>`（UTF-8，可带 BOM）。Windows PowerShell 5.1 会破坏内联 JSON 的引号，使用文件形式。`get` 另支持本地控制参数 `--wait`，它不会进入 HTTP 请求。

```bash
node scripts/hashtag_deep_search_submit.mjs --input-file local-requests/submit.json
node scripts/hashtag_deep_search_get.mjs --wait --input-file local-requests/get.json
```

请求文件放在包根目录下的 `local-requests/`（已被 `.gitignore` 忽略）。

响应只有一层 `success` / `data` / `error` / `meta`。成功时 `error` 为 null，失败时 `data` 为 null。`meta.request_id` 是本次诊断号；list 的 `meta` 另含 `page`、`size`、`total`。所有响应带 `Cache-Control: private, no-store`。

## 请求字段

不传 JWT、`user_id`、`team_id`、执行 token 或配置，身份由 Key 解析。未列出的字段会被拒绝。请求体最多 64 KiB。

**submit**

| 字段 | 类型与约束 |
| --- | --- |
| `query` | 必填，去首尾空白后 5 到 4000 个字符 |
| `idempotency_key` | 必填，UUID 字符串 |
| `locale` | 可省略，`zh` 或 `en`，默认 `zh` |
| `target_count` | 可省略，严格整数 1 到 300，默认 50。不能超过当前服务的候选上限，超出返回 400 `target_count_unavailable`。它是目标，不保证交付数量 |

同一个 `idempotency_key` 配不同的需求返回 409 `idempotency_conflict`。同一个键配完全相同的需求再次提交，返回已有的任务，不会新建。服务端没有按键查询任务的接口。

**get / next / retry**

只接受必填的 `task_id`（UUID 字符串）。next 传前一批任务的 ID，retry 传失败任务的 ID。

**list**

| 字段 | 默认与限制 |
| --- | --- |
| `page` | 1，正整数 |
| `page_size` | 20，1 到 100 |

只返回本人的任务，不接受筛选字段。空历史是 `items=[]`、`total=0`。

## 任务视图

`submit`、`get`、`next`、`retry` 的 `data` 是同一个任务视图。

| 字段 | 含义 |
| --- | --- |
| `id` | 任务 UUID。next 返回新任务时是新的 ID |
| `query`、`locale`、`title`、`target_count` | 提交时的需求、语言、标题（规划出的标题，尚未规划时是需求的前 80 个字符）和目标数量 |
| `status` | `queued`、`running`、`succeeded`、`failed` |
| `stage` | `queued`、`planning`、`retrieving`、`reviewing`、`organizing`、`completed` |
| `revision` | 任务版本号，每次保存进度都会加 1。不用它判断任务是否完成 |
| `attempt_no`、`max_attempts` | 当前是第几次尝试，以及最多尝试几次 |
| `can_retry` | 失败且仍有尝试次数，或已有可整理的结果时为 true。只是提示，服务端执行时会重新校验 |
| `can_search_next` | 任务已 `succeeded` 且有规划时为 true。只是提示，服务端执行时会重新校验 |
| `previous_task_id`、`batch_no` | 后续批次关系。第一批 `batch_no` 为 1，`previous_task_id` 为 null |
| `search_round` | 已规划的检索轮数 |
| `total_terms`、`completed_terms` | 已规划的检索词总数，以及已完成召回的检索词数 |
| `current_term` | 正在检索的词，其他阶段为 null |
| `excluded_count` | 从前批排除的 hashtag 数量 |
| `raw_count`、`unique_count`、`truncated_count` | 召回统计：原始召回数、去重后的候选数、因上限被截掉的数量。它们是检索统计，不代表全平台实时热度 |
| `plan` | 当前检索计划，含 `title`、`terms[]`（`term`、`explanation`）、`exclusions[]`。尚未规划时为 null |
| `candidates` | 召回的候选，按相似度从高到低排序，可能包含未被选定的项 |
| `selected_candidate_ids` | 最终选定项的 ID，只有它决定交付内容。取的是被保留的候选里按候选排序（相似度从高到低）靠前的 `target_count` 个 |
| `decisions` | 模型对候选的保留或剔除决定 |
| `groups` | 选定项的内容分组 |
| `error_code` | 失败时的任务错误码，见下文 |
| `created_at`、`updated_at`、`started_at`、`finished_at` | ISO 8601 带时区。未发生的时间为 null |

list 的 `items[]` 是任务摘要，只含 `id`、`batch_no`、`query`、`title`、`status`、`stage`、`created_at`、`updated_at`，不含候选和决定。

## 状态与阶段

`status` 和 `stage` 分开解释：`status` 是任务整体的状态，`stage` 是执行到哪一步。

| `status` | 含义 |
| --- | --- |
| `queued` | 已受理，等待执行 |
| `running` | 执行中 |
| `succeeded` | 已完成，可以读取最终结果 |
| `failed` | 失败，可能保留了已完成阶段的产物 |

终态是 `succeeded` 和 `failed`。

| `stage` | 含义 |
| --- | --- |
| `queued` | 排队中 |
| `planning` | 模型规划检索词 |
| `retrieving` | 按检索词召回候选，`current_term` 是当前词 |
| `reviewing` | 模型审阅候选，决定保留或剔除 |
| `organizing` | 整理分组 |
| `completed` | 全部完成 |

目标数量不足时，任务会再规划新一轮检索并重复召回和审阅，直到达到目标、候选上限或检索轮数上限。因此一个任务可能执行较久，`succeeded` 时的选定数量也可能少于 `target_count`。

HTTP 202 只表示已受理本次操作，不代表任务完成，也不代表已成功派发。

## 候选、决策与分组

**候选**（`candidates[]`）

| 字段 | 含义 |
| --- | --- |
| `id` | 候选 ID，字符串，用于对应 `selected_candidate_ids`、`decisions` 和 `groups` |
| `hashtag` | 标签文本，通常不带 `#` 前缀，展示时按需加上 |
| `similarity` | 与检索词的相似度。它是内积分，不是概率，不要写成百分比或命中率 |
| `total_count` | 标签的使用量统计 |
| `platform_counts` | 按平台的使用量：`instagram`、`tiktok`、`youtube`、`twitter` |
| `last_seen_month` | 最近出现的月份，可为 null |
| `source_terms` | 召回它的检索词 |

**决策**（`decisions[]`）：`candidate_id`、`keep`（保留或剔除）、`reason`、`group`（保留时必有分组名）。`keep: true` 的数量可能多于 `selected_candidate_ids`：超过 `target_count` 的相关词不算被剔除，但不进入本批交付。

**分组**（`groups[]`）：`name`、`candidate_ids`。只包含 `selected_candidate_ids` 里的选定项。

**响应大小**：任务视图包含全部召回的候选，可达上千条。一个目标只有 5 个标签的任务也可能返回 700 多条候选、约 300 KB。读取时先落到文件，只提取选定项，做法见子 Skill 的“读取大结果”。

## 任务错误码

任务 `error_code` 只会是下面五个值，未知的内部原因统一映射为 `deep_search_failed`。

| 值 | 含义 |
| --- | --- |
| `model_timeout` | 模型调用超时 |
| `invalid_model_result` | 模型返回的结果不合规 |
| `task_timeout` | 任务超过执行预算，可从已保存的阶段继续 |
| `enqueue_failed` | 任务没能成功派发到执行队列 |
| `deep_search_failed` | 其他失败 |

## 费用字段

Hashtag 深度搜索没有接入 Scout 积分结算：`meta.credits_consumed`、`billing_status`、`billing_operation_id` 在成功、错误和分页响应里都是 null。兼容字段 `billable_units=0`、`credits_remaining=-1`、`quota_remaining=-1` 不能解释为零成本或无限额。submit、next、retry 可能产生模型和检索成本。

## 错误与恢复

失败返回真实的非 2xx 状态，`error.code` 等于 HTTP 状态乘 100 再加 1（例如 409 对应 40901），`error.message` 是安全的原因或校验说明。客户端诊断只输出类别、HTTP 状态和 code、受控的 `reason`、`request_id`、合法的 `Retry-After`，以及结果是否未知。不输出原始响应、查询文本、Key 或异常堆栈。

| HTTP | 外层 code | 常见 `reason` | 处理 |
| --- | --- | --- | --- |
| 400 | 40001 | `target_count_unavailable` | `target_count` 超过服务候选上限，调小后让用户确认再提交 |
| 401 | 40101 | | 核对 Key，不换身份 |
| 403 | 40301 | | scope、服务端策略或 RBAC 权限不足，说不清具体哪一项。停止，让用户检查，不换 Key 或接口 |
| 404 | 40401 | `not_found` | 任务不存在或不属于当前用户，不要猜测其他 ID |
| 409 | 40901 | `idempotency_conflict`、`next_batch_unavailable`、`retry_unavailable` | 键已用于不同的需求；或该任务当前不能继续搜索下一批；或不能重试。不换键，不换操作 |
| 413 | 41301 | `payload_too_large` | 缩小请求 |
| 422 | 42201 | | 输入不合法，`message` 是字段级描述。修正输入 |
| 429 | 42901 | | 按有效的 `Retry-After` 提示等待，不自动重试，不编造等待时间 |
| 500 | 50001 | | 内部故障。submit、next、retry 的结果可能未知 |
| 503 | 50301 | `unavailable` | 服务暂不可用，或深度搜索功能未开启。submit、next、retry 的结果可能未知 |

**submit、next、retry 结果未知时**（超时、断连、5xx 或响应无效）：任务可能已经创建或已经开始执行。不自动重发，也不换键。服务端没有按键查询任务的接口，只能用 list 查看最近的任务来判断。

空页、失败任务和结果不足数量，都按实际业务字段如实呈现。
