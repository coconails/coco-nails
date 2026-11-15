import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { SiteRow } from '../sites/service.js';
import type { SiteManifest } from '../sites/manifest.js';
import { installDependencies } from '../functions/isolation.js';
import { APP_DIR } from '../functions/service.js';
import { assertNoSymlinks, buildOutput } from './build.js';

export interface FabricationResult {
  fichiers: number;
  fonctions: boolean;
  dependances: 'aucune' | 'cache' | 'installees';
  preparation: boolean;
}

/**
 * Fabrication d'une version à partir d'une copie figée du dépôt (srcDir) :
 * 1. dépendances (« npm ci » sans scripts, avec cache) ;
 * 2. étape de préparation du site (« node script.mjs »), dans l'isolation (conteneur ou processus restreint) ;
 * 3. copie du dossier publié ;
 * 4. si le site a des fonctions : la copie de travail devient le code de l'exécuteur (dossier caché « .app », jamais servi).
 */
export async function fabricate(ctx: Ctx, site: SiteRow, srcDir: string, outDir: string, version: string, manifest: SiteManifest, env: 'production' | 'test'): Promise<FabricationResult> {
  // Vérification répétée ici pour tous les cas (publication, aperçu, refabrication d'une ancienne version).
  assertNoSymlinks(srcDir);
  const log = (l: string) => ctx.functions.log(`${site.id}:${env}`, `[préparation] ${l}`);
  const hasFunctions = !!manifest.functionsDir && fs.existsSync(path.join(srcDir, manifest.functionsDir));
  let dependances: FabricationResult['dependances'] = 'aucune';
  if (manifest.build || hasFunctions) {
    dependances = await installDependencies(srcDir, path.join(ctx.config.dataDir, 'cache', 'dependances'), log);
  }
  if (manifest.build) {
    log(`lancement : ${manifest.build}`);
    await ctx.functions.isolation.runBuild(srcDir, manifest.build, log);
    log('terminée');
  }
  const fichiers = buildOutput(srcDir, manifest, outDir, version, { functionsDir: hasFunctions ? manifest.functionsDir : null });
  if (hasFunctions) {
    fs.rmSync(path.join(srcDir, '.git'), { recursive: true, force: true });
    fs.renameSync(srcDir, path.join(outDir, APP_DIR));
    fs.mkdirSync(srcDir, { recursive: true }); // l'appelant supprime srcDir à la fin
  }
  return { fichiers, fonctions: hasFunctions, dependances, preparation: !!manifest.build };
}
