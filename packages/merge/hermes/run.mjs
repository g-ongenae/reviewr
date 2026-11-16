/*
 * Runs the package's specs on the Hermes VM that React Native ships, the two ways a phone runs JavaScript: from source
 * (a development build) and from bytecode compiled by `hermesc -O` (a release build). The same bundle also runs on
 * Node first, so a case that fails only on Hermes is an engine difference, not a harness bug.
 *
 * The bundle is made with TypeScript alone: each file of `src` is transpiled to CommonJS and wrapped in a function,
 * `vitest` is replaced by `harness.js`, and the specs are required in order. Usage: node hermes/run.mjs
 * Looks for `hermes` and `hermesc` in $HERMES_BIN, or where `get-hermes.sh` puts them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const sourceDir = join(packageDir, 'src');
const hermesVersion = '260318099.0.4';
const bin = process.env.HERMES_BIN ?? join(packageDir, '.hermes', hermesVersion, 'bin');
const out = join(packageDir, '.hermes', 'out');

if (!existsSync(join(bin, 'hermes')) || !existsSync(join(bin, 'hermesc'))) {
  console.error(`No hermes and hermesc in ${bin}. Build them with packages/merge/hermes/get-hermes.sh (see README).`);
  process.exit(1);
}

const files = readdirSync(sourceDir, { recursive: true })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort();
const specs = files.filter((file) => file.endsWith('.spec.ts'));

/** The module id a `require` of `request` from `file` points to. */
const resolve = (file, request) => {
  if (request === 'vitest') {
    return 'vitest';
  }
  if (!request.startsWith('.')) {
    throw new Error(`${file}: only relative imports and vitest can be bundled, not ${request}`);
  }
  const id = posix.join(posix.dirname(file), request).replace(/\.js$/u, '.ts');
  if (!files.includes(id)) {
    throw new Error(`${file}: cannot find ${request}`);
  }

  return id;
};

const modules = files.map((file) => {
  const { outputText } = ts.transpileModule(readFileSync(join(sourceDir, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    fileName: file,
  });
  const requests = [...outputText.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]);
  const map = Object.fromEntries(requests.map((request) => [request, resolve(file, request)]));

  return `${JSON.stringify(file)}: [${JSON.stringify(map)}, function (module, exports, require) {\n${outputText}\n}]`;
});

const bundle = `(function () {
var definitions = {
"vitest": [{}, function (module, exports, require) {\n${readFileSync(join(here, 'harness.js'), 'utf8')}\n}],
${modules.join(',\n')}
};
var cache = {};
function load(id) {
  if (!cache[id]) {
    var module = (cache[id] = { exports: {} });
    var definition = definitions[id];
    definition[1](module, module.exports, function (request) { return load(definition[0][request]); });
  }
  return cache[id].exports;
}
${JSON.stringify(specs)}.forEach(load);
load('vitest').run(typeof HermesInternal === 'object'
  ? 'Hermes ' + HermesInternal.getRuntimeProperties()['OSS Release Version']
  : 'Node ' + process.version);
})();
`;

mkdirSync(out, { recursive: true });
const script = join(out, 'merge.cjs');
const bytecode = join(out, 'merge.hbc');
writeFileSync(script, bundle);
console.log(`Bundled ${specs.join(', ')} into ${relative(process.cwd(), script)}`);

execFileSync(join(bin, 'hermesc'), ['-O', '-emit-binary', '-out', bytecode, script], { stdio: 'inherit' });

let failed = false;
for (const [title, command, args] of [
  ['On Node (V8), to check the harness:', process.execPath, [script]],
  ['On Hermes, from source:', join(bin, 'hermes'), [script]],
  ['On Hermes, from bytecode compiled by hermesc -O:', join(bin, 'hermes'), ['-b', bytecode]],
]) {
  console.log(`\n${title}`);
  try {
    execFileSync(command, args, { stdio: 'inherit' });
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
