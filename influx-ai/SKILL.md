---
name: influx-ai
description: |
  达人发现 Skill。支持自然语言查找 TikTok、Instagram、YouTube 达人，按结构化筛选条件分平台浏览
  TikTok/Instagram/YouTube/Twitter 达人库，按品牌查找公开合作达人，以及根据种子达人查找相似达人。
  支持独立邮箱查找：预览、创建、进度、分页结果和本人历史；支持 Hashtag 深度搜索：按研究需求提交任务、查询进度与结果、本人历史、搜索下一批和重试；支持达人画像打标：提交主页批次、查询进度、条目与画像结果、本人历史和重试；支持物流追踪：登记寄样运单、查看列表、统计与轨迹，以及刷新、恢复、更换承运商、人工跟进、停止和删除；支持视频监控：注册视频监控、查看列表、快照与趋势，以及暂停／恢复、修改期限、归档和手动采集；支持实时采集：按主页链接、用户名、达人视频、作品链接或关键词提交采集任务，查询状态与步骤、分页读取或导出结果、查看导出字段，以及中止和重试；支持竞品追踪的关键词研究：创建研究并扩词、确认关键词、查看进度、正式报告、来源评论与品牌视频，以及刷新、重新生成和归档；支持 Brief 分析：上传 Brief 文件后提取结构化事实，查看进度与报告、编辑、重试，以及生成 Campaign 草稿投影；支持脚本与视频审核：创建审核会话或项目，导入公开外链或公开上传的 Brief、脚本或视频，分阶段执行解析、质检、视频分析和内容审核，查询状态、结果与历史；支持通用素材上传：把授权的本地文档、图片或视频上传（默认私有，可按需公开）并取得 oss_url；也支持达人邮件建联：首封、回复、Smart Send 预约、台账/会话查询及首封内容准备，调用 Scout OpenAPI。
compatibility: Node.js 20.6+
license: MIT-0
metadata:
  version: "0.4.0"
---

# Influx AI

## 强制执行边界

根据用户的达人发现、独立邮箱查找、Hashtag 深度搜索、达人画像打标、物流追踪、视频监控、实时采集、竞品追踪、Brief 分析、脚本与视频审核、素材上传或邮件建联请求，选择对应子 Skill 和脚本。Brief 分析的 submit 和 retry 会派发真实分析、可能调用模型，只按用户明确意图执行；submit 保留同一个 Idempotency-Key，HTTP 200 不等于分析成功，以 data.status 为准；campaign-draft 只返回草稿投影，不创建 Campaign。脚本与视频审核的 import 和 execute 会写入素材、调用 IMM 或模型，只按用户明确意图执行；素材用公开外链或公开上传，公开上传前告知用户；每个阶段用 status 确认完成后再执行下一阶段，失败即停，不自动重试；不提供增强审核和报告导出。素材上传只上传用户授权的文件，不会触发分析或审核；默认私有，只在工具要求时公开上传；submit 的 202 只表示受理，查到 succeeded 才能使用 oss_url。竞品追踪的 create 会立即扩词并调用模型或搜索，一次逻辑创建保留同一个 Idempotency-Key；关键词和品牌依据由用户确认后才 confirm，不替用户设置已核对；get、report 等读取不自动衔接刷新、物化或重新生成。实时采集的提交、重试和中止只按用户明确意图执行；提交后保存返回的 `task_id`，不猜测任务 ID；达人检索无结果时不自动提交采集。物流追踪的登记、刷新、恢复、更换承运商、跟进修改、停止和删除只按用户明确意图执行，变更前读取最新 version，409 后不自动重放。视频监控的注册、暂停／恢复、修改期限、归档和手动采集只按用户明确意图执行，list 与 get 不触发采集。达人画像打标的 submit、retry 会产生外部打标和采集成本，只按用户明确意图运行；`unknown` 条目可能已计费，不自动重试。邮件发送、回复和预约须展示目标、主题、完整正文及模式，经用户确认后提交。Hashtag 深度搜索的 submit、next、retry 会产生模型和检索成本，只按用户明确意图运行，不放进轮询或自动恢复。接口无结果或不可用时，不未经用户同意改用公开网页搜索。

## 意图路由

