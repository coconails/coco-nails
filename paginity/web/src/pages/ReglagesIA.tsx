import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Divider, Group, NumberInput, PasswordInput, SegmentedControl, Select, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconRobot } from '@tabler/icons-react';
import { del, errorMessage, get, post, put } from '../api';
import { Loading } from '../components/Page';
import { BancEssai } from './BancEssai';
import { DetecterModeles } from './DetecterModeles';

type Externe = 'claude' | 'chatgpt';
interface Local {
  id?: string;
  nom: string;
  actif: boolean;
  url: string;
  modele: string;
  tailleMax?: number;
  delaiS?: number;
}
interface Service {
  actif: boolean;
  modele: string;
  prixEntree: number | null;
  prixSortie: number | null;
  plafondCentimes: number | null;
  delaiS: number;
  url: string;
}
interface EtatIA {
  reglages: {
    active: boolean;
    dictee: boolean;
    relaisExterne: 'jamais' | 'demander' | 'auto';
    plafondMensuelCentimes: number;
    ordre: Externe[];
    locaux: Local[];
    claude: Service;
    chatgpt: Service;
    reunion: { active: boolean; maxParticipants: number; payantVerificateur: boolean; verificateurs: Partial<Record<string, string>> };
  };
  cles: Record<Externe, boolean>;
  depenseDuMoisCentimes: number;
  depenseParService: Record<Externe, number>;
  enService: Record<string, boolean>;
  tarifsClaude: Record<string, { entree: number; sortie: number; libelle: string }>;
  domaines: Record<string, string>;
  notes: Record<string, Record<string, { note: number | null; banc?: number | null; acceptes?: number; refuses?: number }>>;
  libelles: Record<string, string>;
}

