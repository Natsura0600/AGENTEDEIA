export function checkKey(req) {
  const key = req.query?.key || req.headers["x-admin-key"];
  return Boolean(process.env.ADMIN_PASSWORD) && key === process.env.ADMIN_PASSWORD;
}
