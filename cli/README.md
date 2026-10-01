# dsh-imagegen CLI（`gen.mjs`）—— 绕过 DSH 协议限制，直接用中转站出图

`gen.mjs` 是这个仓库的命令行入口，只依赖 Node（无第三方包）。插件里已经有的功能它都有，插件里**还没做**的图生图 / 视频也在它这儿。

## 问题（为什么需要它）

`~/.dsh/profiles/desktop/cordis.patch.yml` 里 guaihub 是这样配的：

```yaml
- id: llm-pi-ai
  config:
    providers:
      guaihub:
        api: anthropic-messages      # ← 聊天协议
        baseURL: https://guaihub.com
        models: [ ..., gpt-image-2, gpt-image-2.5-flare, grok-imagine-video, ... ]
```

所有模型（包括图片/视频模型）都被声明成了**聊天模型**，DSH 用 Anthropic Messages 协议去请求。
图片模型不是聊天模型，它的产出是图片文件，不是 message content —— 所以选 `gpt-image-2.5-flare`
当 agent 模型只会得到一段文字，永远出不了图。这跟中转站没关系，是**协议层不匹配**。

## 结论：中转站是 New API 面板，出图根本不需要 DSH 支持

实测 guaihub.com 是 [New API](https://github.com/Calcium-Ion/new-api) 搭的（首页 title 就是 `New API`），
它同时挂着多套官方协议的兼容端点，聊天走 `anthropic-messages`，出图走 OpenAI 那套：

| 端点 | 方法 | 作用 | 实测结果 |
|---|---|---|---|
| `/v1/models` | GET | 模型列表 | 200，共 72 个模型 |
| `/v1/images/generations` | POST | 文生图（OpenAI 格式） | ✅ 成功出图 |
| `/v1/images/edits` | POST | 图生图 / 编辑（multipart） | 路由存在 |
| `/v1/video/generations` | POST | 提交视频任务 | 路由存在 |
| `/v1/video/generations/{id}` | GET | 轮询视频任务 | 路由存在（返回 `task_not_exist`） |
| `/mj/submit/imagine` | POST | Midjourney | 路由存在，但 `mj_imagine` 分组无渠道 |

也就是说：**Studio 只是个前端，后端就是这些接口**。Studio 能做的，脚本都能做。
（跟 DSH 插件的关系：插件走同一套接口，只是把结果直接渲染进对话。两边都改同一个 `~/.dsh/.credentials.yaml` 里的密钥。）

## 用法

```powershell
$cli = "~/dsh/dsh-imagegen/cli/gen.mjs"   # 换成你本地的 clone 路径

# 文生图
node $cli --prompt "一只赛博朋克猫，霓虹雨夜" --out images/cat.png

# 换模型 / 尺寸 / 张数
node $cli -m gpt-image-2 -s 1024x1536 -n 2 -p "..."

# 图生图（multipart 上传本地图片）
node $cli --edit in.png -p "把背景换成海边"

# 视频（提交任务后自动轮询并下载）
node $cli --video -m video-ds-2.0 -p "..." --out out.mp4

# 看中转站有哪些模型
node $cli --list

# 调试：打印原始 JSON
node $cli -p "..." --raw
```

参数一览：`-p/--prompt`、`-m/--model`（默认 `gpt-image-2`）、`-s/--size`（默认 `1024x1024`）、`--n`、
`-o/--out`、`--quality`、`--background`、`--extra '<json>'`、`--raw`、`--list`、`--timeout`、
`--video`、`--edit`、`--poll`（默认 5000ms）、`--max-wait`（默认 900000ms）。

密钥读取顺序：`$env:GUAIHUB_API_KEY` → `~/.dsh/.credentials.yaml` 里的 `refs.GUAIHUB_API_KEY`。
换站改 `$env:GUAIHUB_BASE_URL` 即可（默认 `https://guaihub.com`）。

## 已验证

- `gpt-image-2` + `1024x1024` → `test-apple.png`，1948.7 KB，PNG 1370×1148 RGB（模型自己决定了实际尺寸）；该图现在放在 `~/dsh/images/test-apple.png`。
- 视频链路只验证了路由存在，没跑完整流程（会产生实际费用）。

## 可选的下一步

1. ~~**做成 DSH 插件工具**~~ ✅ 已做：`~/dsh/dsh-imagegen`（工具 `generate_image` / `list_image_models`，已装进 desktop profile 并热加载成功）。
2. **清理模型列表**：把 `gpt-image-*` / `grok-imagine-*` / `video-*` 从 `llm-pi-ai` 的聊天模型列表里挪走，
   避免误选成 agent 模型（目前仍然存在，误选只会得到文字）。
3. 把这里已经跑通的图生图 / 视频轮询也包成插件工具（插件里还没做）。
