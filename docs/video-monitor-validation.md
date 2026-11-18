# 视频监控 Skill 验证状态

记录 `influx-ai/tools/video-monitor` 的验证进度。本文件在仓库 `docs/` 下，不随安装包发布。request_id 只保留前 8 位和后 4 位。

最后更新：2026-11-13

## 结论

| 层面 | 状态 |
| --- | --- |
| 隔离协议测试 | 通过（133 项） |
| 真实 HTTP · 只读（list、不存在 ID 的 get） | **通过**（后端修复后重测） |
| 真实 HTTP · 已有监控的 get 与全部动作 | 未执行 |
| 真实采集 | 未执行 |

## 隔离测试

`node --test tests/video-monitor.test.mjs`，133 项全部通过，全程不调用真实网络。

| 覆盖项 | 状态 |
| --- | --- |
| 七个操作的路径、方法、`X-API-Key`、请求体原样发送、成功 HTTP 200 | 通过 |
| 不替服务端补默认值（期限、间隔、分页、days） | 通过 |
| `monitor_id` 十进制字符串：超过 2^53 与 int64 上限原样发送；JSON 数字、0、负数、超界被拒绝 | 通过 |
| 响应中的 `id` 为 JSON 数字时视为协议错误 | 通过 |
| 期限二选一：天数与日期互斥、日期必须带时区、天数不接受时区；deadline 必须显式选择期限 | 通过 |
| 单层 `success/data/error/meta`；第二层旧 CommonResult、非 JSON、状态码不符视为协议错误 | 通过 |
| `meta` 账务字段非 null 视为协议错误 | 通过 |
| 空快照：`snapshot=null`、`trend=[]`、窗口指标保持 null 不补 0 | 通过 |
| 动作只调用一次；list / get 不触发 register、trigger、status、deadline | 通过 |
| 409 `monitor_state_changed` 不自动覆盖；register 全部冲突（422）不重提 | 通过 |
| 动作类超时 / 断连 / 5xx 结果标为未知，不重发；只读操作超时标为 unavailable | 通过 |
| HTTP×100+1 错误码、受控 reason、429 Retry-After | 通过 |
| 脱敏：Key、视频链接、服务端自由文本、异常堆栈不进入错误输出 | 通过 |

变异验证：临时改坏三处（允许数字 ID、deadline 不要求选择期限、4xx 标为结果未知），测试分别抓到 6 项失败，之后已还原并重新全部通过。

## 真实 HTTP

环境：`http://127.0.0.1:8010/openapi`，测试身份 `zq340h8xqyh7`，专用 `video-monitor` Key。

### 第一轮：后端 500（已修复）

| 操作 | 请求 | 结果 | request_id |
| --- | --- | --- | --- |
| list | `{}` | HTTP 500，`50001` | `4f7e48c6…9ea` |
| get | 不存在的 ID | HTTP 500，`50001` | `eb1ab0fc…7f61` |
| list | `platform=youtube, page=1, page_size=5, days=7` | HTTP 500，`50001` | `49d857c4…e505` |
| list | `{}`（重试） | HTTP 500，`50001` | `fc8a22b2…3457` |

路由已加载、鉴权已通过，失败在 list 与 get 的共同路径上。已交后端排查。

### 第二轮：后端修复后重测（通过）

| 操作 | 请求 | 结果 | request_id |
| --- | --- | --- | --- |
| list | `{}` | HTTP 200，`total=1`，`meta.page/size/total=1/20/1`，账务 meta 均为 null | `10e67c92…2207` |
| list | `platform=youtube, page=1, page_size=5, days=7` | HTTP 200，`total=1`，`meta.size=5` | `7a5975d9…70f7` |
| get | `monitor_id` = int64 上限（不存在） | HTTP 404，`40401`，`reason=monitor_not_found` | `99d847e8…4e08` |

列表中的 1 条监控不是本轮建立的（推测为后端联调时建立）。只读取了字段类型，未输出视频链接、文案或达人资料。

**真实响应与文档的差异**（已补进 `references/video-monitor.md`）：

