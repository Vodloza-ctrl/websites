/**
 * websites.co.zw — render Worker v3 (SELF-CONTAINED, no imports)
 * --------------------------------------------------------------
 * Skins registered: bold-retail, grill-house, beauty-salon,
 *                   school-institution, advisory-firm, property-estate
 *
 * Each skin reads from the same content JSON schema:
 *   content.business_name, .tagline, .about, .services[], .contact{},
 *   .socials{}, .images{hero,logo,gallery[]}, .team[], .testimonials[],
 *   .video{embedUrl,r2Url,poster}, .menu{categories[]}, .hours,
 *   .stats[], .location
 *
 * theme.palette   → one of the PALETTES keys (or skin default)
 * theme.font_pair → one of the FONT_PAIRS keys (or skin default)
 * theme.sections  → ordered array of section names (or skin default)
 */

const PUBLICLY_SERVEABLE = new Set(["published", "grace"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const root = (env.PLATFORM_ROOT || "websites.co.zw").toLowerCase();

    if (host === `assets.${root}` || host === `cdn.${root}`) {
      return serveAsset(request, env, ctx, url);
    }

    const target = resolveHost(host, url.pathname, root);

    // app.websites.co.zw (non-preview) → forward to auth/dashboard Worker
    if (target && target.context === "app") {
      const authHost = env.AUTH_WORKER_HOST || "websites-cozw-auth.yasibomedia.workers.dev";
      const authUrl  = new URL(request.url);
      authUrl.hostname = authHost;
      return fetch(new Request(authUrl.toString(), request));
    }

    // null = apex / www → forward to Pages (rewrite hostname to avoid loop)
    if (!target) {
      const pagesHost = env.PAGES_HOST || "websites-aon.pages.dev";
      const pagesUrl  = new URL(request.url);
      pagesUrl.hostname = pagesHost;
      return fetch(new Request(pagesUrl.toString(), request));
    }

    const site = await loadSite(env.DB, target);
    if (!site) return holdingPage(404, "Site not found");

    if (target.context === "preview") {
      const claims = await verifyPreviewToken(readCookie(request, "wcz_preview"), env.PREVIEW_SECRET);
      if (!claims) return redirectToLogin(request, env);
      if (claims.sub !== site.owner_id) return holdingPage(404, "Site not found");
    }

    const status = effectiveStatus(site);

    if (target.context === "public" && !PUBLICLY_SERVEABLE.has(status)) {
      return holdingPage(404, "This site is not published yet");
    }

    let doc;
    try { doc = JSON.parse(site.content || "{}"); } catch { doc = {}; }
    const theme   = doc.theme   || {};
    const content = doc.content || {};

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

/* =========================================================================
 * Host + path resolution
 * ========================================================================= */
const RESERVED_SUBDOMAINS = new Set([
  "app","www","api","preview","dashboard","admin","assets","cdn","mail",
]);

function resolveHost(host, pathname, root) {
  const appHost = `app.${root}`;
  if (host === appHost) {
    const m = pathname.match(/^\/preview\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\/|$)/i);
    if (m) return { context: "preview", token: m[1].toLowerCase() };
    return { context: "app" }; // forward to auth/dashboard worker
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
  const cols = "id, owner_id, status, plan, draft_subdomain, custom_domain, custom_domain_status, template_id, content, published_at, expires_at";
  if (target.token) {
    return db.prepare(`SELECT ${cols} FROM sites WHERE draft_subdomain = ?1`).bind(target.token).first();
  }
  return db.prepare(`SELECT ${cols} FROM sites WHERE custom_domain = ?1`).bind(target.host).first();
}

const GRACE_WINDOW_SECONDS = 14 * 24 * 60 * 60;
function effectiveStatus(site) {
  if (site.status !== "published" && site.status !== "grace") return site.status;
  if (!site.expires_at) return site.status;
  const now = Math.floor(Date.now() / 1000);
  if (now <= site.expires_at) return "published";
  if (now <= site.expires_at + GRACE_WINDOW_SECONDS) return "grace";
  return "suspended";
}

/* =========================================================================
 * Skin registry
 * ========================================================================= */
const SKINS = {
  "bold-retail":        renderBoldRetail,
  "grill-house":        renderGrillHouse,
  "beauty-salon":       renderBeautySalon,
  "school-institution": renderSchoolInstitution,
  "advisory-firm":      renderAdvisoryFirm,
  "property-estate":    renderPropertyEstate,
};

// Alias mapping so template_id values from the editor work
const SKIN_ALIASES = {
  "restaurant": "grill-house",
  "salon":      "beauty-salon",
  "school":     "school-institution",
  "consultant": "advisory-firm",
  "realestate": "property-estate",
  "church":     "school-institution", // shares institution layout
  "sports":     "bold-retail",        // uses bold-retail + sports-sans
};

function renderSite(ctx) {
  const tid = ctx.site.template_id || "bold-retail";
  const key = SKINS[tid] ? tid : (SKIN_ALIASES[tid] || "bold-retail");
  const skin = SKINS[key];
  const body = skin(ctx);
  return wrapDocument(body, ctx, key);
}

/* =========================================================================
 * Theme tokens
 * ========================================================================= */
const PALETTES = {
  // Global
  "black-white-gold": { bg:"#0c0c0c", surface:"#161616", ink:"#f5f5f3", muted:"#a8a89f", accent:"#c8a24a", onAccent:"#0c0c0c", hero:"rgba(0,0,0,.62)" },
  "clean-white":      { bg:"#ffffff", surface:"#f6f6f4", ink:"#1a1a1a", muted:"#6b6b66", accent:"#1a1a1a", onAccent:"#ffffff", hero:"rgba(0,0,0,.55)" },
  "sky-blue":         { bg:"#0f1b2d", surface:"#16263d", ink:"#eef4fb", muted:"#9fb3cc", accent:"#3da5e0", onAccent:"#0f1b2d", hero:"rgba(15,27,45,.7)" },
  "elite-sports":     { bg:"#0a0a0a", surface:"#151515", ink:"#f5f6f5", muted:"#9aa0a6", accent:"#16a34a", onAccent:"#ffffff", hero:"rgba(0,0,0,.72)" },
  // Restaurant / grill
  "ember-cream":      { bg:"#FBF4E9", surface:"#fff",    ink:"#2A211A", muted:"#6E6055", accent:"#D2541F", onAccent:"#fff",    hero:"rgba(34,26,20,.88)" },
  // Salon / beauty
  "blush-plum":       { bg:"#ffffff", surface:"#F7ECEC", ink:"#2E2329", muted:"#7A6A70", accent:"#B08D57", onAccent:"#fff",    hero:"rgba(58,31,43,.68)" },
  // School / institution
  "navy-gold":        { bg:"#ffffff", surface:"#EAF1F9", ink:"#1C2733", muted:"#5C6976", accent:"#C99A2E", onAccent:"#fff",    hero:"rgba(17,51,92,.88)" },
  // Advisory / consultant
  "slate-gold":       { bg:"#ffffff", surface:"#F4F6FA", ink:"#1A2236", muted:"#5A6478", accent:"#C08A2D", onAccent:"#fff",    hero:"rgba(21,34,56,.82)" },
  // Property / real estate
  "forest-cream":     { bg:"#F6F1E7", surface:"#fff",    ink:"#1E2A24", muted:"#5E6B63", accent:"#B0852F", onAccent:"#fff",    hero:"rgba(19,57,42,.82)" },
};

const FONT_PAIRS = {
  "grotesk-serif":    { display:"'Fraunces', Georgia, serif",           body:"'Plus Jakarta Sans', system-ui, sans-serif", url:"https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" },
  "clean-sans":       { display:"'Space Grotesk', sans-serif",          body:"'Inter', system-ui, sans-serif",             url:"https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Space+Grotesk:wght@500;700&display=swap" },
  "sports-sans":      { display:"'Barlow Condensed', system-ui, sans-serif", body:"'Barlow', system-ui, sans-serif",       url:"https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700&display=swap" },
  "playfair-jakarta": { display:"'Playfair Display', Georgia, serif",   body:"'Plus Jakarta Sans', system-ui, sans-serif", url:"https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" },
  "garamond-jost":    { display:"'Cormorant Garamond', Georgia, serif", body:"'Jost', system-ui, sans-serif",              url:"https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Jost:wght@300;400;500;600&display=swap" },
};

// Per-skin defaults — used when theme.palette / theme.font_pair not set
const SKIN_DEFAULTS = {
  "bold-retail":        { palette:"clean-white",  font:"clean-sans",       sections:["hero","about","services","gallery","team","testimonials","contact"] },
  "grill-house":        { palette:"ember-cream",  font:"playfair-jakarta", sections:["hero","menu","about","gallery","contact"] },
  "beauty-salon":       { palette:"blush-plum",   font:"garamond-jost",    sections:["hero","services","about","gallery","team","contact"] },
  "school-institution": { palette:"navy-gold",    font:"grotesk-serif",    sections:["hero","stats","about","services","team","testimonials","contact"] },
  "advisory-firm":      { palette:"slate-gold",   font:"grotesk-serif",    sections:["hero","services","about","team","testimonials","contact"] },
  "property-estate":    { palette:"forest-cream", font:"grotesk-serif",    sections:["hero","services","about","gallery","contact"] },
};

function themeVars(theme, skinKey) {
  const def = SKIN_DEFAULTS[skinKey] || SKIN_DEFAULTS["bold-retail"];
  const p = PALETTES[theme.palette] || PALETTES[def.palette];
  const f = FONT_PAIRS[theme.font_pair] || FONT_PAIRS[def.font];
  const vars = [
    `--bg:${p.bg}`,`--surface:${p.surface}`,`--ink:${p.ink}`,
    `--muted:${p.muted}`,`--accent:${p.accent}`,`--on-accent:${p.onAccent}`,
    `--hero-overlay:${p.hero}`,
    `--font-display:${f.display}`,`--font-body:${f.body}`,
  ].join(";");
  return { vars, fontUrl: f.url };
}

/* =========================================================================
 * Document wrapper — shared <head>, CSS scaffold, draft banner, scripts
 * ========================================================================= */
function wrapDocument(body, ctx, skinKey) {
  const { vars, fontUrl } = themeVars(ctx.theme, skinKey);
  const imgs  = ctx.content.images || {};
  const title = esc(ctx.content.business_name || "Untitled site");
  const desc  = esc(ctx.content.tagline || "");
  const banner = ctx.showBanner ? draftBanner(ctx.status) : "";
  const favicon  = imgs.favicon || "";
  const ogImage  = imgs.hero || imgs.logo || "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
${favicon ? `<link rel="icon" href="${esc(favicon)}">` : ""}
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
  body{background:var(--bg);color:var(--ink);font-family:var(--font-body);line-height:1.62;-webkit-font-smoothing:antialiased}
  h1,h2,h3,h4{font-family:var(--font-display);line-height:1.08;font-weight:600}
  a{color:inherit;text-decoration:none}
  img{display:block;max-width:100%}
  .wrap{max-width:1120px;margin:0 auto;padding:0 26px}
  .section{padding:70px 0}
  .eyebrow{font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:var(--accent)}
  .btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--on-accent);padding:13px 24px;border-radius:8px;font-weight:600;font-size:.94rem;cursor:pointer;border:none;transition:.2s}
  .btn:hover{opacity:.88;transform:translateY(-1px)}
  .btn-ghost{background:rgba(255,255,255,.12);border:1.5px solid rgba(255,255,255,.45);color:#fff}
  .btn-ghost:hover{background:rgba(255,255,255,.22)}
  /* Nav */
  .nav{position:fixed;top:0;left:0;right:0;z-index:900;display:flex;align-items:center;justify-content:space-between;
       padding:18px 26px;transition:background .3s,padding .3s,border-color .3s;background:transparent;border-bottom:1px solid transparent}
  .nav.scrolled{background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(14px);padding:11px 26px;border-bottom-color:rgba(128,128,128,.16)}
  .nav-brand{display:flex;align-items:center;gap:10px;text-decoration:none}
  .nav-logo{height:38px;width:auto}
  .nav-logo-text{font-family:var(--font-display);font-weight:700;font-size:1.25rem;color:var(--ink)}
  .nav-cta{background:var(--accent);color:var(--on-accent);padding:9px 18px;border-radius:8px;font-weight:600;font-size:.86rem}
  /* Hero */
  .hero{position:relative;min-height:86vh;display:flex;align-items:flex-end;overflow:hidden}
  .hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.04);animation:hzoom 14s ease-out forwards}
  @keyframes hzoom{to{transform:scale(1)}}
  .hero-ov{position:absolute;inset:0;background:linear-gradient(0deg,var(--hero-overlay) 0%,rgba(0,0,0,.18) 55%,transparent 100%)}
  .hero-in{position:relative;z-index:2;padding:0 26px 64px;color:#fff;max-width:1120px;margin:0 auto;width:100%}
  .hero-in .eyebrow{color:rgba(255,255,255,.75)}
  .hero-in h1{font-size:clamp(2.8rem,7vw,5.2rem);margin:12px 0 16px;max-width:18ch;text-shadow:0 2px 30px rgba(0,0,0,.35)}
  .hero-in p{font-size:clamp(1rem,2vw,1.2rem);max-width:46ch;color:rgba(255,255,255,.88)}
  .hero-actions{display:flex;gap:14px;margin-top:28px;flex-wrap:wrap}
  /* Section heads */
  .sec-head{max-width:640px;margin-bottom:44px}
  .sec-head.center{margin:0 auto 44px;text-align:center}.sec-head.center .eyebrow{display:block;text-align:center}
  .sec-head h2{font-size:clamp(1.9rem,3.8vw,2.8rem);margin-top:10px}
  .sec-head p{color:var(--muted);margin-top:10px;font-size:1.02rem}
  /* Gallery + lightbox */
  .gal{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
  .gal button{padding:0;border:0;background:none;cursor:pointer;overflow:hidden;border-radius:12px;display:block;width:100%}
  .gal img{width:100%;height:270px;object-fit:cover;transition:transform .5s}
  .gal button:hover img{transform:scale(1.07)}
  .lb{position:fixed;inset:0;background:rgba(0,0,0,.94);display:none;align-items:center;justify-content:center;z-index:1000;padding:28px}
  .lb.open{display:flex}
  .lb img{max-width:100%;max-height:100%;border-radius:8px}
  .lb-close{position:absolute;top:16px;right:24px;color:#fff;font-size:40px;line-height:1;background:none;border:0;cursor:pointer}
  /* Reveal animation */
  .reveal{opacity:0;transform:translateY(16px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
  @keyframes rise{to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.reveal,.hero-bg{animation:none;opacity:1;transform:none}}
  ${ctx.showBanner ? "body{padding-top:44px}.has-banner .nav{top:44px}" : ""}
  @media(max-width:768px){.nav .nav-links{display:none}}
</style>
</head>
<body class="${ctx.showBanner ? "has-banner" : ""}">
${banner}
${body}
<script>
(function(){
  // Nav scroll behaviour
  var nav=document.querySelector('.nav');
  if(nav){var s=function(){nav.classList.toggle('scrolled',scrollY>40)};s();addEventListener('scroll',s,{passive:true});}
  // Mobile menu
  var ham=document.querySelector('.hamburger');
  var mob=document.querySelector('.mobile-menu');
  var cls=document.querySelector('.mob-close');
  if(ham&&mob){
    ham.addEventListener('click',function(){mob.classList.add('open');document.body.style.overflow='hidden'});
    function closeMob(){mob.classList.remove('open');document.body.style.overflow=''}
    if(cls)cls.addEventListener('click',closeMob);
    mob.addEventListener('click',function(e){if(e.target===mob)closeMob()});
    mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',closeMob)});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')closeMob()});
  }
  // Lightbox
  var lb=document.querySelector('.lb');
  if(lb){
    var lbi=lb.querySelector('img');
    document.querySelectorAll('.gal button').forEach(function(b){
      b.addEventListener('click',function(){lbi.src=b.dataset.full;lb.classList.add('open');document.body.style.overflow='hidden'});
    });
    var clslb=function(){lb.classList.remove('open');lbi.removeAttribute('src');document.body.style.overflow=''};
    lb.addEventListener('click',function(e){if(e.target===lb||e.target.classList.contains('lb-close'))clslb()});
    document.addEventListener('keydown',function(e){if(e.key==='Escape')clslb()});
  }
})();
</script>
</body>
</html>`;
}

function draftBanner(status) {
  const label = {
    draft:"Draft — not published",
    pending_payment:"Payment pending — publishing once confirmed",
    grace:"Live, but renewal overdue",
    suspended:"Suspended — renew to bring this site back online",
  }[status] || "Preview";
  return `<div style="position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;justify-content:center;gap:14px;background:#161616;color:#f5f5f3;font:500 14px system-ui;z-index:9999;border-bottom:1px solid rgba(255,255,255,.1)">
    <span>${esc(label)}</span>
    <a href="https://app.websites.co.zw/publish" style="background:var(--accent);color:var(--on-accent);padding:5px 14px;border-radius:6px;font-weight:600">Publish</a>
  </div>`;
}

/* =========================================================================
 * Shared section builders (used across skins)
 * ========================================================================= */

/* ── Nav link generation ──────────────────────────────────────────────────
 * Priority: content.nav_links[] (owner-defined) → auto from active sections
 * Each link: { label, href } e.g. { label:"Menu", href:"#menu" }
 * Auto-generated hrefs match the section id attrs set in each section builder.
 */
const SECTION_LABELS = {
  about:"About", services:"Services", menu:"Menu", gallery:"Gallery",
  team:"Team", testimonials:"Reviews", contact:"Contact", stats:null,
  video:null, hero:null, listings:"Listings",
};

function buildNavLinks(content, theme) {
  // Owner-defined links take absolute priority
  if (Array.isArray(content.nav_links) && content.nav_links.length) {
    return content.nav_links.slice(0, 6);
  }
  // Auto-generate from active sections (skip hero/stats/video — not linkable anchors)
  const sections = (Array.isArray(theme && theme.sections) && theme.sections.length)
    ? theme.sections : [];
  return sections
    .filter(s => SECTION_LABELS[s])
    .map(s => ({ label: SECTION_LABELS[s], href: "#" + s }));
}

function renderNavLinks(links, opts) {
  opts = opts || {};
  if (!links.length) return "";
  const cls = opts.light ? "nav-links light" : "nav-links";
  const items = links.map(l =>
    `<a href="${esc(l.href||"#")}">${esc(l.label||"")}</a>`
  ).join("");
  return `<div class="${cls}">${items}</div>`;
}

