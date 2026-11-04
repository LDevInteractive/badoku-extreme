// QR code as inline SVG, via vendor/qrcode.js.

import qrcode from '../vendor/qrcode.js';

/** Returns SVG markup for the text. Error correction M, dark modules black on transparent. */
export function qrSvg(text, label) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><path d="${path}" fill="#000"/></svg>`;
}
