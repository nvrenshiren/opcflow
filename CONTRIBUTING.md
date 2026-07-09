# 贡献指南

感谢参与 opcflow!本文说明本地开发、提交与 PR 流程。

## 开发环境

- **Node ≥ 22**(从源码构建前端需 ≥ 22.12,vite 8 要求;仅跑发布包无此限制)
- **pnpm**(仓库用 `packageManager` 锁定版本,建议 `corepack enable` 后自动取用)

```bash
pnpm install            # 装依赖
pnpm run typecheck      # 类型检查(tsc --noEmit)
pnpm test               # 单元测试(node --test)
pnpm run check:isolation # 隔离纪律检查
pnpm run build          # 构建 web + 打包 dist/cli.mjs
```

起本地工作台(连接项目的 `.workbench` 数据):

```bash
pnpm run web:build              # 首次需先构建前端(否则 web/dist 缺失 → 404)
pnpm exec tsx cli.ts serve      # 从源码起 server → http://127.0.0.1:5620
```

开发期直接用源码跑 CLI:`pnpm exec tsx cli.ts <子命令>`(如 `list` / `scan` / `serve`)。

## 目录结构

| 目录 | 作用 |
| --- | --- |
| `core/` | 引擎:SQLite 数据层、gates、信任协议、DAG、commands、平台 adapter |
| `server/` | Fastify HTTP + SSE、MCP server |
| `web/` | React 可视化工作台(Vite 构建) |
| `scripts/` | git/工具 hooks、esbuild 打包脚本、隔离检查 |
| `templates/agents/{zh,en}/` | 各角色 agent 模板(中英双语) |
| `preset/` | init 落到裸项目的最小脚手架 |
| `tests/` | 单元测试 |

**隔离纪律**:`core/` 禁止 import 任何业务代码;改动后 `pnpm run check:isolation` 必须通过。

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/):`type: 简短描述`(描述用中文)。

常用 type:`feat` / `fix` / `chore` / `ci` / `docs` / `refactor` / `test` / `perf`。

只写实际改动,不加任何自动生成/工具署名的尾注。

## 改 agent 模板

模板在 `templates/agents/zh/` 与 `templates/agents/en/`,**两种语言要同步改**。改完用 `pnpm exec tsx cli.ts gen-agents --project=<测试项目>` 重生成验证,并跑 `pnpm test`(含模板零宿主残留检查)。

## PR 流程

1. 从 `main` 切分支(`feat/xxx`、`fix/xxx`)。
2. 做改动,补/改对应测试。
3. 本地过四关:`typecheck`、`test`、`check:isolation`、`build`。
4. 开 PR,按模板填写改动说明与测试 checklist;CI 会自动跑同样的门禁。
5. Review 通过后合并。

## 版本与破坏性变更

- 推 main 即由 semantic-release 发版(`feat`→minor、`fix`→patch)。**破坏性变更**必须在提交标题加 `!` 或 footer 写 `BREAKING CHANGE:`(升 major),且**必须附迁移指南**(commit body 或关联文档),并在 `tests/migration.test.ts` 补齐 schema 演进覆盖。
- 走向 1.0 前,重大破坏性变更先在预发布 minor(如 0.10.x)摊开观察 ≥2 周,再合入大版本。

## 范围外(non-goals)

以下方向刻意不做,请勿就此提 PR:SaaS 多租户、替换 SQLite、TUI/桌面客户端、config 可视化编辑器、自动学习/微调(提炼保持确定性聚合)、插件市场、WORM 审计、Prometheus 导出、GitHub 之外的 git provider(按需再议)、拖拽编排 pipeline(拓扑已由角色注册表物化,手画违背配置即代码)。

## 报告问题 / 提需求

用 [Issues](../../issues) 里的模板(Bug 报告 / 功能请求);开放式讨论走 [Discussions](../../discussions)。