- 查找指定账号/主页的邮箱、预览查找输入、查询邮箱批次进度/结果/历史：加载 `tools/creator-email-lookup/SKILL.md`，调用五个 `scripts/email_lookup_*.mjs` 入口。仅筛选有邮箱候选仍走 discovery；独立查找不发送邮件。
- 研究某个主题、品类或内容方向适合的 hashtag / 话题标签，或查询、续做之前的标签研究任务（进度、结果、历史、下一批、重试）：加载 `tools/hashtag-deep-search/SKILL.md`，调用五个 `scripts/hashtag_deep_search_*.mjs` 入口。找达人仍走 discovery。
- 为用户给出的一批 Instagram / TikTok / YouTube 达人主页生成画像、打标签，或查询之前打标批次的进度、条目和画像结果、重试失败条目：加载 `tools/creator-profile-tagging/SKILL.md`，调用七个 `scripts/profile_tagging_*.mjs` 入口。找达人仍走 discovery。
- 登记寄给达人的样品运单、查物流进度和签收情况、看运单统计、管理寄样跟进状态，或刷新、恢复、更换承运商、停止、删除运单：加载 `tools/logistics-tracking/SKILL.md`，调用十一个 `scripts/logistics_*.mjs` 入口。
- 持续跟踪指定视频的播放、点赞、评论等表现数据，查看视频监控列表、快照和趋势，或暂停／恢复、修改期限、归档、手动采集：加载 `tools/video-monitor/SKILL.md`，调用七个 `scripts/video_monitor_*.mjs` 入口。
- 用户**明确要求实时采集**指定的主页链接、用户名、达人视频、作品链接或关键词，或查询、读取、导出、中止、重试已有的实时采集任务：加载 `tools/realtime-collection/SKILL.md`，调用九个 `scripts/realtime_collection_*.mjs` 入口。普通找达人仍走 discovery，检索无结果时先问用户，不自动转来提交采集；按品牌名查近期提及仍走 `creator-search` 的实时提及。
- 做**竞品分析 / 品牌声量对比**：为本品牌和竞品各建词组，研究 hashtag、视频和评论并出对比报告，或查看、推进、重新生成、归档已有竞品研究：加载 `tools/competitor-tracking/SKILL.md`，调用十二个 `scripts/competitor_tracking_*.mjs` 入口。只研究某主题的 hashtag、不比较品牌，仍走 `hashtag-deep-search`；找品牌合作达人仍走 `creator-search`。
- 分析品牌 Brief 文件、整理合作需求、查看或修改 Brief 分析结果、把 Brief 转成 Campaign 草稿：加载 `tools/brief-analysis/SKILL.md`，先用 `scripts/media_upload_submit.mjs` 上传取得 `oss_url`，再调用七个 `scripts/brief_analysis_*.mjs` 入口。
- 审核达人的脚本或视频是否符合客户 Brief、做内容合规审核，或查看以前的审核会话、项目和结果：加载 `tools/video-script-audit/SKILL.md`，素材是公开外链时直接导入，本地文件先用 `scripts/media_upload_submit.mjs --public` 上传取得 `oss_url`，再调用九个 `scripts/video_script_audit_*.mjs` 入口。只想提取 Brief 的结构化事实、不审核脚本或视频，仍走 `brief-analysis`。
- 上传本地文档、图片或视频，把文件变成 `oss_url`，或查询之前的上传状态：加载 `tools/media-upload/SKILL.md`，调用 `scripts/media_upload_submit.mjs`、`scripts/media_upload_status.mjs`。上传本身不分析文件；需要素材的工具先用它拿到 `oss_url`。

- 发合作邮件、回复已有达人会话、查询邮件台账/沟通历史、读取/准备首封内容：加载 `outreach/creator-outreach/SKILL.md`。支持本地 Agent 起草、用户文案及 Scout 模板；需要已有活动/活动达人关系，搜索 uid 或邮箱不能直接发送。
- 用**自然语言描述**内容方向/人设/风格/场景/产品适配找达人：加载 `discovery/creator-nl-search/SKILL.md`，调用 `scripts/search_creators_nl.mjs`。
- 按**结构化条件**（国家/粉丝/互动/受众画像等，可排序可翻页）找达人，或找**品牌合作达人**、做**实时品牌提及采集**：加载 `discovery/creator-search/SKILL.md`，按意图调用 `scripts/list_creators.mjs`、`scripts/find_brand_collaboration_creators.mjs` 或实时提及脚本。
- 找**相似达人**：加载 `discovery/creator-lookalike/SKILL.md`，调用 `scripts/find_lookalike.mjs`。

