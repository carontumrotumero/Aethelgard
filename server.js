const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();
const localPort = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const baseUrl =
  process.env.BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${localPort}`);

const SESSION_COOKIE = "aethelgard_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const paymentLinkTemplate = String(process.env.PAYMENT_LINK_TEMPLATE || "").trim();
const manualPaymentMethod = String(process.env.MANUAL_PAYMENT_METHOD || "Bizum").trim();
const manualPaymentDestination = String(process.env.MANUAL_PAYMENT_DESTINATION || "").trim();
const manualPaymentNote = String(process.env.MANUAL_PAYMENT_NOTE || "").trim();
const adminMinecraftUsers = new Set(
  String(process.env.ADMIN_MINECRAFT_USERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

const ranks = [
  { name: "Ciudadano", amountEurCents: 499 },
  { name: "Diplomático", amountEurCents: 999 },
  { name: "Senador", amountEurCents: 1999 },
  { name: "Canciller", amountEurCents: 3499 },
];

const requiredEnv = ["SESSION_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`[warn] Missing ${key}. Some features will fail until configured.`);
  }
}

const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasSupabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile("index.html", { root: __dirname });
});

function getSigningSecret() {
  return process.env.SESSION_SECRET || "change-me";
}

function signValue(value) {
  return crypto.createHmac("sha256", getSigningSecret()).update(value).digest("base64url");
}

function parseCookies(header) {
  if (!header) {
    return {};
  }

  const result = {};
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", [cookieValue]);
    return;
  }
  res.setHeader("Set-Cookie", Array.isArray(current) ? current.concat(cookieValue) : [String(current), cookieValue]);
}

function serializeCookie(name, value, options = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  attributes.push(`Path=${options.path || "/"}`);
  if (options.httpOnly !== false) {
    attributes.push("HttpOnly");
  }
  attributes.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

function createSignedPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signValue(encoded);
  return `${encoded}.${signature}`;
}

function verifySignedPayload(value) {
  if (!value) {
    return null;
  }

  const parts = value.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encoded, signature] = parts;
  if (signValue(encoded) !== signature) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function setSessionCookie(res, userId) {
  const payload = { userId, exp: Date.now() + SESSION_TTL_MS };
  const value = createSignedPayload(payload);
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, value, {
      maxAge: SESSION_TTL_MS / 1000,
      secure: isProduction,
    })
  );
}

function clearSessionCookie(res) {
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, "", {
      maxAge: 0,
      secure: isProduction,
    })
  );
}

function readSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifySignedPayload(cookies[SESSION_COOKIE]);
  if (!payload || payload.exp < Date.now() || !payload.userId) {
    return null;
  }
  return payload;
}

function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function ensureSupabaseConfigured() {
  if (!supabase) {
    const error = new Error("Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.");
    error.status = 500;
    throw error;
  }
}

function normalizeMinecraftUsername(username) {
  return String(username || "").trim();
}

function isAdminUsername(username) {
  return adminMinecraftUsers.has(normalizeMinecraftUsername(username).toLowerCase());
}

function getMinecraftKey(username) {
  return `offline:${normalizeMinecraftUsername(username).toLowerCase()}`;
}

function isValidMinecraftUsername(username) {
  return /^[A-Za-z0-9_]{3,16}$/.test(username);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHash] = String(stored || "").split(":");
  if (!salt || !expectedHash) {
    return false;
  }
  const currentHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(currentHash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

async function getUserById(userId) {
  ensureSupabaseConfigured();
  const { data, error } = await supabase
    .from("users")
    .select("id,minecraft_uuid,minecraft_name,email,password_hash")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase get user failed: ${error.message}`);
  }
  return data || null;
}

