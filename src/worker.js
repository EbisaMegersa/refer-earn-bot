// ============================================================
//  REFER & EARN BOT — backend (Cloudflare Worker + D1)
// ============================================================

// ==================== ⚙️ SETTINGS ====================
const BOT_USERNAME    = "tanvexoappbot"; // ⚠️ EDIT: your bot username WITHOUT the @
const WELCOME_POINTS  = 50;    // points a brand new user receives
const REFERRAL_POINTS = 100;   // points you get per friend referred
const MIN_WITHDRAW    = 1000;  // minimum points needed to withdraw
// =====================================================

const TG_API = "https://api.telegram.org/bot";

// ---------------- helpers ----------------
const enc = (s) => new TextEncoder().encode(s);
const toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(str) {
  const d = await crypto.subtle.digest("SHA-256", enc(str));
  return toHex(new Uint8Array(d));
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(message)));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function tg(env, method, body) {
  const res = await fetch(TG_API + env.BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------- router ----------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/webhook" && request.method === "POST") return handleWebhook(request, env);
      if (url.pathname === "/setup") return handleSetup(request, env);
      if (url.pathname === "/api/me" && request.method === "POST") return apiMe(request, env);
      if (url.pathname === "/api/withdraw" && request.method === "POST") return apiWithdraw(request, env);
      if (url.pathname === "/api/leaderboard") return apiLeaderboard(env);
      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  },
};

// ---------------- /setup : connect Telegram ----------------
async function handleSetup(request, env) {
  const origin = new URL(request.url).origin;
  const result = {};

  // 1) point Telegram updates at our worker
  result.setWebhook = await tg(env, "setWebhook", {
    url: origin + "/webhook",
    secret_token: await sha256Hex(env.BOT_TOKEN),
    drop_pending_updates: true,
  });

  // 2) make the ☰ menu button open the mini app
  result.setMenuButton = await tg(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "💰 Earn", web_app: { url: origin + "/" } },
  });

  // 3) bot command list
  result.setCommands = await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Start & get your invite link" },
      { command: "points", description: "Check your points" },
    ],
  });

  // 4) warn if BOT_USERNAME doesn't match the real bot
  const me = await tg(env, "getMe", {});
  if (me && me.ok && me.result.username !== BOT_USERNAME) {
    result.WARNING =
      'BOT_USERNAME in worker.js is "' + BOT_USERNAME + '" but your bot is @' +
      me.result.username + " — fix it, commit, wait for deploy, then open /setup again.";
  }

  return new Response(
    "<h2>✅ Setup</h2><pre>" + JSON.stringify(result, null, 2).replace(/</g, "&lt;") + "</pre>",
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ---------------- /webhook : messages from users ----------------
async function handleWebhook(request, env) {
  const expected = await sha256Hex(env.BOT_TOKEN);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = await request.json();
  const msg = update.message;
  if (msg && msg.text) await handleCommand(msg, env, new URL(request.url).origin);
  return json({ ok: true });
}

async function handleCommand(msg, env, origin) {
  const from = msg.from;
  const text = (msg.text || "").trim();
  const openAppBtn = { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: origin + "/" } }]] };

  // ---------- /start (with optional referral code) ----------
  if (text === "/start" || text.startsWith("/start ")) {
    const param = text.split(/\s+/)[1] || "";
    const referrerId = parseInt(param, 10);
    const myLink = "https://t.me/" + BOT_USERNAME + "?start=" + from.id;

    const existing = await env.DB.prepare(
      "SELECT referrer_id FROM users WHERE telegram_id = ?"
    ).bind(from.id).first();

    if (!existing) {
      // ----- brand new user -----
      await env.DB.prepare(
        "INSERT INTO users (telegram_id, username, first_name, points) VALUES (?, ?, ?, ?)"
      ).bind(from.id, from.username || "", from.first_name || "", WELCOME_POINTS).run();

      // referral credit — only if inviter exists and it's not yourself
      let invitedBy = false;
      if (referrerId && referrerId !== from.id) {
        const referrer = await env.DB.prepare(
          "SELECT telegram_id FROM users WHERE telegram_id = ?"
        ).bind(referrerId).first();
        if (referrer) {
          await env.DB.batch([
            env.DB.prepare("UPDATE users SET referrer_id = ? WHERE telegram_id = ?").bind(referrerId, from.id),
            env.DB.prepare(
              "UPDATE users SET points = points + ?, referrals = referrals + 1 WHERE telegram_id = ?"
            ).bind(REFERRAL_POINTS, referrerId),
          ]);
          invitedBy = true;
          await tg(env, "sendMessage", {
            chat_id: referrerId,
            text: "🎉 Someone joined using your link!\n💰 +" + REFERRAL_POINTS + " points",
          });
        }
      }

      await tg(env, "sendMessage", {
        chat_id: from.id,
        text:
          "👋 Welcome, " + (from.first_name || "friend") + "!\n\n" +
          "🎁 You received " + WELCOME_POINTS + " free points!\n" +
          (invitedBy ? "🤝 You were invited by a friend\n" : "") +
          "\n💰 Invite friends and earn " + REFERRAL_POINTS + " points for each one!\n\n" +
          "👇 Tap the button to open the app and get your invite link",
        reply_markup: openAppBtn,
      });
    } else {
      // ----- returning user -----
      await env.DB.prepare(
        "UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?"
      ).bind(from.username || "", from.first_name || "", from.id).run();

      const row = await env.DB.prepare(
        "SELECT points, referrals FROM users WHERE telegram_id = ?"
      ).bind(from.id).first();

      await tg(env, "sendMessage", {
        chat_id: from.id,
        text:
          "👋 Welcome back, " + (from.first_name || "friend") + "!\n\n" +
          "💰 Points: " + row.points + "\n👥 Referrals: " + row.referrals + "\n\n" +
          "🔗 Your invite link:\n" + myLink,
        reply_markup: openAppBtn,
      });
    }
    return;
  }

  // ---------- /points ----------
  if (text === "/points" || text.startsWith("/points ")) {
    const row = await env.DB.prepare(
      "SELECT points, referrals FROM users WHERE telegram_id = ?"
    ).bind(from.id).first();
    await tg(env, "sendMessage", {
      chat_id: from.id,
      text: row
        ? "💰 Points: " + row.points + "\n👥 Referrals: " + row.referrals
        : "Send /start first 🙂",
    });
    return;
  }

  // ---------- anything else ----------
  await tg(env, "sendMessage", {
    chat_id: from.id,
    text: "Use /start or tap below 👇",
    reply_markup: openAppBtn,
  });
}

