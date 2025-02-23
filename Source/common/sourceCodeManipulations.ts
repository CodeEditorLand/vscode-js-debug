/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { Node as AcornNode, parse as parseStrict } from "acorn";
import { isDummy, Options, parse } from "acorn-loose";
import * as evk from "eslint-visitor-keys";
import {
	ArrowFunctionExpression,
	CallExpression,
	Expression,
	FunctionExpression,
	Identifier,
	Node,
	Program,
	Statement,
	TryStatement,
} from "estree";

export type AnyFunctionExpression =
	| FunctionExpression
	| ArrowFunctionExpression;

export const acornOptions: Options = {
	ecmaVersion: "latest",
	locations: true,
	allowAwaitOutsideFunction: true,
	allowImportExportEverywhere: true,
	allowReserved: true,
	allowReturnOutsideFunction: true,
};

export const getStart: (node: Node | AcornNode) => number = (node) =>
	(node as AcornNode).start;

export const getEnd: (node: Node | AcornNode) => number = (node) =>
	(node as AcornNode).end;

export const getText: (src: string, node: Node | AcornNode) => string = (
	src,
	node,
) => src.slice(getStart(node), getEnd(node));

export const parseProgram = (str: string, strict = false) =>
	(strict ? parseStrict : parse)(str, acornOptions) as unknown as Program;

export const parseSource: (str: string) => (Statement & AcornNode)[] = (
	str,
) => {
	const parsed = parseProgram(str) as unknown as {
		body: (Statement & AcornNode)[];
	};

	// acorn-loose adds a "dummy" identifier to function expressions parsing
	// as a program, which creates an invalid name. But this isn't actually necesary.
	for (const stmt of parsed.body) {
		if (
			stmt.type === "FunctionDeclaration" &&
			stmt.id &&
			isDummy(stmt.id)
		) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(stmt as any).id = null;
		}
	}

	return parsed.body;
};

/**
 * function (params) { code } => function (params) { catchAndReturnErrors?(code) }
 * statement => function () { return catchAndReturnErrors?(return statement) }
 * statement; statement => function () { catchAndReturnErrors?(statement; return statement;) }
 */
export function statementsToFunction(
	parameterNames: ReadonlyArray<string>,
	statements: ReadonlyArray<Statement>,
	catchAndReturnErrors: boolean,
): AnyFunctionExpression {
	if (statements.length > 1 || statements[0].type !== "FunctionDeclaration") {
		return statementToFunction(
			parameterNames,
			statements,
			true,
			catchAndReturnErrors,
		);
	}

	return codeToFunctionExecutingCode(
		parameterNames,
		[
			{
				type: "ReturnStatement",
				argument: {
					type: "CallExpression",
					optional: false,
					arguments: [
						{ type: "ThisExpression" },
						...parameterNames.map((name) => ({
							type: "Identifier" as const,
							name,
						})),
					],
					callee: {
						type: "MemberExpression",
						property: { type: "Identifier", name: "call" },
						computed: false,
						optional: false,
						object: {
							type: "FunctionExpression",
							params: statements[0].params,
							body: statements[0].body,
						},
					},
				},
			},
		],
		true,
		catchAndReturnErrors,
	);
}

/**
 * code => (parameterNames) => return catchAndReturnErrors?(code)
 */
const codeToFunctionExecutingCode = (
	parameterNames: ReadonlyArray<string>,
	body: ReadonlyArray<Statement>,
	preserveThis: boolean,
	catchAndReturnErrors: boolean,
): AnyFunctionExpression => {
	const param: Identifier = { type: "Identifier", name: "e" };

	const innerWithTry: TryStatement = {
		type: "TryStatement",
		block: { type: "BlockStatement", body: body as Statement[] },
		handler: {
			type: "CatchClause",
			param: param,
			body: {
				type: "BlockStatement",
				body: [
					{
						type: "ReturnStatement",
						argument: {
							type: "LogicalExpression",
							left: {
								type: "LogicalExpression",
								left: {
									type: "MemberExpression",
									object: param,
									property: {
										type: "Identifier",
										name: "stack",
									},
									computed: false,
									optional: false,
								},
								operator: "||",
								right: {
									type: "MemberExpression",
									object: param,
									property: {
										type: "Identifier",
										name: "message",
									},
									computed: false,
									optional: false,
								},
							},
							operator: "||",
							right: {
								type: "CallExpression",
								callee: { type: "Identifier", name: "String" },
								arguments: [param],
								optional: false,
							},
						},
					},
				],
			},
		},
	};

	const inner = catchAndReturnErrors
		? [innerWithTry]
		: (body as Array<Statement>);

	return preserveThis
		? {
				type: "FunctionExpression",
				id: { type: "Identifier", name: "_generatedCode" },
				params: parameterNames.map((name) => ({
					type: "Identifier",
					name,
				})),
				body: { type: "BlockStatement", body: inner },
			}
		: {
				type: "ArrowFunctionExpression",
				params: parameterNames.map((name) => ({
					type: "Identifier",
					name,
				})),
				expression: false,
				body: { type: "BlockStatement", body: inner },
			};
};

