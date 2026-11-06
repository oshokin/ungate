import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set([
	'node_modules',
	'dist',
	'bundle',
	'bundled',
	'build',
	'lib',
	'coverage',
	'.svelte-kit',
	'fixtures',
	'__fixtures__',
	'drizzle',
	'migrations',
	'tests',
	'__tests__'
]);
const files: string[] = [];
function walk(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!excludedDirectories.has(entry.name)) walk(path);
		} else if (
			/\.(?:[cm]?[jt]sx?|svelte)$/.test(entry.name) &&
			!/\.(?:d\.ts|test\.[cm]?[jt]sx?|spec\.[cm]?[jt]sx?)$/.test(entry.name)
		)
			files.push(path);
	}
}
for (const directory of ['apps', 'packages', 'scripts']) walk(join(root, directory));
files.sort();
const occurrences: { file: string; line: number; literal: string; kind: string; context: string; review: string }[] = [];
let svelteScripts = 0;
for (const file of files) {
	const text = readFileSync(file, 'utf8');
	const sections = file.endsWith('.svelte')
		? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/g)].map((match) => ({
				text: match[1],
				offset: match.index + match[0].indexOf('>') + 1
			}))
		: [{ text, offset: 0 }];
	if (file.endsWith('.svelte')) svelteScripts += sections.length;
	for (const section of sections) {
		const source = ts.createSourceFile(
			file,
			section.text,
			ts.ScriptTarget.Latest,
			true,
			file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
		);
		if ((source as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length)
			throw new Error(`Cannot parse ${file}`);
		function visit(node: ts.Node): void {
			if (ts.isNumericLiteral(node)) {
				let ancestor: ts.Node | undefined = node.parent;
				let declaration: ts.VariableDeclaration | undefined;
				while (ancestor && !ts.isSourceFile(ancestor)) {
					if (ts.isVariableDeclaration(ancestor)) {
						declaration = ancestor;
						break;
					}
					if (ts.isFunctionLike(ancestor)) break;
					ancestor = ancestor.parent;
				}
				const name = declaration?.name.getText(source) ?? '';
				// Uppercase bindings and const object initializers are policy declarations;
				// ordinary `const timeout = setTimeout(..., 1000)` remains a usage.
				const policy = Boolean(
					declaration &&
					(/^[A-Z][A-Z0-9_]*$/.test(name) ||
						(ts.isObjectLiteralExpression(declaration.initializer ?? node) && name.toUpperCase() === name))
				);
				const value = Number(node.text);
				occurrences.push({
					file: relative(root, file),
					line: text.slice(0, section.offset + node.getStart(source)).split('\n').length,
					literal: node.getText(source),
					kind: policy ? 'declaration' : 'usage',
					context: node.parent.getText(source).replace(/\s+/g, ' ').slice(0, 180),
					review: policy
						? 'named-policy'
						: value === 0 || value === 1
							? 'identity-index-counter-or-protocol-review'
							: value >= 100 && value <= 599
								? 'http-status-or-domain-value-review'
								: 'semantic-review-required'
				});
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
}
const counts = (key: 'kind' | 'review') =>
	Object.fromEntries(
		[...new Set(occurrences.map((entry) => entry[key]))]
			.sort()
			.map((value) => [value, occurrences.filter((entry) => entry[key] === value).length])
	);
const report = {
	method:
		'TypeScript AST numeric literals; Svelte script bodies extracted and parsed as TypeScript. No string, regex, template, markup or CSS numeric scanning.',
	exclusions: [...excludedDirectories, '*.d.ts', '*.test.*', '*.spec.*'],
	caveats: [
		'Declaration classification is syntactic, not a semantic proof. All remaining usages are review candidates, not violations.',
		'Tests are excluded; configuration and build scripts are included. Signed values are represented by their unsigned numeric operand.',
		'Svelte script extraction assumes conventional script tags; malformed TypeScript fails the audit.',
		'Apps are inventoried read-only; app owners resolve remaining candidates.'
	],
	scannedFiles: files.length,
	svelteFiles: files.filter((file) => file.endsWith('.svelte')).length,
	svelteScripts,
	byRoot: Object.fromEntries(
		['apps', 'packages', 'scripts'].map((directory) => [
			directory,
			files.filter((file) => relative(root, file).startsWith(`${directory}/`)).length
		])
	),
	byKind: counts('kind'),
	byReview: counts('review'),
	files: files.map((file) => relative(root, file)),
	occurrences
};
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, 'docs/numeric-constants-inventory.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, '\t')}\n`);
console.log(
	JSON.stringify({
		output: relative(root, output),
		scannedFiles: report.scannedFiles,
		svelteFiles: report.svelteFiles,
		svelteScripts,
		byRoot: report.byRoot,
		byKind: report.byKind,
		byReview: report.byReview
	})
);
