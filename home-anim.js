/* Home page: the substituents on the Structure Search card hop between ring carbons. */
(() => {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const svg = document.querySelector('.hc[data-home-go="structure"] .art');
  if (!svg) return;
  const subs = [...svg.querySelectorAll('.sub')];
  if (subs.length < 2) return;
  // Ring carbons that can carry a substituent (the two fusion carbons are left out): x, y, ring centre.
  const c1 = [110, 64], c2 = [162, 64];
  const verts = [[110, 34, c1], [84, 49, c1], [84, 79, c1], [110, 94, c1], [162, 34, c2], [188, 49, c2], [188, 79, c2], [162, 94, c2]]
    .map(([x, y, c]) => ({ x, y, a: Math.round(Math.atan2(y - c[1], x - c[0]) * 180 / Math.PI) }));
  const place = (g, v) => g.setAttribute('transform', `translate(${v.x} ${v.y}) rotate(${v.a})`);
  const at = [0, 6];
  const hop = i => {
    if (!svg.getClientRects().length || document.hidden) return;
    const g = subs[i];
    g.classList.add('hop');
    setTimeout(() => {
      const free = verts.map((v, k) => k).filter(k => k !== at[i] && k !== at[1 - i]);
      at[i] = free[Math.floor(Math.random() * free.length)];
      place(g, verts[at[i]]);
      g.classList.remove('hop');
    }, 380);
  };
  subs.forEach((g, i) => place(g, verts[at[i]]));
  setInterval(() => hop(0), 2600);
  setTimeout(() => setInterval(() => hop(1), 2600), 1300);
})();