/**
 * function (params) { code } => (function (params) { code })(argumentsText)
 */
export const functionToFunctionCall = (
	argumentsList: ReadonlyArray<string>,
	functionCode: FunctionExpression | ArrowFunctionExpression,
): CallExpression => ({
	type: "CallExpression",
	arguments: argumentsList.map((name) => ({ type: "Identifier", name })),
	callee: functionCode,
	optional: false,
});

/**
 * statement => catchAndReturnErrors(return statement);
 * statement; statement => catchAndReturnErrors(statement; return statement);
 */
export const returnErrorsFromStatements = (
	parameterNames: ReadonlyArray<string>,
	statements: ReadonlyArray<Statement>,
	preserveThis: boolean,
) =>
	functionToFunctionCall(
		parameterNames,
		statementToFunction(
			parameterNames,
			statements,
			preserveThis,
			/*catchAndReturnErrors*/ true,
		),
	);

/**
 * statement => function () { catchAndReturnErrors(return statement); }
 * statement; statement => function () { catchAndReturnErrors(statement; return statement); }
 */
function statementToFunction(
	parameterNames: ReadonlyArray<string>,
	statements: ReadonlyArray<Statement>,
	preserveThis: boolean,
	catchAndReturnErrors: boolean,
) {
	const last = statements[statements.length - 1];

	if (last.type !== "ReturnStatement") {
		const expr = statementToExpression(last);

		if (expr) {
			statements = [
				...statements.slice(0, -1),
				{ type: "ReturnStatement", argument: expr },
			];
		}
	}

	return codeToFunctionExecutingCode(
		parameterNames,
		statements,
		preserveThis,
		catchAndReturnErrors,
	);
}

export function statementToExpression(stmt: Statement): Expression | undefined {
	switch (stmt.type) {
		case "ExpressionStatement":
			return stmt.expression;

		case "BlockStatement":
			return {
				type: "CallExpression",
				arguments: [],
				callee: {
					type: "ArrowFunctionExpression",
					params: [],
					expression: false,
					body: stmt,
				},
				optional: false,
			};

		case "ReturnStatement":
			return stmt.argument || undefined;

		default:
			return undefined;
	}
}

export const enum VisitorOption {
	/** Immediately stop and unwind the transerveral */
	Break,
	/** Skip the children of this node */
	Skip,
}

/**
 * estraverse-like method that visits all nodes in the tree.
 * This is used to replace estraverse which has been abandoned.
 */
export const traverse = (
	node: Node,
	visitor: {
		enter: (node: Node, parent?: Node) => VisitorOption | void;

		leave?: (node: Node) => void;
	},
) => {
	traverseInner(node, visitor);
};

/**
 * estraverse-like method that visits and possibly replaces all nodes in the tree.
 * This is used to replace estraverse which has been abandoned.
 */
export const replace = <T extends Node>(
	node: T,
	visitor: {
		enter: (
			node: Node,
			parent?: Node,
		) => VisitorOption | { replace: Node } | void;

		leave?: (node: Node) => void;
	},
): T => {
	const r = traverseInner(node, visitor);

	if (r && typeof r === "object") {
		return r.replace as T;
	}

	return node;
};

type VisitorResult =
	| VisitorOption.Break
	| VisitorOption.Skip
	| { replace: Node };

const traverseInner = (
	node: Node,
	visitor: {
		enter: (node: Node, parent?: Node) => VisitorResult | void;

		leave?: (node: Node) => void;
	},
	parent?: Node,
): VisitorOption.Break | { replace: Node } | undefined => {
	if (!node) {
		return;
	}

	const opt = visitor.enter(node, parent);

	if (opt === VisitorOption.Break) {
		return VisitorOption.Break;
	} else if (opt && typeof opt === "object") {
		return opt;
	} else if (opt === VisitorOption.Skip) {
		return;
	}

	const keys = evk.KEYS[node.type];

	if (keys) {
		for (const key of keys) {
			const child = (node as unknown as Record<string, Node | Node[]>)[
				key
			];

			if (child instanceof Array) {
				for (const [i, c] of child.entries()) {
					const result = traverseInner(c, visitor, node);

					if (result === VisitorOption.Break) {
						return VisitorOption.Break;
					} else if (result && typeof result === "object") {
						child[i] = result.replace;
					}
				}
			} else if (child) {
				const result = traverseInner(child, visitor, node);

				if (result === VisitorOption.Break) {
					return VisitorOption.Break;
				} else if (result && typeof result === "object") {
					(node as unknown as Record<string, Node | Node[]>)[key] =
						result.replace;
				}
			}
		}
	}

	visitor.leave?.(node);
};