种子达人在场时的细分（关键：看种子是"检索主锚点"还是"辅助参考"）：
- 用户主要意图是"与某个种子达人相似/类似/同类型/lookalike"：路由 `creator-lookalike`；额外的国家、粉丝、邮箱、内容要求作为其收敛条件，不因带筛选条件而改走别的 skill。
- 用户主要按自然语言描述找达人、仅把某个账号作为风格或内容参考：路由 `creator-nl-search`，并使用 `seed_creators`。
- 用户明确要找相似达人但尚未提供种子：仍路由 `creator-lookalike`，并先询问种子达人（触发条件 ≠ 执行条件）。
- "这种/刚才那个达人"等指代：若指代可解析为前文某个具体达人 → `creator-lookalike`；若"这种"仅指品类/画像 → `creator-nl-search`。

描述型 vs 结构化型的取舍：用户用内容方向或人设描述目标达人 → `creator-nl-search`（自然语言搜索）；用户给出可直接映射字段的结构化区间条件、需要可排序可翻页结果 → `creator-search`（结构化列表）；用户要找和某品牌合作过的达人 / 近期提及 → `creator-search`（品牌合作 / 实时提及）。

## Brief 澄清与过程输出质量

- 自然语言搜索（creator-nl-search）需明确平台和内容方向描述；缺少平台时先询问。支持 TikTok/Instagram/YouTube。
- 结构化列表 / 品牌合作 / 实时提及（creator-search）需明确平台和筛选条件或品牌名；缺少平台时先询问。结构化列表额外支持 Twitter 且一次只查单一平台，品牌合作支持 TikTok / Instagram、需明确品牌名。
- 相似达人（creator-lookalike）至少需要用户名、主页链接或 Scout 达人标识之一。

输出只使用接口实际返回的达人信息，不补造字段。

## 搜索预算与静默查询边界

达人发现每次用户请求默认只调用一次对应接口。不自动扩大数量、放宽条件、翻页或切换平台/链路；再次查询前先告知用户。

自然语言搜索、相似达人及四平台结构化列表已接入积分：按请求 `limit` / `size` 做最高可能用量准入，按实际交付候选 / 当前页 `items` 数登记用量，不能用 `total` 或请求数量推算最终费用。`pending_settlement` 或 `recording_failed` 不触发重复搜索。重新执行会产生新的独立计费操作，不能代替查询原回执；价格与扣费由后端 Billing 负责，Skill 不自行计算或执行扣费。计费字段解释见 [API 参考](references/api-reference.md)。

## 生态总览

| 领域 | 子 Skill | 能力描述 |
|------|----------|----------|
| discovery | creator-nl-search | 自然语言找达人：按内容方向/人设/风格/场景/产品适配描述搜索（TikTok/Instagram/YouTube），含 `seed_creators` 参考账号 |
| discovery | creator-search | 结构化分平台筛选列表（TikTok/Instagram/YouTube/Twitter）、按品牌找公开合作达人、实时品牌提及采集 |
| discovery | creator-lookalike | 根据 Scout 已收录的种子达人查找同平台相似达人 |
| tools | creator-email-lookup | 独立邮箱查找：预览、创建、详情、分页条目、本人批次列表 |
| tools | hashtag-deep-search | Hashtag 深度搜索：提交研究任务、查询进度与结果、本人历史、搜索下一批、重试失败任务 |
| tools | creator-profile-tagging | 达人画像打标：读取参数、提交批次、批次进度、条目与画像结果、本人历史、重试失败条目 |
| tools | logistics-tracking | 物流追踪：承运商查询、登记运单、列表、统计、轨迹详情、刷新、恢复、更换承运商、人工跟进、停止、删除 |
| tools | video-monitor | 视频监控：注册、列表、快照与趋势详情、暂停／恢复、修改期限、归档、手动采集 |
| tools | realtime-collection | 实时采集：按主页链接、用户名、达人视频、作品链接或关键词提交采集，状态、步骤、分页结果、导出字段、全部导出、中止、重试 |
| tools | competitor-tracking | 竞品关键词研究：创建并扩词、列表、详情与进度、确认关键词、刷新品牌依据、正式报告、来源评论、品牌视频、补偿推进、重新生成、用现有证据刷新、归档 |
| tools | brief-analysis | Brief 分析：读取选项、提交分析、进度与报告、本人列表、编辑报告、重试、Campaign 草稿投影 |
| tools | video-script-audit | 脚本与视频审核：创建会话或项目、项目与历史查询、导入素材、执行 Brief 解析／脚本质检／视频分析／内容审核、阶段状态、审核结果 |
| tools | media-upload | 通用素材上传：上传本地文档、图片或视频，查询状态并取得 oss_url |
| outreach | creator-outreach | 首封/批量/Smart Send、回复、台账/会话及首封模板/预览/生成 |

