---
name: task-management
description: 任务管理规范 - 使用 cli.ts 创建、更新、查询、删除任务。触发时机：PM 分析完成、架构设计完成、开发完成时。
---

# Task 管理规范

> 前置条件校验由 CLI 自动执行，无需手动检查。

## cli.ts 命令

### 查看任务

```bash
npx tsx cli.ts list
npx tsx cli.ts list --status=pending
npx tsx cli.ts list --role=architect
npx tsx cli.ts list --module=auth
npx tsx cli.ts show <id>
```

### 创建任务

```bash
# architect
npx tsx cli.ts create \
  --module=auth \
  --role=architect \
  --endpoint=common \
  --assignee=architect \
  --creator=product-manager \
  --content="设计 auth 模块"

# designer
npx tsx cli.ts create \
  --module=auth \
  --role=designer \
  --endpoint=app \
  --page=auth/login \
  --assignee=designer \
  --creator=product-manager \
  --content="设计 app/auth/login 页面"

# developer service
npx tsx cli.ts create \
  --module=auth \
  --role=developer \
  --endpoint=service \
  --assignee=developer \
  --creator=product-manager \
  --content="实现 service/auth 登录功能"

# developer 前端
npx tsx cli.ts create \
  --module=auth \
  --role=developer \
  --endpoint=app \
  --page=auth/login \
  --assignee=developer \
  --creator=product-manager \
  --content="实现 auth/login 页面"
```

### 领取任务

```bash
npx tsx cli.ts claim <id> --assignee=architect
```

**自动校验**：CLI 会检查依赖的产出文件是否存在。

### 更新状态

```bash
npx tsx cli.ts update <id> --status=completed --operator=architect
```

**自动校验**：architect/designer 完成任务时会检查是否已添加产出文件。

### 删除任务

```bash
npx tsx cli.ts remove <id> --operator=product-manager
npx tsx cli.ts remove <id> --operator=anyone --force=true
```

### 添加产出文件

```bash
# PM 模块 PRD（输出 endpoint=common，不需要传 page）
npx tsx cli.ts output \
  --module=auth \
  --role=product-manager \
  --endpoint=common \
  -- docs/prd/modules/auth.md

# Architect 数据库文档（输出 endpoint=common）
npx tsx cli.ts output \
  --module=auth \
  --role=architect \
  --endpoint=common \
  -- docs/architecture/database/auth.md

# Architect API 文档（输出 endpoint=service）
npx tsx cli.ts output \
  --module=auth \
  --role=architect \
  --endpoint=service \
  -- docs/architecture/api/base/auth.md

npx tsx cli.ts output \
  --module=auth \
  --role=architect \
  --endpoint=service \
  -- docs/architecture/api/app/auth.md

# Designer 设计稿（输出 endpoint=admin/app/weapp）
npx tsx cli.ts output \
  --module=auth \
  --role=designer \
  --endpoint=app \
  --page=auth/login \
  -- docs/design/prompts/app/auth/login.md
```

### 查询产出文件

```bash
npx tsx cli.ts outputs --module=auth
npx tsx cli.ts outputs --module=auth --role=product-manager
npx tsx cli.ts outputs --module=auth --role=architect
npx tsx cli.ts outputs --module=auth --role=designer --endpoint=app
```

---

## 任务字段规范

| 角色      | role      | endpoint                | page              |
| --------- | --------- | ----------------------- | ----------------- |
| Architect | architect | common                  | -                 |
| Architect | architect | service                 | -                 |
| Designer  | designer  | app/admin/weapp         | {模块}/{页面}     |
| Developer | developer | service/admin/app/weapp | - / {模块}/{页面} |

---

## 产出物路径

| 角色      | 产出文件                                    |
| --------- | ------------------------------------------- |
| PM        | `docs/prd/modules/{模块}.md`                |
| PM        | `docs/prd/pages/{端}/{模块}/{页面}.md`      |
| Architect | `docs/architecture/database/{模块}.md`      |
| Architect | `docs/architecture/api/{端}/{模块}.md`      |
| Designer  | `docs/design/prompts/{端}/{模块}/{页面}.md` |
| Developer | 无需记录（代码直接实现）                    |

---

## 常见错误

| 错误                               | 原因                          |
| ---------------------------------- | ----------------------------- |
| `PM 尚未添加产出文件`              | claim 时 PM 产出不存在        |
| `architect 尚未添加产出文件`       | claim 时 architect 产出不存在 |
| `designer X 尚未添加产出文件`      | claim 时 designer 产出不存在  |
| `必须添加产出文件后才能标记为完成` | update 时未添加产出           |
| `只有执行人才能更新任务状态`       | 非 assignee 尝试更新          |
