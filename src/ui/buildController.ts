/**
 * Contrôleur du mode construction.
 *
 * Il transforme les événements souris du `WorldView` (survol, drag) en plan
 * d'aperçu via `buildRules.planBuild`, puis émet une commande moteur quand le
 * tracé est validé. Aucune règle de jeu n'est dupliquée ici : la validation et
 * le coût viennent du module partagé, le moteur reste l'autorité finale.
 */

import type { MapSnapshot } from '../engine/protocol';
import {
  axisForDrag,
  planBuild,
  type BuildPlan,
  type BuildPoint,
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

  setTool(tool: BuildTool | null): void {
    this.tool = tool;
    this.start = null;
    this.dragging = false;
    this.plan = null;
    this.lastKey = '';
    this.hover = null;
    this.options.onPreview(null);
  }

  /** Survol libre (hors drag) : aperçu d'une tuile. */
  handleHover(point: BuildPoint | null): void {
    if (!this.tool) return;
    if (samePoint(this.hover, point)) return;
    this.hover = point;
    if (!this.dragging) {
      if (point) this.refresh();
      else this.clearPreview();
    }
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
        // Le tronçon est construit : on efface le fantôme au lieu de le
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
    // Revient à l'aperçu d'une tuile sous le curseur pour enchaîner les tronçons.
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
    ].join(':');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const company = this.options.getCompany();
    const plan = planBuild({
      map,
      tool: this.tool ?? 'road',
      from,
      ...(to ? { to } : {}),
      axis,
      ...(company ? { company: company.id, budget: company.money } : {}),
    });
    this.plan = plan;
    this.options.onPreview(plan);
  }
}