function renderMobileMenu(links, cta, opts) {
  opts = opts || {};
  const items = links.map(l =>
    `<a href="${esc(l.href||"#")}">${esc(l.label||"")}</a>`
  ).join("");
  return `<div class="mobile-menu" role="dialog" aria-modal="true" aria-label="Navigation">
    <button class="mob-close" aria-label="Close menu">&times;</button>
    ${items}
    ${cta ? `<span class="mob-cta">${cta}</span>` : ""}
  </div>`;
}

function buildCta(content, opts) {
  opts = opts || {};
  const s = content.socials || {};
  const c = content.contact || {};
  const label = opts.ctaLabel || "WhatsApp";
  const style = opts.ctaStyle || "";
  if (s.whatsapp)
    return `<a class="nav-cta" href="https://wa.me/${digits(s.whatsapp)}" style="${style}">${label}</a>`;
  if (c.phone)
    return `<a class="nav-cta" href="tel:${esc(c.phone)}" style="${style}">Call us</a>`;
  return "";
}

function buildHamburger(opts) {
  opts = opts || {};
  const cls = opts.light ? "hamburger light" : "hamburger";
  return `<button class="${cls}" aria-label="Open menu" aria-expanded="false">
    <span></span><span></span><span></span>
  </button>`;
}

function sharedNav(content, opts) {
  opts = opts || {};
  const imgs = content.images || {};
  const name = esc(content.business_name || "");
  const theme = opts.theme || {};
  const links = buildNavLinks(content, theme);
  const isLight = !!opts.lightText;
  const brand = imgs.logo
    ? `<img class="nav-logo" src="${esc(imgs.logo)}" alt="${name}">`
    : `<span class="nav-logo-text" style="${isLight ? "color:#fff" : ""}">${name}</span>`;
  const cta = buildCta(content, { ctaLabel: opts.ctaLabel || "WhatsApp", ctaStyle: opts.ctaStyle || "" });
  const navLinks = renderNavLinks(links, { light: isLight });
  const ham = buildHamburger({ light: isLight });
  // Mobile menu CTA is plain text inside a styled span — JS handles the click via the nav
  const mob = renderMobileMenu(links, cta);
  const navStyle = opts.forceStyle || "";
  return `<nav class="nav"${navStyle ? ` style="${navStyle}"` : ""}>
    <a class="nav-brand" href="#top" aria-label="${name}">${brand}</a>
    ${navLinks}
    <div style="display:flex;align-items:center;gap:12px">${cta}${ham}</div>
  </nav>
  ${mob}`;
}

