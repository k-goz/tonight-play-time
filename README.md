# 今晚还能玩多久

亲子作业时间管理 PWA。它把“催孩子写作业”转化为一条由孩子自己掌握的正向反馈闭环：越早认真完成，睡前可自由安排的时间越清晰。

## 当前能力

- 北京时间与自定义睡觉时间
- 作业开始、暂停、继续、完成计时
- 家长三项确认：作业、订正、态度
- 完成庆祝、快乐时间项目选择
- 7 天 / 30 天记录与本周星星图
- 无账号本地模式：数据保存在 `localStorage`
- 账号模式：记录同步到 Node.js + SQLite 服务端
- PWA 安装与静态资源离线缓存

## 使用流程

```text
登录或本地模式
  → 开始作业
  → 计时中（可暂停 / 继续）
  → 我写完啦
  → 家长检查确认
  → 庆祝与快乐时间选择
```

应用状态机：`idle → running ⇄ paused → reviewing → completed`。

## 技术结构

```text
index.html / style.css       页面与样式
app.js                       状态机、计时、渲染、本地持久化与同步触发
api-service.js               认证与会话 API
service-worker.js            PWA 静态资源缓存（API 不缓存）
backend/server.js            Express API、认证、SQLite、静态文件白名单
backend/data/                本地数据库目录（不进入 Git）
tests/server.test.js         API 与安全边界回归测试
```

项目只保留 Node.js 后端。最低要求 Node.js 20.17。

## 本地运行

```bash
npm install
npm start
```

默认访问：<http://localhost:8001>

如需指定端口或数据库：

```bash
PORT=8080 DATABASE_PATH=/absolute/path/tonight_play_time.db npm start
```

不要直接双击 `index.html`：账号 API 和完整 PWA 能力需要通过 Node 服务访问。

## 验证

```bash
npm run check
npm test
```

测试覆盖：

- 前端和后端 JavaScript 语法
- 静态文件白名单，部署脚本、后端源码和数据库不可下载
- 注册、登录、会话创建和完成更新
- 非法会话字段被拒绝
- Token 在服务重启后仍有效
- 退出登录后 Token 失效

## 数据与安全说明

- 密码使用带随机盐的 `scrypt` 保存；旧版 SHA-256 密码在成功登录后自动升级。
- 登录 Token 的摘要保存在 SQLite，服务重启不会强制退出。
- 会话更新采用字段白名单。
- 数据库位于 Web 静态目录之外。
- 部署只使用 SSH Key，不在仓库中保存密码。
- 家长 PIN 目前只用于家庭设备上的轻量隔离，不等同于强安全认证。

## 部署

参见 [DEPLOY.md](DEPLOY.md)。生产环境必须配置 HTTPS、持久化磁盘、备份和凭据轮换。
