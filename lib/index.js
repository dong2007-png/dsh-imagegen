/**
 * dsh-imagegen — 用 New API 中转站（guaihub 等）生成图片，并把图片直接显示在对话里。
 *
 * 为什么需要它：DSH 的模型走 anthropic-messages 聊天协议，把 gpt-image-2 之类当聊天模型
 * 选进去只会得到文字。中转站本身有 OpenAI 风格的 POST /v1/images/generations，
 * 这个插件直接打那个接口，并把结果存成附件显示在工具卡片里。
 *
 * 配置项见 Config（可在 DSH 的插件配置界面 / cordis.patch.yml 里改）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

export const name = 'dsh-imagegen'

/** 硬依赖：这些服务由 DSH 核心提供，缺一个就不加载。 */
export const inject = ['tools', 'attachments', 'credentials']

export const Config = z.object({
  baseURL: z.string().default('https://guaihub.com'),
  apiKeyEnv: z.string().default('GUAIHUB_API_KEY'),
  defaultModel: z.string().default('gpt-image-2'),
  defaultSize: z.string().default('1024x1024'),
  outputDir: z.string().default('images'),
  saveFiles: z.boolean().default(true),
  timeoutMs: z.number().default(300000),
})

const DEFAULTS = {
  baseURL: 'https://guaihub.com',
  apiKeyEnv: 'GUAIHUB_API_KEY',
  defaultModel: 'gpt-image-2',
  defaultSize: '1024x1024',
  outputDir: 'images',
  saveFiles: true,
  timeoutMs: 300000,
}

const IMAGE_MODEL_HINT =
  /(gpt-image|dall-?e|flux|seedream|seededit|qwen-image|image-generation|gemini-[0-9.]*-?(pro|flash)-image|grok-imagine-image|nano-?banana|kolors|ideogram|midjourney|imagen|stable-diffusion|sdxl|recraft|hidream|janus)/i

/* ------------------------------ 工具函数 ------------------------------ */

function configOf(config) {
  const merged = { ...DEFAULTS }
  if (config !== null && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== null) merged[key] = value
    }
  }
  return merged
}

/** 密钥：先问 credentials 服务（ref 就是环境变量名），再退到进程 env / ~/.dsh/.credentials.yaml。 */
async function resolveApiKey(ctx, cfg) {
  const ref = String(cfg.apiKeyEnv)
  try {
    const resolved = await ctx.credentials.resolve(ref)
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
  } catch {
    /* 服务不可用时走下面的回退 */
  }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const text = readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = text.match(new RegExp(`^\\s*${ref}:\\s*(\\S+)\\s*$`, 'mu'))
    if (match !== null) return match[1]
  } catch {
    /* 文件不存在 */
  }
  throw new Error(`找不到密钥 ${ref}（credentials 服务、环境变量、~/.dsh/.credentials.yaml 里都没有）`)
}

async function request(ctx, cfg, pathname, { method = 'POST', body, signal } = {}) {
  const base = String(cfg.baseURL).replace(/\/+$/u, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || DEFAULTS.timeoutMs)
  const relay = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', relay, { once: true })
  }
  try {
    const key = await resolveApiKey(ctx, cfg)
    const response = await fetch(base + pathname, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    if (!response.ok) {
      const message = json?.error?.message ?? json?.message ?? text.slice(0, 500)
      throw new Error(`HTTP ${response.status} ${pathname}: ${message}`)
    }
    return json ?? text
  } catch (error) {
    if (controller.signal.aborted && signal?.aborted !== true) {
      throw new Error(`请求超时（${String(cfg.timeoutMs)}ms）：${pathname}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', relay)
  }
}

function detectMediaType(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const head = String.fromCharCode(...data.subarray(0, 6))
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12) {
    const riff = String.fromCharCode(...data.subarray(0, 4))
    const webp = String.fromCharCode(...data.subarray(8, 12))
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return undefined
}

function extensionOf(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg'
  return mediaType.startsWith('image/') ? mediaType.slice(6) : 'png'
}

function sessionCwd(exec) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd ?? session?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
}

/** 把图片落盘；save_path 是文件就按文件写，是目录（或没给）就在目录里按时间戳命名。 */
async function saveImageFile(cfg, cwd, savePath, name, data) {
  let target
  if (typeof savePath === 'string' && savePath.trim() !== '') {
    const raw = savePath.trim()
    const resolved = path.resolve(cwd, raw)
    target = path.extname(resolved) === '' ? path.join(resolved, name) : resolved
  } else {
    target = path.resolve(cwd, String(cfg.outputDir ?? DEFAULTS.outputDir), name)
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, data)
  return target
}

/* ------------------------------ 工具定义 ------------------------------ */

function listModelsTool(ctx, cfg) {
  return defineTool({
    name: 'list_image_models',
    description:
      '列出中转站上可用的图片模型（从 GET /v1/models 里按名称过滤）。生成图片前如果想确认模型名，先调这个。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          image_models: { type: 'array', items: { type: 'string' }, required: true },
          hint: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.image_models.length === 0
              ? `中转站共 ${String(value.total)} 个模型，没认出图片模型。${value.hint}`
              : `可用图片模型（共 ${String(value.image_models.length)} 个，中转站共 ${String(value.total)} 个）：\n${value.image_models.join('\n')}\n${value.hint}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const data = await request(ctx, cfg, '/v1/models', { method: 'GET', signal: exec.signal })
      const ids = (data?.data ?? []).map((item) => (typeof item === 'string' ? item : item?.id)).filter((id) => typeof id === 'string')
      const imageModels = ids.filter((id) => IMAGE_MODEL_HINT.test(id)).sort()
      return {
        total: ids.length,
        image_models: imageModels,
        hint: `生成图片用 generate_image，model 传上面任意一个；默认 ${String(cfg.defaultModel)}。`,
      }
    },
  })
}

