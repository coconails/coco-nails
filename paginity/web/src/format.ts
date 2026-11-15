export function dateHeure(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ilYa(ms: number | null | undefined): string {
  if (!ms) return 'jamais';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return `il y a ${d} jour${d > 1 ? 's' : ''}`;
}

export function taille(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(0)} Ko`;
  if (octets < 1024 ** 3) return `${(octets / 1024 / 1024).toFixed(1)} Mo`;
  return `${(octets / 1024 ** 3).toFixed(1)} Go`;
}

export function duree(secondes: number): string {
  const j = Math.floor(secondes / 86400);
  const h = Math.floor((secondes % 86400) / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  if (j) return `${j} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
