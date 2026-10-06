import * as ts from "typescript";
import { GENERATED_SKILL_DANGEROUS_STRING_FRAGMENTS } from './authoring_contract';

export function generatedSkillFinding(findings: Set<string>, message: string): void {
  findings.add(message);
}

export function importBindingMatches(
  statement: ts.Statement | undefined,
  expectedModule: string,
  expectedBinding: string,
): boolean {
  if (!statement || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
  if (statement.moduleSpecifier.text !== expectedModule) return false;
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }
  const elements = clause.namedBindings.elements;
  return elements.length === 1
    && !elements[0].isTypeOnly
    && !elements[0].propertyName
    && elements[0].name.text === expectedBinding;
}

export function unwrapGeneratedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

export function isStaticDataLiteral(expression: ts.Expression): boolean {
  const value = unwrapGeneratedExpression(expression);
  if (
    ts.isStringLiteral(value)
    || ts.isNumericLiteral(value)
    || value.kind === ts.SyntaxKind.TrueKeyword
    || value.kind === ts.SyntaxKind.FalseKeyword
    || value.kind === ts.SyntaxKind.NullKeyword
  ) return true;
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(element => ts.isExpression(element) && isStaticDataLiteral(element));
  }
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.every(property => (
    ts.isPropertyAssignment(property)
    && propertyNameText(property.name) !== null
    && isStaticDataLiteral(property.initializer)
  ));
}

export function isAllowedGeneratedSchemaExpression(expression: ts.Expression): boolean {
  const value = unwrapGeneratedExpression(expression);
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const receiver = unwrapGeneratedExpression(value.expression.expression);
  const method = value.expression.name.text;

  if (ts.isIdentifier(receiver) && receiver.text === 'z') {
    if (['string', 'number', 'boolean', 'any'].includes(method)) return value.arguments.length === 0;
    if (method === 'array' || method === 'record') {
      return value.arguments.length === 1 && isAllowedGeneratedSchemaExpression(value.arguments[0]);
    }
    if (method !== 'object' || value.arguments.length !== 1) return false;
    const shape = unwrapGeneratedExpression(value.arguments[0]);
    return ts.isObjectLiteralExpression(shape) && shape.properties.every(property => (
      ts.isPropertyAssignment(property)
      && propertyNameText(property.name) !== null
      && isAllowedGeneratedSchemaExpression(property.initializer)
    ));
  }

  return method === 'describe'
    && value.arguments.length === 1
    && ts.isStringLiteral(value.arguments[0])
    && isAllowedGeneratedSchemaExpression(receiver);
}

export function getSingleConstInitializer(statement: ts.Statement | undefined, name: string): ts.Expression | null {
  if (!statement || !ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) return null;
  if (statement.declarationList.declarations.length !== 1) return null;
  const declaration = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) return null;
  return declaration.initializer;
}

export function isIdentifierCall(expression: ts.Expression, name: string): expression is ts.CallExpression {
  const value = unwrapGeneratedExpression(expression);
  return ts.isCallExpression(value)
    && ts.isIdentifier(value.expression)
    && value.expression.text === name
    && value.arguments.length === 0;
}

export function isAwaitedIdentifierCall(statement: ts.Statement | undefined, name: string): boolean {
  if (!statement || !ts.isExpressionStatement(statement)) return false;
  const expression = unwrapGeneratedExpression(statement.expression);
  return ts.isAwaitExpression(expression) && isIdentifierCall(expression.expression, name);
}

export function isExactToolResultReturn(statement: ts.Statement): boolean {
  if (!ts.isReturnStatement(statement) || !statement.expression) return false;
  const resultObject = unwrapGeneratedExpression(statement.expression);
  if (!ts.isObjectLiteralExpression(resultObject) || resultObject.properties.length !== 1) return false;
  const content = resultObject.properties[0];
  if (!ts.isPropertyAssignment(content) || propertyNameText(content.name) !== 'content') return false;
  const contentArray = unwrapGeneratedExpression(content.initializer);
  if (!ts.isArrayLiteralExpression(contentArray) || contentArray.elements.length !== 1) return false;
  const item = unwrapGeneratedExpression(contentArray.elements[0] as ts.Expression);
  if (!ts.isObjectLiteralExpression(item) || item.properties.length !== 2) return false;
  const values = new Map<string, ts.Expression>();
  for (const property of item.properties) {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = propertyNameText(property.name);
    if (!name) return false;
    values.set(name, property.initializer);
  }
  const typeValue = values.get('type');
  const textValue = values.get('text');
  return Boolean(
    typeValue
    && ts.isStringLiteral(unwrapGeneratedExpression(typeValue))
    && (unwrapGeneratedExpression(typeValue) as ts.StringLiteral).text === 'text'
    && textValue
    && ts.isIdentifier(unwrapGeneratedExpression(textValue))
    && (unwrapGeneratedExpression(textValue) as ts.Identifier).text === 'result'
  );
}

export function constantGeneratedString(node: ts.Expression): string | null {
  const value = unwrapGeneratedExpression(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantGeneratedString(value.left);
    const right = constantGeneratedString(value.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

export function generatedSkillStringIsDangerous(value: string): boolean {
  const normalized = value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
  return GENERATED_SKILL_DANGEROUS_STRING_FRAGMENTS.some(fragment => normalized.includes(fragment));
}
