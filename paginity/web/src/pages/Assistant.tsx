import { useState } from 'react';
import { Accordion, Alert, Badge, Button, Card, Group, Stack, Table, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconRobot, IconSend } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure } from '../format';
import { useSite } from './Site';

interface Proposition {
  id: string;
  demande: string;
  statut: 'en_cours' | 'proposee' | 'accord_requis' | 'impossible' | 'acceptee' | 'refusee' | 'perimee' | 'interrompue';
  cerveau: 'local' | 'claude' | 'chatgpt' | null;
  explication: string | null;
  raison: string | null;
  changements: { rubrique: string; libelle: string; avant: unknown; apres: unknown }[];
  empreinte: string | null;
  coutCentimes: number;
  journal: { le: number; texte: string }[];
  creeLe: number;
}

const STATUT: Record<Proposition['statut'], { libelle: string; couleur: string }> = {
  en_cours: { libelle: 'En cours', couleur: 'blue' },
  proposee: { libelle: 'À valider', couleur: 'or' },
  accord_requis: { libelle: 'Accord demandé', couleur: 'orange' },
  impossible: { libelle: 'Non réalisée', couleur: 'gray' },
  acceptee: { libelle: 'Acceptée (brouillon)', couleur: 'green' },
  refusee: { libelle: 'Refusée', couleur: 'gray' },
  perimee: { libelle: 'Périmée', couleur: 'gray' },
  interrompue: { libelle: 'Interrompue', couleur: 'gray' },
};
const CERVEAU = { local: 'Modèle local', claude: 'Claude', chatgpt: 'ChatGPT' } as const;

/** Différences champ par champ (premier niveau), lisibles par tout le monde. */
function differences(avant: unknown, apres: unknown): { champ: string; avant: string; apres: string }[] {
  const texte = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
  if (avant && apres && typeof avant === 'object' && typeof apres === 'object' && !Array.isArray(avant) && !Array.isArray(apres)) {
    const a = avant as Record<string, unknown>;
    const b = apres as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => ({ champ: k, avant: texte(a[k]), apres: texte(b[k]) }));
  }
  return [{ champ: '(ensemble)', avant: texte(avant), apres: texte(apres) }];
}

