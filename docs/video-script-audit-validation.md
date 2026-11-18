# 脚本与视频审核 联调记录

Key：`influxai_bPLo…`（scope `media_uoload` + `video-script-audit`，只经环境变量注入）。服务：`http://127.0.0.1:8010`。测试素材：`D:\xizi\work\视频审核\babycare\Babycare  simplyesrag Video4待审核`（客户 Brief docx 41 KB、脚本 docx 12 KB、视频 mp4 154 MB / 81.5 秒）。

## 1. 隔离协议测试

- `tests/video-script-audit.test.mjs` 110 项、`tests/media-upload.test.mjs` 67 项通过；全仓 1178 项通过。
- `check-skills` 对 video-script-audit、media-upload 无失败；manifest `--check` 通过（150 个文件）。
- 实测后修正：客户端不再校验 `data.stage` 等于请求阶段（`video_upload` 返回 `stage: "completed"`），CLI 提示和摘要改用请求的阶段名；新增对应测试。

## 2. 真实 HTTP 联调

第一次（20:4x，API 未重启）：审核路由全部 404 `Not Found`，在认证前返回；同时 media_uoload、brief-analysis 返回 503 `Authentication unavailable`。

重启后（2026-11-16 12:59–13:23 UTC）：

### 只读

| 调用 | 结果 | request_id |
| --- | --- | --- |
| projects_list `{}` / size 100 | 200，total 18 | c3b1707a-eb2f-4382-9425-7e4d8fb99224 / f4f40b12-ac6f-4311-9280-02466fd67052 |
| history `{}` / root_only / 项目类型 / 独立类型 | 200，total 105 / 64 / 18 / 84 | 8632326d…、1f31e8cb…、3a5f5690…、dbf67454… |
| projects_get、sessions_list、status（单阶段、全部）、result 假 UUID | 404 `session_not_found` | 861ad0e3…、116ff41c…、2abe20d2…、ecda9fa6…、8e2840ed… |
| 原始 422：parent_id+root_only、size 101、未知字段、enhancement 阶段、run_enhancement、video 带 doc_type、collaboration 带 industry、independent 缺 industry | 全部 422 / 42201 | 3cbf997c…、a132f01c…、0e0609fb…、dee732e1…、1e1f032f…、4122160b…、381d6ff5…、3096bd77… |
| reports/list | 404 Not Found（未开放） | 4f63f612-54e8-4dcd-8117-8ad358766815 |

### 上传

| 文件 | public | upload_id | request_id |
| --- | --- | --- | --- |
| babycare-brief.docx | true | 7e67a65c-5cde-45b7-aaa4-bf026aed4488 | 0e474719-88d4-45b2-bf44-ce03a6aa1df8 |
| 脚本.docx | true | 3fec1ddf-db03-4f07-a164-d7d2447541c2 | bdbf1e48-9999-48e0-8baa-2a028fe7faa5 |
| babycare-brief.docx（反向用） | false | 4612ab1d-25cc-4a96-9b5c-5ed7cc2d117a | 1ba196dc-d7b1-4e40-95ad-e362d7f9484c |
| WhatsApp Video….mp4（154 MB） | true | 28fe7eae-cb61-4b96-bed6-ed9e6ae086a9 | 6966e1f1-27a9-4a41-bf90-d4c781ba03f4（约 39 秒） |

### 独立审核 `475c89ed-af0b-48a0-8b98-eba548966a6e`

| 步骤 | 结果 | request_id |
| --- | --- | --- |
| create independent | 200，status pending | db1db563-c6b6-436d-8e9d-65a78bb5f893 |
| 反向：导入私有上传 | 404 `upload_reference_not_found` | 4b96d7a5-6dbe-4854-b4b7-762bcfc148a5 |
| 反向：无素材执行 script_qc | 409 `audit_state_not_allowed` | 11c23cc1-06f1-4483-ae86-1daf9a7fe229 |
| status 全部（导入前） | 7 个阶段都是 pending | 78243027-cae5-4016-bdaa-5454af8d948e |
| import client brief → brief_upload | processing → completed（2 秒） | 7bc9eac4… → 65d54696… |
| parse_brief → brief_parse | queued → completed（约 43 秒） | d86dc7bb… → 10de3e76… |
| import script → brief_upload_script | processing → completed（1 秒） | c092968a… → e38ad862… |
| script_qc → script_qc | queued → completed（约 1 分 45 秒）；得分 68，“需修改”，11 条建议 | 87be90ea… → 6a1a49e3… |
| import video → video_upload | processing → completed（压缩 154 MB → 8.8 MB，处理约 32 秒） | 01046d04… → 1ddd5ddb… |
| analyze_video → video_analysis | queued → completed（约 12 分 50 秒）；第一轮 `--wait` 退出码 2，续查后完成 | cac4e160… → 7143e88c…（exit 2）→ 420fbded… |
| run_audit → content_audit | queued → completed（约 53 秒）；`conditional_pass` | 71ad5bc9… → cddb0947… |
| status 全部 / result | 7 个阶段 completed；report completed | 4eb9248a… / eb4f5193-c49d-4795-a3e1-b8985db49d71 |

