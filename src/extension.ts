import * as vscode from 'vscode';
import { toggleLogs } from './decorator';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'lazydebugger.toggle',
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
