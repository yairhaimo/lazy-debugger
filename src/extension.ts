import * as vscode from 'vscode';
import { toggleLogs } from './decorator';

export function activate(context: vscode.ExtensionContext) {
  console.log(`LAZY ACTIVATED`);
  const disposable = vscode.commands.registerCommand(
    'extension.lazydebugger',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const text = editor.document.getText();
        const cursorPosition = editor.selection.active.line + 1;
        toggleLogs(editor, text, cursorPosition);
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