async function getUserByMinecraftName(username) {
  ensureSupabaseConfigured();
  const uuidKey = getMinecraftKey(username);
  const { data, error } = await supabase
    .from("users")
    .select("id,minecraft_uuid,minecraft_name,email,password_hash")
    .eq("minecraft_uuid", uuidKey)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase get user by name failed: ${error.message}`);
  }
  return data || null;
}

async function createUser(username, password) {
  ensureSupabaseConfigured();
  const passwordHash = hashPassword(password);
  const { data, error } = await supabase
    .from("users")
    .insert({
      microsoft_sub: null,
      minecraft_uuid: getMinecraftKey(username),
      minecraft_name: username,
      email: null,
      password_hash: passwordHash,
    })
    .select("id,minecraft_uuid,minecraft_name,email,password_hash")
    .single();

  if (error) {
    throw new Error(`Supabase create user failed: ${error.message}`);
  }
  return data;
}

async function insertPayment(userId, rank) {
  ensureSupabaseConfigured();
  const { data, error } = await supabase
    .from("payments")
    .insert({
      user_id: userId,
      rank_name: rank.name,
      amount_eur_cents: rank.amountEurCents,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Supabase create payment failed: ${error.message}`);
  }
  return data;
}

async function listUserPayments(userId) {
  ensureSupabaseConfigured();
  const { data, error } = await supabase
    .from("payments")
    .select("id,rank_name,amount_eur_cents,status,created_at,paid_at")
    .eq("user_id", userId)
    .order("id", { ascending: false });

  if (error) {
    throw new Error(`Supabase list payments failed: ${error.message}`);
  }
  return data || [];
}

async function listAllPayments() {
  ensureSupabaseConfigured();
  const { data, error } = await supabase
    .from("payments")
    .select(
      "id,rank_name,amount_eur_cents,status,created_at,paid_at,users!inner(minecraft_name,minecraft_uuid)"
    )
    .order("id", { ascending: false });

  if (error) {
    throw new Error(`Supabase list admin payments failed: ${error.message}`);
  }

  return (data || []).map((item) => ({
    id: item.id,
    rank_name: item.rank_name,
    amount_eur_cents: item.amount_eur_cents,
    status: item.status,
    created_at: item.created_at,
    paid_at: item.paid_at,
    minecraft_name: item.users?.minecraft_name || null,
    minecraft_uuid: item.users?.minecraft_uuid || null,
  }));
}

