/* 待办清单 · 前端逻辑 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  /* ============ 全局状态 ============ */
  const state = {
    user: null,         // { id, username }
    todos: [],          // 原始数据（按后端排序：manual 时按 position asc）
    filter: 'all',      // all / active / done
    sort: 'manual',     // manual / due / created
    editingId: null
  };

  /* ============ 工具 ============ */
  function escapeHTML(s) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return String(s).replace(/[&<>"']/g, c => map[c]);
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function formatToday() {
    const d = new Date();
    const week = ['日','一','二','三','四','五','六'][d.getDay()];
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${week}`;
  }

  function showToast(msg, ms = 1500) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._tm);
    showToast._tm = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (data && data.error) || `请求失败 (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ============ 视图切换 ============ */
  function showAuth() {
    $('#mainView').hidden = true;
    $('#authView').hidden = false;
    switchAuthTab('login');
  }
  function showMain() {
    $('#authView').hidden = true;
    $('#mainView').hidden = false;
    $('#meName').textContent = state.user.username;
    $('#dateLabel').textContent = formatToday();
  }

  function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $('#loginForm').hidden = tab !== 'login';
    $('#registerForm').hidden = tab !== 'register';
    $('#loginMsg').textContent = '';
    $('#loginMsg').classList.remove('ok');
    $('#registerMsg').textContent = '';
    $('#registerMsg').classList.remove('ok');
  }

  /* ============ 鉴权 ============ */
  async function checkSession() {
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
      showMain();
      await loadTodos();
    } catch (_) {
      state.user = null;
      showAuth();
    }
  }

  async function login(username, password) {
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    state.user = data.user;
    showMain();
    await loadTodos();
  }

  async function register(username, password) {
    const data = await api('/api/auth/register', { method: 'POST', body: { username, password } });
    state.user = data.user;
    showMain();
    await loadTodos();
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    catch (e) { showToast(e.message); return; }
    state.user = null;
    state.todos = [];
    showAuth();
  }

  /* ============ Todos ============ */
  async function loadTodos() {
    try {
      const data = await api('/api/todos');
      state.todos = data.todos;
      render();
    } catch (e) {
      if (e.status === 401) { state.user = null; showAuth(); return; }
      showToast(e.message);
    }
  }

  async function addTodo() {
    const text = $('#todoText').value.trim();
    const dueDate = $('#todoDue').value || null;
    if (!text) { showToast('请输入内容'); return; }
    try {
      const data = await api('/api/todos', { method: 'POST', body: { text, dueDate } });
      state.todos.unshift(data.todo);
      $('#todoText').value = '';
      $('#todoDue').value = '';
      render();
      showToast('已添加');
    } catch (e) { showToast(e.message); }
  }

  async function toggleTodo(id) {
    const t = state.todos.find(x => x.id === id);
    if (!t) return;
    try {
      const data = await api(`/api/todos/${id}`, { method: 'PUT', body: { done: !t.done } });
      Object.assign(t, data.todo);
      render();
    } catch (e) { showToast(e.message); }
  }

  async function deleteTodo(id) {
    if (!confirm('确定删除这条任务吗？')) return;
    try {
      await api(`/api/todos/${id}`, { method: 'DELETE' });
      state.todos = state.todos.filter(t => t.id !== id);
      render();
    } catch (e) { showToast(e.message); }
  }

  async function saveEdit(id, text, dueDate) {
    try {
      const body = { text };
      // 始终提交 dueDate（null 表示清除）
      body.dueDate = dueDate || null;
      const data = await api(`/api/todos/${id}`, { method: 'PUT', body });
      const idx = state.todos.findIndex(t => t.id === id);
      if (idx >= 0) state.todos[idx] = data.todo;
      state.editingId = null;
      render();
      showToast('已保存');
    } catch (e) { showToast(e.message); }
  }

  async function reorderTodos(visibleIds) {
    if (state.reordering) return;
    state.reordering = true;
    const ids = mergeVisibleOrder(state.todos, visibleIds);
    try {
      await api('/api/todos/reorder', { method: 'POST', body: { ids } });
      // 同步本地 position
      const map = new Map(ids.map((id, i) => [id, (i + 1) * 1000]));
      state.todos.forEach(t => { if (map.has(t.id)) t.position = map.get(t.id); });
    } catch (e) { showToast(e.message); }
    finally { state.reordering = false; render(); }
  }

  async function clearDone() {
    if (!state.todos.some(t => t.done)) return;
    if (!confirm('清除所有已完成的任务？')) return;
    const done = state.todos.filter(t => t.done);
    try {
      await Promise.all(done.map(t => api(`/api/todos/${t.id}`, { method: 'DELETE' })));
      state.todos = state.todos.filter(t => !t.done);
      render();
    } catch (e) { showToast(e.message); }
  }

  /* ============ 排序 / 过滤 ============ */
  function visibleTodos() {
    let arr = state.todos.slice();
    if (state.filter === 'active') arr = arr.filter(t => !t.done);
    else if (state.filter === 'done') arr = arr.filter(t => t.done);

    if (state.sort === 'due') {
      arr.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return a.position - b.position;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
    } else if (state.sort === 'created') {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      arr.sort((a, b) => a.position - b.position);
    }
    return arr;
  }

  /* ============ 渲染 ============ */
  function dueClass(due, done) {
    if (!due) return '';
    if (done) return 'done';
    const t = todayStr();
    if (due < t) return 'overdue';
    if (due === t) return 'today';
    return '';
  }

  function renderItem(t) {
    const isEditing = state.editingId === t.id;
    const dueCls = dueClass(t.dueDate, t.done);
    const dueLabel = t.dueDate ? formatDue(t.dueDate) : '';

    if (isEditing) {
      return `
        <li class="todo-item editing" data-id="${t.id}">
          <span class="drag-handle" title="拖动以排序">⋮⋮</span>
          <div class="checkbox ${t.done ? 'checked' : ''}" data-act="toggle"></div>
          <div class="body">
            <div class="edit-row">
              <input type="text" value="${escapeHTML(t.text)}" maxlength="200" data-edit="text" />
            </div>
            <div class="edit-row">
              <input type="date" value="${t.dueDate || ''}" data-edit="due" />
              <button class="clear-due" data-act="clear-due">清除日期</button>
              <button class="save" data-act="save">保存</button>
              <button class="cancel" data-act="cancel-edit">取消</button>
            </div>
          </div>
        </li>`;
    }

    return `
      <li class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
        <span class="drag-handle" title="按住拖动以排序">⋮⋮</span>
        <div class="checkbox ${t.done ? 'checked' : ''}" data-act="toggle"></div>
        <div class="body">
          <div class="text">${escapeHTML(t.text)}</div>
          ${t.dueDate ? `<div class="meta"><span class="due ${dueCls}">⏰ ${escapeHTML(dueLabel)}</span></div>` : ''}
        </div>
        <div class="actions">
          <button data-act="edit" title="编辑">✎</button>
          <button class="del" data-act="delete" title="删除">🗑</button>
        </div>
      </li>`;
  }

  function formatDue(d) {
    // d = "YYYY-MM-DD"
    if (!d) return '';
    const today = todayStr();
    if (d === today) return '今天截止';
    const t = new Date(today + 'T00:00:00');
    const x = new Date(d + 'T00:00:00');
    const diffDays = Math.round((x - t) / 86400000);
    if (diffDays === 1) return '明天截止';
    if (diffDays === -1) return '昨天截止';
    if (diffDays > 0 && diffDays <= 7) return `${diffDays} 天后截止`;
    if (diffDays < 0) return `已逾期 ${-diffDays} 天`;
    // 显示月日
    const [, mm, dd] = d.split('-');
    return `${parseInt(mm, 10)} 月 ${parseInt(dd, 10)} 日`;
  }

  function render() {
    const $list = $('#todoList');
    const items = visibleTodos();
    $list.innerHTML = items.map(renderItem).join('');

    // 空态文案
    $list.classList.remove('empty-done', 'empty-active');
    if (items.length === 0) {
      const cls = state.filter === 'done'  ? 'empty-done'
                : state.filter === 'active' ? 'empty-active'
                : null;
      if (cls) $list.classList.add(cls);
    }

    // 计数
    const remain = state.todos.filter(t => !t.done).length;
    $('#counter').textContent = `${remain} 项待完成 · 共 ${state.todos.length} 项`;

    // 清除按钮
    $('#clearDone').disabled = !state.todos.some(t => t.done);

    // 过滤 / 排序 tab 高亮
    document.querySelectorAll('.filters button[data-filter]').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === state.filter);
    });
    document.querySelectorAll('.filters button[data-sort]').forEach(b => {
      b.classList.toggle('active', b.dataset.sort === state.sort);
    });

    bindListEvents();
    setupDrag();
  }

  function bindListEvents() {
    const $list = $('#todoList');
    $list.querySelectorAll('.todo-item').forEach(li => {
      const id = parseInt(li.dataset.id, 10);

      li.querySelectorAll('[data-act]').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const act = el.dataset.act;
          if (act === 'toggle') toggleTodo(id);
          else if (act === 'edit') { state.editingId = id; render(); }
          else if (act === 'delete') deleteTodo(id);
          else if (act === 'save') {
            const text = li.querySelector('[data-edit="text"]').value.trim();
            const due = li.querySelector('[data-edit="due"]').value || null;
            if (!text) { showToast('内容不能为空'); return; }
            saveEdit(id, text, due);
          } else if (act === 'cancel-edit') {
            state.editingId = null; render();
          } else if (act === 'clear-due') {
            li.querySelector('[data-edit="due"]').value = '';
          }
        });
      });
    });

    // 编辑模式自动聚焦
    const editInput = $list.querySelector('.edit-row input[type="text"]');
    if (editInput) {
      editInput.focus();
      const len = editInput.value.length;
      editInput.setSelectionRange(len, len);
      editInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') editInput.closest('.todo-item').querySelector('[data-act="save"]').click();
        else if (e.key === 'Escape') editInput.closest('.todo-item').querySelector('[data-act="cancel-edit"]').click();
      });
    }
  }

  /* ============ 拖拽（原生 HTML5 DnD，鼠标拖拽即可） ============ */
  function setupDrag() {
    const $list = $('#todoList');
    // 清掉旧状态
    if (state._dragCleanup) state._dragCleanup();
    state._dragCleanup = null;

    if (state.sort !== 'manual') return;

    let dragEl = null;

    function onDragStart(e) {
      // 仅在「拖拽顺序」模式启用；编辑模式或非拖拽模式 draggable 应为 false
      if (state.sort !== 'manual' || state.reordering) { e.preventDefault(); return; }
      if (e.target.closest('.editing')) { e.preventDefault(); return; }
      dragEl = e.currentTarget;
      dragEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragEl.dataset.id); } catch (_) {}
    }

    function onDragEnd() {
      if (dragEl) dragEl.classList.remove('dragging');
      $list.querySelectorAll('.drag-over-top, .drag-over-bottom')
        .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
      dragEl = null;
    }

    function onDragOver(e) {
      if (!dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const li = e.currentTarget;
      if (li === dragEl) return;
      const r = li.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      li.classList.toggle('drag-over-bottom', after);
      li.classList.toggle('drag-over-top', !after);
    }

    function onDragLeave(e) {
      e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
    }

    async function onDrop(e) {
      e.preventDefault();
      const li = e.currentTarget;
      if (!dragEl || li === dragEl) return;
      const r = li.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      li.parentNode.insertBefore(dragEl, after ? li.nextSibling : li);
      const ids = [...$list.querySelectorAll('.todo-item')].map(x => parseInt(x.dataset.id, 10));
      await reorderTodos(ids);
    }

    const items = $list.querySelectorAll('.todo-item');
    items.forEach(li => {
      li.setAttribute('draggable', 'true');
      li.addEventListener('dragstart', onDragStart);
      li.addEventListener('dragend', onDragEnd);
      li.addEventListener('dragover', onDragOver);
      li.addEventListener('dragleave', onDragLeave);
      li.addEventListener('drop', onDrop);
    });

    state._dragCleanup = () => {
      items.forEach(li => {
        li.removeAttribute('draggable');
        li.removeEventListener('dragstart', onDragStart);
        li.removeEventListener('dragend', onDragEnd);
        li.removeEventListener('dragover', onDragOver);
        li.removeEventListener('dragleave', onDragLeave);
        li.removeEventListener('drop', onDrop);
      });
    };
  }

  /* ============ 事件绑定 ============ */
  function bindEvents() {
    // 鉴权 tab
    document.querySelectorAll('.auth-tab').forEach(b => {
      b.addEventListener('click', () => switchAuthTab(b.dataset.tab));
    });

    // 登录
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const username = fd.get('username').trim();
      const password = fd.get('password');
      const msg = $('#loginMsg');
      msg.textContent = ''; msg.classList.remove('ok');
      try {
        await login(username, password);
        msg.textContent = '登录成功';
        msg.classList.add('ok');
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    // 注册
    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const username = String(fd.get('username') || '').trim();
      const password = String(fd.get('password') || '');
      const msg = $('#registerMsg');
      msg.textContent = ''; msg.classList.remove('ok');
      try {
        await register(username, password);
        msg.textContent = '注册成功，已为你登录';
        msg.classList.add('ok');
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    // 注销
    $('#logoutBtn').addEventListener('click', logout);

    // 添加
    $('#addBtn').addEventListener('click', addTodo);
    $('#todoText').addEventListener('keydown', e => {
      if (e.key === 'Enter') addTodo();
    });

    // 过滤 / 排序
    document.querySelectorAll('.filters button').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.filter) state.filter = b.dataset.filter;
        if (b.dataset.sort) state.sort = b.dataset.sort;
        render();
      });
    });

    $('#clearDone').addEventListener('click', clearDone);
  }

  /* ============ 启动 ============ */
  function init() {
    try { bindEvents(); } catch (e) { console.error('[init.bindEvents]', e); }
    try { checkSession(); } catch (e) { console.error('[init.checkSession]', e); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
