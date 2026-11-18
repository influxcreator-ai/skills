# 素材上传 Skill 联调记录

环境：本机 `http://127.0.0.1:8010`，dev 专用 Key（仅 `media_uoload` scope），用户 zq340h8xqyh7，2026-11-16。脚本从 `influx-ai/` 通过 Skill CLI 运行。测试文件来自用户指定的 `D:\xizi\work\视频审核\babycare\` 目录。

## 隔离测试

`node --test tests/media-upload.test.mjs`：62 项全部通过（全量 940 项通过）。全部使用注入的 transport。

## 真实 HTTP

| 操作 | 文件 | 结果 | request_id |
| --- | --- | --- | --- |
| 首次探测（服务未启动） | | 连接中断，诊断 `kind: network`、`outcome: unavailable` | — |
| status 随机 UUID | | 404 / 40401 `upload_not_found` | 39b47373-f9d0-4902-8124-bb3f8fd59d6c |
| submit `--wait` document | `Babycare  simplyesrag Video4待审核-脚本.docx`，11596 字节 | 202 → succeeded，4.6 s；大小与 SHA-256 与本地一致 | f5fb4145-e79f-4d7a-950c-1c0ded17d448 |
| submit `--wait` image | `zhaoqing_guangxi_comparison (1).png`，569359 字节 | 202 → succeeded，4.1 s；一致 | d13f2182-5cb7-4d9c-95f2-bdfab018848b |
| submit `--wait` video | `WhatsApp Video 2026-07-24 at 09.05.49.mp4`，154241917 字节 | 202 → succeeded，39.1 s；一致 | 4c55641d-0ae8-4f86-b3dd-abfc4f091726 |
| submit docx 当 image | | 本地拒绝，未发请求 | — |
| submit video（不带 `--wait`） | `Dusti Kae CLOUDSKIN Draft 1.mov`，517158473 字节（493.2 MiB，未超 500 MiB） | 202 受理，18.7 s，大小与 SHA-256 一致 | f129bc12-d919-4587-a6a2-a53f3479f2d8 |
| status `--wait` 同上 | | **failed，`failure_code: storage_upload_failed`**，退出码 1 | 7db05a6e-dfea-4997-abd2-b1a40ea540df |
| 匿名 HEAD 成功文件的 oss_url | docx | 403，对象为私有 | — |

所有成功响应的 `credits_consumed`、`billing_status`、`billing_operation_id` 均为 null。

## 后端修复后复测

后端确认上次失败是 OSS 网络超时：读写超时从 60 秒延长到 1800 秒；超时失败码改为 `upload_timeout`（取代 `upload_interrupted`），并新增 `failure_message`（超时时为“上传超时”）。

| 操作 | 文件 | 结果 | request_id |
| --- | --- | --- | --- |
| submit `--wait` video | `Dusti Kae CLOUDSKIN Draft 1.mov`，517158473 字节 | 202 → succeeded，总耗时 143.5 s；大小与 SHA-256 一致；`failure_message: null` | f53934a8-efda-409c-8bdb-4afc986ee03b |

## 未验证

- 超过 500 MiB 的服务端 413：测试目录里没有超限文件，只有本地拒绝的隔离测试。
- 真实的 `upload_timeout` 返回：只有隔离测试覆盖。
- 429 `upload_capacity_exceeded`、503：本机难以自然触发。
- 24 小时过期后的 404。
