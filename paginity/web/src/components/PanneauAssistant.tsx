import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Box, Group, ScrollArea, Select, Stack, Text, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconMinus, IconPlus, IconRobot } from '@tabler/icons-react';
import { useLocation } from 'react-router-dom';
import { FilAssistant } from '../pages/Assistant';
import type { SiteResume } from '../types';
import { HAUTEUR_ENTETE } from './Logo';

/**
 * Panneau de l'assistant, toujours présent :
 *  - ordinateur : à droite, largeur réglable (bord gauche à tirer), boutons « + » / « − » dans l'angle ;
 *  - téléphone : en bas, hauteur réglable (bord du haut à tirer), mêmes boutons.
 * Réduit au minimum, il reste une fine barre : il ne disparaît jamais.
 * La taille et l'état (réduit ou non) sont retenus sur chaque appareil (mémoire du navigateur).
 */

const CLE = 'paginity-panneau-assistant';
const BARRE = 44;
const LARGEURS = [360, 520, 760];
const HAUTEURS_VH = [40, 70, 100];

interface Memoire {
  bureau: { largeur: number; reduit: boolean };
  mobile: { hauteurVh: number; reduit: boolean };
  site: string | null;
}
const DEFAUT: Memoire = { bureau: { largeur: 420, reduit: false }, mobile: { hauteurVh: 40, reduit: true }, site: null };

function lire(): Memoire {
  try {
    const m = JSON.parse(localStorage.getItem(CLE) ?? '{}');
    return { bureau: { ...DEFAUT.bureau, ...m.bureau }, mobile: { ...DEFAUT.mobile, ...m.mobile }, site: m.site ?? null };
  } catch {
    return DEFAUT;
  }
}
function ecrire(m: Memoire) {
  try {
    localStorage.setItem(CLE, JSON.stringify(m));
  } catch {
    /* navigation privée : la taille ne sera simplement pas retenue */
  }
}

/** Largeur occupée par le panneau sur ordinateur (pour réserver la place à droite du contenu). */
export function usePanneau() {
  const mobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [m, setM] = useState<Memoire>(lire);
  const maj = useCallback((f: (x: Memoire) => Memoire) => {
    setM((x) => {
      const n = f(x);
      ecrire(n);
      return n;
    });
  }, []);
  const largeurMax = useCallback(() => Math.max(320, Math.round(window.innerWidth * 0.7)), []);
  return { mobile, m, maj, largeurMax };
}

