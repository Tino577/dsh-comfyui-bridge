/**
 * @dsh-external/comfyui-bridge — client 半区。
 * 两个会话视图 tab：
 *  - ComfyUI：内嵌官方前端（画布/工作流/上传/模型切换）
 *  - Studio：自建 T2I / I2I / I2V 表单 + 结果画廊（含图片与视频）
 * 数据经 /comfyui-bridge/api 与 /comfyui-studio/api（host webserver 路由）。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import { buildCanvasPanel } from './canvas'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const BRIDGE = '/comfyui-bridge/api'
const STUDIO = '/comfyui-studio/api'
let timer: number | null = null
let studioTimer: number | null = null

/**
 * conversation.view 的 component 必须是 React FC（框架 renderEntry 直接 <Comp/>）。
 * 面板本体是纯 DOM（buildMainPanel），由 FC 挂到容器 div 上。
 */
function ComfyUIPanel(): React.ReactNode {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const host = hostRef.current
    if (host && !host.firstChild) host.appendChild(buildMainPanel())
    return () => { if (host) host.innerHTML = '' }
  }, [])
  return React.createElement('div', { ref: hostRef, style: { height: '100%', minHeight: 0, width: '100%' } })
}

export function apply(ctx: ClientContext): void {
  // ═══ 单一 ComfyUI 面板：官方前端 / Studio / 画布 子导航（不另开视图 tab）═══
  // 注意：component 是 register 的第二个参数（options 里只有 id/order/label/priority）
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/comfyui-bridge-panel',
      label: () => 'ComfyUI',
    }, ComfyUIPanel),
  ), '@dsh-external/comfyui-bridge: main panel')
}

