/**
 * Hôte du join tardif (#92).
 *
 * Ce contrôleur vit dans la partie démarrée, pas dans le salon : il écoute les
 * requêtes de découverte (`late-query`) sur le transport déjà utilisé par le
 * lockstep, puis pilote `NetSession.admitPeer` / `closeJoinWindow` et suit le
 * transfert via `pendingJoins()` et `onJoin`.
 *
 * Aucun DOM ici : le panneau réseau de la partie se contente d'afficher
 * `state()` et d'appeler `admit`, `deny`, `setAutoAdmit` ou `cancelAll`.
 */

import type { StartInfo, StartPayload } from '../net/lobby-types';
import type { JoinEvent, JoinWindowStatus, NetSession } from '../net/session';
import type { JoinRejectReason } from '../net/types';
import type { Transport } from '../net/transport';
import {
  LATE_JOIN_CHANNELS,
  LATE_JOIN_PROTOCOL_VERSION,
  isLateJoinQuery,
  joinRejectMessage,
  startPayloadFromInfo,
  type HostJoinOutcome,
  type HostJoinPending,
  type HostJoinView,
  type LateJoinOffer,
  type LateJoinOfferStatus,
  type LateJoinQuery,
} from './netjoin';

const PENDING_TTL_MS = 60_000;
const OUTCOME_NOTICE_MS = 12_000;

export interface LateJoinHostOptions {
  transport: Transport;
  /** `StartInfo` de l'hôte : configuration figée annoncée aux retardataires. */
  start: StartInfo;
  /** Admission automatique initiale (l'UI peut la basculer ensuite). */
  autoAdmit?: boolean;
  /** Horloge injectée, pour les tests. */
  now?: () => number;
}

interface PendingRequest {
  peerId: string;
  name: string;
  ready: boolean;
  requestedAt: number;
}

export class LateJoinHost {
  private transport: Transport;
  private payload: StartPayload;
  private session: NetSession | null = null;
  private autoAdmitFlag: boolean;
  private clock: () => number;
  private pending = new Map<string, PendingRequest>();
  private names = new Map<string, string>();
  private joined = new Map<number, string>();
  private outcome: HostJoinOutcome | null = null;
  private offs: (() => void)[] = [];
  private offJoin: (() => void) | null = null;
  private changeHandlers = new Set<() => void>();
  private disposed = false;

  constructor(options: LateJoinHostOptions) {
    this.transport = options.transport;
    this.payload = startPayloadFromInfo(options.start);
    this.autoAdmitFlag = Boolean(options.autoAdmit);
    this.clock = options.now ?? (() => Date.now());

    for (const player of this.payload.players) this.joined.set(player.player, player.name);

    this.offs.push(
      this.transport.on(LATE_JOIN_CHANNELS.query, (data, from) => {
        if (isLateJoinQuery(data)) this.handleQuery(data, from);
      }),
    );
    this.offs.push(
      this.transport.onPeerLeave((peerId) => {
        const known = this.pending.delete(peerId);
        this.names.delete(peerId);
        if (known) this.emit();
      }),
    );
  }

  get startPayload(): StartPayload {
    return this.payload;
  }

  /** Branche la session lockstep une fois le chargement de la partie fini. */
  attachSession(session: NetSession): void {
    if (this.disposed || this.session === session) return;
    this.offJoin?.();
    this.session = session;
    this.offJoin = session.onJoin((event) => this.handleJoinEvent(event));
    // Une demande peut déjà avoir été reçue pendant le chargement : elle est
    // restée `busy`, le client va redemander avec `ready: true`.
    this.emit();
  }

  get attached(): boolean {
    return this.session !== null;
  }

  get autoAdmit(): boolean {
    return this.autoAdmitFlag;
  }

  setAutoAdmit(enabled: boolean): void {
    if (this.disposed) return;
    const next = Boolean(enabled);
    if (next === this.autoAdmitFlag) return;
    this.autoAdmitFlag = next;
    if (next) {
      for (const request of [...this.pending.values()]) {
        if (request.ready) this.admit(request.peerId);
      }
    }
    this.emit();
  }

