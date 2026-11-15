import type { ReactNode } from 'react';
import { Box, Center, Image, Paper, Stack, Text } from '@mantine/core';

export function AuthLayout({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <Center mih="100vh" p="md" style={{ background: 'radial-gradient(ellipse at top, #13213a 0%, #0b1626 60%)' }}>
      <Stack w="100%" maw={440} gap="lg">
        <Box ta="center">
          <Image src="/logo-paginity.webp" alt="PAGINITY — Créer, gérer, publier, suivre" maw={340} mx="auto" />
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
