/**
 * Entreprises par joueur avec le moteur OpenTTD réel (#99).
 *
 * Deux instances WASM indépendantes simulent la même partie avec trois
 * entreprises humaines (dont une réserve pour un retardataire) et une IA.
 * Chaque pair contrôle une entreprise différente, construit sur sa propre
 * zone, et l'hôte refuse une commande signée par une autre entreprise.
 *
 * La suite est ignorée si les artefacts de `public/engine/` sont absents.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EngineCommand, NewGameOptions, WorldSnapshot } from '../../src/engine/protocol';
import { TILE_FLAG, TILE_KIND_INDEX } from '../../src/engine/protocol';
import { WasmEngine } from '../../src/engine/WasmEngine';
import { createNetSession, type NetSession } from '../../src/net/session';
import { createMemoryBus, createTransport, type Transport } from '../../src/net/transport';
import { createEngineRunner, type EngineRunner } from '../../src/ui/networkRunner';
import { ARTIFACTS_AVAILABLE, createNodeEngineFactory } from '../fixtures/nodeEngine';
import { drive } from './helpers';

const suite = ARTIFACTS_AVAILABLE ? describe : describe.skip;

const COMPANIES = [
  { name: 'Alpha Transport', colour: 3 },
  { name: 'Beta Logistics', colour: 5 },
  { name: 'Réserve', colour: 7 },
];

const GAME_OPTIONS: NewGameOptions = {
  seed: 99_993,
  width: 128,
  height: 128,
  aiCompanies: 1,
  difficulty: 1,
  startYear: 1950,
  climate: 'temperate',
  companies: COMPANIES,
};

const engines: WasmEngine[] = [];
const sessions: NetSession[] = [];
const transports: Transport[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const transport of transports.splice(0)) transport.leave();
  for (const engine of engines.splice(0)) engine.dispose();
});

interface Booted {
  engine: WasmEngine;
  runner: EngineRunner;
}

async function bootEngine(options: NewGameOptions = GAME_OPTIONS): Promise<Booted> {
  const engine = new WasmEngine({ factory: await createNodeEngineFactory() });
  engines.push(engine);
  await engine.init({ moduleUrl: 'node://opentt3d-engine.js' });
  await engine.newGame(options);
  return { engine, runner: createEngineRunner(engine) };
}

function findFlatRoad(map: NonNullable<WorldSnapshot['map']>, minY = 2): { x: number; y: number } {
  for (let y = Math.max(2, minY); y < map.height - 2; y += 1) {
    for (let x = 2; x < map.width - 4; x += 1) {
      const base = map.heightMap[y * map.width + x];
      let ok = true;
      for (let dx = 0; dx < 3 && ok; dx += 1) {
        const index = y * map.width + x + dx;
        ok =
          map.kind[index] === TILE_KIND_INDEX.grass &&
          map.slope[index] === 0 &&
          ((map.flags[index] ?? 0) & TILE_FLAG.WATER) === 0 &&
          map.heightMap[index] === base;
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('aucune zone de 3 tuiles d’herbe plate trouvée');
}

function roadCommand(company: number, from: { x: number; y: number }): EngineCommand {
  return {
    type: 'build',
    tool: 'road',
    company,
    from,
    to: { x: from.x + 2, y: from.y },
    options: { axis: 'x' },
  };
}

function roadOwnerAt(snapshot: WorldSnapshot, from: { x: number; y: number }): number | undefined {
  const map = snapshot.map;
  if (!map) return undefined;
  return map.owner[from.y * map.width + from.x];
}

suite('entreprises par joueur avec WasmEngine réel (#99)', () => {
  it('crée les entreprises, marque isLocal par pair et garde un hash identique', async () => {
    const host = await bootEngine();
    const client = await bootEngine();
    expect(host.engine.hash()).toBe(client.engine.hash());

    const hostSnapshot = host.engine.snapshot();
    expect(hostSnapshot.companies.map((company) => company.id)).toEqual([0, 1, 2, 3]);
    expect(hostSnapshot.companies.slice(0, 3).map((company) => company.name)).toEqual([
      'Alpha Transport',
      'Beta Logistics',
      'Réserve',
    ]);
    expect(hostSnapshot.companies[0]).toMatchObject({ colour: 3, isLocal: true, isAI: false });
    expect(hostSnapshot.companies[1]).toMatchObject({ colour: 5, isLocal: false, isAI: false });
    expect(hostSnapshot.companies[3]?.isAI).toBe(true);

    // Chaque module choisit son entreprise : seule la marque isLocal change.
    expect(client.engine.setLocalCompany(1)).toBe(true);
    const clientLocal = client.engine.snapshot();
    expect(clientLocal.companies.find((company) => company.isLocal)?.id).toBe(1);
    expect(clientLocal.companies.find((company) => company.id === 0)?.isLocal).toBe(false);
    expect(client.engine.hash()).toBe(host.engine.hash());
    expect(clientLocal.meta.hash).toBe(hostSnapshot.meta.hash);

    // Une entreprise inexistante ou IA est refusée explicitement.
    expect(client.engine.setLocalCompany(9)).toBe(false);
    expect(client.engine.setLocalCompany(3)).toBe(false);
    expect(client.engine.status().warnings?.join(' ')).toMatch(/entreprise/i);
  }, 180_000);

  it('deux pairs construisent chacun sur leur entreprise ; la mauvaise entreprise est refusée', async () => {
    const host = await bootEngine();
    const client = await bootEngine();
    client.engine.setLocalCompany(1);

    const bus = createMemoryBus();
    const room = `wasm-companies-${Math.random().toString(36).slice(2, 10)}`;
    const hostTransport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
    const clientTransport = createTransport({ kind: 'memory', roomId: room, memory: { bus } });
    transports.push(hostTransport, clientTransport);
    const peers = { 0: hostTransport.selfId, 1: clientTransport.selfId };
    const companies = { 0: 0, 1: 1 };
    const hostSession = createNetSession({
      runner: host.runner,
      localPlayer: 0,
      transport: hostTransport,
      isHost: true,
      peers,
      inputDelay: 3,
      companies,
      companySeats: COMPANIES.length,
    });
    const clientSession = createNetSession({
      runner: client.runner,
      localPlayer: 1,
      transport: clientTransport,
      isHost: false,
      hostId: hostTransport.selfId,
      peers,
      inputDelay: 3,
      companies,
      companySeats: COMPANIES.length,
    });
    sessions.push(hostSession, clientSession);

    const startTick = host.runner.tick();
    const map = host.engine.snapshot().map;
    if (!map) throw new Error('carte absente');
    const hostRoad = findFlatRoad(map);
    const clientRoad = findFlatRoad(map, hostRoad.y + 6);
    const forbiddenRoad = findFlatRoad(map, clientRoad.y + 6);

    hostSession.issue(roadCommand(0, hostRoad));
    clientSession.issue(roadCommand(1, clientRoad));
    // Le client tente de construire avec l'entreprise de l'hôte : l'hôte doit
    // refuser sans interrompre le lockstep.
    clientSession.issue(roadCommand(0, forbiddenRoad));

    drive([hostSession, clientSession], startTick + 220);

    expect(hostSession.stats().desyncs).toBe(0);
    expect(clientSession.stats().desyncs).toBe(0);
    expect(clientSession.stats().rejected).toBeGreaterThan(0);
    expect(host.runner.hash()).toBe(client.runner.hash());

    const hostWorld = host.engine.snapshot();
    const clientWorld = client.engine.snapshot();
    expect(roadOwnerAt(hostWorld, hostRoad)).toBe(0);
    expect(roadOwnerAt(hostWorld, clientRoad)).toBe(1);
    expect(roadOwnerAt(clientWorld, hostRoad)).toBe(0);
    expect(roadOwnerAt(clientWorld, clientRoad)).toBe(1);
    expect(roadOwnerAt(hostWorld, forbiddenRoad)).not.toBe(0);
    expect(hostWorld.companies.find((company) => company.id === 0)?.isLocal).toBe(true);
    expect(clientWorld.companies.find((company) => company.id === 1)?.isLocal).toBe(true);
    expect(hostWorld.map?.owner).toEqual(clientWorld.map?.owner);
    console.info(
      `[wasm-companies] tick=${hostWorld.meta.tick} hash=${host.runner.hash()} ` +
        `owners=${hostWorld.companies.filter((company) => !company.isAI).length} humaines ` +
        `rejected=${clientSession.stats().rejected}`,
    );
  }, 180_000);

  it('conserve les entreprises et l’entreprise locale dans la sauvegarde', async () => {
    const host = await bootEngine();
    const client = await bootEngine();
    client.engine.setLocalCompany(1);
    const tick = host.runner.tick();
    const saved = host.runner.serialize();
    const savedHash = host.runner.hash();

    // Une instance neuve (autre graine) recharge l'état complet.
    const restored = await bootEngine({ ...GAME_OPTIONS, seed: 4242, width: 64, height: 64 });
    restored.runner.load(saved);
    expect(restored.runner.tick()).toBe(tick);
    expect(restored.runner.hash()).toBe(savedHash);

    const world = restored.engine.snapshot();
    expect(world.companies.slice(0, 3).map((company) => company.name)).toEqual([
      'Alpha Transport',
      'Beta Logistics',
      'Réserve',
    ]);
    expect(world.companies[3]?.isAI).toBe(true);
    // Les métadonnées ont conservé l'entreprise locale de l'hôte.
    expect(world.companies.find((company) => company.isLocal)?.id).toBe(0);
    // Le pair client peut ensuite reprendre la sienne.
    expect(restored.engine.setLocalCompany(1)).toBe(true);
    expect(restored.engine.snapshot().companies.find((company) => company.isLocal)?.id).toBe(1);
    expect(restored.engine.hash()).toBe(savedHash);

    // Même après rechargement, les deux moteurs poursuivent à l'identique.
    client.runner.step([]);
    restored.runner.step([]);
    expect(restored.runner.hash()).toBe(client.runner.hash());
  }, 180_000);
});
