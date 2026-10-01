# dsh-imagegen

给 DSH 用的图片生成插件：直接调 **New API 中转站**（guaihub 等）的 OpenAI 风格接口出图，图片会显示在对话的工具卡片里，同时可以落盘到工作区。

## 为什么不是"选个图片模型当聊天模型"

DSH 里 `guaihub` provider 走的是 `api: anthropic-messages`（聊天协议），`gpt-image-2`、`gemini-3-pro-image-preview`、`grok-imagine-image` 这些被声明成聊天模型是出不来的，永远只回文字。
中转站本身有 `POST /v1/images/generations`，这个插件直接打那个接口，跟网页版 Studio 用的是同一套后端。

## 注册的工具

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文字生成图片（`prompt` / `model` / `size` / `n` / `quality` / `background` / `save_path`） |
| `list_image_models` | 从 `GET /v1/models` 里过滤出可用的图片模型名 |

默认模型 `gpt-image-2`，默认尺寸 `1024x1024`。

## 配置

宿主侧 Config（可在 DSH 的插件配置界面里改，或写进 profile 的 `cordis.patch.yml`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://guaihub.com` | 中转站地址 |
| `apiKeyEnv` | `GUAIHUB_API_KEY` | 密钥名；通过 DSH 的 credentials 服务解析（进程 env → provider 托管存储 → `.env`），失败再退回 `~/.dsh/.credentials.yaml` |
| `defaultModel` | `gpt-image-2` | 默认图片模型 |
| `defaultSize` | `1024x1024` | 默认尺寸 |
| `outputDir` | `images` | 落盘目录（相对会话工作目录） |
| `saveFiles` | `true` | 是否把图片写到磁盘 |
| `timeoutMs` | `300000` | 请求超时 |

`cordis.patch.yml` 覆盖示例：

```yaml
- id: dsh-imagegen
  config:
    defaultModel: gpt-image-2.5-flare
    outputDir: images/gen
```

## 安装（desktop profile —— 当前 DSH 实际在跑的 profile）

插件源码放在 `~/dsh/dsh-imagegen`，已用 DSH 自带的插件管理器装进 desktop profile：

```text
plugin_manager(action="install_bundle", target="file:<你本地的 clone 路径>/dsh-imagegen")
```

它会做三件事：写 `~/.dsh/profiles/desktop/package.json` 的依赖、把 `dsh-imagegen` 追加进 `dsh.profile.bundles`、把包实体放进 `~/.dsh/profiles/desktop/node_modules/dsh-imagegen`，并且**热加载**（无需重启，装完当次会话里 `generate_image` 就能用）。

注意 pnpm 对 `file:` 依赖是**复制**而不是软链，所以：

- 改完源码要同步：把 `~/dsh/dsh-imagegen` 重新 `install_bundle` 一次，或手动复制 `lib/index.js` 到 `~/.dsh/profiles/desktop/node_modules/dsh-imagegen/lib/index.js`；
- 工作区那份是源码，profile 里那份是运行副本，两边内容目前一致（已核对哈希）。

## 已验证 / 未做

- 已验证：插件热加载成功，`generate_image`、`list_image_models` 出现在宿主工具列表里；Config schema 已注册（`include:dsh-imagegen`，status `schema`，可在插件配置界面里改）。
- 已验证：真机出图两次 —— `gpt-image-2`，产物 `~/dsh/images/plugin-test-cat.png`（2081 KB）与 `~/dsh/images/imagegen-gpt-image-2-2026-10-01T06-33-00.png`（787 KB）；返回宽高是模型自定的 1254×1254。
- 未做：图生图（`/v1/images/edits`）与视频（`/v1/video/generations` + 轮询）尚未包装成工具；`gen.mjs` 里已经有可用实现。

## 注意

- 写盘用的是宿主进程里的 `node:fs`，不经过 DSH 的 fs 沙箱与文件版本观测。
- 密钥不要提交到仓库；本插件只按名字去 credentials 里取。
