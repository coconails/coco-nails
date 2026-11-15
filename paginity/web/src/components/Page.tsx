import type { ReactNode } from 'react';
import { Alert, Anchor, Breadcrumbs, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api';

export function Page({
  titre,
  sousTitre,
  actions,
  fil,
  children,
  largeur = 1200,
}: {
  titre: ReactNode;
  sousTitre?: ReactNode;
  actions?: ReactNode;
  fil?: { label: string; to?: string }[];
  children: ReactNode;
  largeur?: number;
}) {
  return (
    <Stack maw={largeur} mx="auto" gap="lg" pb="xl">
      {fil && (
        <Breadcrumbs separator="›" fz="sm">
          {fil.map((f) =>
            f.to ? (
              <Anchor key={f.label} component={Link} to={f.to} size="sm">
                {f.label}
              </Anchor>
            ) : (
              <Text key={f.label} size="sm" c="dimmed">
                {f.label}
              </Text>
            ),
          )}
        </Breadcrumbs>
      )}
      <Group justify="space-between" align="flex-start" gap="sm">
        <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
          <Title order={1} fz={{ base: 24, sm: 30 }}>
            {titre}
          </Title>
          {sousTitre && <Text c="dimmed">{sousTitre}</Text>}
        </Stack>
        {actions && <Group gap="xs">{actions}</Group>}
      </Group>
      {children}
    </Stack>
  );
}

export function Loading() {
  return (
    <Center py="xl">
      <Loader />
    </Center>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <Alert color="red">{errorMessage(error)}</Alert>;
}