| 项目 | 实测 |
| --- | --- |
| `id` | 字符串，符合预期 |
| 额外字段 | `monitor_type`（`free_tools`）、`source`（`manual`）、`campaign_id`、`campaign_creator_id`（本条为 null）、顶层 `followers_cnt` |
| `creator_snapshot` 字段 | 与文档列出的 8 个字段一致 |
| `snapshot` | 结构与文档一致；`video_share_cnt`、`video_collect_cnt` 为 null，印证未知值不补 0 |
| `latest_run_status` | 有快照时为 `completed` |
| 时间格式 | 带微秒的 UTC，如 `YYYY-MM-DDTHH:MM:SS.ffffffZ` |

**需要后端确认**：`campaign_id`、`campaign_creator_id` 关联 Campaign 时是否以 JSON 数字返回。若是 BIGINT 数字，JavaScript 客户端会丢失精度，建议与 `id` 一样转为字符串。

本轮的 get 只针对不存在的 ID，没有可回填的达人快照，未写入任何数据。

### 第三轮：已有监控的 get 与真实注册（经用户确认）

范围：对已有监控 get 一次；用测试视频 register 一次（`track_days: 1`，未传 `interval_minutes`），再对新监控 get 一次。未执行 trigger、status、deadline、archive。

| 操作 | 结果 | request_id |
| --- | --- | --- |
| get 已有监控（id `36`） | HTTP 200。`status=active`，`latest_run_status=completed`，`has_tracking_data=true`；`trend` 4 天；`views_3d`、`engagement` 有值，`views_24h`、`views_7d` 为 null；`creator_snapshot` 调用前后都是 8 个字段，未观察到可见变化 | `0256dfbd…b717` |
| register 测试视频 | HTTP 200。`created` 1 条，新监控 id `42`（字符串），`skipped_urls` 为空；账务 meta 均为 null | `82a76075…a27d` |
| get 新监控（id `42`） | HTTP 200。`status=active`，`latest_run_status=collecting`，`has_tracking_data=false`，`snapshot=null`，`trend=[]`，四个窗口指标都是 null，`last_triggered_at=null` | `00cd3768…7b05` |
| list | `total` 从 1 变为 2 | `df52bda6…1573` |

**与文档不符：默认采集间隔是 1440 分钟，不是 120。**

- 未传 `interval_minutes` 时，新监控的 `interval_minutes` 为 `1440`。
- 当前后端源码 `application/video_monitor/contracts.py` 为 `DEFAULT_INTERVAL_MINUTES = 24 * 60`，ORM 列默认值也是 1440。对接文档和 Skill 文档写的是 120。
- 本监控 `track_days=1`、间隔 1440，`next_trigger_at`（截止后 30 分钟）晚于 `track_deadline`，所以到期前不会有第二次自动采集，只有首次采集。

其他确认：

- `id`、`created[].id` 均为字符串。
- 已有监控的 `track_deadline` 为 `…T15:59:59.999999Z`，即日期模式下 `Asia/Shanghai` 当地日末，与文档描述一致。
- 注册后立即读取时首次采集尚未完成（`collecting`），与“注册成功不等于采集完成”一致。
- 窗口指标在真实数据里会出现部分为 null、部分有值，印证不能补 0。

遗留：测试监控 id `42` 仍为 `active`，约 24 小时后到期自动停止。是否归档由用户决定。

## 未验证

| 项目 | 原因 |
| --- | --- |
| trigger、status、deadline、archive | 本轮不执行 |
| 首次采集完成与快照回流 | 已注册，需稍后再 get 监控 `42` 确认 |
| get 是否实际回填达人快照 | 已有监控调用前后字段数未变，未能观察到回填 |
| 409 `monitor_state_changed`、422 全部冲突、404 已归档的真实形态 | 需要真实动作 |
| `campaign_id` 非 null 时的类型 | 需要关联 Campaign 的监控 |

**处理**：按用户决定，以后端实际行为为准，Skill 文档、CLI 提醒、README、CHANGELOG 和测试中的默认间隔已全部改为 1440 分钟（24 小时）；后端未改动。另在 SKILL.md 的 Gotchas 和契约参考中补充：期限短于间隔时，到期前可能只有首次采集。

## 下一步

1. 稍后 get 监控 `42`，确认首次采集是否完成、快照是否回流。
2. 决定是否归档测试监控 `42`。
3. 建议后端同步更新对接文档中的默认间隔（目前仍写 120）。
