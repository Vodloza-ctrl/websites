// render.js — the one render function, run in BOTH the Worker (to serve the live
// site) and the browser (to drive the editor preview). No framework. This is the
// piece that keeps a static-first multi-tenant platform DRY: layout lives here,
// content lives in the per-site config JSON (see data/demo.json).
//
//   Worker:   return new Response(renderSite(config), { headers:{'content-type':'text/html'} })
//   Editor:   iframe.srcdoc = renderSite(draftConfig)

export function renderSite(cfg) {
  const a = cfg.theme?.accent || '#15924B';
  const img = (seed, w, h) => `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;

  const services = (cfg.services || [])
    .map((s) => `
      <div class="card">
        <div class="ic" style="background:${a}1a;color:${a}">${s.icon || '•'}</div>
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.body)}</p>
      </div>`)
    .join('');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(cfg.business)} — ${esc(cfg.tagline || '')}</title>
<style>
  :root{--a:${a};--ink:#231C16;--ink2:#6B5F52;--line:rgba(0,0,0,.1)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;color:var(--ink);line-height:1.6}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}
  header{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--line)}
  .logo{font-weight:800;font-size:1.2rem}
  .btn{background:var(--a);color:#fff;font-weight:600;padding:10px 18px;border-radius:8px;text-decoration:none}
  .hero{position:relative;min-height:60vh;display:flex;align-items:center;color:#fff}
  .hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.6),rgba(0,0,0,.2))}
  .hero .wrap{position:relative;z-index:2}
  .hero h1{font-size:clamp(2.2rem,5vw,3.6rem);max-width:16ch}
  .hero p{margin-top:14px;max-width:42ch;font-size:1.1rem;color:rgba(255,255,255,.9)}
  .hero .btn{display:inline-block;margin-top:24px}
  .services{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:60px 0}
  .card{border:1px solid var(--line);border-radius:14px;padding:24px}
  .card .ic{width:44px;height:44px;border-radius:11px;display:grid;place-items:center;font-size:1.3rem;margin-bottom:14px}
  .wa{display:inline-flex;gap:9px;background:#25D366;color:#fff;font-weight:700;padding:13px 24px;border-radius:10px;text-decoration:none}
  footer{border-top:1px solid var(--line);padding:30px 0;color:var(--ink2);font-size:.9rem}
  @media(max-width:760px){.services{grid-template-columns:1fr}}
</style></head><body>
<header class="wrap"><span class="logo">${esc(cfg.business)}</span><a class="btn" href="#contact">${esc(cfg.cta || 'Contact')}</a></header>
<section class="hero"><img src="${img(cfg.heroImage || cfg.business, 1500, 900)}" alt=""><div class="wrap">
  <h1>${esc(cfg.headline)}</h1><p>${esc(cfg.tagline)}</p>
  <a class="btn" href="#contact">${esc(cfg.cta || 'Get in touch')}</a>
</div></section>
<section class="wrap services">${services}</section>
<section class="wrap" id="contact" style="padding-bottom:60px">
  <h2 style="font-size:1.8rem;margin-bottom:14px">${esc(cfg.contact?.heading || "Let's talk")}</h2>
  <a class="wa" href="https://wa.me/${(cfg.contact?.whatsapp || '').replace(/\\D/g, '')}">💬 Chat on WhatsApp</a>
</section>
<footer class="wrap">© ${new Date().getFullYear()} ${esc(cfg.business)} · Built with websites.co.zw</footer>
</body></html>`;
}

function esc(s = '') {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
