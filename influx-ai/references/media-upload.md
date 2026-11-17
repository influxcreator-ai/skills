# 素材上传契约

通用素材上传两个操作的完整请求、返回、状态和错误规则。日常调用见 [素材上传子 Skill](../tools/media-upload/SKILL.md)。

## 目录

- [端点与调用](#端点与调用)
- [请求](#请求)
- [返回与状态](#返回与状态)
- [费用字段](#费用字段)
- [错误与恢复](#错误与恢复)

## 端点与调用

以下路径在 `{SCOUT_API_BASE_URL}/openapi/v1/media_uoload/` 下，使用 `X-API-Key`，要求 `media_uoload` scope（服务端正式拼写）。上传权限不包含任何分析或审核权限。默认私有上传，可按需公开上传。

| 后缀 | 脚本 | 请求格式 | 成功 |
| --- | --- | --- | --- |
| submit | `scripts/media_upload_submit.mjs` | `multipart/form-data` | HTTP 202，`status: uploading` |
| status | `scripts/media_upload_status.mjs` | JSON | HTTP 200 |

响应只有一层 `success` / `data` / `error` / `meta`，`meta.request_id` 是诊断号，响应带 `Cache-Control: private, no-store`。旧的 `/v1/files/*` 和 `files:upload` 已取消。

## 请求

**submit**：multipart 里只能有一个 `file`、一个 `file_type` 和可选的一个 `public`，多余字段或多个文件返回 422 `invalid_multipart`。

| 字段 | 约束 |
| --- | --- |
| `file` | 单个文件。文件名 1 到 255 字符，不能含路径或控制字符，只作展示；对象键由服务端生成 |
| `file_type` | `document`、`image`、`video` |
| `public` | 可选，默认 false（私有）。`true` 时对象公开，拿到 `oss_url` 的任何人都能匿名读取。脚本只在 `--public` 时发送 `public=true`，否则不发送 |

公开与否由使用素材的工具决定：Brief 分析用私有上传；脚本与视频审核只接受 `public` 为 true 的成功回执。

| 分类 | 允许扩展名 | 默认上限 |
| --- | --- | --- |
| `document` | pdf、doc、docx、xls、xlsx、csv、txt、md、html、htm、pptx | 50 MiB |
| `image` | png、jpg、jpeg、webp | 50 MiB |
| `video` | mp4、mov、m4v、webm、avi、mkv | 500 MiB |

扩展名决定 MIME，服务端不检查真实格式；页数、像素、时长和能否解码由使用素材的工具检查。空文件返回 422 `empty_file`。

脚本以磁盘文件流发送，不把文件整份读入内存；发送前在本地检查扩展名、大小和空文件，并流式计算 SHA-256。

**status**：`{"upload_id": "<UUID>"}`，未列出的字段被拒绝。

## 返回与状态

| 字段 | 含义 |
| --- | --- |
| `upload_id` | 上传标识，只用于查询和排障 |
| `status` | `uploading`、`succeeded`、`failed` |
| `filename` | 原始文件名 |
| `file_type` | 传输分类 |
| `content_type` | 按扩展名确定的 MIME |
| `size_bytes` | 服务端实际收到的字节数 |
| `sha256` | 服务端实际收到的字节的 SHA-256（小写十六进制） |
| `public` | 布尔值，是否公开上传；脚本要求它与请求一致，否则视为协议错误 |
| `oss_key` | 成功时的对象键，只用于追踪 |
| `oss_url` | 成功时的对象稳定地址。私有对象不是匿名下载授权；公开对象可被匿名读取 |
| `failure_code` | 失败原因码 |
| `failure_message` | 失败说明；超时时为“上传超时”，其他情况可为 null |

- `oss_key`、`oss_url` 只在 `succeeded` 时有值；`failure_code` 只在 `failed` 时有值。
- `failure_code`：`upload_timeout` 传到存储时网络超时（读写超时 30 分钟），或受理后 30 分钟执行期限内没有完成（服务重启等）；`storage_upload_failed` 其他存储失败。两者都不会再变成成功。脚本对已知码给固定中文提示，不回显服务端的自由文本。
- 上传记录保留 24 小时，过期或不属于本人时 status 返回 404。
- 成功前服务端会核对存储中的对象大小；脚本另外比对 submit 返回的 `size_bytes`、`sha256` 与本地文件。
- 服务端重启不续传，`uploading` 的记录会在期限后变成 `upload_timeout`。

## 费用字段

`meta.credits_consumed`、`billing_status`、`billing_operation_id` 为 null，表示没有结算回执，不代表免费。上传不扣分析费用，存储成本另计，Skill 不估算。

## 错误与恢复

`error.code` 是 HTTP 状态乘 100 加 1。客户端诊断只输出类别、HTTP 状态和 code、受控的 `reason`、`request_id`、合法的 `Retry-After`，以及结果是否未知；不输出本地路径、Key 或异常堆栈。

| HTTP | `reason` | 处理 |
| --- | --- | --- |
| 401 | | Key 缺失或失效 |
| 403 | | scope 或权限不允许，停止，不换 Key |
| 404 | `upload_not_found` | 记录不存在、不属于本人或已过期 |
| 413 | `file_too_large` | 文件超过分类上限 |
| 413 | `payload_too_large` | 整个请求体超过服务端上限 |
| 415 | `unsupported_file_type` | 扩展名不在允许列表 |
| 422 | `invalid_filename`、`empty_file`、`invalid_multipart`，或字段级说明 | 修正后再传 |
| 429 | `upload_capacity_exceeded` | 服务端每个进程最多同时处理 4 个上传，按 `Retry-After` 等待 |
| 500 | | 内部错误，保留 `request_id` |
| 503 | `upload_storage_unavailable`、`upload_status_unavailable` | 暂存或状态服务不可用 |

**submit 结果未知**（超时、断连、5xx、无效响应）：服务端可能已经受理，但没有 `upload_id` 就无法查询，也没有列表接口。不自动重传；告诉用户，由用户决定是否重新上传，重新上传会生成新的对象。

**完整性不一致**（`kind: "integrity"`）：服务端收到的大小或摘要与本地文件不同，通常是文件在上传过程中被修改。不要使用这次结果，确认文件后重新上传。