## 路由索引

| 子 Skill | 中文关键词 | 英文关键词 | 路径 |
|----------|-----------|-----------|------|
| creator-nl-search | 自然语言找达人、描述型找达人、按内容方向/人设/风格/场景找达人、参考某账号找相近达人 | natural-language creator search, semantic creator discovery, reference-account search | `discovery/creator-nl-search/SKILL.md` |
| creator-search | 结构化筛达人、达人列表、按国家/粉丝/互动/受众画像筛、品牌合作达人、合作过的达人、实时品牌提及 | structured filters, per-platform list, brand collaboration creators, realtime brand mentions | `discovery/creator-search/SKILL.md` |
| creator-lookalike | 相似达人、类似达人、找同类型达人 | similar creators, lookalike | `discovery/creator-lookalike/SKILL.md` |
| creator-email-lookup | 查邮箱、指定账号邮箱、邮箱批次、查找进度与结果 | independent email lookup, lookup batches | `tools/creator-email-lookup/SKILL.md` |
| hashtag-deep-search | hashtag 研究、话题标签、标签推荐、内容方向找标签、标签研究进度与结果、下一批标签 | hashtag deep search, hashtag research, hashtag recommendations | `tools/hashtag-deep-search/SKILL.md` |
| creator-profile-tagging | 达人画像、画像打标、给达人打标签、主页画像分析、打标批次进度与结果 | creator profile tagging, creator persona tagging, profile tagging batch | `tools/creator-profile-tagging/SKILL.md` |
| logistics-tracking | 物流追踪、寄样运单、登记运单、查物流、签收情况、承运商、寄样跟进状态 | logistics tracking, shipment tracking, sample shipment, carrier | `tools/logistics-tracking/SKILL.md` |
| video-monitor | 视频监控、视频数据跟踪、播放量趋势、视频表现、手动采集 | video monitor, video tracking, video performance, view trend | `tools/video-monitor/SKILL.md` |
| realtime-collection | 实时采集、采集主页/账号/用户名、采集达人视频、采集作品链接、关键词采集、采集任务进度与结果、导出采集结果 | realtime collection, collection task, keyword collection, export collection data | `tools/realtime-collection/SKILL.md` |
| competitor-tracking | 竞品分析、竞品追踪、品牌声量对比、竞品 hashtag 研究、竞品报告、竞品研究进度 | competitor tracking, competitor analysis, brand share of voice, keyword study | `tools/competitor-tracking/SKILL.md` |
| brief-analysis | Brief 分析、解读 Brief、合作需求整理、Brief 报告、Brief 转活动草稿 | brief analysis, campaign brief, brief parsing, campaign draft | `tools/brief-analysis/SKILL.md` |
| video-script-audit | 脚本审核、视频审核、达人视频是否符合 Brief、脚本质检、内容审核、审核项目、审核历史 | video script audit, script QC, video content audit, brief compliance | `tools/video-script-audit/SKILL.md` |
| media-upload | 上传文件、上传素材、上传视频/图片/文档、取得 oss_url、上传进度 | media upload, file upload, upload video, oss_url | `tools/media-upload/SKILL.md` |
| creator-outreach | 发合作邮件、回复达人、邮件状态、沟通历史、首封模板、Agent 起草 | creator email outreach, reply, Smart Send, email template | `outreach/creator-outreach/SKILL.md` |

## Prerequisites

- Node.js 20.6 或更高版本。
- 可访问 Scout OpenAPI 服务；通过 `SCOUT_API_BASE_URL` 配置地址（OpenAPI 挂载在 `/openapi`，脚本已拼接 `/openapi/v1/...` 路径）。
- 配置 `SCOUT_API_KEY`：每次请求都会通过 `X-API-Key` 头认证。用户身份由后端根据 Key 解析，无需传用户 ID。缺少该变量时脚本会在本地直接报错、不发请求。Key 属于机密，仅放在环境变量里，勿写入代码、命令参数或日志；多用户场景各自使用自己的 Key。

