import * as vscode from 'vscode';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import template from '@babel/template';
import generate from '@babel/generator';
import { parse, ParserPlugin } from '@babel/parser';

const plugins: ParserPlugin[] = [
  'typescript',
  'doExpressions',
  'objectRestSpread',
  'dynamicImport',
  ['decorators', { decoratorsBeforeExport: true }],
  'classProperties',
  'asyncGenerators',
  'functionBind',
  'functionSent',
  'optionalChaining',
  'nullishCoalescingOperator',
  'jsx',
];

export function toggleLogs(
  editor: vscode.TextEditor,
  text: string,
  cursorPosition: number
) {
  const ast = generateAST(text);
  const enclosingFunction = findEnclosingFunction(ast, cursorPosition);
  if (shouldDecorate(enclosingFunction)) {
    addLogs(enclosingFunction);
  } else {
    removeLogs(enclosingFunction);
  }
  const code = generateCode(ast);
  setContent(editor, code);
}

function shouldDecorate(enclosingFunction: t.Function) {
  // TODO: support body-less arrow functions
  const body: any = enclosingFunction.body;
  const firstExpression = body.body[0];
  return !isPluginConsoleLogStatement(firstExpression);
}

function isPluginConsoleLogStatement(statement: any) {
  return (
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression) &&
    t.isMemberExpression(statement.expression.callee) &&
    t.isIdentifier(statement.expression.callee.object) &&
    statement.expression.callee.object.name === 'console' &&
    t.isIdentifier(statement.expression.callee.property) &&
    statement.expression.callee.property.name === 'log' &&
    t.isStringLiteral(statement.expression.arguments[0]) &&
    /\*\*\w+ - (?:\d+|START|FINISH)/.test(
      statement.expression.arguments[0].value
    )
  );
}

function addLogs(enclosingFunction: t.Function) {
  // TODO: support body-less arrow functions
  const body: any = enclosingFunction.body;
  body.body = createDecoratedBodyAST(body.body);
}

function removeLogs(enclosingFunction: t.Function) {
  const body: any = enclosingFunction.body;
  body.body = createUndecoratedBodyAST(body.body);
}

function generateAST(text: string) {
  return parse(text, {
    sourceType: 'module',
    plugins,
  });
}

function generateCode(ast: t.File) {
  return generate(ast, {}, '').code;
}

function setContent(editor: vscode.TextEditor, code: string) {
  editor.edit((selectedText) => {
    selectedText.replace(
      new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(editor.document.lineCount, 10000)
      ),
      code
    );
  });
}

function findEnclosingFunction(
  ast: t.File,
  cursorPosition: number
): t.Function {
  const relevantFunctions: any[] = [];
  (traverse as any)(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(
      path: any
    ) {
      const start = path.node.loc.start.line;
      const end = path.node.loc.end.line;
      if (cursorPosition >= start && cursorPosition <= end) {
        relevantFunctions.push({ path, start, end });
      }
    },
  });
  const enclosingFunction = relevantFunctions.sort(
    (a, b) => b.start - a.start
  )[0];

  return enclosingFunction.path.node;
}

function createDecoratedBodyAST(body: t.Statement[]) {
  const newBody = [];
  let idx = 0;
  for (let row of body) {
    const buildLog = template(`console.log(%%idx%%);`);
    const text = `**NAME - ${idx === 0 ? 'START' : idx}`;
    const logAst = buildLog({
      idx: t.stringLiteral(text),
    });
    idx++;
    newBody.push(logAst, row);
  }
  newBody.push(
    template(`console.log(%%finish%%);`)({
      finish: t.stringLiteral(`**NAME - FINISH`),
    })
  );

  return newBody;
}

function createUndecoratedBodyAST(body: t.Statement[]) {
  const newBody = [];
  for (let row of body) {
    if (!isPluginConsoleLogStatement(row)) {
      newBody.push(row);
    }
  }
  return newBody;
}
