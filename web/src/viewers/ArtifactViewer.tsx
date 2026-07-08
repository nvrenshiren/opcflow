import Editor from "@monaco-editor/react"
import { Alert, Button, Flex, Input, List, Modal, Radio, Skeleton, Space, Tag, Tooltip, Typography, message } from "antd"
import { DesktopOutlined, MobileOutlined, TabletOutlined } from "@ant-design/icons"
import mermaid from "mermaid"
import { useEffect, useId, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, type Artifact, type ArtifactDetail } from "../api"
import { MONO, SURFACE } from "../ui"
import { t } from "../i18n"

mermaid.initialize({ startOnLoad: false, theme: "dark" })

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  dart: "dart",
  less: "less",
  css: "css",
  html: "html",
  prisma: "graphql",
  yaml: "yaml",
  yml: "yaml"
}

function langOf(path: string): string {
  return LANG_BY_EXT[path.split(".").pop() ?? ""] ?? "plaintext"
}

function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "")
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mermaid
      .render(`m${id}`, code)
      .then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg
      })
      .catch(err => {
        if (ref.current) ref.current.innerText = t(`mermaid 渲染失败: ${err.message}`, `Mermaid render failed: ${err.message}`)
      })
  }, [code, id])
  return <div ref={ref} />
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="wb-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1]
            if (lang === "mermaid") return <Mermaid code={String(children)} />
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function PrototypeView({ artifact }: { artifact: Artifact }) {
  const [width, setWidth] = useState(artifact.endpoint === "admin" ? 1280 : 375)
  const VIEWPORTS = [
    { icon: <MobileOutlined />, value: 375, tip: t("375 · 手机 (weapp/app)", "375 · Mobile (weapp/app)") },
    { icon: <TabletOutlined />, value: 768, tip: t("768 · 平板", "768 · Tablet") },
    { icon: <DesktopOutlined />, value: 1280, tip: t("1280 · 桌面 (admin/pc)", "1280 · Desktop (admin/pc)") }
  ]
  return (
    <div>
      <Radio.Group
        size="small"
        options={VIEWPORTS.map(v => ({ label: <Tooltip title={v.tip}>{v.icon}</Tooltip>, value: v.value }))}
        optionType="button"
        value={width}
        onChange={e => setWidth(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <Flex justify="center" style={{ background: SURFACE.raised, padding: 16, borderRadius: 10 }}>
        <iframe
          src={api.rawUrl(artifact.id)}
          sandbox="allow-scripts"
          style={{ width, height: "70vh", border: `1px solid ${SURFACE.lineStrong}`, borderRadius: 6, background: "#fff" }}
          title={artifact.path}
        />
      </Flex>
    </div>
  )
}

function CodeDirView({ artifact }: { artifact: Artifact }) {
  const [files, setFiles] = useState<{ rel: string; size: number }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string>("")

  useEffect(() => {
    api.files(artifact.id).then(d => {
      setFiles(d.files)
      if (d.files.length > 0) setSelected(d.files[0].rel)
    })
  }, [artifact.id])

  useEffect(() => {
    if (!selected) return
    api.file(artifact.id, selected).then(d => setContent(d.content))
  }, [artifact.id, selected])

  return (
    <Flex gap={12} style={{ height: "72vh" }}>
      <List
        size="small"
        split={false}
        style={{ width: 300, overflow: "auto", borderRight: `1px solid ${SURFACE.line}` }}
        dataSource={files}
        renderItem={f => (
          <List.Item
            className="wb-hover-row"
            style={{
              cursor: "pointer",
              background: f.rel === selected ? "rgba(47,189,175,0.14)" : undefined,
              padding: "5px 10px"
            }}
            onClick={() => setSelected(f.rel)}
          >
            <Typography.Text style={{ fontSize: 12, fontFamily: MONO }}>{f.rel}</Typography.Text>
          </List.Item>
        )}
      />
      <div style={{ flex: 1 }}>
        {selected && (
          <Editor
            height="100%"
            theme="vs-dark"
            language={langOf(selected)}
            value={content}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }}
          />
        )}
      </div>
    </Flex>
  )
}

