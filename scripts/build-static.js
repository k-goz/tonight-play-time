const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const publicFiles = [
  'index.html', 'style.css', 'time-utils.js', 'app.js', 'api-service.js',
  'service-worker.js', 'manifest.json'
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const filename of publicFiles) {
  fs.copyFileSync(path.join(root, filename), path.join(output, filename));
}
fs.cpSync(path.join(root, 'icons'), path.join(output, 'icons'), { recursive: true });

console.log(`Prepared ${publicFiles.length} public files and icons in ${output}`);
