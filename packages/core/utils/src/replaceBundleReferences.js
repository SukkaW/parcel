// @flow strict-local

import type SourceMap from '@parcel/source-map';
import type {
  Async,
  Blob,
  Bundle,
  BundleGraph,
  Dependency,
  NamedBundle,
} from '@parcel/types';

import {Readable} from 'stream';
import nullthrows from 'nullthrows';
import URL from 'url';
import {bufferStream, relativeBundlePath, urlJoin} from '../';

type ReplacementMap = Map<
  string /* dependency id */,
  {|from: string, to: string|},
>;

/*
 * Replaces references to dependency ids for URL dependencies with:
 *   - in the case of an unresolvable url dependency, the original moduleSpecifier.
 *     These are external requests that Parcel did not bundle.
 *   - in the case of a reference to another bundle, the relative url to that
 *     bundle from the current bundle.
 */
export function replaceURLReferences({
  bundle,
  bundleGraph,
  contents,
  map,
  relative = true,
}: {|
  bundle: NamedBundle,
  bundleGraph: BundleGraph<NamedBundle>,
  contents: string,
  relative?: boolean,
  map?: ?SourceMap,
|}): {|+contents: string, +map: ?SourceMap|} {
  let replacements = new Map();
  let urlDependencies = [];
  bundle.traverse(node => {
    if (node.type === 'dependency' && node.value.isURL) {
      urlDependencies.push(node.value);
    }
  });

  for (let dependency of urlDependencies) {
    if (!dependency.isURL) {
      continue;
    }

    let resolved = bundleGraph.getReferencedBundle(dependency, bundle);
    if (resolved == null) {
      replacements.set(dependency.id, {
        from: dependency.id,
        to: dependency.moduleSpecifier,
      });
      continue;
    }

    if (!resolved || resolved.isInline) {
      // If a bundle is inline, it should be replaced with inline contents,
      // not a URL.
      continue;
    }

    replacements.set(
      dependency.id,
      getURLReplacement({
        dependency,
        fromBundle: bundle,
        toBundle: resolved,
        relative,
      }),
    );
  }

  return performReplacement(replacements, contents, map);
}

/*
 * Replaces references to dependency ids for inline bundles with the packaged
 * contents of that bundle.
 */
export async function replaceInlineReferences({
  bundle,
  bundleGraph,
  contents,
  map,
  getInlineReplacement,
  getInlineBundleContents,
}: {|
  bundle: Bundle,
  bundleGraph: BundleGraph<NamedBundle>,
  contents: string,
  getInlineReplacement: (
    Dependency,
    ?'string',
    string,
  ) => {|from: string, to: string|},
  getInlineBundleContents: (
    Bundle,
    BundleGraph<NamedBundle>,
  ) => Async<{|contents: Blob|}>,
  map?: ?SourceMap,
|}): Promise<{|+contents: string, +map: ?SourceMap|}> {
  let replacements = new Map();

  let dependencies = [];
  bundle.traverse(node => {
    if (node.type === 'dependency') {
      dependencies.push(node.value);
    }
  });

  for (let dependency of dependencies) {
    let entryBundle = bundleGraph.getReferencedBundle(dependency, bundle);
    if (!entryBundle?.isInline) {
      continue;
    }

    let packagedBundle = await getInlineBundleContents(
      entryBundle,
      bundleGraph,
    );
    let packagedContents = (packagedBundle.contents instanceof Readable
      ? await bufferStream(packagedBundle.contents)
      : packagedBundle.contents
    ).toString();

    let inlineType = nullthrows(entryBundle.getEntryAssets()[0]).meta
      .inlineType;
    if (inlineType == null || inlineType === 'string') {
      replacements.set(
        dependency.id,
        getInlineReplacement(dependency, inlineType, packagedContents),
      );
    }
  }

  return performReplacement(replacements, contents, map);
}

function getURLReplacement({
  dependency,
  fromBundle,
  toBundle,
  relative,
}: {|
  dependency: Dependency,
  fromBundle: NamedBundle,
  toBundle: NamedBundle,
  relative: boolean,
|}) {
  let url = URL.parse(dependency.moduleSpecifier);
  let to;
  if (relative) {
    url.pathname = relativeBundlePath(fromBundle, toBundle, {
      leadingDotSlash: false,
    });
    to = URL.format(url);
  } else {
    url.pathname = nullthrows(toBundle.name);
    to = urlJoin(toBundle.target.publicUrl, URL.format(url));
  }

  return {
    from: dependency.id,
    to,
  };
}

function performReplacement(
  replacements: ReplacementMap,
  contents: string,
  map?: ?SourceMap,
): {|+contents: string, +map: ?SourceMap|} {
  let {result, offsets} = regexReplaceWithLocations(
    contents,
    new Map([...replacements.values()].map(val => [val.from, val.to])),
  );

  if (map) {
    for (let offset of offsets) {
      map.offsetColumns(offset.line, offset.column, offset.offset);
    }
  }

  return {
    contents: result,
    map,
  };
}

export function regexReplaceWithLocations(
  input: string,
  replacementMap: Map<string, string>,
): {|
  result: string,
  offsets: Array<{|column: number, line: number, offset: number|}>,
|} {
  // turn keys into a length sorted array, this ensures longer keys get priority over shorter keys
  // this is to prevent bugs in case 2 keys start with the same characters
  let keysArray = Array.from(replacementMap.keys()).sort((a, b) => {
    return b.length - a.length;
  });

  let line = 1;
  let offset = 0;
  let columnStartIndex = 0;
  let offsets = [];
  let regex = new RegExp(['\n', ...keysArray].join('|'), 'g');
  let result = input.replace(regex, (match, index) => {
    if (match === '\n') {
      line++;
      columnStartIndex = index + offset + 1;
      return '\n';
    }

    let replacement = replacementMap.get(match);
    if (replacement != null) {
      let lengthDifference = replacement.length - match.length;
      if (lengthDifference !== 0) {
        offsets.push({
          line,
          column: index + offset - columnStartIndex,
          offset: lengthDifference,
        });

        offset += lengthDifference;
      }
      return replacement;
    }

    return match;
  });

  return {result, offsets};
}
