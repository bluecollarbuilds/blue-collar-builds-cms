/**
 * fixture-site.mjs — a tiny multi-page "live site" for the ingest tests to capture.
 * Stands in for a real Astro/static build: a sitemap, several real pages, plus the
 * awkward cases (a redirect, a 404, a non-HTML file, an off-site link).
 *
 *   node test/fixture-site.mjs [port]
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 4600);
const ORIGIN = `http://localhost:${PORT}`;

const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<meta name="description" content="${title} description">
<link rel="stylesheet" href="/_astro/main.abc123.css">
<link rel="icon" href="/favicon.svg">
</head>
<body><header><nav>
  <a href="/">Home</a><a href="/about">About</a><a href="/services">Services</a>
  <a href="/services/plumbing">Plumbing</a><a href="/contact">Contact</a>
  <a href="/brochure.pdf">Brochure</a><a href="https://example.com/external">Elsewhere</a>
</nav></header><main>${body}</main><footer><p>© Fixture Co</p></footer></body></html>`;

const PAGES = {
  '/':                  page('Fixture Co — Home',      '<h1>Welcome to Fixture Co</h1><p>We do the thing.</p><img src="/_astro/hero.png" alt="Hero">'),
  '/about':             page('About Fixture Co',       '<h1>About us</h1><p>Founded in a garage.</p>'),
  '/services':          page('Our Services',           '<h1>Services</h1><p>Everything you need.</p>'),
  '/services/plumbing': page('Plumbing — Fixture Co',  '<h1>Plumbing</h1><p>Pipes and such.</p>'),
  '/contact':           page('Contact Fixture Co',     '<h1>Contact</h1><p>Call us maybe.</p>'),
};

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Object.keys(PAGES).map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join('\n')}
  <url><loc>${ORIGIN}/brochure.pdf</loc></url>
</urlset>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, ORIGIN).pathname.replace(/(.)\/$/, '$1');

  if (path === '/sitemap.xml') return send(res, 200, SITEMAP, 'application/xml');
  // Assets, as a real build emits them: a stylesheet that itself references a
  // font and a background image, plus a favicon and an <img>.
  if (path === '/_astro/main.abc123.css') return send(res, 200,
    `@font-face{font-family:Fix;src:url('/_astro/fix.woff2') format('woff2')}\n` +
    `body{font-family:Fix;background:url("/_astro/bg.png") repeat;color:#123}\n` +
    `h1{color:rebeccapurple}\n`, 'text/css');
  if (path === '/_astro/fix.woff2')  return sendBin(res, 'FONTDATA', 'font/woff2');
  if (path === '/_astro/bg.png')     return sendBin(res, 'PNGDATA',  'image/png');
  if (path === '/_astro/hero.png')   return sendBin(res, 'HERODATA', 'image/png');
  if (path === '/favicon.svg')       return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
  if (path === '/brochure.pdf') return send(res, 200, '%PDF-1.4 not really', 'application/pdf');
  if (path === '/moved') { res.writeHead(302, { Location: '/about' }); return res.end(); }
  if (path === '/slow') return setTimeout(() => send(res, 200, page('Slow', '<h1>Slow</h1>')), 30000);
  if (PAGES[path]) return send(res, 200, PAGES[path]);
  send(res, 404, page('Not found', '<h1>404</h1>'));
});

function send(res, code, body, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}
function sendBin(res, body, type) {
  res.writeHead(200, { 'Content-Type': type });
  res.end(Buffer.from(body));
}

server.listen(PORT, () => console.log(`fixture site on ${ORIGIN}`));
