import * as ts from "typescript";
import { unwrapGeneratedExpression, generatedSkillStringIsDangerous, generatedSkillFinding, propertyNameText } from './syntax';
import { GENERATED_SKILL_FORBIDDEN_PROPERTIES, GENERATED_SKILL_PURE_GLOBAL_VALUES, GENERATED_SKILL_FORBIDDEN_IDENTIFIERS, GENERATED_SKILL_NON_FIRST_CLASS_GLOBALS, GENERATED_SKILL_PURE_STATIC_VALUES, GENERATED_SKILL_PURE_GLOBAL_CALLS, GENERATED_SKILL_PURE_STATIC_CALLS, GENERATED_SKILL_PURE_INSTANCE_CALLS } from './authoring_contract';

export class GeneratedCallbackScope extends Set<string> {
  readonly functions: Set<string>;
  constructor(parent: Iterable<string> = []) {
    super(parent);
    this.functions = new Set(parent instanceof GeneratedCallbackScope ? parent.functions : []);
  }
}

export function isGeneratedStaticDataAccess(node: ts.ElementAccessExpression): boolean {
  const key = node.argumentExpression && unwrapGeneratedExpression(node.argumentExpression);
  if (!key) return false;
  if (ts.isNumericLiteral(key)) return Number.isSafeInteger(Number(key.text)) && Number(key.text) >= 0;
  return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
    && !GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(key.text)
    && !generatedSkillStringIsDangerous(key.text);
}

export function isGeneratedLocalWriteTarget(expression: ts.Expression, scope: Set<string>): boolean {
  const value = unwrapGeneratedExpression(expression);
  if (ts.isIdentifier(value)) return scope.has(value.text);
  if (ts.isPropertyAccessExpression(value)) {
    if (GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(value.name.text)) return false;
    return isGeneratedLocalWriteTarget(value.expression, scope);
  }
  return false;
}

export function isGeneratedAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

export function addGeneratedBindingNames(
  name: ts.BindingName,
  scope: GeneratedCallbackScope,
  findings: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    if (GENERATED_SKILL_PURE_GLOBAL_VALUES.has(name.text) || GENERATED_SKILL_FORBIDDEN_IDENTIFIERS.has(name.text)) {
      generatedSkillFinding(findings, `Generated skill callback cannot shadow reserved binding ${name.text}.`);
      return;
    }
    scope.functions.delete(name.text);
    scope.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      generatedSkillFinding(findings, 'Computed binding properties are not allowed in generated skill callbacks.');
    }
    addGeneratedBindingNames(element.name, scope, findings);
  }
}