function sharedHero(content, opts) {
  opts = opts || {};
  const imgs = content.images || {};
  const name = esc(content.business_name || "Your business");
  const tag  = esc(content.tagline || "");
  const s    = content.socials || {};
  const bg   = imgs.hero ? `background-image:url('${esc(imgs.hero)}')` : `background:var(--bg)`;
  const cta1 = s.whatsapp
    ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}">${opts.ctaLabel || "WhatsApp us"}</a>`
    : "";
  const cta2 = opts.cta2 || "";
  const eyebrow = opts.eyebrow ? `<p class="eyebrow reveal">${esc(opts.eyebrow)}</p>` : "";

  return `<header class="hero" id="top">
    <div class="hero-bg" style="${bg}"></div>
    <div class="hero-ov"></div>
    <div class="hero-in">
      ${eyebrow}
      <h1 class="reveal">${name}</h1>
      ${tag ? `<p class="reveal" style="animation-delay:.07s">${tag}</p>` : ""}
      ${(cta1 || cta2) ? `<div class="hero-actions reveal" style="animation-delay:.14s">${cta1}${cta2}</div>` : ""}
    </div>
  </header>`;
}

function sharedAbout(content) {
  const about = content.about || (typeof content.about_text === "string" ? content.about_text : "");
  if (!about) return "";
  return `<section class="section" id="about" style="background:var(--surface)"><div class="wrap" style="max-width:760px">
    <p class="eyebrow">About us</p>
    <p style="font-size:clamp(1.15rem,2.4vw,1.5rem);margin-top:16px;line-height:1.55;color:var(--ink)">${esc(about)}</p>
  </div></section>`;
}