async function markPaymentPaid(paymentId, providerRef) {
  ensureSupabaseConfigured();
  const updatePayload = {
    status: "paid",
    paid_at: new Date().toISOString(),
  };

  if (providerRef) {
    updatePayload.provider_ref = providerRef;
  }

  const { data, error } = await supabase
    .from("payments")
    .update(updatePayload)
    .eq("id", paymentId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase mark paid failed: ${error.message}`);
  }

  return data;
}

function buildPaymentLink({ paymentId, rankName, username, amountEurCents }) {
  if (!paymentLinkTemplate) {
    return null;
  }

  return paymentLinkTemplate
    .replaceAll("{payment_id}", encodeURIComponent(String(paymentId)))
    .replaceAll("{rank}", encodeURIComponent(rankName))
    .replaceAll("{username}", encodeURIComponent(username))
    .replaceAll("{amount_eur}", encodeURIComponent((amountEurCents / 100).toFixed(2)));
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: "Debes iniciar sesión." });
  }
  req.sessionUserId = session.userId;
  next();
}

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "Admin token inválido." });
  }
  next();
}

const requireAdminSession = asyncHandler(async (req, res, next) => {
  const user = await getUserById(req.sessionUserId);
  if (!user || !isAdminUsername(user.minecraft_name)) {
    return res.status(403).json({ error: "Solo admins pueden hacer esto." });
  }
  req.sessionUser = user;
  next();
});

app.post(
  "/auth/register",
  asyncHandler(async (req, res) => {
    const username = normalizeMinecraftUsername(req.body.username);
    const password = String(req.body.password || "");

    if (!isValidMinecraftUsername(username)) {
      return res.status(400).json({ error: "El usuario debe parecer un nombre válido de Minecraft (3-16, letras/números/_)." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    }

    const existing = await getUserByMinecraftName(username);
    if (existing) {
      return res.status(409).json({ error: "Ese usuario ya está registrado." });
    }

    const user = await createUser(username, password);
    setSessionCookie(res, user.id);

    res.status(201).json({
      message: "Cuenta creada correctamente.",
      user: { id: user.id, minecraft_name: user.minecraft_name, minecraft_uuid: user.minecraft_uuid },
    });
  })
);

app.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const username = normalizeMinecraftUsername(req.body.username);
    const password = String(req.body.password || "");

    const user = await getUserByMinecraftName(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    setSessionCookie(res, user.id);
    res.json({ message: "Sesión iniciada.", user: { id: user.id, minecraft_name: user.minecraft_name } });
  })
);

app.get("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.redirect("/");
});

app.get("/api/ranks", (_req, res) => {
  res.json({ ranks });
});

app.get("/api/payment-instructions", (_req, res) => {
  res.json({
    hasExternalCheckout: Boolean(paymentLinkTemplate),
    method: manualPaymentMethod,
    destination: manualPaymentDestination,
    note: manualPaymentNote,
  });
});

app.get(
  "/api/session",
  asyncHandler(async (req, res) => {
    const session = readSession(req);
    if (!session) {
      return res.json({ loggedIn: false, user: null });
    }

    const user = await getUserById(session.userId);
    if (!user) {
      clearSessionCookie(res);
      return res.json({ loggedIn: false, user: null });
    }

    res.json({
      loggedIn: true,
      user: {
        id: user.id,
        minecraft_name: user.minecraft_name,
        minecraft_uuid: user.minecraft_uuid,
        isAdmin: isAdminUsername(user.minecraft_name),
      },
    });
  })
);

app.get(
  "/api/payments/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payments = await listUserPayments(req.sessionUserId);
    res.json({ payments });
  })
);

app.post(
  "/api/payments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rankName = String(req.body.rankName || "").trim();
    const rank = ranks.find((item) => item.name === rankName);

    if (!rank) {
      return res.status(400).json({ error: "Rango inválido." });
    }

    const payment = await insertPayment(req.sessionUserId, rank);
    const user = await getUserById(req.sessionUserId);
    const paymentUrl = buildPaymentLink({
      paymentId: payment.id,
      rankName: rank.name,
      username: user?.minecraft_name || "jugador",
      amountEurCents: rank.amountEurCents,
    });

    res.status(201).json({
      paymentId: payment.id,
      paymentUrl,
      message: paymentUrl
        ? "Pedido creado. Te redirigimos al pago."
        : "Pago registrado en estado pendiente. Configura PAYMENT_LINK_TEMPLATE para redirigir a pago.",
    });
  })
);

app.post(
  "/api/admin/grant-rank",
  requireAuth,
  requireAdminSession,
  asyncHandler(async (req, res) => {
    const rankName = String(req.body.rankName || "").trim();
    const rank = ranks.find((item) => item.name === rankName);
    if (!rank) {
      return res.status(400).json({ error: "Rango inválido." });
    }

    const payment = await insertPayment(req.sessionUserId, rank);
    await markPaymentPaid(payment.id, "admin-grant");

    res.json({ ok: true, message: `Rango ${rank.name} activado gratis para admin.` });
  })
);

app.get(
  "/api/admin/payments",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const payments = await listAllPayments();
    res.json({ payments });
  })
);

app.get(
  "/api/admin/payments-session",
  requireAuth,
  requireAdminSession,
  asyncHandler(async (_req, res) => {
    const payments = await listAllPayments();
    res.json({ payments });
  })
);

app.post(
  "/api/admin/payments/:id/mark-paid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const paymentId = Number(req.params.id);
    if (!Number.isInteger(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const providerRef = req.body.providerRef ? String(req.body.providerRef) : null;
    const updated = await markPaymentPaid(paymentId, providerRef);

    if (!updated) {
      return res.status(404).json({ error: "Pago no encontrado." });
    }

    res.json({ ok: true });
  })
);

app.post(
  "/api/admin/payments/:id/mark-paid-session",
  requireAuth,
  requireAdminSession,
  asyncHandler(async (req, res) => {
    const paymentId = Number(req.params.id);
    if (!Number.isInteger(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const providerRef = req.body.providerRef ? String(req.body.providerRef) : "manual-admin-panel";
    const updated = await markPaymentPaid(paymentId, providerRef);

    if (!updated) {
      return res.status(404).json({ error: "Pago no encontrado." });
    }

    res.json({ ok: true, message: "Pago marcado como completado." });
  })
);

app.use((error, _req, res, _next) => {
  console.error("[server-error]", error);
  const status = Number(error.status) || 500;
  const message = error.message || "Error interno del servidor";
  if (res.headersSent) {
    return;
  }
  res.status(status).json({ error: message });
});

if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(localPort, () => {
    console.log(`Aethelgard web running on ${baseUrl}`);
  });
}
