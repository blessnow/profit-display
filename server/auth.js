import { timingSafeEqual } from "crypto";

/** 默认账号；生产务必用环境变量 ADMIN_USER / ADMIN_PASS 覆盖 */
export function getAdminCredentials() {
  return {
    user: process.env.ADMIN_USER || "holder",
    pass: process.env.ADMIN_PASS || "HoldSync_2026",
  };
}

function safeEq(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 除 GET /api/health 外，所有 /api/* 需 Basic 与 ADMIN 一致
 */
export function basicAuthMiddleware() {
  const { user, pass } = getAdminCredentials();
  return (req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    if (req.method === "GET" && req.path === "/api/health") return next();

    const h = req.headers.authorization || "";
    const m = /^Basic\s+(.+)$/i.exec(h);
    if (!m) {
      res.setHeader("WWW-Authenticate", 'Basic realm="positions"');
      return res.status(401).json({ error: "需要登录" });
    }
    let decoded = "";
    try {
      decoded = Buffer.from(m[1], "base64").toString("utf8");
    } catch {
      return res.status(401).json({ error: "凭证无效" });
    }
    const idx = decoded.indexOf(":");
    const u = idx >= 0 ? decoded.slice(0, idx) : "";
    const p = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (!safeEq(u, user) || !safeEq(p, pass)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="positions"');
      return res.status(401).json({ error: "用户名或密码错误" });
    }
    next();
  };
}