function sharedServices(content, opts) {
  opts = opts || {};
  const items = Array.isArray(content.services) ? content.services : [];
  if (!items.length) return "";
  const cards = items.map(s => `<div style="background:var(--bg);padding:28px 24px;border-radius:14px;border:1px solid rgba(128,128,128,.12)">
      <h3 style="font-size:1.12rem">${esc(s.title || "")}</h3>
      <p style="color:var(--muted);margin-top:10px;font-size:.94rem;line-height:1.55">${esc(s.body || s.description || "")}</p>
      ${s.price ? `<p style="font-weight:600;margin-top:14px;color:var(--accent)">${esc(s.price)}</p>` : ""}
    </div>`).join("");
  return `<section class="section" id="services"><div class="wrap">
    <div class="sec-head${opts.center ? " center" : ""}">
      <p class="eyebrow">${esc(opts.label || "What we do")}</p>
      <h2>${esc(opts.heading || "Our services")}</h2>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px">${cards}</div>
  </div></section>`;
}

function sharedGallery(content) {
  const imgs = Array.isArray(content.images && content.images.gallery) ? content.images.gallery : [];
  if (!imgs.length) return "";
  const cells = imgs.map(src => `<button data-full="${esc(src)}" aria-label="View image"><img loading="lazy" src="${esc(src)}" alt=""></button>`).join("");
  return `<section class="section" id="gallery" style="background:var(--surface)"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Gallery</p><h2>Our work</h2></div>
    <div class="gal">${cells}</div>
  </div></section>
  <div class="lb"><button class="lb-close" aria-label="Close">&times;</button><img alt=""></div>`;
}

function sharedTeam(content, opts) {
  opts = opts || {};
  const items = Array.isArray(content.team) ? content.team : [];
  if (!items.length) return "";
  if (items.length === 1) {
    const m = items[0];
    return `<section class="section" id="team" style="background:var(--surface)"><div class="wrap">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:44px;max-width:900px;margin:0 auto">
        ${m.photo ? `<img loading="lazy" src="${esc(m.photo)}" alt="${esc(m.name||"")}" style="width:200px;height:200px;border-radius:16px;object-fit:cover;flex:none;border:3px solid var(--accent)">` : ""}
        <div style="flex:1;min-width:240px">
          <p class="eyebrow">${esc(opts.label || "Our team")}</p>
          <h3 style="font-size:clamp(1.6rem,3vw,2.2rem);margin-top:10px">${esc(m.name||"")}</h3>
          ${m.role ? `<p style="color:var(--accent);font-weight:600;margin-top:6px">${esc(m.role)}</p>` : ""}
          ${m.bio  ? `<p style="color:var(--muted);margin-top:16px;line-height:1.6">${esc(m.bio)}</p>` : ""}
        </div>
      </div>
    </div></section>`;
  }
  const cards = items.map(m => `<div style="text-align:center">
      ${m.photo ? `<img loading="lazy" src="${esc(m.photo)}" alt="${esc(m.name||"")}" style="width:120px;height:120px;border-radius:50%;object-fit:cover;margin:0 auto 14px;border:3px solid var(--accent)">` : ""}
      <h3 style="font-size:1.05rem">${esc(m.name||"")}</h3>
      ${m.role ? `<p style="color:var(--accent);font-size:.84rem;font-weight:600;margin-top:4px">${esc(m.role)}</p>` : ""}
      ${m.bio  ? `<p style="color:var(--muted);font-size:.86rem;margin-top:8px">${esc(m.bio)}</p>` : ""}
    </div>`).join("");
  return `<section class="section" id="team" style="background:var(--surface)"><div class="wrap">
    <div class="sec-head center"><p class="eyebrow">${esc(opts.label || "Our team")}</p><h2>${esc(opts.heading || "Meet the team")}</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:28px">${cards}</div>
  </div></section>`;
}

