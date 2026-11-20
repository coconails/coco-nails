import { useId, type CSSProperties } from 'react';

/** Hauteur de la barre du haut de l'administration (le logo centré y tient entièrement). */
export const HAUTEUR_ENTETE = 76;

const LETTRES = ['P', 'A', 'G', 'I', 'N', 'I', 'T', 'Y'];
const OR_DES = 3; // « PAG » clair, « INITY » or

/** Bouclier bleu nuit à bordure or et « P » blanc ; le bouclier tourne vers la gauche (20 s), le « P » vers la droite (24 s). */
export function Bouclier({ taille }: { taille: number }) {
  const id = `pg-or-${useId().replace(/:/g, '')}`;
  const w = Math.round(taille * 0.86);
  return (
    <span className="pg-bouclier" style={{ width: w, height: taille }} aria-hidden>
      <svg viewBox="0 0 86 100" width={w} height={taille} aria-hidden focusable="false">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--pg-or-1)" />
            <stop offset="1" stopColor="var(--pg-or-2)" />
          </linearGradient>
        </defs>
        <path d="M43 5 C30 13 18 16 7 16 L7 50 C7 73 22 87 43 95 C64 87 79 73 79 50 L79 16 C68 16 56 13 43 5 Z" fill="var(--pg-nuit)" stroke={`url(#${id})`} strokeWidth="6" strokeLinejoin="round" />
      </svg>
      {/* Deux faces : le « P » se lit à l'endroit même quand on le voit de dos. */}
      <span className="pg-bouclier-p" style={{ fontSize: Math.round(taille * 0.56) }}>
        <span className="pg-face">P</span>
        <span className="pg-face pg-dos">P</span>
      </span>
    </span>
  );
}

const lettre = (l: string, i: number) => (
  <span key={i} className={i < OR_DES ? 'pg-lettre' : 'pg-lettre pg-lettre-or'}>
    {l}
  </span>
);

/**
 * Logo de la barre du haut : « P A G [bouclier] I N I T Y », lettres immobiles.
 * Sans texte (téléphone) : le bouclier seul.
 */
export function Logo({ taille = 52, texte = true, tailleTexte }: { taille?: number; texte?: boolean; tailleTexte?: number }) {
  const fs = tailleTexte ?? Math.round(taille * 0.46);
  return (
    <span className="pg-logo" style={{ fontSize: fs }} aria-hidden>
      {texte && LETTRES.slice(0, OR_DES).map(lettre)}
      <Bouclier taille={taille} />
      {texte && LETTRES.slice(OR_DES).map((l, i) => lettre(l, i + OR_DES))}
    </span>
  );
}

/**
 * Pages d'accès : les 8 lettres tournent autour du bouclier sur une orbite en ellipse (45 s par tour), comme l'anneau de Saturne.
 * Devant le bouclier elles sont nettes, derrière elles passent dessous et s'estompent.
 * Si l'appareil demande de réduire les animations, le logo en ligne immobile est affiché à la place.
 */
export function LogoSaturne({ taille = 76 }: { taille?: number }) {
  const rx = 140;
  const ry = Math.round(taille * 0.36);
  const marge = 22;
  const W = 2 * rx + 2 * marge;
  const H = taille + 2 * marge;
  const cx = W / 2;
  const cy = H / 2 + Math.round(taille * 0.06);
  // Départ à droite, puis passage devant (en bas), à gauche, derrière (en haut).
  const chemin = `path('M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy}')`;
  return (
    <>
      <span className="pg-saturne" style={{ width: W, height: H }} aria-hidden>
        <span className="pg-saturne-centre">
          <Bouclier taille={taille} />
        </span>
        {LETTRES.map((l, i) => {
          // Mot groupé sur une demi-orbite, centré devant le bouclier (25 % du tour), lu de gauche à droite.
          const position = (((0.25 + (3.5 - i) / 16) % 1) + 1) % 1;
          const style: CSSProperties = { offsetPath: chemin, animationDelay: `${-(position * 45).toFixed(2)}s` };
          return (
            <span key={i} className={i < OR_DES ? 'pg-orbite' : 'pg-orbite pg-lettre-or'} style={style}>
              {l}
            </span>
          );
        })}
      </span>
      <span className="pg-saturne-immobile">
        <Logo taille={64} />
      </span>
    </>
  );
}
