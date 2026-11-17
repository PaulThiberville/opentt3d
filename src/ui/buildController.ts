/**
 * Contrôleur du mode construction.
 *
 * Il transforme les événements souris du `WorldView` (survol, drag) en plan
 * d'aperçu via `buildRules` (routes/rails ou gares/dépôts/signaux), puis émet
 * une commande moteur quand le tracé est validé. Aucune règle de jeu n'est
 * dupliquée ici : la validation et le coût viennent du module partagé, le
 * moteur reste l'autorité finale.
 */

import type { MapSnapshot } from '../engine/protocol';
import {
  axisForDrag,
  cloneBuildSettings,
  createBuildSettings,
  nextDirection,
  nextRoadDirection,
  planAqueduct,
  planBridge,
  planBuild,
  planCanal,
  planConvertRail,
  planCrossing,
  planDepot,
  planLock,
  planRemoveSignal,
  planSignal,
  planStation,
  planTerraform,
  planTree,
  planTunnel,
  resolveTunnelSpan,
  structureDragTarget,
  type BuildPlan,
  type BuildPoint,
  type BuildSettings,
  type BuildTool,
} from '../game/buildRules';

export interface BuildCompany {
  id: number;
  money: number;
  bankrupt: boolean;
}

export interface BuildControllerOptions {
  getMap: () => MapSnapshot | null;
  getCompany: () => BuildCompany | null;
  /** Plan à afficher (fantôme 3D + texte d'aide). */
  onPreview: (plan: BuildPlan | null) => void;
  /** Tracé valide relâché par l'utilisateur. */
  onCommit: (plan: BuildPlan) => void;
  /** Message local : aperçu invalide, cible manquante… */
  onNotice: (kind: 'info' | 'warning' | 'error', text: string) => void;
}

function samePoint(a: BuildPoint | null, b: BuildPoint | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y;
}

export class BuildController {
  private options: BuildControllerOptions;
  private tool: BuildTool | null = null;
  private settings: BuildSettings = createBuildSettings();
  private start: BuildPoint | null = null;
  private hover: BuildPoint | null = null;
  private dragging = false;
  private plan: BuildPlan | null = null;
  private lastKey = '';

  constructor(options: BuildControllerOptions) {
    this.options = options;
  }

