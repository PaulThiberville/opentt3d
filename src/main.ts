import './style.css';

function requireCanvas(selector: string): HTMLCanvasElement {
  const element = document.querySelector<HTMLCanvasElement>(selector);
  if (element === null) throw new Error(`Canvas ${selector} introuvable`);
  return element;
}

function require2d(canvasElement: HTMLCanvasElement): CanvasRenderingContext2D {
  const renderingContext = canvasElement.getContext('2d');
  if (renderingContext === null) throw new Error('Canvas 2D indisponible');
  return renderingContext;
}

const canvas = requireCanvas('#scene');
const context = require2d(canvas);

// Placeholder de fondation : remplacé par le bootstrap Three.js (issue #15).
function resize(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  context.fillStyle = '#10151c';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#8fd3a8';
  context.font = '600 18px system-ui, sans-serif';
  context.fillText('OpenTT3D — fondations', 24, 40);
}

window.addEventListener('resize', resize);
resize();