自然语言搜索、相似达人及四平台结构化列表共六个接口要求 `creator:search`。后端分别检查 Key 有效性、Key scope、服务端 scope 策略和用户 `Scout Discover` 权限；有 scope 不等于有业务权限。不需要 JWT、用户 ID、自报角色或额外 scope 请求头，普通搜索无需 `billing:read`，Skill 不自动创建 Key。

独立邮箱查找五操作统一要求 `email-lookup` scope，并由服务端检查 `Scout Find Email` 与资源归属。旧 Key 不自动获得新 scope；202 仅受理，计费 null 不等于供应商免费。详见[邮箱查找子 Skill](tools/creator-email-lookup/SKILL.md)。

Hashtag 深度搜索五操作统一要求 `hashtag-deep-search` scope，并由服务端检查 `Scout Hashtag Deep Search` 权限与任务归属。旧 Key 不自动获得新 scope；202 仅受理，计费 null 不等于免费。详见[Hashtag 深度搜索子 Skill](tools/hashtag-deep-search/SKILL.md)。

达人画像打标七个操作统一要求 `creator-profile-tagging` scope，并由服务端检查达人画像打标权限与批次归属。旧 Key 不自动获得新 scope；批次和条目 ID 都是十进制字符串；202 仅受理，计费 null 不等于免费。详见[达人画像打标子 Skill](tools/creator-profile-tagging/SKILL.md)。

物流追踪十一个操作统一要求 `logistics-tracking` scope，并由服务端检查物流权限与运单归属。旧 Key 不自动获得新 scope；成功均为 HTTP 200；运单上的扣费可能是历史回执，`meta` 账务字段为 null 不等于免费。详见[物流追踪子 Skill](tools/logistics-tracking/SKILL.md)。

视频监控七个操作统一要求 `video-monitor` scope，并由服务端检查视频监控权限与资源归属。旧 Key 不自动获得新 scope；`monitor_id` 与返回的 `id` 都是十进制字符串；成功均为 HTTP 200，注册成功或 `accepted=true` 不等于采集完成；账务字段为 null 不等于免费。详见[视频监控子 Skill](tools/video-monitor/SKILL.md)。

实时采集九个操作分别要求 `realtime-collection:submit`、`realtime-collection:keyword-submit`、`realtime-collection:status`、`realtime-collection:data`、`realtime-collection:manage` 五项 scope，并由服务端检查实时采集权限；只能操作当前 Key 所属用户通过 OpenAPI 提交的任务。旧的 `collection:*` scope 不再有效。成功均为 HTTP 200，`submitted` 只表示受理；原四项的业务错误是 HTTP 400 加原业务码，新增五项是 HTTP×100+1；`credits_consumed` 为 0 或 null 都不代表免费。详见[实时采集子 Skill](tools/realtime-collection/SKILL.md)。

竞品追踪十二个操作统一要求 `competitor-tracking` scope，并由服务端检查洞察或竞品追踪权限与研究归属。旧 Key 不自动获得新 scope；refresh-existing-evidence 成功为 HTTP 202，其余为 200；受理或 `completed` 不等于报告可交付，以 `result.report_state` 和 report 的正式交付校验为准；账务字段为 null 不等于免费。详见[竞品追踪子 Skill](tools/competitor-tracking/SKILL.md)。

素材上传两个操作要求 `media_uoload` scope（服务端正式拼写），只能查询本人的上传记录；上传权限不包含任何分析或审核权限。submit 成功为 HTTP 202，status 为 200；默认私有，`oss_url` 不能匿名下载；`--public` 上传的对象可被任何拿到链接的人读取；账务字段为 null 不等于免费。详见[素材上传子 Skill](tools/media-upload/SKILL.md)。

Brief 分析七个操作要求 `brief-analysis` scope 和 Brief 分析权限，上传文件另需 `media_uoload`；只能操作本人的任务和上传。submit、retry 成功为 HTTP 202，其余为 200；`task_id` 与返回的 `id` 都是十进制字符串；账务字段为 null 不等于免费。详见[Brief 分析子 Skill](tools/brief-analysis/SKILL.md)。

