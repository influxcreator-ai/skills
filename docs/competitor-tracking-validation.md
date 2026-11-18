# 竞品追踪 Skill 联调记录

环境：本机 `http://127.0.0.1:8010`，dev 专用 Key（仅 `competitor-tracking` scope），用户 zq340h8xqyh7，2026-11-15。脚本均从 `influx-ai/` 通过 Skill CLI 运行。未调用 create、confirm-keywords、refresh-brand-context、materialize、regenerate、refresh-existing-evidence、archive。

## 隔离测试

`node --test tests/competitor-tracking.test.mjs`：152 项全部通过（全量 878 项通过）。全部使用注入的 transport。

## 第一次（服务未加载新代码）

| 操作 | 结果 | request_id |
| --- | --- | --- |
| list `{}` | 404 / 40401 `Not Found`，无 `Cache-Control`（路由不存在） | de746bc2-2910-47ad-a561-26bfba0a64b0 |
| get 虚构 study_id | 404 `Not Found` | 0e09f880-4a22-4c14-8b3f-c0b98801ffc7 |
| report 虚构 study_id | 404 `Not Found` | a7ab762f-de27-47dc-9cf9-a5134e9815b0 |

## 第二次（服务重新加载后）

| 操作 | 结果 | request_id |
| --- | --- | --- |
| list `{"size":50}` | 200，`items: []`，`total: 0`；`meta.page`=1、`meta.total`=0；账务字段 null | e9ccdf9a-ddf8-4a51-aaed-b40b8c924422 |
| list `{"status":"completed","size":5}` | 200，0 条 | 995464dc-fc6f-4e19-83d8-b46bc516d1bb |
| get 虚构 study_id | 404 / 40401 `study_not_found` | 2e80165f-6bbb-418a-a287-e4d23b3684a5 |
| report 虚构 study_id | 404 / 40401 `study_not_found` | aed59643-c83c-40cd-ad63-813a86ec9384 |
| list 带未开放字段（直接 HTTP） | 422 / 42201 `body.extra: Unknown field`，`Cache-Control: private, no-store` | b4b776ae-6372-4a9d-a455-ff2f3cc5e625 |
| get `study_id` 含空格（直接 HTTP） | 422 / 42201 | 71424128-0ec0-4662-a0ec-fe4f320bf011 |

## 第三次（用户授权真实创建与动作）

测试目标：主品牌 Glossier（种子词 `glossier`）、对比品牌 Rare Beauty（`rarebeauty`），仅 TikTok，近 30 天，intent `competitor`。

### 研究一 kms_e036bcaaf6aa44d288ee6f467422e2deb603a7bd9702f602（键 ct-skill-live-20261115-01）

| 操作 | 结果 | request_id |
| --- | --- | --- |
| create | 200，`awaiting_keyword_confirm`；本机实时检索关闭，两组 `brand_context.status=unavailable`，扩词只有种子词 | 976d8ce7-8a0a-42b5-a816-dc71907cab4d |
| create 同键同参数重放 | 200，返回同一个 study_id | 227c267a-c798-4e82-90a6-296263f7fb32 |
| create 同键不同参数 | 409 `study_creation_conflict` | 7bc99432-92ad-4a96-8c5c-c6aedd3304a6 |
| confirm 未传 `brand_context_reviewed` | 400 `invalid_study_request` | 4daadc18-1017-4480-9059-e2f665681fda |
| confirm 过期 revision | 400 `invalid_study_request` | 9e2fe987-9209-4cfa-b3f0-128a25a2692c |
| confirm 缺一组 | 400 `invalid_study_request` | 020df758-4496-4358-bac0-84080eddce23 |
| confirm 主组含对比品牌词 | 400 `invalid_study_request` | df8b4787-5713-488b-8e2a-1b0893f54ae6 |
| report（未就绪） | 409 `study_state_not_allowed` | d7b56364-dbb2-47d3-96d3-084391239e4b |
| brand-videos（未召回） | 200，`[]` | 5411e909-270a-45c4-9bdc-55ddde4b9333 |
| comments | 200，`total: 0` | 8878a64a-3816-4fb4-8e4b-675159b112c5 |
| comments 不属于研究的 brand_id | 400 `invalid_study_request` | 968953f5-48ae-49e9-b1e3-ea9ce6b10fe4 |
| materialize（等待确认阶段） | 409 `study_state_not_allowed` | 8f23b52b-f326-40c6-9ece-c7675953a07c |
| regenerate（运行中） | 409 `study_state_not_allowed` | 114cf1f1-b20f-42df-af56-caa34faf8c2b |
| archive（等待确认阶段） | 200，`archived: true`。**测试脚本顺序错误，在正式确认前归档了该研究** | 8ae059cd-b203-41ea-96cf-2d43c5058c12 |
| 归档后 confirm / refresh-brand-context / get | 均 404 `study_not_found` | 03a0efe7-0286-4307-8285-ecaabf02894c 等 |

