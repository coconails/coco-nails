import { useEffect, useRef, useState } from 'react';
import { Accordion, Badge, Button, Card, Group, Progress, Stack, Switch, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconFlask, IconX } from '@tabler/icons-react';
import { del, errorMessage, get, post } from '../api';

interface Detail {
  tache: string;
  titre: string;
  domaine: 'textes' | 'donnees';
  reussi: boolean;
  raison: string;
  ms: number;
  centimes: number;
}
interface Resultat {
  le: number;
  libelle: string;
  notes: { textes: number | null; donnees: number | null };
  complet: boolean;
  reussies: number;
  total: number;
  msMoyen: number;
  centimes: number;
  details: Detail[];
}
interface EtatBanc {
  enCours: null | { total: number; fait: number; actuel: string; arret: boolean };
  dernier: null | { le: number; resultats: Record<string, Resultat> };
  taches: { id: string; titre: string; domaine: string; demande: string; reelle?: boolean }[];
  reelles: number;
  libelles: Record<string, string>;
}

const secondes = (ms: number) => `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
const note = (n: number | null) => (n === null ? '—' : <Badge color={n >= 80 ? 'green' : n >= 50 ? 'yellow' : 'red'} variant="light">{n}</Badge>);

/**
 * Banc d'essai : les mêmes demandes types posées à chaque IA, sur un salon fictif (aucun site touché).
 * Les résultats donnent les notes par domaine utilisées par la salle de réunion.
 */
export function BancEssai() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['banc-ia'],
    queryFn: () => get<EtatBanc>('/api/reglages/ia/banc'),
    refetchInterval: (x) => (x.state.data?.enCours ? 1000 : false),
  });
  const [payants, setPayants] = useState(false);
  const [busy, setBusy] = useState(false);
  const etaitEnCours = useRef(false);
  const enCours = q.data?.enCours ?? null;
  useEffect(() => {
    // Fin d'un essai : les notes de la salle de réunion ont changé.
    if (etaitEnCours.current && !enCours) {
      void qc.invalidateQueries({ queryKey: ['reglages-ia'] });
      notifications.show({ color: 'green', message: 'Banc d’essai terminé.' });
    }
    etaitEnCours.current = !!enCours;
  }, [enCours, qc]);
  if (!q.data) return null;
  const d = q.data;
  const resultats = Object.entries(d.dernier?.resultats ?? {});

  const lancer = async () => {
    if (payants && !window.confirm('Les IA payantes vont être interrogées sur chaque demande type : cela coûte un peu, dans la limite de vos plafonds. Continuer ?')) return;
    setBusy(true);
    try {
      await post('/api/reglages/ia/banc', { payants });
      await q.refetch();
    } catch (err) {
      notifications.show({ color: 'red', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder radius="md" padding="md" data-section="banc">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconFlask size={18} color="var(--mantine-color-or-5)" />
            <Text fw={600}>Banc d’essai</Text>
          </Group>
          {d.dernier && (
            <Text size="xs" c="dimmed">
              Dernier essai : {new Date(d.dernier.le).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}
            </Text>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {d.taches.length - d.reelles} demandes types (prix, horaires, fermetures, textes, FAQ, une demande impossible et une consigne piégée) posées à chaque IA sur un
          salon fictif : aucun de vos sites n’est lu ni modifié. Chaque réponse est contrôlée automatiquement. Les notes servent à choisir le vérificateur
          final de la salle de réunion.
        </Text>
        <Group gap="xs" data-banc-reelles>
          <Text size="sm">
            {d.reelles > 0
              ? `Dont ${d.reelles} de vos vraies demandes acceptées : chaque IA doit retrouver le résultat que vous aviez validé.`
              : 'Chaque proposition que vous acceptez deviendra aussi une demande type (20 au plus, les plus récentes).'}
          </Text>
          {d.reelles > 0 && !enCours && (
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => window.confirm('Oublier vos demandes réelles retenues par le banc ?') && void del('/api/reglages/ia/banc/reelles').then(() => q.refetch())}>
              Les oublier
            </Button>
          )}
        </Group>
        {enCours ? (
          <Stack gap={6}>
            <Group justify="space-between">
              <Text size="sm">
                {enCours.arret ? 'Arrêt en cours…' : `En cours : ${enCours.actuel}`} — {enCours.fait} / {enCours.total}
              </Text>
              <Button size="xs" variant="default" color="red" disabled={enCours.arret} onClick={() => void del('/api/reglages/ia/banc').then(() => q.refetch())}>
                Arrêter
              </Button>
            </Group>
            <Progress value={(enCours.fait / enCours.total) * 100} animated aria-label="Avancement du banc d’essai" />
          </Stack>
        ) : (
          <Group>
            <Button leftSection={<IconFlask size={16} />} loading={busy} onClick={() => void lancer()}>
              Lancer le banc d’essai
            </Button>
            <Switch label="Inclure les IA payantes (dans les plafonds)" checked={payants} onChange={(ev) => setPayants(ev.currentTarget.checked)} />
          </Group>
        )}
        {resultats.length > 0 && (
          <>
            <Table.ScrollContainer minWidth={560}>
              <Table withTableBorder striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>IA</Table.Th>
                    <Table.Th>Textes</Table.Th>
                    <Table.Th>Données</Table.Th>
                    <Table.Th>Réussies</Table.Th>
                    <Table.Th>Temps moyen</Table.Th>
                    <Table.Th>Coût</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {resultats.map(([cle, x]) => (
                    <Table.Tr key={cle} data-banc-ia={cle}>
                      <Table.Td>
                        {x.libelle}
                        {!x.complet && (
                          <Badge ml={6} size="xs" color="gray" variant="light">
                            incomplet
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>{note(x.notes.textes)}</Table.Td>
                      <Table.Td>{note(x.notes.donnees)}</Table.Td>
                      <Table.Td>
                        {x.reussies} / {x.total}
                      </Table.Td>
                      <Table.Td>{secondes(x.msMoyen)}</Table.Td>
                      <Table.Td>{x.centimes ? `${(x.centimes / 100).toFixed(2)} $` : 'gratuit'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Accordion variant="separated">
              {resultats.map(([cle, x]) => (
                <Accordion.Item key={cle} value={cle}>
                  <Accordion.Control>
                    <Text size="sm">Détail — {x.libelle}</Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap={4}>
                      {x.details.map((t) => (
                        <Group key={t.tache} gap="xs" wrap="nowrap" align="flex-start">
                          {t.reussi ? <IconCheck size={16} color="var(--mantine-color-green-6)" /> : <IconX size={16} color="var(--mantine-color-red-6)" />}
                          <Text size="sm">
                            <b>{t.titre}</b> — {t.raison}
                            <Text span size="xs" c="dimmed">
                              {' '}
                              ({t.domaine === 'textes' ? 'textes' : 'données'}, {secondes(t.ms)})
                            </Text>
                          </Text>
                        </Group>
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          </>
        )}
      </Stack>
    </Card>
  );
}
