import { EventEmitter } from 'node:events';

/** Diffusion interne d'événements (activités, présence…) vers les navigateurs connectés. */
export interface PaginityEvent {
  type: 'activite' | 'presence' | 'site';
  siteId?: string | null;
  /** Utilisateurs autorisés à recevoir l'événement ; vide = tous ceux qui ont accès au site. */
  data: unknown;
}

export class Events extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000);
  }
  publish(e: PaginityEvent): void {
    this.emit('event', e);
  }
}
