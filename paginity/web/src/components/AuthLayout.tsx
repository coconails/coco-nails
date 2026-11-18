import type { ReactNode } from 'react';
import { Box, Center, Paper, Stack, Text } from '@mantine/core';
import { Logo } from './Logo';

export function AuthLayout({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <Center mih="100vh" p="md" style={{ background: 'radial-gradient(ellipse at top, #13213a 0%, #0b1626 60%)' }}>
      <Stack w="100%" maw={440} gap="lg">
        <Box ta="center" data-mantine-color-scheme="dark" style={{ background: 'transparent' }}>
          <Logo taille={64} tailleTexte={38} />
          <Text c="#c9ced6" size="sm" mt={8} style={{ letterSpacing: '0.08em' }}>
            Créer · Gérer · Publier · Suivre
          </Text>
          <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            PAGINITY — Créer, gérer, publier, suivre
          </span>
        </Box>
        <Paper p="xl" radius="lg" withBorder shadow="xl">
          <Text component="h1" fz={22} fw={700} mb="md" mt={0}>
            {titre}
          </Text>
          {children}
        </Paper>
      </Stack>
    </Center>
  );
}
