import { useId } from 'react';
import { Box } from '@mantine/core';

/**
 * Logo PAGINITY : bouclier argenté et « P » qui tournent sur eux-mêmes en sens opposés, et le nom (« PAGIN » argent, « ITY » or).
 * Dessiné en SVG + texte (net à toutes les tailles, posé directement sur le fond de la page, sans cadre).
 * Rotation continue ; tout reste immobile si l'appareil demande de réduire les animations.
 */
export function Logo({ taille = 34, texte = true, tailleTexte }: { taille?: number; texte?: boolean; tailleTexte?: number }) {
  const id = `pg-argent-${useId().replace(/:/g, '')}`;
  const h = taille;
  const w = Math.round(taille * 0.86);
  return (
    <Box className="pg-logo" style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(taille * 0.32) }} aria-hidden>
      <span className="pg-logo-bouclier" style={{ width: w, height: h }}>
        <svg viewBox="0 0 86 100" width={w} height={h} aria-hidden focusable="false">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--pg-argent-1)" />
              <stop offset="0.45" stopColor="var(--pg-argent-2)" />
              <stop offset="1" stopColor="var(--pg-argent-3)" />
            </linearGradient>
          </defs>
          {/* Contour épais du bouclier, puis filet intérieur. */}
          <path d="M43 4 C30 12 18 15 6 15 L6 50 C6 74 22 88 43 96 C64 88 80 74 80 50 L80 15 C68 15 56 12 43 4 Z" fill="none" stroke={`url(#${id})`} strokeWidth="7" strokeLinejoin="round" />
          <path d="M43 14 C33 20 24 22 15 23 L15 50 C15 68 27 79 43 86" fill="none" stroke={`url(#${id})`} strokeWidth="2" strokeLinecap="round" opacity="0.55" />
        </svg>
        <span className="pg-logo-p" style={{ fontSize: Math.round(taille * 0.5) }}>
          P
        </span>
      </span>
      {texte && (
        <span className="pg-logo-nom" style={{ fontSize: tailleTexte ?? Math.round(taille * 0.66) }}>
          <span className="pg-logo-argent">PAGIN</span>
          <span className="pg-logo-or">ITY</span>
        </span>
      )}
    </Box>
  );
}
