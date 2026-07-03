import { Alert, Button, Drawer, Empty, Input, List, Modal, Space, Tag, Typography, message } from "antd"
import { useCallback, useEffect, useState } from "react"
import { api, type Artifact } from "./api"

function DiffView({ id }: { id: number }) {
  const [diff, setDiff] = useState<{ approved: string | null; current: string | null } | null>(null)
  useEffect(() => {
    api.diff(id).then(setDiff)
  }, [id])
  if (!diff) return null
  if (diff.approved === null) {
    return (
      <div>
        <Alert type="info" message="首次送审,无已批版本可比对——展示当前全文" style={{ marginBottom: 8 }} showIcon />
        <pre style={paneStyle}>{diff.current ?? "(空)"}</pre>
      </div>
    )
  }
  const approvedLines = new Set(diff.approved.split("\n"))
  const currentLines = new Set((diff.current ?? "").split("\n"))
  const render = (text: string, other: Set<string>, color: string) => (
    <pre style={paneStyle}>
      {text.split("\n").map((line, i) => (
        <div key={i} style={{ background: other.has(line) ? undefined : color, minHeight: 18 }}>
          {line || " "}
        </div>
      ))}
    </pre>
  )
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ flex: 1 }}>
        <Typography.Text type="secondary">已批版本</Typography.Text>
        {render(diff.approved, currentLines, "#fff1f0")}
      </div>
      <div style={{ flex: 1 }}>
        <Typography.Text type="secondary">当前版本</Typography.Text>
        {render(diff.current ?? "", approvedLines, "#f6ffed")}
      </div>
    </div>
  )
}

const paneStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: "18px",
  background: "#fafafa",
  padding: 8,
  maxHeight: "55vh",
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all"
}

export function ReviewQueue({ open, onClose, onActed }: { open: boolean; onClose: () => void; onActed: () => void }) {
  const [queue, setQueue] = useState<Artifact[]>([])
  const [active, setActive] = useState<Artifact | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [rejecting, setRejecting] = useState(false)

  const load = useCallback(() => {
    api.reviewQueue().then(rows => {
      setQueue(rows)
      setActive(prev => (prev ? rows.find(r => r.id === prev.id) ?? rows[0] ?? null : rows[0] ?? null))
    })
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const act = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn()
      message.success(label)
      load()
      onActed()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Drawer open={open} onClose={onClose} width="82%" title={`待审队列 (${queue.length})`} destroyOnHidden>
      {queue.length === 0 ? (
        <Empty description="没有待审产物" />
      ) : (
        <div style={{ display: "flex", gap: 16, height: "100%" }}>
          <List
            style={{ width: 360, overflow: "auto", borderRight: "1px solid #f0f0f0", paddingRight: 8 }}
            size="small"
            dataSource={queue}
            renderItem={a => (
              <List.Item
                style={{ cursor: "pointer", background: active?.id === a.id ? "#e6f4ff" : undefined }}
                onClick={() => setActive(a)}
              >
                <Space direction="vertical" size={0}>
                  <Space size={4}>
                    <Tag>{a.kind}</Tag>
                    <Tag color={a.review_status === "invalidated" ? "red" : "gold"}>
                      {a.review_status === "invalidated" ? "已失效" : a.ever_approved ? "复审中" : "待审"}
                    </Tag>
                  </Space>
                  <Typography.Text style={{ fontSize: 12 }}>{a.path}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
          <div style={{ flex: 1, overflow: "auto" }}>
            {active && (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" onClick={() => act(() => api.approve(active.id), "已审批通过")}>
                    通过
                  </Button>
                  <Button onClick={() => act(() => api.approve(active.id, true), "trivial 通过(已 re-bless 下游)")}>
                    trivial 通过
                  </Button>
                  <Button danger onClick={() => setRejecting(true)}>
                    打回
                  </Button>
                  {active.review_status === "invalidated" && (
                    <Button onClick={() => act(() => api.submit(active.id), "已重新送审")}>重新送审</Button>
                  )}
                </Space>
                <DiffView id={active.id} />
              </>
            )}
          </div>
        </div>
      )}
      <Modal
        open={rejecting}
        title="打回原因(必填,会进事件流)"
        onCancel={() => setRejecting(false)}
        onOk={async () => {
          if (!active) return
          await act(() => api.reject(active.id, rejectReason), "已打回")
          setRejecting(false)
          setRejectReason("")
        }}
      >
        <Input.TextArea rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
      </Modal>
    </Drawer>
  )
}
