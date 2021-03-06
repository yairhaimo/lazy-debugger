import * as vscode from 'vscode';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import template from '@babel/template';
import generate from '@babel/generator';
import { parse, ParserPlugin } from '@babel/parser';
import { basename } from 'path';
import flattenDeep from 'lodash/flattenDeep';

const LAZY_RESULT = '__lazyResult';
const PLUGINS: ParserPlugin[] = [
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
  const enclosingFunctionPath = findEnclosingFunction(ast, cursorPosition);
  const name = getFunctionNameByType(enclosingFunctionPath);
  if (shouldDecorate(enclosingFunctionPath.node, name)) {
    addLogs(enclosingFunctionPath.node, name);
  } else {
    removeLogs(enclosingFunctionPath.node, name);
  }
  const code = generateCode(ast);
  setContent(editor, code);
}

function shouldDecorate(enclosingFunction: t.Function, name: string) {
  const body: any = enclosingFunction.body;
  const firstExpression = body.body[0];
  return !isPluginConsoleLogStatement(firstExpression, name);
}

function isPluginConsoleLogStatement(statement: any, name: string) {
  return (
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression) &&
    t.isMemberExpression(statement.expression.callee) &&
    t.isIdentifier(statement.expression.callee.object) &&
    statement.expression.callee.object.name === 'console' &&
    t.isIdentifier(statement.expression.callee.property) &&
    statement.expression.callee.property.name === 'log' &&
    t.isStringLiteral(statement.expression.arguments[0]) &&
    new RegExp(`\\*\\*${name} - (?:\\d+|START|FINISH)`).test(
      statement.expression.arguments[0].value
    )
  );
}

function addLogs(enclosingFunction: t.Function, name: string) {
  const body: any = enclosingFunction.body;
  body.body = createDecoratedBodyAST(body.body, name, enclosingFunction.params);
}

function removeLogs(enclosingFunction: t.Function, name: string) {
  const body: any = enclosingFunction.body;
  const newBody = removeLazyResultReturn(
    createUndecoratedBodyAST(body.body, name)
  );
  if (
    t.isArrowFunctionExpression(enclosingFunction) &&
    newBody.length === 1 &&
    t.isReturnStatement(newBody[0])
  ) {
    enclosingFunction.body = newBody[0].argument as any;
  } else {
    body.body = newBody;
  }
}

function removeLazyResultReturn(body: any[]) {
  const [beforeLastStatement, lastStatement] = body.slice(-2);
  if (
    t.isVariableDeclaration(beforeLastStatement) &&
    (beforeLastStatement.declarations[0]?.id as any).name === LAZY_RESULT &&
    t.isReturnStatement(lastStatement)
  ) {
    return [
      ...body.slice(0, body.length - 2),
      t.returnStatement((beforeLastStatement.declarations[0] as any).init),
    ];
  }
  return body;
}

function generateAST(text: string) {
  return parse(text, {
    sourceType: 'module',
    plugins: PLUGINS,
  });
}

function generateCode(ast: t.File) {
  return generate(ast, {}, '').code;
}

function setContent(editor: vscode.TextEditor, code: string) {
  editor.edit((selectedText) => {
    // TODO: use   selectedText.insert(new vscode.Position(0, 0), "TEXT");
    // for each line in the function, starting from the last.
    // this will reduce jankiness
    selectedText.replace(
      new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(editor.document.lineCount, Number.MAX_VALUE)
      ),
      code
    );
  });
}

function findEnclosingFunction(ast: t.File, cursorPosition: number): any {
  const relevantFunctions: any[] = [];
  (traverse as any)(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod'(
      path: any
    ) {
      const start = path.node.loc.start.line;
      const end = path.node.loc.end.line;
      if (cursorPosition >= start && cursorPosition <= end) {
        relevantFunctions.push({ path, start, end });
      }
    },
  });
  // get the function scope most close to the current line
  const enclosingFunction = relevantFunctions.sort(
    (a, b) => b.start - a.start
  )[0];
  const node = enclosingFunction.path.node;
  const body = Array.isArray(node.body.body)
    ? t.blockStatement(node.body.body)
    : t.blockStatement([t.returnStatement(node.body)]);
  enclosingFunction.path.node.body = body;
  return enclosingFunction.path;
}

