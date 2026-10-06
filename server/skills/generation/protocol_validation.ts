import * as ts from "typescript";
import { generatedSkillFinding, importBindingMatches, getSingleConstInitializer, isAllowedGeneratedSchemaExpression, isAwaitedIdentifierCall, unwrapGeneratedExpression, isStaticDataLiteral, propertyNameText, constantGeneratedString, generatedSkillStringIsDangerous, isExactToolResultReturn } from './syntax';
import { GENERATED_SKILL_IMPORTS, GENERATED_SKILL_FORBIDDEN_PROPERTIES, GENERATED_SKILL_FORBIDDEN_IDENTIFIERS } from './authoring_contract';
import { isGeneratedStaticDataAccess, validateGeneratedCallbackStatements, GeneratedCallbackScope } from './callback_validation';

export function validateGeneratedSkillProtocolStructure(source: string, expectedToolName?: string): string[] {
  const findings = new Set<string>();
  if (!source.trim() || Buffer.byteLength(source, 'utf8') > 512 * 1024) {
    return ['Generated skill source must be non-empty and no larger than 512 KiB.'];
  }
  if (source.includes('\0')) {
    generatedSkillFinding(findings, 'Generated skill source cannot contain null bytes.');
  }

  const sourceFile = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics || [];
  if (parseDiagnostics.length > 0) {
    generatedSkillFinding(findings, 'Generated skill source is not valid TypeScript syntax.');
    for (const diagnostic of parseDiagnostics.slice(0, 3)) {
      const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start || 0);
      const line = source.split(/\r?\n/u)[location.line] || '';
      generatedSkillFinding(findings, `TypeScript ${diagnostic.code} at ${location.line + 1}:${location.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} Source excerpt (data only): ${JSON.stringify(line.slice(0, 180))}`);
    }
    return [...findings];
  }

  if (sourceFile.statements.length !== 6) {
    generatedSkillFinding(findings, 'Generated skill source contains unexpected top-level statements.');
  }
  for (let index = 0; index < GENERATED_SKILL_IMPORTS.length; index += 1) {
    const expected = GENERATED_SKILL_IMPORTS[index];
    if (!importBindingMatches(sourceFile.statements[index], expected[0], expected[1])) {
      generatedSkillFinding(findings, 'Generated skill imports must be exactly the three fixed MCP/Zod modules.');
    }
  }
  if (sourceFile.statements.some((statement, index) => index >= 3 && ts.isImportDeclaration(statement))) {
    generatedSkillFinding(findings, 'Generated skill imports must be exactly the three fixed MCP/Zod modules.');
  }

  const schemaInitializer = getSingleConstInitializer(sourceFile.statements[3], 'inputSchema');
  if (!schemaInitializer || !isAllowedGeneratedSchemaExpression(schemaInitializer)) {
    generatedSkillFinding(findings, 'Generated skill inputSchema must be a generator-owned Zod data schema.');
  }

  const mainStatement = sourceFile.statements[4];
  const mainFunction = mainStatement && ts.isFunctionDeclaration(mainStatement) ? mainStatement : null;
  const mainIsAsync = Boolean(
    mainFunction
    && mainFunction.name?.text === 'main'
    && mainFunction.parameters.length === 0
    && mainFunction.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    && mainFunction.body
  );
  if (!mainIsAsync) {
    generatedSkillFinding(findings, 'Generated skill protocol envelope must contain the expected async main function.');
  }
  if (!isAwaitedIdentifierCall(sourceFile.statements[5], 'main')) {
    generatedSkillFinding(findings, 'Generated skill protocol envelope must end with exactly await main().');
  }

  let callback: ts.ArrowFunction | null = null;
  let callbackBody: ts.Block | null = null;
  if (mainIsAsync && mainFunction?.body) {
    const statements = mainFunction.body.statements;
    if (statements.length !== 4) {
      generatedSkillFinding(findings, 'Generated skill main function contains unexpected statements.');
    }

    const serverInitializer = getSingleConstInitializer(statements[0], 'server');
    const serverValue = serverInitializer ? unwrapGeneratedExpression(serverInitializer) : null;
    if (
      !serverValue
      || !ts.isNewExpression(serverValue)
      || !ts.isIdentifier(serverValue.expression)
      || serverValue.expression.text !== 'McpServer'
      || serverValue.arguments?.length !== 2
      || !serverValue.arguments.every(isStaticDataLiteral)
    ) {
      generatedSkillFinding(findings, 'Generated skill main function must construct only the expected MCP server envelope.');
    }

    const registerStatement = statements[1];
    if (registerStatement && ts.isExpressionStatement(registerStatement)) {
      const expression = unwrapGeneratedExpression(registerStatement.expression);
      if (
        ts.isCallExpression(expression)
        && ts.isPropertyAccessExpression(expression.expression)
        && ts.isIdentifier(expression.expression.expression)
        && expression.expression.expression.text === 'server'
        && expression.expression.name.text === 'registerTool'
        && expression.arguments.length === 3
        && ts.isStringLiteral(expression.arguments[0])
        && (!expectedToolName || expression.arguments[0].text === expectedToolName)
      ) {
        const registration = unwrapGeneratedExpression(expression.arguments[1]);
        const handler = unwrapGeneratedExpression(expression.arguments[2]);
        if (ts.isObjectLiteralExpression(registration)) {
          const fields = new Map<string, ts.ObjectLiteralElementLike>();
          for (const property of registration.properties) {
            if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
              const name = propertyNameText(property.name);
              if (name) fields.set(name, property);
            }
          }
          const description = fields.get('description');
          const schema = fields.get('inputSchema');
          if (
            fields.size !== 2
            || !description
            || !ts.isPropertyAssignment(description)
            || !ts.isStringLiteral(unwrapGeneratedExpression(description.initializer))
            || !schema
            || !(
              ts.isShorthandPropertyAssignment(schema)
              || (ts.isPropertyAssignment(schema)
                && ts.isIdentifier(unwrapGeneratedExpression(schema.initializer))
                && (unwrapGeneratedExpression(schema.initializer) as ts.Identifier).text === 'inputSchema')
            )
          ) {
            generatedSkillFinding(findings, 'Generated skill tool registration metadata changed outside the reviewed envelope.');
          }
        } else {
          generatedSkillFinding(findings, 'Generated skill tool registration metadata changed outside the reviewed envelope.');
        }
        if (
          ts.isArrowFunction(handler)
          && Boolean(handler.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
          && handler.parameters.length === 1
          && ts.isIdentifier(handler.parameters[0].name)
          && handler.parameters[0].name.text === 'args'
          && ts.isBlock(handler.body)
        ) {
          callback = handler;
          callbackBody = handler.body;
        }
      }
    }
    if (!callback) {
      generatedSkillFinding(findings, 'Generated implementation must exist only inside the unique async server.registerTool callback.');
    }

    const transportInitializer = getSingleConstInitializer(statements[2], 'transport');
    const transportValue = transportInitializer ? unwrapGeneratedExpression(transportInitializer) : null;
    if (
      !transportValue
      || !ts.isNewExpression(transportValue)
      || !ts.isIdentifier(transportValue.expression)
      || transportValue.expression.text !== 'StdioServerTransport'
      || (transportValue.arguments?.length || 0) !== 0
    ) {
      generatedSkillFinding(findings, 'Generated skill main function must construct only the expected stdio transport.');
    }
    const connectStatement = statements[3];
    let exactConnect = false;
    if (connectStatement && ts.isExpressionStatement(connectStatement)) {
      const outer = unwrapGeneratedExpression(connectStatement.expression);
      if (ts.isAwaitExpression(outer)) {
        const call = unwrapGeneratedExpression(outer.expression);
        exactConnect = ts.isCallExpression(call)
          && ts.isPropertyAccessExpression(call.expression)
          && ts.isIdentifier(call.expression.expression)
          && call.expression.expression.text === 'server'
          && call.expression.name.text === 'connect'
          && call.arguments.length === 1
          && ts.isIdentifier(call.arguments[0])
          && call.arguments[0].text === 'transport';
      }
    }
    if (!exactConnect) {
      generatedSkillFinding(findings, 'Generated skill main function must contain only the expected transport connection.');
    }
  }

  let registerToolCalls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && !isGeneratedStaticDataAccess(node)) {
      generatedSkillFinding(findings, 'Computed property access is not allowed in generated skill drafts: ' + node.getText().slice(0, 120) + '. Use a fixed safe key or .at(index) for array reads.');
    }
    if (ts.isPropertyAccessExpression(node) && GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(node.name.text)) {
      generatedSkillFinding(findings, `Generated skill drafts cannot access escape property ${node.name.text}.`);
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node))
      && node.name
    ) {
      const name = propertyNameText(node.name);
      if (name && GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(name)) {
        generatedSkillFinding(findings, `Generated skill drafts cannot define escape property ${name}.`);
      }
    }
    if (ts.isIdentifier(node) && GENERATED_SKILL_FORBIDDEN_IDENTIFIERS.has(node.text)) {
      generatedSkillFinding(findings, `Generated skill drafts cannot use host entry ${node.text}.`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      generatedSkillFinding(findings, 'Dynamic imports are not allowed in generated skill drafts.');
    }
    if (ts.isImportTypeNode(node) || ts.isMetaProperty(node)) {
      generatedSkillFinding(findings, 'Generated skill drafts cannot access dynamic modules or import.meta.');
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'server'
      && node.expression.name.text === 'registerTool'
    ) {
      registerToolCalls += 1;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const folded = constantGeneratedString(node);
      if (
        folded
        && (
          GENERATED_SKILL_FORBIDDEN_IDENTIFIERS.has(folded)
          || GENERATED_SKILL_FORBIDDEN_PROPERTIES.has(folded)
          || generatedSkillStringIsDangerous(folded)
        )
      ) {
        generatedSkillFinding(findings, `Generated skill drafts cannot construct host entry ${folded}.`);
      }
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      generatedSkillFinding(findings, 'Generated skill drafts cannot use this or super as an escape surface.');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (registerToolCalls !== 1) {
    generatedSkillFinding(findings, 'Generated skill source must contain exactly one server.registerTool call.');
  }

  if (callback && callbackBody) {
    validateGeneratedCallbackStatements(
      callbackBody.statements,
      new GeneratedCallbackScope(['args']),
      findings,
    );
    const resultDeclarations = callbackBody.statements.flatMap(statement => (
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.filter(declaration => (
            ts.isIdentifier(declaration.name) && declaration.name.text === 'result'
          ))
        : []
    ));
    if (resultDeclarations.length !== 1) {
      generatedSkillFinding(findings, 'Generated skill callback must contain exactly one generator-owned result variable. Remove any const/let/var result declaration from the generated body; assign to the existing result variable instead.');
    }
    const finalStatement = callbackBody.statements[callbackBody.statements.length - 1];
    if (!finalStatement || !isExactToolResultReturn(finalStatement)) {
      generatedSkillFinding(findings, 'Generated skill callback must end with the expected text-content receipt.');
    }
    const forbiddenClosureNames = new Set(['server', 'transport', 'inputSchema', 'McpServer', 'StdioServerTransport']);
    const visitCallback = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && forbiddenClosureNames.has(node.text)) {
        generatedSkillFinding(findings, `Generated skill callback cannot access envelope binding ${node.text}.`);
      }
      ts.forEachChild(node, visitCallback);
    };
    callbackBody.statements.forEach(visitCallback);
  }

  return [...findings];
}
