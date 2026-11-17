import { useState } from 'react';
import { Alert, Badge, Button, Card, CopyButton, Group, List, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconBrandGoogle, IconUpload } from '@tabler/icons-react';
import { del, errorMessage, get, post } from '../api';

interface Compte {
  connecte: boolean;
  email: string | null;
  connecteLe: number | null;
  sitesLies: { n: number };
  proprietes?: { siteUrl: string; permissionLevel: string }[];
}

/** Connexion Google Search Console en lecture seule, par un compte de service dédié (propriétaire). */
export function ReglagesSearchConsole() {
  const q = useQuery({ queryKey: ['gsc-compte'], queryFn: () => get<Compte>('/api/reglages/search-console') });
  const [proprietes, setProprietes] = useState<Compte['proprietes'] | null>(null);
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
  const envoyerFichier = (f: File | undefined) => {
    if (!f) return;
    void agir(
      'connecter',
      async () => {
        const r = await post<Compte>('/api/reglages/search-console', { cle: await f.text() });
        setProprietes(r.proprietes ?? []);
      },
      'Search Console connecté (lecture seule).',
    );
  };
  return (
    <Card withBorder radius="lg" padding="lg" data-section="search-console">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconBrandGoogle size={20} color="var(--mantine-color-or-5)" />
            <Title order={3} size="h4">
              Google Search Console (lecture seule)
            </Title>
          </Group>
          {e.connecte ? <Badge color="green">Connecté</Badge> : <Badge color="gray">Non connecté</Badge>}
        </Group>
        <Text size="sm" c="dimmed">
          Pour voir dans PAGINITY les recherches qui mènent à vos sites, les apparitions dans Google, les clics et la position moyenne. PAGINITY ne demande
          que la lecture des données Search Console : il ne peut rien modifier chez Google, ni lire vos e-mails, votre Drive ou votre agenda.
        </Text>
        {!e.connecte ? (
          <>
            <Alert variant="light" color="blue" title="Mise en place (une fois, environ 15 minutes)">
              <List size="sm" type="ordered" spacing={4}>
                <List.Item>Dans Google Cloud (console.cloud.google.com), dans votre projet : activez l’« API Google Search Console ».</List.Item>
                <List.Item>
                  Créez un <b>nouveau</b> compte de service réservé à PAGINITY (n’utilisez pas celui qui envoie déjà des e-mails ou lit l’agenda), sans aucun rôle.
                </List.Item>
                <List.Item>Dans ce compte de service : Clés › Ajouter une clé › JSON. Un fichier est téléchargé.</List.Item>
                <List.Item>Envoyez ce fichier ci-dessous : il est vérifié auprès de Google puis rangé chiffré dans le coffre.</List.Item>
                <List.Item>Dans Search Console : Paramètres › Utilisateurs et autorisations › Ajouter, avec l’adresse du compte de service, autorisation « Restreinte ».</List.Item>
              </List>
            </Alert>
            <Group>
              <Button component="label" leftSection={<IconUpload size={16} />} loading={busy === 'connecter'}>
                Envoyer le fichier de clé (JSON)
                <input type="file" accept="application/json,.json" hidden aria-label="Fichier de clé du compte de service" onChange={(ev) => envoyerFichier(ev.currentTarget.files?.[0])} />
              </Button>
            </Group>
          </>
        ) : (
          <>
            <Group gap="xs">
              <Text size="sm">
                Compte de service : <b style={{ wordBreak: 'break-all' }}>{e.email}</b>
              </Text>
              <CopyButton value={e.email ?? ''}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant="subtle" onClick={copy}>
                    {copied ? 'Copié' : 'Copier'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Text size="sm" c="dimmed">
              Ajoutez cette adresse dans chaque propriété Search Console à suivre (autorisation « Restreinte »), puis reliez chaque site dans sa page
              « Référencement ». {e.sitesLies.n} site(s) relié(s).
            </Text>
            <Group>
              <Button
                variant="default"
                loading={busy === 'proprietes'}
                onClick={() => void agir('proprietes', async () => setProprietes(await get('/api/reglages/search-console/proprietes')))}
              >
                Voir les propriétés accessibles
              </Button>
              <Button
                variant="subtle"
                color="red"
                loading={busy === 'deconnecter'}
                onClick={() =>
                  window.confirm('Déconnecter Search Console ? La clé, les liaisons et les chiffres relevés seront effacés de PAGINITY.') &&
                  void agir('deconnecter', () => del('/api/reglages/search-console'), 'Search Console déconnecté.')
                }
              >
                Déconnecter
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Pour couper l’accès aussi chez Google : supprimez la clé du compte de service dans Google Cloud et retirez l’adresse dans Search Console.
            </Text>
          </>
        )}
        {proprietes && (
          <Alert variant="light" color={proprietes.length ? 'green' : 'yellow'} title={`${proprietes.length} propriété(s) accessible(s)`}>
            {proprietes.length ? (
              <List size="sm">
                {proprietes.map((p) => (
                  <List.Item key={p.siteUrl}>{p.siteUrl}</List.Item>
                ))}
              </List>
            ) : (
              <Text size="sm">Aucune pour l’instant : ajoutez l’adresse du compte de service dans Search Console (cela peut prendre quelques minutes).</Text>
            )}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
