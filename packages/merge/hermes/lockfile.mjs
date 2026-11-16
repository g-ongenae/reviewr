/*
 * The Hermes version the mobile app ships, read from pnpm-lock.yaml: the app's resolved `react-native`, then that
 * snapshot's `hermes-compiler`. No YAML library is installed here, so this is a strict reader of the subset pnpm
 * writes: documents split by `---`, block mappings, block lists of scalars, plain or single-quoted scalars, and flow
 * values (`{…}`, `[…]`) kept as text. Anything else (a comment, a double-quoted scalar, a duplicate key, a bad indent)
 * throws, so the check fails closed. Checked by lockfile.spec.mjs.
 */

const keyLine = /^( *)('(?:[^']|'')*'|[^\s'"#\-[{][^:#]*?):(?: (.*))?$/u;
const itemLine = /^( *)- (.*)$/u;

const unquote = (text) => (text.startsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text);

const scalar = (text, where) => {
  if (/^'(?:[^']|'')*'$/u.test(text) || /^[{[].*[}\]]$/u.test(text)) {
    return unquote(text);
  }
  if (/^["'#&*!|>%@`]/u.test(text) || / #/u.test(text)) {
    throw new Error(`${where}: unsupported YAML value ${text}`);
  }

  return text;
};

/** Parse pnpm-lock.yaml into one object per document. */
export const readLockfile = (text) =>
  text
    .split(/^---$/mu)
    .filter((document) => document.trim() !== '')
    .map((document, index) => {
      const lines = document
        .split('\n')
        .map((line, number) => ({ line, where: `document ${index + 1}, line ${number + 1}` }))
        .filter(({ line }) => line.trim() !== '');
      let position = 0;

      const block = (indent) => {
        const first = lines[position];
        if (first === undefined || first.line.length - first.line.trimStart().length !== indent) {
          throw new Error(`${first?.where ?? 'end'}: expected a block indented by ${indent}`);
        }
        if (itemLine.test(first.line)) {
          const list = [];
          while (lines[position] !== undefined && lines[position].line.startsWith(`${' '.repeat(indent)}- `)) {
            const { line, where } = lines[position++];
            list.push(scalar(itemLine.exec(line)[2], where));
          }

          return list;
        }
        const map = {};
        while (lines[position] !== undefined) {
          const { line, where } = lines[position];
          const match = keyLine.exec(line);
          if (match === null) {
            throw new Error(`${where}: unsupported YAML line ${line}`);
          }
          if (match[1].length < indent) {
            break;
          }
          if (match[1].length > indent) {
            throw new Error(`${where}: unexpected indent`);
          }
          position++;
          const key = unquote(match[2]);
          if (Object.hasOwn(map, key)) {
            throw new Error(`${where}: duplicate key ${key}`);
          }
          const next = lines[position];
          const nested = next !== undefined && next.line.length - next.line.trimStart().length > indent;
          if (match[3] === undefined || match[3] === '') {
            map[key] = nested ? block(next.line.length - next.line.trimStart().length) : null;
          } else if (nested) {
            throw new Error(`${next.where}: a block under a key that has a value`);
          } else {
            map[key] = scalar(match[3], where);
          }
        }

        return map;
      };

      const result = block(0);
      if (position !== lines.length) {
        throw new Error(`${lines[position].where}: unexpected indent`);
      }

      return result;
    });

/** The `hermes-compiler` version that the mobile app's React Native resolves to, or an error naming the broken link. */
export const mobileHermesVersion = (text) => {
  const documents = readLockfile(text).filter((document) => document?.importers?.['apps/mobile'] !== undefined);
  if (documents.length !== 1) {
    throw new Error('pnpm-lock.yaml has no importer apps/mobile');
  }
  const [{ importers, snapshots, packages }] = documents;
  const reactNative = importers['apps/mobile'].dependencies?.['react-native']?.version;
  if (typeof reactNative !== 'string') {
    throw new Error('apps/mobile has no resolved react-native dependency in pnpm-lock.yaml');
  }
  const compiler = snapshots?.[`react-native@${reactNative}`]?.dependencies?.['hermes-compiler'];
  if (typeof compiler !== 'string') {
    throw new Error(`pnpm-lock.yaml has no hermes-compiler for the mobile app's react-native@${reactNative}`);
  }
  if (packages?.[`hermes-compiler@${compiler}`] === undefined) {
    throw new Error(`pnpm-lock.yaml has no package hermes-compiler@${compiler}`);
  }

  return compiler;
};

/** Fails, with how to update the pin, unless the mobile app's Hermes is `pinned`. */
export const checkMobileHermes = (text, pinned) => {
  const instructions =
    'Update packages/merge/hermes/hermes.env to the tag hermes-v<version> of facebook/hermes (its commit and the ' +
    'SHA-256 of its source tarball), then rebuild with get-hermes.sh.';
  let resolved;
  try {
    resolved = mobileHermesVersion(text);
  } catch (error) {
    throw new Error(`Cannot find the mobile app's Hermes: ${error.message}. ${instructions}`);
  }
  if (resolved !== pinned) {
    throw new Error(`The mobile app ships Hermes ${resolved}, but the tests run on Hermes ${pinned}. ${instructions}`);
  }

  return resolved;
};
