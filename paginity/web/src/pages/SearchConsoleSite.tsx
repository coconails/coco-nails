import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, List, Select, SimpleGrid, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconBrandGoogle, IconRefresh } from '@tabler/icons-react';
import { errorMessage, get, post, put } from '../api';
import { useEtat } from '../App';

interface Ligne {
  cle: string;
  clics: number;
  impressions: number;
  ctr: number;
  position: number | null;
}
interface Etat {
  compte: { connecte: boolean };
  propriete: string | null;
  rapport: null | {
    le: number;
    debut: string;
    fin: string;
    total: { clics: number; impressions: number; ctr: number; position: number | null };
    requetes: Ligne[];
    pages: Ligne[];
    redaction: { phrases: string[]; pistes: string[]; significatif: boolean };
  };
  jours: { jour: string; clics: number; impressions: number }[];
  inspection: null | { le: number; resultats: { adresse: string; verdict: string; couverture: string; dernierPassage: string | null; erreur: string | null }[] };
  indexnow: { actif: boolean; dernier: null | { le: number; ok: boolean; message: string; adresses: number } };
}
const nb = (x: number) => x.toLocaleString('fr-FR');
const pct = (x: number) => `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
const pos = (x: number | null) => (x === null ? '—' : x.toLocaleString('fr-FR', { maximumFractionDigits: 1 }));
const date = (t: number) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const court = (j: string) => new Date(`${j}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/** Barres par jour, une seule mesure (pas de double échelle). */
function Barres({ titre, jours, valeur }: { titre: string; jours: { jour: string }[]; valeur: (i: number) => number }) {
  const [survol, setSurvol] = useState<number | null>(null);
  const L = 600;
  const H = 110;
  const n = jours.length || 1;
  const max = Math.max(1, ...jours.map((_, i) => valeur(i)));
  const pas = L / n;
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {titre}
      </Text>
      <Text size="xs" c="dimmed" mih={18}>
        {survol !== null ? `${court(jours[survol].jour)} : ${nb(valeur(survol))}` : 'Survolez une barre pour le détail du jour.'}
      </Text>
      <svg viewBox={`0 0 ${L} ${H + 24}`} width="100%" role="img" aria-label={`${titre} par jour`} onMouseLeave={() => setSurvol(null)}>
        <line x1={0} x2={L} y1={H} y2={H} stroke="var(--mantine-color-default-border)" />
        {jours.map((j, i) => {
          const v = valeur(i);
          const h = v ? Math.max(2, (v / max) * (H - 4)) : 0;
          return (
            <g key={j.jour} onMouseEnter={() => setSurvol(i)}>
              <rect x={i * pas} y={0} width={pas} height={H} fill="transparent" />
              {h > 0 && <rect x={i * pas + 1} y={H - h} width={Math.max(1, pas - 2)} height={h} rx={Math.min(3, (pas - 2) / 2)} fill="var(--mantine-color-or-5)" opacity={survol === null || survol === i ? 1 : 0.45} />}
              <title>{`${court(j.jour)} : ${nb(v)}`}</title>
            </g>
          );
        })}
        {jours.length > 0 && (
          <>
            <text x={0} y={H + 20} fontSize={17} fill="var(--mantine-color-dimmed)">
              {court(jours[0].jour)}
            </text>
            <text x={L} y={H + 20} fontSize={17} textAnchor="end" fill="var(--mantine-color-dimmed)">
              {court(jours[jours.length - 1].jour)}
            </text>
          </>
        )}
      </svg>
    </Stack>
  );
}

