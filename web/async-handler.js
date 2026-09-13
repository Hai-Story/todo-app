// Express 4 不会自动转发 async 路由的 Promise rejection。
module.exports = handler => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(next);
};