  get activeTool(): BuildTool | null {
    return this.tool;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  get currentPlan(): BuildPlan | null {
    return this.plan;
  }

  get buildSettings(): BuildSettings {
    return cloneBuildSettings(this.settings);
  }

  setTool(tool: BuildTool | null): void {
    this.tool = tool;
    this.start = null;
    this.dragging = false;
    this.plan = null;
    this.lastKey = '';
    this.hover = null;
    this.options.onPreview(null);
  }

  /** Met à jour les options de gare/dépôt/signal et rafraîchit le fantôme. */
  setSettings(settings: BuildSettings): void {
    this.settings = cloneBuildSettings(settings);
    this.lastKey = '';
    this.refresh();
  }

  /** Pivote l'infrastructure active (touche R ou bouton du HUD). */
  rotate(): boolean {
    if (this.tool === 'road') {
      this.settings.road.direction = nextRoadDirection(this.settings.road.direction);
    } else if (this.tool === 'station') {
      this.settings.station.direction = nextDirection(this.settings.station.direction);
    } else if (this.tool === 'depot') {
      this.settings.depot.direction = nextDirection(this.settings.depot.direction ?? 'se');
    } else if (this.tool === 'lock') {
      this.settings.lock.direction = nextDirection(this.settings.lock.direction ?? 'ne');
    } else {
      return false;
    }
    this.lastKey = '';
    this.refresh();
    return true;
  }

  /** Survol libre (hors drag) : aperçu d'une tuile. */
  handleHover(point: BuildPoint | null): void {
    if (!this.tool) return;
    // Pendant un drag, la destination vient exclusivement de `handleMove`.
    // Laisser le survol écrire `hover` ici ferait rater la mise à jour du plan
    // (même tuile) et figerait l'aperçu sur la culée de départ.
    if (this.dragging) return;
    if (samePoint(this.hover, point)) return;
    this.hover = point;
    if (point) this.refresh();
    else this.clearPreview();
  }

  /** Bouton gauche enfoncé : début d'un segment A→B. */
  handleBegin(point: BuildPoint | null): void {
    if (!this.tool || !point) return;
    this.start = point;
    this.hover = point;
    this.dragging = true;
    this.refresh();
  }

  /** Drag en cours : la destination suit la tuile survolée. */
  handleMove(point: BuildPoint | null): void {
    if (!this.dragging || !point) return;
    if (samePoint(this.hover, point)) return;
    this.hover = point;
    this.refresh();
  }

  /** Bouton gauche relâché : construit si le plan est valide. */
  handleEnd(point: BuildPoint | null): void {
    if (!this.tool) return;
    if (point) this.hover = point;
    if (this.dragging) {
      this.refresh();
      const plan = this.plan;
      if (plan?.valid) {
        this.options.onCommit(plan);
        // L'ouvrage est construit : on efface le fantôme au lieu de le
        // recolorer immédiatement en « voie déjà construite » sous le curseur.
        this.hover = null;
      } else if (plan?.reason) {
        this.options.onNotice('warning', `Construction impossible : ${plan.reason}`);
      } else {
        this.options.onNotice('warning', 'Construction impossible : aucune tuile ciblée.');
      }
    }
    this.dragging = false;
    this.start = null;
    // Revient à l'aperçu d'une tuile sous le curseur pour enchaîner les poses.
    if (this.hover) this.refresh();
    else this.clearPreview();
  }

  /** Clic droit : abandonne le drag, garde l'outil actif. */
  handleCancel(): void {
    this.dragging = false;
    this.start = null;
    if (this.hover) this.refresh();
    else this.clearPreview();
  }

  /** Quitte le mode construction (Échap, changement d'outil, pause). */
  exit(): void {
    this.setTool(null);
  }

  private clearPreview(): void {
    this.plan = null;
    this.lastKey = '';
    this.options.onPreview(null);
  }

  /**
   * Destination réelle d'un pont ou d'un tunnel.
   *
   * - un drag est projeté sur l'axe dominant pour garantir un ouvrage droit ;
   * - un tunnel cherche sa sortie au même niveau le long de l'axe, comme
   *   l'entrée OpenTTD, au lieu d'exiger que le curseur vise un portail ;
   * - un simple survol garde l'aperçu par défaut de trois tuiles.
   */
  private structureTarget(
    tool: 'bridge' | 'tunnel',
    from: BuildPoint,
    hover: BuildPoint | null,
    map: MapSnapshot,
    company: number | undefined,
  ): BuildPoint {
    const fallback = defaultStructureTarget(from, map);
    if (!this.dragging || !hover) {
      if (tool === 'bridge') return structureDragTarget(from, fallback, map);
      return (
        resolveTunnelSpan(map, from, fallback, {
          settings: this.settings.tunnel,
          ...(company !== undefined ? { company } : {}),
        })?.to ?? fallback
      );
    }

    const snapped = structureDragTarget(from, hover, map);
    if (tool === 'bridge') return snapped;
    if (snapped.x === from.x && snapped.y === from.y) return snapped;

    return (
      resolveTunnelSpan(map, from, snapped, {
        settings: this.settings.tunnel,
        ...(company !== undefined ? { company } : {}),
      })?.to ?? snapped
    );
  }

  private refresh(): void {
    const map = this.options.getMap();
    const hover = this.hover;
    if (!map || !hover) {
      this.clearPreview();
      return;
    }
    const from = this.dragging ? (this.start ?? hover) : hover;
    const to = this.dragging ? hover : undefined;
    const axis = to ? axisForDrag(from, to) : 'x';
    const key = [
      this.tool ?? '',
      from.x,
      from.y,
      to?.x ?? '',
      to?.y ?? '',
      axis,
      map.width,
      map.height,
      this.options.getCompany()?.money ?? '',
      JSON.stringify(this.settings),
    ].join(':');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const company = this.options.getCompany();
    const shared = {
      map,
      from,
      ...(company ? { company: company.id, budget: company.money } : {}),
    };
    const tool = this.tool;
    let plan: BuildPlan;
    if (tool === 'station') {
      plan = planStation({ ...shared, settings: this.settings.station });
    } else if (tool === 'depot') {
      plan = planDepot({ ...shared, settings: this.settings.depot });
    } else if (tool === 'signal') {
      plan = planSignal({
        ...shared,
        settings: this.settings.signal,
        ...(to ? { to } : {}),
        axis,
      });
    } else if (tool === 'unsignal') {
      plan = planRemoveSignal({
        ...shared,
        settings: this.settings.signal,
        ...(to ? { to } : {}),
        axis,
      });
    } else if (tool === 'convert') {
      plan = planConvertRail({
        ...shared,
        railType: this.settings.rail.type,
        ...(to ? { to } : {}),
        axis,
      });
    } else if (tool === 'terraform') {
      plan = planTerraform({
        ...shared,
        settings: this.settings.terraform,
        ...(to ? { to } : {}),
      });
    } else if (tool === 'tree') {
      plan = planTree({ ...shared, settings: this.settings.tree, ...(to ? { to } : {}) });
    } else if (tool === 'canal') {
      plan = planCanal({ ...shared, ...(to ? { to } : {}), axis });
    } else if (tool === 'lock') {
      plan = planLock({ ...shared, settings: this.settings.lock });
    } else if (tool === 'aqueduct') {
      plan = planAqueduct({ ...shared, to: to ?? from });
    } else if (tool === 'crossing') {
      plan = planCrossing({ ...shared });
    } else if (tool === 'bridge') {
      const target = this.structureTarget('bridge', from, to ?? null, map, company?.id);
      plan = planBridge({ ...shared, to: target, settings: this.settings.bridge });
    } else if (tool === 'tunnel') {
      const target = this.structureTarget('tunnel', from, to ?? null, map, company?.id);
      plan = planTunnel({ ...shared, to: target, settings: this.settings.tunnel });
    } else {
      plan = planBuild({
        ...shared,
        tool: tool ?? 'road',
        ...(tool === 'rail' ? { railType: this.settings.rail.type } : {}),
        ...(tool === 'road' ? { roadDirection: this.settings.road.direction } : {}),
        ...(to ? { to } : {}),
        axis,
      });
    }
    this.plan = plan;
    this.options.onPreview(plan);
  }
}

/** Cible par défaut d'un aperçu d'ouvrage au simple survol (3 tuiles à l'est). */
function defaultStructureTarget(
  from: BuildPoint,
  map: { width: number; height: number },
): BuildPoint {
  const offset = from.x + 3 < map.width ? 3 : -3;
  return { x: Math.max(0, Math.min(map.width - 1, from.x + offset)), y: from.y };
}
