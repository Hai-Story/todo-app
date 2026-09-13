const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mergeVisibleOrder = require('../public/order.js');

const source = path.resolve(__dirname, '..');
const password = 'test-password-only';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-regression-')));
  for (const file of ['server.js', 'db.js', 'async-handler.js', 'routes', 'public']) {
    fs.cpSync(path.join(source, file), path.join(dir, file), { recursive: true });
  }
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const dbPath = path.join(dir, 'data', 'db.json');
  let child, origin;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function start(expectFailure = false) {
    await stop();
    child = spawn(process.execPath, ['server.js'], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'test', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (expectFailure && code !== 0) resolve(output);
        else reject(new Error(`Server exited (${code}): ${output}`));
      });
      const read = buffer => {
        output += buffer;
        const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
        if (match) {
          clearTimeout(timer);
          origin = `http://127.0.0.1:${match[1]}`;
          if (expectFailure) reject(new Error('Corrupt database unexpectedly accepted'));
          else resolve();
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
    });
  }
  async function request(method, route, body, cookie, raw = false) {
    const response = await fetch(origin + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(username = 'test_user') {
    const response = await request('POST', '/api/auth/register', { username, password });
    assert.equal(response.status, 200);
    return response.cookie;
  }
  async function create(cookie, text = 'task', dueDate = null) {
    const response = await request('POST', '/api/todos', { text, dueDate }, cookie);
    assert.equal(response.status, 200);
    return response.data.todo;
  }
  return { dir, dbPath, start, stop, request, register, create };
}

test('registration and login sessions survive restart; logout remains effective', async t => {
  const f = fixture(t); await f.start();
  const cookie = await f.register();
  await f.start();
  assert.equal((await f.request('GET', '/api/auth/me', undefined, cookie)).status, 200);
  assert.equal((await f.request('POST', '/api/auth/logout', undefined, cookie)).status, 200);
  await f.start();
  assert.equal((await f.request('GET', '/api/auth/me', undefined, cookie)).status, 401);
  const login = await f.request('POST', '/api/auth/login', { username: 'test_user', password });
  assert.equal(login.status, 200);
  await f.start();
  assert.equal((await f.request('GET', '/api/auth/me', undefined, login.cookie)).status, 200);
});

test('malformed field types and JSON return client errors without stopping the server', async t => {
  const f = fixture(t); await f.start(); const cookie = await f.register();
  const todo = await f.create(cookie);
  for (const text of [123, true, {}, [], null]) {
    for (const [method, route] of [['POST', '/api/todos'], ['PUT', `/api/todos/${todo.id}`]]) {
      assert.equal((await f.request(method, route, { text }, cookie)).status, 400);
    }
  }
  for (const route of ['/api/auth/register', '/api/auth/login']) {
    for (const body of [{ username: 'test_user', password: 123456 }, { username: ['test_user'], password }]) {
      assert.equal((await f.request('POST', route, body)).status, 400);
    }
  }
  assert.equal((await f.request('PUT', `/api/todos/${todo.id}`, { done: 'false' }, cookie)).status, 400);
  assert.equal((await f.request('DELETE', `/api/todos/${todo.id}abc`, undefined, cookie)).status, 400);
  assert.equal((await f.request('POST', '/api/todos', '{', cookie, true)).status, 400);
  assert.equal((await f.request('POST', '/api/todos', { text: 'x'.repeat(70000) }, cookie)).status, 413);
  assert.equal((await f.request('GET', '/api/missing')).status, 404);
  assert.equal((await f.request('GET', '/api/todos', undefined, cookie)).status, 200);
});

test('calendar validation rejects impossible dates and accepts leap years', async t => {
  const f = fixture(t); await f.start(); const cookie = await f.register();
  const todo = await f.create(cookie, 'leap day', '2028-02-29');
  for (const dueDate of ['2026-99-99', '2026-02-29', '2026-04-31', '0000-01-01', '2026-00-10', '2026-01-00', '2026-1-01', 20260913]) {
    assert.equal((await f.request('POST', '/api/todos', { text: 'invalid', dueDate }, cookie)).status, 400);
    assert.equal((await f.request('PUT', `/api/todos/${todo.id}`, { dueDate }, cookie)).status, 400);
  }
  const changed = await f.request('PUT', `/api/todos/${todo.id}`, { text: 'edited', done: true, dueDate: null }, cookie);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.todo.dueDate, null);
  assert.equal(changed.data.todo.done, true);
  await f.start();
  assert.equal((await f.request('GET', '/api/todos', undefined, cookie)).data.todos[0].text, 'edited');
  assert.equal((await f.request('DELETE', `/api/todos/${todo.id}`, undefined, cookie)).status, 200);
});

