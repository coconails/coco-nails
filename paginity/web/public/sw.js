// PAGINITY — notifications sur cet appareil (Web Push). Ce fichier ne met rien en cache : il affiche seulement
// les notifications envoyées par votre serveur PAGINITY (chiffrées de bout en bout jusqu'à cet appareil).
self.addEventListener('push', (e) => {
  let d = { titre: 'PAGINITY', texte: '', url: '/' };
  try {
    d = { ...d, ...e.data.json() };
  } catch {
    /* message illisible : notification générique */
  }
  e.waitUntil(self.registration.showNotification(d.titre, { body: d.texte, icon: '/icone-192.png', badge: '/favicon.png', data: { url: d.url } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((liste) => {
      for (const c of liste) if (c.url.startsWith(self.location.origin)) return c.focus().then(() => c.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
