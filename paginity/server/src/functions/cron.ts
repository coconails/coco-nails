/**
 * Expressions « cron » à 5 champs (minute heure jour mois jour-de-la-semaine), évaluées en heure UTC,
 * exactement comme les tâches planifiées de Netlify. Raccourcis acceptés : @hourly, @daily, @weekly, @monthly, @yearly.
 */

const NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  source: string;
}

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  for (const part of field.toLowerCase().split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`pas invalide « ${part} »`);
    const val = (s: string) => {
      const n = names ? names.indexOf(s) : -1;
      const v = n >= 0 ? n + (min === 1 ? 1 : 0) : Number(s);
      if (!Number.isInteger(v)) throw new Error(`valeur invalide « ${s} »`);
      return v;
    };
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = val(a);
      hi = val(b);
    } else {
      lo = val(range);
      hi = stepStr === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`valeur hors limites « ${part} »`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const src = NICKNAMES[expr.trim().toLowerCase()] ?? expr.trim();
  const f = src.split(/\s+/);
  if (f.length !== 5) throw new Error('il faut 5 champs (minute heure jour mois jour-de-semaine)');
  const dow = parseField(f[4], 0, 7, DAYS);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12, MONTHS),
    dow,
    domAny: f[2] === '*',
    dowAny: f[4] === '*',
    source: expr,
  };
}

export function cronMatches(c: Cron, t: number): boolean {
  const d = new Date(t);
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // Règle cron classique : si jour du mois ET jour de la semaine sont restreints, l'un OU l'autre suffit.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** Prochain créneau (à la minute) strictement après t. */
export function nextRun(c: Cron, t: number): number | null {
  let m = Math.floor(t / 60_000) * 60_000 + 60_000;
  const limit = t + 366 * 86_400_000;
  while (m <= limit) {
    const d = new Date(m);
    if (!c.month.has(d.getUTCMonth() + 1)) {
      m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    if (!c.hour.has(d.getUTCHours())) {
      m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (cronMatches(c, m)) return m;
    m += 60_000;
  }
  return null;
}

/** Créneaux dans l'intervalle ]from, to] (au plus `max`). */
export function slotsBetween(c: Cron, from: number, to: number, max = 500): number[] {
  const out: number[] = [];
  let t = from;
  for (;;) {
    const n = nextRun(c, t);
    if (n === null || n > to || out.length >= max) break;
    out.push(n);
    t = n;
  }
  return out;
}

/** Description en français, avec l'heure de Paris correspondante (qui change entre été et hiver). */
export function describeCron(expr: string, at = Date.now()): string {
  try {
    const c = parseCron(expr);
    const n = nextRun(c, at);
    const paris = n ? new Date(n).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' }) : 'jamais';
    return `« ${expr} » (heure UTC) — prochaine exécution : ${paris} (heure de Paris)`;
  } catch (e) {
    return `« ${expr} » : expression invalide (${(e as Error).message})`;
  }
}
