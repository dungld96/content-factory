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

import { AssetPicker } from '@/components/asset-picker';
import { CancelRunButton } from '@/components/cancel-run';
import { Modal } from '@/components/modal';
import { ModelSelect, type ModelOption } from '@/components/model-select';
import { ResumeRunButton } from '@/components/resume-run';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, fetchJson, mutate } from '@/lib/api-client';
import { jobErrorText } from '@/lib/format';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** A text field of a submitted form (never a File), trimmed. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function ErrorText({ error }: { readonly error: string | null }) {
  return error ? (
    <span className="form-error" role="alert">
      {error}
    </span>
  ) : null;
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
  if (!result) return <p className="brief-check">Checking the brief…</p>;
  return (
    <div className="brief-check" aria-label="Brief check">
      {result.errors.length === 0 ? (
        <Pill tone="green">Brief ready</Pill>
      ) : (
        <ul role="alert">
          {result.errors.map((e) => (
            <li key={e.path}>
              <Pill tone="red">Error</Pill> {e.path}: {e.message}
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul>
          {result.warnings.map((w) => (
            <li key={w.path}>
              {w.path}: {w.message}
            </li>
          ))}
        </ul>
      )}
      {result.flags.length > 0 && <p>Claim terms to verify: {result.flags.join(', ')}</p>}
    </div>
  );
}

/** Starts a generation job and follows it until it ends. */
export function GenerateButton(props: {
  readonly path: string;
  readonly label: string;
  readonly again?: boolean;
  readonly primary?: boolean;
  /** Enabled text models (M8.5 Q3); empty → the task route only. */
  readonly models?: readonly ModelOption[];
}) {
  const router = useRouter();
  const [modelKey, setModelKey] = useState('');
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
    const r = await mutate<GenerateResponseDto>('POST', props.path, {
      ...(props.again ? { regenerate: true } : {}),
      ...(modelKey ? { modelKey } : {}),
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(errorText(r));
      return;
    }
    setJob(r.data.job);
    router.refresh();
  }

  const running = job !== null && !TERMINAL.has(job.status);
  return (
    <>
      <ModelSelect
        models={props.models ?? []}
        value={modelKey}
        disabled={busy || running}
        onChange={setModelKey}
      />
      <button
        type="button"
        className={props.primary ? 'btn primary' : 'btn ghost'}
        onClick={() => void start()}
        disabled={busy || running}
      >
        <span aria-hidden="true">✧</span> {running ? 'Generating…' : props.label}
      </button>
      {job && (
        <span className="job-line" role="status">
          Job {job.status}
          {job.attempt > 1 ? ` (attempt ${String(job.attempt)})` : ''}
          {job.errorCode ? ` — ${jobErrorText(job.errorCode)}` : ''}
        </span>
      )}
      {job && (job.status === 'failed' || job.status === 'canceled') && (
        <ResumeRunButton runId={job.productionRunId} />
      )}
      {running && (
        <CancelRunButton
          runId={job.productionRunId}
          what={`the ${props.label.toLowerCase()} job`}
        />
      )}
      <ErrorText error={error} />
    </>
  );
}

/** Approve / reject a pending version (gates 1 and 2). */
export function ReviewButtons(props: {
  readonly kind: 'scripts' | 'storyboards';
  readonly id: string;
  readonly label: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function review(action: 'approve' | 'reject') {
    setBusy(true);
    const r = await mutate('POST', `/${props.kind}/${props.id}/${action}`, {});
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(
      action === 'approve' ? `The ${props.label} is approved.` : `The ${props.label} is rejected.`,
    );
    router.refresh();
  }
  return (
    <>
      <button
        type="button"
        className="btn primary"
        disabled={busy}
        onClick={() => void review('approve')}
      >
        <span aria-hidden="true">✓</span> Approve {props.label}
      </button>
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        onClick={() => void review('reject')}
      >
        <span aria-hidden="true">↺</span> Reject
      </button>
      <ErrorText error={error} />
    </>
  );
}

function EditorActions(props: { readonly busy: boolean; readonly onCancel: () => void }) {
  return (
    <div className="form-actions">
      <button type="button" className="btn" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="submit" className="btn primary" disabled={props.busy}>
        {props.busy ? 'Saving…' : 'Save as new version'}
      </button>
    </div>
  );
}

/** Edits the main script fields; saving creates a new version. */
export function ScriptEditor({ script }: { readonly script: ScriptVersionDto }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setError(null);
  };

  async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const r = await mutate('PATCH', `/scripts/${script.id}`, {
      content: {
        ...script.content,
        title: field(form, 'title'),
        hook: field(form, 'hook'),
        voiceOver: field(form, 'voiceOver'),
        callToAction: field(form, 'callToAction'),
      },
    });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    close();
    toast('Saved as a new script version.');
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setOpen(true);
        }}
      >
        <span aria-hidden="true">✎</span> Edit script
      </button>
      <Modal
        open={open}
        onClose={close}
        title={`Edit script v${String(script.version)}`}
        description="Saving never changes this version: it creates a new one for review."
      >
        <form className="form" onSubmit={(e) => void save(e)} aria-label="Edit script">
          <label className="field">
            Title
            <input name="title" defaultValue={script.content.title} required maxLength={120} />
          </label>
          <label className="field">
            Hook
            <input name="hook" defaultValue={script.content.hook} required maxLength={300} />
          </label>
          <label className="field">
            Voice-over
            <textarea name="voiceOver" defaultValue={script.content.voiceOver} required rows={6} />
          </label>
          <label className="field">
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
          <EditorActions busy={busy} onCancel={close} />
        </form>
      </Modal>
    </>
  );
}

