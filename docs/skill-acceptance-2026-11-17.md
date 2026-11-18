# influx-ai 各工具联调与验收核对（2026-11-17）

环境：本机 `http://127.0.0.1:8010/openapi`，测试身份 `zq340h8xqyh7`，各工具专用 Key（只经环境变量注入）。本轮只做只读查询，时间 2026-11-17 07:50–08:00 UTC；没有创建任务、注册、登记、提交、重试、刷新或调用模型。输出只保留状态、计数和 ID，不含运单号、收件人、视频链接、达人主页或报告正文。

不在本轮范围：邮件建联、素材上传、脚本与视频审核。

状态说明：**通过** = 有真实 HTTP 证据；**失败** = 真实环境明确出错；**未验证** = 没有真实证据；**待确认** = 有历史记录，但现在无法判断是否已修复。

## 视频监控

| 能力 | 状态 | 证据 | request_id |
| --- | --- | --- | --- |
| list | 通过 | 2 条（36、42） | 5a8639a2-961c-4a93-8e69-63b1fdbd40ea |
| get | 通过 | 36、42 均 200 | 14eefced-2ca2-46eb-a360-9dadeca1f9fa / e8beadb0-47d9-4c12-98bf-8820c4d7adc5 |
| register | 通过（11-13） | 新建监控 42，id 为字符串 | 82a76075…a27d |
| 周期采集与快照回流 | 通过（既有监控 36） | 间隔 120 分钟，`last_triggered_at` 11-17 06:55，`next_trigger_at` 09:19；trend 从 11-13 的 4 天增至 8 天，最新一天 11-17；`views_3d`、`views_7d` 有值 | 14eefced… |
| 监控 42 无快照 | 已更正：到期停止，不是故障 | 注册时 `track_days: 1`，11-14 到期停止；11-17 07:32 由用户重新打开并触发采集，07:54 仍为 `collecting`，08:14 回流（见“授权实测”） | e8beadb0… |
| get 回填达人快照 | 未观察到 | 36 的 `creator_snapshot` 一直是 8 个字段 | — |
| trigger、status、deadline、archive（Skill 发起） | 未验证 | 有副作用，本轮不执行 | — |

11-13 的 list/get 500 已修复复测通过，不再作为问题。

## 独立邮箱查找

本轮没有 `email-lookup` scope 的 Key，未做真实查询。Skill 侧的早期联调输出已清理，没有保留可查证的记录。

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| list、preview | 待确认 | 后端记录：11-13 本机 200（65fbb9c0-d3ab-4c8d-a18f-8e7967b6db6d / cdf7ea2d-a17b-4fd8-946f-6f0940e9ab26），未建批次 |
| 已有数据命中、未命中后外部查找、批次完成、结果读取 | 未验证 | 无真实批次记录 |
| 跨用户数据隔离 | 未验证 | 只有隔离测试和源码核对，不能代表真实数据库 |
| 供应商费用 | 未验证 | `credits_consumed` 为 null 不代表免费 |

## Hashtag 深度搜索

本轮没有 `hashtag-deep-search` scope 的 Key。后端记录写明真实模型任务、费用和 Skill 联调未验证；Skill 侧早期输出已清理。

| 能力 | 状态 |
| --- | --- |
| submit、get、list、next、retry 真实链路 | 未验证（待确认是否有过真实任务） |
| 真实模型/向量库调用与费用 | 未验证 |
| 隔离协议测试 | 通过 |

## 达人画像打标

| 能力 | 状态 | 证据 | request_id |
| --- | --- | --- | --- |
| options | 通过 | 200，字段 `enabled`、`max_items`、`max_input_rows`、`reuse_days` | 2c0dabda-3480-4f41-907d-946fbfb3a76e |
| list_batches | 通过 | 200，`total: 0`：该身份没有任何批次 | 069c1548-aaa8-4269-8742-0d74f12d2196 |
| submit、get_batch、list_items、get_item、retry 真实链路 | 未验证 | 从未提交过真实批次 | — |
| 外部打标/采集费用 | 未验证 | — | — |
| 隔离协议测试 | 通过 | — | — |

## 物流追踪

