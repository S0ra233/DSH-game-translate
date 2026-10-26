export function fitRect(rect, viewport) {
  const width = Math.min(Math.max(320, rect.width), viewport.width);
  const height = Math.min(Math.max(300, rect.height), viewport.height);
  return { width, height, x: Math.max(0, Math.min(rect.x, viewport.width-width)), y: Math.max(0, Math.min(rect.y, viewport.height-height)) };
}
export function initialRect(viewport) {
  const width = Math.min(1120, Math.max(320, viewport.width-64));
  const height = Math.min(780, Math.max(300, viewport.height-80));
  return fitRect({ width, height, x: (viewport.width-width)/2, y: (viewport.height-height)/2 }, viewport);
}
export function maximizedRect(viewport) {
  const margin = viewport.width < 600 ? 8 : 16;
  return { x: margin, y: margin, width: viewport.width-2*margin, height: viewport.height-2*margin };
}