function extractParams(params: any[]): any[] {
  if (!params) {
    return [];
  }
  const res = params
    .map((param) => {
      if (t.isIdentifier(param)) {
        return param;
      }
      if (t.isObjectProperty(param)) {
        return param.value;
      }
      if (t.isRestElement(param)) {
        return param.argument;
      }
      if (t.isObjectPattern(param)) {
        return extractParams(param.properties);
      }
      if (t.isArrayPattern(param)) {
        return extractParams(param.elements);
      }
      console.warn('couldnt parse param', param);
    })
    .filter(Boolean);
  return flattenDeep(res);
}

function createConsoleLog(
  name: string,
  idx: number | 'START' | 'END',
  params?: any
) {
  const extractedParams = extractParams(params);
  const buildLog = template(`console.log(%%label%%, %%params%%);`);
  const text = `**${name} - ${idx === 0 ? 'START' : idx}`;
  const logAst = buildLog({
    label: t.stringLiteral(text),
    params: params
      ? t.objectExpression(
          extractedParams.map((p) => t.objectProperty(p, p, false, true))
        )
      : [],
  });
  return logAst;
}

function createDecoratedBodyAST(
  body: t.Statement[],
  name: string,
  params: any[]
) {
  const newBody = [];
  let idx = 0;
  for (let row of body) {
    const logAst = createConsoleLog(
      name,
      idx === 0 ? 'START' : idx,
      idx === 0 ? params : undefined
    );
    idx++;
    newBody.push(logAst, row);
  }
  if (t.isReturnStatement(newBody.slice(-1)[0])) {
    const returnStatement = newBody.pop() as t.ReturnStatement;
    const variable = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier(LAZY_RESULT),
        returnStatement.argument as any
      ),
    ]);
    newBody.push(
      variable,
      template(`console.log(%%finish%%);`)({
        finish: t.stringLiteral(`**${name} - FINISH`),
      }),
      t.returnStatement(variable.declarations[0].id as any)
    );
  } else {
    newBody.push(
      template(`console.log(%%finish%%);`)({
        finish: t.stringLiteral(`**${name} - FINISH`),
      })
    );
  }

  return newBody;
}

function createUndecoratedBodyAST(body: t.Statement[], name: string) {
  const newBody = [];
  for (let row of body) {
    if (!isPluginConsoleLogStatement(row, name)) {
      newBody.push(row);
    }
  }
  return newBody;
}

export function getFunctionNameByType(path: any): string {
  switch (path.node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return getFunctionDeclarationName(path);
    case 'ObjectMethod':
    case 'ClassMethod':
      return path.node.key.name;
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return getFunctionExpressionName(path);
    default:
      return '';
  }
}

function getFunctionDeclarationName(path: any): string {
  if (t.isExportDefaultDeclaration(path.parent)) {
    const fileName = basename(
      vscode.window.activeTextEditor?.document.fileName ?? ''
    ).replace(/\.[tj]sx?/, '');
    return `${fileName ? `${fileName}-` : ''}default-export`;
  }
  return path.node.id.name;
}

function getFunctionExpressionName(path: any) {
  if (t.isArrowFunctionExpression(path.parent)) {
    return 'anon';
  } else if (t.isVariableDeclarator(path.parent)) {
    return path.parent.id.name;
  } else if (isPromiseCallback(path)) {
    const promiseFunc = path.parent.callee.object;
    // support dynamic imports
    if (t.isImport(promiseFunc.callee)) {
      return `import-then`;
    }
    return getMemberExpressionName(path.parent.callee.object.callee) + '-then';
  } else if (isInlineCallback(path)) {
    return getMemberExpressionName(path.parent.callee) + '-callback';
  } else if (path.key === 'value') {
    return (
      path?.container?.value?.id?.name ??
      path?.container?.key?.name ??
      path?.container?.key?.value
    );
  } else if (path?.scope?.parentBlock?.id) {
    return path.scope.parentBlock.id.name;
  } else {
    return 'anon';
  }
}

function isPromiseCallback(path: any) {
  return path.parent.callee?.property?.name === 'then';
}

function getMemberExpressionName(node: any): string {
  const name = [];
  if (t.isMemberExpression(node)) {
    name.push(getMemberExpressionName(node.object));
  }
  if (t.isCallExpression(node)) {
    name.push(getMemberExpressionName(node.callee));
  } else if (t.isIdentifier(node)) {
    name.push(node.name);
  }

  if (node && t.isIdentifier(node.property)) {
    name.push(node.property.name);
  }

  return name.join('.');
}

function isInlineCallback(path: any) {
  return path?.parentKey === 'arguments';
}
