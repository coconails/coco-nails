import { useRef, useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Group, Image, List, Modal, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { IconFileTypePdf, IconRefresh, IconTrash, IconUpload } from '@tabler/icons-react';
import { useParams } from 'react-router-dom';
import { ApiError, del, errorMessage } from '../api';
import { ACCEPTED, uploadMedia, useMedias, type MediaItem } from '../components/MediaPicker';
import { ErrorBox, Loading, Page } from '../components/Page';
import { taille } from '../format';
import { useSite } from './Site';

export function MediasPage() {
  const { id } = useParams();
  const site = useSite();
  const qc = useQueryClient();
  const q = useMedias(id!);
  const [busy, setBusy] = useState(false);
  const [filtre, setFiltre] = useState('');
  const [selection, setSelection] = useState<MediaItem | null>(null);
  const [usages, setUsages] = useState<string[] | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['medias', id] });
    void qc.invalidateQueries({ queryKey: ['site', id] });
  };

  const upload = async (files: File[]) => {
    setBusy(true);
    for (const f of files) {
      try {
        const r = await uploadMedia(id!, f);
        notifications.show({ color: 'green', title: 'Ajouté au brouillon', message: `${r.url} (${taille(r.taille)})` });
      } catch (e) {
        notifications.show({ color: 'red', title: f.name, message: errorMessage(e), autoClose: 10_000 });
      }
    }
    setBusy(false);
    refresh();
  };

  const remove = async (forcer: boolean) => {
    if (!selection) return;
    try {
      await del(`/api/sites/${id}/medias?chemin=${encodeURIComponent(selection.chemin)}${forcer ? '&forcer=1' : ''}`);
      notifications.show({ color: 'green', message: 'Fichier supprimé du brouillon.' });
      setSelection(null);
      setUsages(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setUsages(e.details?.utilisations ?? []);
      else notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const replace = async (file: File) => {
    if (!selection) return;
    try {
      await uploadMedia(id!, file, selection.chemin);
      notifications.show({ color: 'green', message: 'Fichier remplacé dans le brouillon (même nom, même adresse).' });
      setSelection(null);
      refresh();
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) });
    }
  };

  const list = (q.data ?? []).filter((m) => m.chemin.toLowerCase().includes(filtre.toLowerCase()));

  return (
    <Page titre="Médias" sousTitre="Photos et documents publics du site." fil={[{ label: 'Tableau de bord', to: '/' }, { label: site.data?.nom ?? '…', to: `/sites/${id}` }, { label: 'Médias' }]}>
      <Dropzone onDrop={upload} loading={busy} accept={ACCEPTED} maxSize={25 * 1024 * 1024}>
        <Stack align="center" gap={4} py="lg" style={{ pointerEvents: 'none' }}>
          <IconUpload size={36} />
          <Text>Déposez des images ou des PDF ici, ou touchez pour les choisir (appareil photo possible sur téléphone)</Text>
          <Text size="xs" c="dimmed">
            JPEG, PNG, WebP, GIF, AVIF, PDF. Les images sont réduites à 2 560 px, compressées, et leurs informations de localisation supprimées.
          </Text>
        </Stack>
      </Dropzone>
      <TextInput placeholder="Rechercher un fichier…" value={filtre} onChange={(e) => setFiltre(e.currentTarget.value)} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }}>
        {list.map((m) => (
          <Card key={m.chemin} withBorder padding={8} radius="md" component="button" onClick={() => setSelection(m)} style={{ textAlign: 'left', cursor: 'pointer' }}>
            {m.type === 'image' ? (
              <Image src={`/api/sites/${id}/brut?chemin=${encodeURIComponent(m.chemin)}`} className="pg-vignette" alt="" loading="lazy" />
            ) : (
              <Stack className="pg-vignette" align="center" justify="center">
                <IconFileTypePdf size={40} />
              </Stack>
            )}
            <Text size="xs" truncate mt={6} fw={500}>
              {m.chemin.split('/').pop()}
            </Text>
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {taille(m.taille)}
              </Text>
              {m.taille > 1024 * 1024 && <Badge size="xs" color="orange">lourd</Badge>}
            </Group>
          </Card>
        ))}
      </SimpleGrid>

      <Modal opened={!!selection} onClose={() => { setSelection(null); setUsages(null); }} title={selection?.chemin.split('/').pop()} size="lg">
        {selection && (
          <Stack>
            {selection.type === 'image' && <Image src={`/api/sites/${id}/brut?chemin=${encodeURIComponent(selection.chemin)}`} radius="md" alt="" mah={360} fit="contain" />}
            <Text size="sm">
              Adresse sur le site : <b>{selection.url ?? '(hors du dossier publié)'}</b>
            </Text>
            <Text size="sm" c="dimmed">
              Emplacement : {selection.chemin} · {taille(selection.taille)}
            </Text>
            {usages && (
              <Alert color="orange" title="Ce fichier est encore utilisé">
                <List size="sm">
                  {usages.map((u) => (
                    <List.Item key={u}>{u}</List.Item>
                  ))}
                </List>
                <Text size="sm" mt="xs">
                  Le supprimer laissera une image manquante à ces endroits.
                </Text>
                <Button color="red" size="xs" mt="sm" onClick={() => void remove(true)}>
                  Supprimer quand même
                </Button>
              </Alert>
            )}
            <Group>
              <input ref={replaceInput} type="file" hidden accept={ACCEPTED.join(',')} onChange={(e) => e.currentTarget.files?.[0] && void replace(e.currentTarget.files[0])} />
              <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={() => replaceInput.current?.click()}>
                Remplacer
              </Button>
              {site.data?.droits.publier && (
                <Button variant="light" color="red" leftSection={<IconTrash size={16} />} onClick={() => void remove(false)}>
                  Supprimer
                </Button>
              )}
              {selection.url && (
                <Anchor href={`${site.data?.urls.test}${selection.url}`} target="_blank" rel="noopener" size="sm">
                  Version en ligne
                </Anchor>
              )}
            </Group>
          </Stack>
        )}
      </Modal>
    </Page>
  );
}
