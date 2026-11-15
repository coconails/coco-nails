import { useState } from 'react';
import { Alert, Card, Image, Modal, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFileTypePdf, IconUpload } from '@tabler/icons-react';
import { api, errorMessage, get } from '../api';
import { taille } from '../format';

export interface MediaItem {
  chemin: string;
  url: string | null;
  taille: number;
  type: 'image' | 'document';
}

export function useMedias(siteId: string) {
  return useQuery({ queryKey: ['medias', siteId], queryFn: () => get<MediaItem[]>(`/api/sites/${siteId}/medias`) });
}

export async function uploadMedia(siteId: string, file: File, remplacer?: string) {
  const fd = new FormData();
  fd.append('fichier', file);
  return api<{ chemin: string; url: string; taille: number }>('POST', `/api/sites/${siteId}/medias${remplacer ? `?remplacer=${encodeURIComponent(remplacer)}` : ''}`, fd);
}

export const ACCEPTED = [...IMAGE_MIME_TYPE, 'application/pdf'];

/** Choix d'une image dans la médiathèque, ou envoi d'une nouvelle (depuis l'ordinateur ou l'appareil photo du téléphone). */
export function MediaPicker({ opened, onClose, onPick, siteId, images }: { opened: boolean; onClose: () => void; onPick: (url: string) => void; siteId: string; images: boolean }) {
  const qc = useQueryClient();
  const q = useMedias(siteId);
  const [filtre, setFiltre] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const list = (q.data ?? []).filter((m) => m.url && (!images || m.type === 'image') && m.chemin.toLowerCase().includes(filtre.toLowerCase()));

  const onDrop = async (files: File[]) => {
    setBusy(true);
    setErreur(null);
    try {
      const r = await uploadMedia(siteId, files[0]);
      await qc.invalidateQueries({ queryKey: ['medias', siteId] });
      onPick(r.url);
    } catch (e) {
      setErreur(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Choisir un fichier" size="xl" fullScreen={typeof window !== 'undefined' && window.innerWidth < 600}>
      <Stack>
        <Dropzone onDrop={onDrop} loading={busy} maxFiles={1} accept={images ? IMAGE_MIME_TYPE : ACCEPTED}>
          <Stack align="center" gap={4} py="md" style={{ pointerEvents: 'none' }}>
            <IconUpload size={30} />
            <Text size="sm">Envoyer une nouvelle image (glisser-déposer ou toucher)</Text>
            <Text size="xs" c="dimmed">
              Elle sera redimensionnée et compressée automatiquement. Les informations de localisation sont supprimées.
            </Text>
          </Stack>
        </Dropzone>
        {erreur && <Alert color="red">{erreur}</Alert>}
        <TextInput placeholder="Rechercher…" value={filtre} onChange={(e) => setFiltre(e.currentTarget.value)} />
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {list.map((m) => (
            <Card key={m.chemin} withBorder padding={6} component="button" onClick={() => onPick(m.url!)} style={{ cursor: 'pointer', textAlign: 'left' }}>
              {m.type === 'image' ? (
                <Image src={`/api/sites/${siteId}/brut?chemin=${encodeURIComponent(m.chemin)}`} className="pg-vignette" alt="" loading="lazy" />
              ) : (
                <Stack className="pg-vignette" align="center" justify="center">
                  <IconFileTypePdf size={36} />
                </Stack>
              )}
              <Text size="xs" truncate mt={4}>
                {m.chemin.split('/').pop()}
              </Text>
              <Text size="xs" c="dimmed">
                {taille(m.taille)}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
        {q.data && list.length === 0 && <Text c="dimmed" size="sm">Aucun fichier.</Text>}
      </Stack>
    </Modal>
  );
}
