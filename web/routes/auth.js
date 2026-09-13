// routes/auth.js — 注册 / 登录 / 注销 / 当前用户
const express = require('express');
const bcrypt = require('bcryptjs');
const { Users, Sessions, transaction } = require('../db.js');
const asyncHandler = require('../async-handler.js');

const router = express.Router();

const SESSION_COOKIE = 'todo_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** 权限中间件：未登录 401。通过后 req.user = { id, username } */
function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: '未登录' });

  const sess = Sessions.find(token);
  if (!sess) return res.status(401).json({ error: '会话无效，请重新登录' });
  if (sess.expiresAt < Date.now()) {
    clearSessionCookie(res);
    return res.status(401).json({ error: '会话已过期，请重新登录' });
  }
  const u = Users.findById(sess.userId);
  if (!u) return res.status(401).json({ error: '账户不存在，请重新登录' });
  req.user = { id: u.id, username: u.username };
  next();
}

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,20}$/;

router.post('/register', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: '用户名和密码必须为非空字符串' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-20 位字母/数字/下划线/连字符' });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: '密码长度需在 6-128 位之间' });
  }
  if (Users.findByUsername(username)) {
    return res.status(409).json({ error: '用户名已被占用' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const created = await transaction(() => {
    // 排队期间可能已有同名注册完成，必须在事务中再次校验。
    if (Users.findByUsername(username)) return null;
    const user = Users.create({ username, passwordHash });
    return { user, token: Sessions.create(user.id, SESSION_TTL_MS) };
  });
  if (!created) return res.status(409).json({ error: '用户名已被占用' });
  const { user, token } = created;
  setSessionCookie(res, token);

  res.json({ user: publicUser(user) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: '用户名和密码必须为非空字符串' });
  }
  const u = Users.findByUsername(username);
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = await transaction(() => Sessions.create(u.id, SESSION_TTL_MS));
  setSessionCookie(res, token);
  res.json({ user: publicUser(u) });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    await transaction(() => Sessions.delete(token));
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

router.get('/me', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: '未登录' });
  const sess = Sessions.find(token);
  if (!sess || sess.expiresAt < Date.now()) {
    clearSessionCookie(res);
    return res.status(401).json({ error: '未登录' });
  }
  const u = Users.findById(sess.userId);
  if (!u) return res.status(401).json({ error: '未登录' });
  res.json({ user: publicUser(u) });
});

module.exports = {
  router,
  requireAuth,
  purgeExpired: () => transaction(() => Sessions.purgeExpired()),
  SESSION_COOKIE
};