### 研究二 kms_6b4858226e1badcb3c35164531c76e6febee7f48b8d8251a（键 ct-skill-live-20261115-02）

| 操作 | 结果 | request_id |
| --- | --- | --- |
| create | 200，revision a46d…，品牌依据 unavailable | 71dc9fec-f02b-4a13-b611-e6ae7c86cfd3 |
| refresh-brand-context（Glossier 补官网） | 200，revision 变为 69e8…，依据仍 unavailable | 115860bb-66bc-47de-80f7-ac0fcf5a5d23 |
| confirm 用刷新前的 revision | 400 `invalid_study_request` | 086a2cf2-3c55-4186-9608-2ea26c87c783 |
| confirm 用新 revision、`brand_context_reviewed: true` | 200，`stage: recalling`，确认词 `glossier` / `rarebeauty` | 0d120820-038e-4e1b-bcf8-30e2e7a66605 |
| refresh-brand-context（已确认后） | 409 `study_state_not_allowed` | a8bce6a7-8532-4c24-960d-2e54065bcf3e |
| get | 200，`recalling`，`report_state: pending`，`execution.state` 先 `unknown` 后 `active` | f39bcab2-83d3-4289-9c59-c8f63c880715 |

### 研究二后续

| 时间（UTC） | 操作 | 结果 | request_id |
| --- | --- | --- | --- |
| 08:41 | get | `recalling`，`recall_quality.phase=brand_review_pending`；召回 3021 条，审核抽样 868 条，`reviewed: 0` | 642c0083-5eeb-4849-b5d5-1fbda6fe6788 |
| 11:19 | get | `failed`，`stage: collecting_comments`，`failure_reason`=洞察所需的数据处理未在限定时间完成，报告未生成；`report_state: regenerate_required`；`execution: terminal, can_retry: true`；审核 868 条全部完成，通过 747 | af84bf0b-d4bf-4756-b5d6-4729f7d440ed |
| 11:20 | report | 409 `study_state_not_allowed` | ae2baf22-ecbf-4b88-acc2-193493aea4a7 |
| 11:20 | brand-videos 主品牌 / 对比品牌 | 200，各 **12 条**（未完成研究的候选列表，超过文档的六条），带 `study_video_id` 和完整达人、受众 metrics | bef44048-a988-4573-af4a-17adfd3dfaa6 / ba44a661-4929-4bfc-9cec-8cf29d78b3e4 |
| 11:20 | comments `love` / `color` / `blush`（limit 5） | 200，total 39 / 11 / 7，各返回 5 条，字段与契约一致 | a7f64793-de72-4b8a-be36-f987f2a409be 等 |
| 11:20 | materialize（failed） | 409 `study_state_not_allowed` | 4d6a05e0-d356-4486-af59-2a586f846e2d |
| 11:20 | refresh-existing-evidence | **202**，`execution_version: 2`，`scheduled: true` | fcb759d0-8554-49b1-babf-0d48c49e44db |
| 11:20 | refresh-existing-evidence 再次 | 409（研究已回到运行中） | a0767ce8-3510-423b-83ef-35acfd7ae501 |
| 11:21 | get | `running`，`analyzing`，`report_state: pending`，`result` 新增 `sov_soc` | 5531e557-43ae-4fd2-8db9-73d54930c77b |

## 未验证

- 正式 report 的真实结构：等 refresh-existing-evidence 后的分析完成。
- materialize 成功路径：需要研究停在 recalling / collecting_comments / analyzing 且未失败时才能触发。
- regenerate：会重跑整轮召回，未执行。
