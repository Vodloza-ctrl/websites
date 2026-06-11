/**
 * websites.co.zw — render Worker (SELF-CONTAINED build)
 * Preview-auth helpers are inlined below, so this file has NO imports and
 * deploys as a single Worker (wrangler OR dashboard paste).
 *
 * v2 — branding upgrade:
 *   - logo nav bar (transparent over hero, solid on scroll)
 *   - full-bleed hero background image with gradient overlay (falls back to the
 *     original text hero when no image is set)
 *   - gallery grid with a lightweight lightbox (click to enlarge)
 *   - favicon + apple-touch-icon
 *   - Open Graph / Twitter tags so WhatsApp & Facebook shares show a preview
 * All new branding is driven by content.images.* — no per-client code.
 */

const PUBLICLY_SERVEABLE = new Set(["published", "grace"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const root = (env.PLATFORM_ROOT || "websites.co.zw").toLowerCase();

    // 0. Static assets: serve tenant images from the R2 bucket on the assets host.
    //    Dedicated bucket -> no prefix needed; key is the path (e.g. site_001/hero.jpg).
    if (host === `assets.${root}` || host === `cdn.${root}`) {
      return serveAsset(request, env, ctx, url);
    }

    // 1. Resolve which site this host/path points to, and in which context.
    const target = resolveHost(host, url.pathname, root);
    if (!target) return holdingPage(404, "Site not found");

    // 2. Load the site.
    const site = await loadSite(env.DB, target);
    if (!site) return holdingPage(404, "Site not found");

    // 3. Preview is PRIVATE — only the logged-in owner of this site may see it.
    if (target.context === "preview") {
      const claims = await verifyPreviewToken(readCookie(request, "wcz_preview"), env.PREVIEW_SECRET);
      if (!claims) return redirectToLogin(request, env);
      if (claims.sub !== site.owner_id) return holdingPage(404, "Site not found");
    }

    // 4. Compute the *effective* status at read time.
    const status = effectiveStatus(site);

    // 5. The paywall gate (public host).
    if (target.context === "public" && !PUBLICLY_SERVEABLE.has(status)) {
      return holdingPage(404, "This site is not published yet");
    }

    // 6. Parse the per-tenant document. Bad JSON should fail soft, not 500.
    let doc;
    try {
      doc = JSON.parse(site.content || "{}");
    } catch {
      doc = {};
    }
    const theme = doc.theme || {};
    const content = doc.content || {};

    // 7. Render. Preview always wears the banner.
    const showBanner = target.context === "preview";
    const html = renderSite({ site, status, theme, content, showBanner, env });

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": showBanner ? "no-store" : "public, max-age=60",
        "x-robots-tag": showBanner ? "noindex, nofollow" : "all",
      },
    });
  },
};

/* ------------------------------------------------------------------------- *
 * Host + path resolution
 * ------------------------------------------------------------------------- */
const RESERVED_SUBDOMAINS = new Set([
  "app", "www", "api", "preview", "dashboard", "admin", "assets", "cdn", "mail",
]);

function resolveHost(host, pathname, root) {
  const appHost = `app.${root}`;

  if (host === appHost) {
    const m = pathname.match(/^\/preview\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\/|$)/i);
    if (m) return { context: "preview", token: m[1].toLowerCase() };
    return null;
  }

  if (host === root || host === `www.${root}`) return null;

  const publicSuffix = `.${root}`;
  if (host.endsWith(publicSuffix)) {
    const token = host.slice(0, -publicSuffix.length);
    if (!token || token.includes(".") || RESERVED_SUBDOMAINS.has(token)) return null;
    return { context: "public", token };
  }

  return { context: "public", host };
}

async function loadSite(db, target) {
  const cols =
    "id, owner_id, status, plan, draft_subdomain, custom_domain, custom_domain_status, template_id, content, published_at, expires_at";
  if (target.token) {
    return db
      .prepare(`SELECT ${cols} FROM sites WHERE draft_subdomain = ?1`)
      .bind(target.token)
      .first();
  }
  return db
    .prepare(`SELECT ${cols} FROM sites WHERE custom_domain = ?1`)
    .bind(target.host)
    .first();
}