function sharedTestimonials(content, opts) {
  opts = opts || {};
  const items = Array.isArray(content.testimonials) ? content.testimonials : [];
  if (!items.length) return "";
  const cards = items.map(t => `<figure style="background:var(--bg);padding:28px;border-radius:14px;border:1px solid rgba(128,128,128,.12);margin:0">
      <blockquote style="font-size:1.05rem;line-height:1.6">"${esc(t.quote||"")}"</blockquote>
      <figcaption style="margin-top:18px;display:flex;align-items:center;gap:12px">
        ${t.photo ? `<img loading="lazy" src="${esc(t.photo)}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex:none">` : ""}
        <span style="font-size:.88rem;color:var(--muted)"><strong style="color:var(--ink)">${esc(t.name||"")}</strong>${t.role ? `<br>${esc(t.role)}` : ""}</span>
      </figcaption>
    </figure>`).join("");
  return `<section class="section" id="testimonials"><div class="wrap">
    <div class="sec-head center"><p class="eyebrow">Testimonials</p><h2>${esc(opts.heading || "What people say")}</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px">${cards}</div>
  </div></section>`;
}

function sharedContact(content) {
  const c = content.contact || {};
  const s = content.socials  || {};
  const rows = [];
  if (c.phone)    rows.push(contactRow("Phone",    `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`));
  if (c.email)    rows.push(contactRow("Email",    `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`));
  if (c.address)  rows.push(contactRow("Address",  esc(c.address)));
  if (s.whatsapp) rows.push(contactRow("WhatsApp", `<a href="https://wa.me/${digits(s.whatsapp)}">${esc(s.whatsapp)}</a>`));
  if (s.facebook) rows.push(contactRow("Facebook", `<a href="${esc(s.facebook)}">Visit page</a>`));
  if (!rows.length) return "";
  return `<section class="section" id="contact" style="background:var(--surface)"><div class="wrap" style="max-width:640px">
    <div class="sec-head"><p class="eyebrow">Find us</p><h2>Get in touch</h2></div>
    ${rows.join("")}
    ${s.whatsapp ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}" style="margin-top:24px">💬 Chat on WhatsApp</a>` : ""}
  </div></section>`;
}

function contactRow(label, value) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:15px 0;border-bottom:1px solid rgba(128,128,128,.12)">
    <span style="color:var(--muted);font-size:.9rem">${esc(label)}</span><span style="font-weight:500">${value}</span></div>`;
}

function sharedFooter(content) {
  const imgs = content.images || {};
  return `<footer style="padding:50px 0;text-align:center;color:var(--muted);font-size:.84rem;border-top:1px solid rgba(128,128,128,.12)">
    <div class="wrap">
      ${imgs.logo ? `<img src="${esc(imgs.logo)}" alt="" style="height:36px;width:auto;margin:0 auto 16px;opacity:.85">` : ""}
      <p>© ${new Date().getFullYear()} ${esc(content.business_name||"")}</p>
      <p style="margin-top:6px;opacity:.65">Built on <a href="https://websites.co.zw" style="text-decoration:underline">websites.co.zw</a></p>
    </div>
  </footer>`;
}

function sharedStats(content) {
  const items = Array.isArray(content.stats) ? content.stats : [];
  if (!items.length) return "";
  const cells = items.map(s => `<div style="text-align:center">
      <p style="font-family:var(--font-display);font-size:clamp(2rem,4vw,2.8rem);font-weight:700;color:var(--accent)">${esc(s.value||"")}</p>
      <p style="font-size:.84rem;color:var(--muted);margin-top:4px">${esc(s.label||"")}</p>
    </div>`).join("");
  return `<div id="stats" style="background:var(--ink);color:var(--bg);padding:28px 0">
    <div class="wrap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:20px;padding:0 26px">
      ${cells}
    </div>
  </div>`;
}

function sharedVideo(content, plan) {
  const v = content.video || {};
  if (v.embedUrl) {
    return `<section class="section"><div class="wrap" style="max-width:880px;aspect-ratio:16/9">
      <iframe src="${esc(v.embedUrl)}" style="width:100%;height:100%;border:0;border-radius:14px" allowfullscreen loading="lazy"></iframe>
    </div></section>`;
  }
  if (v.r2Url && plan === "pro") {
    return `<section class="section"><div class="wrap" style="max-width:880px">
      <video controls preload="none" poster="${esc(v.poster||"")}" style="width:100%;border-radius:14px"><source src="${esc(v.r2Url)}"></video>
    </div></section>`;
  }
  return "";
}

/* =========================================================================
 * SKIN: bold-retail (default — general purpose)
 * ========================================================================= */
function renderBoldRetail(ctx) {
  const { content, theme, site } = ctx;
  const def = SKIN_DEFAULTS["bold-retail"];
  const sections = (Array.isArray(theme.sections) && theme.sections.length) ? theme.sections : def.sections;
  const parts = sections.map(n => {
    switch (n) {
      case "hero":         return sharedHero(content, { ctaLabel: "WhatsApp us" });
      case "about":        return sharedAbout(content);
      case "services":     return sharedServices(content);
      case "gallery":      return sharedGallery(content);
      case "team":         return sharedTeam(content);
      case "testimonials": return sharedTestimonials(content);
      case "video":        return sharedVideo(content, site.plan);
      case "contact":      return sharedContact(content);
      default: return "";
    }
  });
  return sharedNav(content, { theme }) + parts.join("") + sharedFooter(content);
}

/* =========================================================================
 * SKIN: grill-house (restaurants, cafés, grills)
 * Palette: ember-cream · Font: playfair-jakarta
 * Signature: dark sticky nav, full-bleed fire-gradient hero bottom-anchored,
 *            menu section with category tabs, tinted section bands
 * ========================================================================= */
function renderGrillHouse(ctx) {
  const { content, theme, site } = ctx;
  const def = SKIN_DEFAULTS["grill-house"];
  const sections = (Array.isArray(theme.sections) && theme.sections.length) ? theme.sections : def.sections;
  const parts = sections.map(n => {
    switch (n) {
      case "hero":    return grillHero(content);
      case "menu":    return grillMenu(content);
      case "about":   return sharedAbout(content);
      case "gallery": return sharedGallery(content);
      case "video":   return sharedVideo(content, site.plan);
      case "contact": return grillContact(content);
      default: return "";
    }
  });
  return grillNav(content, theme) + parts.join("") + sharedFooter(content);
}

function grillNav(content, theme) {
  return sharedNav(content, {
    lightText: true,
    theme,
    ctaLabel: "Reserve a table",
    forceStyle: "background:rgba(34,26,20,.92)",
  });
}

