import { createPaginity, listen } from './main.js';
import { siteTestOrigin } from './config.js';

/** Point d'entrée : démarre l'administration, le serveur des sites et le serveur des aperçus. */
const p = await createPaginity();
await listen(p);
const c = p.ctx.config;
console.log('');
console.log('  PAGINITY — Créer · Gérer · Publier · Suivre');
console.log(`  Administration : ${c.publicUrl}`);
console.log(`  Sites          : ${siteTestOrigin(c, '<site>')} (port ${c.sitesPort})`);
console.log(`  Aperçus        : port ${c.previewPort}`);
console.log(`  Données        : ${c.dataDir}`);
if (p.setupCode) {
  console.log('');
  console.log(`  Première installation — code à saisir dans le navigateur : ${p.setupCode}`);
}
console.log('');

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`Arrêt demandé (${signal})…`);
  await p.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