  /**
   * Autorise un pair déjà en attente. Retourne faux quand la session n'est pas
   * prête, que la partie est pleine ou que le pair est déjà installé.
   */
  admit(peerId: string): boolean {
    if (this.disposed) return false;
    const request = this.pending.get(peerId);
    if (!this.session) {
      if (request) this.respond(peerId, 'busy', { message: 'L’hôte prépare encore la partie.' });
      return false;
    }
    const admission = this.session.admitPeer(peerId);
    if (!admission) {
      this.pending.delete(peerId);
      this.respond(peerId, 'denied', {
        reason: 'full',
        message:
          'La partie est complète ou ce joueur n’est plus disponible : aucune place n’a pu être réservée.',
      });
      this.outcome = {
        ok: false,
        message: 'Place indisponible : la partie est peut-être complète.',
        at: this.clock(),
      };
      this.emit();
      return false;
    }
    this.pending.delete(peerId);
    this.respond(peerId, 'open', {
      message: `Place ${admission.player + 1} réservée : vous pouvez rejoindre la partie.`,
    });
    const name = request?.name ?? this.names.get(peerId);
    this.outcome = {
      ok: true,
      message: `Place réservée pour ${name ?? 'le retardataire'} — transfert en préparation…`,
      at: this.clock(),
    };
    this.emit();
    return true;
  }

  /** Refuse explicitement un pair et ferme sa fenêtre. */
  deny(peerId: string, reason: JoinRejectReason = 'closed'): void {
    if (this.disposed) return;
    this.pending.delete(peerId);
    this.names.delete(peerId);
    this.session?.closeJoinWindow(peerId);
    this.respond(peerId, 'denied', {
      reason,
      message:
        reason === 'full' ? 'La partie est complète.' : 'L’hôte a refusé votre demande de join.',
    });
    this.outcome = { ok: false, message: 'Demande refusée par l’hôte.', at: this.clock() };
    this.emit();
  }

  /** Ferme toutes les fenêtres (transfert compris) et repasse en manuel. */
  cancelAll(): void {
    if (this.disposed) return;
    for (const request of this.pending.values()) {
      this.respond(request.peerId, 'denied', {
        reason: 'closed',
        message: 'L’hôte a fermé la fenêtre de join.',
      });
    }
    this.pending.clear();
    this.autoAdmitFlag = false;
    this.session?.closeJoinWindow();
    this.outcome = {
      ok: false,
      message: 'Fenêtre de join fermée : la partie reste inaccessible aux retardataires.',
      at: this.clock(),
    };
    this.emit();
  }

  /** Progression à afficher ; `session` peut être absent pendant le chargement. */
  state(): HostJoinView {
    let windows: JoinWindowStatus[] = [];
    if (this.session) {
      try {
        windows = this.session.pendingJoins();
      } catch {
        windows = [];
      }
    }
    return {
      autoAdmit: this.autoAdmitFlag,
      pending: [...this.pending.values()]
        .map((request): HostJoinPending => ({
          peerId: request.peerId,
          name: request.name,
          ready: request.ready,
          requestedAt: request.requestedAt,
        }))
        .sort((a, b) => a.requestedAt - b.requestedAt),
      windows,
      outcome: this.outcome,
      players: [...this.joined.entries()]
        .map(([player, name]) => ({ player, name }))
        .sort((a, b) => a.player - b.player),
    };
  }

  /** À appeler par l'UI : purge les demandes trop anciennes et l'avis passé. */
  tick(now = this.clock()): void {
    if (this.disposed) return;
    let changed = false;
    for (const [peerId, request] of this.pending) {
      if (now - request.requestedAt > PENDING_TTL_MS) {
        this.pending.delete(peerId);
        this.respond(peerId, 'denied', {
          reason: 'timeout',
          message: 'La demande de join a expiré. Rouvrez-la depuis le menu.',
        });
        this.outcome = {
          ok: false,
          message: 'Demande de join expirée sans autorisation.',
          at: now,
        };
        changed = true;
      }
    }
    if (this.outcome && now - this.outcome.at > OUTCOME_NOTICE_MS) {
      this.outcome = null;
      changed = true;
    }
    if (changed) this.emit();
  }