function TableLignes({ titre, lignes }: { titre: string; lignes: Ligne[] }) {
  if (!lignes.length) return null;
  return (
    <Table.ScrollContainer minWidth={460}>
      <Table fz="sm" withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{titre}</Table.Th>
            <Table.Th ta="right">Apparitions</Table.Th>
            <Table.Th ta="right">Clics</Table.Th>
            <Table.Th ta="right">Position moy.</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {lignes.slice(0, 10).map((l) => (
            <Table.Tr key={l.cle}>
              <Table.Td style={{ wordBreak: 'break-all' }}>{l.cle}</Table.Td>
              <Table.Td ta="right">{nb(l.impressions)}</Table.Td>
              <Table.Td ta="right">{nb(l.clics)}</Table.Td>
              <Table.Td ta="right">{pos(l.position)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Partie « Dans Google » de la page Référencement (M2, lecture seule). */
export function SearchConsoleSite({ siteId, peutRegler }: { siteId: string; peutRegler: boolean }) {
  const proprietaire = !!useEtat().utilisateur?.proprietaire;
  const q = useQuery({ queryKey: ['gsc', siteId], queryFn: () => get<Etat>(`/api/sites/${siteId}/search-console`) });
  const props = useQuery({ queryKey: ['gsc-proprietes'], queryFn: () => get<{ siteUrl: string }[]>('/api/reglages/search-console/proprietes'), enabled: proprietaire && !!q.data?.compte.connecte && !q.data?.propriete });
  const [choix, setChoix] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!q.data) return null;
  const e = q.data;
  const agir = async (cle: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(cle);
    try {
      await f();
      if (ok) notifications.show({ color: 'green', message: ok });
      await q.refetch();
    } catch (err) {
      notifications.show({ color: 'red', message: errorMessage(err), autoClose: 12_000 });
    } finally {
      setBusy(null);
    }
  };
  const r = e.rapport;
  return (
    <Card withBorder radius="lg" padding="lg" data-section="google">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconBrandGoogle size={20} color="var(--mantine-color-or-5)" />
            <Title order={2} fz="lg">
              Dans Google (Search Console)
            </Title>
          </Group>
          {e.propriete && <Badge variant="light">{e.propriete}</Badge>}
        </Group>
        {!e.compte.connecte ? (
          <Alert color="blue" variant="light">
            Search Console n’est pas connecté. {proprietaire ? 'Connectez-le dans « Réglages de la plateforme ».' : 'Le propriétaire de la plateforme peut le faire.'}
          </Alert>
        ) : !e.propriete ? (
          proprietaire ? (
            <Group align="flex-end">
              <Select
                style={{ flex: 1, minWidth: 220 }}
                label="Propriété Search Console de ce site"
                placeholder={props.isLoading ? 'Chargement…' : 'Choisir'}
                data={(props.data ?? []).map((p) => p.siteUrl)}
                value={choix}
                onChange={setChoix}
              />
              <Button disabled={!choix} loading={busy === 'lier'} onClick={() => void agir('lier', () => put(`/api/sites/${siteId}/search-console`, { propriete: choix }), 'Site relié.')}>
                Relier
              </Button>
            </Group>
          ) : (
            <Alert color="blue" variant="light">
              Ce site n’est pas encore relié à sa propriété Search Console (à faire par le propriétaire de la plateforme).
            </Alert>
          )
        ) : (
          <>
            <Group>
              <Button leftSection={<IconRefresh size={16} />} loading={busy === 'releve'} onClick={() => void agir('releve', () => post(`/api/sites/${siteId}/search-console/releve`))}>
                Actualiser les chiffres
              </Button>
              {proprietaire && (
                <Button
                  variant="subtle"
                  color="gray"
                  onClick={() => window.confirm('Délier ce site de sa propriété Search Console ? Les chiffres relevés pour ce site seront effacés.') && void agir('delier', () => put(`/api/sites/${siteId}/search-console`, { propriete: null }))}
                >
                  Délier
                </Button>
              )}
            </Group>
            {!r ? (
              <Text size="sm" c="dimmed">
                Pas encore de chiffres : « Actualiser les chiffres » (puis relevé automatique chaque jour).
              </Text>
            ) : (
              <>
                <Text size="xs" c="dimmed">
                  Relevé du {date(r.le)} — données de Google jusqu’au {court(r.fin)} (Google les publie avec environ 3 jours de retard).
                </Text>
                <SimpleGrid cols={{ base: 2, sm: 4 }}>
                  {[
                    ['Apparitions', nb(r.total.impressions)],
                    ['Clics', nb(r.total.clics)],
                    ['Taux de clic', pct(r.total.ctr)],
                    ['Position moyenne', pos(r.total.position)],
                  ].map(([l, v]) => (
                    <Card key={l} withBorder radius="md" padding="sm">
                      <Text size="xs" c="dimmed">
                        {l} (28 jours)
                      </Text>
                      <Text fz={26} fw={700} lh={1.2}>
                        {v}
                      </Text>
                    </Card>
                  ))}
                </SimpleGrid>
                <Stack gap={4} data-rapport>
                  {r.redaction.phrases.map((p) => (
                    <Text key={p} size="sm">
                      {p}
                    </Text>
                  ))}
                </Stack>
                {r.redaction.pistes.length > 0 && (
                  <Alert color="yellow" variant="light" title="Pistes (à vérifier, rien n’est garanti)">
                    <List size="sm" spacing={4}>
                      {r.redaction.pistes.map((p) => (
                        <List.Item key={p}>{p}</List.Item>
                      ))}
                    </List>
                  </Alert>
                )}
                <SimpleGrid cols={{ base: 1, md: 2 }}>
                  <Barres titre="Apparitions par jour" jours={e.jours} valeur={(i) => e.jours[i].impressions} />
                  <Barres titre="Clics par jour" jours={e.jours} valeur={(i) => e.jours[i].clics} />
                </SimpleGrid>
                <TableLignes titre="Recherches" lignes={r.requetes} />
                <TableLignes titre="Pages" lignes={r.pages} />
              </>
            )}
            <Group justify="space-between" mt="xs">
              <Text fw={600} size="sm">
                Indexation des pages (selon Google)
              </Text>
              <Button size="xs" variant="default" loading={busy === 'inspection'} onClick={() => void agir('inspection', () => post(`/api/sites/${siteId}/search-console/inspection`))}>
                Vérifier l’indexation
              </Button>
            </Group>
            {e.inspection && (
              <Table.ScrollContainer minWidth={460}>
                <Table fz="sm" withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Page</Table.Th>
                      <Table.Th>État dans Google</Table.Th>
                      <Table.Th>Dernier passage de Google</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {e.inspection.resultats.map((x) => (
                      <Table.Tr key={x.adresse}>
                        <Table.Td style={{ wordBreak: 'break-all' }}>{x.adresse}</Table.Td>
                        <Table.Td>
                          <Badge size="sm" variant="light" color={x.verdict === 'PASS' ? 'green' : x.verdict === 'ERREUR' ? 'red' : 'yellow'}>
                            {x.verdict === 'PASS' ? 'indexée' : x.verdict === 'ERREUR' ? 'erreur' : 'à vérifier'}
                          </Badge>{' '}
                          {x.erreur ?? x.couverture}
                        </Table.Td>
                        <Table.Td>{x.dernierPassage ? date(Date.parse(x.dernierPassage)) : '—'}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </>
        )}
        {peutRegler && (
          <Stack gap={4} mt="xs">
            <Switch
              label="Prévenir Bing et les moteurs IndexNow après chaque publication"
              description="Envoie l’adresse des pages du plan du site à IndexNow (Bing, Yandex, Seznam…). Google n’utilise pas IndexNow. Nécessite un nom de domaine configuré."
              checked={e.indexnow.actif}
              onChange={(ev) => void agir('indexnow', () => put(`/api/sites/${siteId}/indexnow`, { actif: ev.currentTarget.checked }))}
            />
            {e.indexnow.dernier && (
              <Text size="xs" c="dimmed">
                Dernier envoi : {date(e.indexnow.dernier.le)} — {e.indexnow.dernier.adresses} adresse(s), {e.indexnow.dernier.message}.
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