| 能力 | 状态 | 证据 | request_id |
| --- | --- | --- | --- |
| carriers（q=DHL） | 通过 | 18 条 | 3ad8c39a-b3e5-4786-9df8-e1f859ced078 |
| list、stats | 通过 | 0 个运单，统计全 0 | d7065b49-933a-402f-bde4-0ca2a5789cf2 / e8842042-a9a4-455c-b8d7-c2675d2d25d2 |
| register、get 轨迹、refresh、follow_up、change_carrier、stop、delete、retry | 未验证 | 没有运单；登记会请求供应商并走计费链，需要真实运单号和授权。本轮没有改动或删除任何运单 | — |

## 实时采集

| 能力 | 任务 | 状态 | 证据 | request_id |
| --- | --- | --- | --- | --- |
| 主页（link_batch） | collection_20261113153542_ab04f33d（retry 后） | 通过 | `completed`，4 步全部完成；data 1 行 28 列 | 176f51d1-cb33-4042-ba93-73f4b1af02b8 / e7cb2e2f-302d-46a0-ae57-14f12f56060e |
| 作品链接（post_video） | collection_20261113161227_15295d33（retry 后） | 通过 | `completed`，4 步全部完成；data 1 行 21 列 | 7574dabb-1473-4de8-b895-6ea22abd0192 / 183c9a89-6b50-4964-bfb0-cb455eab7419 |
| 达人视频（creator_video） | collection_20261113153548_ea20a913 | 未验证完成 | 11-13 retry 后经授权中止，现为 `failed` | aa32cdbc-21a4-4ae3-8742-9787c6af3532 |
| 关键词 | collection_20261113153546_d55eb240 | 失败 | `failed`，`failed: 1`；第 3 步（入库）`failed`（11-13 15:45 开始）；data 0 行 | 824b2417-2f7e-4ff7-b88b-07f2fd2a484e / a614885b-50f4-406f-a1f2-7c15dbcc62b4 / 1bf82584-3aec-43bb-b955-280831cf00ea |
| 关键词（重启 Worker 后 retry） | collection_20261113161226_ea1d4037 | 失败 | 同上，第 3 步 11-13 16:13 开始后 `failed`；data 0 行 | 5511f7a6-0b76-40c2-b776-c722986a5cac / ab67bd72-463d-47fd-9830-7671e673b1ab / 7caccfb3-3137-43f9-bd6b-385fdb8548df |
| 中止、派发失败后的步骤状态 | ea20a913、e063b3b5、787fe1e3 | 失败 | 任务已 `failed`，steps 第 2 步仍是 `running`，后两步 `pending` | ae5e1137-5778-4271-b98a-c3eb872016f8 / 8642226f-b22c-480d-8e97-180f58e5a71e / 1d7e679b-91f7-49ce-b063-3a1881b47cf6 |
| 不同时间范围是否复用 | — | 待确认 | 11-13：与进行中关键词任务同词、不同时间范围，返回原任务（c2ac8084-0319-4915-af4a-c2bed1e578dc）。是否属错误复用需产品确认规则 | — |
| submit / keyword-submit 500（API 进程 Celery NotRegistered） | — | 待确认 | 11-13 三次复现。`src/business/collection/realtime` 与 `src/infrastructure/realtime_collection` 自 11-10 后无提交，源码里看不到修复；要确认需一次真实提交 | — |

## 竞品追踪

研究 kms_6b4858226e1badcb3c35164531c76e6febee7f48b8d8251a（Glossier vs Rare Beauty，TikTok，30 天）：

| 项目 | 最新状态 | request_id |
| --- | --- | --- |
| status / stage | `failed` / `analyzing` | c786222d-bdd9-4aaa-982e-0ea4c5206672 |
| failure_reason | 既有证据报告刷新未完成，请重试 | 5ee4983a-97c2-4753-8100-30dd9f671daa |
| report_state / execution | `regenerate_required` / `terminal`，`can_retry: true` | 同上 |
| report | 409 `study_state_not_allowed`，正式报告未产出 | 216f1a32-0074-4906-b8e7-fc6f89ea2c99 |
| 品牌依据 | 11-15 两组均 `unavailable`（本机实时搜索关闭） | 71dc9fec…、115860bb… |
| 扩词 | 只有种子词：`glossier` / `rarebeauty` | — |
| list | 1 项研究（研究一已于 11-15 归档） | 886089d8-df0d-4342-890d-b97276de89cf |

## Brief 分析

