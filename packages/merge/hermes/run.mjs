/*
 * Runs the package's specs on the Hermes VM that React Native ships, the two ways a phone runs JavaScript: from source
 * (a development build) and from bytecode compiled by `hermesc -O` (a release build). The same bundle also runs on
 * Node first, so a case that fails only on Hermes is an engine difference, not a harness bug.
 *
 * Vitest decides which cases exist: `vitest list` gives the spec files and the case names, and every run must report
 * exactly these names, all passed. The bundle is made with TypeScript alone: each file of `src` is transpiled to
 * CommonJS and wrapped in a function, `vitest` is replaced by `harness.cjs`, and the specs are required in order.
 *
 * Usage: node hermes/run.mjs. Looks for `hermes` and `hermesc` in $HERMES_BIN, or where `get-hermes.sh` puts them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const sourceDir = join(packageDir, 'src');
const out = join(packageDir, '.hermes', 'out');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// The pinned Hermes must be the one the mobile app resolves.
const pin = Object.fromEntries(
  [...readFileSync(join(here, 'hermes.env'), 'utf8').matchAll(/^(\w+)=(.*)$/gmu)].map((match) => [match[1], match[2]]),
);
const lock = readFileSync(join(packageDir, '..', '..', 'pnpm-lock.yaml'), 'utf8');
const resolved = [...new Set([...lock.matchAll(/^ {2}hermes-compiler@([^:(]+):/gmu)].map((match) => match[1]))];
if (resolved.length !== 1 || resolved[0] !== pin.HERMES_VERSION) {
  fail(
    `pnpm-lock.yaml resolves hermes-compiler ${resolved.join(', ') || '(none)'}, but the tests run on Hermes ` +
      `${pin.HERMES_VERSION}. Update packages/merge/hermes/hermes.env to the tag hermes-v<version> of facebook/hermes ` +
      '(its commit and the SHA-256 of its source tarball), then rebuild with get-hermes.sh.',
  );
}

const bin = process.env.HERMES_BIN ?? join(packageDir, '.hermes', pin.HERMES_VERSION, 'bin');
if (!existsSync(join(bin, 'hermes')) || !existsSync(join(bin, 'hermesc'))) {
  fail(`No hermes and hermesc in ${bin}. Build them with packages/merge/hermes/get-hermes.sh (see README).`);
}

// The cases Vitest collects. The harness's own spec checks it against Vitest and has no meaning on Hermes.
mkdirSync(out, { recursive: true });
const listFile = join(out, 'vitest-list.json');
execFileSync(join(packageDir, 'node_modules', '.bin', 'vitest'), ['list', `--json=${listFile}`], {
  cwd: packageDir,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const listed = JSON.parse(readFileSync(listFile, 'utf8'))
  .map(({ name, file }) => ({ name, file: relative(packageDir, file).split('\\').join('/') }))
  .filter(({ file }) => file !== 'hermes/harness.spec.mjs');
const unsupported = listed.filter(({ file }) => !/^src\/.+\.ts$/u.test(file));
if (unsupported.length > 0) {
  fail(`Vitest runs spec files this script cannot bundle: ${[...new Set(unsupported.map(({ file }) => file))]}`);
}
const expectedNames = listed.map(({ name }) => name).sort();

const files = readdirSync(sourceDir, { recursive: true })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort();
const specs = [...new Set(listed.map(({ file }) => file.slice('src/'.length)))].sort();

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
"vitest": [{}, function (module, exports, require) {\n${readFileSync(join(here, 'harness.cjs'), 'utf8')}\n}],
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
if (typeof HermesInternal === 'object' && typeof Intl !== 'object') {
  throw new Error('this Hermes was built without Intl, unlike the one React Native ships');
}
load('vitest').run(typeof HermesInternal === 'object'
  ? 'Hermes ' + HermesInternal.getRuntimeProperties()['OSS Release Version'] + ' with Intl'
  : 'Node ' + process.version);
})();
`;

const script = join(out, 'merge.cjs');
const bytecode = join(out, 'merge.hbc');
writeFileSync(script, bundle);
console.log(`Bundled ${specs.join(', ')} into ${relative(process.cwd(), script)}`);
console.log(`Vitest collects ${expectedNames.length} cases in them; Hermes ${pin.HERMES_VERSION} from ${bin}`);
execFileSync(join(bin, 'hermesc'), ['-O', '-emit-binary', '-out', bytecode, script], { stdio: 'inherit' });

// A run passes if it exits with 0, every case passed, and its cases are exactly Vitest's.
let failed = false;
for (const [title, command, args] of [
  ['On Node (V8), to check the harness:', process.execPath, [script]],
  ['On Hermes, from source:', join(bin, 'hermes'), [script]],
  ['On Hermes, from bytecode compiled by hermesc -O:', join(bin, 'hermes'), ['-b', bytecode]],
]) {
  console.log(`\n${title}`);
  const { status, stdout, stderr } = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = stdout.split('\n');
  const casesLine = lines.find((line) => line.startsWith('CASES '));
  process.stdout.write(lines.filter((line) => line !== casesLine).join('\n'));
  process.stderr.write(stderr);
  const names = casesLine === undefined ? [] : JSON.parse(casesLine.slice('CASES '.length)).sort();
  const missing = expectedNames.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !expectedNames.includes(name));
  const sameCases = names.length === expectedNames.length && names.every((name, i) => name === expectedNames[i]);
  if (!sameCases) {
    const some = (list) => `${list.length} ${JSON.stringify(list.slice(0, 5))}${list.length > 5 ? '…' : ''}`;
    console.error(`The cases differ from Vitest's. Missing: ${some(missing)}. Extra: ${some(extra)}`);
  }
  if (status !== 0 || !/: (\d+) passed, 0 failed, \1 cases\n$/u.test(stdout) || !sameCases) {
    failed = true;
  }
}
if (failed) {
  fail('\nThe specs did not all pass on every run, or the runs did not report the same cases as Vitest.');
}
console.log(`\nThe ${expectedNames.length} cases Vitest collects passed on Node and on Hermes (source and bytecode).`);
