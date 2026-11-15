import { Box, Text } from '@mantine/core';
import { diffLines } from 'diff';

/** Différences ligne par ligne : en vert ce qui est ajouté, en rouge barré ce qui est retiré. */
export function DiffView({ avant, apres }: { avant: string | null; apres: string | null }) {
  if (avant === null && apres === null) return <Text c="dimmed">Fichier vide.</Text>;
  if (avant === null) return <Text size="sm" c="dimmed">Nouveau fichier.</Text>;
  if (apres === null) return <Text size="sm" c="dimmed">Fichier supprimé.</Text>;
  const parts = diffLines(avant, apres);
  // On n'affiche que les zones modifiées, avec 3 lignes de contexte.
  const blocks: { type: 'ajout' | 'retrait' | 'contexte'; text: string }[] = [];
  parts.forEach((p, i) => {
    if (p.added) blocks.push({ type: 'ajout', text: p.value });
    else if (p.removed) blocks.push({ type: 'retrait', text: p.value });
    else {
      const lines = p.value.split('\n');
      if (lines.length > 8) {
        const head = i > 0 ? lines.slice(0, 3).join('\n') + '\n' : '';
        const tail = i < parts.length - 1 ? lines.slice(-4).join('\n') : '';
        blocks.push({ type: 'contexte', text: `${head}…\n${tail}` });
      } else blocks.push({ type: 'contexte', text: p.value });
    }
  });
  return (
    <Box className="pg-diff" p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, maxHeight: 480, overflow: 'auto' }}>
      {blocks.map((b, i) => (
        <span key={i} className={b.type === 'contexte' ? undefined : b.type}>
          {b.text}
        </span>
      ))}
    </Box>
  );
}
