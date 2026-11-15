import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Grid, Group, List, NavLink, Select, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconDeviceFloppy, IconEye, IconFileText, IconRocket, IconUsers } from '@tabler/icons-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, errorMessage, get, post, put } from '../api';
import { ErrorBox, Loading, Page } from '../components/Page';
import { countErrors, FieldsEditor, type MediaContext } from '../components/FieldEditor';
import { FieldEditor } from '../components/FieldEditor';
import type { MediaConfig, Rubrique } from '../types';
import { useSite } from './Site';

interface ListeContenus {
  source: string;
  remarques: string[];
  media: MediaConfig | null;
  rubriques: { nom: string; libelle: string; description?: string; type: string; chemin: string }[];
}

interface Entree {
  entree: Rubrique;
  valeur: unknown;
  version: string | null;
  media: MediaConfig | null;
  dossierPublie: string;
  autres: string[];
}

function Editeur({ siteId, nom, peutPublier }: { siteId: string; nom: string; peutPublier: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contenu', siteId, nom], queryFn: () => get<Entree>(`/api/sites/${siteId}/contenus/${nom}`), refetchOnWindowFocus: false });
  const [valeur, setValeur] = useState<unknown>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflit, setConflit] = useState(false);
  const [erreurs, setErreurs] = useState<{ chemin: string; message: string }[]>([]);
  const [autres, setAutres] = useState<string[]>([]);

  useEffect(() => {
    if (q.data && !dirty) {
      setValeur(structuredClone(q.data.valeur));
      setVersion(q.data.version);
      setAutres(q.data.autres);
    }
  }, [q.data, dirty]);

  // Présence : signale aux autres personnes que cette rubrique est ouverte.
  useEffect(() => {
    if (!q.data) return;
    const tick = () =>
      post<{ autres: string[] }>(`/api/sites/${siteId}/presence`, { chemin: q.data!.entree.path })
        .then((r) => setAutres(r.autres))
        .catch(() => undefined);
    void tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, [q.data, siteId]);

  // Avertit avant de quitter la page avec des modifications non enregistrées.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const mctx: MediaContext = useMemo(() => ({ siteId, media: q.data?.media ?? null, dossierPublie: q.data?.dossierPublie ?? 'public' }), [siteId, q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data || valeur === null) return null;
  const entree = q.data.entree;
  const nbErreurs = entree.list ? 0 : countErrors(entree.fields, valeur);

  const save = async () => {
    setBusy(true);
    setErreurs([]);
    try {
      const r = await put<{ version: string; enregistre: boolean }>(`/api/sites/${siteId}/contenus/${nom}`, { valeur, version });
      setVersion(r.version);
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['contenu', siteId, nom] });
      await qc.invalidateQueries({ queryKey: ['site', siteId] });
      await qc.invalidateQueries({ queryKey: ['sites'] });
      notifications.show({ color: 'green', title: 'Brouillon enregistré', message: 'Rien n’est encore visible du public. Vérifiez l’aperçu, puis publiez.' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflit(true);
      else if (e instanceof ApiError && e.details?.champs) setErreurs(e.details.champs);
      else notifications.show({ color: 'red', title: 'Non enregistré', message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const listRoot = entree.list
    ? { name: 'elements', label: entree.label, type: 'object' as const, required: false, list: {}, fields: entree.fields }
    : null;

  return (
    <Stack>
      {entree.description && <Text c="dimmed">{entree.description}</Text>}
      {autres.length > 0 && (
        <Alert color="blue" icon={<IconUsers />} variant="light">
          {autres.join(', ')} {autres.length > 1 ? 'modifient' : 'modifie'} aussi cette rubrique en ce moment. Si vous enregistrez tous les deux, PAGINITY empêchera tout écrasement.
        </Alert>
      )}
      {conflit && (
        <Alert color="orange" icon={<IconAlertTriangle />} title="Cette rubrique a été modifiée ailleurs">
          <Text size="sm">Quelqu’un (ou vous, dans un autre onglet ou un autre mode) a enregistré une autre version entre-temps. Rien n’a été écrasé.</Text>
          <Button
            mt="sm"
            size="xs"
            onClick={() => {
              setConflit(false);
              setDirty(false);
              void q.refetch();
            }}
          >
            Recharger la version la plus récente (mes changements non enregistrés seront perdus)
          </Button>
        </Alert>
      )}
      {erreurs.length > 0 && (
        <Alert color="red" title="Certains champs sont à corriger">
          <List size="sm">
            {erreurs.map((e) => (
              <List.Item key={e.chemin + e.message}>{e.message}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {listRoot ? (
        <FieldEditor
          f={listRoot}
          value={valeur}
          onChange={(v) => {
            setValeur(v);
            setDirty(true);
          }}
          mctx={mctx}
        />
      ) : (
        <FieldsEditor
          fields={entree.fields}
          value={valeur as Record<string, unknown>}
          onChange={(v) => {
            setValeur(v);
            setDirty(true);
          }}
          mctx={mctx}
        />
      )}
      <div className="pg-barre-enregistrer">
        <Group justify="space-between" gap="xs">
          <Text size="sm" c={dirty ? 'or' : 'dimmed'}>
            {dirty ? 'Modifications non enregistrées' : 'Tout est enregistré dans le brouillon'}
            {nbErreurs > 0 && ` · ${nbErreurs} champ(s) à corriger`}
          </Text>
          <Group gap="xs">
            <Button variant="default" component={Link} to={`/sites/${siteId}/apercu`} leftSection={<IconEye size={16} />} disabled={dirty}>
              Aperçu
            </Button>
            {peutPublier && (
              <Button variant="default" component={Link} to={`/sites/${siteId}/publier`} leftSection={<IconRocket size={16} />} disabled={dirty}>
                Publier
              </Button>
            )}
            <Button onClick={save} loading={busy} disabled={!dirty || nbErreurs > 0} leftSection={<IconDeviceFloppy size={16} />}>
              Enregistrer le brouillon
            </Button>
          </Group>
        </Group>
      </div>
    </Stack>
  );
}

export function ContenusPage() {
  const { id, rubrique } = useParams();
  const navigate = useNavigate();
  const site = useSite();
  const mobile = useMediaQuery('(max-width: 48em)');
  const q = useQuery({ queryKey: ['contenus', id], queryFn: () => get<ListeContenus>(`/api/sites/${id}/contenus`) });
  const current = rubrique ?? q.data?.rubriques.find((r) => r.type === 'file')?.nom;
  const libelle = q.data?.rubriques.find((r) => r.nom === current)?.libelle;

  return (
    <Page
      titre="Contenus"
      sousTitre={libelle}
      fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Contenus' }]}
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && q.data.remarques.length > 0 && (
        <Alert variant="light" color="blue">
          {q.data.remarques.map((r) => (
            <Text size="sm" key={r}>
              {r}
            </Text>
          ))}
        </Alert>
      )}
      {q.data && q.data.rubriques.length === 0 && (
        <Card withBorder>
          <Text>Ce site n’a pas encore de contenus modifiables par formulaire. Ajoutez un fichier .pages.yml, ou des fichiers JSON dans le dossier publié.</Text>
        </Card>
      )}
      {q.data && q.data.rubriques.length > 0 && (
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, md: 3 }}>
            {mobile ? (
              <Select
                label="Rubrique"
                data={q.data.rubriques.map((r) => ({ value: r.nom, label: r.libelle + (r.type === 'collection' ? ' (mode code)' : ''), disabled: r.type === 'collection' }))}
                value={current ?? null}
                onChange={(v) => v && navigate(`/sites/${id}/contenus/${v}`)}
                allowDeselect={false}
              />
            ) : (
              <Card withBorder padding={4} radius="md">
                {q.data.rubriques.map((r) => (
                  <NavLink
                    key={r.nom}
                    component={Link}
                    to={`/sites/${id}/contenus/${r.nom}`}
                    label={r.libelle}
                    leftSection={<IconFileText size={16} />}
                    active={r.nom === current}
                    disabled={r.type === 'collection'}
                    rightSection={r.type === 'collection' ? <Badge size="xs">code</Badge> : null}
                  />
                ))}
              </Card>
            )}
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 9 }}>{current && <Editeur key={current} siteId={id!} nom={current} peutPublier={!!site.data?.droits.publier} />}</Grid.Col>
        </Grid>
      )}
    </Page>
  );
}
