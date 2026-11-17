import { useState } from 'react';
import { Card, Group, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconChartBar } from '@tabler/icons-react';
import { get } from '../api';

interface Visites {
  jours: number;
  total: number;
  parJour: { jour: string; vues: number }[];
  pages: { chemin: string; vues: number }[];
}
const court = (j: string) => new Date(`${j}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/** Pages vues du site en ligne, sans cookies ni données personnelles. */
export function VisitesSite({ siteId }: { siteId: string }) {
  const [jours, setJours] = useState('30');
  const [survol, setSurvol] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['visites', siteId, jours], queryFn: () => get<Visites>(`/api/sites/${siteId}/visites?jours=${jours}`) });
  const d = q.data;
  const max = Math.max(1, ...(d?.parJour.map((x) => x.vues) ?? [1]));
  const L = 600;
  const H = 120;
  const n = d?.parJour.length ?? 1;
  const pas = L / n;
  const jourSurvole = survol !== null && d ? d.parJour[survol] : null;
  return (
    <Card withBorder radius="lg" padding="lg" data-section="visites">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <IconChartBar size={20} color="var(--mantine-color-or-5)" />
            <Title order={2} fz="lg">
              Visites
            </Title>
          </Group>
          <SegmentedControl size="xs" value={jours} onChange={setJours} data={[{ value: '7', label: '7 jours' }, { value: '30', label: '30 jours' }, { value: '90', label: '90 jours' }]} />
        </Group>
        {d && (
          <>
            <Group gap="xs" align="baseline">
              <Text fz={32} fw={700} lh={1}>
                {d.total.toLocaleString('fr-FR')}
              </Text>
              <Text c="dimmed" size="sm">
                pages vues en {d.jours} jours
              </Text>
            </Group>
            <Text size="sm" c="dimmed" mih={20}>
              {jourSurvole ? `${court(jourSurvole.jour)} : ${jourSurvole.vues} page(s) vue(s)` : 'Survolez une barre pour le détail du jour.'}
            </Text>
            <svg viewBox={`0 0 ${L} ${H + 18}`} width="100%" role="img" aria-label={`Pages vues par jour sur ${d.jours} jours, ${d.total} au total`} onMouseLeave={() => setSurvol(null)}>
              <line x1={0} x2={L} y1={H} y2={H} stroke="var(--mantine-color-default-border)" strokeWidth={1} />
              {d.parJour.map((x, i) => {
                const h = x.vues ? Math.max(3, (x.vues / max) * (H - 6)) : 0;
                const w = Math.max(1, pas - 2);
                return (
                  <g key={x.jour} onMouseEnter={() => setSurvol(i)}>
                    <rect x={i * pas} y={0} width={pas} height={H} fill="transparent" />
                    {h > 0 && <path d={`M${i * pas + 1},${H} v${-(h - Math.min(4, w / 2))} q0,-${Math.min(4, w / 2)} ${Math.min(4, w / 2)},-${Math.min(4, w / 2)} h${w - 2 * Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, w / 2)} v${h - Math.min(4, w / 2)} z`} fill="var(--mantine-color-or-5)" opacity={survol === null || survol === i ? 1 : 0.45} />}
                    <title>{`${court(x.jour)} : ${x.vues}`}</title>
                  </g>
                );
              })}
              <text x={0} y={H + 14} fontSize={11} fill="var(--mantine-color-dimmed)">
                {court(d.parJour[0].jour)}
              </text>
              <text x={L} y={H + 14} fontSize={11} textAnchor="end" fill="var(--mantine-color-dimmed)">
                {court(d.parJour[n - 1].jour)}
              </text>
            </svg>
            {d.pages.length > 0 && (
              <Table fz="sm" withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Pages les plus vues</Table.Th>
                    <Table.Th ta="right">Vues</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {d.pages.slice(0, 5).map((p) => (
                    <Table.Tr key={p.chemin}>
                      <Table.Td style={{ wordBreak: 'break-all' }}>{p.chemin}</Table.Td>
                      <Table.Td ta="right">{p.vues.toLocaleString('fr-FR')}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            <Text size="xs" c="dimmed">
              Sans cookies ni donnée personnelle : PAGINITY compte seulement « telle page, tel jour ». Les robots ne sont pas comptés. Ce sont des pages
              vues, pas des personnes différentes.
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}
