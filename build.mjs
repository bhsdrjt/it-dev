import { build } from 'esbuild';
await build({ entryPoints: ['web/App.tsx'], bundle: true, outfile: 'public/app.js', minify: true, target: ['es2022'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
