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
const redirectUri = process.env.MS_REDIRECT_URI || `${baseUrl}/auth/microsoft/callback`;

const SESSION_COOKIE = "aethelgard_session";
const OAUTH_STATE_COOKIE = "aethelgard_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ranks = [
  { name: "Ciudadano", amountEurCents: 499 },
  { name: "Diplomático", amountEurCents: 999 },
  { name: "Senador", amountEurCents: 1999 },
  { name: "Canciller", amountEurCents: 3499 },
];

const requiredEnv = [
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "SESSION_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`[warn] Missing ${key}. Some features will fail until configured.`);
  }
}

const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasSupabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

app.use(express.json());
app.use(express.static(__dirname));

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
  const pairs = header.split(";");
  for (const pair of pairs) {
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
  const next = Array.isArray(current) ? current.concat(cookieValue) : [String(current), cookieValue];
  res.setHeader("Set-Cookie", next);
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
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function setOauthStateCookie(res, state) {
  const value = createSignedPayload({ state, exp: Date.now() + 10 * 60 * 1000 });
  appendSetCookie(
    res,
    serializeCookie(OAUTH_STATE_COOKIE, value, {
      maxAge: 10 * 60,
      secure: isProduction,
    })
  );
}

function clearOauthStateCookie(res) {
  appendSetCookie(
    res,
    serializeCookie(OAUTH_STATE_COOKIE, "", {
      maxAge: 0,
      secure: isProduction,
    })
  );
}

function readOauthState(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifySignedPayload(cookies[OAUTH_STATE_COOKIE]);
  if (!payload || payload.exp < Date.now()) {
    return null;
  }
  return payload.state;
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

function decodeJwtPayload(jwt) {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) {
      return null;
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail = data.error_description || data.XErr || data.error || response.statusText;
    throw new Error(`${response.status} ${detail}`);
  }

  return data;
}

async function exchangeCodeForMicrosoftToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || "",
    client_secret: process.env.MS_CLIENT_SECRET || "",
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    scope: "XboxLive.signin offline_access openid profile email",
  });

  return requestJson("https://login.live.com/oauth20_token.srf", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

async function xboxLiveAuth(msAccessToken) {
  return requestJson("https://user.auth.xboxlive.com/user/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      Properties: {
        AuthMethod: "RPS",
        SiteName: "user.auth.xboxlive.com",
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    }),
  });
}

async function xboxXstsAuth(xblToken) {
  return requestJson("https://xsts.auth.xboxlive.com/xsts/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      Properties: {
        SandboxId: "RETAIL",
        UserTokens: [xblToken],
      },
      RelyingParty: "rp://api.minecraftservices.com/",
      TokenType: "JWT",
    }),
  });
}

async function minecraftLogin(xstsToken, userHash) {
  return requestJson("https://api.minecraftservices.com/authentication/login_with_xbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
    }),
  });
}

async function minecraftProfile(mcAccessToken) {
  return requestJson("https://api.minecraftservices.com/minecraft/profile", {
    headers: {
      Authorization: `Bearer ${mcAccessToken}`,
    },
  });
}

function ensureSupabaseConfigured() {
  if (!supabase) {
    const error = new Error("Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.");
    error.status = 500;
    throw error;
  }
}

async function upsertUser(userData) {
  ensureSupabaseConfigured();
  const { data, error } = await supabase
    .from("users")
    .upsert(userData, { onConflict: "minecraft_uuid" })
    .select("id,minecraft_uuid,minecraft_name,email")
    .single();

  if (error) {
    throw new Error(`Supabase users upsert failed: ${error.message}`);
  }
  return data;
}

async function getUserById(userId) {
  ensureSupabaseConfigured();
  const { data, error } = await supabase
    .from("users")
    .select("id,minecraft_uuid,minecraft_name,email")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase get user failed: ${error.message}`);
  }
  return data || null;
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

function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: "Debes iniciar sesión con Minecraft." });
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

app.get("/auth/microsoft", (req, res) => {
  if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    return res.status(500).send("Falta configurar MS_CLIENT_ID y MS_CLIENT_SECRET.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  setOauthStateCookie(res, state);

  const authUrl = new URL("https://login.live.com/oauth20_authorize.srf");
  authUrl.searchParams.set("client_id", process.env.MS_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "XboxLive.signin offline_access openid profile email");
  authUrl.searchParams.set("state", state);

  res.redirect(authUrl.toString());
});

app.get(
  "/auth/microsoft/callback",
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const storedState = readOauthState(req);
    clearOauthStateCookie(res);

    if (!code || !state || !storedState || String(state) !== storedState) {
      return res.status(400).send("Callback inválido de Microsoft OAuth.");
    }

    const msTokens = await exchangeCodeForMicrosoftToken(String(code));
    const idPayload = msTokens.id_token ? decodeJwtPayload(msTokens.id_token) : null;

    const xbl = await xboxLiveAuth(msTokens.access_token);
    const xsts = await xboxXstsAuth(xbl.Token);
    const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash) {
      throw new Error("No se pudo leer userHash de Xbox.");
    }

    const mcLogin = await minecraftLogin(xsts.Token, userHash);
    const profile = await minecraftProfile(mcLogin.access_token);

    const user = await upsertUser({
      microsoft_sub: idPayload?.sub || null,
      minecraft_uuid: profile.id,
      minecraft_name: profile.name,
      email: idPayload?.email || null,
    });

    setSessionCookie(res, user.id);
    res.redirect("/");
  })
);

app.get("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.redirect("/");
});

app.get("/api/ranks", (_req, res) => {
  res.json({ ranks });
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

    res.json({ loggedIn: true, user });
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

    res.status(201).json({
      paymentId: payment.id,
      message: "Pago registrado en estado pendiente. Conecta tu pasarela para confirmación automática.",
    });
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
