# 邮箱查找契约

邮箱查找五个操作的完整字段约束、响应结构、枚举和错误处理。日常调用方式和流程见 [邮箱查找子 Skill](../tools/creator-email-lookup/SKILL.md)。

## 目录

- [端点与调用](#端点与调用)
- [preview / create 请求](#preview--create-请求)
- [get / items / list 请求](#get--items--list-请求)
- [响应对象](#响应对象)
- [账号输入解析](#账号输入解析)
- [原因码](#原因码)
- [费用字段](#费用字段)
- [错误与恢复](#错误与恢复)

## 端点与调用

以下路径在 `{SCOUT_API_BASE_URL}/openapi` 下，均为 POST JSON，均要求 `email-lookup` scope。服务端另外校验 Key、scope 策略、Scout Find Email 权限和批次归属。旧 Key 需要显式授权新 scope。

| 后缀 `/v1/creator-email-lookup/batches/` | 脚本 | 成功 HTTP | `data` |
| --- | --- | --- | --- |
| preview | `scripts/email_lookup_preview.mjs` | 200 | `summary`、`rows`、`can_submit` |
| create | `scripts/email_lookup_create.mjs` | 202 | 批次对象本身 |
| get | `scripts/email_lookup_get.mjs` | 200 | `batch`、`input_columns`、`input_view_counts` |
| items | `scripts/email_lookup_items.mjs` | 200 | `items`、`total`、`page`、`page_size` |
| list | `scripts/email_lookup_list.mjs` | 200 | `items`、`total`、`page`、`page_size` |

从包根目录调用，传单个 JSON 参数，或 `--input-file <本地 JSON 路径>`（UTF-8，可带 BOM）。Windows PowerShell 5.1 会破坏内联 JSON 的引号，使用文件形式。

```bash
node scripts/email_lookup_preview.mjs --input-file local-requests/preview.json
node scripts/email_lookup_get.mjs --input-file local-requests/get.json
```

请求文件放在包根目录下的 `local-requests/`（已被 `.gitignore` 忽略）。

请求和响应使用同一个 JSON 外壳 `success` / `data` / `error` / `meta`。`meta` 在 items 和 list 里另含 `page`、`size`、`total`。

## preview / create 请求

仅支持 `input_source="paste"` 的结构化 JSON。未知字段会被拒绝。

```json
{
  "input_source": "paste",
  "input": {
    "columns": ["account"],
    "mapping": { "identifier_column": 0 },
    "rows": [{ "source_row_number": 1, "cells": ["@demo"] }]
  },
  "default_platform": "youtube"
}
```

| 字段 | 类型与约束 |
| --- | --- |
| `input_source` | 必填，固定 `paste` |
| `input` | 必填对象，`columns`、`mapping`、`rows` 必填 |
| `input.columns` | 1 到 50 个字符串，每个最多 128 字符 |
| `input.mapping` | `identifier_column` 必填，`platform_column` 可省略或 null。序号从 0 起，在列范围内，两者不同 |
| `input.rows` | 1 到 200 行，每行只有 `source_row_number` 和 `cells` |
| `source_row_number` | 正整数，严格递增，不重复 |
| `cells` | 1 到 50 个字符串，不超过声明的列数，每格最多 2048 字符。短行由服务端补齐 |
| `input.filename`、`input.sheet_name` | 可省略或 null，最多 255 和 128 字符。只是输入来源的元数据，不会触发文件上传 |
| `default_platform` | 可省略或 null。取值 `tiktok`、`instagram`、`youtube`、`twitter`，去首尾空白、转小写，`x` 归为 `twitter` |

请求体序列化后不超过 1 MiB。不接受无效 Unicode，也不接受码点小于 32 的控制字符（TAB、CR、LF 除外）。全空白行由服务端忽略，非法行和重复行保留。

create 在此基础上增加下面的字段，preview 不接受它们：

| 字段 | 约束与默认 |
| --- | --- |
| `idempotency_key` | 必填，UUID 字符串 |
| `name` | 可省略或 null，最多 80 字符，去首尾空白，空白转 null。缺省时服务端生成“邮箱查询 日期 时间”（UTC） |
| `skip_invalid_rows` | boolean，默认 false |
| `enable_external_lookup` | boolean，默认 true |

不传 JWT、`user_id`、`team_id`、`campaign_id`，也不增加 provider、retry 之类的字段。

## get / items / list 请求

get 只接受必填的 `batch_id`（UUID）。

items：

| 字段 | 默认与限制 |
| --- | --- |
| `batch_id` | 必填，UUID |
| `view` | `all`。可选 `all`、`found`、`not_found`、`error`、`issues` |
| `platform` | null。平台枚举及别名同上 |
| `q` | 空字符串，最多 200 字符 |
| `page`、`page_size` | 1 和 50。正整数，`page_size` ≤ 100 |

`view=issues` 返回非法行和重复行。`q` 不区分大小写，匹配原单元格、主页链接、邮箱、用户名和账号 ID。`platform` 按规范化后的平台过滤。

list：

| 字段 | 默认与限制 |
| --- | --- |
| `page`、`page_size` | 1 和 20。正整数，`page_size` ≤ 50 |
| `q` | 空字符串，最多 80 字符 |
| `status` | 可省略或 null。`pending`、`running`、`completed`、`failed` |
| `outcome` | 可省略或 null。`success`、`partial`、`failed` |
| `platform` | 可省略或 null。平台枚举及别名同上 |
| `created_from`、`created_to` | 可省略或 null。带时区的 ISO 8601，起点早于终点，包含起点、不含终点 |
| `submission_key` | 可省略或 null。创建时用的 UUID。存在时 `page` 必须为 1，可传 `page_size`，不能和非空的 `q`、`status`、`outcome`、`platform`、时间范围混用 |

## 响应对象

只有一层 `success` / `data` / `error` / `meta`。成功时 `error` 为 null，失败时 `data` 为 null。保留完整的成功外壳，不丢弃未知的 `meta` 字段。create 的 `data` 是批次对象本身，get 才有 `data.batch`。

**批次对象**

`batch_id`、`name`、`input_source`（历史批次可为 `paste`、`file`、`legacy`）、`platforms`、`status`、`outcome`、`has_skipped`、`latest_attempt_no`（从 0 起）、`created_at`、`updated_at`、`input_stats`、`lookup_stats`。时间带时区，原样保留。

- `status`：`pending`、`running`、`completed`、`failed`。
- `outcome`：`success`、`partial`、`failed`，运行中为 null。它描述唯一执行项，不保证每行都有邮箱。
- `input_stats`：`input_count`、`valid_row_count`、`invalid_row_count`、`duplicate_row_count`、`unique_count`。有效行包含重复行，空白行不计。
- `lookup_stats`：`unique_count`、`pending`、`running`、`found`、`not_found`、`skipped`、`error`、`processed_count`、`retryable_count`。这是唯一执行项的计数，和输入行计数分开解释。

**preview.rows[]**

`input_index`（从 0 起）、`source_row_number`（从 1 起）、`cells`（按声明列补齐）、`validation_status`（`valid` / `invalid`）、`error_code`、`normalized_ref`、`normalized_profile_url`、`duplicate_of_input_index`。`can_submit` 只表示至少有一个有效对象。

**get**

`input_view_counts` 包含 `all`、`found`、`not_found`、`error`、`issues` 五个视图的行数，可含重复行。

**items.items[]**

`input_index`、`source_row_number`、`original_cells`、`normalized_ref`、`profile_url`、`validation`、`validation_error`、`duplicate_of_input_index`、`result`。`result` 为 null 表示暂无结果，或该行输入非法。

**result**

- `status`：`pending`、`running`、`found`、`not_found`、`skipped`、`error`。
- `email`：只有 `found` 才有。
- `source`：`stored`、`cache`、`external`、`none`。
- `checked_at`、`expires_at`、`error_code`、`skip_reason`：可为 null。
- `retryable`：boolean。

`normalized_ref` 含 `platform`、`creator_id`、`username`、`profile_url`，其中未用到的为 null。

## 账号输入解析

由服务端完成，客户端不推断。规则如下：

- 账号单元格可以是 `@handle`、handle、主页链接，或 YouTube 频道 ID（`UC` 加 22 位，共 24 位）。
- 判断为链接的条件：含 `scheme:`、含 `/`、含 `.com`，或以 `youtu.be` 开头。链接缺少 `https://` 时会补上。
- 平台来源：平台单元格优先，其次是 `default_platform`。链接和频道 ID 自带平台。平台单元格与链接的平台不一致时报 `platform_conflict`。
- 可识别的主页链接：
  - TikTok：`tiktok.com/@name`，或 `tiktok.com/@name/video/<数字>`。
  - Instagram：`instagram.com/name`。`p`、`reel`、`reels`、`stories`、`explore`、`accounts`、`direct`、`tv` 不是账号名。
  - X / Twitter：`x.com/name`、`twitter.com/name`。账号名只含字母数字下划线，1 到 15 位，不能是 `home`、`explore`、`search` 等保留名。
  - YouTube：`youtube.com/@name`，或 `youtube.com/channel/UC…`。后面可跟 `videos`、`shorts`、`streams`、`playlists`、`community`、`about`、`featured` 之一。
- 只接受各平台的固定域名：TikTok（`tiktok.com`、`www.`、`m.`）、Instagram（`instagram.com`、`www.`）、YouTube（`youtube.com`、`www.`、`m.`）、X（`x.com`、`www.`、`mobile.`）、Twitter（`twitter.com`、`www.`、`mobile.`）。其他域名报 `unsupported_platform`。
- 短链 `vm.tiktok.com`、`vt.tiktok.com`、`youtu.be` 报 `profile_required`。
- 用户名转小写。YouTube 频道 ID 保持原样。重复判断按规范化后的平台加账号。

## 原因码

服务端把内部原因映射为下面的受控集合，未知的原因回退为统一值，不透出供应商细节。按名称含义展示，不推断更多。

**`validation_error` / preview 的 `error_code`**（回退 `invalid_input`）

| 值 | 含义 |
| --- | --- |
| `identifier_required` | 账号单元格为空 |
| `unsupported_platform` | 平台取值或链接域名不受支持 |
| `invalid_url` | 链接格式不合法 |
| `platform_conflict` | 平台单元格与链接平台不一致 |
| `profile_required` | 不是主页链接：短链、Instagram 帖子和 Reels、YouTube 视频、X 帖子，或链接里缺少账号名。TikTok 视频链接不在此列，会解析为作者账号 |
| `platform_required` | 纯 handle 且没有平台来源 |
| `invalid_username` | 账号名含不允许的字符，或不符合平台规则 |

**`result.error_code`**（回退 `lookup_failed`）

包含上表全部取值，另有：

| 类别 | 值 |
| --- | --- |
| 身份与数据源 | `identity_unresolved`、`warehouse_unavailable`、`cache_unavailable`、`permission_unavailable` |
| 执行 | `lookup_in_progress`、`lookup_prior_attempt`、`deadline_exceeded`、`lookup_execution_error` |
| 外部查找 | `provider_timeout`、`provider_http_error`、`provider_invalid_request`、`provider_business_error`、`provider_invalid_response`、`provider_result_mismatch`、`provider_item_error`、`provider_invalid_email` |

`cache_unavailable` 表示服务端读取共享缓存失败，`retryable` 为 true。它是服务端运行时问题，与账号本身无关，批次里所有有效对象都可能因此变成 `error`。

`deadline_exceeded` 表示批次到期时该对象仍未完成，此时 `retryable` 为 true。到期前已从已有数据或缓存取得的 `found` / `not_found` 结果会保留。

**`result.skip_reason`**（回退 `lookup_skipped`）

| 值 | 含义 |
| --- | --- |
| `external_lookup_disabled` | 外部查找已关闭，且已有数据和缓存都没有结果 |
| `permission_denied` | 权限不足 |
| `target_inactive` | 查找对象不处于可用状态 |

**`result.source`**：`stored`（已有数据）、`cache`（缓存，含已缓存的未找到）、`external`（外部查找）、`none`。

## 费用字段

邮箱查找没有接入 Scout 积分结算：`meta.credits_consumed`、`billing_status`、`billing_operation_id` 均为 null。兼容字段 `billable_units=0`、`credits_remaining=-1`、`quota_remaining=-1` 不能解释为免费或无限额。不要用 `total`、`processed_count` 等推算费用。

## 错误与恢复

失败返回真实的非 2xx 状态，`error.code` 等于 HTTP 状态乘 100 再加 1（例如 422 对应 42201），`error.message` 是安全的原因。客户端诊断只输出类别、HTTP 状态和 code、有限的业务 `reason`、`request_id`、合法的 `Retry-After`，以及结果是否未知。不输出原始响应、账号、邮箱、Key 或异常堆栈。

| HTTP | 常见 `reason` | 处理 |
| --- | --- | --- |
| 401 / 403 | `tool_permission_denied` | 核对 Key、`email-lookup` scope、服务端策略、Find Email 权限和归属。停止，不换身份或接口 |
| 404 | `batch_not_found` | 批次不存在或不属于当前用户，不要猜测其他 ID |
| 409 | `idempotency_conflict` | 该键已用于不同的请求。保留原键，不换键重发 |
| 413 | `payload_too_large` | 缩小请求体 |
| 422 | `all_inputs_invalid`、`invalid_rows_unconfirmed`；字段校验失败时 `message` 是字段级描述，不是固定的 reason | 修正输入。`invalid_rows_unconfirmed` 需要用户选择修正或确认跳过非法行 |
| 429 | | 按有效的 `Retry-After` 提示等待，不自动重试，不编造等待时间 |
| 500 / 503、断连、超时、无效响应 | `permission_unavailable`（503）等 | 创建结果可能未知。保留原键，按用户需要只读 list 的 `submission_key`，不自动重放 create |

空页、未找到、部分失败和批次失败，都按实际业务字段呈现。创建返回 202 后查 get 和 items，不把请求成功当作任务完成。
