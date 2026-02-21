const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const isProduction = process.env.NODE_ENV === "production";
const redirectUri =
  process.env.MS_REDIRECT_URI || `${baseUrl}/auth/microsoft/callback`;

const requiredEnv = ["MS_CLIENT_ID", "MS_CLIENT_SECRET"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`[warn] Missing ${key}. Minecraft login will not work until configured.`);
  }
}

const ranks = [
  { name: "Ciudadano", amountEurCents: 499 },
  { name: "Diplomático", amountEurCents: 999 },
  { name: "Senador", amountEurCents: 1999 },
  { name: "Canciller", amountEurCents: 3499 },
];

const db = new Database(path.join(__dirname, "aethelgard.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    microsoft_sub TEXT,
    minecraft_uuid TEXT NOT NULL UNIQUE,
    minecraft_name TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    rank_name TEXT NOT NULL,
    amount_eur_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_ref TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const upsertUserStmt = db.prepare(`
  INSERT INTO users (microsoft_sub, minecraft_uuid, minecraft_name, email)
  VALUES (@microsoft_sub, @minecraft_uuid, @minecraft_name, @email)
  ON CONFLICT(minecraft_uuid) DO UPDATE SET
    microsoft_sub = excluded.microsoft_sub,
    minecraft_name = excluded.minecraft_name,
    email = excluded.email,
    updated_at = CURRENT_TIMESTAMP
`);

const selectUserByUuidStmt = db.prepare(
  `SELECT id, minecraft_uuid, minecraft_name, email FROM users WHERE minecraft_uuid = ?`
);

const selectUserByIdStmt = db.prepare(
  `SELECT id, minecraft_uuid, minecraft_name, email FROM users WHERE id = ?`
);

const createPaymentStmt = db.prepare(`
  INSERT INTO payments (user_id, rank_name, amount_eur_cents, status)
  VALUES (?, ?, ?, 'pending')
`);

const listPaymentsByUserStmt = db.prepare(`
  SELECT id, rank_name, amount_eur_cents, status, created_at, paid_at
  FROM payments
  WHERE user_id = ?
  ORDER BY id DESC
`);

const listAllPaymentsStmt = db.prepare(`
  SELECT p.id, u.minecraft_name, u.minecraft_uuid, p.rank_name, p.amount_eur_cents,
         p.status, p.created_at, p.paid_at
  FROM payments p
  JOIN users u ON u.id = p.user_id
  ORDER BY p.id DESC
`);

const markPaidStmt = db.prepare(`
  UPDATE payments
  SET status = 'paid', paid_at = CURRENT_TIMESTAMP, provider_ref = COALESCE(?, provider_ref)
  WHERE id = ?
`);

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(express.static(__dirname));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Debes iniciar sesión con Minecraft." });
  }
  next();
}

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "Admin token inválido." });
  }
  next();
}

function decodeJwtPayload(jwt) {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) {
      return null;
    }
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json);
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
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
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

app.get("/auth/microsoft", (req, res) => {
  if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    return res.status(500).send("Falta configurar MS_CLIENT_ID y MS_CLIENT_SECRET en .env");
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const authUrl = new URL("https://login.live.com/oauth20_authorize.srf");
  authUrl.searchParams.set("client_id", process.env.MS_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "XboxLive.signin offline_access openid profile email");
  authUrl.searchParams.set("state", state);

  res.redirect(authUrl.toString());
});

app.get("/auth/microsoft/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
      return res.status(400).send("Callback inválido de Microsoft OAuth.");
    }

    delete req.session.oauthState;

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

    upsertUserStmt.run({
      microsoft_sub: idPayload?.sub || null,
      minecraft_uuid: profile.id,
      minecraft_name: profile.name,
      email: idPayload?.email || null,
    });

    const user = selectUserByUuidStmt.get(profile.id);
    req.session.userId = user.id;

    res.redirect("/");
  } catch (error) {
    console.error("[auth-error]", error);
    res.status(500).send(`No se pudo iniciar sesión con Minecraft: ${error.message}`);
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/api/ranks", (_req, res) => {
  res.json({ ranks });
});

app.get("/api/session", (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false, user: null });
  }

  const user = selectUserByIdStmt.get(req.session.userId);
  if (!user) {
    req.session.userId = null;
    return res.json({ loggedIn: false, user: null });
  }

  res.json({ loggedIn: true, user });
});

app.get("/api/payments/me", requireAuth, (req, res) => {
  const payments = listPaymentsByUserStmt.all(req.session.userId);
  res.json({ payments });
});

app.post("/api/payments", requireAuth, (req, res) => {
  const rankName = String(req.body.rankName || "").trim();
  const rank = ranks.find((item) => item.name === rankName);

  if (!rank) {
    return res.status(400).json({ error: "Rango inválido." });
  }

  const result = createPaymentStmt.run(req.session.userId, rank.name, rank.amountEurCents);
  res.status(201).json({
    paymentId: result.lastInsertRowid,
    message: "Pago registrado en estado pendiente. Conecta tu pasarela para confirmación automática.",
  });
});

app.get("/api/admin/payments", requireAdmin, (_req, res) => {
  const payments = listAllPaymentsStmt.all();
  res.json({ payments });
});

app.post("/api/admin/payments/:id/mark-paid", requireAdmin, (req, res) => {
  const paymentId = Number(req.params.id);
  if (!Number.isInteger(paymentId) || paymentId < 1) {
    return res.status(400).json({ error: "ID inválido." });
  }

  const providerRef = req.body.providerRef ? String(req.body.providerRef) : null;
  const result = markPaidStmt.run(providerRef, paymentId);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Pago no encontrado." });
  }

  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Aethelgard web running on ${baseUrl}`);
});
