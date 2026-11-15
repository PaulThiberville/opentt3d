/**
 * Graphiques légers en SVG natif.
 *
 * Les géométries sont pures et testables sous Node ; les fabriques DOM ne sont
 * appelées que par le HUD. Aucune librairie graphique : quelques chemins SVG
 * suffisent pour la trésorerie, les barres de catégories et les parts de
 * marché. Les valeurs non finies sont ignorées au lieu de produire un `NaN`
 * dans un attribut `d`.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SeriesPoint {
  index: number;
  x: number;
  y: number;
  value: number;
}

export interface SeriesGeometry {
  width: number;
  height: number;
  min: number;
  max: number;
  points: SeriesPoint[];
  path: string;
  area: string;
}

export interface SparklineOptions {
  width?: number;
  height?: number;
  padding?: number;
  className?: string;
  label: string;
  tone?: 'good' | 'bad' | 'neutral';
}

export interface BarOptions {
  className?: string;
  label: string;
  tone?: 'good' | 'bad' | 'neutral' | 'muted';
}

function finiteValues(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Projette une série de valeurs dans une boîte SVG. Une valeur constante est
 * centrée verticalement. Une série vide renvoie `null` : l'appelant affiche
 * alors son état vide plutôt qu'un graphique trompeur.
 */
export function seriesGeometry(
  values: readonly number[],
  width = 320,
  height = 84,
  padding = 4,
): SeriesGeometry | null {
  const safe = finiteValues(values);
  if (safe.length === 0) return null;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const pad = Math.max(0, Math.min(padding, w / 2, h / 2));
  let min = Math.min(...safe);
  let max = Math.max(...safe);
  if (min === max) {
    const margin = Math.max(1, Math.abs(min) * 0.05);
    min -= margin;
    max += margin;
  }
  const innerWidth = Math.max(1, w - pad * 2);
  const innerHeight = Math.max(1, h - pad * 2);
  const points: SeriesPoint[] = safe.map((value, index) => {
    const x = pad + (safe.length === 1 ? innerWidth / 2 : (index / (safe.length - 1)) * innerWidth);
    const y = pad + (1 - (value - min) / (max - min)) * innerHeight;
    return { index, x: round(x), y: round(y), value };
  });
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area =
    first && last ? `${path} L${last.x} ${round(h - pad)} L${first.x} ${round(h - pad)} Z` : '';
  return { width: w, height: h, min, max, points, path, area };
}

/** Pourcentage borné d'une valeur positive, pour les barres de comparaison. */
export function percentOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/**
 * Courbe compacte de la trésorerie. Le graphique est décoratif sur le plan
 * visuel mais porte un `aria-label` lisible par les lecteurs d'écran.
 */
export function createSparkline(values: readonly number[], options: SparklineOptions): SVGElement {
  const width = options.width ?? 320;
  const height = options.height ?? 84;
  const geometry = seriesGeometry(values, width, height, options.padding ?? 4);
  const svg = svgElement('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: `hud-chart${options.className ? ` ${options.className}` : ''}`,
    role: 'img',
    'aria-label': options.label,
    preserveAspectRatio: 'none',
    focusable: 'false',
  });
  if (!geometry) return svg;
  const tone = options.tone ?? 'neutral';
  if (geometry.area) {
    svg.append(
      svgElement('path', {
        d: geometry.area,
        class: `hud-chart-area is-${tone}`,
      }),
    );
  }
  svg.append(
    svgElement('path', {
      d: geometry.path,
      class: `hud-chart-line is-${tone}`,
      'vector-effect': 'non-scaling-stroke',
    }),
  );
  const last = geometry.points[geometry.points.length - 1];
  if (last) {
    svg.append(
      svgElement('circle', {
        cx: String(last.x),
        cy: String(last.y),
        r: '2.6',
        class: `hud-chart-dot is-${tone}`,
      }),
    );
  }
  return svg;
}

/** Barre horizontale SVG, utilisée pour les catégories et parts de marché. */
export function createBarMeter(value: number, max: number, options: BarOptions): SVGElement {
  const percent = percentOf(value, max);
  const svg = svgElement('svg', {
    viewBox: '0 0 100 6',
    class: `hud-meter${options.className ? ` ${options.className}` : ''}`,
    role: 'img',
    'aria-label': options.label,
    preserveAspectRatio: 'none',
    focusable: 'false',
  });
  svg.append(
    svgElement('rect', {
      x: '0',
      y: '0',
      width: '100',
      height: '6',
      rx: '3',
      class: 'hud-meter-track',
    }),
  );
  if (percent > 0) {
    svg.append(
      svgElement('rect', {
        x: '0',
        y: '0',
        width: String(round(percent)),
        height: '6',
        rx: '3',
        class: `hud-meter-fill is-${options.tone ?? 'neutral'}`,
      }),
    );
  }
  return svg;
}