function Actions({ artifact, onDone }: { artifact: Artifact; onDone: () => void }) {
  const [negOpen, setNegOpen] = useState(false)
  const [negComment, setNegComment] = useState("")
  const act = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn()
      message.success(label)
      onDone()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }
  const isFeedbackKind = artifact.kind === "prototype" || artifact.kind === "code"
  return (
    <Space>
      {isFeedbackKind && (
        <>
          <Button size="small" onClick={() => act(() => api.feedback(artifact.id, 1), artifact.kind === "prototype" ? t("👍 已放行", "👍 Released") : t("👍 已记录", "👍 Recorded"))}>
            👍
          </Button>
          <Button size="small" onClick={() => setNegOpen(true)}>
            👎
          </Button>
        </>
      )}
      {!isFeedbackKind && artifact.review_status === "draft" && (
        <Button size="small" onClick={() => act(() => api.submit(artifact.id), t("已送审", "Submitted"))}>
          {t("送审", "Submit")}
        </Button>
      )}
      {!isFeedbackKind && (artifact.review_status === "pending" || artifact.review_status === "invalidated") && (
        <Button size="small" type="primary" onClick={() => act(() => api.approve(artifact.id), t("已审批通过", "Approved"))}>
          {t("通过", "Approve")}
        </Button>
      )}
      <Modal
        open={negOpen}
        title={t("👎 原因(必填,进反馈与进化管道)", "👎 Reason (required — feeds the feedback & evolution pipeline)")}
        onCancel={() => setNegOpen(false)}
        onOk={async () => {
          await act(() => api.feedback(artifact.id, -1, negComment), t("👎 已记录", "👎 Recorded"))
          setNegOpen(false)
          setNegComment("")
        }}
      >
        <Input.TextArea rows={3} value={negComment} onChange={e => setNegComment(e.target.value)} />
      </Modal>
    </Space>
  )
}

export function ArtifactViewer({ artifact }: { artifact: Artifact }) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    setDetail(null)
    api.artifact(artifact.id).then(setDetail)
  }, [artifact.id, reloadKey])

  if (!detail) return <Skeleton active paragraph={{ rows: 8 }} style={{ padding: "12px 4px" }} />
  if (detail.missing) return <Alert type="warning" message={t(`文件已不在磁盘上: ${artifact.path}`, `File no longer on disk: ${artifact.path}`)} />

  let body: React.ReactNode
  if (detail.isDirectory) {
    body = <CodeDirView artifact={artifact} />
  } else if (artifact.kind === "prototype" || artifact.path.endsWith(".html")) {
    body = <PrototypeView artifact={artifact} />
  } else if (artifact.path.endsWith(".md")) {
    body = <MarkdownView content={detail.content ?? ""} />
  } else {
    body = (
      <Editor
        height="72vh"
        theme="vs-dark"
        language={langOf(artifact.path)}
        value={detail.content ?? ""}
        options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }}
      />
    )
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Tag bordered={false} style={{ fontFamily: MONO, fontSize: 11 }}>
          hash {artifact.content_hash.slice(0, 8)}
        </Tag>
        {artifact.approved_hash && (
          <Tag bordered={false} color="green" style={{ fontFamily: MONO, fontSize: 11 }}>
            approved {artifact.approved_hash.slice(0, 8)}
          </Tag>
        )}
        {artifact.reviewed_by && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("审批人", "Reviewed by")} {artifact.reviewed_by} @ {artifact.reviewed_at}
          </Typography.Text>
        )}
        {detail.feedback.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("反馈", "Feedback")} {detail.feedback.filter(f => f.verdict > 0).length}👍 / {detail.feedback.filter(f => f.verdict < 0).length}👎
          </Typography.Text>
        )}
        <Actions artifact={artifact} onDone={() => setReloadKey(k => k + 1)} />
      </Space>
      {body}
    </div>
  )
}