/** Montants en dollars US (devise de facturation d'Anthropic et d'OpenAI), saisis et affichés en dollars, stockés en centimes. */
const dollars = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} $`;
const enCentimes = (v: string | number) => Math.round(Number(v || 0) * 100);

export function ReglagesIA() {
  const q = useQuery({ queryKey: ['reglages-ia'], queryFn: () => get<EtatIA>('/api/reglages/ia') });
  const [r, setR] = useState<EtatIA['reglages'] | null>(null);
  const [cles, setCles] = useState<Record<Externe, string>>({ claude: '', chatgpt: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setR(q.data.reglages);
  }, [q.data]);
  if (!q.data || !r) return <Loading />;
  const e = q.data;

  const enregistrer = async (changement?: Partial<EtatIA['reglages']>) => {
    setBusy(true);
    try {
      const corps = changement ?? { ...r, reunion: { ...r.reunion, verificateurs: Object.fromEntries(Object.keys(e.domaines).map((d) => [d, r.reunion.verificateurs[d] ?? 'auto'])) } };
      await put('/api/reglages/ia', corps);
      notifications.show({ color: 'green', message: 'Réglages de l’assistant enregistrés.' });
      void q.refetch();
    } catch (err) {
      notifications.show({ color: 'red', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const service = (nom: Externe) => r[nom];
  const setService = (nom: Externe, v: Partial<Service>) => setR({ ...r, [nom]: { ...r[nom], ...v } });

  const carteService = (nom: Externe, titre: string, aide: React.ReactNode) => {
    const s = service(nom);
    return (
      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Group justify="space-between">
            <Group gap="xs">
              <Text fw={600}>{titre}</Text>
              {e.enService[nom] ? <Badge color="green" variant="light">En service</Badge> : <Badge color="gray" variant="light">Hors service</Badge>}
            </Group>
            <Switch label="Autoriser" checked={s.actif} onChange={(ev) => setService(nom, { actif: ev.currentTarget.checked })} />
          </Group>
          <Text size="sm" c="dimmed">
            {aide}
          </Text>
          <Group align="flex-end" gap="xs">
            <PasswordInput
              style={{ flex: 1, minWidth: 220 }}
              label="Clé d’API"
              placeholder={e.cles[nom] ? '•••••••• (enregistrée — saisir pour la remplacer)' : 'Collez ici la clé créée sur le site du service'}
              value={cles[nom]}
              onChange={(ev) => setCles({ ...cles, [nom]: ev.currentTarget.value })}
              autoComplete="off"
            />
            <Button
              variant="light"
              disabled={!cles[nom]}
              onClick={async () => {
                try {
                  await put(`/api/reglages/ia/cle/${nom}`, { cle: cles[nom] });
                  setCles({ ...cles, [nom]: '' });
                  notifications.show({ color: 'green', message: 'Clé enregistrée et chiffrée. Elle ne sera plus affichée.' });
                  void q.refetch();
                } catch (err) {
                  notifications.show({ color: 'red', message: errorMessage(err) });
                }
              }}
            >
              Enregistrer la clé
            </Button>
            {e.cles[nom] && (
              <Button
                variant="subtle"
                color="red"
                onClick={async () => {
                  if (!window.confirm('Effacer cette clé ? Le service ne pourra plus être utilisé.')) return;
                  try {
                    await del(`/api/reglages/ia/cle/${nom}`);
                    void q.refetch();
                  } catch (err) {
                    notifications.show({ color: 'red', message: errorMessage(err) });
                  }
                }}
              >
                Effacer
              </Button>
            )}
          </Group>
          {nom === 'claude' ? (
            <Select
              label="Modèle"
              data={Object.entries(e.tarifsClaude).map(([value, t]) => ({ value, label: t.libelle }))}
              value={s.modele}
              allowDeselect={false}
              onChange={(v) => v && setService(nom, { modele: v, prixEntree: e.tarifsClaude[v].entree, prixSortie: e.tarifsClaude[v].sortie })}
            />
          ) : (
            <TextInput label="Modèle" placeholder="Nom exact du modèle (page « Models » d’OpenAI)" value={s.modele} onChange={(ev) => setService(nom, { modele: ev.currentTarget.value })} />
          )}
          <Group grow align="flex-start">
            <NumberInput label="Prix lecture ($ / million de jetons)" decimalScale={3} min={0} value={s.prixEntree ?? ''} onChange={(v) => setService(nom, { prixEntree: v === '' ? null : Number(v) })} />
            <NumberInput label="Prix écriture ($ / million de jetons)" decimalScale={3} min={0} value={s.prixSortie ?? ''} onChange={(v) => setService(nom, { prixSortie: v === '' ? null : Number(v) })} />
          </Group>
          <NumberInput
            label="Plafond mensuel propre à ce service ($)"
            description="Laisser vide pour n’appliquer que le plafond global."
            decimalScale={2}
            min={0}
            value={s.plafondCentimes === null ? '' : s.plafondCentimes / 100}
            onChange={(v) => setService(nom, { plafondCentimes: v === '' ? null : enCentimes(v) })}
          />
          <Text size="xs" c="dimmed">
            Dépensé ce mois-ci : {dollars(e.depenseParService[nom])}
            {s.prixEntree === null || s.prixSortie === null ? ' — renseignez les prix : sans eux, le coût ne peut pas être compté et le service reste hors service.' : ''}
          </Text>
        </Stack>
      </Card>
    );
  };

  return (
    <Card withBorder radius="lg" padding="lg">
      <Stack>
        <Group justify="space-between">
          <Group gap="xs">
            <IconRobot />
            <Title order={2} fz="lg">
              Assistant IA
            </Title>
          </Group>
          <Switch
            size="md"
            label={r.active ? 'Activé' : 'Désactivé'}
            checked={r.active}
            onChange={(ev) => {
              const active = ev.currentTarget.checked;
              setR({ ...r, active });
              void enregistrer({ active });
            }}
          />
        </Group>
        <Text size="sm" c="dimmed">
          L’assistant propose des modifications de contenus ; rien n’est enregistré sans votre accord, et seulement dans le brouillon. Désactiver
          l’assistant arrête immédiatement tout ce qui est en cours (arrêt d’urgence).
        </Text>
        <Switch
          label="Bouton « Dicter » (dictée vocale)"
          description="Pratique sur téléphone. Attention : la voix est envoyée au service de reconnaissance du navigateur (Google pour Chrome, Apple pour Safari) pour être transcrite."
          checked={r.dictee}
          onChange={(ev) => setR({ ...r, dictee: ev.currentTarget.checked })}
        />

        <Divider label="Modèles locaux (gratuits, rien ne sort de chez vous)" labelPosition="left" />
        <Text size="sm" c="dimmed">
          Modèles installés sur votre machine (Qwen3-Coder, GLM, Kimi, DeepSeek…), joints par le protocole « compatible OpenAI » (Ollama, llama.cpp,
          LM Studio…). Ils sont essayés dans l’ordre de la liste.
        </Text>
        <DetecterModeles onAjoute={() => void q.refetch()} />
        {r.locaux.map((l, i) => {
          const maj = (v: Partial<Local>) => setR({ ...r, locaux: r.locaux.map((x, j) => (j === i ? { ...x, ...v } : x)) });
          const deplacer = (sens: -1 | 1) => {
            const t = [...r.locaux];
            [t[i], t[i + sens]] = [t[i + sens], t[i]];
            setR({ ...r, locaux: t });
          };
          return (
            <Card key={l.id ?? `nouveau-${i}`} withBorder radius="md" padding="md" data-modele-local={l.nom}>
              <Stack gap="sm">
                <Group justify="space-between">
                  <Group gap="xs">
                    <Text fw={600}>
                      {i + 1}. {l.nom || 'Nouveau modèle'}
                    </Text>
                    {l.id && e.enService[`local:${l.id}`] ? <Badge color="green" variant="light">En service</Badge> : <Badge color="gray" variant="light">Hors service</Badge>}
                  </Group>
                  <Switch label="Autoriser" checked={l.actif} onChange={(ev) => maj({ actif: ev.currentTarget.checked })} />
                </Group>
                <Group grow align="flex-start">
                  <TextInput label="Nom affiché" placeholder="Qwen3-Coder" value={l.nom} onChange={(ev) => maj({ nom: ev.currentTarget.value })} />
                  <TextInput label="Nom du modèle installé" placeholder="nom du modèle installé" value={l.modele} onChange={(ev) => maj({ modele: ev.currentTarget.value })} />
                </Group>
                <TextInput label="Adresse du modèle" placeholder="http://127.0.0.1:11434/v1" value={l.url} onChange={(ev) => maj({ url: ev.currentTarget.value })} />
                <Group gap="xs">
                  <Button
                    variant="light"
                    size="xs"
                    disabled={!l.id}
                    onClick={async () => {
                      try {
                        const t = await post<{ repond: boolean; enService: boolean }>('/api/reglages/ia/essai-local', { id: l.id });
                        notifications.show(
                          t.repond
                            ? { color: 'green', message: `${l.nom} répond.` }
                            : { color: 'red', message: t.enService ? `${l.nom} ne répond pas à cette adresse.` : 'Enregistrez d’abord ce modèle et autorisez-le.' },
                        );
                      } catch (err) {
                        notifications.show({ color: 'red', message: errorMessage(err) });
                      }
                    }}
                  >
                    Essayer
                  </Button>
                  <Button variant="subtle" size="xs" disabled={i === 0} onClick={() => deplacer(-1)} aria-label={`Monter ${l.nom}`}>
                    Monter
                  </Button>
                  <Button variant="subtle" size="xs" disabled={i === r.locaux.length - 1} onClick={() => deplacer(1)} aria-label={`Descendre ${l.nom}`}>
                    Descendre
                  </Button>
                  <Button variant="subtle" size="xs" color="red" onClick={() => window.confirm(`Retirer ${l.nom || 'ce modèle'} de la liste ?`) && setR({ ...r, locaux: r.locaux.filter((_, j) => j !== i) })}>
                    Retirer
                  </Button>
                </Group>
              </Stack>
            </Card>
          );
        })}
        <Group>
          <Button
            variant="light"
            disabled={r.locaux.length >= 8}
            onClick={() => setR({ ...r, locaux: [...r.locaux, { nom: '', actif: true, url: r.locaux[0]?.url ?? '', modele: '' }] })}
          >
            Ajouter un modèle local
          </Button>
          {r.locaux.length > 0 && (
            <Text size="xs" c="dimmed">
              Pensez à « Enregistrer les réglages de l’assistant » en bas.
            </Text>
          )}
        </Group>

        <Divider label="IA extérieures (payantes, contenus publics du site uniquement)" labelPosition="left" />
        <Alert variant="light">
          <Text size="sm">
            Ces services sont facturés à l’usage, en dollars, sur un compte séparé de vos abonnements (Claude, ChatGPT). Ils ne reçoivent que les
            contenus publics du site concerné : jamais les secrets, les messages des clientes ni le code serveur.
          </Text>
        </Alert>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Quand le modèle local ne suffit pas
          </Text>
          <SegmentedControl
            data={[
              { value: 'jamais', label: 'Ne jamais passer le relais' },
              { value: 'demander', label: 'Demander mon accord' },
              { value: 'auto', label: 'Passer le relais seul' },
            ]}
            value={r.relaisExterne}
            onChange={(v) => setR({ ...r, relaisExterne: v as EtatIA['reglages']['relaisExterne'] })}
          />
        </Stack>
        <Group grow align="flex-start">
          <NumberInput
            label="Plafond mensuel global ($)"
            description="Toutes IA extérieures confondues. 0 = aucune dépense."
            decimalScale={2}
            min={0}
            value={r.plafondMensuelCentimes / 100}
            onChange={(v) => setR({ ...r, plafondMensuelCentimes: enCentimes(v) })}
          />
          <Select
            label="Ordre d’essai"
            data={[
              { value: 'claude,chatgpt', label: 'Claude, puis ChatGPT' },
              { value: 'chatgpt,claude', label: 'ChatGPT, puis Claude' },
            ]}
            value={r.ordre.join(',')}
            allowDeselect={false}
            onChange={(v) => v && setR({ ...r, ordre: v.split(',') as Externe[] })}
          />
        </Group>
        <Text size="sm">
          Dépensé ce mois-ci : <b>{dollars(e.depenseDuMoisCentimes)}</b> sur {dollars(r.plafondMensuelCentimes)}. Avant chaque appel, PAGINITY vérifie que le coût
          maximal possible reste sous les plafonds.
        </Text>
        {carteService('claude', 'Claude (Anthropic)', <>Clé à créer sur console.anthropic.com. Tarifs pré-remplis d’après la liste officielle du 03/11/2026 : vérifiez-les.</>)}
        {carteService('chatgpt', 'ChatGPT (OpenAI)', <>Clé à créer sur platform.openai.com. Recopiez le nom du modèle et ses prix depuis la page des tarifs d’OpenAI.</>)}
        <Divider label="Salle de réunion (les IA travaillent ensemble)" labelPosition="left" />
        <Card withBorder radius="md" padding="md" data-section="reunion">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600}>Réunion des IA</Text>
              <Switch label="Activer" checked={r.reunion.active} onChange={(ev) => setR({ ...r, reunion: { ...r.reunion, active: ev.currentTarget.checked } })} />
            </Group>
            <Text size="sm" c="dimmed">
              Chaque IA propose une fois ; la plus forte dans le domaine de la demande vérifie toutes les propositions en dernier et rend la version finale.
              Plus d’IA, c’est plus d’attente : limitez le nombre de participants.
            </Text>
            <Group grow align="flex-start">
              <NumberInput
                label="IA qui proposent (en plus du vérificateur)"
                min={1}
                max={7}
                value={r.reunion.maxParticipants}
                onChange={(v) => setR({ ...r, reunion: { ...r.reunion, maxParticipants: Number(v) || 1 } })}
              />
              <Switch
                mt={28}
                label="Une IA payante peut être le vérificateur final"
                checked={r.reunion.payantVerificateur}
                onChange={(ev) => setR({ ...r, reunion: { ...r.reunion, payantVerificateur: ev.currentTarget.checked } })}
              />
            </Group>
            <Text size="xs" c="dimmed">
              Les IA payantes ne participent que si « Passer le relais seul » est choisi plus haut, et toujours dans les plafonds.
            </Text>
            <Table.ScrollContainer minWidth={420}>
              <Table withTableBorder fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>IA</Table.Th>
                    {Object.entries(e.domaines).map(([d, lib]) => (
                      <Table.Th key={d}>{lib.split(' (')[0]}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {Object.entries(e.libelles).map(([cle, nom]) => (
                    <Table.Tr key={cle}>
                      <Table.Td>{nom}</Table.Td>
                      {Object.keys(e.domaines).map((d) => {
                        const n = e.notes[d]?.[cle];
                        return (
                          <Table.Td key={d}>
                            {n?.note ?? '—'}
                            {n && (n.acceptes || n.refuses) ? (
                              <Text span size="xs" c="dimmed">
                                {' '}
                                ({n.acceptes ?? 0} acceptée(s), {n.refuses ?? 0} refusée(s))
                              </Text>
                            ) : null}
                          </Table.Td>
                        );
                      })}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Text size="xs" c="dimmed">
              Notes sur 100 : banc d’essai, puis corrigées par vos décisions (à partir de 5). « — » = pas encore mesuré.
            </Text>
            <Group grow align="flex-start">
              {Object.entries(e.domaines).map(([d, lib]) => (
                <Select
                  key={d}
                  label={`Vérificateur final — ${lib.split(' (')[0]}`}
                  data={[{ value: 'auto', label: 'Automatique (meilleure note)' }, ...Object.entries(e.libelles).map(([value, label]) => ({ value, label }))]}
                  value={r.reunion.verificateurs[d] ?? 'auto'}
                  allowDeselect={false}
                  onChange={(v) => setR({ ...r, reunion: { ...r.reunion, verificateurs: { ...r.reunion.verificateurs, [d]: v === 'auto' ? undefined : v ?? undefined } } })}
                />
              ))}
            </Group>
          </Stack>
        </Card>
        <Group>
          <Button loading={busy} onClick={() => void enregistrer()}>
            Enregistrer les réglages de l’assistant
          </Button>
        </Group>
        <Divider label="Banc d’essai (mesurer chaque IA)" labelPosition="left" />
        <BancEssai />
      </Stack>
    </Card>
  );
}
