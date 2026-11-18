# 实时采集 Skill 联调记录

环境：本机 `http://127.0.0.1:8010`，dev 专用 skill Key（五项 `realtime-collection:*` scope），2026-11-13。脚本均从 `influx-ai/` 通过 Skill CLI 运行。用户已授权真实提交、重试和中止，不考虑计费。

## 隔离测试

`node --test tests/realtime-collection.test.mjs`：118 项全部通过（全量 726 项通过）。全部使用注入的 transport。

## 后端阻断问题：submit / keyword-submit 全部 500

| 请求 | 结果 | request_id |
| --- | --- | --- |
| submit LINK_BATCH youtube `@YouTube` | 500 / 50001，outcome unknown | e16e9af2-9d66-47cb-b72f-4becefe12e54 |
| submit 同参数再次提交 | 500（原任务已 failed，不复用） | 0d33227d-add5-4904-911c-b3bdfb8c1ea5 |
| keyword-submit tiktok `skincare routine` | 500 | ea9acdac-d6c2-4023-94cc-b3b676c8e441 |
| submit CREATOR_VIDEO youtube | 500 | 7bd7963b-099e-4a84-a2a8-ba91f0b67cab |
| submit FILE_UPLOAD 虚构用户名 | 500 | e78693f6-2891-4498-b937-1944e140b67b |

进程内复现堆栈：`_submit_collection`（realtime_collection_service.py:439）→ `runtime.py:283 dispatch_submission` → `celery.exceptions.NotRegistered: 'src.business.collection.realtime.execution.submit.process_collection'`。API 进程没有导入 `src.worker.tasks.realtime_collection`。任务记录已提交，随后标为 `failed`（error_message 为 “Celery 派发失败”），客户端拿不到 task_id。

产生的任务（task_name 以 `skill-live-` 开头，source=openapi，caller_type=skill）：

| 名称 | task_id |
| --- | --- |
| link | collection_20261113153542_ab04f33d |
| link（第二次） | collection_20261113153544_e063b3b5 |
| keyword | collection_20261113153546_d55eb240 |
| creator_video | collection_20261113153548_ea20a913 |
| file_upload 虚构用户名 | collection_20261113153551_4469655c |
| 进程内诊断 | collection_20261113154114_fd457fb1 |

## 提交前拒绝（不建任务）

| 请求 | 结果 | request_id |
| --- | --- | --- |
| submit LINK_BATCH youtube `https://example.com/not-youtube` | 400 / 6004 → `all_links_invalid` | 689f9477-9af4-4d06-ae66-06744a565f7f |
| submit POST_VIDEO twitter（直接 HTTP） | 400 / 40001 `Platform 'twitter' does not support video collection` | 6e37562f-6f86-49ee-8eb7-1bf9ffcfe9f1 |

## 真实任务上的操作

| 操作 | 任务 | 结果 | request_id |
| --- | --- | --- | --- |
| status | link（第二次，failed） | 200，`failed`，计数 0 | cc035a19-4481-4136-aa3a-3cbb8ba9c32a |
| steps | 同上 | 200，`crawl_processing` 仍显示 `running`（步骤落后于任务状态） | d0dfc64a-ec39-4e35-9e1c-f3224f2b16a7 |
| data | 同上（无采集任务号） | 500 / 50001 | c385064e-eaeb-4bfe-983f-8dedb2c0fe23 |
| download | 同上 | 409 `collection_state_not_allowed` | b7e2cf8c-2e6a-4421-b7ff-ee4c19d9f200 |
| abort | 同上（failed） | 409 `collection_state_not_allowed` | a7b63db8-7827-43ca-b668-767e1e581e0e |
| retry | link | 200，`crawl_processing`，计数重置 | 27bc5c1a-c0c6-467f-8475-d042d5893e12 |
| retry | keyword | 200，`crawl_processing` | e0fd5d9d-7e27-4b78-9ce7-cc63299d1e75 |
| retry | file_upload 虚构用户名 | 200，`crawl_processing` | 9682040e-f8d0-4fe2-b30d-4c143020056b |
| retry | creator_video | 200，`crawl_processing` | f80790c2-a925-4494-a90c-de7175f6cdc3 |
| abort | creator_video（进行中） | 200，`aborted` | f6d6599f-61fa-4250-ade4-d8a802008ac1 |
| abort | 同上（已中止） | 409 `collection_state_not_allowed` | 87ad7772-b4a0-4a12-9b46-0b1790cc68a5 |
| retry | 同上（已中止） | 409 `collection_state_not_allowed` | 6f49bf19-b657-4d33-aaa3-39d1a92a3af2 |
| status | 同上 | 200，简化状态 `failed` | 61c14521-2669-453a-be52-81578c989b20 |
| keyword-submit | 与进行中的 keyword 同关键词、时间范围不同 | 200，返回原任务，`status: data_processing`，message 提示复用 | c2ac8084-0319-4915-af4a-c2bed1e578dc |
| status / steps | link | `completed`，采集 694 秒，总耗时 695 秒；步骤开始时间仍为最初创建时间 | — |
| data | link | 200，1 行 28 列；单元格混有数字、文本、JSON 文本和 `"1,709"` 这类文本 | f7af619b-f86a-4868-b31a-4c93d106cc0f |
| download zh | link | 200，写入文件 1 行；第一列为 `采集状态` = `success`；账务字段 null | 67d2be74-ec4b-4b20-8269-6c23ba8138b1 |
| status | file_upload 虚构用户名 | `failed`，`failed: 0`，`progress: 100` | — |
| data | 同上 | 200，0 行 | 14889a46-0935-420e-af3b-9598e4490041 |
| download zh | 同上 | 200，1 行，`采集状态` = `invalid` | 718c651d-51a5-4929-a4c1-791cc7e469f9 |
| status | keyword | `processing`，`progress: 100`（入库中） | — |
| data（含 `is_matched_video` true / false） | keyword（入库中） | 200，0 行 | 5b9f8605-8c73-4286-bfc9-be764ea29428 |

