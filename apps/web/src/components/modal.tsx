'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal dialog on the native `<dialog>` element: focus trap, Escape and inert background come
 * from the browser. Children render only while open, so forms start fresh each time.
 */
export function Modal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { open, onClose } = props;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the dialog element itself (not its body) is a click on the backdrop.
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-body">
          <h2 id={titleId}>{props.title}</h2>
          {props.description && <p className="modal-desc">{props.description}</p>}
          {props.children}
        </div>
      )}
    </dialog>
  );
}
