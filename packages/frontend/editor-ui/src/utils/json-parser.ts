import fs from 'fs';
import {
	parseTree,
	getNodeValue,
	printParseErrorCode,
	type ParseError,
	type Node,
} from 'jsonc-parser';
import type { ZodTypeAny, ZodIssue } from 'zod';
import { ZodError, ZodObject, ZodArray } from 'zod';

export interface ValidationIssue {
	message: string;
	suggestion?: string;
	jsonPointer: string;
	line: number;
	column: number;
}

export interface ValidationResult<T> {
	valid: boolean;
	data?: T;
	errors: ValidationIssue[];
}

function groupIssuesByCategory(issues: ValidationIssue[]): {
	missing: ValidationIssue[];
	invalid: ValidationIssue[];
	unexpected: ValidationIssue[];
	other: ValidationIssue[];
} {
	const grouped = {
		missing: [] as ValidationIssue[],
		invalid: [] as ValidationIssue[],
		unexpected: [] as ValidationIssue[],
		other: [] as ValidationIssue[],
	};

	for (const issue of issues) {
		if (
			issue.message.toLowerCase().includes('missing') ||
			issue.message.toLowerCase().includes('required')
		) {
			grouped.missing.push(issue);
		} else if (issue.message.toLowerCase().includes('unexpected')) {
			grouped.unexpected.push(issue);
		} else if (issue.message.toLowerCase().includes('invalid')) {
			grouped.invalid.push(issue);
		} else {
			grouped.other.push(issue);
		}
	}

	return grouped;
}

// 3. Main formatting function that creates the nice output
export function createErrorSummary(issues: ValidationIssue[]): string {
	const grouped = groupIssuesByCategory(issues);
	const parts: string[] = [];

	if (grouped.missing.length > 0) {
		parts.push('\nMissing Required Fields:');
		grouped.missing.forEach((issue) => {
			parts.push(`   - ${issue.message}`);
			if (issue.suggestion) {
				parts.push(`      💡 ${issue.suggestion}`);
			}
		});
	}

	if (grouped.invalid.length > 0) {
		parts.push('\nInvalid Values:');
		grouped.invalid.forEach((issue) => {
			parts.push(`   - ${issue.message}`);
			if (issue.suggestion) {
				parts.push(`      💡 ${issue.suggestion}`);
			}
		});
	}

	if (grouped.unexpected.length > 0) {
		parts.push('\nUnexpected Fields:');
		grouped.unexpected.forEach((issue) => {
			parts.push(`   - ${issue.message}`);
			if (issue.suggestion) {
				parts.push(`      💡 ${issue.suggestion}`);
			}
		});
	}

	if (grouped.other.length > 0) {
		parts.push('\nOther Issues:');
		grouped.other.forEach((issue) => {
			parts.push(`   - ${issue.message}`);
			if (issue.suggestion) {
				parts.push(`      💡 ${issue.suggestion}`);
			}
		});
	}

	return parts.join('\n');
}

/**
 * Recursively enforce strict object validation on all object schemas.
 * This strips passthrough() / catchall() behavior deeply.
 */
function deepStrict<T extends ZodTypeAny>(schema: T): T {
	if (schema instanceof ZodObject) {
		// Cast schema to 'any' for the .strict() call to bypass complex Zod type errors.
		const strictObj = schema.strict();

		// Explicitly type shape to resolve "Unsafe argument of type any assigned to parameter of type {}"
		const shape: Record<string, ZodTypeAny> = strictObj._def.shape();

		for (const key of Object.keys(shape)) {
			shape[key] = deepStrict(shape[key]); // recurse children
		}
		return strictObj as unknown as T;
	}

	if (schema instanceof ZodArray) {
		// Accessing _def.type is fine for ZodArray
		const inner = deepStrict(schema._def.type);
		return schema.element(inner) as T;
	}

	return schema;
}

/** Convert a Zod path array → JSON Pointer */
function pathToPointer(path: Array<string | number>): string {
	if (!path || path.length === 0) return '';
	return (
		'/' +
		path
			.map(String)
			.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1'))
			.join('/')
	);
}

function buildPointerMap(
	node: Node | undefined,
	text: string,
	pointer: string = '',
): Record<string, { offset: number }> {
	const map: Record<string, { offset: number }> = {};

	// Guard: ensure node exists and has required properties
	if (!node || typeof node.offset !== 'number') {
		return map;
	}

	map[pointer] = { offset: node.offset };

	if (node.type === 'object' && node.children && Array.isArray(node.children)) {
		for (let i = 0; i < node.children.length; i += 2) {
			const keyNode = node.children[i];
			const valueNode = node.children[i + 1];

			// Guard: ensure both key and value nodes exist with valid properties
			if (
				!keyNode ||
				!valueNode ||
				typeof keyNode.offset !== 'number' ||
				typeof keyNode.length !== 'number'
			) {
				continue;
			}

			try {
				// Safe access with bounds checking
				const keyStart = keyNode.offset + 1;
				const keyEnd = keyNode.offset + keyNode.length - 1;

				if (keyStart >= 0 && keyEnd <= text.length && keyStart <= keyEnd) {
					const key = text.slice(keyStart, keyEnd);
					const childPointer = pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
					Object.assign(map, buildPointerMap(valueNode, text, childPointer));
				}
			} catch (error) {
				// Silently skip malformed nodes
				console.warn('Error processing object node:', error);
				continue;
			}
		}
	}

	if (node.type === 'array' && node.children && Array.isArray(node.children)) {
		node.children.forEach((child, index) => {
			if (child) {
				const childPointer = pointer + '/' + index;
				Object.assign(map, buildPointerMap(child, text, childPointer));
			}
		});
	}

	return map;
}

