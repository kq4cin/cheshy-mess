import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('../public/icons/icon.svg', import.meta.url));
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512]]) {
  const result = spawnSync('magick', ['svg:-', '-resize', `${size}x${size}`, `public/icons/${name}`], { input: source });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || 'ImageMagick is required to regenerate icons');
}
console.log('Icons generated');
