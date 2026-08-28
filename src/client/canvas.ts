/**
 * 画布面板：参照 ComfyUI 原生的自研节点画布。
 * 支持两类节点：
 *  - 内置便捷节点（t2i/i2i/t2v/i2v/upscale/output）：Host expandNode 展开
 *  - 任意节点（classType 直通）：使用 ComfyUI 全部节点类型（含 custom nodes），
 *    schema 驱动多端口 + 参数表单，连线记录 sourceOutput / targetInput。
 * 交互：左键拖节点、端口拖线、滚轮缩放、中键平移、Ctrl/Delete 删除、工作流保存/加载。
 */
import { createRoot } from 'react-dom/client'
import * as React from 'react'

const STUDIO = '/comfyui-studio/api'

const NODE_TYPES = [
  { type: 't2i', label: '文生图 T2I', group: '生成', color: '#3b82f6', desc: '文本 → 图片' },
  { type: 'i2i', label: '图生图 I2I', group: '生成', color: '#8b5cf6', desc: '图片 + 文本 → 图片' },
  { type: 't2v', label: '文生视频 T2V', group: '生成', color: '#0ea5e9', desc: '文本 → 视频（LTXV）' },
  { type: 'i2v', label: '图生视频 I2V', group: '生成', color: '#06b6d4', desc: '图片 + 文本 → 视频（LTXV）' },
  { type: 'upscale', label: '放大 Upscale', group: '编辑', color: '#f59e0b', desc: '图片放大' },
  { type: 'output', label: '输出 Output', group: '输出', color: '#ef4444', desc: '保存结果图片' },
]
const NODE_COLORS: Record<string, string> = { t2i: '#3b82f6', i2i: '#8b5cf6', t2v: '#0ea5e9', i2v: '#06b6d4', upscale: '#f59e0b', output: '#ef4444' }
const SAMPLERS = ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc', 'uni_pc_bh2']
const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal']
// 内置节点参数 schema（model 特殊：下拉列出 checkpoints）
const BUILTIN_SPEC: Record<string, Record<string, { type: string; options?: string[] }>> = {
  t2i: { prompt: { type: 'STRING' }, negative: { type: 'STRING' }, width: { type: 'INT' }, height: { type: 'INT' }, steps: { type: 'INT' }, cfg: { type: 'FLOAT' }, seed: { type: 'SEED' }, model: { type: 'MODEL' }, sampler: { type: 'COMBO', options: SAMPLERS }, scheduler: { type: 'COMBO', options: SCHEDULERS } },
  i2i: { prompt: { type: 'STRING' }, negative: { type: 'STRING' }, image: { type: 'STRING' }, denoise: { type: 'FLOAT' }, width: { type: 'INT' }, height: { type: 'INT' }, steps: { type: 'INT' }, cfg: { type: 'FLOAT' }, seed: { type: 'SEED' }, model: { type: 'MODEL' }, sampler: { type: 'COMBO', options: SAMPLERS }, scheduler: { type: 'COMBO', options: SCHEDULERS } },
  t2v: { prompt: { type: 'STRING' }, negative: { type: 'STRING' }, width: { type: 'INT' }, height: { type: 'INT' }, length: { type: 'INT' }, fps: { type: 'INT' }, frame_rate: { type: 'INT' }, strength: { type: 'FLOAT' }, steps: { type: 'INT' }, cfg: { type: 'FLOAT' }, seed: { type: 'SEED' } },
  i2v: { prompt: { type: 'STRING' }, negative: { type: 'STRING' }, image: { type: 'STRING' }, width: { type: 'INT' }, height: { type: 'INT' }, length: { type: 'INT' }, fps: { type: 'INT' }, frame_rate: { type: 'INT' }, strength: { type: 'FLOAT' }, steps: { type: 'INT' }, cfg: { type: 'FLOAT' }, seed: { type: 'SEED' } },
  upscale: { width: { type: 'INT' }, height: { type: 'INT' }, method: { type: 'COMBO', options: ['lanczos', 'nearest', 'bilinear'] } },
  output: { prefix: { type: 'STRING' } },
}
const DEFAULT_PARAMS: Record<string, Record<string, any>> = {
  t2i: { prompt: '', negative: '', width: 512, height: 512, steps: 20, cfg: 7, seed: undefined, model: '', sampler: 'euler', scheduler: 'normal' },
  i2i: { prompt: '', negative: '', image: '', denoise: 0.65, width: 512, height: 512, steps: 20, cfg: 7, seed: undefined, model: '', sampler: 'euler', scheduler: 'normal' },
  t2v: { prompt: '', negative: '', width: 768, height: 512, length: 97, fps: 24, frame_rate: 25, strength: 0.15, steps: 20, cfg: 7, seed: undefined },
  i2v: { prompt: '', negative: '', image: '', width: 768, height: 512, length: 97, fps: 24, frame_rate: 25, strength: 0.15, steps: 20, cfg: 7, seed: undefined },
  upscale: { width: 1024, height: 1024, method: 'lanczos' },
  output: { prefix: 'dsh/canvas' },
}

interface CNode {
  id: string
  type: string
  classType?: string
  outputCount?: number
  portInputs?: string[]
  portOutputs?: string[]
  inputSpecs?: Record<string, any>
  x: number
  y: number
  params: Record<string, any>
}
interface CEdge { id: string; source: string; target: string; sourceOutput?: number; targetInput?: string }

