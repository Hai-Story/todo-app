// 在完整顺序中替换当前筛选项的位置，保留隐藏任务的相对位置。
(function (root) {
  function mergeVisibleOrder(todos, visibleIds) {
    const selected = new Set(visibleIds);
    let index = 0;
    return todos.slice()
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map(todo => selected.has(todo.id) ? visibleIds[index++] : todo.id);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mergeVisibleOrder;
  else root.mergeVisibleOrder = mergeVisibleOrder;
})(globalThis);