function buildMainPanel(): HTMLElement {
  if (timer !== null) { clearInterval(timer); timer = null }

  const root = document.createElement('div')
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;width:100%;overflow:hidden;'

  // ═══ 服务状态条（共享，跨 Studio/画布）═══
  const btnStyle = 'font-size:12px;line-height:1;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary, #ddd);cursor:pointer;'
  const bar = document.createElement('div')
  bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));'

  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#999;flex:none;'
  const label = document.createElement('span')
  label.textContent = 'ComfyUI 服务状态查询中…'
  label.style.cssText = 'font-size:13px;color:var(--dsw-alias-label-secondary, #888);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:80px;'

  const modelSel = document.createElement('select')
  modelSel.style.cssText = 'font-size:12px;max-width:200px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:var(--dsw-alias-bg-base, #1e1e1e);color:var(--dsw-alias-label-primary, #ddd);'

  const startBtn = document.createElement('button')
  startBtn.type = 'button'
  startBtn.textContent = '启动服务'
  startBtn.style.cssText = btnStyle
  startBtn.onclick = async () => {
    startBtn.disabled = true
    try { await fetch(BRIDGE + '/start', { method: 'POST', cache: 'no-store' }) } catch { /* ignore */ }
    startBtn.disabled = false
    refresh()
  }
  const stopBtn = document.createElement('button')
  stopBtn.type = 'button'
  stopBtn.textContent = '停止服务'
  stopBtn.style.cssText = btnStyle
  stopBtn.onclick = async () => {
    stopBtn.disabled = true
    try { await fetch(BRIDGE + '/stop', { method: 'POST', cache: 'no-store' }) } catch { /* ignore */ }
    stopBtn.disabled = false
    refresh()
  }

  bar.append(dot, label, modelSel, startBtn, stopBtn)

  // ═══ 子导航（Studio | 画布）═══
  const nav = document.createElement('div')
  nav.style.cssText = 'flex:none;display:flex;gap:2px;padding:8px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.15));'
  const tabs = [
    { id: 'studio', name: 'Studio · 生成' },
    { id: 'canvas', name: '画布 · 编排' },
  ]
  const views: Record<string, HTMLElement> = {}
  const btns: Record<string, HTMLButtonElement> = {}

  function mount(id: string): void {
    if (views[id]) return
    const inner = id === 'canvas' ? buildCanvasPanel() : buildStudioPanel()
    inner.style.height = '100%'
    const wrap = document.createElement('div')
    wrap.style.cssText = 'flex:1;min-height:0;display:none;'
    wrap.append(inner)
    views[id] = wrap
    root.append(wrap)
  }
  function show(id: string): void {
    mount(id)
    for (const t of tabs) {
      const w = views[t.id]
      if (w) w.style.display = t.id === id ? 'flex' : 'none'
      const b = btns[t.id]
      const active = t.id === id
      b.style.background = active ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.25))' : 'transparent'
      b.style.color = active ? 'var(--dsw-alias-label-primary, #eee)' : 'var(--dsw-alias-label-tertiary, #999)'
      b.style.borderBottom = active ? '2px solid var(--dsw-alias-label-primary, #ddd)' : '2px solid transparent'
    }
  }
  for (const t of tabs) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = t.name
    b.style.cssText = 'font-size:13px;font-weight:500;padding:7px 16px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary, #999);cursor:pointer;'
    b.onclick = () => show(t.id)
    btns[t.id] = b
    nav.append(b)
  }

  root.append(bar, nav)
  show('studio')

  // 服务状态 + 模型列表轮询
  async function refresh(): Promise<void> {
    try {
      const res = await fetch(BRIDGE + '/status', { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const s = await res.json()
      const running = !!s.running
      dot.style.background = running ? '#2ea043' : '#d29922'
      label.textContent = running
        ? `ComfyUI 运行中 · ${s.url}${s.pid ? ' · pid ' + s.pid : ''}`
        : 'ComfyUI 未运行 —— 点击「启动服务」'
      startBtn.style.display = running ? 'none' : ''
      stopBtn.style.display = running ? '' : 'none'
    } catch {
      dot.style.background = '#999'
      label.textContent = 'ComfyUI 插件 API 不可用'
    }
    try {
      const mres = await fetch(BRIDGE + '/models', { cache: 'no-store' })
      if (mres.ok) {
        const m = await mres.json()
        const models: string[] = m.models ?? []
        const cur = modelSel.value
        modelSel.innerHTML = ''
        for (const name of models) {
          const opt = document.createElement('option')
          opt.value = name
          opt.textContent = name
          modelSel.append(opt)
        }
        if (models.includes(cur)) modelSel.value = cur
      }
    } catch { /* ignore */ }
  }

  refresh()
  timer = window.setInterval(refresh, 3000)

  return root
}

function buildStudioPanel(): HTMLElement {
  if (studioTimer !== null) { clearInterval(studioTimer); studioTimer = null }

  const SAMPLERS = ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc', 'uni_pc_bh2']
  const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal']

  const input = (v: string, ph: string, w = '100%', type = 'text'): HTMLInputElement => {
    const el = document.createElement('input')
    el.type = type
    el.value = v
    el.placeholder = ph
    el.style.cssText = `width:${w};box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:var(--dsw-alias-bg-base, #1e1e1e);color:var(--dsw-alias-label-primary, #ddd);font-size:12px;`
    return el
  }
  const sel = (opts: string[], v: string): HTMLSelectElement => {
    const el = document.createElement('select')
    for (const o of opts) {
      const opt = document.createElement('option')
      opt.value = o
      opt.textContent = o
      el.append(opt)
    }
    el.value = v
    el.style.cssText = 'width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:var(--dsw-alias-bg-base, #1e1e1e);color:var(--dsw-alias-label-primary, #ddd);font-size:12px;'
    return el
  }
  const field = (labelText: string, control: HTMLElement, grow = true): HTMLDivElement => {
    const wrap = document.createElement('div')
    wrap.style.cssText = `display:flex;flex-direction:column;gap:4px;${grow ? 'flex:1;' : 'flex:none;'}min-width:0;`
    const lb = document.createElement('label')
    lb.textContent = labelText
    lb.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary, #888);'
    wrap.append(lb, control)
    return wrap
  }
  const row = (...els: HTMLElement[]): HTMLDivElement => {
    const r = document.createElement('div')
    r.style.cssText = 'display:flex;gap:10px;align-items:flex-end;'
    r.append(...els)
    return r
  }
  const panel = (): HTMLDivElement => {
    const p = document.createElement('div')
    p.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
    return p
  }

  const root = document.createElement('div')
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;'

  // ── 模式切换 ──
  const modeBar = document.createElement('div')
  modeBar.style.cssText = 'flex:none;display:flex;gap:8px;padding:8px 16px 0;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));'
  const modes = [
    { id: 't2i', name: '文生图' },
    { id: 'i2i', name: '图生图' },
    { id: 'i2v', name: '图生视频' },
  ]
  const modeBtns: Record<string, HTMLButtonElement> = {}
  let activeMode = 't2i'

  const form = document.createElement('div')
  form.style.cssText = 'flex:none;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));display:flex;flex-direction:column;gap:10px;'

  const title = document.createElement('div')
  title.textContent = 'ComfyUI Studio · 文生图'
  title.style.cssText = 'font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary, #eee);'

  const prompt = document.createElement('textarea')
  prompt.placeholder = '提示词（英文效果最佳）…'
  prompt.style.cssText = 'width:100%;box-sizing:border-box;min-height:64px;padding:8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:var(--dsw-alias-bg-base, #1e1e1e);color:var(--dsw-alias-label-primary, #ddd);font-size:13px;resize:vertical;font-family:inherit;'
  const negative = document.createElement('textarea')
  negative.placeholder = '反向提示词（默认空）…'
  negative.style.cssText = prompt.style.cssText + ';min-height:44px;'

  const modelSel = sel([], '')
  const width = input('512', '宽', '100%', 'number')
  const height = input('512', '高', '100%', 'number')
  const steps = input('20', '步数', '100%', 'number')
  const cfg = input('7', 'CFG', '100%', 'number')
  const seed = input('', '种子（空=随机）', '100%', 'number')
  const samplerSel = sel(SAMPLERS, 'euler')
  const schedulerSel = sel(SCHEDULERS, 'normal')

  const statusLine = document.createElement('div')
  statusLine.textContent = '就绪'
  statusLine.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary, #999);flex:1;'

  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.textContent = '生成'
  runBtn.style.cssText = 'font-size:13px;font-weight:600;padding:8px 22px;border-radius:8px;border:none;background:#2ea043;color:#fff;cursor:pointer;'
  runBtn.onmouseenter = () => { if (!runBtn.disabled) runBtn.style.background = '#33b249' }
  runBtn.onmouseleave = () => { if (!runBtn.disabled) runBtn.style.background = '#2ea043' }

  // ── I2I 专属：图片上传 + denoise ──
  const i2iPanel = panel()
  const i2iFile = document.createElement('input')
  i2iFile.type = 'file'
  i2iFile.accept = 'image/png,image/jpeg,image/webp'
  i2iFile.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary, #888);'
  const i2iPreview = document.createElement('img')
  i2iPreview.style.cssText = 'max-width:120px;max-height:120px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));display:none;object-fit:cover;'
  const i2iDenoise = input('0.65', '', '100%', 'number')
  i2iDenoise.min = '0.1'
  i2iDenoise.max = '1'
  i2iDenoise.step = '0.05'
  i2iPanel.append(row(field('参考图片', i2iFile), field('去噪强度 (0.1~1.0)', i2iDenoise)), i2iPreview)
  let i2iUploaded = '' // host input 目录文件名

  // ── I2V 专属：起始帧 + 视频参数 ──
  const i2vPanel = panel()
  const i2vFile = document.createElement('input')
  i2vFile.type = 'file'
  i2vFile.accept = 'image/png,image/jpeg,image/webp'
  i2vFile.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary, #888);'
  const i2vPreview = document.createElement('img')
  i2vPreview.style.cssText = 'max-width:120px;max-height:120px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));display:none;object-fit:cover;'
  const i2vLength = sel(['25', '49', '97', '121'], '97')
  const i2vFps = sel(['16', '24', '30'], '24')
  const i2vStrength = input('0.15', '', '100%', 'number')
  i2vStrength.min = '0'
  i2vStrength.max = '1'
  i2vStrength.step = '0.05'
  const i2vVideoNote = document.createElement('div')
  i2vVideoNote.textContent = '视频模型检测中…'
  i2vVideoNote.style.cssText = 'font-size:11px;color:var(--dsw-alias-state-warning-primary, #d29922);'
  i2vPanel.append(
    row(field('起始帧图片', i2vFile), field('帧数', i2vLength), field('帧率', i2vFps), field('运动强度', i2vStrength)),
    row(i2vPreview, i2vVideoNote),
  )
  let i2vUploaded = ''

  const commonControls = row(
    field('模型', modelSel),
    field('宽', width),
    field('高', height),
    field('步数', steps),
    field('CFG', cfg),
    field('种子', seed),
    field('采样器', samplerSel),
    field('调度器', schedulerSel),
  )

  // ── V3：模板 + 工作流 ──
  const tplSel = sel([], '')
  const tplNote = document.createElement('span')
  tplNote.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary, #999);'
  const wfSel = sel([], '')
  const saveWfBtn = document.createElement('button')
  saveWfBtn.type = 'button'
  saveWfBtn.textContent = '保存工作流'
  saveWfBtn.style.cssText = 'font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary, #ddd);cursor:pointer;'
  const runTplBtn = document.createElement('button')
  runTplBtn.type = 'button'
  runTplBtn.textContent = '运行模板'
  runTplBtn.style.cssText = saveWfBtn.style.cssText
  const tplRow = row(field('模板', tplSel), runTplBtn, field('工作流', wfSel), saveWfBtn)
  const tplNoteRow = document.createElement('div')
  tplNoteRow.style.cssText = 'display:flex;gap:8px;align-items:center;'
  tplNoteRow.append(tplNote)

  form.append(title, i2iPanel, i2vPanel, field('提示词', prompt), field('反向提示词', negative), commonControls, tplRow, tplNoteRow, row(statusLine, runBtn))

  // ── 画廊区 ──
  const galleryWrap = document.createElement('div')
  galleryWrap.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:12px 16px;'
  const gallery = document.createElement('div')
  gallery.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;'
  galleryWrap.append(gallery)

  root.append(modeBar, form, galleryWrap)

  // 模式切换：显示/隐藏专属面板
  function applyMode(): void {
    title.textContent = `ComfyUI Studio · ${modes.find((m) => m.id === activeMode)?.name ?? ''}`
    i2iPanel.style.display = activeMode === 'i2i' ? 'flex' : 'none'
    i2vPanel.style.display = activeMode === 'i2v' ? 'flex' : 'none'
    for (const m of modes) {
      const b = modeBtns[m.id]
      b.style.background = m.id === activeMode ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.25))' : 'transparent'
      b.style.color = m.id === activeMode ? 'var(--dsw-alias-label-primary, #eee)' : 'var(--dsw-alias-label-tertiary, #999)'
    }
  }
  for (const m of modes) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = m.name
    b.style.cssText = 'font-size:13px;font-weight:500;padding:6px 14px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary, #999);cursor:pointer;border-radius:8px 8px 0 0;'
    b.onclick = () => { activeMode = m.id; applyMode() }
    modeBtns[m.id] = b
    modeBar.append(b)
  }
  applyMode()

  // 图片上传：file → base64 → POST upload
  function bindUpload(fileInput: HTMLInputElement, preview: HTMLImageElement, setter: (f: string) => void): void {
    fileInput.onchange = () => {
      const f = fileInput.files?.[0]
      if (!f) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '')
        const base64 = dataUrl.split(',')[1] ?? ''
        void (async () => {
          try {
            const res = await fetch(STUDIO + '/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: f.name, data: base64 }),
            })
            const r = await res.json()
            if (!res.ok || !r.ok) throw new Error(r.error ?? '上传失败')
            setter(r.filename)
            preview.src = dataUrl
            preview.style.display = 'block'
            statusLine.textContent = `已上传: ${r.filename}`
          } catch (e) {
            statusLine.textContent = '上传失败: ' + String(e instanceof Error ? e.message : e)
          }
        })()
      }
      reader.readAsDataURL(f)
    }
  }
  bindUpload(i2iFile, i2iPreview, (f) => { i2iUploaded = f })
  bindUpload(i2vFile, i2vPreview, (f) => { i2vUploaded = f })

  // 视频模型状态
  void (async () => {
    try {
      const res = await fetch(STUDIO + '/video-models', { cache: 'no-store' })
      if (!res.ok) return
      const v = await res.json()
      if (v.ok) {
        i2vVideoNote.textContent = '视频模型就绪 ✓（LTXV 2B + T5xxl）'
        i2vVideoNote.style.color = 'var(--dsw-alias-state-success-primary, #2ea043)'
      } else {
        i2vVideoNote.textContent = '缺少视频模型：' + (v.missing ?? []).map((m: any) => m.name).join(', ') + ' —— 请联系 agent 获取下载指引'
        i2vVideoNote.style.color = 'var(--dsw-alias-state-warning-primary, #d29922)'
      }
    } catch { /* ignore */ }
  })()

  async function loadModels(): Promise<void> {
    try {
      const res = await fetch(BRIDGE + '/models', { cache: 'no-store' })
      if (!res.ok) return
      const m = await res.json()
      const models: string[] = m.models ?? []
      const cur = modelSel.value
      modelSel.innerHTML = ''
      for (const name of models) {
        const opt = document.createElement('option')
        opt.value = name
        opt.textContent = name
        modelSel.append(opt)
      }
      if (models.includes(cur)) modelSel.value = cur
    } catch { /* ignore */ }
  }

  async function generate(preset?: { prompt: string; negative: string; params: any; kind: string }): Promise<void> {
    if (!prompt.value.trim() && !preset) {
      statusLine.textContent = '请先输入提示词'
      return
    }
    const kind = preset?.kind ?? activeMode
    if ((kind === 'i2i' || kind === 'i2v') && !preset) {
      const uploaded = kind === 'i2i' ? i2iUploaded : i2vUploaded
      if (!uploaded) {
        statusLine.textContent = kind === 'i2i' ? '请先上传参考图片' : '请先上传起始帧图片'
        return
      }
    }
    runBtn.disabled = true
    const prev = runBtn.textContent
    runBtn.textContent = kind === 'i2v' ? '生成视频中…（数分钟）' : '生成中…'
    statusLine.textContent = kind === 'i2v' ? '视频生成中（首次加载视频模型较慢）…' : '生成中（首次会加载模型，请稍候）…'
    try {
      const base = preset
        ? { ...preset.params, prompt: preset.prompt, negative: preset.negative, seed: undefined }
        : {
            prompt: prompt.value.trim(),
            negative: negative.value.trim(),
            model: modelSel.value || undefined,
            width: Number(width.value) || 512,
            height: Number(height.value) || 512,
            steps: Number(steps.value) || 20,
            cfg: Number(cfg.value) || 7,
            seed: seed.value === '' ? undefined : Number(seed.value),
            sampler: samplerSel.value,
            scheduler: schedulerSel.value,
          }
      const body: any = { kind, ...base }
      if (kind === 'i2i') {
        body.image = preset ? undefined : i2iUploaded
        body.denoise = Number(i2iDenoise.value) || 0.65
      } else if (kind === 'i2v') {
        body.image = preset ? undefined : i2vUploaded
        body.length = Number(i2vLength.value) || 97
        body.fps = Number(i2vFps.value) || 24
        body.strength = Number(i2vStrength.value) || 0.15
      }
      const res = await fetch(STUDIO + '/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'HTTP ' + res.status)
      const e = data.entry
      const n = (e.images?.length ?? 0) + (e.videos?.length ?? 0)
      statusLine.textContent = `完成 ✓ ${n} 个文件 · seed ${e.params?.seed ?? e.params?.seed ?? '?'}`
      await renderGallery()
    } catch (e) {
      statusLine.textContent = '失败: ' + String(e instanceof Error ? e.message : e)
    } finally {
      runBtn.disabled = false
      runBtn.textContent = prev
    }
  }

  async function renderGallery(): Promise<void> {
    try {
      const res = await fetch(STUDIO + '/history', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      const entries: any[] = data.entries ?? []
      gallery.innerHTML = ''
      if (entries.length === 0) {
        const empty = document.createElement('div')
        empty.textContent = '还没有生成记录 —— 在上方填写提示词，点「生成」开始'
        empty.style.cssText = 'grid-column:1/-1;color:var(--dsw-alias-label-tertiary, #999);font-size:13px;padding:24px 0;text-align:center;'
        gallery.append(empty)
        return
      }
      for (const e of entries) {
        const card = document.createElement('div')
        card.style.cssText = 'border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2));border-radius:10px;overflow:hidden;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base, #161616);'

        const mediaUrl = e.videos?.[0]?.url ?? e.images?.[0]?.url ?? ''
        let media: HTMLElement
        if (e.videos?.[0]) {
          const v = document.createElement('video')
          v.src = e.videos[0].url
          v.controls = true
          v.preload = 'metadata'
          v.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:contain;background:#000;display:block;'
          media = v
        } else {
          const im = document.createElement('img')
          im.src = mediaUrl
          im.loading = 'lazy'
          im.style.cssText = 'width:100%;aspect-ratio:1/1;object-fit:cover;background:#222;display:block;'
          im.onerror = () => { im.style.visibility = 'hidden' }
          media = im
        }
        media.title = e.prompt

        const body = document.createElement('div')
        body.style.cssText = 'padding:8px 10px;display:flex;flex-direction:column;gap:6px;'

        const p = document.createElement('div')
        p.textContent = `[${e.kind}] ${(e.prompt ?? '').slice(0, 70)}${((e.prompt ?? '').length > 70 ? '…' : '')}`
        p.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-primary, #ddd);line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;'

        const pr = e.params ?? {}
        const meta = document.createElement('div')
        meta.textContent = `${pr.width ?? '?'}×${pr.height ?? '?'} · seed ${pr.seed ?? '?'}${pr.denoise ? ' · denoise ' + pr.denoise : ''}${pr.length ? ' · ' + pr.length + '帧' : ''}`
        meta.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-tertiary, #999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

        const btns = document.createElement('div')
        btns.style.cssText = 'display:flex;gap:6px;'
        const again = document.createElement('button')
        again.type = 'button'
        again.textContent = '重新生成'
        again.style.cssText = 'flex:1;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary, #ddd);cursor:pointer;'
        again.onclick = () => { void generate({ prompt: e.prompt, negative: e.negative ?? '', params: pr, kind: e.kind }) }
        const dl = document.createElement('a')
        dl.textContent = '下载'
        dl.href = mediaUrl || '#'
        dl.download = ''
        dl.target = '_blank'
        dl.style.cssText = 'flex:1;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary, #ddd);text-align:center;text-decoration:none;'
        const del = document.createElement('button')
        del.type = 'button'
        del.textContent = '✕'
        del.title = '删除记录'
        del.style.cssText = 'font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary, #999);cursor:pointer;'
        del.onclick = async () => {
          try { await fetch(STUDIO + '/history/delete?id=' + encodeURIComponent(e.id), { method: 'DELETE', cache: 'no-store' }) } catch { /* ignore */ }
          await renderGallery()
        }
        btns.append(again, dl, del)

        body.append(p, meta, btns)
        card.append(media, body)
        gallery.append(card)
      }
    } catch { /* ignore */ }
  }

  runBtn.onclick = () => { void generate() }

  // 模板/工作流加载
  function fillFormFromParams(p: any): void {
    if (!p) return
    if (p.prompt !== undefined) prompt.value = String(p.prompt)
    if (p.negative !== undefined) negative.value = String(p.negative)
    if (p.width !== undefined) width.value = String(p.width)
    if (p.height !== undefined) height.value = String(p.height)
    if (p.steps !== undefined) steps.value = String(p.steps)
    if (p.cfg !== undefined) cfg.value = String(p.cfg)
    if (p.seed !== undefined && p.seed !== null) seed.value = String(p.seed)
    if (p.model !== undefined && modelSel.querySelector(`option[value="${CSS.escape(String(p.model))}"]`)) modelSel.value = String(p.model)
    if (p.denoise !== undefined) i2iDenoise.value = String(p.denoise)
    if (p.length !== undefined) i2vLength.value = String(p.length)
    if (p.fps !== undefined) i2vFps.value = String(p.fps)
    if (p.strength !== undefined) i2vStrength.value = String(p.strength)
  }

  void (async () => {
    try {
      const res = await fetch(STUDIO + '/templates/list', { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json()
      const all = [...(d.builtin ?? []), ...(d.custom ?? [])]
      tplSel.innerHTML = ''
      for (const t of all) {
        const opt = document.createElement('option')
        opt.value = t.id
        opt.textContent = `${t.name}${t.kind === 'custom' ? ' (自定义)' : ''}`
        tplSel.append(opt)
      }
      tplNote.textContent = `模板：内置 ${(d.builtin ?? []).length} 个 · 自定义 ${(d.custom ?? []).length} 个（从 ComfyUI 导出 API JSON 可导入）`
    } catch { /* ignore */ }
  })()

  runTplBtn.onclick = () => {
    if (!tplSel.value) return
    const p: any = {
      prompt: prompt.value.trim(),
      negative: negative.value.trim(),
      model: modelSel.value || undefined,
      width: Number(width.value) || 512,
      height: Number(height.value) || 512,
      steps: Number(steps.value) || 20,
      cfg: Number(cfg.value) || 7,
      seed: seed.value === '' ? undefined : Number(seed.value),
      sampler: samplerSel.value,
      scheduler: schedulerSel.value,
    }
    if (activeMode === 'i2i') { p.image = i2iUploaded; p.denoise = Number(i2iDenoise.value) || 0.65 }
    if (activeMode === 'i2v') { p.image = i2vUploaded; p.length = Number(i2vLength.value) || 97; p.fps = Number(i2vFps.value) || 24; p.strength = Number(i2vStrength.value) || 0.15 }
    void (async () => {
      runBtn.disabled = true
      runTplBtn.disabled = true
      statusLine.textContent = '模板运行中…'
      try {
        const res = await fetch(STUDIO + '/templates/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId: tplSel.value, params: p }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'HTTP ' + res.status)
        statusLine.textContent = `模板完成 ✓ seed ${data.entry.params?.seed ?? '?'}`
        await renderGallery()
      } catch (e) {
        statusLine.textContent = '模板失败: ' + String(e instanceof Error ? e.message : e)
      } finally {
        runBtn.disabled = false
        runTplBtn.disabled = false
      }
    })()
  }

  saveWfBtn.onclick = () => {
    const name = window.prompt('工作流名称', prompt.value.trim().slice(0, 20) || '未命名工作流')
    if (!name) return
    const p: any = {
      prompt: prompt.value.trim(),
      negative: negative.value.trim(),
      model: modelSel.value || undefined,
      width: Number(width.value) || 512,
      height: Number(height.value) || 512,
      steps: Number(steps.value) || 20,
      cfg: Number(cfg.value) || 7,
      seed: seed.value === '' ? undefined : Number(seed.value),
      sampler: samplerSel.value,
      scheduler: schedulerSel.value,
    }
    if (activeMode === 'i2i') { p.image = i2iUploaded; p.denoise = Number(i2iDenoise.value) || 0.65 }
    if (activeMode === 'i2v') { p.image = i2vUploaded; p.length = Number(i2vLength.value) || 97; p.fps = Number(i2vFps.value) || 24; p.strength = Number(i2vStrength.value) || 0.15 }
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/workflows/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, templateId: tplSel.value || 't2i', params: p, kind: activeMode }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'HTTP ' + res.status)
        statusLine.textContent = '已保存工作流: ' + data.workflow.id
        await loadWorkflows()
      } catch (e) {
        statusLine.textContent = '保存失败: ' + String(e instanceof Error ? e.message : e)
      }
    })()
  }

  async function loadWorkflows(): Promise<void> {
    try {
      const res = await fetch(STUDIO + '/workflows', { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json()
      const list: any[] = d.workflows ?? []
      wfSel.innerHTML = ''
      for (const w of list) {
        const opt = document.createElement('option')
        opt.value = w.id
        opt.textContent = w.name
        wfSel.append(opt)
      }
    } catch { /* ignore */ }
  }
  wfSel.onchange = () => {
    if (!wfSel.value) return
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/workflows/load?id=' + encodeURIComponent(wfSel.value), { cache: 'no-store' })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'HTTP ' + res.status)
        fillFormFromParams(d.workflow.params)
        if (d.workflow.kind === 'i2i') { activeMode = 'i2i'; applyMode() }
        if (d.workflow.kind === 'i2v') { activeMode = 'i2v'; applyMode() }
        statusLine.textContent = '已加载工作流: ' + d.workflow.name
      } catch (e) {
        statusLine.textContent = '加载失败: ' + String(e instanceof Error ? e.message : e)
      }
    })()
  }
  void loadWorkflows()

  void loadModels()
  void renderGallery()
  studioTimer = window.setInterval(() => { void renderGallery() }, 5000)

  return root
}