| 能力 | 状态 | 证据 | request_id |
| --- | --- | --- | --- |
| 上传、提交、状态、列表、编辑、重试、草稿投影 | 通过（11-16） | 任务 40–45：成功 5 个，加密 PDF 失败 1 个（41） | 643dd10b-c953-4242-be4c-8c0abd1ad86f |
| 扫描 PDF 识别问题、Campaign 草稿映射问题 | 待底层处理 | 任务 40 仍为 `result_version: 3`，最后更新 11-16 06:54（Skill 侧编辑），没有新版本或复测结果 | 9f7da1e6-b087-473b-a09a-604b9733d362 |

## 授权实测（2026-11-17 08:12–08:15 UTC）

用户授权真实提交，不考虑模型和供应商费用。邮箱查找、Hashtag 用新提供的 Key（带 `email-lookup`、`hashtag-deep-search`、`creator-profile-tagging`），画像打标和视频监控用各自原来的 Key。已核对两把 Key 属于同一用户。

### 独立邮箱查找

已有历史批次 4 个（11-13）：1 个 `completed` / `success`（stored 命中），3 个 `failed`，错误码全是 `cache_unavailable`，`retryable: true`。

| 操作 | 结果 | request_id |
| --- | --- | --- |
| preview（3 行：Instagram cristiano、YouTube MrBeast、虚构 TikTok 账号） | 3 行全有效，`can_submit: true` | 045f6c56-eb1d-4199-b226-75eb8acfcb87 |
| create | 202，批次 12dcbccc-878e-4657-96b3-a0dc9417e76e，`pending`；账务 meta 均为 null | 6b5e18af-83d8-4889-8ff7-da40bc9def3a |
| create 同键重放 | 返回同一个批次 | 00c69bf3-a2ef-49b5-b4fc-3b21e1bc3884 |
| get | 5 秒内 `completed` / `partial`：found 2、error 1 | d8ee33a8-b1c2-4a0a-a837-82f3ef51a08b |
| items | 第 1、2 行 `found`，`source: stored`；第 3 行 `error`，`source: none`，`error_code: cache_unavailable`，`retryable: true` | ae93145a… / 8670d8e7-0251-471b-9c68-24c953d37ac9 |
| list（submission_key） | 找到同一批次 | 939450f2-ccb4-4757-9725-c93acb2c908d |

结论：已有数据命中（stored）通过。未命中时的外部查找没有发生，`cache_unavailable` 在 11-13 和 11-17 都稳定出现，属于环境或依赖故障。供应商费用未验证（没有发生外部查找）。邮箱查找没有 retry 操作。

### Hashtag 深度搜索

| 操作 | 结果 | request_id |
| --- | --- | --- |
| submit（户外露营装备，zh，target 10） | 202，任务 26b45ff2-d7b0-4399-ab63-c8a4efbe6a93；账务 meta null | c3d9faf4-d4bc-4ca9-806d-c94f546329b7 |
| submit 同键重放 | 返回同一个任务 | 3ebf13c9-2e83-4cf8-a893-f63c1dde60cb |
| get --wait | 约 58 秒 `succeeded`：选定 10 个，候选 693 | 443a271e-0edd-49ad-887f-538261b5eed8 |
| next | 202，第 2 批 4af1c13b-f546-456b-b114-623770b30970，排除 10 个 | 7fd995e3-88a8-4d61-b3f5-7a005bb0388d |
| 第 2 批 get --wait | 约 46 秒 `succeeded`：选定 10 个，候选 683 | 4aab25d9-c6a8-4088-ae50-2b880806afb5 |
| list | 3 个任务，全部 `succeeded`（含 11-13 的两个历史任务，其中一个是 next 出的第 2 批） | 15c729fa-a207-4e24-bf27-6e0dfc0a0752 |
| retry 已成功任务 | 409 `retry_unavailable` | 02422096-cdb8-410d-b64b-d3757738a654 |

失败任务的 retry 成功路径未验证：没有失败任务。真实模型调用已发生，费用未验证（账务 meta null）。

### 达人画像打标

| 操作 | 结果 | request_id |
| --- | --- | --- |
| submit（Instagram cristiano，`force_refresh: true`） | 202，批次 36；账务 meta null | d9839386-1b12-4152-87bf-250f1f3f66e6 |
| submit 同键重放 | 返回同一个批次 | 22f7e59d-fa1f-4df5-a99b-d3976e95be7b |
| get_batch --wait | 约 83 秒 `completed`：成功 1、失败 0，`collection_counts.not_needed: 1` | 8373e27a-10e9-4ce8-a25d-4e53e279131b |
| list_items | 条目 37 `succeeded`，有 `result_obtained_at` | 81cbcada-6085-49b9-a095-d42382bd915c |
| get_item | 有画像结果（性别、年龄段、行业、内容形式、中英文摘要等维度） | fc80e822-6f87-4882-abfe-0c3c93be8043 |
| retry 已成功条目 | 409 `item_not_retryable` | 4ff45b8d-c96f-4d53-8329-04c077facce4 |
| 用同一用户的另一把 Key 读批次 36 | 可见（同一用户，不能证明跨用户隔离） | e3294b65-622e-4dec-b9b4-5a0c2d8250b0 |