const NODE_W = 180
const PORT_Y = 34 // builtin 端口纵向位置
const PORT_TOP = 34 // custom 端口起始行
const PORT_STEP = 22

// 基础类型（表单参数），其余为端口连接类型
const isPrimitive = (t: any): boolean =>
  Array.isArray(t) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'SEED', 'IMAGEUPLOAD', 'COMBO'].includes(String(t))

function nodeSummary(n: CNode): string {
  if (n.classType) return n.classType
  const p = n.params
  if (n.type === 't2i' || n.type === 'i2i') return String(p.prompt ?? '').slice(0, 26) || '(未填提示词)'
  if (n.type === 't2v' || n.type === 'i2v') return `${String(p.prompt ?? '').slice(0, 20) || '(未填提示词)'} · ${p.length ?? 97}帧`
  if (n.type === 'upscale') return `${p.width ?? '?'} × ${p.height ?? '?'}`
  return `${p.prefix ?? 'dsh/canvas'}`
}
function nodeTitle(n: CNode): string {
  if (n.classType) return (n.inputSpecs?.display_name as string) || n.classType
  return NODE_TYPES.find((t) => t.type === n.type)?.label ?? n.type
}
function nodeColor(n: CNode): string {
  if (n.classType) return '#2f9e7e'
  return NODE_COLORS[n.type] ?? '#888'
}

// 端口位置（含 custom 多端口索引）
function portPos(n: CNode, isOut: boolean, index = 0): { x: number; y: number } | null {
  if (n.classType) {
    const list = isOut ? n.portOutputs : n.portInputs
    const i = Math.min(index, (list?.length ?? 1) - 1)
    return { x: n.x + (isOut ? NODE_W : 0), y: n.y + PORT_TOP + i * PORT_STEP }
  }
  return { x: n.x + (isOut ? NODE_W : 0), y: n.y + PORT_Y }
}

