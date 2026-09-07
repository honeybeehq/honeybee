import ts from "typescript";

const OUTPUT_EXTENSIONS = [
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".ts", ".js"],
];

function outputSpecifier(specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  if (/\.d\.(?:mts|cts|ts)$/u.test(specifier)) return undefined;
  for (const [input, output] of OUTPUT_EXTENSIONS) {
    if (specifier.endsWith(input)) return `${specifier.slice(0, -input.length)}${output}`;
  }
  return undefined;
}

function literalModuleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length > 0
    && ts.isStringLiteralLike(node.arguments[0])) {
    return node.arguments[0];
  }
  return undefined;
}

/**
 * Rewrite only ESM module-specifier literals that TypeScript would emit with a
 * JavaScript extension. All other source bytes are retained verbatim.
 */
export function rewriteRelativeTypeScriptImports(source, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const edits = [];
  function visit(node) {
    const literal = literalModuleSpecifier(node);
    if (literal) {
      const rewritten = outputSpecifier(literal.text);
      if (rewritten !== undefined) {
        edits.push({ start: literal.getStart(sourceFile), end: literal.end, text: JSON.stringify(rewritten) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (edits.length === 0) return source;

  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return output;
}