失败条目的 retry 成功路径未验证。外部打标费用未验证（账务 meta null）。

### 视频监控（测试监控 42）

| 操作 | 结果 | request_id |
| --- | --- | --- |
| get（操作前） | `active`，`latest_run_status: completed`，但 `has_tracking_data: false` | 7327a92e-b965-48ea-9462-ae67073be32e |
| status paused | 200，`updated: true`；get 确认为 `paused` | 3d9a9793-fa32-453e-8258-6579b44c6cda / 7d8783f8-6836-4efc-b06f-048dfb8bfd5e |
| trigger（paused 状态） | 200，`accepted: true` | dc5db2f5-43f5-4c7d-b0e6-504a7ef87cb2 |
| status active | 200 | f0a40f91-034f-42e3-aafe-86f35f05b539 |
| deadline 用过期的 expected_track_deadline | 409 `monitor_state_changed` | a86f5ddc-1721-4ed5-a99d-395a2f75525c |
| deadline `track_days: 3` | 200；截止改为 2026-11-20T08:13:06Z | 4545ef8a-a260-495d-a19d-bd43c87b5d00 / f8cd91c7-a4e8-4b38-8f8a-250088589e36 |
| register 同一视频 | 422 `invalid_monitor_request`（全部已有活跃监控） | 8757124f-1622-4140-9f84-891cc60e28f2 |
| trigger 后约 60 秒 get | `has_tracking_data: true`，trend 1 天：手动采集与快照回流通过 | d7afb207-b13d-4db3-8340-c128e63a146a |
| archive | 200，`archived: true` | fae422e1-b5fa-4b96-aa36-4afd09066898 |
| 归档后 get / 再次 archive | 404 `monitor_not_found` | c8f5fca6-1f01-47df-8200-5686cc394e57 / 7daea24d-4286-48b7-ae91-87b85268c9f6 |
| list | 只剩监控 36 | 7d5e8e5c-73fd-4c24-9074-5b0663e30453 |

更正：监控 42 注册时 `track_days: 1`，11-14 到期停止，所以之后没有自动采集，这不是采集故障。用户在 11-17 07:32 修改截止日、重新打开并触发采集；Skill 侧 08:13 再次 trigger。08:14 回流的快照无法区分来自哪一次触发。

`last_triggered_at`、`latest_run_status` 的表现按设计，见下节说明。

监控 42 已于 08:14 由 Skill 侧归档（当时不知道是用户刚重新打开的），无法恢复。需要继续监控时，对同一视频重新注册。

### 视频监控：重新注册并立即采集（08:26 UTC，用户确认）

同一视频（YouTube）重新注册，`track_days: 15`，间隔默认 1440 分钟。

| 操作 | 结果 | request_id |
| --- | --- | --- |
| register | 200，新监控 id `43`，`skipped_urls` 为空 | ef45c01c-5b60-4371-9f9f-334badc32cff |
| get | `active`、`collecting`，无快照；截止 2026-12-02T08:26:39Z，`next_trigger_at` 2026-11-18T08:54:39Z，`last_triggered_at: null` | c38eaeb6-a1e0-431f-ba4a-d07f3f61d705 |
| trigger | 200，`accepted: true` | 48526aae-cbb2-40c1-b2b9-507c802cb935 |
| trigger 后 20 秒 get | `has_tracking_data: true`，快照 18 个字段，trend 1 天：手动采集与快照回流通过 | 99191bc4-488f-4e7d-b741-6a2568a92396 |

状态字段说明（用户确认按设计，不是问题）：手动 trigger 后 `last_triggered_at` 仍为 null；已有快照时 `latest_run_status` 可以仍是 `collecting`。SKILL 已改为“有没有数据看 `has_tracking_data` 和 `snapshot`”，不再用 `latest_run_status` 判断。

## 达人检索（2026-11-17 09:03–09:10 UTC）

