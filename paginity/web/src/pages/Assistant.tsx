import { useState } from 'react';
import { Accordion, Alert, Badge, Button, Card, Group, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconHelpCircle, IconMicrophone, IconRobot, IconSend, IconUsersGroup } from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage, get, post } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure } from '../format';
import { useSite } from './Site';
import type { SiteDetail } from '../types';

interface Proposition {
  id: string;
  demande: string;
  statut: 'en_cours' | 'proposee' | 'accord_requis' | 'question' | 'repondue' | 'annulee' | 'impossible' | 'acceptee' | 'refusee' | 'perimee' | 'interrompue';
  annulable?: boolean;
  cerveau: string | null;
  cerveauLibelle: string | null;
  explication: string | null;
  raison: string | null;
  changements: { rubrique: string; libelle: string; avant: unknown; apres: unknown }[];
  empreinte: string | null;
  coutCentimes: number;
  journal: { le: number; texte: string }[];
  reunion: null | {
    domaine: string;
    domaineLibelle: string;
    choixDomaine: string;
    verificateur: string | null;
    choixVerificateur: string | null;
    statutVerificateur: string | null;
    participants: { cle: string; libelle: string; auteur: string; statut: string; explication: string; changements: { rubrique: string; libelle: string; avant: unknown; apres: unknown }[] }[];
  };
  creeLe: number;
}

const STATUT: Record<Proposition['statut'], { libelle: string; couleur: string }> = {
  en_cours: { libelle: 'En cours', couleur: 'blue' },
  proposee: { libelle: 'À valider', couleur: 'or' },
  accord_requis: { libelle: 'Accord demandé', couleur: 'orange' },
  question: { libelle: 'Question', couleur: 'cyan' },
  repondue: { libelle: 'Répondue', couleur: 'gray' },
  annulee: { libelle: 'Annulée', couleur: 'gray' },
  impossible: { libelle: 'Non réalisée', couleur: 'gray' },
  acceptee: { libelle: 'Acceptée (brouillon)', couleur: 'green' },
  refusee: { libelle: 'Refusée', couleur: 'gray' },
  perimee: { libelle: 'Périmée', couleur: 'gray' },
  interrompue: { libelle: 'Interrompue', couleur: 'gray' },
};

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
  return (
    <Page
      titre="Assistant"
      sousTitre="Décrivez une modification de contenu : l’assistant prépare une proposition, vous la vérifiez avant qu’elle n’entre dans le brouillon."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? 'Site', to: `/sites/${id}` }, { label: 'Assistant' }]}
      largeur={900}
    >
      <FilAssistant siteId={id!} />
    </Page>
  );
}