export function validateGeneratedCallbackExpression(
  expression: ts.Expression,
  scope: GeneratedCallbackScope,
  findings: Set<string>,
): void {
  const value = unwrapGeneratedExpression(expression);
  if (
    ts.isStringLiteral(value)
    || ts.isNoSubstitutionTemplateLiteral(value)
  ) {
    if (generatedSkillStringIsDangerous(value.text)) {
      generatedSkillFinding(findings, 'Generated skill callback contains a dangerous constant string.');
    }
    return;
  }
  if (
    ts.isNumericLiteral(value)
    || ts.isRegularExpressionLiteral(value)
    || value.kind === ts.SyntaxKind.TrueKeyword
    || value.kind === ts.SyntaxKind.FalseKeyword
    || value.kind === ts.SyntaxKind.NullKeyword
  ) return;
  if (ts.isIdentifier(value)) {
    if (
      !scope.has(value.text)
      && (
        !GENERATED_SKILL_PURE_GLOBAL_VALUES.has(value.text)
        || GENERATED_SKILL_NON_FIRST_CLASS_GLOBALS.has(value.text)
      )
    ) {
      generatedSkillFinding(findings, `Generated skill callback references non-whitelisted identifier ${value.text}.`);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      if (ts.isSpreadElement(element)) validateGeneratedCallbackExpression(element.expression, scope, findings);
      else validateGeneratedCallbackExpression(element as ts.Expression, scope, findings);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        validateGeneratedCallbackExpression(property.expression, scope, findings);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        validateGeneratedCallbackExpression(property.name, scope, findings);
        continue;
      }
      if (!ts.isPropertyAssignment(property) || propertyNameText(property.name) === null) {
        generatedSkillFinding(findings, 'Generated skill callback object literals may contain only plain data properties.');
        continue;
      }
      const propertyName = propertyNameText(property.name)!;
      if (GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(propertyName) || generatedSkillStringIsDangerous(propertyName)) {
        generatedSkillFinding(findings, `Generated skill callback cannot define dangerous property ${propertyName}.`);
      }
      validateGeneratedCallbackExpression(property.initializer, scope, findings);
    }
    return;
  }
  if (ts.isPropertyAccessExpression(value)) {
    if (GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(value.name.text)) {
      generatedSkillFinding(findings, `Generated skill callback cannot access escape property ${value.name.text}.`);
    }
    const receiver = unwrapGeneratedExpression(value.expression);
    if (
      ts.isIdentifier(receiver)
      && !scope.has(receiver.text)
      && GENERATED_SKILL_PURE_GLOBAL_VALUES.has(receiver.text)
    ) {
      if (GENERATED_SKILL_PURE_STATIC_VALUES[receiver.text]?.has(value.name.text) !== true) {
        generatedSkillFinding(findings, 'Generated skill callback cannot extract methods or unknown properties from global objects.');
      }
      return;
    }
    validateGeneratedCallbackExpression(receiver, scope, findings);
    return;
  }
  if (ts.isElementAccessExpression(value)) {
    if (!isGeneratedStaticDataAccess(value)) generatedSkillFinding(findings, 'Computed property access is not allowed in generated skill callbacks: ' + value.getText().slice(0, 120) + '. Use a fixed safe key or .at(index) for array reads.');
    validateGeneratedCallbackExpression(value.expression, scope, findings);
    if (value.argumentExpression) validateGeneratedCallbackExpression(value.argumentExpression, scope, findings);
    return;
  }
  if (ts.isCallExpression(value)) {
    let allowed = false;
    const callee = unwrapGeneratedExpression(value.expression);
    if (ts.isIdentifier(callee)) {
      allowed = scope.functions.has(callee.text)
        || (!scope.has(callee.text) && GENERATED_SKILL_PURE_GLOBAL_CALLS.has(callee.text));
    } else if (ts.isPropertyAccessExpression(callee)) {
      const receiver = unwrapGeneratedExpression(callee.expression);
      const method = callee.name.text;
      if (ts.isRegularExpressionLiteral(receiver) && method === 'test') allowed = true;
      if (ts.isIdentifier(receiver) && !scope.has(receiver.text)) {
        allowed = GENERATED_SKILL_PURE_STATIC_CALLS[receiver.text]?.has(method) === true;
      }
      if (!allowed && GENERATED_SKILL_PURE_INSTANCE_CALLS.has(method)) {
        allowed = true;
        validateGeneratedCallbackExpression(receiver, scope, findings);
      }
    }
    if (!allowed) {
      generatedSkillFinding(findings, 'Generated skill callback contains a non-whitelisted function or method call: ' + callee.getText().slice(0, 120));
      validateGeneratedCallbackExpression(callee, scope, findings);
    }
    for (const argument of value.arguments) {
      validateGeneratedCallbackExpression(
        ts.isSpreadElement(argument) ? argument.expression : argument,
        scope,
        findings,
      );
    }
    return;
  }
  if (ts.isNewExpression(value)) {
    generatedSkillFinding(findings, 'Generated skill callback cannot construct objects with new.');
    if (value.arguments) {
      value.arguments.forEach(argument => validateGeneratedCallbackExpression(argument, scope, findings));
    }
    return;
  }
  if (ts.isTaggedTemplateExpression(value)) {
    generatedSkillFinding(findings, 'Tagged templates are not allowed in generated skill callbacks.');
    return;
  }
  if (ts.isArrowFunction(value)) {
    if (value.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      generatedSkillFinding(findings, 'Nested async callbacks are not allowed in generated skill callbacks.');
    }
    const childScope = new GeneratedCallbackScope(scope);
    for (const parameter of value.parameters) {
      addGeneratedBindingNames(parameter.name, childScope, findings);
      if (parameter.initializer) validateGeneratedCallbackExpression(parameter.initializer, scope, findings);
    }
    if (ts.isBlock(value.body)) validateGeneratedCallbackStatements(value.body.statements, childScope, findings);
    else validateGeneratedCallbackExpression(value.body, childScope, findings);
    return;
  }
  if (ts.isBinaryExpression(value)) {
    if (
      value.operatorToken.kind === ts.SyntaxKind.InKeyword
      || value.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      generatedSkillFinding(findings, 'Reflection-style binary operators are not allowed in generated skill callbacks.');
    }
    if (isGeneratedAssignmentOperator(value.operatorToken.kind) && !isGeneratedLocalWriteTarget(value.left, scope)) {
      generatedSkillFinding(findings, 'Generated skill callback assignments may target only local data.');
    }
    validateGeneratedCallbackExpression(value.left, scope, findings);
    validateGeneratedCallbackExpression(value.right, scope, findings);
    return;
  }
  if (ts.isDeleteExpression(value)) {
    generatedSkillFinding(findings, 'delete is not allowed in generated skill callbacks.');
    validateGeneratedCallbackExpression(value.expression, scope, findings);
    return;
  }
  if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) {
    if (
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(value.operator)
      && !isGeneratedLocalWriteTarget(value.operand, scope)
    ) {
      generatedSkillFinding(findings, 'Generated skill callback updates may target only local data.');
    }
    validateGeneratedCallbackExpression(value.operand, scope, findings);
    return;
  }
  if (ts.isConditionalExpression(value)) {
    validateGeneratedCallbackExpression(value.condition, scope, findings);
    validateGeneratedCallbackExpression(value.whenTrue, scope, findings);
    validateGeneratedCallbackExpression(value.whenFalse, scope, findings);
    return;
  }
  if (ts.isTemplateExpression(value)) {
    if (generatedSkillStringIsDangerous(value.head.text)) {
      generatedSkillFinding(findings, 'Generated skill callback contains a dangerous constant string.');
    }
    value.templateSpans.forEach(span => {
      validateGeneratedCallbackExpression(span.expression, scope, findings);
      if (generatedSkillStringIsDangerous(span.literal.text)) {
        generatedSkillFinding(findings, 'Generated skill callback contains a dangerous constant string.');
      }
    });
    return;
  }
  if (ts.isTypeOfExpression(value) || ts.isVoidExpression(value)) {
    validateGeneratedCallbackExpression(value.expression, scope, findings);
    return;
  }
  if (ts.isAwaitExpression(value) || ts.isYieldExpression(value)) {
    generatedSkillFinding(findings, 'Async suspension is not allowed in pure generated skill callbacks.');
    if (value.expression) validateGeneratedCallbackExpression(value.expression, scope, findings);
    return;
  }
  if (ts.isCommaListExpression(value)) {
    value.elements.forEach(element => validateGeneratedCallbackExpression(element, scope, findings));
    return;
  }

  generatedSkillFinding(
    findings,
    `Generated skill callback contains unsupported expression ${ts.SyntaxKind[value.kind] || value.kind}.`,
  );
}

