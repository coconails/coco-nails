// Affiche les contenus JSON (modifiables dans PAGINITY, mode « Contenus »).
(function () {
  function charger(nom) {
    return fetch('/contenu/' + nom + '.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function el(tag, cls, texte) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }
  document.getElementById('annee').textContent = new Date().getFullYear();
  Promise.all([charger('site'), charger('prestations'), charger('horaires'), charger('faq')]).then(function (d) {
    var site = d[0] || {}, prest = d[1] || {}, hor = d[2] || {}, faq = d[3] || {};
    document.querySelectorAll('[data-champ]').forEach(function (n) {
      var v = site[n.getAttribute('data-champ')];
      if (typeof v === 'string' && v) n.textContent = v;
    });
    if (site.nom) document.title = site.nom;
    var img = document.querySelector('[data-champ-image]');
    if (site.image) { img.src = site.image; img.alt = site.nom || ''; img.hidden = false; }
    var tel = document.getElementById('tel');
    if (site.telephone) { tel.textContent = '📞 ' + site.telephone; tel.href = 'tel:' + site.telephone.replace(/[^0-9+]/g, ''); }
    var mail = document.getElementById('mail');
    if (site.email) { mail.textContent = '✉️ ' + site.email; mail.href = 'mailto:' + site.email; }
    var ul = document.getElementById('prestations');
    (prest.prestations || []).forEach(function (p) {
      var li = el('li', 'carte');
      var tete = el('div', 'carte__tete');
      tete.appendChild(el('h3', '', p.nom || ''));
      if (p.prix) tete.appendChild(el('span', 'prix', p.prix));
      li.appendChild(tete);
      if (p.duree) li.appendChild(el('p', 'duree', p.duree + ' min'));
      if (p.description) li.appendChild(el('p', '', p.description));
      ul.appendChild(li);
    });
    var tb = document.getElementById('horaires');
    (hor.jours || []).forEach(function (j) {
      var tr = el('tr');
      tr.appendChild(el('th', '', j.jour));
      tr.appendChild(el('td', j.ouvert ? '' : 'ferme', j.ouvert ? (j.heures || 'Ouvert') : 'Fermé'));
      tb.appendChild(tr);
    });
    if (hor.fermeture) { var f = document.getElementById('fermeture'); f.textContent = hor.fermeture; f.hidden = false; }
    var zone = document.getElementById('faq');
    (faq.questions || []).forEach(function (q) {
      var det = el('details', 'question');
      det.appendChild(el('summary', '', q.question));
      det.appendChild(el('p', '', q.reponse));
      zone.appendChild(det);
    });
  });
})();
