/**
 * Heure « humaine » de PAGINITY : celle de Paris par défaut (réglable avec PAGINITY_FUSEAU), quel que soit le réglage
 * du système. Sert à l'heure de la sauvegarde nocturne et au découpage des journées (visites).
 */
export const fuseau = () => process.env.PAGINITY_FUSEAU || 'Europe/Paris';

function parties(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: fuseau(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { jour: `${p.year}-${p.month}-${p.day}`, heure: Number(p.hour) };
}
/** Date du jour (AAAA-MM-JJ) dans le fuseau de PAGINITY. */
export const jourLocal = (d: Date | number = new Date()) => parties(new Date(d)).jour;
/** Heure (0 à 23) dans le fuseau de PAGINITY. */
export const heureLocale = (d: Date | number = new Date()) => parties(new Date(d)).heure;
/** AAAA-MM-JJ décalé de n jours (calcul sur la date seule, sans souci de changement d'heure). */
export const decalerJour = (jour: string, n: number) => new Date(Date.parse(`${jour}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