function grillHero(content) {
  const imgs = content.images || {};
  const name = esc(content.business_name || "");
  const tag  = esc(content.tagline || "");
  const c    = content.contact || {};
  const s    = content.socials || {};
  const bg   = imgs.hero ? `background-image:url('${esc(imgs.hero)}')` : `background:#221A14`;
  const eyebrow = content.location ? esc(content.location) : "";
  const cta1 = s.whatsapp ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}" style="background:var(--accent)">Reserve a table</a>` : "";
  const cta2 = c.phone ? `<a class="btn btn-ghost" href="tel:${esc(c.phone)}">Call us</a>` : "";
  return `<header class="hero" id="top" style="min-height:88vh;align-items:flex-end">
    <div class="hero-bg" style="${bg}"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(0deg,rgba(34,26,20,.94) 0%,rgba(34,26,20,.18) 55%,transparent 100%)"></div>
    <div class="hero-in" style="padding-bottom:70px">
      ${eyebrow ? `<p style="font-size:.8rem;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:10px">${eyebrow}</p>` : ""}
      <h1 class="reveal" style="font-size:clamp(3rem,7vw,5.5rem)">${name}</h1>
      ${tag ? `<p class="reveal" style="animation-delay:.07s;font-size:1.1rem;color:rgba(255,255,255,.85);max-width:44ch">${tag}</p>` : ""}
      ${(cta1||cta2) ? `<div class="hero-actions reveal" style="animation-delay:.14s">${cta1}${cta2}</div>` : ""}
    </div>
  </header>`;
}

function grillMenu(content) {
  const menu = content.menu || {};
  const categories = Array.isArray(menu.categories) ? menu.categories : [];
  // Fallback: if no dedicated menu, use services as menu items
  if (!categories.length) {
    return sharedServices(content, { label: "Our menu", heading: "What we serve" });
  }
  const tabs = categories.map((cat, i) =>
    `<button class="pill" onclick="showCat(${i})" id="tab-${i}" style="${i===0?"background:var(--ink);color:var(--bg)":""}">${esc(cat.name||"")}</button>`
  ).join("");
  const panels = categories.map((cat, i) => {
    const items = Array.isArray(cat.items) ? cat.items : [];
    const rows = items.map(item => `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:14px 0;border-bottom:1px dashed rgba(128,128,128,.15)">
        <div>
          <p style="font-weight:600">${esc(item.name||"")}</p>
          ${item.description ? `<p style="color:var(--muted);font-size:.88rem;margin-top:3px">${esc(item.description)}</p>` : ""}
        </div>
        ${item.price ? `<span style="font-weight:700;color:var(--accent);margin-left:16px;white-space:nowrap">${esc(item.price)}</span>` : ""}
      </div>`).join("");
    return `<div id="cat-${i}" style="${i===0?"":"display:none"}">${rows}</div>`;
  }).join("");

  return `<section class="section" id="menu" style="background:var(--surface)"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Menu</p><h2>What we serve</h2></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px">${tabs}</div>
    <div>${panels}</div>
  </div></section>
  <style>.pill{display:inline-block;border:1px solid rgba(128,128,128,.2);border-radius:100px;padding:8px 18px;font-weight:600;font-size:.88rem;cursor:pointer;font-family:var(--font-body);background:var(--bg);color:var(--ink);transition:.18s}.pill:hover{background:var(--ink);color:var(--bg)}</style>
  <script>function showCat(i){document.querySelectorAll('[id^="cat-"]').forEach(function(p){p.style.display='none'});document.getElementById('cat-'+i).style.display='';document.querySelectorAll('[id^="tab-"]').forEach(function(t,j){t.style.background=j===i?'var(--ink)':'';t.style.color=j===i?'var(--bg)':''});}</script>`;
}

function grillContact(content) {
  const c = content.contact || {};
  const s = content.socials  || {};
  const rows = [];
  if (c.phone)    rows.push(contactRow("Reservations", `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`));
  if (s.whatsapp) rows.push(contactRow("WhatsApp",     `<a href="https://wa.me/${digits(s.whatsapp)}">${esc(s.whatsapp)}</a>`));
  if (c.address)  rows.push(contactRow("Address",      esc(c.address)));
  if (content.hours) rows.push(contactRow("Hours",     esc(content.hours)));
  if (c.email)    rows.push(contactRow("Email",        `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`));
  if (!rows.length) return "";
  return `<section class="section" id="contact"><div class="wrap" style="max-width:640px">
    <div class="sec-head"><p class="eyebrow">Visit us</p><h2>Find us &amp; book</h2></div>
    ${rows.join("")}
    ${s.whatsapp ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}" style="margin-top:24px">💬 Reserve via WhatsApp</a>` : ""}
  </div></section>`;
}

/* =========================================================================
 * SKIN: beauty-salon (salons, spas, clinics)
 * Palette: blush-plum · Font: garamond-jost
 * Signature: editorial left-anchored hero, dashed service price list,
 *            delicate lines, gold accents
 * ========================================================================= */
function renderBeautySalon(ctx) {
  const { content, theme, site } = ctx;
  const def = SKIN_DEFAULTS["beauty-salon"];
  const sections = (Array.isArray(theme.sections) && theme.sections.length) ? theme.sections : def.sections;
  const parts = sections.map(n => {
    switch (n) {
      case "hero":         return salonHero(content);
      case "services":     return salonServices(content);
      case "about":        return sharedAbout(content);
      case "gallery":      return sharedGallery(content);
      case "team":         return sharedTeam(content, { label: "Our stylists", heading: "Meet the team" });
      case "testimonials": return sharedTestimonials(content, { heading: "Client love" });
      case "contact":      return sharedContact(content);
      default: return "";
    }
  });
  return salonNav(content, theme) + parts.join("") + sharedFooter(content);
}

function salonNav(content, theme) {
  return sharedNav(content, {
    theme,
    ctaLabel: "Book now",
    ctaStyle: "border-radius:2px;letter-spacing:.06em;text-transform:uppercase;font-size:.78rem",
  });
}

function salonHero(content) {
  const imgs = content.images || {};
  const name = esc(content.business_name || "");
  const tag  = esc(content.tagline || "");
  const s    = content.socials || {};
  const bg   = imgs.hero ? `background-image:url('${esc(imgs.hero)}')` : `background:#3A1F2B`;
  const cta  = s.whatsapp
    ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}" style="background:var(--accent);border-radius:2px">Book an appointment</a>`
    : "";
  return `<header class="hero" id="top" style="min-height:82vh;align-items:center">
    <div class="hero-bg" style="${bg}"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(58,31,43,.75) 0%,rgba(58,31,43,.22) 100%)"></div>
    <div class="hero-in" style="padding-bottom:0;padding-top:80px">
      <p style="font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.7);margin-bottom:14px">${esc(content.location||"")}</p>
      <h1 class="reveal" style="font-size:clamp(2.8rem,6vw,4.8rem);max-width:16ch">${name}</h1>
      ${tag ? `<p class="reveal" style="animation-delay:.07s;font-size:1.1rem;max-width:40ch;color:rgba(255,255,255,.88)">${tag}</p>` : ""}
      ${cta ? `<div class="reveal" style="margin-top:28px;animation-delay:.14s">${cta}</div>` : ""}
    </div>
  </header>`;
}

