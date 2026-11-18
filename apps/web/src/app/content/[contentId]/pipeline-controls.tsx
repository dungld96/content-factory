'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';

import type {
  BriefValidationDto,
  GenerateResponseDto,
  GenerationJobDto,
  ScriptVersionDto,
  StoryboardSceneDto,
} from '@acf/contracts';

import { fetchJson, mutate } from '@/lib/api-client';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** A text field of a submitted form (never a File), trimmed. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Refreshes the server-rendered page while a generation runs (also after a reload). */
export function AutoRefresh({ active }: { readonly active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      router.refresh();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [active, router]);
  return null;
}

/** Brief check on load (POST, so it runs in the browser with the CSRF token). */
export function BriefCheck({ contentId }: { readonly contentId: string }) {
  const [result, setResult] = useState<BriefValidationDto | null>(null);
  useEffect(() => {
    void mutate<BriefValidationDto>('POST', `/content/${contentId}/brief/validate`).then((r) => {
      setResult(r.data);
    });
  }, [contentId]);
  if (!result) return <p className="muted">Checking the brief…</p>;
  return (
    <div aria-label="Brief check">
      {result.errors.length === 0 ? (
        <p>
          <span className="badge badge-ok">Brief ready</span>
        </p>
      ) : (
        <ul role="alert">
          {result.errors.map((e) => (
            <li key={e.path}>
              <span className="badge badge-err">Error</span> {e.path}: {e.message}
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="muted">
          {result.warnings.map((w) => (
            <li key={w.path}>
              {w.path}: {w.message}
            </li>
          ))}
        </ul>
      )}
      {result.flags.length > 0 && (
        <p className="muted">Claim terms to verify: {result.flags.join(', ')}</p>
      )}
    </div>
  );
}

/** Starts a generation job and follows it until it ends. */
export function GenerateButton(props: {
  readonly path: string;
  readonly label: string;
  readonly again?: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState<GenerationJobDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!job || TERMINAL.has(job.status)) return;
    const timer = setInterval(() => {
      void fetchJson<GenerationJobDto>(`/generation-jobs/${job.id}`).then((next) => {
        if (!next) return;
        setJob(next);
        if (TERMINAL.has(next.status)) router.refresh();
      });
    }, 1500);
    return () => {
      clearInterval(timer);
    };
  }, [job, router]);

  async function start() {
    setBusy(true);
    setError(null);
    const r = await mutate<GenerateResponseDto>(
      'POST',
      props.path,
      props.again ? { regenerate: true } : {},
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    setJob(r.data.job);
    router.refresh();
  }

  const running = job !== null && !TERMINAL.has(job.status);
  return (
    <div className="row">
      <button type="button" onClick={() => void start()} disabled={busy || running}>
        {running ? 'Generating…' : props.label}
      </button>
      {job && (
        <span className="muted" role="status">
          Job {job.status}
          {job.attempt > 1 ? ` (attempt ${String(job.attempt)})` : ''}
          {job.errorCode ? ` — ${job.errorCode}` : ''}
        </span>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Approve / reject a pending version. */
export function ReviewButtons(props: {
  readonly kind: 'scripts' | 'storyboards';
  readonly id: string;
  readonly label: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function review(action: 'approve' | 'reject') {
    const r = await mutate('POST', `/${props.kind}/${props.id}/${action}`, {});
    if (!r.ok) setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
    else router.refresh();
  }
  return (
    <div className="row">
      <button type="button" onClick={() => void review('approve')}>
        Approve {props.label}
      </button>
      <button type="button" className="secondary" onClick={() => void review('reject')}>
        Reject
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Edits the main script fields; saving creates a new version. */
export function ScriptEditor({ script }: { readonly script: ScriptVersionDto }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const r = await mutate('PATCH', `/scripts/${script.id}`, {
      content: {
        ...script.content,
        title: field(form, 'title'),
        hook: field(form, 'hook'),
        voiceOver: field(form, 'voiceOver'),
        callToAction: field(form, 'callToAction'),
      },
    });
    if (!r.ok) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit script
      </button>
    );
  }
  return (
    <form className="form" onSubmit={(e) => void save(e)} aria-label="Edit script">
      <label>
        Title
        <input name="title" defaultValue={script.content.title} required maxLength={120} />
      </label>
      <label>
        Hook
        <input name="hook" defaultValue={script.content.hook} required maxLength={300} />
      </label>
      <label>
        Voice-over
        <textarea name="voiceOver" defaultValue={script.content.voiceOver} required rows={5} />
      </label>
      <label>
        Call to action
        <input
          name="callToAction"
          defaultValue={script.content.callToAction}
          required
          maxLength={300}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit">Save as new version</button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Edits one scene; saving creates a new storyboard version. */
export function SceneEditor({ scene }: { readonly scene: StoryboardSceneDto }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const r = await mutate('PATCH', `/scenes/${scene.id}`, {
      imagePrompt: field(form, 'imagePrompt'),
      voiceOverSegment: field(form, 'voiceOverSegment'),
    });
    if (!r.ok) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit scene {scene.sceneNumber}
      </button>
    );
  }
  return (
    <form
      className="form"
      onSubmit={(e) => void save(e)}
      aria-label={`Edit scene ${String(scene.sceneNumber)}`}
    >
      <label>
        Image prompt
        <textarea name="imagePrompt" defaultValue={scene.imagePrompt} required rows={3} />
      </label>
      <label>
        Voice-over segment
        <textarea name="voiceOverSegment" defaultValue={scene.voiceOverSegment} rows={2} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit">Save as new version</button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