export function validateGeneratedVariableDeclarationList(
  declarationList: ts.VariableDeclarationList,
  scope: GeneratedCallbackScope,
  findings: Set<string>,
): void {
  for (const declaration of declarationList.declarations) {
    const pureHelper = Boolean((declarationList.flags & ts.NodeFlags.Const)
      && ts.isIdentifier(declaration.name) && declaration.initializer
      && ts.isArrowFunction(unwrapGeneratedExpression(declaration.initializer)));
    const findingsBefore = findings.size;
    if (declaration.initializer) {
      const initializerScope = new GeneratedCallbackScope(scope);
      // Prevent a shadowed recursive binding from resolving to an outer helper.
      if (ts.isIdentifier(declaration.name) && ts.isArrowFunction(unwrapGeneratedExpression(declaration.initializer))) {
        initializerScope.delete(declaration.name.text);
        initializerScope.functions.delete(declaration.name.text);
      }
      validateGeneratedCallbackExpression(declaration.initializer, initializerScope, findings);
    }
    addGeneratedBindingNames(declaration.name, scope, findings);
    if (pureHelper && findings.size === findingsBefore && ts.isIdentifier(declaration.name)) scope.functions.add(declaration.name.text);
  }
}

export function validateGeneratedCallbackStatement(
  statement: ts.Statement,
  scope: GeneratedCallbackScope,
  findings: Set<string>,
): void {
  if (ts.isVariableStatement(statement)) {
    validateGeneratedVariableDeclarationList(statement.declarationList, scope, findings);
    return;
  }
  if (ts.isExpressionStatement(statement)) {
    validateGeneratedCallbackExpression(statement.expression, scope, findings);
    return;
  }
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    if (statement.expression) validateGeneratedCallbackExpression(statement.expression, scope, findings);
    return;
  }
  if (ts.isIfStatement(statement)) {
    validateGeneratedCallbackExpression(statement.expression, scope, findings);
    validateGeneratedCallbackStatement(statement.thenStatement, new GeneratedCallbackScope(scope), findings);
    if (statement.elseStatement) {
      validateGeneratedCallbackStatement(statement.elseStatement, new GeneratedCallbackScope(scope), findings);
    }
    return;
  }
  if (ts.isBlock(statement)) {
    validateGeneratedCallbackStatements(statement.statements, new GeneratedCallbackScope(scope), findings);
    return;
  }
  if (
    ts.isForOfStatement(statement)
    || ts.isForInStatement(statement)
    || ts.isForStatement(statement)
    || ts.isWhileStatement(statement)
    || ts.isDoStatement(statement)
  ) {
    generatedSkillFinding(
      findings,
      'Generated skill callbacks cannot contain loops; use bounded pure array transforms instead.',
    );
    return;
  }
  if (
    ts.isBreakStatement(statement)
    || ts.isContinueStatement(statement)
    || ts.isEmptyStatement(statement)
  ) return;

  generatedSkillFinding(
    findings,
    `Generated skill callback contains unsupported statement ${ts.SyntaxKind[statement.kind] || statement.kind}.`,
  );
}

export function validateGeneratedCallbackStatements(
  statements: readonly ts.Statement[],
  initialScope: GeneratedCallbackScope,
  findings: Set<string>,
): void {
  const scope = new GeneratedCallbackScope(initialScope);
  const hideBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      scope.delete(name.text);
      scope.functions.delete(name.text);
    } else for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) hideBinding(element.name);
    }
  };
  // Lexical shadows apply to the whole block, including closures declared
  // before the shadow. Do not misclassify a forward cycle as an outer call.
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach(declaration => hideBinding(declaration.name));
    }
  }
  for (const statement of statements) {
    validateGeneratedCallbackStatement(statement, scope, findings);
  }
}
