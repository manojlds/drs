import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

interface PrdEditorProps {
  /** Identifies the document. The editor is re-created when this changes. */
  docKey: string;
  /** Initial markdown. Only read when the editor is (re-)created for a docKey. */
  initialValue: string;
  readOnly?: boolean;
  onChange: (markdown: string) => void;
  className?: string;
}

/**
 * Milkdown (Crepe) WYSIWYG editor for PRD markdown.
 *
 * Milkdown owns its own document state, so this is intentionally an
 * uncontrolled component: it seeds from `initialValue` when a new `docKey`
 * mounts and streams markdown back through `onChange`. Feeding `initialValue`
 * on every keystroke would fight the editor and reset the cursor.
 */
export function PrdEditor({ docKey, initialValue, readOnly = false, onChange, className }: PrdEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(initialValue);
  onChangeRef.current = onChange;
  initialValueRef.current = initialValue;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let destroyed = false;
    const crepe = new Crepe({ root, defaultValue: initialValueRef.current });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
    });
    void crepe.create().then(() => {
      if (destroyed) {
        void crepe.destroy();
        return;
      }
      crepe.setReadonly(readOnly);
      crepeRef.current = crepe;
    });
    return () => {
      destroyed = true;
      crepeRef.current = null;
      void crepe.destroy();
    };
    // Re-create only when the document identity changes; readOnly is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    crepeRef.current?.setReadonly(readOnly);
  }, [readOnly]);

  return <div ref={rootRef} className={className} />;
}