export function PanneauAssistant({ etat, siteRoute, sites }: { etat: ReturnType<typeof usePanneau>; siteRoute: string | null; sites: SiteResume[] }) {
  useLocation(); // se remettre à jour à chaque changement de page
  const { mobile, m, maj, largeurMax } = etat;
  const glisse = useRef<null | { depart: number; valeur: number }>(null);
  const siteId = siteRoute ?? (m.site && sites.some((s) => s.id === m.site) ? m.site : sites[0]?.id ?? null);
  const reduit = mobile ? m.mobile.reduit : m.bureau.reduit;

  // Tirer le bord (souris ou doigt) : la taille réglée à la main est retenue.
  useEffect(() => {
    const bouge = (x: number, y: number) => {
      const g = glisse.current;
      if (!g) return;
      if (mobile) {
        const vh = Math.min(100, Math.max(20, g.valeur + ((g.depart - y) / window.innerHeight) * 100));
        maj((a) => ({ ...a, mobile: { hauteurVh: Math.round(vh), reduit: false } }));
      } else {
        const l = Math.min(largeurMax(), Math.max(300, g.valeur + (g.depart - x)));
        maj((a) => ({ ...a, bureau: { largeur: Math.round(l), reduit: false } }));
      }
    };
    const souris = (e: MouseEvent) => bouge(e.clientX, e.clientY);
    const doigt = (e: TouchEvent) => bouge(e.touches[0].clientX, e.touches[0].clientY);
    const fin = () => {
      glisse.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', souris);
    window.addEventListener('touchmove', doigt, { passive: true });
    window.addEventListener('mouseup', fin);
    window.addEventListener('touchend', fin);
    return () => {
      window.removeEventListener('mousemove', souris);
      window.removeEventListener('touchmove', doigt);
      window.removeEventListener('mouseup', fin);
      window.removeEventListener('touchend', fin);
    };
  }, [mobile, maj, largeurMax]);
  const commencer = (x: number, y: number) => {
    glisse.current = { depart: mobile ? y : x, valeur: mobile ? m.mobile.hauteurVh : m.bureau.largeur };
    document.body.style.userSelect = 'none';
  };

  const agrandir = () =>
    maj((a) => {
      if (mobile) {
        if (a.mobile.reduit) return { ...a, mobile: { ...a.mobile, reduit: false } };
        const suivant = HAUTEURS_VH.find((h) => h > a.mobile.hauteurVh) ?? 100;
        return { ...a, mobile: { hauteurVh: suivant, reduit: false } };
      }
      if (a.bureau.reduit) return { ...a, bureau: { ...a.bureau, reduit: false } };
      const suivant = [...LARGEURS, largeurMax()].find((l) => l > a.bureau.largeur) ?? largeurMax();
      return { ...a, bureau: { largeur: suivant, reduit: false } };
    });
  const reduire = () => maj((a) => (mobile ? { ...a, mobile: { ...a.mobile, reduit: true } } : { ...a, bureau: { ...a.bureau, reduit: true } }));

  const boutons = (
    <Group gap={4} wrap="nowrap">
      <Tooltip label="Réduire complètement">
        <ActionIcon variant="subtle" size="sm" onClick={reduire} disabled={reduit} aria-label="Réduire le panneau de l’assistant">
          <IconMinus size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Agrandir">
        <ActionIcon variant="subtle" size="sm" onClick={agrandir} aria-label="Agrandir le panneau de l’assistant">
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );

  const surPageAssistant = !!siteRoute && /\/assistant\/?$/.test(window.location.pathname);
  const contenu = surPageAssistant ? (
    <Text size="sm" c="dimmed">
      L’assistant est affiché en grand sur cette page.
    </Text>
  ) : siteId ? (
    <Stack gap="sm">
      {!siteRoute && sites.length > 1 && (
        <Select
          size="xs"
          label="Site"
          data={sites.map((s) => ({ value: s.id, label: s.nom }))}
          value={siteId}
          allowDeselect={false}
          onChange={(v) => v && maj((a) => ({ ...a, site: v }))}
        />
      )}
      <FilAssistant siteId={siteId} compact />
    </Stack>
  ) : (
    <Text size="sm" c="dimmed">
      Aucun site pour l’instant.
    </Text>
  );

  const fond = { background: 'var(--mantine-color-body)', borderColor: 'var(--mantine-color-default-border)' };

  if (mobile) {
    const hauteur = reduit ? `${BARRE}px` : `calc(${m.mobile.hauteurVh}dvh - ${m.mobile.hauteurVh === 100 ? HAUTEUR_ENTETE : 0}px)`;
    return (
      <Box
        component="aside"
        aria-label="Assistant"
        data-panneau-assistant={reduit ? 'reduit' : 'ouvert'}
        style={{ ...fond, position: 'fixed', left: 0, right: 0, bottom: 0, height: hauteur, zIndex: 150, borderTop: '1px solid', display: 'flex', flexDirection: 'column' }}
      >
        <Box
          onTouchStart={(e) => commencer(e.touches[0].clientX, e.touches[0].clientY)}
          onMouseDown={(e) => commencer(e.clientX, e.clientY)}
          style={{ cursor: 'ns-resize', touchAction: 'none', padding: '4px 0 0' }}
          aria-hidden
        >
          <Box mx="auto" w={40} h={4} style={{ borderRadius: 4, background: 'var(--mantine-color-dimmed)' }} />
        </Box>
        <Group justify="space-between" px="sm" h={BARRE - 8} wrap="nowrap" onClick={reduit ? agrandir : undefined} style={{ cursor: reduit ? 'pointer' : undefined }}>
          <Group gap={6} wrap="nowrap">
            <IconRobot size={18} color="var(--mantine-color-or-5)" />
            <Text fw={600} size="sm">
              Assistant
            </Text>
          </Group>
          <Box onClick={(e) => e.stopPropagation()}>{boutons}</Box>
        </Group>
        {!reduit && (
          <ScrollArea style={{ flex: 1 }} px="sm" pb="sm">
            {contenu}
          </ScrollArea>
        )}
      </Box>
    );
  }

  const largeur = reduit ? BARRE : m.bureau.largeur;
  return (
    <Box
      component="aside"
      aria-label="Assistant"
      data-panneau-assistant={reduit ? 'reduit' : 'ouvert'}
      style={{ ...fond, position: 'fixed', top: HAUTEUR_ENTETE, right: 0, bottom: 0, width: largeur, zIndex: 150, borderLeft: '1px solid', display: 'flex', flexDirection: 'column' }}
    >
      {!reduit && (
        <Box
          onMouseDown={(e) => commencer(e.clientX, e.clientY)}
          title="Tirer pour changer la largeur"
          style={{ position: 'absolute', left: -4, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', zIndex: 1 }}
        />
      )}
      {reduit ? (
        <Stack align="center" gap="xs" pt="xs" style={{ cursor: 'pointer', height: '100%' }} onClick={agrandir} aria-label="Ouvrir l’assistant">
          <Tooltip label="Agrandir" position="left">
            <ActionIcon variant="subtle" size="sm" aria-label="Agrandir le panneau de l’assistant">
              <IconPlus size={16} />
            </ActionIcon>
          </Tooltip>
          <IconRobot size={20} color="var(--mantine-color-or-5)" />
          <Text size="sm" fw={600} style={{ writingMode: 'vertical-rl' }}>
            Assistant
          </Text>
        </Stack>
      ) : (
        <>
          <Group justify="space-between" px="sm" py={8} wrap="nowrap" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
            <Group gap={6} wrap="nowrap">
              <IconRobot size={18} color="var(--mantine-color-or-5)" />
              <Text fw={600}>Assistant</Text>
            </Group>
            {boutons}
          </Group>
          <ScrollArea style={{ flex: 1 }} p="sm">
            {contenu}
          </ScrollArea>
        </>
      )}
    </Box>
  );
}
