// server.js — 入口
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { initialize } = require('./db.js');

// 数据损坏或不可读时停止启动，避免以空数据库覆盖原文件。
initialize();

const auth = require('./routes/auth.js');
const todosRouter = require('./routes/todos.js');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// 每小时清理一次过期 session
setInterval(async () => {
  try { await auth.purgeExpired(); } catch (e) { console.error('[purgeExpired]', e); }
}, 60 * 60 * 1000).unref();

// 简易访问日志
app.use((req, _res, next) => {
  if (!req.path.startsWith('/public') && req.path !== '/') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

app.use('/api/auth', auth.router);
app.use('/api/todos', todosRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

// 静态前端
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// 前端 history 兜底：非 /api/ 请求一律返回 index.html（这里只有首页，简单处理）
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 全局错误兜底
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求 JSON 格式无效' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大' });
  console.error('[unhandled]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = Number(process.env.PORT ?? 3000);
const HOST = '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`todo app listening on http://${HOST}:${server.address().port}`);
});