范围：自然语言找达人、结构化列表、相似达人。品牌合作达人和实时品牌提及按用户要求不测。Key 带 `creator:search`。日志只记状态、数量、字段名和计费字段，不记达人身份。

### 自然语言找达人（search_creators_nl）

| 用例 | 结果 | request_id |
| --- | --- | --- |
| TikTok 美国跑步达人，硬性条件 US、粉丝 ≥ 1 万，limit 10 | `success`，10 个候选；`billable_units: 10`，`pending_settlement` | a28551ef-2ccd-4c93-8e88-81f77bf36645 |
| Instagram + YouTube 日本美妆，limit 5 | `success`，5 个 | 32547b2d-6a45-4f2f-b718-0fff19dbbc18 |
| 带 `seed_creators` | `success`，5 个 | f8037dc5-176c-4a90-91f1-d8663b2a1eee |
| 硬性条件是否生效 | 5 个候选全部 US、粉丝 ≥ 1 万；候选含 `match_assessment` | d672b77f-3b6c-4257-9233-e6ec7af59e58 |
| 缺 query / 平台 twitter | 本地拒绝，不发请求 | — |

### 结构化列表（list_creators）

| 用例 | 结果 | request_id |
| --- | --- | --- |
| TikTok US 1 万–50 万，粉丝倒序，第 1、2 页 | 各 5 条，`total` 2,345,038；两页无重复 | fd2b32f2-c976-4a26-bc9e-5bb611b0d6c4 / cd495d9f-756e-4d7b-b73b-052c9c89d2b1 |
| 排序与筛选 | `followers_count`（字符串）严格倒序，全部 US、≥ 10 万 | 6ae21a3d…（同组） |
| Instagram、YouTube、Twitter | 各 3 条；字段数 30 / 42 / 31 | 187f118f…、7a104807…、64fbc05d… |
| service_level S1 / S2 / S3 | 字段数都是 44，**非空字段**平均 14 / 29.7 / 33.7：S2 比 S1 多地区、性别、语言、表现指标、简介、类目、近期视频、邮箱等 18 个；S3 再多 4 个受众字段（女性比例、国家、语言、年龄分布） | a12efc43…、3da8e63e…、745ddd91… |
| lang en / cn | `gender` 由 Male/Female/Unknown 变为 男/女/未知；`language` 等保持原值 | 0f8cbc5c… / 0983ca4c… |
| `total` 何时为数字 | 国家 + 粉丝上下限：数字；只有国家、国家 + 粉丝下限、只有粉丝上下限：null | 86b2f74b…、24bd870f…、2d076bbd…、5232fcde… |
| 非法 service_level / lang / 平台 | 本地拒绝 | — |

服务等级通过把字段置为 null 来裁剪，不是删除字段，与 SKILL“未返回字段保持 null”一致。`total` 的触发条件需后端确认（粉丝上下限是否要成对才算条件）；SKILL 已写明 null 不代表 0。

### 相似达人（find_lookalike）

| 用例 | 结果 | request_id |
| --- | --- | --- |
| TikTok username | `success`，5 个；返回 `seed`（`seed_creator_key`、`handle`、`display_name`） | 2c137cc4-58e1-497d-85a1-f37a2a18d8cf |
| profile_url | `success`，5 个 | 47a7e08b-ffdc-4c31-8c1d-8cfefe296198 |
| 维度 topic + 硬性条件 US、粉丝 ≥ 1000 | 5 个全部 US，结果不含种子本人 | 8ea8c2dd…、e0bbb6c1-2b67-4416-a714-6da74b823086 |
| Instagram username | `success`，5 个 | f24c6044-39bd-4d6a-85e2-a6d987303bcc |
| 种子不在库（格式合法） | 404 / 40401 `Seed creator is not in Scout's library`；`credits_consumed: 0` | 7a462129-f0d7-4e5f-bf49-be07f966109b |
| 用户名超过 24 字符 | 400 / 40001 “账号名包含不支持的字符”（格式校验） | eab1ed2b-f704-4caf-a0da-e0fc78880a14 |
| 不给种子 | 本地拒绝 | — |

### 计费

所有成功调用 `billing_status: pending_settlement`，`billable_units` 等于实际返回条数（列表按当前页条数，自然语言和相似达人按候选数），`credits_consumed: null`，带 `billing_operation_id`。失败调用 `credits_consumed: 0`、无计费操作号。最终结算是否完成未验证（需要查账务）。