### 项目与项目下审核

| 步骤 | 结果 | request_id |
| --- | --- | --- |
| create project `e3d206df-dd41-4b4c-be9f-0317f75df88d` | project_session_id = session_id | 43cac996-43d2-4944-83b7-abfe3116b5cf |
| projects_get | 200 | ca8f1f5b-9481-40b4-9909-9cb12386e10a |
| 反向：项目导入脚本 | 400 `invalid_audit_request` | e4f90830-3179-47b2-b57d-df918ecde0a8 |
| 项目导入客户 Brief、parse_brief | completed（约 36 秒） | 70c0cd53… → bdc0c7c6… → ff2b7257… |
| create collaboration `b125ea08-e263-43f5-ac78-964e3b0b8a18` | 返回 parent_id、project_session_id | 3e90aaab-f9d2-43d1-a0f2-b89877bd0b74 |
| sessions_list / history parent_id | total 1 / total 1 | 80a8951d… / 1c306d48… |
| 反向：项目下审核导入客户 Brief | 400 `invalid_audit_request` | a7f6caeb-52fb-4b9d-a407-d1bf97d5236e |
| 导入脚本、brief_parse（读项目）、script_qc | completed；script_qc 约 1 分 24 秒 | f978cc2c… → ab5759f1… → 0189d099… → e8c4055d… |
| result | 200 | 301d571b-e276-4ff8-96d3-46cd98bd872b |

## 3. 发现的问题（服务端，未自行修正）

已修复：

1. 原来只有 `video_upload` 的 `data.stage` 返回 `completed`，不是阶段名。服务端修复后复测（只读）：单阶段查询返回 `stage: "video_upload"`（request_id 0b77163f-dd1a-4a4e-8cdb-d2b6b3ea1303）；全部阶段查询中 7 个阶段的 `stage` 都等于阶段名（request_id 23d52903-bf8a-496c-a27f-f6673109b6d1）。客户端已恢复对 `data.stage` 的校验。

用户确认为设计如此（后续由服务端加一层过滤处理）：

2. result 的 `stages` 不含 `brief_upload_script`、`script_qc`，各阶段不带 `result_data`；`briefs` 导入两份文档后仍为空；`session` 不含 `name`。
3. 素材 `name` 是 `<upload_id>.<扩展名>`，原文件名丢失。
4. 项目下审核的 `session_type` 与独立审核相同（`video_script_audit`），history 按类型筛选无法区分。
5. 内容审核报告汇总与明细不一致：`overall_score` null（5 个维度都有分）、`pass_rate` 0 与 `selling_point_coverage` 0（卖点命中 3/4、必须说命中 5/6）、`summary` 空、`key_issues` 空（`revision_plan` 有 P0 问题）、`brief_match` 85 分但状态 `not_applicable`。

### 外部链接导入（OpenAPI 不支持）

| 调用 | 结果 | request_id |
| --- | --- | --- |
| 原始请求：Google Docs Brief 链接导入项目 | 404 `upload_reference_not_found` | 970116f6-3d5f-4c13-87f7-77477ead003b |
| 原始请求：Google Drive 视频链接导入项目下审核 | 404 `upload_reference_not_found` | 9dda418b-752e-4403-8420-f3507e804e8d |
| CLI：Google Docs 链接（带 `?usp=sharing`） | 本地拒绝，不发请求 | — |
| CLI：Google Drive 视频链接 | 404 `upload_reference_not_found` | 496f3c04-54c1-4bc6-9a25-8c7ac7ee1acc |

## 5. 新投影与外链导入复测（2026-11-17 04:20 UTC 起）