function salonServices(content) {
  const items = Array.isArray(content.services) ? content.services : [];
  if (!items.length) return "";
  // Salon layout: dashed price list, not cards
  const rows = items.map(s => `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:16px 0;border-bottom:1px dashed rgba(128,128,128,.2)">
      <div>
        <p style="font-weight:600">${esc(s.title||"")}</p>
        ${s.body||s.description ? `<p style="color:var(--muted);font-size:.86rem;margin-top:3px">${esc(s.body||s.description||"")}</p>` : ""}
      </div>
      ${s.price ? `<span style="font-family:var(--font-display);font-size:1.05rem;font-weight:600;color:var(--accent);margin-left:16px;white-space:nowrap">${esc(s.price)}</span>` : ""}
    </div>`).join("");
  return `<section class="section" id="services"><div class="wrap" style="max-width:700px">
    <div class="sec-head"><p class="eyebrow">Services</p><h2>Our treatments &amp; prices</h2></div>
    ${rows}
  </div></section>`;
}

/* =========================================================================
 * SKIN: school-institution (schools, churches, NGOs, academies)
 * Palette: navy-gold · Font: grotesk-serif
 * Signature: top info bar, stats band, crest in nav, institutional gravitas
 * ========================================================================= */
function renderSchoolInstitution(ctx) {
  const { content, theme, site } = ctx;
  const def = SKIN_DEFAULTS["school-institution"];
  const sections = (Array.isArray(theme.sections) && theme.sections.length) ? theme.sections : def.sections;
  const topbar = content.contact
    ? schoolTopbar(content)
    : "";
  const parts = sections.map(n => {
    switch (n) {
      case "hero":         return sharedHero(content, { eyebrow: content.location, ctaLabel: "Enquire now" });
      case "stats":        return sharedStats(content);
      case "about":        return sharedAbout(content);
      case "services":     return sharedServices(content, { label: "Programmes", heading: "What we offer" });
      case "team":         return sharedTeam(content, { label: "Leadership", heading: "Our leadership team" });
      case "testimonials": return sharedTestimonials(content, { heading: "What parents say" });
      case "video":        return sharedVideo(content, site.plan);
      case "contact":      return sharedContact(content);
      default: return "";
    }
  });
  return topbar + schoolNav(content, theme) + parts.join("") + sharedFooter(content);
}

function schoolTopbar(content) {
  const c = content.contact || {};
  const phone = c.phone ? `📞 ${esc(c.phone)}` : "";
  const email = c.email ? `✉ ${esc(c.email)}` : "";
  const info  = [phone, email].filter(Boolean).join(" &nbsp;·&nbsp; ");
  return `<div style="background:var(--ink);color:rgba(255,255,255,.78);font-size:.8rem;padding:7px 0">
    <div class="wrap" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
      <span>${esc(content.business_name||"")}</span><span>${info}</span>
    </div>
  </div>`;
}

function schoolNav(content, theme) {
  return sharedNav(content, { theme, ctaLabel: "Enquire now" });
}

/* =========================================================================
 * SKIN: advisory-firm (consultants, lawyers, accountants)
 * Palette: slate-gold · Font: grotesk-serif
 * Signature: split hero (text left / image right), stats inline,
 *            clean professional layout with sidebar contact
 * ========================================================================= */
function renderAdvisoryFirm(ctx) {
  const { content, theme, site } = ctx;
  const def = SKIN_DEFAULTS["advisory-firm"];
  const sections = (Array.isArray(theme.sections) && theme.sections.length) ? theme.sections : def.sections;
  const parts = sections.map(n => {
    switch (n) {
      case "hero":         return advisoryHero(content);
      case "services":     return sharedServices(content, { label: "Practice areas", heading: "How we can help" });
      case "about":        return sharedAbout(content);
      case "team":         return sharedTeam(content, { label: "Our people", heading: "The team" });
      case "testimonials": return sharedTestimonials(content, { heading: "Client feedback" });
      case "contact":      return sharedContact(content);
      default: return "";
    }
  });
  return sharedNav(content, { theme }) + parts.join("") + sharedFooter(content);
}

function advisoryHero(content) {
  const imgs = content.images || {};
  const name = esc(content.business_name || "");
  const tag  = esc(content.tagline || "");
  const s    = content.socials || {};
  const c    = content.contact || {};
  const stats = Array.isArray(content.stats) ? content.stats : [];

  // If there's a hero image, use the full-bleed version
  if (imgs.hero) {
    return sharedHero(content, { eyebrow: content.location, ctaLabel: "Book a consultation" });
  }

  // Text-only split layout — more appropriate for a professional firm without photography
  const cta1 = s.whatsapp ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}">WhatsApp us</a>` : "";
  const cta2 = c.phone    ? `<a class="btn" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink)" href="tel:${esc(c.phone)}">Call us</a>` : "";
  const statHtml = stats.length ? `<div style="display:flex;gap:40px;margin-top:36px;flex-wrap:wrap">${
    stats.map(s => `<div><p style="font-family:var(--font-display);font-size:2rem;font-weight:700;color:var(--ink)">${esc(s.value)}</p><p style="font-size:.82rem;color:var(--muted);margin-top:2px">${esc(s.label)}</p></div>`).join("")
  }</div>` : "";
  const heroImg = imgs.profile || imgs.team || "";
  return `<section style="padding:120px 0 80px" id="top"><div class="wrap">
    <div style="display:grid;grid-template-columns:${heroImg?"1fr 1fr":"1fr"};gap:56px;align-items:center">
      <div>
        ${content.location ? `<p class="eyebrow" style="margin-bottom:14px">${esc(content.location)}</p>` : ""}
        <h1 style="font-size:clamp(2.4rem,5vw,3.6rem);max-width:18ch">${name}</h1>
        ${tag ? `<p style="font-size:1.1rem;color:var(--muted);margin-top:16px;max-width:46ch">${tag}</p>` : ""}
        ${(cta1||cta2) ? `<div style="display:flex;gap:14px;margin-top:28px;flex-wrap:wrap">${cta1}${cta2}</div>` : ""}
        ${statHtml}
      </div>
      ${heroImg ? `<div><img src="${esc(heroImg)}" alt="" style="width:100%;border-radius:16px;aspect-ratio:4/3.4;object-fit:cover;box-shadow:0 40px 80px -40px rgba(21,34,56,.35)"></div>` : ""}
    </div>
  </div></section>`;
}

