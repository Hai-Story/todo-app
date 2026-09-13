// db.js — 基于 JSON 文件的轻量持久化
// 适合个人/小团队 todo 场景：无原生依赖，部署简单，写时整文件落盘 + 串行化。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const EMPTY = {
  meta: { nextTodoId: 1, nextUserId: 1 },
  users: {},     // id -> { id, username, passwordHash, createdAt }
  userByName: {},// username -> id
  sessions: {},  // token -> { userId, expiresAt, createdAt }
  todos: {}      // id -> { id, userId, text, done, dueDate, position, createdAt }
};

let state = null;        // 缓存
let writeQueue = Promise.resolve();

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.meta) ||
        !['nextTodoId', 'nextUserId'].every(key => Number.isSafeInteger(parsed.meta[key]) && parsed.meta[key] > 0) ||
        !['users', 'userByName', 'sessions', 'todos'].every(key => isRecord(parsed[key])) ||
        !['users', 'sessions', 'todos'].every(key => Object.values(parsed[key]).every(isRecord))) {
      throw new Error('数据文件结构无效');
    }
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return JSON.parse(JSON.stringify(EMPTY));
    throw new Error('无法加载数据文件，请检查文件或从备份恢复；原文件未被修改');
  }
}

function ensureLoaded() {
  if (!state) state = load();
}

function transaction(mutate) {
  // 写操作依次修改独立副本。落盘成功后才发布给读请求，失败时保留已提交状态。
  const pending = writeQueue.then(async () => {
    ensureLoaded();
    const committed = state;
    const previous = JSON.stringify(committed);
    let candidate, result, serialized;
    state = JSON.parse(previous);
    try {
      result = mutate(); // 回调只执行同步内存操作，不得 await。
      if (result && typeof result.then === 'function') throw new Error('事务回调必须是同步函数');
      candidate = state;
      serialized = JSON.stringify(candidate);
    } finally {
      state = committed;
    }
    if (serialized === previous) return result;
    const tmp = DB_PATH + '.tmp';
    await fs.promises.writeFile(tmp, serialized);
    await fs.promises.rename(tmp, DB_PATH);
    state = candidate;
    return result;
  });
  // 队列可继续接受后续写入；当前调用者仍会收到原始失败。
  writeQueue = pending.catch(() => {});
  return pending;
}

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* ===== Users ===== */
const Users = {
  findById(id) {
    ensureLoaded();
    return state.users[id] || null;
  },
  findByUsername(username) {
    ensureLoaded();
    const id = Object.hasOwn(state.userByName, username) ? state.userByName[username] : null;
    return id ? state.users[id] : null;
  },
  create({ username, passwordHash }) {
    ensureLoaded();
    const id = state.meta.nextUserId++;
    const user = { id, username, passwordHash, createdAt: Date.now() };
    state.users[id] = user;
    Object.defineProperty(state.userByName, username, { value: id, enumerable: true, writable: true, configurable: true });
    return user;
  }
};

/* ===== Sessions ===== */
const Sessions = {
  create(userId, ttlMs) {
    ensureLoaded();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    state.sessions[token] = { userId, expiresAt: now + ttlMs, createdAt: now };
    return token;
  },
  find(token) {
    ensureLoaded();
    return state.sessions[token] || null;
  },
  delete(token) {
    ensureLoaded();
    delete state.sessions[token];
  },
  purgeExpired() {
    ensureLoaded();
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(state.sessions)) {
      if (v.expiresAt < now) { delete state.sessions[k]; changed = true; }
    }
    return changed;
  }
};

/* ===== Todos ===== */
const Todos = {
  listByUser(userId) {
    ensureLoaded();
    return Object.values(state.todos)
      .filter(t => t.userId === userId)
      .sort((a, b) => a.position - b.position || a.id - b.id);
  },
  find(userId, id) {
    ensureLoaded();
    const t = state.todos[id];
    if (!t || t.userId !== userId) return null;
    return t;
  },
  create(userId, data) {
    ensureLoaded();
    // 新任务放最前面：position = min - 1
    const owned = Object.values(state.todos).filter(t => t.userId === userId);
    const minPos = owned.length ? Math.min(...owned.map(t => t.position)) : 0;
    const id = state.meta.nextTodoId++;
    const todo = {
      id,
      userId,
      text: data.text,
      done: !!data.done,
      dueDate: data.dueDate || null,
      position: minPos - 1,
      createdAt: Date.now()
    };
    state.todos[id] = todo;
    return todo;
  },
  update(userId, id, patch) {
    ensureLoaded();
    const t = state.todos[id];
    if (!t || t.userId !== userId) return null;
    if ('text'    in patch) t.text    = patch.text;
    if ('done'    in patch) t.done    = !!patch.done;
    if ('dueDate' in patch) t.dueDate = patch.dueDate || null;
    return t;
  },
  remove(userId, id) {
    ensureLoaded();
    const t = state.todos[id];
    if (!t || t.userId !== userId) return false;
    delete state.todos[id];
    return true;
  },
  reorder(userId, ids) {
    ensureLoaded();
    // ids 已经是目标顺序
    ids.forEach((id, i) => {
      const t = state.todos[id];
      if (t && t.userId === userId) t.position = (i + 1) * 1000;
    });
  }
};

module.exports = {
  Users,
  Sessions,
  Todos,
  transaction,
  initialize: ensureLoaded,
  uid
};
