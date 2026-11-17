import { useEffect, type ReactNode } from 'react';
import {
  ActionIcon, AppShell, Avatar, Badge, Burger, Divider, Group, Image, Indicator, Menu, NavLink, ScrollArea, Text, Tooltip, UnstyledButton, useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconActivity, IconBell, IconClipboardList, IconCode, IconDashboard, IconEye, IconFileText, IconHeartbeat, IconHistory, IconLogout, IconMoon, IconPhoto,
  IconPlus, IconRocket, IconSettings, IconSun, IconUser, IconUsers, IconWorld, IconMail, IconServerBolt, IconKey, IconAdjustments, IconRobot,
} from '@tabler/icons-react';
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { get, post } from '../api';
import { useEtat } from '../App';
import type { Activite, SiteDetail, SiteResume } from '../types';
import { StatusDot } from './Status';
import { PanneauAssistant, usePanneau } from './PanneauAssistant';

function useLiveActivities() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/activites/flux');
    es.addEventListener('activite', (ev) => {
      const j = JSON.parse((ev as MessageEvent).data) as Activite;
      qc.setQueryData(['activite', j.id], j);
      qc.invalidateQueries({ queryKey: ['activites'] });
      if (['reussie', 'echouee', 'interrompue'].includes(j.etat)) {
        qc.invalidateQueries({ queryKey: ['tableau'] });
        qc.invalidateQueries({ queryKey: ['sites'] });
        if (j.siteId) {
          for (const k of ['site', 'publications', 'modifications', 'historique']) qc.invalidateQueries({ queryKey: [k, j.siteId] });
        }
        notifications.show({
          color: j.etat === 'reussie' ? 'green' : 'red',
          title: j.etat === 'reussie' ? 'Terminé' : 'Échec',
          message: j.etat === 'reussie' ? j.libelle : `${j.libelle} — ${j.erreur ?? ''}`,
          autoClose: j.etat === 'reussie' ? 5000 : 12000,
        });
      }
    });
    return () => es.close();
  }, [qc]);
}