脚本与视频审核九个操作要求 `video-script-audit` scope 和脚本视频审核权限，上传素材另需 `media_uoload`；只能操作本人的会话；导入本服务上传的素材时只认本人的公开上传。成功均为 HTTP 200；HTTP 200 不等于阶段完成，以 status 返回的阶段状态为准，`pending` 表示还没有记录；解析和审核结果只从 result 读取；账务字段为 null 不等于免费。详见[脚本与视频审核子 Skill](tools/video-script-audit/SKILL.md)。

邮件需分别授权 `creator:outreach:read` 和 `creator:outreach:send`，send 不隐含 read。API Key 与操作 scope 始终校验；只有 `influxai` Billing 模式额外校验 `creator.outreach` 产品权益，`legacy` 模式不检查该新权益。邮件参数见 [邮件子 Skill](outreach/creator-outreach/SKILL.md)，响应见 [API 参考](references/api-reference.md#邮件建联接口)，错误处理见 [错误码参考](references/error-codes.md#邮件建联错误与重试)。

## Error Handling

脚本在 HTTP 错误、网络错误、参数错误或检索失败时以非零状态退出。达人发现外层 `error.code` 约定为 `状态码*100+1`（如 HTTP 422 → `42201`）。上述六个接口：`401` 检查 Key 缺失、无效、过期或撤销；`402` 且 `error.code=40201`、`error.message=insufficient_credits` 表示积分不足；`403` 检查 scope、服务端策略、用户权限或资源归属，不统一解释成缺套餐；`429` 只按有效 `Retry-After` 提示等待，没有就不编造时间，不更换 Key 绕过限流；`503` 表示服务或依赖暂不可用，不表示 Key 一定无效。HTTP 200 / `success:true` 仍需检查 `data.status`、`data.errors` 及实际结果，区分空结果、部分成功和业务失败。详见 [错误码参考](references/error-codes.md)；邮件沿用 [错误码参考中的邮件说明](references/error-codes.md#邮件建联错误与重试)。

## References

子 Skill：
- [独立邮箱查找子 Skill](tools/creator-email-lookup/SKILL.md)
- [Hashtag 深度搜索子 Skill](tools/hashtag-deep-search/SKILL.md)
- [达人画像打标子 Skill](tools/creator-profile-tagging/SKILL.md)
- [物流追踪子 Skill](tools/logistics-tracking/SKILL.md)
- [视频监控子 Skill](tools/video-monitor/SKILL.md)
- [实时采集子 Skill](tools/realtime-collection/SKILL.md)
- [竞品追踪子 Skill](tools/competitor-tracking/SKILL.md)
- [Brief 分析子 Skill](tools/brief-analysis/SKILL.md)
- [脚本与视频审核子 Skill](tools/video-script-audit/SKILL.md)
- [素材上传子 Skill](tools/media-upload/SKILL.md)
- [自然语言找达人子 Skill（NL 搜索 / seed_creators）](discovery/creator-nl-search/SKILL.md)
- [达人搜索子 Skill（结构化列表 / 品牌合作 / 实时提及）](discovery/creator-search/SKILL.md)
- [相似达人子 Skill](discovery/creator-lookalike/SKILL.md)
- [邮件建联子 Skill](outreach/creator-outreach/SKILL.md)

参考资料（`references/`）：
- [独立邮箱查找契约](references/email-lookup.md)
- [Hashtag 深度搜索契约](references/hashtag-deep-search.md)
- [达人画像打标契约](references/creator-profile-tagging.md)
- [物流追踪契约](references/logistics-tracking.md)
- [视频监控契约](references/video-monitor.md)
- [实时采集契约](references/realtime-collection.md)
- [竞品追踪契约](references/competitor-tracking.md)
- [Brief 分析契约](references/brief-analysis.md)
- [脚本与视频审核契约](references/video-script-audit.md)
- [素材上传契约](references/media-upload.md)
- [API 参考（端点 / 协议 / 响应结构）](references/api-reference.md)
- [平台参数速查（结构化列表字段）](references/platform-params.md)
- [错误码与状态参考](references/error-codes.md)
- [国家代码映射表](references/country-codes.md)
- [语言代码映射表](references/language-codes.md)
- [行业类目参考](references/industry-categories.md)
