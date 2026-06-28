import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as editorPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

export const ChapterEditor = forwardRef(function ChapterEditor({
  value,
  placeholder,
  onChange,
  onSelectionChange,
  onContextMenu,
  onScroll,
  onSaveShortcut,
  jumpRange,
}, ref) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const mirrorRef = useRef(null);
  const contentRef = useRef(value || '');
  const jumpKeyRef = useRef('');
  const callbacksRef = useRef({
    onChange,
    onSelectionChange,
    onContextMenu,
    onScroll,
    onSaveShortcut,
  });

  useEffect(() => {
    callbacksRef.current = {
      onChange,
      onSelectionChange,
      onContextMenu,
      onScroll,
      onSaveShortcut,
    };
  }, [onChange, onContextMenu, onSaveShortcut, onScroll, onSelectionChange]);

  const extensions = useMemo(() => [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightSelectionMatches(),
    highlightActiveLine(),
    editorPlaceholder(placeholder || ''),
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          if (callbacksRef.current.onSaveShortcut) callbacksRef.current.onSaveShortcut();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      const view = update.view;
      if (update.docChanged) {
        const next = view.state.doc.toString();
        contentRef.current = next;
        if (callbacksRef.current.onChange) callbacksRef.current.onChange(next);
      }
      if (update.selectionSet || update.docChanged || update.focusChanged) {
        const main = view.state.selection.main;
        const start = Math.min(main.from, main.to);
        const end = Math.max(main.from, main.to);
        if (callbacksRef.current.onSelectionChange) {
          callbacksRef.current.onSelectionChange({
            start,
            end,
            text: view.state.doc.sliceString(start, end),
          });
        }
      }
    }),
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        const main = view.state.selection.main;
        const start = Math.min(main.from, main.to);
        const end = Math.max(main.from, main.to);
        if (callbacksRef.current.onContextMenu) {
          callbacksRef.current.onContextMenu(event, {
            start,
            end,
            text: view.state.doc.sliceString(start, end),
          });
        }
        return true;
      },
      scroll: (event) => {
        if (callbacksRef.current.onScroll) {
          const target = event.target;
          callbacksRef.current.onScroll({
            top: target?.scrollTop || 0,
            left: target?.scrollLeft || 0,
          });
        }
        return false;
      },
    }),
    EditorView.theme({
      '&': {
        height: '100%',
        color: '#d1d5db',
        backgroundColor: 'transparent',
        fontSize: '14px',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        lineHeight: '1.625',
        padding: '16px 0',
      },
      '.cm-content': {
        padding: '0 16px',
        caretColor: '#93c5fd',
      },
      '.cm-line': {
        padding: '0 2px',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: '#6b7280',
        borderRight: '1px solid rgba(75,85,99,0.35)',
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(59,130,246,0.08)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'rgba(59,130,246,0.12)',
        color: '#bfdbfe',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(96,165,250,0.32)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    }),
  ], [placeholder]);

  useEffect(() => {
    if (!hostRef.current || viewRef.current) return undefined;
    const view = new EditorView({
      state: EditorState.create({
        doc: value || '',
        extensions,
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    hostRef.current.__cmView = view;
    if (typeof window !== 'undefined') window.__manaChapterEditorView = view;
    contentRef.current = value || '';
    return () => {
      if (hostRef.current) delete hostRef.current.__cmView;
      if (typeof window !== 'undefined' && window.__manaChapterEditorView === view) delete window.__manaChapterEditorView;
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    const next = value || '';
    if (!view || view.state.doc.toString() === next) return;
    contentRef.current = next;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpRange) return;
    const key = `${jumpRange.start}:${jumpRange.end}:${jumpRange.nonce || ''}`;
    if (jumpKeyRef.current === key) return;
    jumpKeyRef.current = key;
    const docLength = view.state.doc.length;
    const start = Math.max(0, Math.min(Number(jumpRange.start) || 0, docLength));
    const end = Math.max(start, Math.min(Number(jumpRange.end) || start, docLength));
    view.focus();
    view.dispatch({
      selection: { anchor: start, head: end },
      effects: EditorView.scrollIntoView(start, { y: 'center' }),
    });
    if (onSelectionChange) {
      onSelectionChange({ start, end, text: view.state.doc.sliceString(start, end) });
    }
  }, [jumpRange, onSelectionChange]);

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    getValue() {
      return viewRef.current?.state.doc.toString() || contentRef.current || '';
    },
    getSelectionRange() {
      const view = viewRef.current;
      if (!view) return { start: 0, end: 0, text: '' };
      const main = view.state.selection.main;
      const start = Math.min(main.from, main.to);
      const end = Math.max(main.from, main.to);
      return { start, end, text: view.state.doc.sliceString(start, end) };
    },
    setSelectionRange(start, end) {
      const view = viewRef.current;
      if (!view) return;
      const docLength = view.state.doc.length;
      const from = Math.max(0, Math.min(start, docLength));
      const to = Math.max(from, Math.min(end, docLength));
      view.focus();
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
    },
  }), []);

  const syncMirrorContent = (nextValue) => {
    const next = String(nextValue || '');
    const view = viewRef.current;
    contentRef.current = next;
    if (!view) {
      if (callbacksRef.current.onChange) callbacksRef.current.onChange(next);
      return;
    }
    if (view.state.doc.toString() !== next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
  };

  const handleMirrorSelection = () => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    const start = mirror.selectionStart || 0;
    const end = mirror.selectionEnd || start;
    const view = viewRef.current;
    if (view) {
      const docLength = view.state.doc.length;
      const from = Math.max(0, Math.min(start, docLength));
      const to = Math.max(from, Math.min(end, docLength));
      view.dispatch({ selection: { anchor: from, head: to } });
    }
    if (!callbacksRef.current.onSelectionChange) return;
    callbacksRef.current.onSelectionChange({
      start,
      end,
      text: contentRef.current.substring(start, end),
    });
  };

  useEffect(() => {
    const mirror = mirrorRef.current;
    if (!mirror || mirror.__manaSelectionRangePatched) return undefined;
    const originalSetSelectionRange = mirror.setSelectionRange.bind(mirror);
    mirror.setSelectionRange = (start, end, direction) => {
      const result = originalSetSelectionRange(start, end, direction);
      queueMicrotask(handleMirrorSelection);
      return result;
    };
    mirror.__manaSelectionRangePatched = true;
    return () => {
      mirror.setSelectionRange = originalSetSelectionRange;
      delete mirror.__manaSelectionRangePatched;
    };
  }, []);

  return (
    <div className="relative h-full w-full" data-testid="chapter-editor">
      <div ref={hostRef} className="h-full w-full" data-testid="chapter-editor-codemirror" />
      <textarea
        ref={mirrorRef}
        data-testid="chapter-editor-compat-textarea"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute left-0 top-0 h-px w-px opacity-0 pointer-events-none"
        value={value || ''}
        onInput={(event) => syncMirrorContent(event.target.value)}
        onChange={(event) => syncMirrorContent(event.target.value)}
        onSelect={handleMirrorSelection}
        onClick={handleMirrorSelection}
        onKeyUp={handleMirrorSelection}
        readOnly={false}
      />
    </div>
  );
});
