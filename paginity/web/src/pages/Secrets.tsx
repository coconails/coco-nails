import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Modal, PasswordInput, Stack, Table, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconKey, IconLock, IconPlus } from '@tabler/icons-react';
import { useParams } from 'react-router-dom';
import { del, errorMessage, get, put } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure } from '../format';
import { useSite } from './Site';

interface Secret {
  nom: string;
  utiliseParLeCode: boolean;
  production: { le: number; par: string | null } | null;
  test: { le: number; par: string | null } | null;
}

type Env = 'production' | 'test';

export function SecretsPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['secrets', id], queryFn: () => get<Secret[]>(`/api/sites/${id}/secrets`) });
  const [edit, setEdit] = useState<{ nom: string; env: Env; nouveau?: boolean } | null>(null);
  const [valeur, setValeur] = useState('');
  const [multi, setMulti] = useState(false);

  const save = async () => {
    if (!edit) return;
    try {
      await put(`/api/sites/${id}/secrets/${edit.env}/${encodeURIComponent(edit.nom)}`, { valeur });
      notifications.show({ color: 'green', message: `Secret « ${edit.nom} » enregistré (${edit.env === 'production' ? 'production' : 'test'}). Les fonctions redémarrent.` });
      setEdit(null);
      setValeur('');
      void qc.invalidateQueries({ queryKey: ['secrets', id] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const remove = async (nom: string, env: Env) => {
    if (!window.confirm(`Supprimer le secret « ${nom} » (${env}) ? Les fonctions qui l’utilisent ne fonctionneront plus.`)) return;
    try {
      await del(`/api/sites/${id}/secrets/${env}/${encodeURIComponent(nom)}`);
      void qc.invalidateQueries({ queryKey: ['secrets', id] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const cell = (s: Secret, env: Env) => {
    const v = s[env];
    return (
      <Stack gap={4}>
        {v ? (
          <Badge color="green" variant="light" leftSection={<IconLock size={10} />}>
            Enregistré
          </Badge>
        ) : (
          <Badge color={env === 'production' && s.utiliseParLeCode ? 'orange' : 'gray'} variant="light">
            Manquant
          </Badge>
        )}
        {v && (
          <Text size="xs" c="dimmed">
            {dateHeure(v.le)}
            {v.par ? `, ${v.par}` : ''}
          </Text>
        )}
        <Group gap={4}>
          <Button size="compact-xs" variant="light" onClick={() => { setEdit({ nom: s.nom, env }); setValeur(''); setMulti(false); }}>
            {v ? 'Remplacer' : 'Définir'}
          </Button>
          {v && (
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(s.nom, env)}>
              Supprimer
            </Button>
          )}
        </Group>
      </Stack>
    );
  };

  return (
    <Page
      titre="Secrets"
      sousTitre="Clés d’API et mots de passe utilisés par les fonctions du site. Chiffrés, jamais réaffichés, jamais exportés."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Secrets' }]}
      actions={
        <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => { setEdit({ nom: '', env: 'production', nouveau: true }); setValeur(''); }}>
          Autre secret
        </Button>
      }
    >
      <Alert variant="light" icon={<IconKey />}>
        <Text size="sm">
          <b>Production</b> : utilisé par le site en ligne. <b>Test</b> : utilisé seulement dans l’aperçu, avec des comptes de test (agenda de test, SumUp en mode test…), pour essayer
          sans rien envoyer de réel. Saisissez les valeurs vous-même ici : ne les envoyez jamais par message.
        </Text>
      </Alert>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && q.data.length === 0 && <Text c="dimmed">Le code de ce site n’utilise aucune variable secrète.</Text>}
      {q.data && q.data.length > 0 && (
        <Card withBorder radius="lg" padding="sm">
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Nom</Table.Th>
                  <Table.Th>Production</Table.Th>
                  <Table.Th>Test (aperçu)</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((s) => (
                  <Table.Tr key={s.nom}>
                    <Table.Td>
                      <Text ff="monospace" size="sm" fw={600}>
                        {s.nom}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {s.utiliseParLeCode ? 'utilisé par le code' : 'non trouvé dans le code'}
                      </Text>
                    </Table.Td>
                    <Table.Td>{cell(s, 'production')}</Table.Td>
                    <Table.Td>{cell(s, 'test')}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.nouveau ? 'Nouveau secret' : `${edit?.nom} — ${edit?.env === 'production' ? 'production' : 'test'}`}>
        {edit && (
          <Stack>
            {edit.nouveau && (
              <>
                <TextInput label="Nom" description="Lettres, chiffres et « _ », ex. CLE_API" value={edit.nom} onChange={(e) => setEdit({ ...edit, nom: e.currentTarget.value.toUpperCase() })} />
                <Group>
                  <Button size="xs" variant={edit.env === 'production' ? 'filled' : 'default'} onClick={() => setEdit({ ...edit, env: 'production' })}>
                    Production
                  </Button>
                  <Button size="xs" variant={edit.env === 'test' ? 'filled' : 'default'} onClick={() => setEdit({ ...edit, env: 'test' })}>
                    Test
                  </Button>
                </Group>
              </>
            )}
            {multi ? (
              <Textarea label="Valeur (plusieurs lignes)" autosize minRows={4} maxRows={12} value={valeur} onChange={(e) => setValeur(e.currentTarget.value)} styles={{ input: { fontFamily: 'monospace' } }} />
            ) : (
              <PasswordInput label="Valeur" value={valeur} onChange={(e) => setValeur(e.currentTarget.value)} autoComplete="off" data-autofocus />
            )}
            <Button variant="subtle" size="xs" onClick={() => setMulti(!multi)} style={{ alignSelf: 'flex-start' }}>
              {multi ? 'Saisie masquée sur une ligne' : 'Valeur sur plusieurs lignes (clé privée…)'}
            </Button>
            <Text size="xs" c="dimmed">
              Une confirmation d’identité peut être demandée. La valeur ne sera plus jamais affichée.
            </Text>
            <Button onClick={save} disabled={!valeur || !edit.nom}>
              Enregistrer
            </Button>
          </Stack>
        )}
      </Modal>
    </Page>
  );
}