export function AssistantPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['assistant', id], queryFn: () => get<{ etat: { active: boolean }; propositions: Proposition[] }>(`/api/sites/${id}/assistant`) });
  const [demande, setDemande] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isLoading || site.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const actualiser = () => qc.invalidateQueries({ queryKey: ['assistant', id] });
  const agir = async (cle: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(cle);
    try {
      await f();
      if (ok) notifications.show({ color: 'green', message: ok });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e), autoClose: 10_000 });
    } finally {
      setBusy(null);
      void actualiser();
      void qc.invalidateQueries({ queryKey: ['site', id] });
    }
  };
  const peutPublier = !!site.data?.droits.publier;

  return (
    <Page
      titre="Assistant"
      sousTitre="Décrivez une modification de contenu : l’assistant prépare une proposition, vous la vérifiez avant qu’elle n’entre dans le brouillon."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? 'Site', to: `/sites/${id}` }, { label: 'Assistant' }]}
      largeur={900}
    >
      {!q.data.etat.active ? (
        <Alert color="blue" title="L’assistant est désactivé">
          Le propriétaire de la plateforme peut l’activer dans « Réglages de la plateforme ».
        </Alert>
      ) : (
        <Card withBorder radius="lg" padding="lg">
          <Stack>
            <Textarea
              label="Votre demande"
              placeholder="Exemple : ajoute la pose gel à 45 € dans les tarifs, ou : nous sommes fermés du 24 au 26 décembre."
              autosize
              minRows={3}
              maxLength={2000}
              value={demande}
              onChange={(e) => setDemande(e.currentTarget.value)}
            />
            <Group>
              <Button
                leftSection={<IconSend size={16} />}
                loading={busy === 'demande'}
                disabled={!demande.trim()}
                onClick={() =>
                  agir('demande', async () => {
                    await post(`/api/sites/${id}/assistant`, { demande });
                    setDemande('');
                  })
                }
              >
                Envoyer à l’assistant
              </Button>
            </Group>
          </Stack>
        </Card>
      )}

      {q.data.propositions.length === 0 && <Text c="dimmed">Aucune demande pour l’instant.</Text>}
      {q.data.propositions.map((p) => (
        <Card key={p.id} withBorder radius="lg" padding="lg">
          <Stack gap="sm">
            <Group justify="space-between" align="flex-start">
              <Stack gap={2} style={{ flex: 1 }}>
                <Text fw={600}>« {p.demande} »</Text>
                <Text size="xs" c="dimmed">
                  {dateHeure(p.creeLe)}
                  {p.cerveau ? ` · préparée par ${CERVEAU[p.cerveau]}` : ''}
                  {p.coutCentimes > 0 ? ` · coût ${(p.coutCentimes / 100).toFixed(2).replace('.', ',')} $` : p.cerveau === 'local' ? ' · gratuit' : ''}
                </Text>
              </Stack>
              <Badge color={STATUT[p.statut].couleur} variant="light">
                {STATUT[p.statut].libelle}
              </Badge>
            </Group>
            {p.explication && <Text size="sm">{p.explication}</Text>}
            {p.raison && (
              <Alert color={p.statut === 'accord_requis' ? 'orange' : 'gray'} variant="light">
                <Text size="sm">{p.raison}</Text>
              </Alert>
            )}
            {p.changements.map((c) => (
              <Stack key={c.rubrique} gap={4}>
                <Text size="sm" fw={500}>
                  {c.libelle}
                </Text>
                <Table.ScrollContainer minWidth={420}>
                  <Table withTableBorder fz="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w="22%">Champ</Table.Th>
                        <Table.Th>Avant</Table.Th>
                        <Table.Th>Après</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {differences(c.avant, c.apres).map((d) => (
                        <Table.Tr key={d.champ}>
                          <Table.Td>{d.champ}</Table.Td>
                          <Table.Td c="dimmed" style={{ wordBreak: 'break-word' }}>
                            {d.avant}
                          </Table.Td>
                          <Table.Td style={{ wordBreak: 'break-word' }}>{d.apres}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Stack>
            ))}
            <Group gap="xs">
              {p.statut === 'proposee' && (
                <>
                  <Button
                    loading={busy === `ok-${p.id}`}
                    onClick={() => agir(`ok-${p.id}`, () => post(`/api/sites/${id}/assistant/${p.id}/accepter`, { empreinte: p.empreinte }), 'Modification enregistrée dans le brouillon. Vérifiez l’aperçu, puis publiez.')}
                  >
                    Accepter (brouillon)
                  </Button>
                  <Button variant="light" color="gray" loading={busy === `non-${p.id}`} onClick={() => agir(`non-${p.id}`, () => post(`/api/sites/${id}/assistant/${p.id}/refuser`))}>
                    Refuser
                  </Button>
                </>
              )}
              {p.statut === 'accord_requis' && (
                <>
                  {peutPublier ? (
                    <Button color="orange" loading={busy === `relais-${p.id}`} onClick={() => agir(`relais-${p.id}`, () => post(`/api/sites/${id}/assistant/${p.id}/relais`))}>
                      Oui, passer à l’IA extérieure
                    </Button>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Une personne de rôle Éditeur ou plus doit donner son accord.
                    </Text>
                  )}
                  <Button variant="light" color="gray" loading={busy === `non-${p.id}`} onClick={() => agir(`non-${p.id}`, () => post(`/api/sites/${id}/assistant/${p.id}/refuser`))}>
                    Non merci
                  </Button>
                </>
              )}
              {p.statut === 'acceptee' && (
                <Button component={Link} to={`/sites/${id}/apercu`} variant="light">
                  Voir l’aperçu
                </Button>
              )}
            </Group>
            {p.journal.length > 0 && (
              <Accordion variant="contained" radius="md">
                <Accordion.Item value="journal">
                  <Accordion.Control icon={<IconRobot size={16} />}>
                    <Text size="sm">Ce qui s’est passé</Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap={4}>
                      {p.journal.map((j, i) => (
                        <Text key={i} size="xs">
                          {dateHeure(j.le)} — {j.texte}
                        </Text>
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}
          </Stack>
        </Card>
      ))}
    </Page>
  );
}