const GRACE_WINDOW_SECONDS = 14 * 24 * 60 * 60; // 14 days — confirm with Lenni
function effectiveStatus(site) {
  if (site.status !== "published" && site.status !== "grace") return site.status;
  if (!site.expires_at) return site.status;
  const now = Math.floor(Date.now() / 1000);
  if (now <= site.expires_at) return "published";
  if (now <= site.expires_at + GRACE_WINDOW_SECONDS) return "grace";
  return "suspended";
}

/* ------------------------------------------------------------------------- *
 * Skin registry
 * ------------------------------------------------------------------------- */
const SKINS = {
  "bold-retail": renderBoldRetail,
};

function renderSite(ctx) {
  const skin = SKINS[ctx.site.template_id] || SKINS["bold-retail"];
  const body = skin(ctx);
  return wrapDocument(body, ctx);
}

/* ------------------------------------------------------------------------- *
 * Theme tokens -> CSS variables.
 * ------------------------------------------------------------------------- */
const PALETTES = {
  "black-white-gold": { bg: "#0c0c0c", surface: "#161616", ink: "#f5f5f3", muted: "#a8a89f", accent: "#c8a24a", onAccent: "#0c0c0c" },
  "clean-white":      { bg: "#ffffff", surface: "#f6f6f4", ink: "#1a1a1a", muted: "#6b6b66", accent: "#1a1a1a", onAccent: "#ffffff" },
  "sky-blue":         { bg: "#0f1b2d", surface: "#16263d", ink: "#eef4fb", muted: "#9fb3cc", accent: "#3da5e0", onAccent: "#0f1b2d" },
  "elite-sports":     { bg: "#0a0a0a", surface: "#151515", ink: "#f5f6f5", muted: "#9aa0a6", accent: "#16a34a", onAccent: "#ffffff" },
};
const FONT_PAIRS = {
  "grotesk-serif": { display: "'Fraunces', Georgia, serif", body: "'Archivo', system-ui, sans-serif", url: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" },
  "clean-sans":    { display: "'Space Grotesk', sans-serif", body: "'Inter', system-ui, sans-serif", url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Space+Grotesk:wght@500;700&display=swap" },
  "sports-sans":   { display: "'Barlow Condensed', system-ui, sans-serif", body: "'Barlow', system-ui, sans-serif", url: "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700&display=swap" },
};

function themeVars(theme) {
  const p = PALETTES[theme.palette] || PALETTES["clean-white"];
  const f = FONT_PAIRS[theme.font_pair] || FONT_PAIRS["clean-sans"];
  const vars = [
    `--bg:${p.bg}`, `--surface:${p.surface}`, `--ink:${p.ink}`,
    `--muted:${p.muted}`, `--accent:${p.accent}`, `--on-accent:${p.onAccent}`,
    `--font-display:${f.display}`, `--font-body:${f.body}`,
  ].join(";");
  return { vars, fontUrl: f.url };
}

/* ------------------------------------------------------------------------- *
 * Document wrapper: <head>, base CSS, optional draft banner, body, scripts.
 * ------------------------------------------------------------------------- */
function wrapDocument(body, ctx) {
  const { vars, fontUrl } = themeVars(ctx.theme);
  const imgs = ctx.content.images || {};
  const title = esc(ctx.content.business_name || "Untitled site");
  const desc = esc(ctx.content.tagline || "");
  const banner = ctx.showBanner ? draftBanner(ctx.status) : "";

  const favicon = imgs.favicon || "";
  const appleIcon = imgs.apple_icon || imgs.favicon || "";
  const ogImage = imgs.hero || imgs.logo || "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
${favicon ? `<link rel="icon" href="${esc(favicon)}">` : ""}
${appleIcon ? `<link rel="apple-touch-icon" href="${esc(appleIcon)}">` : ""}
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontUrl}" rel="stylesheet">
<style>
  :root{${vars}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:var(--font-body);line-height:1.6;-webkit-font-smoothing:antialiased}
  h1,h2,h3{font-family:var(--font-display);line-height:1.1;font-weight:600}
  a{color:inherit}
  img{display:block}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}
  .section{padding:64px 0}
  .accent{color:var(--accent)}
  .btn{display:inline-block;background:var(--accent);color:var(--on-accent);padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:600}
  .btn:focus-visible,.nav-cta:focus-visible,.gal button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .reveal{opacity:0;transform:translateY(14px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
  @keyframes rise{to{opacity:1;transform:none}}

  /* nav */
  .nav{position:fixed;top:0;left:0;right:0;z-index:900;display:flex;align-items:center;justify-content:space-between;
       padding:18px 24px;transition:background .3s ease,padding .3s ease,border-color .3s ease;background:transparent;border-bottom:1px solid transparent}
  .nav.scrolled{background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);padding:11px 24px;border-bottom-color:rgba(128,128,128,.18)}
  .nav-brand{display:flex;align-items:center;text-decoration:none;gap:10px}
  .nav-logo{height:40px;width:auto}
  .nav-logo-text{font-family:var(--font-display);font-weight:700;font-size:20px;color:var(--ink);letter-spacing:-.01em}
  .nav-cta{background:var(--accent);color:var(--on-accent);padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;white-space:nowrap}

  /* hero with image */
  .hero{position:relative;min-height:90vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
  .hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.04);animation:heroZoom 14s ease-out forwards}
  @keyframes heroZoom{to{transform:scale(1)}}
  .hero-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,.32) 42%,rgba(0,0,0,.78) 100%)}
  .hero-inner{position:relative;z-index:2;padding:0 24px;max-width:900px}
  .hero-inner h1{font-size:clamp(44px,8vw,88px);color:#fff;max-width:16ch;margin:0 auto;text-shadow:0 2px 40px rgba(0,0,0,.45)}
  .hero-inner p{color:rgba(255,255,255,.9);font-size:clamp(18px,2.4vw,24px);margin:22px auto 0;max-width:46ch}
  .hero-logo{height:84px;width:auto;margin:0 auto 28px;filter:drop-shadow(0 4px 24px rgba(0,0,0,.5))}

  /* gallery + lightbox */
  .gal{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
  .gal button{padding:0;border:0;background:none;cursor:pointer;overflow:hidden;border-radius:12px;display:block}
  .gal img{width:100%;height:280px;object-fit:cover;transition:transform .5s ease}
  .gal button:hover img{transform:scale(1.06)}
  .lb{position:fixed;inset:0;background:rgba(0,0,0,.93);display:none;align-items:center;justify-content:center;z-index:1000;padding:28px}
  .lb.open{display:flex}
  .lb img{max-width:100%;max-height:100%;border-radius:8px}
  .lb-close{position:absolute;top:16px;right:24px;color:#fff;font-size:38px;line-height:1;background:none;border:0;cursor:pointer}

  @media (prefers-reduced-motion:reduce){
    .reveal,.hero-bg{animation:none;opacity:1;transform:none}
  }
  ${ctx.showBanner ? "body{padding-top:44px}.has-banner .nav{top:44px}" : ""}
</style>
</head>
<body class="${ctx.showBanner ? "has-banner" : ""}">
${banner}
${body}
<script>
(function(){
  var nav=document.querySelector('.nav');
  if(nav){
    var onScroll=function(){nav.classList.toggle('scrolled',window.scrollY>40);};
    onScroll();window.addEventListener('scroll',onScroll,{passive:true});
  }
  var lb=document.querySelector('.lb');
  if(lb){
    var lbImg=lb.querySelector('img');
    document.querySelectorAll('.gal button').forEach(function(b){
      b.addEventListener('click',function(){lbImg.src=b.getAttribute('data-full');lb.classList.add('open');document.body.style.overflow='hidden';});
    });
    var close=function(){lb.classList.remove('open');lbImg.removeAttribute('src');document.body.style.overflow='';};
    lb.addEventListener('click',function(e){if(e.target===lb||e.target.classList.contains('lb-close'))close();});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
  }
})();
</script>
</body>
</html>`;
}

function draftBanner(status) {
  const label = {
    draft: "Draft — not published",
    pending_payment: "Payment pending — publishing once confirmed",
    grace: "Live, but renewal overdue",
    suspended: "Suspended — renew to bring this site back online",
  }[status] || "Preview";
  return `<div style="position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;justify-content:center;gap:14px;background:#161616;color:#f5f5f3;font:500 14px system-ui;z-index:9999;border-bottom:1px solid rgba(255,255,255,.12)">
    <span>${esc(label)}</span>
    <a href="https://app.websites.co.zw/publish" style="background:#c8a24a;color:#0c0c0c;padding:5px 14px;border-radius:6px;text-decoration:none;font-weight:600">Publish</a>
  </div>`;
}

/* ------------------------------------------------------------------------- *
 * Reference skin: bold-retail
 * ------------------------------------------------------------------------- */
function renderBoldRetail(ctx) {
  const { content, theme, site } = ctx;
  const order = Array.isArray(theme.sections) && theme.sections.length
    ? theme.sections
    : ["hero", "about", "services", "gallery", "contact"];

  const parts = order.map((name) => {
    switch (name) {
      case "hero": return heroSection(content, theme);
      case "about": return aboutSection(content);
      case "services": return servicesSection(content);
      case "gallery": return gallerySection(content);
      case "team": return teamSection(content);
      case "testimonials": return testimonialsSection(content);
      case "video": return videoSection(content, site.plan);
      case "contact": return contactSection(content);
      default: return "";
    }
  });
  return siteHeader(content) + parts.join("\n") + footer(content);
}

/** Sticky nav: logo (or business name) + a single contact action. */
function siteHeader(content) {
  const imgs = content.images || {};
  const name = esc(content.business_name || "");
  const brand = imgs.logo
    ? `<img class="nav-logo" src="${esc(imgs.logo)}" alt="${name}">`
    : `<span class="nav-logo-text">${name}</span>`;
  const s = content.socials || {};
  const c = content.contact || {};
  const cta = s.whatsapp
    ? `<a class="nav-cta" href="https://wa.me/${digits(s.whatsapp)}">WhatsApp</a>`
    : (c.phone ? `<a class="nav-cta" href="tel:${esc(c.phone)}">Call us</a>` : "");
  return `<nav class="nav"><a class="nav-brand" href="#top" aria-label="${name}">${brand}</a>${cta}</nav>`;
}

function heroSection(content, theme) {
  const imgs = content.images || {};
  const name = esc(content.business_name || "Your business");
  const tag = esc(content.tagline || "");
  const s = content.socials || {};
  const cta = s.whatsapp
    ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}">Message us on WhatsApp</a>`
    : "";

  // Full-bleed image hero — the signature element.
  if (imgs.hero) {
    return `<header class="hero" id="top">
      <div class="hero-bg" style="background-image:url('${esc(imgs.hero)}')"></div>
      <div class="hero-overlay"></div>
      <div class="hero-inner reveal">
        ${imgs.logo ? `<img class="hero-logo" src="${esc(imgs.logo)}" alt="">` : ""}
        <h1>${name}</h1>
        ${tag ? `<p>${tag}</p>` : ""}
        ${cta ? `<div style="margin-top:34px">${cta}</div>` : ""}
      </div>
    </header>`;
  }

  // Text-only fallback (original behavior, with nav clearance).
  const variant = theme.variant || "hero-centered";
  const align = variant === "hero-split" ? "left" : "center";
  return `<header class="section" id="top" style="text-align:${align};padding-top:150px">
    <div class="wrap">
      <h1 class="reveal" style="font-size:clamp(40px,7vw,76px);max-width:14ch;${align === "center" ? "margin:0 auto" : ""}">${name}</h1>
      ${tag ? `<p class="reveal" style="animation-delay:.08s;color:var(--muted);font-size:clamp(18px,2.4vw,24px);margin-top:20px;max-width:48ch;${align === "center" ? "margin-left:auto;margin-right:auto" : ""}">${tag}</p>` : ""}
      ${cta ? `<div class="reveal" style="animation-delay:.16s;margin-top:32px">${cta}</div>` : ""}
    </div>
  </header>`;
}

function aboutSection(content) {
  if (!content.about) return "";
  return `<section class="section" style="background:var(--surface)"><div class="wrap" style="max-width:760px">
    <h2 class="accent" style="font-size:14px;letter-spacing:.12em;text-transform:uppercase">About</h2>
    <p style="font-size:clamp(20px,3vw,30px);margin-top:18px;line-height:1.4">${esc(content.about)}</p>
  </div></section>`;
}

function servicesSection(content) {
  const items = Array.isArray(content.services) ? content.services : [];
  if (!items.length) return "";
  const cards = items.map((s) => `<div style="background:var(--surface);padding:30px;border-radius:14px;border:1px solid rgba(128,128,128,.12)">
      <h3 style="font-size:22px">${esc(s.title || "")}</h3>
      <p style="color:var(--muted);margin-top:10px">${esc(s.body || "")}</p>
    </div>`).join("");
  return `<section class="section"><div class="wrap">
    <h2 style="font-size:clamp(28px,4vw,40px);margin-bottom:34px">What we do</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px">${cards}</div>
  </div></section>`;
}

function gallerySection(content) {
  const imgs = (content.images && Array.isArray(content.images.gallery)) ? content.images.gallery : [];
  if (!imgs.length) return "";
  const cells = imgs.map((src) => `<button data-full="${esc(src)}" aria-label="View image"><img loading="lazy" src="${esc(src)}" alt=""></button>`).join("");
  return `<section class="section"><div class="wrap">
    <h2 style="font-size:clamp(28px,4vw,40px);margin-bottom:30px">Gallery</h2>
    <div class="gal">${cells}</div>
  </div></section>
  <div class="lb"><button class="lb-close" aria-label="Close">&times;</button><img alt=""></div>`;
}

function videoSection(content, plan) {
  const v = content.video || {};
  if (v.embedUrl) {
    return `<section class="section"><div class="wrap" style="aspect-ratio:16/9;max-width:880px">
      <iframe src="${esc(v.embedUrl)}" style="width:100%;height:100%;border:0;border-radius:14px" allowfullscreen loading="lazy"></iframe>
    </div></section>`;
  }
  if (v.r2Url && plan === "pro") {
    return `<section class="section"><div class="wrap" style="max-width:880px">
      <video controls preload="none" poster="${esc(v.poster || "")}" style="width:100%;border-radius:14px"><source src="${esc(v.r2Url)}"></video>
    </div></section>`;
  }
  return "";
}

function contactSection(content) {
  const c = content.contact || {};
  const s = content.socials || {};
  const rows = [];
  if (c.phone) rows.push(line("Phone", `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`));
  if (c.email) rows.push(line("Email", `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`));
  if (c.address) rows.push(line("Address", esc(c.address)));
  if (s.whatsapp) rows.push(line("WhatsApp", `<a href="https://wa.me/${digits(s.whatsapp)}">${esc(s.whatsapp)}</a>`));
  if (s.facebook) rows.push(line("Facebook", `<a href="${esc(s.facebook)}">Visit page</a>`));
  if (!rows.length) return "";
  return `<section class="section" id="contact"><div class="wrap" style="max-width:640px">
    <h2 style="font-size:clamp(28px,4vw,40px);margin-bottom:28px">Get in touch</h2>
    ${rows.join("")}
  </div></section>`;
}

/**
 * Team / coaching staff — optional. Renders only if content.team has entries
 * AND "team" is in theme.sections. Photo is optional (text-only card if absent).
 */
function teamSection(content) {
  const items = Array.isArray(content.team) ? content.team : [];
  if (!items.length) return "";

  // One person -> a filled feature (photo beside bio) so it doesn't float in space.
  if (items.length === 1) {
    const m = items[0];
    return `<section class="section" style="background:var(--surface)"><div class="wrap">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:40px;max-width:900px;margin:0 auto">
        ${m.photo ? `<img loading="lazy" src="${esc(m.photo)}" alt="${esc(m.name || "")}" style="width:220px;height:220px;border-radius:16px;object-fit:cover;border:2px solid var(--accent);flex:none">` : ""}
        <div style="flex:1;min-width:260px">
          <h2 class="accent" style="font-size:14px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:14px">Our coaching team</h2>
          <h3 style="font-size:clamp(26px,4vw,34px)">${esc(m.name || "")}</h3>
          ${m.role ? `<p style="color:var(--accent);font-weight:600;margin-top:6px">${esc(m.role)}</p>` : ""}
          ${m.bio ? `<p style="color:var(--muted);font-size:17px;margin-top:16px;line-height:1.55">${esc(m.bio)}</p>` : ""}
        </div>
      </div>
    </div></section>`;
  }

  // Several -> grid, on a surface band so it reads as an intentional section.
  const cards = items.map((m) => `<div style="text-align:center">
      ${m.photo ? `<img loading="lazy" src="${esc(m.photo)}" alt="${esc(m.name || "")}" style="width:128px;height:128px;border-radius:50%;object-fit:cover;margin:0 auto 16px;border:2px solid var(--accent)">` : ""}
      <h3 style="font-size:19px">${esc(m.name || "")}</h3>
      ${m.role ? `<p style="color:var(--accent);font-size:14px;font-weight:600;margin-top:4px">${esc(m.role)}</p>` : ""}
      ${m.bio ? `<p style="color:var(--muted);font-size:14px;margin-top:8px">${esc(m.bio)}</p>` : ""}
    </div>`).join("");
  return `<section class="section" style="background:var(--surface)"><div class="wrap">
    <h2 style="font-size:clamp(28px,4vw,40px);margin-bottom:38px">Our coaching team</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:30px">${cards}</div>
  </div></section>`;
}

/**
 * Testimonials — optional. Same opt-in rule as team. Quote + attribution.
 */
function testimonialsSection(content) {
  const items = Array.isArray(content.testimonials) ? content.testimonials : [];
  if (!items.length) return "";
  const cards = items.map((t) => `<figure style="background:var(--surface);padding:30px;border-radius:14px;border:1px solid rgba(128,128,128,.12);margin:0">
      <blockquote style="font-size:18px;line-height:1.55">${esc(t.quote || "")}</blockquote>
      <figcaption style="margin-top:20px;display:flex;align-items:center;gap:12px">
        ${t.photo ? `<img loading="lazy" src="${esc(t.photo)}" alt="${esc(t.name || "")}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex:none">` : ""}
        <span style="font-size:14px;color:var(--muted)"><span style="color:var(--ink);font-weight:600">${esc(t.name || "")}</span>${t.role ? `<br>${esc(t.role)}` : ""}</span>
      </figcaption>
    </figure>`).join("");
  return `<section class="section"><div class="wrap">
    <h2 style="font-size:clamp(28px,4vw,40px);margin-bottom:38px">What parents &amp; players say</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px">${cards}</div>
  </div></section>`;
}

function footer(content) {
  const imgs = content.images || {};
  return `<footer style="padding:54px 0;text-align:center;color:var(--muted);font-size:13px;border-top:1px solid var(--surface)">
    <div class="wrap">
      ${imgs.logo ? `<img src="${esc(imgs.logo)}" alt="" style="height:40px;width:auto;margin:0 auto 18px;opacity:.9">` : ""}
      <div>© ${new Date().getFullYear()} ${esc(content.business_name || "")}</div>
      <div style="margin-top:8px;opacity:.7">Built on websites.co.zw</div>
    </div>
  </footer>`;
}

function line(label, value) {
  return `<div style="display:flex;justify-content:space-between;padding:16px 0;border-bottom:1px solid var(--surface)">
    <span style="color:var(--muted)">${esc(label)}</span><span>${value}</span></div>`;
}

/* ------------------------------------------------------------------------- *
 * Static asset serving from R2 (assets.websites.co.zw / cdn.websites.co.zw).
 * Dedicated bucket bound as ASSETS. Read-only, edge-cached, 1-year immutable.
 * ------------------------------------------------------------------------- */
async function serveAsset(request, env, ctx, url) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  if (!env.ASSETS) return new Response("Asset store not configured", { status: 500 });

  const key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

  // Edge cache first — repeat hits never touch R2.
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);                  // content-type etc. from R2 metadata
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  const resp = new Response(obj.body, { headers });
  ctx.waitUntil(cache.put(request, resp.clone())); // populate edge cache without blocking
  return resp;
}

