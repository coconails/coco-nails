import { Badge, Box, Group, Loader, Stack, Text, ThemeIcon, Timeline } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconCircleDashed, IconPlayerSkipForward, IconX } from '@tabler/icons-react';
import type { Activite, EtatSite } from '../types';
import { dateHeure } from '../format';

const ETATS: Record<EtatSite, { couleur: string; libelle: string }> = {
  en_ligne: { couleur: 'green', libelle: 'En ligne' },
  modifications: { couleur: 'or', libelle: 'Modifications non publiées' },
  erreur: { couleur: 'red', libelle: 'Dernière publication échouée' },
  jamais_publie: { couleur: 'gray', libelle: 'Jamais publié' },
};

export function StatusDot({ etat }: { etat: EtatSite }) {
  const e = ETATS[etat];
  return <Box component="span" w={10} h={10} style={{ borderRadius: 99, background: `var(--mantine-color-${e.couleur}-6)`, display: 'inline-block' }} aria-label={e.libelle} title={e.libelle} />;
}

export function StatusBadge({ etat }: { etat: EtatSite }) {
  const e = ETATS[etat];
  return (
    <Badge color={e.couleur} variant="light" leftSection={<StatusDot etat={etat} />}>
      {e.libelle}
    </Badge>
  );
}

const JOB: Record<Activite['etat'], { couleur: string; libelle: string }> = {
  en_attente: { couleur: 'gray', libelle: 'En attente' },
  en_cours: { couleur: 'blue', libelle: 'En cours' },
  reussie: { couleur: 'green', libelle: 'Réussie' },
  echouee: { couleur: 'red', libelle: 'Échouée' },
  interrompue: { couleur: 'orange', libelle: 'Interrompue' },
};

export function JobBadge({ etat }: { etat: Activite['etat'] }) {
  return <Badge color={JOB[etat].couleur} variant="light">{JOB[etat].libelle}</Badge>;
}

/** Progression étape par étape d'une activité (publication, import…), mise à jour en direct. */
export function JobSteps({ job }: { job: Activite }) {
  const active = job.etapes.findIndex((s) => s.etat === 'en_cours');
  const last = job.etapes.reduce((acc, s, i) => (s.etat !== 'a_faire' ? i : acc), -1);
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text fw={600}>{job.libelle}</Text>
        <JobBadge etat={job.etat} />
      </Group>
      <Timeline active={active >= 0 ? active : last} bulletSize={26} lineWidth={2}>
        {job.etapes.map((s) => (
          <Timeline.Item
            key={s.nom}
            title={s.nom}
            bullet={
              s.etat === 'reussi' ? (
                <ThemeIcon color="green" radius="xl" size={26}><IconCheck size={15} /></ThemeIcon>
              ) : s.etat === 'echoue' ? (
                <ThemeIcon color="red" radius="xl" size={26}><IconX size={15} /></ThemeIcon>
              ) : s.etat === 'en_cours' ? (
                <Loader size={18} />
              ) : s.etat === 'ignore' ? (
                <ThemeIcon color="gray" variant="light" radius="xl" size={26}><IconPlayerSkipForward size={14} /></ThemeIcon>
              ) : (
                <ThemeIcon color="gray" variant="light" radius="xl" size={26}><IconCircleDashed size={14} /></ThemeIcon>
              )
            }
          >
            {s.message && (
              <Text size="sm" c={s.etat === 'echoue' ? 'red' : 'dimmed'}>
                {s.message}
              </Text>
            )}
          </Timeline.Item>
        ))}
      </Timeline>
      {job.erreur && (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconAlertTriangle size={18} color="var(--mantine-color-red-6)" />
          <Text size="sm" c="red">{job.erreur}</Text>
        </Group>
      )}
      <Text size="xs" c="dimmed">
        Lancée {dateHeure(job.creeLe)}{job.utilisateur ? ` par ${job.utilisateur}` : ''}. Vous pouvez fermer cette page : l’opération continue sur le serveur.
      </Text>
    </Stack>
  );
}
