import { useEffect, useRef } from 'react';
import { useMantineColorScheme } from '@mantine/core';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';

function languageFor(path: string): Extension[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) return [html()];
  if (ext === 'css') return [css()];
  if (['js', 'mjs', 'cjs'].includes(ext)) return [javascript()];
  if (ext === 'ts') return [javascript({ typescript: true })];
  if (['json', 'webmanifest'].includes(ext)) return [json(), linter(jsonParseLinter()), lintGutter()];
  return [];
}

const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#0e1829', color: '#e6eaf0' },
    '.cm-content': { caretColor: '#e8a93a' },
    '.cm-gutters': { backgroundColor: '#0b1626', color: '#6b7891', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#13213a' },
    '.cm-activeLineGutter': { backgroundColor: '#13213a' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#2c4466 !important' },
  },
  { dark: true },
);

/** Éditeur de code (CodeMirror 6) : coloration, numéros de ligne, contrôle du JSON, raccourci Ctrl/Cmd+S. */
export function CodeEditor({ path, value, onChange, onSave, readOnly }: { path: string; value: string; onChange: (v: string) => void; onSave?: () => void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const { colorScheme } = useMantineColorScheme();

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          ...languageFor(path),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!readOnly),
          colorScheme === 'dark' ? darkTheme : [],
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                cb.current.onSave?.();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': `Contenu du fichier ${path}`, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly, colorScheme]);

  // Remplacement du contenu depuis l'extérieur (rechargement).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div className="pg-editeur-code" ref={host} />;
}