/* ------------------------------------------------------------------------- *
 * Holding page for unpublished / unknown public hosts.
 * ------------------------------------------------------------------------- */
function holdingPage(code, message) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(message)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0c0c;color:#f5f5f3;font:400 16px system-ui;text-align:center;padding:24px}a{color:#c8a24a}</style>
</head><body><div><h1 style="font-size:22px;font-weight:600">${esc(message)}</h1>
<p style="color:#a8a89f;margin-top:10px">Powered by <a href="https://websites.co.zw">websites.co.zw</a></p></div></body></html>`;
  return new Response(html, { status: code, headers: { "content-type": "text/html; charset=utf-8" } });
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */
function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function redirectToLogin(request, env) {
  const loginUrl = env.APP_LOGIN_URL || "https://app.websites.co.zw/login";
  return Response.redirect(`${loginUrl}?next=${encodeURIComponent(request.url)}`, 302);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function digits(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

/* ===================================================================== *
 * Inlined preview-auth (token sign/verify).
 * ===================================================================== */
const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPreviewToken(ownerId, secret, ttlSeconds = 900) {
  const payload = {
    sub: ownerId,
    scope: "preview",
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

async function verifyPreviewToken(token, secret) {
  if (!token || !secret || token.indexOf(".") < 0) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;

  const key = await hmacKey(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sigB64), enc.encode(payloadB64));
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  if (payload.scope !== "preview") return null;
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}