/* =========================================================================
 * SKIN: property-estate (real estate agents, developers, rentals)
 * Palette: forest-cream · Font: grotesk-serif
 * Signature: search bar in hero, property listing cards, forest green CTA
 * ========================================================================= */
function renderPropertyEstate(ctx) {
  const { content, theme, site } = ctx;
  const def = SKIN_DEFAULTS["property-estate"];
  const sections = (Array.isArray(theme.sections) && theme.sections.length) ? theme.sections : def.sections;
  const parts = sections.map(n => {
    switch (n) {
      case "hero":    return estateHero(content);
      case "services":return sharedServices(content, { label: "What we offer", heading: "Our services" });
      case "about":   return sharedAbout(content);
      case "gallery": return estateListings(content);
      case "contact": return sharedContact(content);
      default: return "";
    }
  });
  return estateNav(content, theme) + parts.join("") + sharedFooter(content);
}

function estateNav(content, theme) {
  return sharedNav(content, { theme, ctaLabel: "View listings" });
}

function estateHero(content) {
  const imgs = content.images || {};
  const name = esc(content.business_name || "");
  const tag  = esc(content.tagline || "");
  const s    = content.socials || {};
  const bg   = imgs.hero ? `background-image:url('${esc(imgs.hero)}')` : `background:#13392A`;
  const cta  = s.whatsapp
    ? `<a class="btn" href="https://wa.me/${digits(s.whatsapp)}" style="background:var(--accent)">View listings on WhatsApp</a>`
    : "";
  return `<header class="hero" id="top" style="min-height:78vh">
    <div class="hero-bg" style="${bg}"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(19,57,42,.88) 0%,rgba(19,57,42,.3) 100%)"></div>
    <div class="hero-in" style="padding-bottom:0;padding-top:80px">
      ${content.location ? `<p style="font-size:.8rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.7);margin-bottom:12px">${esc(content.location)}</p>` : ""}
      <h1 class="reveal" style="font-size:clamp(2.6rem,6vw,5rem);max-width:18ch">${name}</h1>
      ${tag ? `<p class="reveal" style="animation-delay:.07s;font-size:1.1rem;max-width:46ch;color:rgba(255,255,255,.88)">${tag}</p>` : ""}
      ${cta ? `<div class="reveal" style="margin-top:30px;animation-delay:.14s">${cta}</div>` : ""}
    </div>
  </header>`;
}

function estateListings(content) {
  // If the owner has provided property listings in content.listings[], show cards.
  // Otherwise fall back to the gallery grid.
  const listings = Array.isArray(content.listings) ? content.listings : [];
  if (!listings.length) return sharedGallery(content);

  const cards = listings.map(p => `<div style="background:var(--bg);border:1px solid rgba(128,128,128,.14);border-radius:14px;overflow:hidden">
      ${p.image ? `<div style="aspect-ratio:16/10;background-image:url('${esc(p.image)}');background-size:cover;background-position:center"></div>` : ""}
      <div style="padding:18px">
        <p style="font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:6px">${esc(p.type||"Property")}</p>
        <h3 style="font-size:1.05rem">${esc(p.title||"")}</h3>
        ${p.location ? `<p style="font-size:.88rem;color:var(--muted);margin-top:4px">📍 ${esc(p.location)}</p>` : ""}
        ${p.price    ? `<p style="font-family:var(--font-display);font-size:1.2rem;font-weight:700;color:var(--ink);margin-top:10px">${esc(p.price)}</p>` : ""}
        ${p.beds||p.baths ? `<p style="font-size:.84rem;color:var(--muted);margin-top:6px">${p.beds?esc(p.beds)+" bed":""} ${p.baths?esc(p.baths)+" bath":""}</p>` : ""}
      </div>
    </div>`).join("");

  return `<section class="section" id="listings"><div class="wrap">
    <div class="sec-head"><p class="eyebrow">Listings</p><h2>Available properties</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px">${cards}</div>
  </div></section>`;
}

/* =========================================================================
 * Static asset serving (R2)
 * ========================================================================= */
async function serveAsset(request, env, ctx, url) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  if (!env.ASSETS) return new Response("Asset store not configured", { status: 500 });
  const key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  const resp = new Response(obj.body, { headers });
  ctx.waitUntil(cache.put(request, resp.clone()));
  return resp;
}

/* =========================================================================
 * Holding page
 * ========================================================================= */
function holdingPage(code, message) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(message)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0c0c;color:#f5f5f3;font:400 16px system-ui;text-align:center;padding:24px}a{color:#c8a24a}</style>
</head><body><div><h1 style="font-size:22px;font-weight:600">${esc(message)}</h1>
<p style="color:#a8a89f;margin-top:10px">Powered by <a href="https://websites.co.zw">websites.co.zw</a></p></div></body></html>`;
  return new Response(html, { status: code, headers: { "content-type": "text/html; charset=utf-8" } });
}

/* =========================================================================
 * Helpers
 * ========================================================================= */
function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
function redirectToLogin(request, env) {
  const loginUrl = env.APP_LOGIN_URL || "https://app.websites.co.zw/login";
  return Response.redirect(`${loginUrl}?next=${encodeURIComponent(request.url)}`, 302);
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function digits(s) { return String(s||"").replace(/[^\d]/g,""); }

/* =========================================================================
 * Preview auth (inlined — no imports)
 * ========================================================================= */
const enc = new TextEncoder();
function b64url(bytes){let b="";const a=new Uint8Array(bytes);for(let i=0;i<a.length;i++)b+=String.fromCharCode(a[i]);return btoa(b).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function b64urlToBytes(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const b=atob(s),o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;}
async function hmacKey(secret){return crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
async function verifyPreviewToken(token,secret){
  if(!token||!secret||!token.includes("."))return null;
  const[pb,sb]=token.split(".");if(!pb||!sb)return null;
  const key=await hmacKey(secret);
  let ok=false;
  try{ok=await crypto.subtle.verify("HMAC",key,b64urlToBytes(sb),enc.encode(pb));}catch{return null;}
  if(!ok)return null;
  let p;try{p=JSON.parse(new TextDecoder().decode(b64urlToBytes(pb)));}catch{return null;}
  if(p.scope!=="preview")return null;
  if(!p.exp||Math.floor(Date.now()/1000)>p.exp)return null;
  return p;
}
