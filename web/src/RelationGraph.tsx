import { Button, Drawer, Empty, Input, List, Select, Space, Tag, Typography, message } from "antd"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type Node
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import dagre from "@dagrejs/dagre"
import { api, type GraphEdge, type GraphNode } from "./api"
import { MONO } from "./ui"
import { t } from "./i18n"

/** 审批状态 → 节点配色(与树/队列口径一致的四态) */
const REVIEW_STYLE: Record<string, { bg: string; border: string }> = {
  approved: { bg: "rgba(47,189,175,0.14)", border: "#2fbdaf" },
  pending: { bg: "rgba(250,173,20,0.14)", border: "#d89614" },
  invalidated: { bg: "rgba(255,77,79,0.14)", border: "#d32029" },
  draft: { bg: "rgba(140,140,140,0.10)", border: "#8c8c8c" }
}

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: 230, height: 52 })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return nodes.map(n => {
    const p = g.node(n.id)
    return { ...n, position: { x: p.x - 115, y: p.y - 26 } }
  })
}

function toFlow(nodes: GraphNode[], edges: GraphEdge[], highlight: string): { nodes: Node[]; edges: Edge[] } {
  const fNodes: Node[] = nodes.map(n => {
    const s = REVIEW_STYLE[n.review_status] ?? REVIEW_STYLE.draft
    const hit = highlight !== "" && n.path.toLowerCase().includes(highlight)
    return {
      id: String(n.id),
      position: { x: 0, y: 0 },
      data: {
        label: (
          <div title={n.path} style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.4, textAlign: "left" }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
              {n.path.split("/").pop()}
            </div>
            <span style={{ opacity: 0.65 }}>
              {n.kind}
              {n.module ? ` · ${n.module}` : ""}
              {n.missing ? " · ⚠missing" : ""}
            </span>
          </div>
        )
      },
      style: {
        background: s.bg,
        border: `${hit ? 2.5 : 1.5}px ${n.missing ? "dashed" : "solid"} ${hit ? "#c41d7f" : s.border}`,
        borderRadius: 8,
        padding: "6px 10px",
        width: 230,
        opacity: n.missing ? 0.6 : 1
      }
    }
  })
  const fEdges: Edge[] = edges.map(e => ({
    id: String(e.id),
    source: String(e.from_id),
    target: String(e.to_id),
    markerEnd: { type: MarkerType.ArrowClosed },
    style:
      e.source === "manual"
        ? { stroke: "#2f6bbd", strokeWidth: 2, strokeDasharray: "6 3" }
        : { stroke: "#999", strokeWidth: 1.2 },
    label: e.source === "manual" ? t("手动", "manual") : undefined,
    data: { source: e.source, dbId: e.id }
  }))
  return { nodes: layout(fNodes, fEdges), edges: fEdges }
}

