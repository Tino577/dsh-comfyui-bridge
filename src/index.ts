/**
 * @dsh-external/comfyui-bridge — host 半区。
 * 向 DSH 注册 ComfyUI 工具：服务生命周期（start/stop/status）、文本生图、图生图（img2img）、模型列表。
 * 同时向 DSH webserver 注册 /comfyui-bridge/api/* 路由，供 client 面板轮询状态与启停按钮。
 * 服务进程由本插件 spawn（系统 Python 运行 main.py），fiber dispose 时回收。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, type WriteStream } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import z from 'schemastery'

export const name = '@dsh-external/comfyui-bridge'
export const inject = ['tools', 'webServer']

export interface Config {
  comfyDir: string
  python: string
  port: number
  host: string
  outputDir: string
  waitTimeoutMs: number
}

export const Config = z.object({
  comfyDir: z.string().default('F:/ComfyUI'),
  python: z.string().default('F:/python3.10/python.exe'),
  port: z.number().default(8188),
  host: z.string().default('127.0.0.1'),
  outputDir: z.string().default('F:/ComfyUI/output/dsh'),
  waitTimeoutMs: z.number().default(180000),
})

type WebServer = {
  register(opts: { kind: string; path: string; handler: (req: unknown, res: any) => void }): () => void
}

type AppContext = Context & {
  webServer: WebServer
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function apply(ctx: AppContext, config: Config): void {
  if (!existsSync(config.python)) {
    ctx.logger?.error?.(`[comfyui-bridge] python 不存在: ${config.python}`)
  }
  if (!existsSync(join(config.comfyDir, 'main.py'))) {
    ctx.logger?.error?.(`[comfyui-bridge] ComfyUI 目录缺少 main.py: ${config.comfyDir}`)
  }

  let proc: ChildProcess | null = null
  let startedAt = 0
  let logStream: WriteStream | null = null
  const base = `http://${config.host}:${config.port}`

  function fetchTimeout(path: string, ms: number, init?: RequestInit): Promise<Response> {
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => {
        ctrl.abort()
        reject(new Error(`请求超时: ${path}`))
      }, ms)
      fetch(base + path, { ...init, signal: ctrl.signal })
        .then((r) => { clearTimeout(t); resolve(r) })
        .catch((e) => { clearTimeout(t); reject(e) })
    })
  }

  async function ping(): Promise<boolean> {
    try {
      const res = await fetchTimeout('/system_stats', 3000)
      return res.ok
    } catch {
      return false
    }
  }

  async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetchTimeout(path, 15000, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`ComfyUI ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  function statusSync(): any {
    return {
      running: proc !== null && proc.exitCode === null,
      url: base,
      pid: proc?.pid ?? null,
      startedAt: startedAt || null,
    }
  }

  async function status(): Promise<any> {
    const s = statusSync()
    s.running = await ping()
    if (s.running) {
      try {
        const stats = await api('/system_stats')
        s.system = stats?.system ?? null
      } catch { /* 状态查询失败不致命 */ }
    }
    return s
  }

  async function start(port?: number): Promise<any> {
    if (await ping()) return await status()
    const args = [
      'main.py',
      '--port', String(port ?? config.port),
      '--listen', config.host,
      '--disable-auto-launch',
      // 允许 iframe（DSH 面板内 origin 可能为 null）加载前端资源，避免 CORS 拦截导致空白
      '--enable-cors-header',
    ]
    proc = spawn(config.python, args, {
      cwd: config.comfyDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    startedAt = Date.now()
    const logFile = join(config.comfyDir, 'output', 'dsh-comfyui.log')
    try { mkdirSync(join(config.comfyDir, 'output'), { recursive: true }) } catch { /* ignore */ }
    logStream = createWriteStream(logFile, { flags: 'a' })
    proc.stdout?.pipe(logStream)
    proc.stderr?.pipe(logStream)
    proc.on('exit', () => { proc = null })

    const deadline = Date.now() + config.waitTimeoutMs
    while (Date.now() < deadline) {
      if (await ping()) return await status()
      await sleep(1000)
    }
    throw new Error(`ComfyUI 启动超时（${config.waitTimeoutMs}ms），日志: ${logFile}`)
  }

  async function stop(): Promise<any> {
    const p = proc
    if (p && p.exitCode === null) {
      proc = null
      p.kill()
      await new Promise((r) => p.once('exit', r))
    }
    return await status()
  }

  function checkpoints(): string[] {
    const dir = join(config.comfyDir, 'models', 'checkpoints')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => /\.(safetensors|ckpt|pt)$/i.test(f))
  }

  interface BaseGenArgs {
    prompt: string
    negative?: string
    steps?: number
    cfg?: number
    seed?: number
    model?: string
    sampler?: string
    scheduler?: string
  }

  // ═══ workflow 构建 ═══
  function ckptNodes(model: string): Record<string, any> {
    return {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    }
  }

  function encodeNodes(prompt: string, negative: string): Record<string, any> {
    return {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    }
  }

  function samplerNode(a: { seed: number; steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise: number }, latentFrom: [string, number]): Record<string, any> {
    return {
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: a.seed, steps: a.steps ?? 20, cfg: a.cfg ?? 7,
          sampler_name: a.sampler ?? 'euler', scheduler: a.scheduler ?? 'normal', denoise: a.denoise,
          model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: latentFrom,
        },
      },
    }
  }

  function finishNodes(): Record<string, any> {
    return {
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh', images: ['8', 0] } },
    }
  }

  function buildText2Img(a: BaseGenArgs & { model: string; seed: number; negative: string; width: number; height: number }): Record<string, any> {
    return {
      ...ckptNodes(a.model),
      '5': { class_type: 'EmptyLatentImage', inputs: { width: a.width, height: a.height, batch_size: 1 } },
      ...encodeNodes(a.prompt, a.negative),
      ...samplerNode({ ...a, denoise: 1 }, ['5', 0]),
      ...finishNodes(),
    }
  }

  function buildImg2Img(a: BaseGenArgs & { model: string; seed: number; negative: string; imageName: string; denoise: number; width?: number; height?: number }): Record<string, any> {
    const nodes: Record<string, any> = {
      '1': { class_type: 'LoadImage', inputs: { image: a.imageName } },
      ...ckptNodes(a.model),
      ...encodeNodes(a.prompt, a.negative),
    }
    let pixelsFrom: [string, number] = ['1', 0]
    if (a.width && a.height) {
      nodes['10'] = {
        class_type: 'ImageScale',
        inputs: { image: ['1', 0], width: a.width, height: a.height, upscale_method: 'lanczos', crop: 'disabled' },
      }
      pixelsFrom = ['10', 0]
    }
    nodes['2'] = { class_type: 'VAEEncode', inputs: { pixels: pixelsFrom, vae: ['4', 2] } }
    return {
      ...nodes,
      ...samplerNode({ ...a, denoise: a.denoise }, ['2', 0]),
      ...finishNodes(),
    }
  }

  // ═══ workflow 提交 + 轮询 + 下载（t2i / i2i / i2v 共用）═══
  async function runWorkflow(workflow: Record<string, any>, signal?: AbortSignal, timeoutMs?: number): Promise<any> {
    const submitRes = await fetchTimeout('/prompt', 15000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'dsh-bridge-' + Date.now() }),
    })
    const submitJson: any = await submitRes.json().catch(() => null)
    if (!submitRes.ok) throw new Error('workflow 提交失败: ' + JSON.stringify(submitJson ?? (await submitRes.text()).slice(0, 300)))
    const promptId = submitJson?.prompt_id
    if (!promptId) throw new Error('响应缺少 prompt_id: ' + JSON.stringify(submitJson))

    const deadline = Date.now() + (timeoutMs ?? config.waitTimeoutMs)
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('生成已取消')
      const hist: any = await api(`/history/${promptId}`).catch(() => null)
      const entry: any = hist?.[promptId]
      if (entry) {
        if (entry.status?.status_str === 'error') {
          const msgs = entry.status?.messages ?? []
          throw new Error('执行错误: ' + JSON.stringify(msgs.slice(0, 3)))
        }
        const files: Array<{ filename: string; subfolder: string; type: string; kind: 'image' | 'video' }> = []
        const outputs: any = entry.outputs ?? {}
        for (const out of Object.values(outputs) as any[]) {
          for (const img of out?.images ?? []) files.push({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output', kind: 'image' })
          for (const g of out?.gifs ?? []) files.push({ filename: g.filename, subfolder: g.subfolder ?? '', type: g.type ?? 'output', kind: 'video' })
          for (const v of out?.videos ?? []) files.push({ filename: v.filename, subfolder: v.subfolder ?? '', type: v.type ?? 'output', kind: 'video' })
        }
        if (files.length > 0) {
          try { mkdirSync(config.outputDir, { recursive: true }) } catch { /* ignore */ }
          const images: any[] = []
          const videos: any[] = []
          for (const f of files) {
            const view = await fetchTimeout(
              `/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${encodeURIComponent(f.type)}`,
              60000,
            )
            if (!view.ok) continue
            const buf = Buffer.from(await view.arrayBuffer())
            const file = `${promptId}_${f.filename}`
            const path = join(config.outputDir, file)
            writeFileSync(path, buf)
            const item = {
              filename: f.filename,
              url: `${base}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${encodeURIComponent(f.type)}`,
              path,
            }
            if (f.kind === 'video') videos.push(item); else images.push(item)
          }
          return { prompt_id: promptId, status: 'success', images, videos }
        }
      }
      await sleep(1000)
    }
    throw new Error(`生成超时（${timeoutMs ?? config.waitTimeoutMs}ms），prompt_id=${promptId}`)
  }

  async function ensureModel(model?: string): Promise<string> {
    const m = model || checkpoints()[0]
    if (!m) throw new Error('models/checkpoints 目录为空，没有可用模型')
    return m
  }

  async function text2img(args: BaseGenArgs & { width?: number; height?: number }, signal?: AbortSignal): Promise<any> {
    if (!(await ping())) throw new Error('ComfyUI 服务未运行，请先调用 comfy_start 启动')
    const model = await ensureModel(args.model)
    const seed = args.seed ?? Math.floor(Math.random() * 0x7fffffff)
    const workflow = buildText2Img({
      prompt: args.prompt,
      negative: args.negative ?? '',
      width: args.width ?? 512,
      height: args.height ?? 512,
      steps: args.steps ?? 20,
      cfg: args.cfg ?? 7,
      sampler: args.sampler ?? 'euler',
      scheduler: args.scheduler ?? 'normal',
      model,
      seed,
    })
    const result = await runWorkflow(workflow, signal)
    return { ...result, model, seed }
  }

  // 把本地图片复制进 ComfyUI input 目录，返回可被 LoadImage 引用的文件名
  function stageInputImage(srcPath: string): string {
    if (!existsSync(srcPath)) throw new Error(`图片不存在: ${srcPath}`)
    const dir = join(config.comfyDir, 'input')
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    const name = `dsh_i2i_${Date.now()}_${basename(srcPath)}`
    copyFileSync(srcPath, join(dir, name))
    return name
  }

  async function img2img(args: BaseGenArgs & { image_path: string; denoise?: number; width?: number; height?: number }, signal?: AbortSignal): Promise<any> {
    if (!(await ping())) throw new Error('ComfyUI 服务未运行，请先调用 comfy_start 启动')
    const model = await ensureModel(args.model)
    const seed = args.seed ?? Math.floor(Math.random() * 0x7fffffff)
    const imageName = stageInputImage(args.image_path)
    const denoise = args.denoise ?? 0.65
    if (denoise <= 0 || denoise > 1) throw new Error('denoise 必须在 (0, 1] 区间')
    const workflow = buildImg2Img({
      prompt: args.prompt,
      negative: args.negative ?? '',
      steps: args.steps ?? 20,
      cfg: args.cfg ?? 7,
      sampler: args.sampler ?? 'euler',
      scheduler: args.scheduler ?? 'normal',
      model,
      seed,
      imageName,
      denoise,
      width: args.width,
      height: args.height,
    })
    const result = await runWorkflow(workflow, signal)
    return { ...result, model, seed, denoise, input_image: args.image_path }
  }

  // ═══ 工具注册 ═══
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_status',
    description: '查询本地 ComfyUI 服务状态（是否运行、访问地址、PID、系统统计）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute() {
      return await status()
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_start',
    description: '启动本地 ComfyUI 服务（幂等：已在运行则直接返回状态）。等待就绪后返回状态信息。',
    parameters: {
      port: { type: 'number', description: '端口（默认 8188）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      return await start(args.port)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_stop',
    description: '停止本插件启动的 ComfyUI 服务（不影响外部启动的实例）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute() {
      return await stop()
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_generate',
    description: '调用本地 ComfyUI 生成图片（SD1.5 风格 checkpoint，text2img）。等待执行完成并保存图片到本地，返回图片路径与 URL。',
    parameters: {
      prompt: { type: 'string', required: true, description: '正面提示词（英文效果最佳）' },
      negative: { type: 'string', description: '负面提示词（默认空）' },
      width: { type: 'number', description: '宽（默认 512）' },
      height: { type: 'number', description: '高（默认 512）' },
      steps: { type: 'number', description: '采样步数（默认 20）' },
      cfg: { type: 'number', description: 'CFG scale（默认 7）' },
      seed: { type: 'number', description: '随机种子（默认随机）' },
      model: { type: 'string', description: 'checkpoint 文件名（默认取 models/checkpoints 第一个模型）' },
      sampler: { type: 'string', description: '采样器名，如 euler/dpmpp_2m/uni_pc（默认 euler）' },
      scheduler: { type: 'string', description: '调度器，如 normal/karras/exponential（默认 normal）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return await text2img(args, exec.signal)
    },
    timeoutMs: 300000,
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_img2img',
    description: '调用本地 ComfyUI 图生图（img2img）：基于一张本地图片，按提示词重绘（denoise 控制改动幅度）。等待完成并保存结果图片到本地，返回图片路径与 URL。',
    parameters: {
      image_path: { type: 'string', required: true, description: '输入图片的本地绝对路径' },
      prompt: { type: 'string', required: true, description: '正面提示词（英文效果最佳）' },
      negative: { type: 'string', description: '负面提示词（默认空）' },
      denoise: { type: 'number', description: '重绘强度 (0,1]：越大改动越大（默认 0.65）' },
      width: { type: 'number', description: '输出宽（不填保持原图尺寸）' },
      height: { type: 'number', description: '输出高（不填保持原图尺寸）' },
      steps: { type: 'number', description: '采样步数（默认 20）' },
      cfg: { type: 'number', description: 'CFG scale（默认 7）' },
      seed: { type: 'number', description: '随机种子（默认随机）' },
      model: { type: 'string', description: 'checkpoint 文件名（默认取 models/checkpoints 第一个模型）' },
      sampler: { type: 'string', description: '采样器名（默认 euler）' },
      scheduler: { type: 'string', description: '调度器（默认 normal）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return await img2img(args, exec.signal)
    },
    timeoutMs: 300000,
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_list_models',
    description: '列出本地 ComfyUI models/checkpoints 目录中的可用模型文件（多模型切换：把模型放进该目录即可被识别，生成时用 model 参数选择）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute() {
      return { models: checkpoints(), dir: join(config.comfyDir, 'models', 'checkpoints') }
    },
  })))

  // ═══ Agent 画布编排工具 ═══
  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_canvas_state',
    description: '查看 Agent 画布当前状态（节点、连线、版本号）。Agent 编排画布时先调用它了解现状。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute() { return canvasSnapshot() },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_canvas_add_node',
    description: '向 Agent 画布添加节点。type 可选 t2i(文生图)/i2i(图生图)/t2v(文生视频)/i2v(图生视频)/upscale(放大)/output(输出)。',
    parameters: {
      type: { type: 'string', description: '节点类型：t2i/i2i/t2v/i2v/upscale/output' },
      prompt: { type: 'string', description: '提示词（生成类节点）' },
      negative: { type: 'string', description: '反向提示词' },
      width: { type: 'number', description: '宽' },
      height: { type: 'number', description: '高' },
      steps: { type: 'number', description: '步数' },
      cfg: { type: 'number', description: 'CFG' },
      seed: { type: 'number', description: '种子' },
      length: { type: 'number', description: '视频帧数（t2v/i2v）' },
      denoise: { type: 'number', description: '重绘强度（i2i）' },
      model: { type: 'string', description: 'checkpoint 文件名' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      const params: Record<string, any> = {}
      for (const k of ['prompt', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'length', 'denoise', 'model']) {
        if ((args as any)[k] !== undefined) params[k] = (args as any)[k]
      }
      return canvasOp({ type: 'add', node_type: args.type ?? 't2i', params })
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_canvas_connect',
    description: '在 Agent 画布中连接两个节点（source 节点输出 → target 节点输入）。先 comfy_canvas_state 获取节点 id。',
    parameters: {
      source: { type: 'string', required: true, description: '源节点 id' },
      target: { type: 'string', required: true, description: '目标节点 id' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) { return canvasOp({ type: 'connect', source: args.source, target: args.target }) },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_canvas_set_param',
    description: '设置 Agent 画布中节点的参数（如 prompt/width/steps 等）。先 comfy_canvas_state 获取节点 id。',
    parameters: {
      node_id: { type: 'string', required: true, description: '节点 id' },
      key: { type: 'string', required: true, description: '参数名（如 prompt/width/height/steps/cfg/seed/denoise/length/fps/model）' },
      value: { type: 'string', required: true, description: '参数值（字符串）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      let value: any = args.value
      if (/^-?\d+(\.\d+)?$/.test(String(args.value))) value = Number(args.value)
      else if (args.value === 'true') value = true
      else if (args.value === 'false') value = false
      return canvasOp({ type: 'param', node_id: args.node_id, key: args.key, value })
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_canvas_run',
    description: '运行 Agent 画布当前的工作流（序列化为 ComfyUI workflow 执行），返回生成结果（图片/视频）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute() { return await canvasRun() },
    timeoutMs: 600000,
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_canvas_clear',
    description: '清空 Agent 画布（删除所有节点和连线）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute() { return canvasOp({ type: 'clear' }) },
  })))

  // ═══ 任务模板工具（方案 D）═══
  disposers.push(ctx.tools.register(defineTool({
    name: 'comfy_task',
    description: '按任务模板一键执行：anime(二次元动漫图)/promo(宣传海报图)/report(报告配图)/i2v(图生视频)/canvas_demo(画布示例工作流)。返回生成结果。',
    parameters: {
      task: { type: 'string', required: true, description: '任务 id：anime/promo/report/i2v/canvas_demo' },
      prompt: { type: 'string', description: '内容描述/提示词' },
      negative: { type: 'string', description: '反向提示词' },
      width: { type: 'number', description: '宽' },
      height: { type: 'number', description: '高' },
      image: { type: 'string', description: 'input 目录图片文件名（i2v 用）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    async execute(args) {
      const task = TASKS.find((t) => t.id === args.task)
      if (!task) throw new Error('任务不存在: ' + args.task)
      return await task.run(args as Record<string, any>)
    },
    timeoutMs: 600000,
  })))

  // ═══ webserver 路由（面板用）═══
  const BASE = '/comfyui-bridge/api'
  const json = (res: any, code: number, payload: any) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(payload))
  }
  const wrap = (handler: () => Promise<any>) => async (_req: unknown, res: any) => {
    try {
      json(res, 200, await handler())
    } catch (e) {
      json(res, 500, { error: String(e instanceof Error ? e.message : e) })
    }
  }

  disposers.push(ctx.webServer.register({ kind: 'exact', path: BASE + '/status', handler: wrap(() => status()) }))
  disposers.push(ctx.webServer.register({ kind: 'exact', path: BASE + '/start', handler: wrap(() => start()) }))
  disposers.push(ctx.webServer.register({ kind: 'exact', path: BASE + '/stop', handler: wrap(() => stop()) }))
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/models',
    handler: wrap(async () => ({ models: checkpoints(), dir: join(config.comfyDir, 'models', 'checkpoints') })),
  }))

  // ═══ ComfyUI Studio：结果历史 + 生成 API（MVP: T2I）═══
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const studioDir = join(dshHome, 'comfyui-studio')
  const historyFile = join(studioDir, 'history.json')
  const MAX_HISTORY = 200

  function loadHistory(): any[] {
    try { return JSON.parse(readFileSync(historyFile, 'utf8')) } catch { return [] }
  }
  function saveHistory(entries: any[]): void {
    try {
      mkdirSync(studioDir, { recursive: true })
      writeFileSync(historyFile, JSON.stringify(entries.slice(0, MAX_HISTORY), null, 2), 'utf8')
    } catch { /* 历史写失败不致命 */ }
  }

  const num = (v: unknown, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }

  // ── 视频模型预检（LTXV I2V）──
  const VIDEO_MODEL_NEEDS = [
    { name: 'ltx-video-2b-v0.9.5.safetensors', dir: 'checkpoints', url: 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors' },
    { name: 't5xxl_fp16.safetensors', dir: 'text_encoders', url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors' },
  ]
  function listModelsDir(sub: string): string[] {
    const dir = join(config.comfyDir, 'models', sub)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
  }
  function videoModelStatus(): { ok: boolean; missing: Array<{ name: string; dir: string; url: string }> } {
    const ckpts = listModelsDir('checkpoints')
    const tencs = listModelsDir('text_encoders')
    const missing = VIDEO_MODEL_NEEDS.filter((n) => !(n.dir === 'checkpoints' ? ckpts : tencs).includes(n.name))
    return { ok: missing.length === 0, missing }
  }

  function buildLtxvI2V(a: { prompt: string; negative: string; imageName: string; width: number; height: number; length: number; fps: number; strength: number; steps: number; cfg: number; seed: number; frameRate: number; model: string; clip: string; maxShift: number; baseShift: number; terminal: number }): Record<string, any> {
    return {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: a.model } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: a.clip, type: 'ltxv' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: a.prompt, clip: ['2', 0] } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: a.negative, clip: ['2', 0] } },
      '5': { class_type: 'LoadImage', inputs: { image: a.imageName } },
      '6': { class_type: 'LTXVImgToVideo', inputs: { positive: ['3', 0], negative: ['4', 0], vae: ['1', 2], image: ['5', 0], width: a.width, height: a.height, length: a.length, batch_size: 1, strength: a.strength } },
      '7': { class_type: 'LTXVConditioning', inputs: { positive: ['6', 0], negative: ['6', 1], frame_rate: a.frameRate } },
      '8': { class_type: 'LTXVScheduler', inputs: { steps: a.steps, max_shift: a.maxShift, base_shift: a.baseShift, stretch: true, terminal: a.terminal, latent: ['6', 2] } },
      '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
      '10': { class_type: 'SamplerCustom', inputs: { model: ['1', 0], add_noise: true, noise_seed: a.seed, cfg: a.cfg, positive: ['7', 0], negative: ['7', 1], sampler: ['9', 0], sigmas: ['8', 0], latent_image: ['6', 2] } },
      '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['1', 2] } },
      '12': { class_type: 'CreateVideo', inputs: { images: ['11', 0], fps: a.fps } },
      '13': { class_type: 'SaveVideo', inputs: { video: ['12', 0], filename_prefix: 'dsh/video', format: 'mp4' } },
    }
  }

  async function studioGenerate(body: any): Promise<any> {
    const kind = body?.kind ?? 't2i'
    if (typeof body?.prompt !== 'string' || !body.prompt.trim()) throw new Error('prompt 必填')
    const width = num(body.width, 512)
    const height = num(body.height, 512)
    const steps = num(body.steps, 20)
    const cfg = num(body.cfg, 7)
    const seedArg = body.seed === undefined || body.seed === null || body.seed === '' ? undefined : num(body.seed, -1)
    const common = {
      prompt: body.prompt,
      negative: typeof body.negative === 'string' ? body.negative : undefined,
      width,
      height,
      steps,
      cfg,
      seed: seedArg === -1 ? undefined : seedArg,
      model: typeof body.model === 'string' ? body.model : undefined,
      sampler: typeof body.sampler === 'string' ? body.sampler : undefined,
      scheduler: typeof body.scheduler === 'string' ? body.scheduler : undefined,
    }

    if (kind === 'i2v') {
      const status = videoModelStatus()
      if (!status.ok) {
        throw new Error('缺少视频模型：' + status.missing.map((m) => `${m.name}（→ models/${m.dir}/，下载: ${m.url}）`).join('；'))
      }
      const imageName = typeof body.image === 'string' ? body.image : ''
      if (!imageName) throw new Error('i2v 需要已上传起始帧图片（image 参数）')
      const length = num(body.length, 97)
      const fps = num(body.fps, 24)
      const strength = num(body.strength, 0.15)
      const frameRate = num(body.frame_rate, 25)
      const seed = seedArg === -1 ? Math.floor(Math.random() * 0x7fffffff) : (seedArg ?? Math.floor(Math.random() * 0x7fffffff))
      const model = typeof body.model === 'string' && body.model ? body.model : 'ltx-video-2b-v0.9.5.safetensors'
      const result = await runWorkflow(buildLtxvI2V({
        prompt: body.prompt,
        negative: common.negative ?? '',
        imageName,
        width,
        height,
        length,
        fps,
        strength,
        steps,
        cfg,
        seed,
        frameRate,
        model,
        clip: 't5xxl_fp16.safetensors',
        maxShift: num(body.max_shift, 2.05),
        baseShift: num(body.base_shift, 0.95),
        terminal: num(body.terminal, 0.1),
      }), undefined, 30 * 60 * 1000)
      const entry = {
        id: result.prompt_id,
        kind: 'i2v' as const,
        prompt: body.prompt,
        negative: common.negative ?? '',
        params: { width, height, length, fps, strength, steps, cfg, seed, model },
        videos: result.videos,
        createdAt: Date.now(),
        status: 'done' as const,
      }
      const list = loadHistory()
      list.unshift(entry)
      saveHistory(list)
      return { entry }
    }

    if (kind === 'i2i') {
      const imageName = typeof body.image === 'string' ? body.image : ''
      if (!imageName) throw new Error('i2i 需要已上传图片（image 参数）')
      const denoise = num(body.denoise, 0.65)
      if (denoise <= 0 || denoise > 1) throw new Error('denoise 必须在 (0, 1] 区间')
      const result = await img2img({
        ...common,
        image_path: join(config.comfyDir, 'input', imageName),
        denoise,
      })
      const entry = {
        id: result.prompt_id,
        kind: 'i2i' as const,
        prompt: body.prompt,
        negative: common.negative ?? '',
        params: { width, height, steps, cfg, seed: result.seed, model: result.model, sampler: body.sampler ?? 'euler', scheduler: body.scheduler ?? 'normal', denoise },
        images: result.images,
        createdAt: Date.now(),
        status: 'done' as const,
      }
      const list = loadHistory()
      list.unshift(entry)
      saveHistory(list)
      return { entry }
    }

    const result = await text2img(common)
    const entry = {
      id: result.prompt_id,
      kind: 't2i' as const,
      prompt: body.prompt,
      negative: common.negative ?? '',
      params: {
        width,
        height,
        steps,
        cfg,
        seed: result.seed,
        model: result.model,
        sampler: body.sampler ?? 'euler',
        scheduler: body.scheduler ?? 'normal',
      },
      images: result.images,
      createdAt: Date.now(),
      status: 'done' as const,
    }
    const list = loadHistory()
    list.unshift(entry)
    saveHistory(list)
    return { entry }
  }

  function readBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (c: Buffer) => {
        data += c.toString('utf8')
        if (data.length > 10 * 1024 * 1024) {
          reject(new Error('body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  // ═══ V3：模板引擎 + 工作流保存/加载 + 自定义模板导入 ═══
  const templateDir = join(studioDir, 'templates')
  const workflowDir = join(studioDir, 'workflows')
  try { mkdirSync(templateDir, { recursive: true }); mkdirSync(workflowDir, { recursive: true }) } catch { /* ignore */ }

  const BUILTIN_TEMPLATES = [
    {
      id: 't2i',
      name: '文生图 (T2I)',
      kind: 't2i',
      schema: { prompt: { type: 'string' }, negative: { type: 'string' }, width: { type: 'number', default: 512 }, height: { type: 'number', default: 512 }, steps: { type: 'number', default: 20 }, cfg: { type: 'number', default: 7 }, seed: { type: 'number' }, model: { type: 'string' }, sampler: { type: 'string', default: 'euler' }, scheduler: { type: 'string', default: 'normal' } },
    },
    {
      id: 'i2i',
      name: '图生图 (I2I)',
      kind: 'i2i',
      schema: { prompt: { type: 'string' }, negative: { type: 'string' }, image: { type: 'string' }, denoise: { type: 'number', default: 0.65 }, width: { type: 'number', default: 512 }, height: { type: 'number', default: 512 }, steps: { type: 'number', default: 20 }, cfg: { type: 'number', default: 7 }, seed: { type: 'number' }, model: { type: 'string' }, sampler: { type: 'string', default: 'euler' }, scheduler: { type: 'string', default: 'normal' } },
    },
    {
      id: 'i2v',
      name: '图生视频 (I2V · LTXV)',
      kind: 'i2v',
      schema: { prompt: { type: 'string' }, negative: { type: 'string' }, image: { type: 'string' }, width: { type: 'number', default: 768 }, height: { type: 'number', default: 512 }, length: { type: 'number', default: 97 }, fps: { type: 'number', default: 24 }, strength: { type: 'number', default: 0.15 }, steps: { type: 'number', default: 20 }, cfg: { type: 'number', default: 7 }, seed: { type: 'number' }, frame_rate: { type: 'number', default: 25 } },
    },
  ]

  function listCustomTemplates(): any[] {
    try {
      return readdirSync(templateDir).filter((f) => f.endsWith('.json')).map((f) => {
        try { return JSON.parse(readFileSync(join(templateDir, f), 'utf8')) } catch { return null }
      }).filter(Boolean)
    } catch { return [] }
  }

  // 分析 API JSON 中所有非引用输入（标量值）为可变参数（按字段名注入，不依赖节点 ID）
  function analyzeWorkflowParams(workflow: Record<string, any>): Record<string, any> {
    const params: Record<string, any> = {}
    for (const node of Object.values(workflow) as any[]) {
      for (const [k, v] of Object.entries(node?.inputs ?? {})) {
        if (!Array.isArray(v)) params[k] = v
      }
    }
    return params
  }

  // 自定义模板运行时：按字段名覆盖非引用值
  function buildCustomWorkflow(workflow: Record<string, any>, params: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = JSON.parse(JSON.stringify(workflow))
    for (const node of Object.values(out) as any[]) {
      for (const [k, v] of Object.entries(node.inputs)) {
        if (!Array.isArray(v) && params[k] !== undefined && params[k] !== '') node.inputs[k] = params[k]
      }
    }
    return out
  }

  async function runTemplate(templateId: string, params: Record<string, any>): Promise<any> {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.id === templateId)
    if (builtin) {
      const p = params as any
      if (builtin.kind === 'i2i') return await img2img({ ...p, image_path: join(config.comfyDir, 'input', String(p.image ?? '')) })
      if (builtin.kind === 'i2v') return await studioGenerate({ kind: 'i2v', ...p })
      return await text2img(p)
    }
    const custom = listCustomTemplates().find((t) => t.id === templateId)
    if (!custom) throw new Error('模板不存在: ' + templateId)
    const result = await runWorkflow(buildCustomWorkflow(custom.workflow, params), undefined, 30 * 60 * 1000)
    return { ...result, model: params.model ?? '', seed: Number(params.seed) || 0 }
  }

  function saveWorkflowRecord(name: string, templateId: string, params: Record<string, any>, kind: string): any {
    const rec = { id: 'wf_' + Date.now().toString(36), name, templateId, params, kind, createdAt: Date.now() }
    try { writeFileSync(join(workflowDir, rec.id + '.json'), JSON.stringify(rec, null, 2), 'utf8') } catch { /* ignore */ }
    return rec
  }
  function listWorkflows(): any[] {
    try {
      return readdirSync(workflowDir).filter((f) => f.endsWith('.json')).map((f) => {
        try { return JSON.parse(readFileSync(join(workflowDir, f), 'utf8')) } catch { return null }
      }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)
    } catch { return [] }
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/templates/list',
    handler: wrap(async () => ({ builtin: BUILTIN_TEMPLATES, custom: listCustomTemplates() })),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/templates/import',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '自定义模板'
        const workflow = body.workflow
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('workflow 必须为 API JSON 对象（ComfyUI 导出格式）')
        const params = analyzeWorkflowParams(workflow)
        const t = { id: 'tpl_' + Date.now().toString(36), name, kind: 'custom', params, workflow, createdAt: Date.now() }
        writeFileSync(join(templateDir, t.id + '.json'), JSON.stringify(t, null, 2), 'utf8')
        json(res, 200, { ok: true, template: t })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // V4 模板市场：从 URL/Gist 导入共享模板
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/templates/import-url',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const url = typeof body.url === 'string' ? body.url.trim() : ''
        if (!/^https?:\/\//.test(url)) throw new Error('url 必须是 http(s) 链接（支持 Gist / raw 文件）')
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 20000)
        let text = ''
        try {
          const r = await fetch(url, { signal: ctrl.signal })
          if (!r.ok) throw new Error('HTTP ' + r.status)
          text = await r.text()
        } finally {
          clearTimeout(t)
        }
        const workflow = JSON.parse(text)
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('内容不是 API JSON 对象')
        const name = body.name && body.name.trim()
          ? body.name.trim()
          : decodeURIComponent(url.split('/').pop() ?? '远程模板').replace(/\.json$/i, '')
        const params = analyzeWorkflowParams(workflow)
        const tpl = { id: 'tpl_' + Date.now().toString(36), name, kind: 'custom' as const, source: url, params, workflow, createdAt: Date.now() }
        writeFileSync(join(templateDir, tpl.id + '.json'), JSON.stringify(tpl, null, 2), 'utf8')
        json(res, 200, { ok: true, template: tpl })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/templates/export',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '', 'http://x')
        const id = u.searchParams.get('id')
        const tpl = listCustomTemplates().find((t) => t.id === id)
        if (!tpl) throw new Error('模板不存在: ' + id)
        json(res, 200, { ok: true, template: tpl })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/templates/delete',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '', 'http://x')
        const id = u.searchParams.get('id')
        rmSync(join(templateDir, id + '.json'), { force: true })
        json(res, 200, { ok: true, custom: listCustomTemplates() })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/templates/run',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        if (typeof body?.templateId !== 'string') throw new Error('templateId 必填')
        const params = body.params && typeof body.params === 'object' ? body.params : {}
        const result = await runTemplate(body.templateId, params)
        const entry = {
          id: result.prompt_id,
          kind: 'template' as const,
          prompt: (params.prompt ?? body.templateId) as string,
          negative: typeof params.negative === 'string' ? params.negative : '',
          params: { templateId: body.templateId, ...params },
          images: result.images,
          videos: result.videos,
          createdAt: Date.now(),
          status: 'done' as const,
        }
        const list = loadHistory()
        list.unshift(entry)
        saveHistory(list)
        json(res, 200, { entry })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/workflows',
    handler: wrap(async () => ({ workflows: listWorkflows() })),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/workflows/save',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '未命名工作流'
        if (typeof body?.templateId !== 'string') throw new Error('templateId 必填')
        const params = body.params && typeof body.params === 'object' ? body.params : {}
        const kind = body.kind ?? body.templateId
        json(res, 200, { ok: true, workflow: saveWorkflowRecord(name, body.templateId, params, kind) })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/workflows/load',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '', 'http://x')
        const id = u.searchParams.get('id')
        const rec = listWorkflows().find((w) => w.id === id)
        if (!rec) throw new Error('工作流不存在: ' + id)
        json(res, 200, { workflow: rec })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/workflows/delete',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '', 'http://x')
        const id = u.searchParams.get('id')
        try { rmSync(join(workflowDir, id + '.json'), { force: true }) } catch { /* ignore */ }
        json(res, 200, { ok: true, workflows: listWorkflows() })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))
  // ═══ 画布序列化引擎（V2 核心：画布节点/边 → ComfyUI API JSON）═══
  type CanvasNode = { id: string; type: string; data?: { params?: Record<string, any> }; classType?: string; outputCount?: number }
  type CanvasEdge = { source: string; target: string; sourceOutput?: number; targetInput?: string }
  type Expanded = {
    nodes: Record<string, { class_type: string; inputs: Record<string, any> }>
    entry: { node: string; output: number } | null
    imageInput: boolean
  }

  // ComfyUI object_info 缓存（任意节点 schema 来源，5 分钟有效）
  let objectInfoCache: any = null
  let objectInfoTs = 0
  async function getObjectInfo(): Promise<any> {
    if (objectInfoCache && Date.now() - objectInfoTs < 5 * 60 * 1000) return objectInfoCache
    const info = await api('/object_info')
    objectInfoCache = info
    objectInfoTs = Date.now()
    return info
  }

  // 高层节点 → 底层 ComfyUI 子图展开（__INPUT_IMAGE__ / __IMAGE_SLOT__ 为待注入槽）
  function expandNode(type: string, params: Record<string, any>): Expanded {
    const p = (k: string, d: number): number => { const n = Number(params[k]); return Number.isFinite(n) ? n : d }
    const s = (k: string, d: string): string => (typeof params[k] === 'string' && params[k] ? params[k] : d)
    const model = s('model', checkpoints()[0] ?? '')
    if (!model) throw new Error('models/checkpoints 目录为空')
    const seed = params.seed === undefined || params.seed === null || params.seed === ''
      ? Math.floor(Math.random() * 0x7fffffff)
      : p('seed', 0)
    switch (type) {
      case 't2i':
        return {
          nodes: {
            'a': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
            'b': { class_type: 'CLIPTextEncode', inputs: { text: s('prompt', ''), clip: ['a', 1] } },
            'c': { class_type: 'CLIPTextEncode', inputs: { text: s('negative', ''), clip: ['a', 1] } },
            'd': { class_type: 'EmptyLatentImage', inputs: { width: p('width', 512), height: p('height', 512), batch_size: 1 } },
            'e': { class_type: 'KSampler', inputs: { seed, steps: p('steps', 20), cfg: p('cfg', 7), sampler_name: s('sampler', 'euler'), scheduler: s('scheduler', 'normal'), denoise: 1, model: ['a', 0], positive: ['b', 0], negative: ['c', 0], latent_image: ['d', 0] } },
            'f': { class_type: 'VAEDecode', inputs: { samples: ['e', 0], vae: ['a', 2] } },
          },
          entry: { node: 'f', output: 0 },
          imageInput: false,
        }
      case 'i2i':
        return {
          nodes: {
            'a': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
            'b': { class_type: 'CLIPTextEncode', inputs: { text: s('prompt', ''), clip: ['a', 1] } },
            'c': { class_type: 'CLIPTextEncode', inputs: { text: s('negative', ''), clip: ['a', 1] } },
            'd': { class_type: 'LoadImage', inputs: { image: '__IMAGE_SLOT__' } },
            'e': { class_type: 'VAEEncode', inputs: { pixels: ['d', 0], vae: ['a', 2] } },
            'f': { class_type: 'KSampler', inputs: { seed, steps: p('steps', 20), cfg: p('cfg', 7), sampler_name: s('sampler', 'euler'), scheduler: s('scheduler', 'normal'), denoise: p('denoise', 0.65), model: ['a', 0], positive: ['b', 0], negative: ['c', 0], latent_image: ['e', 0] } },
            'g': { class_type: 'VAEDecode', inputs: { samples: ['f', 0], vae: ['a', 2] } },
          },
          entry: { node: 'g', output: 0 },
          imageInput: true,
        }
      case 'output':
        return {
          nodes: { 'a': { class_type: 'SaveImage', inputs: { images: '__INPUT_IMAGE__', filename_prefix: s('prefix', 'dsh/canvas') } } },
          entry: null,
          imageInput: true,
        }
      case 'upscale':
        return {
          nodes: { 'a': { class_type: 'ImageScale', inputs: { image: '__INPUT_IMAGE__', width: p('width', 1024), height: p('height', 1024), upscale_method: s('method', 'lanczos'), crop: 'disabled' } } },
          entry: { node: 'a', output: 0 },
          imageInput: true,
        }
      case 't2v':
      case 'i2v': {
        // 视频节点：需要 LTXV 视频模型 + T5xxl 文本编码器
        const ckpts = checkpoints()
        const hasVidModel = ckpts.some((f) => /ltx/i.test(f))
        if (!hasVidModel) {
          throw new Error('缺少视频模型：请下载 ltx-video-2b-v0.9.5.safetensors 到 models/checkpoints/（详见 /comfyui-studio/api/video-models）')
        }
        const hasT5 = listModelsDir('text_encoders').includes('t5xxl_fp16.safetensors')
        if (!hasT5) {
          throw new Error('缺少文本编码器：请下载 t5xxl_fp16.safetensors 到 models/text_encoders/（详见 /comfyui-studio/api/video-models）')
        }
        const vidModel = (s('model', '') && ckpts.includes(s('model', ''))) ? s('model', '') : (ckpts.find((f) => /ltx/i.test(f)) ?? 'ltx-video-2b-v0.9.5.safetensors')
        const length = p('length', 97)
        const fps = p('fps', 24)
        const frameRate = p('frame_rate', 25)
        const videoNodes: Record<string, { class_type: string; inputs: Record<string, any> }> = {
          'a': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: vidModel } },
          'b': { class_type: 'CLIPLoader', inputs: { clip_name: 't5xxl_fp16.safetensors', type: 'ltxv' } },
          'c': { class_type: 'CLIPTextEncode', inputs: { text: s('prompt', ''), clip: ['b', 0] } },
          'd': { class_type: 'CLIPTextEncode', inputs: { text: s('negative', ''), clip: ['b', 0] } },
        }
        let latentFrom: [string, number]
        if (type === 'i2v') {
          videoNodes['e'] = { class_type: 'LoadImage', inputs: { image: '__IMAGE_SLOT__' } }
          videoNodes['f'] = { class_type: 'LTXVImgToVideo', inputs: { positive: ['c', 0], negative: ['d', 0], vae: ['a', 2], image: ['e', 0], width: p('width', 768), height: p('height', 512), length, batch_size: 1, strength: p('strength', 0.15) } }
          latentFrom = ['f', 2]
          videoNodes['g'] = { class_type: 'LTXVConditioning', inputs: { positive: ['f', 0], negative: ['f', 1], frame_rate: frameRate } }
        } else {
          videoNodes['e'] = { class_type: 'EmptyLTXVLatentVideo', inputs: { width: p('width', 768), height: p('height', 512), length, batch_size: 1 } }
          latentFrom = ['e', 0]
          videoNodes['g'] = { class_type: 'LTXVConditioning', inputs: { positive: ['c', 0], negative: ['d', 0], frame_rate: frameRate } }
        }
        videoNodes['h'] = { class_type: 'LTXVScheduler', inputs: { steps: p('steps', 20), max_shift: p('max_shift', 2.05), base_shift: p('base_shift', 0.95), stretch: true, terminal: p('terminal', 0.1), latent: latentFrom } }
        videoNodes['i'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } }
        videoNodes['j'] = { class_type: 'SamplerCustom', inputs: { model: ['a', 0], add_noise: true, noise_seed: seed, cfg: p('cfg', 7), positive: ['g', 0], negative: ['g', 1], sampler: ['i', 0], sigmas: ['h', 0], latent_image: latentFrom } }
        videoNodes['k'] = { class_type: 'VAEDecode', inputs: { samples: ['j', 0], vae: ['a', 2] } }
        videoNodes['l'] = { class_type: 'CreateVideo', inputs: { images: ['k', 0], fps } }
        videoNodes['m'] = { class_type: 'SaveVideo', inputs: { video: ['l', 0], filename_prefix: s('prefix', 'dsh/video'), format: 'mp4' } }
        return {
          nodes: videoNodes,
          entry: null,
          imageInput: type === 'i2v',
        }
      }
      default:
        throw new Error('未知画布节点类型: ' + type)
    }
  }

  function serializeCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): Record<string, any> {
    if (nodes.length === 0) throw new Error('画布为空')
    // 展开：builtin（expandNode 子图）或任意节点（classType 直通）
    const expanded: Record<string, Expanded & { custom?: boolean }> = {}
    for (const cn of nodes) {
      try {
        expanded[cn.id] = cn.classType
          ? {
              nodes: { 'a': { class_type: cn.classType, inputs: { ...(cn.data?.params ?? {}) } } },
              entry: null,
              imageInput: false,
              custom: true,
            }
          : expandNode(cn.type, cn.data?.params ?? {})
      } catch (err) {
        throw new Error(`节点 ${cn.id} 展开失败: ${msg(err)}`)
      }
    }
    let next = 1
    const mapping: Record<string, string> = {}
    for (const cn of nodes) {
      for (const k of Object.keys(expanded[cn.id].nodes)) mapping[`${cn.id}:${k}`] = String(next++)
    }
    const resolve = (cnId: string, local: string): string => mapping[`${cnId}:${local}`]
    const api: Record<string, any> = {}
    const entries: Record<string, { node: string; output: number; outputCount?: number }> = {}
    for (const cn of nodes) {
      const ex = expanded[cn.id]
      for (const [local, def] of Object.entries(ex.nodes)) {
        const inputs: Record<string, any> = {}
        for (const [k, v] of Object.entries(def.inputs)) {
          if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') inputs[k] = [resolve(cn.id, v[0]), v[1]]
          else inputs[k] = v
        }
        api[resolve(cn.id, local)] = { class_type: def.class_type, inputs }
      }
      if (ex.entry) entries[cn.id] = { node: resolve(cn.id, ex.entry.node), output: ex.entry.output }
      else if (ex.custom) entries[cn.id] = { node: resolve(cn.id, 'a'), output: 0, outputCount: Number(cn.outputCount) || 1 }
    }
    // 边注入：custom target 用 targetInput 端口名；builtin target 用 __INPUT_IMAGE__/__IMAGE_SLOT__
    const imageSrc: Record<string, { node: string; output: number }> = {}
    for (const e of edges) {
      const src = entries[e.source]
      if (!src) continue
      const srcRef = { node: src.node, output: src.outputCount ? (e.sourceOutput ?? 0) : src.output }
      imageSrc[e.target] = srcRef
      const tgtEx = expanded[e.target]
      if (tgtEx?.custom) {
        const inputName = e.targetInput
        if (inputName) {
          const tgtApi = api[resolve(e.target, 'a')]
          if (tgtApi) tgtApi.inputs[inputName] = [srcRef.node, srcRef.output]
        }
      }
    }
    for (const cn of nodes) {
      const ex = expanded[cn.id]
      if (!ex || ex.custom || !ex.imageInput) continue
      const src = imageSrc[cn.id]
      for (const [local, def] of Object.entries(ex.nodes)) {
        for (const [k, v] of Object.entries(def.inputs)) {
          if (v === '__INPUT_IMAGE__') {
            if (!src) throw new Error(`节点 ${cn.id}（${cn.type}）缺少 image 输入连线`)
            api[resolve(cn.id, local)].inputs[k] = [src.node, src.output]
          } else if (v === '__IMAGE_SLOT__') {
            const nodeId = resolve(cn.id, local)
            if (src) api[nodeId].inputs[k] = [src.node, src.output]
            else {
              const img = cn.data?.params?.image
              if (!img) throw new Error(`节点 ${cn.id}（${cn.type}）需要参考图片（上传或连线）`)
              api[nodeId].inputs[k] = img
            }
          }
        }
      }
    }
    return api
  }

  // ═══ Agent 画布编排：Host 维护画布状态（单源），工具/前端/任务共享 ═══
  const canvasStore = { version: 0, nodes: [] as any[], edges: [] as any[] }
  const bumpCanvas = () => { canvasStore.version++ }
  const canvasSnapshot = () => ({ version: canvasStore.version, nodes: canvasStore.nodes, edges: canvasStore.edges })

  function canvasNodeById(id: string): any | undefined { return canvasStore.nodes.find((n) => n.id === id) }

  // 画布操作（agent 工具 + HTTP API 共用）
  function canvasOp(op: any): any {
    if (!op || typeof op !== 'object') throw new Error('无效操作')
    switch (op.type) {
      case 'add': {
        const type = typeof op.node_type === 'string' ? op.node_type : 't2i'
        const id = `${type}_${Date.now().toString(36)}`
        const n = {
          id, type,
          classType: typeof op.class_type === 'string' && op.class_type ? op.class_type : undefined,
          outputCount: Number(op.output_count) || 1,
          x: typeof op.x === 'number' ? op.x : 80 + Math.random() * 160,
          y: typeof op.y === 'number' ? op.y : 60 + Math.random() * 120,
          params: op.params && typeof op.params === 'object' ? { ...op.params } : {},
        }
        canvasStore.nodes.push(n)
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'remove': {
        canvasStore.nodes = canvasStore.nodes.filter((n) => n.id !== op.node_id)
        canvasStore.edges = canvasStore.edges.filter((e) => e.source !== op.node_id && e.target !== op.node_id)
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'connect': {
        const src = canvasNodeById(op.source)
        const tgt = canvasNodeById(op.target)
        if (!src || !tgt || op.source === op.target) throw new Error('无效连线（节点不存在或自连）')
        const dup = canvasStore.edges.some((e) => e.source === op.source && e.target === op.target && e.targetInput === op.target_input)
        if (!dup) canvasStore.edges.push({
          id: `e_${Date.now().toString(36)}`,
          source: op.source, target: op.target,
          sourceOutput: typeof op.source_output === 'number' ? op.source_output : 0,
          targetInput: typeof op.target_input === 'string' ? op.target_input : undefined,
        })
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'disconnect': {
        canvasStore.edges = canvasStore.edges.filter((e) => !(e.source === op.source && e.target === op.target))
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'param': {
        const n = canvasNodeById(op.node_id)
        if (!n) throw new Error('节点不存在: ' + op.node_id)
        n.params = { ...n.params, [op.key]: op.value }
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'move': {
        const n = canvasNodeById(op.node_id)
        if (!n) throw new Error('节点不存在: ' + op.node_id)
        if (typeof op.x === 'number') n.x = op.x
        if (typeof op.y === 'number') n.y = op.y
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'clear': {
        canvasStore.nodes = []
        canvasStore.edges = []
        bumpCanvas()
        return canvasSnapshot()
      }
      case 'load': {
        canvasStore.nodes = Array.isArray(op.nodes) ? op.nodes : []
        canvasStore.edges = Array.isArray(op.edges) ? op.edges : []
        bumpCanvas()
        return canvasSnapshot()
      }
      default:
        throw new Error('未知画布操作: ' + String(op.type))
    }
  }

  async function canvasRun(): Promise<any> {
    if (canvasStore.nodes.length === 0) throw new Error('画布为空，请先添加节点')
    const workflow = serializeCanvas(
      canvasStore.nodes.map((n) => ({ id: n.id, type: n.type, classType: n.classType, outputCount: n.outputCount, data: { params: n.params } })),
      canvasStore.edges.map((e) => ({ source: e.source, target: e.target, sourceOutput: e.sourceOutput, targetInput: e.targetInput })),
    )
    const result = await runWorkflow(workflow, undefined, 30 * 60 * 1000)
    const entry = {
      id: result.prompt_id,
      kind: 'canvas' as const,
      prompt: 'Agent 画布 · ' + canvasStore.nodes.map((n) => n.type).join(' → '),
      negative: '',
      params: { nodeTypes: canvasStore.nodes.map((n) => n.type) },
      images: result.images,
      videos: result.videos,
      createdAt: Date.now(),
      status: 'done' as const,
    }
    const list = loadHistory()
    list.unshift(entry)
    saveHistory(list)
    return { entry, nodeCount: canvasStore.nodes.length, expandedNodes: Object.keys(workflow).length }
  }

  // ═══ 任务模板（方案 D：agent 按任务一键执行）═══
  const TASKS: Array<{ id: string; name: string; description: string; params: Record<string, { type: string; description: string }>; run: (p: Record<string, any>) => Promise<any> }> = [
    {
      id: 'anime',
      name: '二次元动漫图',
      description: '用动漫 checkpoint（Counterfeit 等）生成二次元图片',
      params: { prompt: { type: 'string', description: '提示词（英文最佳，动漫风格）' }, negative: { type: 'string', description: '反向提示词' }, width: { type: 'number', description: '宽（默认 512）' }, height: { type: 'number', description: '高（默认 512）' } },
      async run(p) {
        const ckpts = checkpoints()
        const model = ckpts.find((f) => /counterfeit/i.test(f)) ?? ckpts.find((f) => /anime|anything|meina|animagine/i.test(f)) ?? ckpts[0]
        return await text2img({ prompt: p.prompt ?? '', negative: p.negative ?? '', width: Number(p.width) || 512, height: Number(p.height) || 512, model })
      },
    },
    {
      id: 'promo',
      name: '宣传海报图',
      description: '生成宣传/广告风格图片（大标题留白、高对比、视觉冲击）',
      params: { prompt: { type: 'string', description: '海报内容描述' }, negative: { type: 'string', description: '反向提示词' }, width: { type: 'number', description: '宽（默认 768）' }, height: { type: 'number', description: '高（默认 512）' } },
      async run(p) {
        const prompt = `${p.prompt ?? ''}, promotional poster, bold typography space, high contrast, vibrant colors, advertising style, professional marketing design, cinematic lighting, ultra detailed`
        return await text2img({ prompt, negative: p.negative ?? 'text, watermark, blurry, lowres', width: Number(p.width) || 768, height: Number(p.height) || 512 })
      },
    },
    {
      id: 'report',
      name: '报告配图',
      description: '生成报告/演示风格的配图（数据可视化、商务插画）',
      params: { prompt: { type: 'string', description: '配图内容描述' }, negative: { type: 'string', description: '反向提示词' }, width: { type: 'number', description: '宽（默认 1024）' }, height: { type: 'number', description: '高（默认 512）' } },
      async run(p) {
        const prompt = `${p.prompt ?? ''}, business report illustration, data visualization style, clean flat design, professional infographic aesthetic, corporate colors, high quality`
        return await text2img({ prompt, negative: p.negative ?? 'text, watermark, blurry, lowres', width: Number(p.width) || 1024, height: Number(p.height) || 512 })
      },
    },
    {
      id: 'i2v',
      name: '图生视频 (LTXV)',
      description: '基于上传/画布图片生成短视频（需 LTXV 模型）',
      params: { prompt: { type: 'string', description: '运动/内容描述' }, image: { type: 'string', description: 'input 目录的图片文件名（画布连线或已有）' }, negative: { type: 'string', description: '反向提示词' } },
      async run(p) {
        return await studioGenerate({ kind: 'i2v', prompt: p.prompt ?? '', negative: p.negative ?? '', image: p.image ?? '', length: Number(p.length) || 49 })
      },
    },
    {
      id: 'canvas_demo',
      name: '画布示例 (T2I→放大→输出)',
      description: '在 Agent 画布构建 文生图→放大→输出 示例工作流并运行',
      params: { prompt: { type: 'string', description: '图片内容描述' }, negative: { type: 'string', description: '反向提示词' }, width: { type: 'number', description: '宽（默认 512）' }, height: { type: 'number', description: '高（默认 512）' } },
      async run(p) {
        canvasOp({ type: 'clear' })
        canvasOp({ type: 'add', node_type: 't2i', x: 80, y: 60, params: { prompt: p.prompt ?? 'a beautiful illustration', negative: p.negative ?? '', width: Number(p.width) || 512, height: Number(p.height) || 512, steps: 20, cfg: 7 } })
        const t2iNode = canvasStore.nodes[0]
        canvasOp({ type: 'add', node_type: 'upscale', x: 340, y: 40, params: { width: 1024, height: 1024, method: 'lanczos' } })
        canvasOp({ type: 'add', node_type: 'output', x: 620, y: 80, params: { prefix: 'dsh/agent' } })
        canvasOp({ type: 'connect', source: t2iNode.id, target: canvasStore.nodes[1].id })
        canvasOp({ type: 'connect', source: canvasStore.nodes[1].id, target: canvasStore.nodes[2].id })
        return await canvasRun()
      },
    },
  ]

  const msg = (e: unknown) => String(e instanceof Error ? e.message : e)

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/generate',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* 空体视为空参数 */ }
        json(res, 200, await studioGenerate(body))
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/history',
    handler: wrap(async () => ({ entries: loadHistory().slice(0, 50) })),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/history/delete',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '', 'http://x')
        const id = u.searchParams.get('id')
        const list = loadHistory().filter((e) => e.id !== id)
        saveHistory(list)
        json(res, 200, { ok: true, entries: list.slice(0, 50) })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // 图片上传（base64 JSON → ComfyUI input 目录），返回可被 LoadImage 引用的文件名
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/upload',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const name = typeof body.name === 'string' ? basename(body.name).replace(/[\\/]/g, '_') : 'upload.png'
        const data = typeof body.data === 'string' ? body.data : ''
        if (!/\.(png|jpe?g|webp)$/i.test(name)) throw new Error('仅支持 png/jpg/jpeg/webp 图片')
        const buf = Buffer.from(data, 'base64')
        if (buf.length === 0 || buf.length > 20 * 1024 * 1024) throw new Error('图片数据无效或超过 20MB')
        const dir = join(config.comfyDir, 'input')
        try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
        const filename = `dsh_upload_${Date.now()}_${name}`
        writeFileSync(join(dir, filename), buf)
        json(res, 200, { ok: true, filename })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/video-models',
    handler: wrap(async () => {
      const st = videoModelStatus()
      return {
        ok: st.ok,
        missing: st.missing.map((m) => ({ name: m.name, dir: m.dir, url: m.url })),
        diffusion_models: listModelsDir('diffusion_models'),
        checkpoints: listModelsDir('checkpoints'),
        text_encoders: listModelsDir('text_encoders'),
      }
    }),
  }))

  // 画布工作流执行：nodes/edges → 序列化 → 提交 ComfyUI
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/run',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const nodes: CanvasNode[] = Array.isArray(body?.nodes) ? body.nodes : []
        const edges: CanvasEdge[] = Array.isArray(body?.edges) ? body.edges : []
        if (nodes.length === 0) throw new Error('画布为空')
        const workflow = serializeCanvas(nodes, edges)
        const result = await runWorkflow(workflow, undefined, 30 * 60 * 1000)
        const entry = {
          id: result.prompt_id,
          kind: 'canvas' as const,
          prompt: '画布工作流 · ' + nodes.map((n) => n.type).join(' → '),
          negative: '',
          params: { nodeTypes: nodes.map((n) => n.type) },
          images: result.images,
          videos: result.videos,
          createdAt: Date.now(),
          status: 'done' as const,
        }
        const list = loadHistory()
        list.unshift(entry)
        saveHistory(list)
        json(res, 200, { entry, workflow })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // Agent 画布：状态快照（前端轮询同步用）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/state',
    handler: wrap(async () => canvasSnapshot()),
  }))

  // 任意节点：ComfyUI 全部节点类型列表（object_info 精简 schema）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/nodes',
    handler: wrap(async () => {
      const info = await getObjectInfo()
      const list: any[] = []
      for (const [classType, raw] of Object.entries(info)) {
        const r = raw as any
        const inputs: Record<string, any> = {}
        const collect = (sec: any, required: boolean) => {
          for (const [name, spec] of Object.entries(sec ?? {})) {
            const type = Array.isArray(spec) ? spec[0] : String(spec)
            const meta = Array.isArray(spec) && spec.length > 1 ? spec[1] : {}
            inputs[name] = { type, required, default: meta?.default, options: Array.isArray(type) ? type : undefined }
          }
        }
        collect(r?.input?.required, true)
        collect(r?.input?.optional, false)
        list.push({
          class_type: classType,
          category: r?.category ?? 'misc',
          display_name: r?.display_name ?? r?.name ?? classType,
          inputs,
          outputs: Array.isArray(r?.output) ? r.output : [],
          output_is_list: r?.output_is_list,
        })
      }
      return { nodes: list }
    }),
  }))

  // Agent 画布：操作（add/connect/param/move/clear/load…）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/op',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        json(res, 200, canvasOp(body))
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // Agent 画布：运行当前 Host 画布状态
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/agent-run',
    handler: wrap(async () => await canvasRun()),
  }))

  // 基础类型判断（端口连接类型之外）
  const isPrimitiveType = (t: string): boolean => ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'SEED', 'IMAGEUPLOAD'].includes(t)
  // 收集节点输入的简化 schema（供前端参数面板）
  const collectInputSpecs = (raw: any): Record<string, any> => {
    const inputs: Record<string, any> = {}
    const collect = (sec: any, required: boolean) => {
      for (const [name, spec] of Object.entries(sec ?? {})) {
        const type = Array.isArray(spec) ? spec[0] : String(spec)
        const meta = Array.isArray(spec) && spec.length > 1 ? spec[1] : {}
        inputs[name] = { type, required, default: meta?.default, options: Array.isArray(type) ? type : undefined }
      }
    }
    collect(raw?.input?.required, true)
    collect(raw?.input?.optional, false)
    return inputs
  }

  // 工作流导出（API 格式由 Host 序列化；画布格式直接返回状态）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/export',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        if (body?.format === 'api') {
          const workflow = serializeCanvas(
            canvasStore.nodes.map((n) => ({ id: n.id, type: n.type, classType: n.classType, outputCount: n.outputCount, data: { params: n.params } })),
            canvasStore.edges.map((e) => ({ source: e.source, target: e.target, sourceOutput: e.sourceOutput, targetInput: e.targetInput })),
          )
          json(res, 200, { workflow })
        } else {
          json(res, 200, { canvas: canvasSnapshot() })
        }
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // 工作流导入（支持画布 JSON 与 ComfyUI API 格式 JSON）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/canvas/import',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const raw = body?.json
        if (!raw || typeof raw !== 'object') throw new Error('无效的工作流 JSON')
        // 画布格式：直接加载
        if (Array.isArray(raw.nodes) && Array.isArray(raw.edges)) {
          canvasOp({ type: 'load', nodes: raw.nodes, edges: raw.edges })
          json(res, 200, canvasSnapshot())
          return
        }
        // API workflow 格式：还原为画布节点 + 端口连线
        const info = await getObjectInfo()
        const idMap: Record<string, string> = {}
        const nodes: any[] = []
        for (const [apiId, def] of Object.entries(raw)) {
          const d = def as any
          const schema = info?.[d.class_type]
          const cnId = `imp_${apiId}`
          idMap[apiId] = cnId
          const params: Record<string, any> = {}
          for (const [name, v] of Object.entries(d?.inputs ?? {})) if (!Array.isArray(v)) params[name] = v
          const inputSpecs = schema ? collectInputSpecs(schema) : {}
          const portInputs = Object.keys(inputSpecs).filter((k) => !isPrimitiveType(String(inputSpecs[k].type)) && !Array.isArray(inputSpecs[k].type))
          for (const p of portInputs) if (params[p] === undefined) params[p] = ''
          const outputs: string[] = Array.isArray(schema?.output) ? schema.output.map(String) : []
          nodes.push({
            id: cnId, type: 'custom', classType: d.class_type, outputCount: Math.max(1, outputs.length),
            portInputs, portOutputs: outputs,
            inputSpecs: { class_type: d.class_type, display_name: schema?.display_name, inputs: inputSpecs, outputs },
            x: 80 + Math.random() * 200, y: 60 + Math.random() * 150,
            params,
          })
        }
        const edges: any[] = []
        for (const [apiId, def] of Object.entries(raw)) {
          for (const [name, v] of Object.entries((def as any)?.inputs ?? {})) {
            if (Array.isArray(v) && v.length === 2 && idMap[v[0]]) {
              edges.push({ id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, source: idMap[v[0]], target: idMap[apiId], sourceOutput: v[1], targetInput: name })
            }
          }
        }
        canvasOp({ type: 'load', nodes, edges })
        json(res, 200, canvasSnapshot())
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // 任务模板：列表
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/tasks',
    handler: wrap(async () => ({ tasks: TASKS.map(({ id, name, description, params }) => ({ id, name, description, params })) })),
  }))

  // 任务模板：执行
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/comfyui-studio/api/tasks/run',
    handler: async (req: any, res: any) => {
      try {
        let body: any = {}
        try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
        const task = TASKS.find((t) => t.id === body?.task)
        if (!task) throw new Error('任务不存在: ' + String(body?.task))
        const params = body?.params && typeof body.params === 'object' ? body.params : {}
        const result = await task.run(params)
        const e = result?.entry ?? result
        json(res, 200, { entry: e, task: task.id })
      } catch (e) {
        json(res, 500, { error: msg(e) })
      }
    },
  }))

  // fiber dispose：回收本插件启动的进程与日志流
  ctx.effect(() => () => {
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
    if (proc && proc.exitCode === null) { try { proc.kill() } catch { /* ignore */ } }
    proc = null
    if (logStream) { try { logStream.end() } catch { /* ignore */ } }
    logStream = null
  })

  ctx.logger?.info?.(`[comfyui-bridge] 已装配（comfyDir=${config.comfyDir}, port=${config.port}）`)
}