## 只读与 404 校验

| 操作 | 输入 | 结果 | request_id |
| --- | --- | --- | --- |
| columns | link_batch / youtube | 200，28 个英文显示名 | 4d5ccf61-6862-4398-9194-62ca2cb1590e |
| columns | keyword / tiktok / zh | 200，16 个中文显示名 | e80e0ecf-56a5-4c49-a4bc-2394a9b38a76 |
| columns | post_video / instagram | 200，`columns: []` | 28f2bbb7-288c-480c-aa12-fe81748aff41 |
| columns | file_upload / twitter / zh | 200，27 个 | 73b72b9a-5fe0-4e32-8219-f780bf08f54b |
| columns | creator_video / youtube | 200，21 个 | 6cd7e813-9449-46b4-9028-c67d2f0cb6ca |
| status / data | 虚构 task_id | 404 / 40401 `Task not found` | cafab71b-78c0-424a-881b-03a147745068 |
| steps / download / abort / retry | 虚构 task_id | 404 / 40401 `collection_task_not_found` | 45672c0c-5c95-419d-8a69-e1591dcb70fe |
| 旧路径 `/v1/collection/tasks/status` | | 404 `Not Found` | b165a051-bb11-4c99-8dd6-690a76806fd0 |
| steps 带未开放字段 | | 422 `Unknown field`，`Cache-Control: private, no-store` | 1af30097-bfcd-4ba0-af6d-c0d14986ec95 |
| status 带未开放字段 | | 原接口忽略额外字段，无 `Cache-Control` | 3bbfdef1-b0d1-4311-a44f-6b6fbe8046fc |

## 重启 worker 后复测

| 请求 | 结果 | request_id |
| --- | --- | --- |
| submit LINK_BATCH youtube | 仍为 500，任务 failed，原因同上（NotRegistered，API 进程侧） | 1b1d6d5e-194b-40b5-a827-0ef5ffe6acd4 |
| keyword-submit tiktok `matcha latte` | 仍为 500，同上 | c6850b21-3d2b-4b3b-a7eb-05d3b8cfa2e2 |
| submit POST_VIDEO youtube | 仍为 500，同上 | 3b7ddd97-cb62-49f8-94bc-ccf004619530 |
| retry 作品链接任务 collection_20261113161227_15295d33 | 200，`crawl_processing` → 约 10 分钟后 `completed` | 5831b2b6-a589-49b9-92fc-7021006a29c9 |
| data / download 作品链接任务 | 200，1 行 21 列，第一列 `Collection Status` = `success` | da6b040f-5031-40df-9d4d-9dfe591b92f1 |
| retry 关键词任务 collection_20261113161226_ea1d4037 | 200；10 分钟后仍 `processing`，`progress: 100`（入库中），与第一次关键词任务表现相同 | c44f7d44-3c49-4f65-b361-327f61d9fa78 |

## 未验证

- submit / keyword-submit 正常返回 `submitted`：被上面的后端问题阻断。
- 关键词任务的真实数据行和 `is_matched_video` 筛选效果：两次关键词任务都停在入库阶段，未拿到数据。
- 6001 / 6005 / 6006、429、webhook 503、retry 502：本环境无法自然触发。
