/**
 * Génère un bloc HTML autonome à coller dans un Code Block Squarespace.
 *
 * Le bloc contient l'iframe + le contenu *inline* de content-models.js et
 * squarespace-bridge.js : une fois collé, Squarespace ne charge plus aucun
 * script depuis ce dépôt.
 *
 *   npm run build:embed
 *   npm run build:embed -- --src=https://mon-org.github.io/ma-carte/
 *
 * Sortie : dist-embed/squarespace-snippet.html
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EMBED_DIR = join(ROOT, 'public', 'embed');
const OUT_DIR = join(ROOT, 'dist-embed');
const OUT_FILE = join(OUT_DIR, 'squarespace-snippet.html');

const DEFAULT_SRC = 'https://ORG.github.io/REPO/';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function gitStamp() {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    return sha + (dirty ? '+local' : '');
  } catch {
    return 'inconnu';
  }
}

/** Empêche un `</script>` dans le code JS de fermer la balise du snippet. */
function escapeForInlineScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

function readEmbed(name) {
  return escapeForInlineScript(
    readFileSync(join(EMBED_DIR, name), 'utf8').trimEnd()
  );
}

const src = arg('src', DEFAULT_SRC);
const height = arg('height', '600');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  .version;
const stamp = gitStamp();
const date = new Date().toISOString().slice(0, 10);

const snippet = `<!--
  Carte des régions administratives du Québec — bloc autonome.
  Généré le ${date} — version ${version} (commit ${stamp}).
  Ne pas modifier à la main : régénérer avec \`npm run build:embed\` et recoller.
-->
<iframe
  id="qc-map"
  src="${src}"
  title="Carte des régions administratives du Québec"
  style="width:100%;height:${height}px;border:0;display:block;"
  allow="clipboard-write"
  data-qc-region-pages="/carte-tables-regionales"
  data-qc-contacts="/carte-tables-rgionales-responsables"
  data-qc-contact-region-from="urlId"
></iframe>

<script>
/* ===== content-models.js (inline) ===== */
${readEmbed('content-models.js')}
</script>

<script>
/* ===== squarespace-bridge.js (inline) ===== */
${readEmbed('squarespace-bridge.js')}
</script>

<script>
  QuebecMapBridge.mount({ iframe: '#qc-map' });
</script>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, snippet, 'utf8');

console.log(`✓ ${OUT_FILE}`);
console.log(`  iframe src : ${src}`);
console.log(`  version    : ${version} (commit ${stamp})`);
console.log(`  taille     : ${(snippet.length / 1024).toFixed(1)} Ko`);