export function RelationGraph({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [raw, setRaw] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const [moduleFilter, setModuleFilter] = useState<string | undefined>()
  const [q, setQ] = useState("")
  const [files, setFiles] = useState<string[]>([])
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout>>()

  const load = useCallback(() => {
    api.graph().then(setRaw)
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  // SSE:任何事件 400ms 去抖后重载(scan/审批/建边都会产生事件)
  useEffect(() => {
    if (!open) return
    const es = new EventSource("/api/sse")
    let timer: ReturnType<typeof setTimeout>
    es.onmessage = () => {
      clearTimeout(timer)
      timer = setTimeout(load, 400)
    }
    return () => {
      clearTimeout(timer)
      es.close()
    }
  }, [open, load])

  // 未登记文件搜索(去抖)
  useEffect(() => {
    clearTimeout(debounce.current)
    if (!q.trim()) {
      setFiles([])
      return
    }
    debounce.current = setTimeout(() => api.searchFiles(q).then(r => setFiles(r.files)), 300)
  }, [q])

  const filtered = useMemo(() => {
    const nodes = moduleFilter ? raw.nodes.filter(n => n.module === moduleFilter || n.module === null) : raw.nodes
    const ids = new Set(nodes.map(n => n.id))
    return { nodes, edges: raw.edges.filter(e => ids.has(e.from_id) && ids.has(e.to_id)) }
  }, [raw, moduleFilter])

  const flow = useMemo(() => toFlow(filtered.nodes, filtered.edges, q.trim().toLowerCase()), [filtered, q])
  const modules = useMemo(
    () => [...new Set(raw.nodes.map(n => n.module).filter((m): m is string => !!m))].sort(),
    [raw]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return
      api
        .addEdge(Number(c.source), Number(c.target))
        .then(() => {
          message.success(t("已声明手动关系(参与失效传播)", "Manual relation added (joins invalidation propagation)"))
          load()
        })
        .catch(e => message.error(String((e as Error).message ?? e)))
    },
    [load]
  )

  const unbind = useCallback(() => {
    if (!selectedEdge) return
    api
      .removeEdge(Number((selectedEdge.data as { dbId: number }).dbId))
      .then(() => {
        message.success(t("已解绑", "Unbound"))
        setSelectedEdge(null)
        load()
      })
      .catch(e => message.error(String((e as Error).message ?? e)))
  }, [selectedEdge, load])

  const addFile = useCallback(
    (path: string) => {
      api
        .registerFile(path)
        .then(() => {
          message.success(t(`已登记并加入图:${path}`, `Registered & added: ${path}`))
          setFiles(f => f.filter(x => x !== path))
          load()
        })
        .catch(e => message.error(String((e as Error).message ?? e)))
    },
    [load]
  )

  return (
    <Drawer open={open} onClose={onClose} width="92%" title={t("产出物关系图", "Artifact relation graph")} destroyOnHidden>
      <Space style={{ marginBottom: 10 }} wrap>
        <Select
          allowClear
          placeholder={t("按模块过滤", "Filter by module")}
          style={{ width: 200 }}
          value={moduleFilter}
          onChange={setModuleFilter}
          options={modules.map(m => ({ label: m, value: m }))}
        />
        <Input.Search
          allowClear
          placeholder={t("按名字索引(高亮已登记 / 列出未登记)", "Search by name")}
          style={{ width: 340 }}
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        {selectedEdge && (selectedEdge.data as { source: string }).source === "manual" && (
          <Button danger size="small" onClick={unbind}>
            {t("解绑选中的手动关系", "Unbind selected manual edge")}
          </Button>
        )}
        {selectedEdge && (selectedEdge.data as { source: string }).source === "derived" && (
          <Tag>{t("自动推导的关系不可解绑", "Derived edges cannot be unbound")}</Tag>
        )}
      </Space>
      {files.length > 0 && (
        <List
          size="small"
          style={{ marginBottom: 10, maxHeight: 140, overflow: "auto" }}
          header={
            <Typography.Text type="secondary">
              {t("未登记文件(点击登记并加入图)", "Unregistered files (click to register & add)")}
            </Typography.Text>
          }
          dataSource={files}
          renderItem={p => (
            <List.Item
              style={{ cursor: "pointer", fontFamily: MONO, fontSize: 12 }}
              onClick={() => addFile(p)}
              actions={[
                <Button key="add" size="small" type="link">
                  {t("登记并加入", "Add")}
                </Button>
              ]}
            >
              {p}
            </List.Item>
          )}
        />
      )}
      <div
        style={{
          height: "calc(100% - 110px)",
          minHeight: 420,
          border: "1px solid rgba(128,128,128,0.25)",
          borderRadius: 10
        }}
      >
        {flow.nodes.length === 0 ? (
          <Empty style={{ paddingTop: 80 }} description={t("暂无产物(先 scan)", "No artifacts yet (run scan)")} />
        ) : (
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            onConnect={onConnect}
            onEdgeClick={(_, edge) => setSelectedEdge(edge)}
            onPaneClick={() => setSelectedEdge(null)}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
            nodesDraggable
            nodesConnectable
            edgesFocusable
          >
            <Background />
            <Controls />
          </ReactFlow>
        )}
      </div>
    </Drawer>
  )
}
