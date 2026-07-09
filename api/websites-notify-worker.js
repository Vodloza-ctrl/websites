// websites-notify-worker.js
// v1.0 — Swappable notification worker. Single responsibility: given a
// phone number + message, send it via WhatsApp (ManyChat). Callers
// (bookings-worker today; orders-worker and future reminder/digest cron
// jobs later) never talk to ManyChat directly -- they call this worker, so
// the moment we outgrow ManyChat (WhatsApp Cloud API template messages, SMS
// fallback, etc.) it changes in exactly one place.
//
// v1 scope: WhatsApp only, via ManyChat, to EXISTING ManyChat subscribers
// only. Confirmed (not guessed) constraint from the booking-engine design
// sessions: ManyChat/WhatsApp Business cannot cold-message a phone number
// that has never messaged the bot first. This worker does not attempt it --
// it looks the phone up as an existing subscriber and silently returns
// ok:false if not found. Every caller MUST treat a notify failure as
// non-fatal to whatever it was doing (a booking still succeeds even if the
// owner ping fails to send).
//
// Routes:
//   POST /send { phone, message }  -> best-effort WhatsApp send
//   GET  /health
//
// Bindings: none (stateless).
// Secrets: MANYCHAT_API_TOKEN (same token already used by auth-worker.js's
//   sendWhatsApp() -- this worker's implementation matches it verbatim so
//   behaviour is identical regardless of which worker sends a message).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS),
  });
}

// Matches auth-worker.js's sendWhatsApp() exactly: look the phone up as an
// existing ManyChat subscriber, then push a text message via sendContent.
// Never throws -- returns false on any failure (missing token, subscriber
// not found, ManyChat API error), which is what callers expect.
async function sendWhatsApp(env, phone, message) {
  if (!env.MANYCHAT_API_TOKEN) return false;
  try {
    const find = await fetch(
      "https://api.manychat.com/fb/subscriber/findBySystemField?phone=" + encodeURIComponent(phone),
      { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } }
    );
    const found = await find.json().catch(() => ({}));
    const subId = found?.data?.id;
    if (!subId) return false;
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriber_id: subId,
        data: { version: "v2", content: { messages: [{ type: "text", text: message }] } },
      }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// Same normalization rule used everywhere else in the platform (auth-worker,
// render-worker's whatsapp_clean derivation) -- kept identical so a phone
// that's valid elsewhere is valid here too.
function normalizePhone(raw) {
  const p = String(raw || "").replace(/[^\d]/g, "");
  if (!p || p.length < 7) return null;
  if (p.startsWith("263") && p.length >= 12) return p;
  if (p.startsWith("0") && p.length >= 10) return "263" + p.slice(1);
  if (p.length === 9 && (p.startsWith("7") || p.startsWith("8"))) return "263" + p;
  if (p.length >= 10) return p;
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "websites-notify-worker", version: "1.0" });
    }

    if (url.pathname === "/send" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) {}

      const phone = normalizePhone(body.phone);
      const message = String(body.message || "").trim();

      if (!phone) return json({ ok: false, error: "invalid_phone" }, 400);
      if (!message) return json({ ok: false, error: "message_required" }, 400);

      const sent = await sendWhatsApp(env, phone, message);
      return json({ ok: sent, sent: sent, phone: phone });
    }

    return json({ error: "not_found" }, 404);
  },
};
