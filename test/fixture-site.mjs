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
<meta name="description" content="${title} description"></head>
<body><header><nav>
  <a href="/">Home</a><a href="/about">About</a><a href="/services">Services</a>
  <a href="/services/plumbing">Plumbing</a><a href="/contact">Contact</a>
  <a href="/brochure.pdf">Brochure</a><a href="https://example.com/external">Elsewhere</a>
</nav></header><main>${body}</main><footer><p>© Fixture Co</p></footer></body></html>`;

const PAGES = {
  '/':                  page('Fixture Co — Home',      '<h1>Welcome to Fixture Co</h1><p>We do the thing.</p><img src="/hero.png" alt="Hero">'),
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

server.listen(PORT, () => console.log(`fixture site on ${ORIGIN}`));
