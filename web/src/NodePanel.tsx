import { Drawer, Empty, List, Space, Table, Tabs, Tag, Timeline, Typography } from "antd"
import { useEffect, useState } from "react"
import { api, type Artifact, type Task, type TreeNode, type WbEvent } from "./api"
import { ArtifactViewer } from "./viewers/ArtifactViewer"

const REVIEW_TAG: Record<string, { color: string; text: string }> = {
  draft: { color: "default", text: "草稿" },
  pending: { color: "gold", text: "待审" },
  approved: { color: "green", text: "已审批" },
  invalidated: { color: "red", text: "已失效" }
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: "default", text: "待领取" },
  in_progress: { color: "blue", text: "进行中" },
  completed: { color: "green", text: "已完成" },
  cancelled: { color: "red", text: "已取消" }
}

function eventLabel(e: WbEvent): string {
  const payload = e.payload ? (JSON.parse(e.payload) as Record<string, unknown>) : {}
  const extra = e.event === "note" ? `:${payload.content}` : ""
  return `[${e.event}] ${e.actor}${extra}`
}

export function NodePanel({ node, liveEvents }: { node: TreeNode | null; liveEvents: WbEvent[] }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [viewing, setViewing] = useState<Artifact | null>(null)

  useEffect(() => {
    if (!node) return
    const q =
      node.key === "__project__" || node.key === "__meta__"
        ? { module: node.key }
        : { module: node.module ?? undefined, endpoint: node.endpoint ?? undefined, page: node.page ?? undefined }
    if (node.key === "__root__") {
      setArtifacts([])
      setTasks([])
      return
    }
    api.node(q).then(d => {
      setArtifacts(d.artifacts)
      setTasks(d.tasks)
    })
  }, [node, liveEvents.length])

  if (!node) {
    return (
      <div style={{ padding: 48 }}>
        <Empty description="选择左侧节点查看产物与任务" />
        <EventFeed events={liveEvents} />
      </div>
    )
  }

  return (
    <div style={{ padding: "12px 20px" }}>
      <Space align="baseline">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {node.title}
        </Typography.Title>
        <Typography.Text type="secondary">{node.phase}</Typography.Text>
      </Space>

      <Tabs
        items={[
          {
            key: "artifacts",
            label: `产物 (${artifacts.length})`,
            children: (
              <List
                size="small"
                dataSource={artifacts}
                renderItem={a => {
                  const tag = REVIEW_TAG[a.review_status]
                  return (
                    <List.Item
                      style={{ cursor: "pointer" }}
                      onClick={() => setViewing(a)}
                      actions={[
                        a.kind === "prototype" && a.endorsed ? <Tag color="green">👍 已放行</Tag> : null,
                        <Tag color={tag.color}>{a.review_status === "pending" && a.ever_approved ? "复审中(禁用)" : tag.text}</Tag>
                      ].filter(Boolean)}
                    >
                      <Space>
                        <Tag>{a.kind}</Tag>
                        <Typography.Text style={{ fontSize: 13 }}>{a.path}</Typography.Text>
                      </Space>
                    </List.Item>
                  )
                }}
              />
            )
          },
          {
            key: "tasks",
            label: `任务 (${tasks.length})`,
            children: (
              <Table
                size="small"
                rowKey="id"
                pagination={{ pageSize: 15 }}
                dataSource={tasks}
                columns={[
                  { title: "ID", dataIndex: "id", width: 60 },
                  { title: "角色", dataIndex: "role", width: 130 },
                  { title: "类型", dataIndex: "type", width: 80, render: t => <Tag>{t}</Tag> },
                  {
                    title: "状态",
                    dataIndex: "status",
                    width: 110,
                    render: (s: string, row: Task) => (
                      <Space size={4}>
                        <Tag color={STATUS_TAG[s]?.color}>{STATUS_TAG[s]?.text ?? s}</Tag>
                        {row.stale && <Tag color="orange">stale</Tag>}
                      </Space>
                    )
                  },
                  { title: "执行人", dataIndex: "assignee", width: 120 },
                  { title: "内容", dataIndex: "content", ellipsis: true },
                  { title: "更新时间", dataIndex: "updated_at", width: 160 }
                ]}
              />
            )
          },
          {
            key: "timeline",
            label: "实时事件",
            children: <EventFeed events={liveEvents} />
          }
        ]}
      />

      <Drawer
        open={viewing !== null}
        onClose={() => setViewing(null)}
        width="72%"
        title={
          viewing && (
            <Space>
              <Tag>{viewing.kind}</Tag>
              <span style={{ fontSize: 13 }}>{viewing.path}</span>
            </Space>
          )
        }
        destroyOnHidden
      >
        {viewing && <ArtifactViewer artifact={viewing} />}
      </Drawer>
    </div>
  )
}

function EventFeed({ events }: { events: WbEvent[] }) {
  if (events.length === 0) {
    return <Typography.Text type="secondary">等待事件……(CLI 任何操作会实时出现在这里)</Typography.Text>
  }
  return (
    <Timeline
      style={{ marginTop: 16 }}
      items={events.map(e => ({
        children: (
          <Space size={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {e.created_at}
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>{eventLabel(e)}</Typography.Text>
            {e.module && <Tag style={{ fontSize: 10 }}>{[e.module, e.endpoint, e.page].filter(Boolean).join("/")}</Tag>}
          </Space>
        )
      }))}
    />
  )
}