test('filtered ordering preserves hidden slots and persists the complete order', async t => {
  const f = fixture(t); await f.start(); const cookie = await f.register();
  const todos = [];
  for (let i = 0; i < 5; i++) todos.push(await f.create(cookie, `task ${i}`));
  const original = todos.slice().reverse();
  for (const index of [1, 3]) {
    await f.request('PUT', `/api/todos/${original[index].id}`, { done: true }, cookie);
  }
  let current = (await f.request('GET', '/api/todos', undefined, cookie)).data.todos;
  const activeIds = current.filter(todo => !todo.done).map(todo => todo.id).reverse();
  const ids = mergeVisibleOrder(current, activeIds);
  assert.deepEqual(ids, [original[4].id, original[1].id, original[2].id, original[3].id, original[0].id]);
  assert.equal((await f.request('POST', '/api/todos/reorder', { ids }, cookie)).status, 200);
  await f.start();
  current = (await f.request('GET', '/api/todos', undefined, cookie)).data.todos;
  assert.deepEqual(current.map(todo => todo.id), ids);
  assert.deepEqual(mergeVisibleOrder(current, [original[3].id, original[1].id]),
    [original[4].id, original[3].id, original[2].id, original[1].id, original[0].id]);
  assert.deepEqual(mergeVisibleOrder(current, []), ids);
  assert.deepEqual(mergeVisibleOrder(current, ids.slice().reverse()), ids.slice().reverse());
});

test('anonymous access, other users and invalid reorder lists stay isolated', async t => {
  const f = fixture(t); await f.start();
  assert.equal((await f.request('GET', '/api/todos')).status, 401);
  const alice = await f.register('alice'); const a = await f.create(alice);
  const bob = await f.register('bob'); const b = await f.create(bob);
  assert.deepEqual((await f.request('GET', '/api/todos', undefined, bob)).data.todos.map(todo => todo.id), [b.id]);
  assert.equal((await f.request('PUT', `/api/todos/${a.id}`, { text: 'forbidden' }, bob)).status, 404);
  assert.equal((await f.request('DELETE', `/api/todos/${a.id}`, undefined, bob)).status, 404);
  for (const ids of [[a.id], [], [b.id, b.id], [String(b.id)]]) {
    assert.equal((await f.request('POST', '/api/todos/reorder', { ids }, bob)).status, 400);
  }
});