/** Zone de demande et propositions de l'assistant pour un site (page Assistant et panneau permanent). */
export function FilAssistant({ siteId, compact = false }: { siteId: string; compact?: boolean }) {
  const id = siteId;
  const site = useQuery({ queryKey: ['site', id], queryFn: () => get<SiteDetail>(`/api/sites/${id}`) });
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['assistant', id], queryFn: () => get<{ etat: { active: boolean; reunion: boolean; dictee?: boolean }; propositions: Proposition[] }>(`/api/sites/${id}/assistant`) });
  const [demande, setDemande] = useState('');
  const [domaine, setDomaine] = useState('auto');
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
  const pad = compact ? 'sm' : 'lg';

  return (
    <Stack gap={compact ? 'sm' : 'lg'}>
      {!q.data.etat.active ? (
        <Alert color="blue" title="L’assistant est désactivé">
          Le propriétaire de la plateforme peut l’activer dans « Réglages de la plateforme ».
        </Alert>
      ) : (
        <Card withBorder radius="lg" padding={pad}>
          <Stack gap="sm">
            <Textarea
              label="Votre demande"
              placeholder="Exemple : ajoute la pose gel à 45 € dans les tarifs, ou : nous sommes fermés du 24 au 26 décembre."
              autosize
              minRows={compact ? 2 : 3}
              maxLength={2000}
              value={demande}
              onChange={(e) => setDemande(e.currentTarget.value)}
            />
            {q.data.etat.dictee && <BoutonDictee onTexte={(t) => setDemande((d) => (d ? `${d} ${t}` : t))} />}
            <Group align="flex-end" gap="sm">
              {q.data.etat.reunion && (
                <Select
                  size="xs"
                  w={190}
                  label="Domaine"
                  data={[
                    { value: 'auto', label: 'Automatique' },
                    { value: 'textes', label: 'Textes' },
                    { value: 'donnees', label: 'Données' },
                  ]}
                  value={domaine}
                  allowDeselect={false}
                  onChange={(v) => setDomaine(v ?? 'auto')}
                />
              )}
              <Button
                leftSection={<IconSend size={16} />}
                loading={busy === 'demande'}
                disabled={!demande.trim()}
                onClick={() =>
                  agir('demande', async () => {
                    await post(`/api/sites/${id}/assistant`, { demande, domaine: domaine === 'auto' ? undefined : domaine });
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
        <Card key={p.id} withBorder radius="lg" padding={pad}>
          <Stack gap="sm">
            <Group justify="space-between" align="flex-start">
              <Stack gap={2} style={{ flex: 1 }}>
                <Text fw={600} style={{ whiteSpace: 'pre-line' }}>« {p.demande} »</Text>
                <Text size="xs" c="dimmed">
                  {dateHeure(p.creeLe)}
                  {p.cerveauLibelle ? ` · préparée par ${p.cerveauLibelle}` : ''}
                  {p.coutCentimes > 0 ? ` · coût ${(p.coutCentimes / 100).toFixed(2).replace('.', ',')} $` : p.cerveau?.startsWith('local') ? ' · gratuit' : ''}
                </Text>
              </Stack>
              <Badge color={STATUT[p.statut].couleur} variant="light">
                {STATUT[p.statut].libelle}
              </Badge>
            </Group>
            {p.reunion?.verificateur && (
              <Text size="xs" c="dimmed" data-reunion>
                Réunion · domaine {p.reunion.domaineLibelle.split(' (')[0].toLowerCase()}
                {p.reunion.choixDomaine === 'vous' ? ' (choisi par vous)' : ''} · vérificateur final : {p.reunion.verificateur} ({p.reunion.choixVerificateur})
              </Text>
            )}
            {p.explication && <Text size="sm">{p.explication}</Text>}
            {p.raison && p.statut === 'question' ? (
              <Reponse
                question={p.raison}
                busy={busy === `rep-${p.id}`}
                envoyer={(reponse) => agir(`rep-${p.id}`, () => post(`/api/sites/${id}/assistant/${p.id}/repondre`, { reponse }))}
              />
            ) : (
              p.raison && (
                <Alert color={p.statut === 'accord_requis' ? 'orange' : 'gray'} variant="light">
                  <Text size="sm">{p.raison}</Text>
                </Alert>
              )
            )}
            {p.changements.map((c) => (
              <Stack key={c.rubrique} gap={4}>
                <Text size="sm" fw={500}>
                  {c.libelle}
                </Text>
                {compact ? (
                  // Panneau étroit : un bloc par champ, « avant » au-dessus, « après » en dessous.
                  <Stack gap={6}>
                    {differences(c.avant, c.apres).map((d) => (
                      <Card key={d.champ} withBorder radius="md" padding="xs">
                        <Text size="xs" fw={600}>
                          {d.champ}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word', textDecoration: 'line-through' }}>
                          {d.avant}
                        </Text>
                        <Text size="sm" style={{ wordBreak: 'break-word' }}>
                          {d.apres}
                        </Text>
                      </Card>
                    ))}
                  </Stack>
                ) : (
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
                )}
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
              {p.annulable && (
                <Button
                  variant="subtle"
                  color="red"
                  leftSection={<IconArrowBackUp size={16} />}
                  loading={busy === `annuler-${p.id}`}
                  onClick={() =>
                    window.confirm('Remettre les contenus comme avant cette modification ? (dans le brouillon)') &&
                    agir(`annuler-${p.id}`, () => post(`/api/sites/${id}/assistant/${p.id}/annuler`), 'Modification annulée : le brouillon est revenu comme avant.')
                  }
                >
                  Annuler cette modification
                </Button>
              )}
            </Group>
            {p.reunion && p.reunion.participants.length > 0 && (
              <Accordion variant="contained" radius="md">
                <Accordion.Item value="reunion">
                  <Accordion.Control icon={<IconUsersGroup size={16} />}>
                    <Text size="sm">Propositions des autres IA ({p.reunion.participants.length})</Text>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="xs">
                      {p.reunion.participants.map((x) => (
                        <Card key={x.cle} withBorder radius="md" padding="xs">
                          <Group justify="space-between" wrap="nowrap" align="flex-start">
                            <Text size="sm" fw={600}>
                              {x.libelle}
                            </Text>
                            <Badge size="xs" variant="light" color={x.statut === 'valable' ? 'green' : 'gray'}>
                              {x.statut}
                            </Badge>
                          </Group>
                          {x.explication && (
                            <Text size="xs" c="dimmed">
                              {x.explication}
                            </Text>
                          )}
                          {x.changements.flatMap((c) => differences(c.avant, c.apres)).map((d) => (
                            <Text key={d.champ} size="xs" style={{ wordBreak: 'break-word' }}>
                              {d.champ} → {d.apres}
                            </Text>
                          ))}
                        </Card>
                      ))}
                      {p.reunion.statutVerificateur && (
                        <Text size="xs" c="dimmed">
                          Vérificateur final ({p.reunion.verificateur}) : {p.reunion.statutVerificateur}.
                        </Text>
                      )}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}
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
    </Stack>
  );
}

/** Réponse à la question de l'IA : la demande repart, complétée. */
function Reponse({ question, busy, envoyer }: { question: string; busy: boolean; envoyer: (r: string) => void }) {
  const [r, setR] = useState('');
  return (
    <Alert color="cyan" variant="light" icon={<IconHelpCircle size={18} />} title="L’assistant a besoin d’une précision">
      <Stack gap="xs">
        <Text size="sm">{question}</Text>
        <Group align="flex-end" gap="xs">
          <TextInput style={{ flex: 1, minWidth: 180 }} aria-label="Votre réponse" placeholder="Votre réponse" value={r} maxLength={500} onChange={(e) => setR(e.currentTarget.value)} />
          <Button size="sm" loading={busy} disabled={!r.trim()} onClick={() => envoyer(r)}>
            Répondre
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

/**
 * Dictée vocale (si le propriétaire l'a autorisée) : utilise la reconnaissance vocale du navigateur.
 * Attention : dans Chrome et Safari, la voix est envoyée aux serveurs de Google ou d'Apple pour être transcrite.
 */
type Reco = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
function BoutonDictee({ onTexte }: { onTexte: (t: string) => void }) {
  const [ecoute, setEcoute] = useState<Reco | null>(null);
  const W = window as unknown as { SpeechRecognition?: new () => Reco; webkitSpeechRecognition?: new () => Reco };
  const Classe = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!Classe) return null;
  const basculer = () => {
    if (ecoute) {
      ecoute.stop();
      return;
    }
    const r = new Classe();
    r.lang = 'fr-FR';
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      const t = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (t) onTexte(t);
    };
    r.onerror = (e) => notifications.show({ color: 'red', message: e.error === 'not-allowed' ? 'Micro refusé : autorisez-le dans le navigateur.' : 'La dictée n’a pas fonctionné.' });
    r.onend = () => setEcoute(null);
    setEcoute(r);
    r.start();
  };
  return (
    <Group gap="xs">
      <Button size="xs" variant={ecoute ? 'filled' : 'light'} color={ecoute ? 'red' : undefined} leftSection={<IconMicrophone size={14} />} onClick={basculer}>
        {ecoute ? 'J’écoute… (toucher pour arrêter)' : 'Dicter'}
      </Button>
      <Text size="xs" c="dimmed">
        La voix est transcrite par le service du navigateur (Google ou Apple).
      </Text>
    </Group>
  );
}
