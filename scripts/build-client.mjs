import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const compiled = await build({ entryPoints: ['src/client/index.jsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
  external: ['react', 'react-dom'], loader: { '.css': 'text' }, minify: true, jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"' } });
await mkdir('dist', { recursive: true });
const code = compiled.outputFiles[0].text;
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:'dsh-game-translate',factory(require){const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
console.log('DSH Client bundle written: dist/client.js');
await build({ entryPoints: ['src/client/webview.jsx'], bundle: true, outfile: 'dist/translation-ui.js', format: 'iife', platform: 'browser', target: 'es2022',
  loader: { '.css': 'text' }, minify: true, jsx: 'transform', define: { 'process.env.NODE_ENV': '"production"' } });
await writeFile('dist/translation-ui.html', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>DSH-game-translate</title><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style></head><body><div id="root"></div><script src="./translation-ui.js"></script></body></html>`);
