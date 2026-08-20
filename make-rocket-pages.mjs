/**
 * make-rocket-pages.mjs — one-off: turn the single-page rocket site into a
 * 3-page site (Home · About · Pricing) reusing its exact <head> styles, header
 * and footer, so the new pages look native. Each page is then autotagged so
 * every visible thing (incl. nav labels + meta tags) is editable.
 */
import { load } from 'cheerio';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { autotag } from './lib/autotag.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const dir = join(ROOT, 'sites', 'rocket');
const homeTpl = readFileSync(join(dir, 'pages', 'home', 'template.html'), 'utf8');

const NAV = `
  <a href="/live/rocket" class="text-[14px] font-medium text-ink-soft hover:text-brand-primary transition-colors">Home</a>
  <a href="/live/rocket/about" class="text-[14px] font-medium text-ink-soft hover:text-brand-primary transition-colors">About</a>
  <a href="/live/rocket/pricing" class="text-[14px] font-medium text-ink-soft hover:text-brand-primary transition-colors">Pricing</a>`;

/** clean clone of the home doc: strip CMS tags, swap nav, optional title/main */
function buildPage({ title, mainHtml }) {
  const $ = load(homeTpl, { decodeEntities: false });
  $('[data-cms],[data-cms-img],[data-cms-item],[data-cms-collection]').each((_, el) => {
    for (const a of ['data-cms', 'data-cms-img', 'data-cms-item', 'data-cms-collection']) $(el).removeAttr(a);
  });
  if (title) $('head > title').text(title);
  $('header nav').first().html(NAV);
  if (mainHtml) $('main').html(mainHtml);
  return $.html();
}

const section = (id, inner) => `<section class="relative px-4 sm:px-6 md:px-12 py-[80px] md:py-[100px] border-b border-hairline" id="${id}">${inner}</section>`;
const h2 = (t) => `<h2 class="text-[36px] sm:text-[48px] md:text-[52px] font-bold leading-[1.08] tracking-tight text-ink" style="color:rgb(30,28,26)">${t}</h2>`;
const lead = (t) => `<p class="text-[15px] md:text-[16px] leading-[1.5] max-w-[60ch]" style="color:rgb(56,52,47)">${t}</p>`;
const eyebrow = (t) => `<span class="text-xs font-mono uppercase tracking-widest text-brand-primary">${t}</span>`;
const card = (n, tag, title, body) => `
  <div class="flex flex-col bg-[#141211] border border-white/5 rounded-[16px] p-8 shadow-2xl min-h-[300px]">
    <div class="flex items-center justify-between mb-8"><span class="text-xs font-mono font-bold text-white/40">${n}</span><span class="text-xs font-mono font-bold uppercase tracking-wider text-[#38bdf8]">${tag}</span></div>
    <h3 class="text-[22px] font-bold tracking-tight text-white mb-3">${title}</h3>
    <p class="text-[13.5px] leading-[1.55] text-[#a19d97]">${body}</p>
  </div>`;
const tier = (name, price, term, feats) => `
  <div class="flex flex-col bg-[#141211] border border-white/5 rounded-[16px] p-8 shadow-2xl">
    <h3 class="text-[20px] font-bold tracking-tight text-white mb-2">${name}</h3>
    <div class="flex items-baseline gap-1 mb-5"><span class="text-[40px] font-bold tracking-tight text-white">${price}</span><span class="text-[13px] text-[#a19d97]">${term}</span></div>
    <ul class="space-y-2 text-[13.5px] text-[#d4cfc7]">${feats.map((f) => `<li>— ${f}</li>`).join('')}</ul>
  </div>`;

const aboutMain = `
  ${section('hero', `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
      <div class="lg:col-span-8 space-y-6">
        ${eyebrow('// About Rocket')}
        ${h2('We engineer websites,<br>not just decorate them.')}
        ${lead('Rocket is a small senior studio. We design with mathematical grids, build on lightweight modern code, and ship sites that load fast and convert — then hand you a CMS so you run it yourself.')}
      </div>
    </div>`)}
  ${section('values', `
    <div class="mb-12 max-w-[700px]">${eyebrow('// How we work')}<div class="mt-3">${h2('Three principles.')}</div></div>
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      ${card('01', 'Clarity', 'Structure before style.', 'Every page starts as a clean grid and a clear message. Decoration comes last, and only if it earns its place.')}
      ${card('02', 'Speed', 'Zero bloat shipped.', 'No heavy page-builders, no tracking sludge. Just fast, accessible, hand-tuned pages your visitors actually wait for.')}
      ${card('03', 'Ownership', 'You hold the keys.', 'We hand over a CMS you can run without us — edit any text or image, add pages, and publish in seconds.')}
    </div>`)}`;

const pricingMain = `
  ${section('hero', `
    <div class="max-w-[700px] space-y-6">
      ${eyebrow('// Pricing')}
      ${h2('Simple, honest pricing.')}
      ${lead('One build fee to launch, one small monthly to keep it hosted, safe, and self-editable. No surprises, cancel anytime.')}
    </div>`)}
  ${section('tiers', `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      ${tier('Launch', '£2,400', 'one-time', ['Up to 5 pages', 'Mobile-perfect build', 'Basic SEO setup', '2 weeks support'])}
      ${tier('Studio', '£4,800', 'one-time', ['Up to 12 pages', 'Custom design system', 'Self-edit CMS included', 'Analytics + SEO', '30 days support'])}
      ${tier('Care plan', '£149', '/ month', ['Hosting + backups', 'Self-serve CMS editor', 'Version history', 'Priority support'])}
    </div>`)}`;

function writePage(slug, html, title) {
  const { templateHtml, content, schema, sections, collections } = autotag(html);
  const pd = join(dir, 'pages', slug);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, 'template.html'), templateHtml);
  writeFileSync(join(pd, 'content.json'), JSON.stringify(content, null, 2));
  writeFileSync(join(pd, 'schema.json'), JSON.stringify(schema, null, 2));
  writeFileSync(join(pd, 'meta.json'), JSON.stringify({ sections, collections }, null, 2));
  console.log(`  ${slug}: ${Object.keys(schema).length} fields, ${collections.length} collections`);
}

// Home (re-tagged with new nav), About, Pricing
writePage('home', buildPage({}), 'Home');
writePage('about', buildPage({ title: 'About · Rocket', mainHtml: aboutMain }), 'About');
writePage('pricing', buildPage({ title: 'Pricing · Rocket', mainHtml: pricingMain }), 'Pricing');

writeFileSync(join(dir, 'site.json'), JSON.stringify({
  order: ['home', 'about', 'pricing'],
  home: 'home',
  pages: { home: { title: 'Home', path: '/' }, about: { title: 'About', path: '/about' }, pricing: { title: 'Pricing', path: '/pricing' } },
}, null, 2));

// fresh timeline so v0 includes all 3 pages
rmSync(join(dir, 'versions'), { recursive: true, force: true });
rmSync(join(dir, 'releases'), { recursive: true, force: true });
rmSync(join(dir, 'head.json'), { force: true });
console.log('✓ rocket is now a 3-page site (home · about · pricing)');
