/* Chapter tracking for the manual. Nothing more; the manual is HTML. */
const links = [...document.querySelectorAll('.docs__index a')];
const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const a of links) a.classList.remove('on');
    map.get(e.target.id)?.classList.add('on');
  }
}, { rootMargin: '-10% 0px -70% 0px' });

document.querySelectorAll('.docs__body section').forEach((s) => io.observe(s));