function CanvasApp(): React.ReactElement {
  const [nodes, setNodes] = React.useState<CNode[]>([])
  const [edges, setEdges] = React.useState<CEdge[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState('就绪 —— 左侧添加节点，端口拖线连接；滚轮缩放，中键平移')
  const [running, setRunning] = React.useState(false)
  const [resultImgs, setResultImgs] = React.useState<any[]>([])
  const [resultVideos, setResultVideos] = React.useState<any[]>([])
  const [query, setQuery] = React.useState('')
  const [libWidth, setLibWidth] = React.useState(190)
  const [panelWidth, setPanelWidth] = React.useState(270)
  const [connectLine, setConnectLine] = React.useState<{ fromId: string; fromOut: boolean; fromIndex: number; fromInput?: string; x: number; y: number } | null>(null)
  const [dragInfo, setDragInfo] = React.useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [zoom, setZoom] = React.useState(1)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const [panDrag, setPanDrag] = React.useState<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const canvasRef = React.useRef<HTMLDivElement | null>(null)

  // ═══ Agent 画布同步 ═══
  const hostVersionRef = React.useRef(0)
  React.useEffect(() => {
    const sync = (): void => {
      void (async () => {
        try {
          const res = await fetch(STUDIO + '/canvas/state', { cache: 'no-store' })
          if (!res.ok) return
          const s = await res.json()
          if (typeof s.version === 'number' && s.version !== hostVersionRef.current) {
            hostVersionRef.current = s.version
            if (!dragInfo && !connectLine && !panDrag) {
              setNodes(Array.isArray(s.nodes) ? s.nodes : [])
              setEdges(Array.isArray(s.edges) ? s.edges : [])
              setStatus(`已同步 Agent 编排的画布（${(s.nodes ?? []).length} 节点 · v${s.version}）`)
            }
          }
        } catch { /* ignore */ }
      })()
    }
    sync()
    const t = window.setInterval(sync, 2500)
    return () => clearInterval(t)
  }, [])

  // ═══ 全部节点列表（任意节点）═══
  const [allNodes, setAllNodes] = React.useState<any[]>([])
  const [allQuery, setAllQuery] = React.useState('')
  // 模型列表（内置节点 model 下拉）
  const [models, setModels] = React.useState<string[]>([])
  React.useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/comfyui-bridge/api/models', { cache: 'no-store' })
        if (res.ok) { const d = await res.json(); setModels(Array.isArray(d.models) ? d.models : []) }
      } catch { /* ignore */ }
    })()
  }, [])
  React.useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/canvas/nodes', { cache: 'no-store' })
        if (res.ok) {
          const d = await res.json()
          setAllNodes(d.nodes ?? [])
        }
      } catch { /* ignore */ }
    })()
  }, [])
  const addCustomNode = (schema: any) => {
    const params: Record<string, any> = {}
    const portInputs: string[] = []
    for (const [name, spec] of Object.entries(schema.inputs ?? {})) {
      const s = spec as any
      if (Array.isArray(s.type)) params[name] = s.options?.[0] ?? ''
      else if (isPrimitive(s.type)) {
        if (s.type === 'BOOLEAN') params[name] = s.default ?? false
        else if (s.type === 'SEED') params[name] = s.default ?? 0
        else params[name] = s.default ?? (s.type === 'INT' || s.type === 'FLOAT' ? 0 : '')
      } else {
        portInputs.push(name)
        params[name] = '' // 端口类型输入占位（连线时被引用覆盖）
      }
    }
    const portOutputs: string[] = Array.isArray(schema.outputs) ? schema.outputs.map((o: any) => String(o)) : []
    const id = `custom_${Date.now().toString(36)}`
    setNodes((ns) => [...ns, {
      id, type: 'custom', classType: schema.class_type,
      outputCount: Math.max(1, portOutputs.length), portInputs, portOutputs,
      inputSpecs: schema,
      x: 80 + Math.random() * 160, y: 60 + Math.random() * 120, params,
    }])
    setSelected(id)
    setStatus(`已添加节点 ${schema.class_type}`)
  }
  const filteredAll = allNodes.filter((n) => (n.class_type ?? '').toLowerCase().includes(allQuery.toLowerCase()) || (n.display_name ?? '').toLowerCase().includes(allQuery.toLowerCase())).slice(0, 80)

  // ═══ 内置节点添加 ═══
  const addNode = (type: string) => {
    const id = `${type}_${Date.now().toString(36)}`
    const n: CNode = { id, type, x: 80 + Math.random() * 160, y: 60 + Math.random() * 120, params: { ...DEFAULT_PARAMS[type] } }
    setNodes((ns) => [...ns, n])
    setSelected(id)
    setStatus(`已添加「${NODE_TYPES.find((t) => t.type === type)?.label}」`)
  }

  const updateParam = (key: string, value: any) => {
    setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, params: { ...n.params, [key]: value } } : n)))
  }

  // ═══ 节点拖拽 ═══
  const onNodeMouseDown = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const node = nodes.find((n) => n.id === id)
    if (!node) return
    setSelected(id)
    setDragInfo({ id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y })
  }
  React.useEffect(() => {
    if (!dragInfo) return
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - dragInfo.startX) / zoom
      const dy = (ev.clientY - dragInfo.startY) / zoom
      setNodes((ns) => ns.map((n) => (n.id === dragInfo.id ? { ...n, x: dragInfo.origX + dx, y: dragInfo.origY + dy } : n)))
    }
    const onUp = () => setDragInfo(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragInfo, zoom])

  // ═══ 连线 ═══
  const onPortMouseDown = (e: React.MouseEvent, id: string, isOut: boolean, index: number, inputName?: string) => {
    e.preventDefault(); e.stopPropagation()
    setConnectLine({ fromId: id, fromOut: isOut, fromIndex: index, fromInput: inputName, x: e.clientX, y: e.clientY })
  }
  React.useEffect(() => {
    if (!connectLine) return
    const onMove = (ev: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      setConnectLine((l) => l && { ...l, x: (ev.clientX - rect.left - pan.x) / zoom, y: (ev.clientY - rect.top - pan.y) / zoom })
    }
    const onUp = (ev: MouseEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const port = el?.closest?.('[data-port]') as HTMLElement | null
      if (port) {
        const nodeId = port.dataset.nodeId
        const isTargetOut = port.dataset.port === 'out'
        const targetInput = port.dataset.inputName
        const sourceOutput = Number(port.dataset.outputIndex ?? 0)
        const src = connectLine.fromOut ? connectLine.fromId : nodeId
        const tgt = connectLine.fromOut ? nodeId : connectLine.fromId
        if (src && tgt && src !== tgt) {
          const sourceOutputFinal = connectLine.fromOut ? connectLine.fromIndex : sourceOutput
          const targetInputFinal = connectLine.fromOut ? targetInput : connectLine.fromInput
          setEdges((es) => [...es, { id: `e_${Date.now().toString(36)}`, source: src, target: tgt, sourceOutput: sourceOutputFinal, targetInput: targetInputFinal }])
          setStatus('已连接')
        }
      }
      setConnectLine(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [connectLine, pan, zoom])

  // ═══ 滚轮缩放（原生非 passive）/ 中键平移 ═══
  React.useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const newZoom = Math.min(4, Math.max(0.2, zoom * factor))
      setZoom(newZoom)
      setPan({ x: mx - (mx - pan.x) * (newZoom / zoom), y: my - (my - pan.y) * (newZoom / zoom) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, pan])
  const onCanvasMouseDown = (e: React.MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault()
      setSelected(null)
      setPanDrag({ startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y })
    } else if (e.button === 0) setSelected(null)
  }
  React.useEffect(() => {
    if (!panDrag) return
    const onMove = (ev: MouseEvent) => setPan({ x: panDrag.origX + (ev.clientX - panDrag.startX), y: panDrag.origY + (ev.clientY - panDrag.startY) })
    const onUp = () => setPanDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [panDrag])

  // ═══ 键盘删除 ═══
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        setNodes((ns) => ns.filter((n) => n.id !== selected))
        setEdges((es) => es.filter((ed) => ed.source !== selected && ed.target !== selected))
        setSelected(null)
        setStatus('已删除节点及其连线')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  // ═══ 运行 ═══
  const run = () => {
    if (nodes.length === 0) { setStatus('画布为空，请先添加节点'); return }
    setRunning(true)
    setStatus('提交执行中…')
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/canvas/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodes: nodes.map((n) => ({ id: n.id, type: n.type, classType: n.classType, outputCount: n.outputCount, data: { params: n.params } })),
            edges: edges.map((e) => ({ source: e.source, target: e.target, sourceOutput: e.sourceOutput, targetInput: e.targetInput })),
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'HTTP ' + res.status)
        setResultImgs(data.entry?.images ?? [])
        setResultVideos(data.entry?.videos ?? [])
        setStatus(`完成 ✓ ${data.entry?.images?.length ?? 0} 张 / ${data.entry?.videos?.length ?? 0} 视频 · 展开 ${Object.keys(data.workflow ?? {}).length} 个底层节点`)
      } catch (e) {
        setStatus('失败: ' + String(e instanceof Error ? e.message : e))
      } finally {
        setRunning(false)
      }
    })()
  }

  // ═══ 工作流管理 ═══
  const [wfName, setWfName] = React.useState('未命名')
  const [wfList, setWfList] = React.useState<any[]>([])
  const [showWfList, setShowWfList] = React.useState(false)
  const wfRef = React.useRef<HTMLDivElement | null>(null)
  const refreshWfList = async () => {
    try {
      const res = await fetch(STUDIO + '/workflows', { cache: 'no-store' })
      if (res.ok) { const d = await res.json(); setWfList(d.workflows ?? []) }
    } catch { /* ignore */ }
  }
  const newWorkflow = () => { setNodes([]); setEdges([]); setSelected(null); setResultImgs([]); setResultVideos([]); setWfName('未命名'); setShowWfList(false); setStatus('已新建工作流') }
  const saveWorkflow = () => {
    const name = window.prompt('工作流名称', wfName === '未命名' ? '' : wfName)
    if (!name || !name.trim()) return
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/workflows/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), templateId: 'canvas', params: { nodes, edges }, kind: 'canvas' }),
        })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'HTTP ' + res.status)
        setWfName(name.trim()); setShowWfList(false); setStatus('工作流已保存: ' + name.trim()); void refreshWfList()
      } catch (e) { setStatus('保存失败: ' + String(e instanceof Error ? e.message : e)) }
    })()
  }
  const loadWorkflow = (id: string) => {
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/workflows/load?id=' + encodeURIComponent(id), { cache: 'no-store' })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'HTTP ' + res.status)
        const params = d.workflow?.params ?? {}
        setNodes(Array.isArray(params.nodes) ? params.nodes : [])
        setEdges(Array.isArray(params.edges) ? params.edges : [])
        setWfName(d.workflow?.name ?? '未命名'); setShowWfList(false); setStatus('已加载工作流: ' + (d.workflow?.name ?? ''))
      } catch (e) { setStatus('加载失败: ' + String(e instanceof Error ? e.message : e)) }
    })()
  }
  const deleteWorkflow = (id: string, name: string) => {
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/workflows/delete?id=' + encodeURIComponent(id), { method: 'DELETE', cache: 'no-store' })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? '')
        setStatus('已删除工作流: ' + name); void refreshWfList()
      } catch (e) { setStatus('删除失败: ' + String(e instanceof Error ? e.message : e)) }
    })()
  }
  React.useEffect(() => {
    if (!showWfList) return
    const onDown = (e: MouseEvent) => { if (wfRef.current && !wfRef.current.contains(e.target as Node)) setShowWfList(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [showWfList])
  void refreshWfList()

  // ═══ 工作流导出/导入文件 ═══
  const [showExport, setShowExport] = React.useState(false)
  const exportRef = React.useRef<HTMLDivElement | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const downloadJSON = (data: any, filename: string): void => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }
  const exportApi = () => {
    void (async () => {
      try {
        const res = await fetch(STUDIO + '/canvas/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'api' }) })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'HTTP ' + res.status)
        downloadJSON(d.workflow, (wfName === '未命名' ? 'workflow' : wfName) + '-api.json')
        setShowExport(false)
        setStatus('已导出 API 工作流 JSON')
      } catch (e) { setStatus('导出失败: ' + String(e instanceof Error ? e.message : e)) }
    })()
  }
  const exportCanvas = () => {
    downloadJSON({ nodes, edges }, (wfName === '未命名' ? 'workflow' : wfName) + '.json')
    setShowExport(false)
    setStatus('已导出画布 JSON')
  }
  const importFile = (file: File) => {
    void (async () => {
      try {
        const text = await file.text()
        const obj = JSON.parse(text)
        const res = await fetch(STUDIO + '/canvas/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: obj }) })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error ?? 'HTTP ' + res.status)
        setNodes(Array.isArray(d.nodes) ? d.nodes : [])
        setEdges(Array.isArray(d.edges) ? d.edges : [])
        setSelected(null)
        setWfName(file.name.replace(/\.json$/i, ''))
        setStatus(`已导入工作流（${(d.nodes ?? []).length} 节点）`)
      } catch (e) {
        setStatus('导入失败: ' + String(e instanceof Error ? e.message : e))
      }
    })()
  }
  React.useEffect(() => {
    if (!showExport) return
    const onDown = (e: MouseEvent) => { if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExport(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [showExport])

  const filtered = NODE_TYPES.filter((t) => t.label.toLowerCase().includes(query.toLowerCase()) || t.type.includes(query.toLowerCase()))
  const selectedNode = selected ? nodes.find((n) => n.id === selected) ?? null : null
  const barBtn: React.CSSProperties = { fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: '#ddd', cursor: 'pointer' }
  const fieldStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', background: '#111', color: '#ddd', fontSize: 12 }

  // ═══ 画布内容 ═══
  const canvasContent = (): React.ReactElement => {
    const edgeEls = edges.map((e) => {
      const sn = nodes.find((n) => n.id === e.source)
      const tn = nodes.find((n) => n.id === e.target)
      if (!sn || !tn) return null
      const p1 = portPos(sn, true, e.sourceOutput ?? 0)
      const p2 = portPos(tn, false, tn.portInputs ? Math.max(0, (tn.portInputs?.indexOf(e.targetInput ?? '') ?? 0)) : 0)
      if (!p1 || !p2) return null
      const mx = (p1.x + p2.x) / 2
      const d = `M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`
      const isSel = selected === e.id
      return React.createElement('path', {
        key: e.id, d, fill: 'none', stroke: isSel ? '#3b82f6' : '#5a5f68', strokeWidth: (isSel ? 2.5 : 2) / zoom,
        pointerEvents: 'stroke', cursor: 'pointer', onClick: (ev: React.MouseEvent) => { ev.stopPropagation(); setSelected(e.id) },
      })
    })
    const nodeEls = nodes.map((n) => {
      const color = nodeColor(n)
      const isSel = selected === n.id
      const inCount = n.classType ? (n.portInputs?.length ?? 0) : (n.type === 'i2i' || n.type === 'upscale' || n.type === 'output' || n.type === 'i2v' ? 1 : 0)
      const outCount = n.classType ? (n.portOutputs?.length ?? 0) : (n.type === 't2i' || n.type === 'i2i' || n.type === 'upscale' ? 1 : 0)
      const portRows = Math.max(inCount, outCount)
      return React.createElement(
        'div',
        {
          key: n.id, 'data-node-id': n.id,
          onMouseDown: (e: React.MouseEvent) => onNodeMouseDown(e, n.id),
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); setSelected(n.id) },
          style: {
            position: 'absolute', left: n.x, top: n.y, width: NODE_W, zIndex: isSel ? 20 : 10,
            background: '#1b1e24', border: `1px solid ${color}`, borderRadius: 10, boxSizing: 'border-box',
            boxShadow: isSel ? `0 0 0 2px ${color}66, 0 4px 16px rgba(0,0,0,.5)` : '0 2px 8px rgba(0,0,0,.35)',
            cursor: 'grab', userSelect: 'none',
          },
        },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: color, borderRadius: '9px 9px 0 0', fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
          React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', border: '1px solid rgba(255,255,255,.5)', background: 'rgba(255,255,255,.25)', flex: 'none' } }),
          nodeTitle(n),
        ),
        React.createElement('div', { style: { padding: '8px 10px', fontSize: 11, color: '#bbb', lineHeight: 1.4, borderTop: '1px solid rgba(128,128,128,.12)', wordBreak: 'break-all' } }, nodeSummary(n)),
        // 输入端口
        n.classType
          ? (n.portInputs ?? []).map((name, i) =>
              React.createElement('div', {
                key: 'in' + name, 'data-port': 'in', 'data-node-id': n.id, 'data-input-name': name,
                onMouseDown: (e: React.MouseEvent) => onPortMouseDown(e, n.id, false, i, name),
                title: name,
                style: { position: 'absolute', left: -6, top: PORT_TOP + i * PORT_STEP - 6, width: 12, height: 12, borderRadius: '50%', background: '#3b82f6', border: '2px solid #1b1e24', cursor: 'crosshair', boxSizing: 'border-box' },
              }),
            )
          : (n.type === 'i2i' || n.type === 'upscale' || n.type === 'output' || n.type === 'i2v'
              ? React.createElement('div', { 'data-port': 'in', 'data-node-id': n.id, onMouseDown: (e: React.MouseEvent) => onPortMouseDown(e, n.id, false, 0), style: { position: 'absolute', left: -6, top: PORT_Y - 6, width: 12, height: 12, borderRadius: '50%', background: '#3b82f6', border: '2px solid #1b1e24', cursor: 'crosshair', boxSizing: 'border-box' } })
              : null),
        // 输出端口
        n.classType
          ? (n.portOutputs ?? []).map((t, i) =>
              React.createElement('div', {
                key: 'out' + i, 'data-port': 'out', 'data-node-id': n.id, 'data-output-index': String(i),
                onMouseDown: (e: React.MouseEvent) => onPortMouseDown(e, n.id, true, i),
                title: String(t),
                style: { position: 'absolute', right: -6, top: PORT_TOP + i * PORT_STEP - 6, width: 12, height: 12, borderRadius: '50%', background: '#3b82f6', border: '2px solid #1b1e24', cursor: 'crosshair', boxSizing: 'border-box' },
              }),
            )
          : (n.type === 't2i' || n.type === 'i2i' || n.type === 'upscale'
              ? React.createElement('div', { 'data-port': 'out', 'data-node-id': n.id, 'data-output-index': '0', onMouseDown: (e: React.MouseEvent) => onPortMouseDown(e, n.id, true, 0), style: { position: 'absolute', right: -6, top: PORT_Y - 6, width: 12, height: 12, borderRadius: '50%', background: '#3b82f6', border: '2px solid #1b1e24', cursor: 'crosshair', boxSizing: 'border-box' } })
              : null),
        // 端口标签（custom）
        ...(n.classType
          ? [
              ...(n.portInputs ?? []).map((name, i) =>
                React.createElement('span', { key: 'il' + i, style: { position: 'absolute', left: 12, top: PORT_TOP + i * PORT_STEP - 8, fontSize: 9, color: '#8ab4f8', pointerEvents: 'none', whiteSpace: 'nowrap' } }, name.slice(0, 16)),
              ),
              ...(n.portOutputs ?? []).map((t, i) =>
                React.createElement('span', { key: 'ol' + i, style: { position: 'absolute', right: 12, top: PORT_TOP + i * PORT_STEP - 8, fontSize: 9, color: '#8ab4f8', pointerEvents: 'none', whiteSpace: 'nowrap' } }, String(t).slice(0, 12)),
              ),
            ]
          : []),
        // 占位高度（多端口时撑开）
        portRows > 0 ? React.createElement('div', { style: { height: portRows * PORT_STEP - 8 } }) : null,
      )
    })
    return React.createElement(
      'div', { style: { position: 'absolute', inset: 0, overflow: 'hidden' } },
      React.createElement('div', { style: { position: 'absolute', left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' } },
        React.createElement('svg', { style: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, pointerEvents: 'none', overflow: 'visible' } }, ...edgeEls),
        ...nodeEls,
        connectLine
          ? (() => {
              const from = portPos(nodes.find((n) => n.id === connectLine.fromId) as CNode, connectLine.fromOut, connectLine.fromIndex)
              if (!from) return null
              const d = `M ${from.x} ${from.y} C ${(from.x + connectLine.x) / 2} ${from.y}, ${(from.x + connectLine.x) / 2} ${connectLine.y}, ${connectLine.x} ${connectLine.y}`
              return React.createElement('svg', { style: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, pointerEvents: 'none', overflow: 'visible', zIndex: 30 } },
                React.createElement('path', { d, fill: 'none', stroke: '#3b82f6', strokeWidth: 2 / zoom, strokeDasharray: '6 3' }),
              )
            })()
          : null,
      ),
    )
  }

  return React.createElement(
    'div', { style: { display: 'flex', flexDirection: 'column', height: '100%', width: '100%', minHeight: 0 } },
    // ── 顶栏 ──
    React.createElement('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(128,128,128,.2)', background: '#171a1f' } },
      React.createElement('span', { style: { fontSize: 13, fontWeight: 600, color: '#eee' } }, '工作流画布'),
      React.createElement('div', { ref: wfRef, style: { position: 'relative', display: 'flex', alignItems: 'center' } },
        React.createElement('button', { type: 'button', onClick: () => setShowWfList((v) => !v), style: { ...barBtn, fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `工作流: ${wfName} ▾`),
        showWfList ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 240, maxHeight: 280, overflowY: 'auto', background: '#1b1e24', border: '1px solid rgba(128,128,128,.3)', borderRadius: 8, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,.4)', padding: 4 } },
          wfList.length === 0 ? React.createElement('div', { style: { padding: '10px 12px', fontSize: 12, color: '#888' } }, '暂无已保存的工作流 —— 点「保存」创建')
          : wfList.map((w) => React.createElement('div', {
              key: w.id, onClick: () => loadWorkflow(w.id),
              onMouseEnter: (e: React.MouseEvent) => { e.currentTarget.style.background = 'rgba(128,128,128,.15)' },
              onMouseLeave: (e: React.MouseEvent) => { e.currentTarget.style.background = 'transparent' },
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#ddd' },
            },
            React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w.name),
            React.createElement('span', { style: { flex: 'none', fontSize: 10, color: '#666' } }, (w.createdAt ? new Date(w.createdAt).toLocaleDateString() : '')),
            React.createElement('span', { style: { flex: 'none', color: '#f66', cursor: 'pointer', padding: '0 4px' }, onClick: (e: React.MouseEvent) => { e.stopPropagation(); deleteWorkflow(w.id, w.name) } }, '✕'),
          )),
        ) : null,
      ),
      React.createElement('button', { type: 'button', onClick: newWorkflow, style: barBtn }, '新建'),
      React.createElement('button', { type: 'button', onClick: saveWorkflow, style: barBtn }, '保存'),
      // 导出/导入
      React.createElement('div', { ref: exportRef, style: { position: 'relative', display: 'flex', alignItems: 'center' } },
        React.createElement('button', { type: 'button', onClick: () => setShowExport((v) => !v), style: barBtn }, '导出 ▾'),
        showExport ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 150, background: '#1b1e24', border: '1px solid rgba(128,128,128,.3)', borderRadius: 8, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,.4)', padding: 4, display: 'flex', flexDirection: 'column', gap: 2 } },
          React.createElement('button', { type: 'button', onClick: exportApi, style: { ...barBtn, border: 'none', textAlign: 'left', padding: '7px 10px' } }, 'API 工作流 JSON'),
          React.createElement('button', { type: 'button', onClick: exportCanvas, style: { ...barBtn, border: 'none', textAlign: 'left', padding: '7px 10px' } }, '画布 JSON'),
        ) : null,
      ),
      React.createElement('input', { ref: fileInputRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = '' } }),
      React.createElement('button', { type: 'button', onClick: () => fileInputRef.current?.click(), style: barBtn }, '导入'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { type: 'button', onClick: run, disabled: running, style: { ...barBtn, border: 'none', background: '#2ea043', color: '#fff', fontWeight: 600, opacity: running ? 0.6 : 1 } }, running ? '运行中…' : '▶ 运行'),
    ),
    // ── 主体 ──
    React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' } },
      // 左侧节点库
      React.createElement('div', { style: { flex: 'none', width: libWidth, display: 'flex', flexDirection: 'column', background: '#171a1f', boxSizing: 'border-box' } },
        React.createElement('div', { style: { padding: '10px 12px 6px', fontSize: 11, color: '#888', fontWeight: 600 } }, '快捷节点'),
        React.createElement('div', { style: { flex: 'none', overflowY: 'auto', maxHeight: 170, padding: '0 10px 6px', display: 'flex', flexDirection: 'column', gap: 4 } },
          ...['生成', '编辑', '输出'].map((grp) => {
            const items = filtered.filter((t) => t.group === grp)
            if (items.length === 0) return null
            return React.createElement('div', { key: grp, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              React.createElement('div', { style: { fontSize: 10, color: '#666', padding: '4px 2px 2px' } }, grp),
              ...items.map((t) => React.createElement('button', {
                key: t.type, type: 'button', onClick: () => addNode(t.type), title: t.desc,
                style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.2)', background: 'transparent', color: '#ddd', cursor: 'pointer', fontSize: 12, textAlign: 'left' },
              },
                React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: t.color, flex: 'none' } }),
                t.label,
              )),
            )
          }),
        ),
        React.createElement('div', { style: { borderTop: '1px solid rgba(128,128,128,.15)', padding: '8px 10px', fontSize: 11, color: '#888', fontWeight: 600 } }, '全部节点'),
        React.createElement('div', { style: { padding: '0 10px 8px' } },
          React.createElement('input', { value: allQuery, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAllQuery(e.target.value), placeholder: '搜索任意节点…', style: fieldStyle }),
        ),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 4 } },
          filteredAll.length === 0 && !allQuery
            ? React.createElement('div', { style: { fontSize: 11, color: '#666', padding: 4 } }, '输入关键词搜索 ComfyUI 全部节点（含插件节点）')
            : filteredAll.map((n) => React.createElement('button', {
                key: n.class_type, type: 'button', onClick: () => addCustomNode(n), title: n.class_type,
                style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.15)', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: 11, textAlign: 'left' },
              },
                React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: '#2f9e7e', flex: 'none' } }),
                React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, n.class_type),
              )),
        ),
      ),
      React.createElement('div', { style: { flex: 'none', width: 8, cursor: 'col-resize', background: 'transparent' }, onMouseDown: (e: React.MouseEvent) => startResize(e, 'lib', libWidth, setLibWidth) }),
      // 中间画布
      React.createElement('div', { ref: canvasRef, onMouseDown: onCanvasMouseDown, style: { flex: 1, minWidth: 0, position: 'relative', background: '#111318', overflow: 'hidden' } }, canvasContent()),
      // 右侧参数面板
      selectedNode
        ? React.createElement(React.Fragment, null,
            React.createElement('div', { style: { flex: 'none', width: 8, cursor: 'col-resize', background: 'transparent' }, onMouseDown: (e: React.MouseEvent) => startResize(e, 'panel', panelWidth, setPanelWidth) }),
            React.createElement('div', { style: { flex: 'none', width: panelWidth, background: '#171a1f', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' } },
              React.createElement('div', { style: { flex: 'none', padding: '10px 12px', borderBottom: '1px solid rgba(128,128,128,.2)', fontSize: 13, fontWeight: 600, color: '#eee', display: 'flex', alignItems: 'center', gap: 6 } },
                React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: nodeColor(selectedNode), display: 'inline-block' } }),
                React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, nodeTitle(selectedNode)),
              ),
              React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 } },
                ...Object.entries(selectedNode.params).map(([k, v]) => {
                  const spec = selectedNode.classType
                    ? (selectedNode.inputSpecs?.inputs?.[k] as any)
                    : BUILTIN_SPEC[selectedNode.type]?.[k]
                  const isCombo = spec && (Array.isArray(spec.type) || spec.type === 'COMBO')
                  const isBool = spec && spec.type === 'BOOLEAN'
                  const isModel = k === 'model' && !selectedNode.classType
                  const isNumber = spec && (spec.type === 'INT' || spec.type === 'FLOAT' || spec.type === 'SEED')
                  // 图片文件参数：本地上传 + 下拉 + 预览
                  const isImageFile = (k === 'image' && !isCombo) || (isCombo && k.toLowerCase().includes('image'))
                  if (spec && !isCombo && !isBool && !isNumber && !isPrimitive(spec.type) && !isModel && !isImageFile) return null
                  const options = isModel ? models : (spec?.options ?? (Array.isArray(spec?.type) ? spec.type : undefined))
                  if (isImageFile) {
                    return React.createElement('div', { key: k, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      React.createElement('label', { style: { fontSize: 11, color: '#999' } }, k),
                      React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        React.createElement('button', {
                          type: 'button',
                          onClick: () => {
                            const input = document.createElement('input')
                            input.type = 'file'
                            input.accept = 'image/*'
                            input.onchange = () => {
                              const f = input.files?.[0]
                              if (!f) return
                              const reader = new FileReader()
                              reader.onload = () => {
                                const base64 = String(reader.result ?? '').split(',')[1]
                                void (async () => {
                                  try {
                                    const res = await fetch(STUDIO + '/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, data: base64 }) })
                                    const d = await res.json()
                                    if (!res.ok || !d.ok) throw new Error(d.error ?? '上传失败')
                                    updateParam(k, d.filename)
                                    setStatus('已上传图片: ' + d.filename)
                                  } catch (e) { setStatus('上传失败: ' + String(e instanceof Error ? e.message : e)) }
                                })()
                              }
                              reader.readAsDataURL(f)
                            }
                            input.click()
                          },
                          style: { ...barBtn, fontSize: 11, padding: '5px 10px', flex: 'none' },
                        }, '上传图片'),
                        React.createElement('select', { value: v ?? '', onChange: (e: React.ChangeEvent<HTMLSelectElement>) => updateParam(k, e.target.value), style: fieldStyle },
                          (options ?? []).length === 0
                            ? React.createElement('option', { key: '', value: '' }, '(无文件)')
                            : (options ?? []).map((o: any) => React.createElement('option', { key: String(o), value: String(o) }, String(o))),
                        ),
                      ),
                      v ? React.createElement('img', { src: `http://127.0.0.1:8188/view?filename=${encodeURIComponent(String(v))}&subfolder=&type=input`, style: { maxWidth: '100%', maxHeight: 90, borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', objectFit: 'contain', background: '#000' }, onError: (e: React.SyntheticEvent<HTMLImageElement>) => { (e.target as HTMLImageElement).style.display = 'none' } }) : null,
                    )
                  }
                  return React.createElement('label', { key: k, style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#999' } },
                    k,
                    isCombo || isModel
                      ? React.createElement('select', { value: v ?? '', onChange: (e: React.ChangeEvent<HTMLSelectElement>) => updateParam(k, e.target.value), style: fieldStyle },
                          (options ?? []).length === 0
                            ? React.createElement('option', { key: '', value: '' }, '(空)')
                            : (options ?? []).map((o: any) => React.createElement('option', { key: String(o), value: String(o) }, String(o))),
                        )
                      : isBool
                        ? React.createElement('input', { type: 'checkbox', checked: !!v, onChange: (e: React.ChangeEvent<HTMLInputElement>) => updateParam(k, e.target.checked), style: { width: 16, height: 16 } })
                        : (k === 'prompt' || k === 'negative' || (spec && spec.type === 'STRING' && String(v ?? '').length > 40))
                          ? React.createElement('textarea', { value: v ?? '', rows: k === 'prompt' ? 3 : 2, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => updateParam(k, e.target.value), style: { ...fieldStyle, resize: 'vertical', fontFamily: 'inherit' } })
                          : React.createElement('input', {
                              type: isNumber ? 'number' : 'text',
                              value: v ?? '',
                              onChange: (e: React.ChangeEvent<HTMLInputElement>) => updateParam(k, isNumber ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value),
                              style: fieldStyle,
                            }),
                  )
                }),
                selectedNode.classType
                  ? React.createElement('div', { style: { fontSize: 11, color: '#d29922', lineHeight: 1.5 } }, '端口类型参数（IMAGE/LATENT/MODEL 等）需用连线提供；下拉/数值/文本在此直接填写')
                  : null,
                React.createElement('button', { type: 'button', onClick: () => {
                  setNodes((ns) => ns.filter((n) => n.id !== selectedNode.id))
                  setEdges((es) => es.filter((ed) => ed.source !== selectedNode.id && ed.target !== selectedNode.id))
                  setSelected(null)
                  setStatus('已删除节点及其连线')
                }, style: { ...barBtn, color: '#f66', borderColor: 'rgba(246,102,102,.4)' } }, '删除节点'),
              ),
            ),
          )
        : null,
    ),
    // ── 底栏 ──
    React.createElement('div', { style: { flex: 'none', padding: '6px 12px', borderTop: '1px solid rgba(128,128,128,.2)', fontSize: 12, color: '#999', display: 'flex', gap: 10, alignItems: 'center', background: '#171a1f' } },
      React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, status),
      ...resultVideos.slice(0, 3).map((v) => React.createElement('a', { key: v.filename, href: v.url, target: '_blank', style: { flex: 'none' } },
        React.createElement('video', { src: v.url, controls: true, preload: 'metadata', style: { height: 44, borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', display: 'block', background: '#000' } }),
      )),
      ...resultImgs.slice(0, 6).map((img) => React.createElement('a', { key: img.filename, href: img.url, target: '_blank', style: { flex: 'none' } },
        React.createElement('img', { src: img.url, style: { height: 44, borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', display: 'block' } }),
      )),
    ),
  )
}

function startResize(e: React.MouseEvent, which: 'lib' | 'panel', startW: number, setW: (w: number) => void): void {
  e.preventDefault(); e.stopPropagation()
  const startX = e.clientX
  const onMove = (ev: MouseEvent) => {
    const dx = which === 'lib' ? ev.clientX - startX : startX - ev.clientX
    setW(Math.min(520, Math.max(140, startW + dx)))
  }
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

export function buildCanvasPanel(): HTMLElement {
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;width:100%;position:relative;'
  try {
    if (!createRoot) throw new Error('react-dom/client 未就绪')
    const root = createRoot(host)
    root.render(React.createElement(CanvasApp))
  } catch (e) {
    host.textContent = '画布加载失败: ' + String(e instanceof Error ? e.message : e)
    host.style.cssText += ';align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary, #999);font-size:13px;padding:16px;text-align:center;'
  }
  return host
}