  onChange(fn: () => void): () => void {
    if (typeof fn !== 'function') throw new TypeError('Un handler doit être une fonction');
    this.changeHandlers.add(fn);
    return () => {
      this.changeHandlers.delete(fn);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offJoin?.();
    this.offJoin = null;
    for (const off of this.offs.splice(0)) off();
    this.changeHandlers.clear();
    this.pending.clear();
    this.names.clear();
    this.joined.clear();
    this.session = null;
  }

  // ------------------------------------------------------------------ interne

  private emit(): void {
    if (this.disposed) return;
    for (const fn of [...this.changeHandlers]) {
      try {
        fn();
      } catch (error) {
        console.error('[ui:late-join-host] handler error', error);
      }
    }
  }

  private respond(
    peerId: string,
    status: LateJoinOfferStatus,
    extra: Partial<LateJoinOffer> = {},
  ): void {
    if (this.disposed) return;
    const offer: LateJoinOffer = {
      v: LATE_JOIN_PROTOCOL_VERSION,
      k: 'late-offer',
      status,
      ...(status === 'denied' ? {} : { payload: this.payload }),
      ...extra,
    };
    this.transport.send(LATE_JOIN_CHANNELS.offer, offer, peerId);
  }

  private handleQuery(query: LateJoinQuery, from: string): void {
    if (this.disposed || from === this.transport.selfId) return;
    if (query.engine !== undefined && query.engine !== this.payload.engineBuild) {
      this.respond(from, 'denied', {
        reason: 'version',
        message: joinRejectMessage(
          'version',
          'Version du moteur incompatible avec celle de la partie en cours.',
        ),
      });
      return;
    }

    const name = query.name?.trim() || `Joueur ${from.slice(0, 6)}`;
    this.names.set(from, name);
    if (!query.ready) {
      // Découverte : on annonce la configuration sans réserver de place, pour
      // que le client initialise son moteur avant de demander une admission.
      this.respond(from, this.session ? 'available' : 'busy', {
        message: this.session ? undefined : 'L’hôte prépare encore la partie.',
      });
      return;
    }

    if (!this.session) {
      this.respond(from, 'busy', { message: 'L’hôte prépare encore la partie.' });
      return;
    }

    if (this.autoAdmitFlag) {
      const request = this.pending.get(from);
      if (request) request.ready = true;
      // `admit` répond `open` ou `denied` puis notifie l'UI.
      this.admit(from);
      return;
    }

    let request = this.pending.get(from);
    if (!request) {
      request = { peerId: from, name, ready: true, requestedAt: this.clock() };
      this.pending.set(from, request);
    } else {
      request.name = name;
      request.ready = true;
    }
    this.respond(from, 'pending', {
      message: `${name} souhaite rejoindre : l’hôte doit autoriser la demande.`,
    });
    this.emit();
  }

  private handleJoinEvent(event: JoinEvent): void {
    if (this.disposed) return;
    const peerId = event.peerId;
    const name = peerId ? (this.pending.get(peerId)?.name ?? this.names.get(peerId)) : undefined;
    if (peerId) this.pending.delete(peerId);
    if (event.ok) {
      const player = event.player ?? -1;
      if (player >= 0) this.joined.set(player, name ?? `Joueur ${player + 1}`);
      if (peerId) this.names.delete(peerId);
      this.outcome = {
        ok: true,
        message: `${name ?? 'Le retardataire'} a rejoint la partie au tick ${event.tick ?? 0} (hash vérifié).`,
        at: this.clock(),
      };
    } else {
      this.outcome = {
        ok: false,
        message: joinRejectMessage(event.reason ?? 'closed', event.message),
        at: this.clock(),
      };
    }
    this.emit();
  }
}
