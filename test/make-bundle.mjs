/**
 * make-bundle.mjs — writes a zip shaped like a real `astro build` dist/ folder,
 * including the two things that broke when a site was rebuilt from fetched HTML:
 * a mobile menu that ships OPEN and is closed by JavaScript, and responsive
 * images that carry srcset/<picture> rather than a plain src.
 *
 *   node test/make-bundle.mjs /tmp/dist.zip
 */
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || '/tmp/dist.zip';

const shell = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/_astro/main.BX3kd2Aa.css">
<link rel="icon" href="/favicon.svg">
</head><body>
<header>
  <a href="/"><img src="/_astro/logo.CxY9_1z-.svg" alt="Gutter Guys" width="180" height="40"></a>
  <button id="nav-toggle" aria-expanded="true">Open menu</button>
  <nav id="mobile-nav" class="open">
    <a href="/services">Services</a><a href="/pricing">Pricing</a><a href="/faq">FAQ</a>
  </nav>
</header>
<main>${body}</main>
<footer><p>© Gutter Guys</p></footer>
<script src="/_astro/nav.js"></script>
</body></html>`;

const files = {
  // Astro's usual shape: the home page at the root, others as dir/index.html
  'dist/index.html': strToU8(shell('Gutter Guys — Home', `
    <h1>Gutter Cleaning That's One Less Thing To Worry About</h1>
    <p>We're the Gutter Guys, your friendly local crew.</p>
    <picture>
      <source srcset="/_astro/hero.a1.avif 1x, /_astro/hero@2x.a1.avif 2x" type="image/avif">
      <img src="/_astro/hero.a1.webp" srcset="/_astro/hero.a1.webp 800w" sizes="100vw" alt="A two story suburban home">
    </picture>`)),
  'dist/services/index.html': strToU8(shell('Services — Gutter Guys', '<h1>Services</h1><p>Gutter cleaning and guards.</p>')),
  'dist/pricing/index.html':  strToU8(shell('Pricing — Gutter Guys',  '<h1>Pricing</h1><p>Simple annual membership.</p>')),
  'dist/faq/index.html':      strToU8(shell('FAQ — Gutter Guys',      '<h1>FAQ</h1><p>Common questions.</p>')),

  // The behaviour that a fetched snapshot loses: this is what closes the menu.
  'dist/_astro/nav.js': strToU8(
    `document.getElementById('mobile-nav').classList.remove('open');\n` +
    `document.getElementById('nav-toggle').setAttribute('aria-expanded','false');\n`),

  'dist/_astro/main.BX3kd2Aa.css': strToU8(
    `@font-face{font-family:Brand;src:url('/_astro/brand.woff2') format('woff2')}\n` +
    `body{font-family:Brand;color:#123;background:url("/_astro/paper.png")}\n` +
    `h1{color:rebeccapurple}\n` +
    `#mobile-nav{display:none}#mobile-nav.open{display:block}\n`),

  'dist/_astro/brand.woff2':     strToU8('FONTDATA'),
  'dist/_astro/paper.png':       strToU8('PAPERPNG'),
  'dist/_astro/logo.CxY9_1z-.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40"></svg>'),
  'dist/_astro/hero.a1.webp':    strToU8('HEROWEBP'),
  'dist/_astro/hero@2x.a1.avif': strToU8('HERO2XAVIF'),
  'dist/_astro/hero.a1.avif':    strToU8('HEROAVIF'),
  'dist/favicon.svg':            strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  'dist/robots.txt':             strToU8('User-agent: *\nAllow: /\n'),
  // Noise a real zip carries and we should ignore.
  'dist/.DS_Store':              strToU8('junk'),
};

writeFileSync(out, Buffer.from(zipSync(files)));
console.log(`wrote ${out} (${Object.keys(files).length} entries)`);
