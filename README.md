# 待办清单 Todo App

一个简洁的全栈待办清单：Node.js + Express + JSON 文件存储，每个用户拥有独立的待办列表，支持拖拽排序、截止日期和 30 天登录会话。

## 🌐 在线访问

本项目通过 WorkBuddy 部署，访问地址：[待办清单 Todo App](https://todo-app-21774.app.workbuddy.host/)。

## ✨ 功能

- 👤 **注册 / 登录**：bcrypt 密码哈希，HttpOnly cookie session，30 天免登录
- 🔐 **权限隔离**：每个用户只能看到 / 编辑自己的任务，数据访问函数按 `userId` 校验归属
- ➕ **添加任务**：支持可选的截止日期（YYYY-MM-DD）
- ✅ **完成 / 取消完成**
- ✎ **编辑**：点击编辑按钮，可改文本、修改 / 清除截止日期
- 🗑 **删除**（带二次确认）
- 🔍 **筛选**：全部 / 待完成 / 已完成
- ↕ **拖拽排序**：原生 HTML5 鼠标拖拽；筛选后排序保留隐藏任务的位置
- 🧮 **多种排序方式**：拖拽顺序 / 截止日期 / 创建时间
- 💾 **服务端持久化**：JSON 文件串行事务，写入成功后才返回成功
- 🎨 **响应式 UI**：桌面和手机都好用

## 📁 目录结构

```
todo-app/
└── web/
    ├── server.js              # Express 入口
    ├── db.js                  # JSON 存储与串行事务
    ├── async-handler.js       # 异步路由错误转发
    ├── package.json
    ├── data/                  # db.json（运行时自动创建）
    ├── test/                  # 隔离临时数据的回归测试
    ├── routes/
    │   ├── auth.js            # /api/auth/* — 注册 / 登录 / 注销 / 会话
    │   └── todos.js           # /api/todos/* — CRUD + reorder
    └── public/                # 前端静态资源
        ├── index.html
        ├── app.js
        ├── order.js           # 筛选列表与完整顺序合并
        └── style.css
```

## 🚀 本地运行

```bash
cd todo-app/web
npm install
npm start
# 默认监听 http://localhost:3000
```

环境变量：

- `PORT` — 监听端口（部署平台会自动注入）
- `NODE_ENV=production` — 使用仅 HTTPS 传输的会话 cookie

运行回归测试：在 `web` 目录执行 `npm test`。测试使用临时目录，不读写当前应用的数据文件。

## 🔐 权限模型

| 角色 | 能做什么 |
| --- | --- |
| 匿名 | 只能看到登录 / 注册页 |
| 已登录 | 只能 CRUD `userId = 自己` 的任务 |
| 任何用户 | 不能看到 / 修改 / 删除他人的任务（接口层强制） |

所有 todo 接口都通过 `requireAuth` 中间件，并在数据访问时按 `userId` 校验；`reorder` 接口要求当前用户的完整任务 ID 列表，不接受缺漏、重复或其他用户的 ID。

## 🔌 API 速览

### 鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ username, password }` → 自动登录 |
| POST | `/api/auth/login` | `{ username, password }` |
| POST | `/api/auth/logout` |  |
| GET  | `/api/auth/me` | 检查当前会话，返回用户信息 |

### Todo（需要登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET    | `/api/todos` | 列出自己的所有任务（按 position asc） |
| POST   | `/api/todos` | `{ text, dueDate? }` |
| PUT    | `/api/todos/:id` | `{ text?, done?, dueDate? }` |
| DELETE | `/api/todos/:id` |  |
| POST   | `/api/todos/reorder` | `{ ids: number[] }` 拖拽后批量提交新顺序 |

错误响应统一为 `{ "error": "..." }`。文本必须为字符串，`done` 必须为布尔值，截止日期必须为真实存在的 `YYYY-MM-DD` 日期。

## 💾 数据结构

`web/data/db.json` 中的 `todos` 对象按任务 ID 索引：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 唯一任务 ID |
| `userId` | number | 所属用户 ID |
| `text` | string | 任务文本 |
| `done` | boolean | 是否完成 |
| `dueDate` | string / null | 截止日期（YYYY-MM-DD），可空 |
| `position` | number | 排序权重（拖拽后服务端重写为 1000, 2000, …） |
| `createdAt` | number | 创建时间戳（毫秒） |

文件还包含 `meta`（ID 计数器）、`users`、`userByName`（用户名索引）和 `sessions`；session 默认 30 天过期。

账户与注册会话在同一事务中保存。每次写入先生成临时文件，再重命名替换原文件；失败时返回错误并保留已提交的内存状态。数据文件损坏、结构无效或不可读时服务停止启动，保留原文件供检查和恢复。

此存储只支持单进程运行。部署时须保留 `web/data` 持久化目录，并定期备份；临时磁盘或多个实例共享同一文件不受支持。

## 🎨 设计说明

- 主色 `#5b6cff`，强调色 `#20c997`（完成）、`#ff9f43`（今天截止）、`#ff5b6c`（逾期）
- 拖拽手柄固定在每条左侧，hover 时才显示操作按钮
- 截止日期展示规则：今天 / 明天 / N 天后 / 已逾期 N 天 / 具体月日

## 🔮 后续可扩展

- 截止日期提醒（邮件 / 浏览器通知）
- 任务分组 / 多清单
- 数据导入 / 导出（JSON / CSV）
- 找回密码（邮件）
- 双因素认证