function generateImageTool(ctx, cfg) {
  return defineTool({
    name: 'generate_image',
    description:
      '用文字描述生成图片（走中转站的 OpenAI 风格 /v1/images/generations），图片会直接显示在对话里，并可选保存到工作区。适用于：画图、配图、生成海报/图标/插画。prompt 要写具体（主体、风格、构图、光线）。不要用它生成文字回答。',
    parameters: {
      prompt: { type: 'string', required: true, description: '图片描述，越具体越好。' },
      model: { type: 'string', description: `图片模型名，默认 ${DEFAULTS.defaultModel}；不确定就先调 list_image_models。` },
      size: { type: 'string', description: `尺寸，如 1024x1024 / 1024x1536 / 1536x1024，默认 ${DEFAULTS.defaultSize}。` },
      n: { type: 'integer', description: '生成张数，默认 1。' },
      quality: { type: 'string', description: '可选，如 high / medium / low（部分模型支持）。' },
      background: { type: 'string', description: '可选，如 transparent / opaque（部分模型支持）。' },
      save_path: { type: 'string', description: '可选：保存到哪个文件或目录（相对工作目录或绝对路径）。不传则存到配置的 outputDir。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          size: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string' },
                mediaType: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                attachmentId: { type: 'string', required: true },
                revised_prompt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.images.map((image, index) => {
          const where = image.path === undefined ? '' : ` → ${image.path}`
          const revised = image.revised_prompt === undefined ? '' : `\n   revised_prompt: ${image.revised_prompt}`
          return `${String(index + 1)}. ${image.name}  ${String(image.width)}x${String(image.height)}  ${(image.bytes / 1024).toFixed(1)} KB${where}${revised}`
        })
        return [
          {
            type: 'text',
            text: `已生成 ${String(value.count)} 张图片（${value.model} / ${value.size}）：\n${lines.join('\n')}`,
          },
          ...value.images.map((image) => ({
            type: 'image',
            attachment: {
              attachmentId: AttachmentId(image.attachmentId),
              mediaType: image.mediaType,
              width: image.width,
              height: image.height,
              bytes: image.bytes,
              name: image.name,
            },
          })),
        ]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('prompt 不能为空')
      const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : String(cfg.defaultModel)
      const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : String(cfg.defaultSize)
      const count = Number.isSafeInteger(args.n) && args.n > 0 ? args.n : 1

      const limits = ctx.attachments.imageLimits
      if (count > limits.maxImagesPerMessage) {
        throw new Error(`一次最多生成 ${String(limits.maxImagesPerMessage)} 张（本部署限制）`)
      }

      const payload = { model, prompt, n: count, size }
      if (typeof args.quality === 'string' && args.quality.trim() !== '') payload.quality = args.quality.trim()
      if (typeof args.background === 'string' && args.background.trim() !== '') payload.background = args.background.trim()

      const result = await request(ctx, cfg, '/v1/images/generations', { body: payload, signal: exec.signal })
      const items = Array.isArray(result?.data) ? result.data : []
      if (items.length === 0) {
        throw new Error(`接口没返回图片：${JSON.stringify(result).slice(0, 600)}`)
      }

      const cwd = sessionCwd(exec)
      const stamp = timestamp()
      const images = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        let bytes
        if (typeof item?.b64_json === 'string') {
          bytes = Buffer.from(item.b64_json, 'base64')
        } else if (typeof item?.url === 'string') {
          const download = await fetch(item.url, { signal: exec.signal })
          if (!download.ok) throw new Error(`下载图片失败 HTTP ${String(download.status)}: ${item.url}`)
          bytes = Buffer.from(await download.arrayBuffer())
        } else {
          continue
        }
        const data = new Uint8Array(bytes)
        const mediaType = detectMediaType(data)
        if (mediaType === undefined) throw new Error('返回的数据不是 PNG/JPEG/WebP 图片')
        if (!limits.mediaTypes.includes(mediaType)) throw new Error(`${mediaType} 图片在本部署被禁用`)
        if (data.byteLength > limits.maxImageBytes) {
          throw new Error(`图片 ${(data.byteLength / 1024 / 1024).toFixed(1)} MB 超过本部署上限`)
        }
        const fallbackName = `imagegen-${model.replace(/[^\w.-]/gu, '_')}-${stamp}${items.length > 1 ? `-${String(index + 1)}` : ''}.${extensionOf(mediaType)}`
        const ref = await ctx.attachments.saveImage({ data, mediaType, name: fallbackName })
        if (ref.width * ref.height > limits.maxImagePixels) throw new Error('图片超过本部署的像素上限')

        let saved
        if (cfg.saveFiles !== false) {
          saved = await saveImageFile(cfg, cwd, args.save_path, ref.name ?? fallbackName, bytes)
        }
        images.push({
          name: ref.name ?? fallbackName,
          ...(saved === undefined ? {} : { path: saved }),
          mediaType: ref.mediaType ?? mediaType,
          width: ref.width,
          height: ref.height,
          bytes: ref.bytes ?? data.byteLength,
          attachmentId: ref.attachmentId,
          ...(typeof item.revised_prompt === 'string' ? { revised_prompt: item.revised_prompt } : {}),
        })
      }
      if (images.length === 0) throw new Error(`接口返回的数据里没有可用的图片：${JSON.stringify(result).slice(0, 600)}`)
      return { model, size, count: images.length, images }
    },
  })
}

/* ------------------------------ 插件入口 ------------------------------ */

export function apply(ctx, config = {}) {
  const cfg = configOf(config)
  ctx.tools.register(generateImageTool(ctx, cfg))
  ctx.tools.register(listModelsTool(ctx, cfg))
}