| 调用 | 结果 | request_id |
| --- | --- | --- |
| status 单阶段 video_upload | 只有 session_id、stage=video_upload、status、error_code、duration_ms=81493 | 3dce7872-4516-42ac-92f6-a8bc3ca972a0 |
| status 单阶段 script_qc | 只有四个字段，无 result_data | 88c0a93a-a4be-4380-b2e2-4c2d475e7a3b |
| status 全部 | 七个阶段齐全，每项只有 status、error_code（video_upload 带 duration_ms） | 40a47ec5-82f8-4c08-a018-40aa53ea57ad |
| result 独立审核 475c89ed… | 结构符合；script_qc 68 分、11 条；report conditional_pass，五类核对 6/2/6/3/4 条；约 28 KB | 74f3905f-7225-4721-82e3-335f0bd07079 |
| result 项目下审核 b125ea08…（只做了质检） | 结构符合，但见下方问题 | 834f6db5-3acf-4399-a098-96353255ef45 |
| create 外链测试会话 5a2b5393-9c1e-4507-bb62-486648c5a512 | 200 | f8066d87-f0b3-4c43-b09f-13959ea02c9c |
| import Google Docs Brief（带 ?usp=sharing） | 200 → brief_upload completed，filename 为文档标题 | 45a8368f-0600-4608-b956-e36642a9e0d0 / 0b69d25f-8009-4010-a179-1e4d0ae5da0b |
| import Google Drive 视频 | 200 → video_upload 14 分钟后仍 processing，duration_ms null | 7a0ebe4f-bc63-4195-9c8f-793b8b0ede66 / d5305358-a01b-4034-b372-b295b8872a09 |
| result 外链会话 | materials 含 Brief（标题）和视频（filename=view） | 5537fcc8-482b-4bfe-a10a-9f798d260eb1 |

YouTube 外链视频（会话 1520d8c8-bc87-4267-aeaf-7c85c5acf079）：06:03 import 200、processing（a47494f5-c7f2-473f-bded-a0b365ce484a，约 5.6 秒，导入前已取到视频信息）；06:48 查询为 `download_failed` / `DOWNLOAD_FAILED`，CLI 退出码 1（228e22e4-341a-4a43-8ec4-26c7ae89d992）。OpenAPI 路由、导入和失败状态投影都正常，失败在底层社媒下载服务（下载等待上限 30 分钟）。Google Drive 视频走另一条下载链路，长时间停在 processing，不再跟进。

result 投影与契约不符（服务端）：

1. `stages.brief_upload_script`、`stages.script_qc` 在 status 里是 completed，在 result 里是 pending。
2. 只做脚本质检、没执行 run_audit 的会话，`script_qc` 为空（overall_score null、revision_plan 空、dimensions 空）。`result_snapshot` 只从报告内嵌数据取质检结果，路由传入的 `script_qc_source` 未使用。
3. `materials` 不含脚本，只列客户 Brief 和视频；项目下审核列出的是项目的客户 Brief。
4. `filename`：本服务上传的仍是 `<upload_id>.docx` / `.mp4`；Google Drive 视频是 `view`（取了 URL 最后一段）。Google Docs 正确。
5. `session.name` 为 null（create 时传了名称）；项目下审核的 `session.parent_id` 为 null。
6. `report.final_report.revision_plan[]` 没有 `title`；`issues` 内仍是嵌套对象（含 `supporting_evidence` 等）。

## 6. result 修复后复测（2026-11-17）

上节 6 处问题全部修复：

| 会话 | 结果 | request_id |
| --- | --- | --- |
| 独立审核 475c89ed… | session.name 有值；materials 含客户 Brief、视频、脚本；七个阶段与 status 一致；script_qc 68 分、11 条（含 title）；report conditional_pass，revision_plan 2 条，`title` 为 null（契约允许），issues 只有 issue/priority，actions 只有 suggestion；约 20 KB | 0ca90904-beba-4b8a-8680-354aa0ed9921 |
| 项目下审核 b125ea08…（只做质检） | parent_id 有值；materials 含脚本；script_qc 82 分、10 条；report 为空 | f2eb2935-0174-4e71-918c-0db90b613f0f |
| 外链会话 5a2b5393… | Google Docs Brief 文件名为文档标题；Drive 视频仍是历史记录名 `view`（契约：历史素材不补写） | d38ec2c5-4ad0-48d3-b0d6-5d64c760b821 |
| 项目 e3d206df… | 只有客户 Brief，结构正常 | f30d9d45-0055-4fe5-9a11-42d14c60bf32 |
| 新会话 b8a7c9bc-f28d-490c-bb15-865722603261：公开上传脚本 → 导入 → result | `filename` 为原始文件名“Babycare  simplyesrag Video4待审核-脚本.docx” | 上传 99a7f845… / 导入 c4768232… / result 11de5ccc-b06d-4d39-8fe3-68d24da8e0da |

## 4. 未验证

- 项目下审核的视频链路（独立审核已覆盖视频导入、分析和内容审核）。
- 阶段失败状态（`failed`、`*_failed`、`partial`）的真实响应。
- 429、503、500 的真实响应。
- 409 `upload_reference_not_ready`（上传太快完成，未能在 uploading 时导入）。