function positionFromOffset(text: string, offset: number) {
	// Guard: ensure valid offset
	if (typeof offset !== 'number' || offset < 0 || offset > text.length) {
		return { line: 0, column: 0 };
	}

	const lines = text.slice(0, offset).split(/\r?\n/);
	const line = lines.length;
	const column = lines[lines.length - 1].length + 1;
	return { line, column };
}

/**
 * Validate raw JSON contents
 */
export function validateJson<T>(jsonText: string, schema: ZodTypeAny): ValidationResult<T> {
	// Guard: ensure jsonText is a string
	if (typeof jsonText !== 'string') {
		return {
			valid: false,
			errors: [
				{
					message: 'Invalid input: expected string',
					jsonPointer: '',
					line: 0,
					column: 0,
				},
			],
		};
	}

	const errors: ParseError[] = [];
	let tree: Node | undefined;

	try {
		tree = parseTree(jsonText, errors);
	} catch (error) {
		return {
			valid: false,
			errors: [
				{
					message: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					jsonPointer: '',
					line: 0,
					column: 0,
				},
			],
		};
	}

	// Syntax errors first
	if (errors.length > 0 || !tree) {
		return {
			valid: false,
			errors: errors.map((e) => {
				const { line, column } = positionFromOffset(jsonText, e.offset);
				return {
					message: `Syntax error: ${printParseErrorCode(e.error)}`,
					jsonPointer: '',
					line,
					column,
				};
			}),
		};
	}

	let data: unknown;
	let pointerMap: Record<string, { offset: number }> = {};

	try {
		data = getNodeValue(tree);
		pointerMap = buildPointerMap(tree, jsonText);
	} catch (error) {
		return {
			valid: false,
			errors: [
				{
					message: `Error processing JSON structure: ${error instanceof Error ? error.message : 'Unknown error'}`,
					jsonPointer: '',
					line: 0,
					column: 0,
				},
			],
		};
	}

	// Strictify schema deeply
	let strictSchema: ZodTypeAny;
	try {
		strictSchema = deepStrict(schema);
	} catch (error) {
		return {
			valid: false,
			errors: [
				{
					message: `Schema error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					jsonPointer: '',
					line: 0,
					column: 0,
				},
			],
		};
	}

	try {
		const parsed = strictSchema.parse(data);
		return { valid: true, data: parsed as T, errors: [] };
	} catch (e) {
		const issues: ValidationIssue[] = [];

		const handleIssue = (issue: ZodIssue) => {
			const pointer = pathToPointer(issue.path);
			const pm = pointerMap[pointer];
			const loc = pm ? positionFromOffset(jsonText, pm.offset) : { line: 0, column: 0 };

			let suggestion: string | undefined;

			// Optionally handle type-available cases
			if (issue.message.toLowerCase().includes('required')) {
				suggestion = `Add missing field: "${issue.path[issue.path.length - 1]}"`;
			} else if (issue.code === 'unrecognized_keys') {
				suggestion = 'Remove this field — it is not allowed by the schema';
			} else if (issue.code === 'invalid_type' && 'expected' in issue && 'received' in issue) {
				suggestion = `Expected type '${issue.expected}', got '${issue.received}'`;
			}

			issues.push({
				message: `Validation error: ${issue.message}`,
				suggestion,
				jsonPointer: pointer,
				line: loc.line,
				column: loc.column,
			});
		};

		if (e instanceof ZodError) {
			e.issues.map((issue) => {
				if (issue.code === 'invalid_union') {
					for (const unionErr of issue.unionErrors) {
						for (const innerErr of unionErr.issues) {
							handleIssue(innerErr);
						}
					}
				} else {
					handleIssue(issue);
				}
			});
		} else {
			issues.push({
				message: `Validation error: ${e instanceof Error ? e.message : 'Unknown error'}`,
				jsonPointer: 'root',
				line: 0,
				column: 0,
			});
		}

		return {
			valid: false,
			errors: issues,
		};
	}
}

/**
 * Convenience wrapper to validate a file path
 */
export function validateJsonFile<T>(
	filePath: string,
	schema: ZodTypeAny,
	fileEncoding: BufferEncoding = 'utf8',
): ValidationResult<T> {
	try {
		const raw = fs.readFileSync(filePath, fileEncoding);
		return validateJson<T>(raw, schema);
	} catch (error) {
		return {
			valid: false,
			errors: [
				{
					message: `File error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					jsonPointer: '',
					line: 0,
					column: 0,
				},
			],
		};
	}
}