// ---------------- mini app APIs ----------------
// Verify Telegram's signed initData and return the user
async function getTelegramUser(initData, env) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  const dataCheckString = Array.from(params.entries())
    .filter(([k]) => k !== "hash")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");

  const secretKey = await hmac(enc(env.BOT_TOKEN), "WebAppData");
  const computed = toHex(await hmac(secretKey, dataCheckString));
  if (computed !== hash) return null;

  // reject data older than 24h
  const authDate = parseInt(params.get("auth_date") || "0", 10) * 1000;
  if (Date.now() - authDate > 86400000) return null;

  try { return JSON.parse(params.get("user")); } catch { return null; }
}

async function apiMe(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await getTelegramUser(body.initData, env);
  if (!user || !user.id) return json({ ok: false, error: "unauthorized" }, 401);

  await env.DB.prepare(
    "INSERT INTO users (telegram_id, username, first_name, points) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name"
  ).bind(user.id, user.username || "", user.first_name || "", WELCOME_POINTS).run();

  const row = await env.DB.prepare(
    "SELECT points, referrals FROM users WHERE telegram_id = ?"
  ).bind(user.id).first();

  return json({
    ok: true,
    first_name: user.first_name || "Friend",
    points: row.points,
    referrals: row.referrals,
    link: "https://t.me/" + BOT_USERNAME + "?start=" + user.id,
    referral_points: REFERRAL_POINTS,
    min_withdraw: MIN_WITHDRAW,
  });
}

async function apiWithdraw(request, env) {
  const body = await request.json().catch(() => ({}));
  const user = await getTelegramUser(body.initData, env);
  if (!user || !user.id) return json({ ok: false, error: "unauthorized" }, 401);

  const row = await env.DB.prepare(
    "SELECT points FROM users WHERE telegram_id = ?"
  ).bind(user.id).first();
  if (!row) return json({ ok: false, error: "Please send /start to the bot first" }, 400);
  if (row.points < MIN_WITHDRAW) {
    return json({ ok: false, error: "You need at least " + MIN_WITHDRAW + " points to withdraw" }, 400);
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET points = 0 WHERE telegram_id = ?").bind(user.id),
    env.DB.prepare("INSERT INTO withdrawals (telegram_id, points) VALUES (?, ?)").bind(user.id, row.points),
  ]);

  return json({ ok: true, message: "✅ Withdrawal requested! You will be paid within 48 hours." });
}

async function apiLeaderboard(env) {
  const { results } = await env.DB.prepare(
    "SELECT first_name, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT 10"
  ).all();
  return json({ ok: true, list: results });
}