test('failed writes preserve disk and memory, return errors, and permit retries', async t => {
  const f = fixture(t); await f.start(); const cookie = await f.register();
  const a = await f.create(cookie, 'one'); const b = await f.create(cookie, 'two');
  const disk = fs.readFileSync(f.dbPath, 'utf8');
  const before = (await f.request('GET', '/api/todos', undefined, cookie)).data;
  fs.mkdirSync(f.dbPath + '.tmp'); // 确定性制造写入失败，不依赖磁盘或权限配置。
  const attempts = [
    ['POST', '/api/todos', { text: 'unsaved' }],
    ['PUT', `/api/todos/${a.id}`, { text: 'unsaved edit' }],
    ['DELETE', `/api/todos/${a.id}`],
    ['POST', '/api/todos/reorder', { ids: [a.id, b.id] }],
    ['POST', '/api/auth/register', { username: 'retry_user', password }],
    ['POST', '/api/auth/login', { username: 'test_user', password }],
    ['POST', '/api/auth/logout']
  ];
  for (const [method, route, body] of attempts) {
    const response = await f.request(method, route, body, cookie);
    assert.equal(response.status, 500, route);
    assert.equal(response.cookie, undefined, route);
    assert.equal(fs.readFileSync(f.dbPath, 'utf8'), disk);
    assert.deepEqual((await f.request('GET', '/api/todos', undefined, cookie)).data, before);
  }
  fs.rmdirSync(f.dbPath + '.tmp');
  // 不重启服务，直接确认失败后的队列仍可成功处理重试。
  await f.register('retry_user');
  await f.create(cookie, 'saved after recovery');
  await f.start();
  assert.equal((await f.request('GET', '/api/todos', undefined, cookie)).data.todos[0].text, 'saved after recovery');
});

test('concurrent registrations cannot create duplicate usernames', async t => {
  const f = fixture(t); await f.start();
  const responses = await Promise.all(Array.from({ length: 4 }, () =>
    f.request('POST', '/api/auth/register', { username: 'same_user', password })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409, 409, 409]);
  const saved = JSON.parse(fs.readFileSync(f.dbPath, 'utf8'));
  assert.equal(Object.keys(saved.users).length, 1);
  assert.equal(Object.keys(saved.sessions).length, 1);
});

test('concurrent task writes survive restart without missing entries', async t => {
  const f = fixture(t); await f.start(); const cookie = await f.register();
  const todos = await Promise.all(Array.from({ length: 12 }, (_, i) => f.create(cookie, `parallel ${i}`)));
  assert.equal(new Set(todos.map(todo => todo.id)).size, 12);
  await f.start();
  const saved = (await f.request('GET', '/api/todos', undefined, cookie)).data.todos;
  assert.deepEqual(saved.map(todo => todo.text).sort(), todos.map(todo => todo.text).sort());
});

for (const [name, content] of [['invalid JSON', '{"users":'], ['null', 'null'], ['missing collections', '{}'], ['invalid collection type', '{"meta":{"nextTodoId":1,"nextUserId":1},"users":[],"userByName":{},"sessions":{},"todos":{}}']]) {
  test(`startup preserves and refuses corrupt database: ${name}`, async t => {
    const f = fixture(t); fs.mkdirSync(path.dirname(f.dbPath)); fs.writeFileSync(f.dbPath, content);
    assert.match(await f.start(true), /无法加载数据文件/);
    assert.equal(fs.readFileSync(f.dbPath, 'utf8'), content);
    assert.equal(fs.existsSync(f.dbPath + '.tmp'), false);
  });
}

test('reads see only committed data while a write is in flight; failed transactions do not poison the queue', async t => {
  const f = fixture(t);
  const db = require(path.join(f.dir, 'db.js'));
  await db.transaction(() => db.Todos.create(1, { text: 'committed' }));
  const originalWrite = fs.promises.writeFile;
  let release, entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  fs.promises.writeFile = async (...args) => {
    if (args[0] === f.dbPath + '.tmp') { entered(); await blocked; }
    return originalWrite(...args);
  };
  try {
    const pending = db.transaction(() => db.Todos.create(1, { text: 'pending' }));
    await writing;
    assert.deepEqual(db.Todos.listByUser(1).map(todo => todo.text), ['committed']);
    release(); await pending;
    assert.deepEqual(db.Todos.listByUser(1).map(todo => todo.text), ['pending', 'committed']);
  } finally { release(); fs.promises.writeFile = originalWrite; }
  await assert.rejects(db.transaction(() => {
    db.Todos.create(1, { text: 'rolled back' });
    throw new Error('test failure');
  }), /test failure/);
  await db.transaction(() => db.Todos.create(1, { text: 'after failure' }));
  assert.deepEqual(db.Todos.listByUser(1).map(todo => todo.text), ['after failure', 'pending', 'committed']);
});