export function Shell({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure();
  const etat = useEtat();
  const user = etat.utilisateur!;
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  useLiveActivities();

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get<SiteResume[]>('/api/sites') });
  const activites = useQuery({ queryKey: ['activites'], queryFn: () => get<Activite[]>('/api/activites') });
  const enCours = (activites.data ?? []).filter((a) => a.etat === 'en_cours' || a.etat === 'en_attente').length;

  const m = matchPath('/sites/:id/*', location.pathname) ?? matchPath('/sites/:id', location.pathname);
  const siteId = m?.params.id && m.params.id !== 'nouveau' ? m.params.id : null;
  const site = useQuery({ queryKey: ['site', siteId], queryFn: () => get<SiteDetail>(`/api/sites/${siteId}`), enabled: !!siteId });

  useEffect(() => close(), [location.pathname, close]);
  const panneau = usePanneau();
  // Place réservée au panneau de l'assistant pour qu'il ne cache jamais le contenu.
  const reserve = panneau.mobile
    ? { paddingBottom: panneau.m.mobile.reduit ? 44 + 16 : `calc(${panneau.m.mobile.hauteurVh}dvh + 16px)` }
    : { paddingRight: (panneau.m.bureau.reduit ? 44 : panneau.m.bureau.largeur) + 16 };

  const logout = async () => {
    await post('/api/deconnexion');
    qc.clear();
    navigate('/connexion');
    window.location.reload();
  };

  const nav = (to: string, label: string, icon: ReactNode, exact = false) => (
    <NavLink
      key={to}
      component={Link}
      to={to}
      label={label}
      leftSection={icon}
      active={exact ? location.pathname === to : location.pathname === to || location.pathname.startsWith(`${to}/`)}
    />
  );

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 270, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Ouvrir le menu" />
            <UnstyledButton component={Link} to="/" aria-label="PAGINITY, tableau de bord">
              <Group gap={8} wrap="nowrap">
                <Image src="/symbole-paginity.png" h={34} w="auto" alt="" lightHidden />
                <Image src="/icone-192.png" h={34} w={34} radius="sm" alt="" darkHidden />
                <Text className="pg-logo-texte" fz={22} visibleFrom="xs">
                  PAGINITY
                </Text>
              </Group>
            </UnstyledButton>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Tooltip label={colorScheme === 'dark' ? 'Mode clair' : 'Mode sombre'}>
              <ActionIcon variant="subtle" size="lg" onClick={toggleColorScheme} aria-label="Changer de thème">
                {colorScheme === 'dark' ? <IconSun size={20} /> : <IconMoon size={20} />}
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Activités">
              <Indicator disabled={!enCours} label={enCours} size={16} color="or">
                <ActionIcon variant="subtle" size="lg" component={Link} to="/activites" aria-label={`Activités${enCours ? ` (${enCours} en cours)` : ''}`}>
                  <IconBell size={20} />
                </ActionIcon>
              </Indicator>
            </Tooltip>
            <Menu position="bottom-end" withArrow>
              <Menu.Target>
                <UnstyledButton aria-label="Mon compte">
                  <Avatar color="or" radius="xl" size={34}>
                    {user.nom.slice(0, 2).toUpperCase()}
                  </Avatar>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user.nom}</Menu.Label>
                <Menu.Item leftSection={<IconUser size={16} />} component={Link} to="/profil">
                  Mon profil et sécurité
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item leftSection={<IconLogout size={16} />} color="red" onClick={logout}>
                  Se déconnecter
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          {nav('/', 'Tableau de bord', <IconDashboard size={18} />, true)}
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt="md" mb={4} px="sm">
            Mes sites
          </Text>
          {(sites.data ?? []).map((s) => (
            <NavLink
              key={s.id}
              component={Link}
              to={`/sites/${s.id}`}
              label={s.nom}
              leftSection={<StatusDot etat={s.etat} />}
              rightSection={s.modificationsEnAttente ? <Badge size="xs" variant="light" color="or">{s.modificationsEnAttente}</Badge> : null}
              active={siteId === s.id && location.pathname === `/sites/${s.id}`}
              defaultOpened={siteId === s.id}
              opened={siteId === s.id ? true : undefined}
            >
              {siteId === s.id && site.data && (
                <>
                  {nav(`/sites/${s.id}/contenus`, 'Contenus', <IconFileText size={16} />)}
                  {nav(`/sites/${s.id}/medias`, 'Médias', <IconPhoto size={16} />)}
                  {nav(`/sites/${s.id}/assistant`, 'Assistant', <IconRobot size={16} />)}
                  {site.data.droits.code && nav(`/sites/${s.id}/fichiers`, 'Code', <IconCode size={16} />)}
                  {nav(`/sites/${s.id}/apercu`, 'Aperçu', <IconEye size={16} />)}
                  {site.data.droits.publier && nav(`/sites/${s.id}/publier`, 'Publier', <IconRocket size={16} />)}
                  {nav(`/sites/${s.id}/versions`, 'Versions', <IconHistory size={16} />)}
                  {site.data.droits.publier && nav(`/sites/${s.id}/formulaires`, 'Formulaires', <IconMail size={16} />)}
                  {nav(`/sites/${s.id}/fonctions`, 'Fonctions et tâches', <IconServerBolt size={16} />)}
                  {site.data.droits.reglages && nav(`/sites/${s.id}/secrets`, 'Secrets', <IconKey size={16} />)}
                  {site.data.droits.reglages && nav(`/sites/${s.id}/reglages`, 'Réglages', <IconSettings size={16} />)}
                </>
              )}
            </NavLink>
          ))}
          {user.proprietaire && nav('/sites/nouveau', 'Ajouter un site', <IconPlus size={18} />)}
          <Divider my="sm" />
          {nav('/activites', 'Activités', <IconActivity size={18} />)}
          {user.proprietaire && nav('/utilisateurs', 'Utilisateurs', <IconUsers size={18} />)}
          {user.proprietaire && nav('/sante', 'Santé du serveur', <IconHeartbeat size={18} />)}
          {user.proprietaire && nav('/journal', 'Journal', <IconClipboardList size={18} />)}
          {user.proprietaire && nav('/reglages', 'Réglages de la plateforme', <IconAdjustments size={18} />)}
        </AppShell.Section>
        <AppShell.Section>
          <Group gap={6} px="sm" py={6}>
            <IconWorld size={14} />
            <Text size="xs" c="dimmed">
              Créer · Gérer · Publier · Suivre
            </Text>
          </Group>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main style={reserve}>{children}</AppShell.Main>
      <PanneauAssistant etat={panneau} siteRoute={siteId} sites={sites.data ?? []} />
    </AppShell>
  );
}
