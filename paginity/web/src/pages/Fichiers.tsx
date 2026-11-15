import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Grid, Group, Menu, Modal, NavLink, ScrollArea, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconDeviceFloppy, IconDots, IconFile, IconFilePlus, IconFolder, IconFolderPlus, IconGitCompare, IconHistory, IconPencil, IconTrash } from '@tabler/icons-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ApiError, del, errorMessage, get, post, put } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import { DiffView } from '../components/DiffView';
import { ErrorBox, Loading, Page } from '../components/Page';
import { dateHeure, taille } from '../format';
import { useSite } from './Site';

interface Entree {
  chemin: string;
  type: 'fichier' | 'dossier';
  taille: number;
  texte: boolean;
}

function Editeur({ siteId, chemin, onSaved }: { siteId: string; chemin: string; onSaved: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['fichier', siteId, chemin],
    queryFn: () => get<{ chemin: string; contenu: string; version: string; autres: string[] }>(`/api/sites/${siteId}/fichier?chemin=${encodeURIComponent(chemin)}`),
    refetchOnWindowFocus: false,
  });
  const [texte, setTexte] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflit, setConflit] = useState(false);
  const [erreurJson, setErreurJson] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ avant: string | null; apres: string | null } | null>(null);
  const [historique, setHistorique] = useState<{ id: string; le: number; auteur: string; message: string }[] | null>(null);
  const [autres, setAutres] = useState<string[]>([]);
  const dirty = texte !== null && q.data !== undefined && texte !== q.data.contenu;

  useEffect(() => {
    if (q.data) {
      setTexte(q.data.contenu);
      setVersion(q.data.version);
      setAutres(q.data.autres);
    }
  }, [q.data]);

  useEffect(() => {
    const t = setInterval(() => {
      post<{ autres: string[] }>(`/api/sites/${siteId}/presence`, { chemin })
        .then((r) => setAutres(r.autres))
        .catch(() => undefined);
    }, 20_000);
    return () => clearInterval(t);
  }, [siteId, chemin]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (texte === null) return null;

  const save = async (forcerJson = false) => {
    setBusy(true);
    setErreurJson(null);
    try {
      const r = await put<{ version: string }>(`/api/sites/${siteId}/fichier`, { chemin, contenu: texte, version, forcerJson });
      setVersion(r.version);
      qc.setQueryData(['fichier', siteId, chemin], { ...q.data!, contenu: texte, version: r.version });
      onSaved();
      notifications.show({ color: 'green', title: 'Enregistré dans le brouillon', message: chemin });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflit(true);
      else if (e instanceof ApiError && e.status === 422) setErreurJson(e.message);
      else notifications.show({ color: 'red', message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between" gap="xs">
        <Text fw={600} style={{ wordBreak: 'break-all' }}>
          {chemin} {dirty && <Badge color="or" size="sm">modifié</Badge>}
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconGitCompare size={14} />}
            onClick={async () => setDiff(await get(`/api/sites/${siteId}/diff?chemin=${encodeURIComponent(chemin)}`))}
          >
            Comparer avec la version en ligne
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconHistory size={14} />}
            onClick={async () => setHistorique(await get(`/api/sites/${siteId}/historique?chemin=${encodeURIComponent(chemin)}`))}
          >
            Historique
          </Button>
          <Button size="xs" onClick={() => void save()} loading={busy} disabled={!dirty} leftSection={<IconDeviceFloppy size={14} />}>
            Enregistrer
          </Button>
        </Group>
      </Group>
      {autres.length > 0 && <Alert color="blue">{autres.join(', ')} consulte(nt) aussi ce fichier.</Alert>}
      {conflit && (
        <Alert color="orange" icon={<IconAlertTriangle />} title="Fichier modifié ailleurs">
          Une autre version a été enregistrée entre-temps (autre personne, autre onglet ou mode contenus). Rien n’a été écrasé. Copiez vos changements si besoin, puis rechargez.
          <Button mt="sm" size="xs" onClick={() => { setConflit(false); void q.refetch(); }}>
            Recharger la dernière version
          </Button>
        </Alert>
      )}
      {erreurJson && (
        <Alert color="red" title="Le fichier contient une erreur">
          {erreurJson}
          <Text size="sm" mt={4}>
            Un JSON invalide peut casser l’affichage du site. La publication sera refusée tant que l’erreur n’est pas corrigée.
          </Text>
          <Button mt="sm" size="xs" variant="light" color="red" onClick={() => void save(true)}>
            Enregistrer quand même dans le brouillon
          </Button>
        </Alert>
      )}
      <CodeEditor path={chemin} value={texte} onChange={setTexte} onSave={() => dirty && void save()} />
      <Text size="xs" c="dimmed">
        Astuce : Ctrl+S (ou Cmd+S sur Mac) enregistre. Les fichiers gérés par le mode contenus sont protégés contre l’écrasement mutuel.
      </Text>
      <Modal opened={!!diff} onClose={() => setDiff(null)} title={`Différences avec la version en ligne : ${chemin}`} size="xl">
        {diff && <DiffView avant={diff.avant} apres={diff.apres} />}
      </Modal>
      <Modal opened={!!historique} onClose={() => setHistorique(null)} title={`Historique : ${chemin}`} size="lg">
        <Stack gap="xs">
          {historique?.map((h) => (
            <Text size="sm" key={h.id}>
              <b>{dateHeure(h.le)}</b> — {h.auteur} : {h.message}
            </Text>
          ))}
        </Stack>
      </Modal>
    </Stack>
  );
}

export function FichiersPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const mobile = useMediaQuery('(max-width: 62em)');
  const [params, setParams] = useSearchParams();
  const chemin = params.get('chemin');
  const q = useQuery({ queryKey: ['fichiers', id], queryFn: () => get<Entree[]>(`/api/sites/${id}/fichiers`) });
  const [creer, setCreer] = useState<null | 'fichier' | 'dossier'>(null);
  const [nouveauNom, setNouveauNom] = useState('');
  const [renommer, setRenommer] = useState<string | null>(null);
  const textFiles = useMemo(() => (q.data ?? []).filter((f) => f.type === 'fichier'), [q.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['fichiers', id] });
    void qc.invalidateQueries({ queryKey: ['site', id] });
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifications.show({ color: 'green', message: ok });
      refresh();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const tree = (
    <ScrollArea h={mobile ? undefined : 'min(70vh, 720px)'}>
      {(q.data ?? []).map((f) => {
        const depth = f.chemin.split('/').length - 1;
        return (
          <Group key={f.chemin} gap={0} wrap="nowrap" pl={depth * 12}>
            <NavLink
              label={f.chemin.split('/').pop()}
              leftSection={f.type === 'dossier' ? <IconFolder size={15} /> : <IconFile size={15} />}
              active={f.chemin === chemin}
              disabled={f.type === 'fichier' && !f.texte}
              onClick={() => f.type === 'fichier' && f.texte && setParams({ chemin: f.chemin })}
              description={f.type === 'fichier' && !f.texte ? `${taille(f.taille)} · médiathèque` : undefined}
              py={4}
              style={{ flex: 1 }}
            />
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon variant="subtle" size="sm" aria-label={`Actions pour ${f.chemin}`}>
                  <IconDots size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => { setRenommer(f.chemin); setNouveauNom(f.chemin); }}>
                  Renommer / déplacer
                </Menu.Item>
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => window.confirm(`Supprimer ${f.chemin} du brouillon ?`) && void act(() => del(`/api/sites/${id}/fichier?chemin=${encodeURIComponent(f.chemin)}`), 'Supprimé du brouillon.')}
                >
                  Supprimer
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        );
      })}
    </ScrollArea>
  );

  return (
    <Page
      titre="Code"
      sousTitre="Fichiers HTML, CSS, JavaScript et JSON du site. Chaque enregistrement va dans le brouillon et dans l’historique."
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Code' }]}
      largeur={1400}
      actions={
        <>
          <Tooltip label="Nouveau fichier">
            <ActionIcon variant="light" size="lg" onClick={() => { setCreer('fichier'); setNouveauNom(chemin ? chemin.replace(/[^/]+$/, '') : 'public/'); }} aria-label="Nouveau fichier">
              <IconFilePlus size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Nouveau dossier">
            <ActionIcon variant="light" size="lg" onClick={() => { setCreer('dossier'); setNouveauNom('public/'); }} aria-label="Nouveau dossier">
              <IconFolderPlus size={18} />
            </ActionIcon>
          </Tooltip>
        </>
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <Grid gap="md">
          <Grid.Col span={{ base: 12, md: 3 }}>
            {mobile ? (
              <Select
                label="Fichier"
                searchable
                data={textFiles.filter((f) => f.texte).map((f) => f.chemin)}
                value={chemin}
                onChange={(v) => v && setParams({ chemin: v })}
              />
            ) : (
              <Card withBorder padding={4}>
                {tree}
              </Card>
            )}
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 9 }}>
            {chemin ? <Editeur key={chemin} siteId={id!} chemin={chemin} onSaved={refresh} /> : <Text c="dimmed">Choisissez un fichier à modifier.</Text>}
          </Grid.Col>
        </Grid>
      )}
      <Modal opened={!!creer} onClose={() => setCreer(null)} title={creer === 'dossier' ? 'Nouveau dossier' : 'Nouveau fichier'}>
        <Stack>
          <TextInput label="Chemin complet" description="Par exemple public/mentions-legales.html" value={nouveauNom} onChange={(e) => setNouveauNom(e.currentTarget.value)} data-autofocus />
          <Button
            onClick={() =>
              void act(async () => {
                await post(`/api/sites/${id}/fichiers/nouveau`, { chemin: nouveauNom, dossier: creer === 'dossier' });
                setCreer(null);
                if (creer === 'fichier') setParams({ chemin: nouveauNom });
              }, 'Créé dans le brouillon.')
            }
          >
            Créer
          </Button>
        </Stack>
      </Modal>
      <Modal opened={!!renommer} onClose={() => setRenommer(null)} title="Renommer ou déplacer">
        <Stack>
          <TextInput label="Nouveau chemin" value={nouveauNom} onChange={(e) => setNouveauNom(e.currentTarget.value)} data-autofocus />
          <Text size="xs" c="dimmed">
            Attention : les pages qui utilisent l’ancien nom devront être mises à jour.
          </Text>
          <Button
            onClick={() =>
              void act(async () => {
                await post(`/api/sites/${id}/fichiers/renommer`, { de: renommer, vers: nouveauNom });
                setRenommer(null);
              }, 'Renommé dans le brouillon.')
            }
          >
            Renommer
          </Button>
        </Stack>
      </Modal>
    </Page>
  );
}
