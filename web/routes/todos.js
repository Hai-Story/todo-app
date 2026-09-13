// routes/todos.js — 每个用户只能访问自己的 todos
const express = require('express');
const { Todos, transaction } = require('../db.js');
const { requireAuth } = require('./auth.js');
const asyncHandler = require('../async-handler.js');

const router = express.Router();
router.use(requireAuth);

const TEXT_MAX = 200;

function rowToTodo(r) {
  return {
    id: r.id,
    text: r.text,
    done: !!r.done,
    dueDate: r.dueDate || null,
    position: r.position,
    createdAt: r.createdAt
  };
}

function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith('0000')) return false;
  const date = new Date(s + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}

router.get('/', (req, res) => {
  const rows = Todos.listByUser(req.user.id);
  res.json({ todos: rows.map(rowToTodo) });
});

router.post('/', asyncHandler(async (req, res) => {
  const { text, dueDate } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: '内容必须为字符串' });
  const t = text.trim();
  if (!t) return res.status(400).json({ error: '内容不能为空' });
  if (t.length > TEXT_MAX) return res.status(400).json({ error: `内容最多 ${TEXT_MAX} 字` });

  let due = null;
  if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
    if (!isISODate(dueDate)) return res.status(400).json({ error: '截止日期必须为有效日期，格式为 YYYY-MM-DD' });
    due = dueDate;
  }

  const todo = await transaction(() => Todos.create(req.user.id, { text: t, dueDate: due }));
  res.json({ todo: rowToTodo(todo) });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'id 无效' });

  const patch = {};
  if ('text' in (req.body || {})) {
    if (typeof req.body.text !== 'string') return res.status(400).json({ error: '内容必须为字符串' });
    const t = req.body.text.trim();
    if (!t) return res.status(400).json({ error: '内容不能为空' });
    if (t.length > TEXT_MAX) return res.status(400).json({ error: `内容最多 ${TEXT_MAX} 字` });
    patch.text = t;
  }
  if ('done' in (req.body || {})) {
    if (typeof req.body.done !== 'boolean') return res.status(400).json({ error: '完成状态必须为布尔值' });
    patch.done = req.body.done;
  }
  if ('dueDate' in (req.body || {})) {
    const d = req.body.dueDate;
    if (d === null || d === '') patch.dueDate = null;
    else if (isISODate(d))        patch.dueDate = d;
    else return res.status(400).json({ error: '截止日期必须为有效日期，格式为 YYYY-MM-DD' });
  }

  if (!Object.keys(patch).length) return res.status(400).json({ error: '没有可更新的字段' });

  const updated = await transaction(() => Todos.update(req.user.id, id, patch));
  if (!updated) return res.status(404).json({ error: '任务不存在' });
  res.json({ todo: rowToTodo(updated) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'id 无效' });
  const ok = await transaction(() => Todos.remove(req.user.id, id));
  if (!ok) return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: true });
}));

/** 拖拽重排：客户端发送完整的目标顺序 id 数组，服务端重新分配均匀的 position。 */
router.post('/reorder', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids 必须为数组' });

  const error = await transaction(() => {
    const owned = Todos.listByUser(req.user.id).map(t => t.id);
    if (ids.length !== owned.length) {
      return '排序数据与任务列表不一致';
    }
    const ownedSet = new Set(owned);
    const seen = new Set();
    for (const x of ids) {
      if (!Number.isSafeInteger(x)) return 'id 必须为整数';
      if (!ownedSet.has(x))     return '存在不属于你的任务';
      if (seen.has(x))          return 'id 重复';
      seen.add(x);
    }

    Todos.reorder(req.user.id, ids);
  });
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
}));

module.exports = router;
