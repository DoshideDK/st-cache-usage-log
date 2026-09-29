# 缓存用量记录 (Cache Usage Log)

SillyTavern 第三方扩展：只记录每次生成返回的 usage —— 缓存创建 / 缓存读取 / 未缓存输入 / 命中率 / 推理 / 输出 / 费用。

| 字段 | 来源（Claude） |
|---|---|
| 总输入 | input + cache_creation + cache_read |
| 缓存创建 | `cache_creation_input_tokens`（附 5m / 1h 明细） |
| 未缓存输入 | `input_tokens` |
| 缓存读取 | `cache_read_input_tokens` |
| 缓存命中 | 缓存读取 / 总输入 |
| 推理 | `output_tokens_details.thinking_tokens` |
| 输出 | `output_tokens` |
| 费用 | `cost`（OpenRouter 等中转返回时才有） |

同时兼容 OpenAI 格式（`prompt_tokens_details.cached_tokens` 等）。

## 原理

包装前端 `window.fetch`，对 `/api/backends/chat-completions/generate` 的响应 `clone()` 一份后台解析，不影响酒馆本身的处理。

**请开启流式输出**：ST 后端对流式请求会把上游 SSE 原样转发（含 `message_start` / `message_delta` 里的 usage）；而非流式 Claude 请求会被后端重新包装，usage 被丢弃，此时只会记一条“无 usage”。

## 安装

扩展 → 安装扩展 → 填 `https://github.com/DoshideDK/st-cache-usage-log`；或者把本目录复制/软链到
`SillyTavern/public/scripts/extensions/third-party/st-cache-usage-log`（或 `data/<用户>/extensions/`）后刷新页面。

每条 AI 回复的按钮栏（编辑✏️按钮左侧）会常驻一个小徽章，如 `写0 读49.0k 未1.8k 96.4%`，鼠标悬停看完整明细。数据写在该消息的 `extra.cache_usage` 里，随聊天存档持久化，刷新/切换聊天/切换 swipe 都在。

设置面板在「扩展」页右侧栏：「缓存用量记录」。记录保存在扩展设置里，可设置保留条数、清空、导出 JSON。