/** Edits one scene; saving creates a new storyboard version. */
export function SceneEditor({ scene }: { readonly scene: StoryboardSceneDto }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setError(null);
  };

  async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const duration = Number(field(form, 'durationSeconds'));
    const r = await mutate('PATCH', `/scenes/${scene.id}`, {
      imagePrompt: field(form, 'imagePrompt'),
      voiceOverSegment: field(form, 'voiceOverSegment'),
      // Only when changed: clip models offer fixed lengths (e.g. 4, 6, 8 s), so scenes are
      // retimed to match them (M8 pilot finding).
      ...(Number.isFinite(duration) && duration !== scene.durationSeconds
        ? { durationSeconds: duration }
        : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    close();
    toast('Saved as a new storyboard version.');
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn small ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit scene {scene.sceneNumber}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={`Edit scene ${String(scene.sceneNumber)}`}
        description="Saving creates a new storyboard version; the current one stays as it is."
      >
        <form
          className="form"
          onSubmit={(e) => void save(e)}
          aria-label={`Edit scene ${String(scene.sceneNumber)}`}
        >
          <label className="field">
            Image prompt
            <textarea name="imagePrompt" defaultValue={scene.imagePrompt} required rows={4} />
          </label>
          <label className="field">
            Voice-over segment
            <textarea name="voiceOverSegment" defaultValue={scene.voiceOverSegment} rows={3} />
          </label>
          <label className="field">
            Duration (seconds)
            <input
              name="durationSeconds"
              type="number"
              min={1}
              max={120}
              step={0.5}
              defaultValue={scene.durationSeconds}
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <EditorActions busy={busy} onCancel={close} />
        </form>
      </Modal>
    </>
  );
}

const REFERENCE_TYPES = ['reference', 'image'] as const;

/**
 * Scene reference assets chosen from the Library (P2b L4). Saving creates a new storyboard
 * version with the chosen asset IDs; the current version keeps its references.
 */
export function SceneReferencesButton(props: {
  readonly scene: StoryboardSceneDto;
  readonly projectId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = props.scene.requiredReferenceAssetIds;

  async function save(assetIds: string[]) {
    setOpen(false);
    if (assetIds.length === current.length && assetIds.every((id) => current.includes(id))) return;
    const r = await mutate('PATCH', `/scenes/${props.scene.id}`, {
      requiredReferenceAssetIds: assetIds,
    });
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    setError(null);
    toast('References saved as a new storyboard version.');
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn small ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        References ({current.length})
      </button>
      {open && (
        <AssetPicker
          projectId={props.projectId}
          open
          multiple
          title={`References for scene ${String(props.scene.sceneNumber)}`}
          types={REFERENCE_TYPES}
          selected={current}
          onClose={() => {
            setOpen(false);
          }}
          onDone={(ids) => void save(ids)}
        />
      )}
      <ErrorText error={error} />
    </>
  );
}
