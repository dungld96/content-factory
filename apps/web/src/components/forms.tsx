'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode, type SyntheticEvent } from 'react';

import type {
  AssetDto,
  ContentBrief,
  ContentItemDto,
  ContentMasterDetailDto,
  ContentMasterDto,
  ProjectDto,
} from '@acf/contracts';

import { mutate, uploadImage, type MutationResult } from '@/lib/api-client';
import { PLATFORM_OPTIONS } from '@/lib/format';

import { Modal } from './modal';
import { toast } from './toast';

/** A project the caller can write to, as the pickers need it. */
export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly defaultLanguage: string;
}

type SubmitEvent_ = SyntheticEvent<HTMLFormElement, SubmitEvent>;

/** A text field of a submitted form (never a File), trimmed. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Optional brief fields: empty inputs are omitted (the API rejects empty strings). */
function optionalBrief(
  form: FormData,
  names: readonly (keyof ContentBrief)[],
): Partial<ContentBrief> {
  const brief: Record<string, string> = {};
  for (const name of names) {
    const value = field(form, name);
    if (value) brief[name] = value;
  }
  return brief;
}

const failure = (r: MutationResult<unknown>) =>
  r.message ?? `Request failed (HTTP ${String(r.status)})`;

/** Busy/error state around one submit. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(request: () => Promise<MutationResult<T>>): Promise<T | null> {
    setBusy(true);
    setError(null);
    const r = await request();
    setBusy(false);
    if (!r.ok || r.data === null) {
      setError(failure(r));
      return null;
    }
    return r.data;
  }
  return { busy, error, run };
}

function FormError({ error }: { readonly error: string | null }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}

function Actions(props: {
  readonly busy: boolean;
  readonly submit: string;
  readonly onCancel: () => void;
}) {
  return (
    <div className="form-actions">
      <button type="button" className="btn" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="submit" className="btn primary" disabled={props.busy}>
        {props.busy ? 'Saving…' : props.submit}
      </button>
    </div>
  );
}

/** A button that opens a modal; `children` gets a close callback. */
function ModalButton(props: {
  readonly label: ReactNode;
  readonly className?: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly disabled?: boolean;
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        className={props.className ?? 'btn'}
        disabled={props.disabled}
        onClick={() => {
          setOpen(true);
        }}
      >
        {props.label}
      </button>
      <Modal open={open} onClose={close} title={props.title} description={props.description}>
        {props.children(close)}
      </Modal>
    </>
  );
}

function ProjectSelect(props: {
  readonly projects: readonly ProjectOption[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  return (
    <label className="field">
      Project
      <select
        name="projectId"
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        required
      >
        {props.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SpecFields(props: { readonly language: string }) {
  return (
    <div className="form-row">
      <label className="field">
        Duration (s)
        <input name="duration" type="number" min={5} max={180} defaultValue={30} required />
      </label>
      <label className="field">
        Aspect ratio
        <select name="aspectRatio" defaultValue="9:16">
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
        </select>
      </label>
      <label className="field">
        Language
        <input name="language" defaultValue={props.language} required maxLength={35} />
      </label>
      <label className="field">
        Platform
        <select name="targetPlatform" defaultValue="">
          <option value="">—</option>
          {PLATFORM_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function specBody(form: FormData) {
  const platform = field(form, 'targetPlatform');
  return {
    format: 'short_video' as const,
    targetDurationSeconds: Number(field(form, 'duration')),
    aspectRatio: field(form, 'aspectRatio'),
    language: field(form, 'language'),
    ...(platform ? { targetPlatform: platform } : {}),
  };
}

// --- Content -------------------------------------------------------------------------------

function NewContentForm(props: {
  readonly projects: readonly ProjectOption[];
  readonly projectId: string;
  readonly showProject: boolean;
  readonly onCancel: () => void;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(props.projectId);
  const { busy, error, run } = useSubmit();
  const project = props.projects.find((p) => p.id === projectId);

  async function create(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const created = await run(() =>
      mutate<ContentItemDto>('POST', `/projects/${projectId}/content`, {
        title: field(form, 'title'),
        ...specBody(form),
        brief: { topic: field(form, 'topic'), ...optionalBrief(form, ['audience', 'tone']) },
      }),
    );
    if (created) router.push(`/content/${created.id}`);
  }

  return (
    <form className="form" aria-label="New content" onSubmit={(e) => void create(e)}>
      {props.showProject && (
        <ProjectSelect projects={props.projects} value={projectId} onChange={setProjectId} />
      )}
      <label className="field">
        Title
        <input name="title" required maxLength={200} placeholder="Give this a working title" />
      </label>
      <label className="field">
        Topic
        <textarea
          name="topic"
          required
          maxLength={500}
          rows={3}
          placeholder="What should this content achieve?"
        />
      </label>
      <div className="form-row">
        <label className="field">
          Audience <small>(optional)</small>
          <input name="audience" maxLength={500} />
        </label>
        <label className="field">
          Tone <small>(optional)</small>
          <input name="tone" maxLength={200} />
        </label>
      </div>
      {/* Key: the language default follows the chosen project. */}
      <SpecFields key={projectId} language={project?.defaultLanguage ?? 'en'} />
      <FormError error={error} />
      <Actions busy={busy} submit="Create draft" onCancel={props.onCancel} />
    </form>
  );
}

/** Creates a content item and its content master (R0), then opens it. */
export function NewContentButton(props: {
  readonly projects: readonly ProjectOption[];
  /** Fixes the project (project page); otherwise the form offers a picker. */
  readonly projectId?: string;
  readonly label?: string;
}) {
  const first = props.projectId ?? props.projects[0]?.id;
  if (!first) return null;
  return (
    <ModalButton
      className="btn primary"
      label={
        <>
          <span aria-hidden="true">＋</span> {props.label ?? 'New content'}
        </>
      }
      title="Create new content"
      description="Start with a clear brief. Your content item becomes the first variant of a new content master."
    >
      {(close) => (
        <NewContentForm
          projects={props.projects}
          projectId={first}
          showProject={props.projectId === undefined}
          onCancel={close}
        />
      )}
    </ModalButton>
  );
}

// --- Projects ------------------------------------------------------------------------------

const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function NewProjectForm({ onCancel }: { readonly onCancel: () => void }) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const { busy, error, run } = useSubmit();

  async function create(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = field(form, 'description');
    const created = await run(() =>
      mutate<ProjectDto>('POST', '/projects', {
        name: field(form, 'name'),
        slug: field(form, 'slug'),
        defaultLanguage: field(form, 'defaultLanguage'),
        timezone: field(form, 'timezone'),
        ...(description ? { description } : {}),
      }),
    );
    if (created) {
      toast(`Project created: ${created.name}`);
      router.push(`/projects/${created.id}`);
    }
  }

  return (
    <form className="form" aria-label="New project" onSubmit={(e) => void create(e)}>
      <label className="field">
        Name
        <input
          name="name"
          required
          maxLength={120}
          onChange={(e) => {
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
        />
      </label>
      <label className="field">
        Slug <small>(unique; lower-case letters, digits and dashes)</small>
        <input
          name="slug"
          required
          maxLength={60}
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
        />
      </label>
      <label className="field">
        Description <small>(optional)</small>
        <textarea name="description" rows={2} maxLength={5000} />
      </label>
      <div className="form-row">
        <label className="field">
          Default language
          <input name="defaultLanguage" defaultValue="en" required maxLength={35} />
        </label>
        <label className="field">
          Timezone
          <input
            name="timezone"
            required
            maxLength={64}
            defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
        </label>
      </div>
      <FormError error={error} />
      <Actions busy={busy} submit="Create project" onCancel={onCancel} />
    </form>
  );
}

export function NewProjectButton() {
  return (
    <ModalButton
      className="btn primary"
      label={
        <>
          <span aria-hidden="true">＋</span> New project
        </>
      }
      title="Create a project"
      description="Organize content production by brand, channel or campaign. You become its owner."
    >
      {(close) => <NewProjectForm onCancel={close} />}
    </ModalButton>
  );
}

/** Owner-only project settings (PATCH /projects/:id). */
export function ProjectSettingsForm({ project }: { readonly project: ProjectDto }) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();

  async function save(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = field(form, 'description');
    const saved = await run(() =>
      mutate<ProjectDto>('PATCH', `/projects/${project.id}`, {
        name: field(form, 'name'),
        description: description || null,
        defaultLanguage: field(form, 'defaultLanguage'),
        timezone: field(form, 'timezone'),
      }),
    );
    if (saved) {
      toast('Project settings saved.');
      router.refresh();
    }
  }

  return (
    <form
      key={project.updatedAt}
      className="form"
      aria-label="Project settings"
      onSubmit={(e) => void save(e)}
    >
      <label className="field">
        Project name
        <input name="name" defaultValue={project.name} required maxLength={120} />
      </label>
      <label className="field">
        Description
        <textarea
          name="description"
          defaultValue={project.description ?? ''}
          rows={2}
          maxLength={5000}
        />
      </label>
      <div className="form-row">
        <label className="field">
          Default language
          <input
            name="defaultLanguage"
            defaultValue={project.defaultLanguage}
            required
            maxLength={35}
          />
        </label>
        <label className="field">
          Timezone
          <input name="timezone" defaultValue={project.timezone} required maxLength={64} />
        </label>
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

// --- Content masters -----------------------------------------------------------------------

function BriefFields(props: { readonly brief?: ContentBrief }) {
  return (
    <>
      <label className="field">
        Core idea (topic)
        <textarea
          name="topic"
          required
          maxLength={500}
          rows={3}
          defaultValue={props.brief?.topic}
        />
      </label>
      <div className="form-row">
        <label className="field">
          Audience <small>(optional)</small>
          <input name="audience" maxLength={500} defaultValue={props.brief?.audience} />
        </label>
        <label className="field">
          Tone <small>(optional)</small>
          <input name="tone" maxLength={200} defaultValue={props.brief?.tone} />
        </label>
      </div>
      <label className="field">
        Objective <small>(optional)</small>
        <input name="objective" maxLength={500} defaultValue={props.brief?.objective} />
      </label>
    </>
  );
}

const BRIEF_OPTIONAL = ['audience', 'tone', 'objective'] as const;

function NewMasterForm(props: {
  readonly projects: readonly ProjectOption[];
  readonly onCancel: () => void;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(props.projects[0]?.id ?? '');
  const { busy, error, run } = useSubmit();
  const project = props.projects.find((p) => p.id === projectId);

  async function create(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const created = await run(() =>
      mutate<ContentMasterDto>('POST', `/projects/${projectId}/content-masters`, {
        title: field(form, 'title'),
        language: field(form, 'language'),
        brief: { topic: field(form, 'topic'), ...optionalBrief(form, BRIEF_OPTIONAL) },
      }),
    );
    if (created) router.push(`/masters/${created.id}`);
  }

  return (
    <form className="form" aria-label="New content master" onSubmit={(e) => void create(e)}>
      <ProjectSelect projects={props.projects} value={projectId} onChange={setProjectId} />
      <label className="field">
        Title
        <input name="title" required maxLength={200} />
      </label>
      <BriefFields />
      <label className="field" key={projectId}>
        Default language of variants
        <input
          name="language"
          defaultValue={project?.defaultLanguage ?? 'en'}
          required
          maxLength={35}
        />
      </label>
      <FormError error={error} />
      <Actions busy={busy} submit="Create master" onCancel={props.onCancel} />
    </form>
  );
}

export function NewMasterButton({ projects }: { readonly projects: readonly ProjectOption[] }) {
  if (projects.length === 0) return null;
  return (
    <ModalButton
      className="btn primary"
      label={
        <>
          <span aria-hidden="true">＋</span> Create master
        </>
      }
      title="Create a content master"
      description="One core idea, many channel-ready variants. Add variants once the master exists."
    >
      {(close) => <NewMasterForm projects={projects} onCancel={close} />}
    </ModalButton>
  );
}

function EditMasterForm(props: {
  readonly master: ContentMasterDetailDto;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const { master } = props;
  const { busy, error, run } = useSubmit();

  async function save(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // Fields this form does not show (notes, sources, character…) are kept as they are.
    const kept = Object.fromEntries(
      Object.entries(master.brief).filter(
        ([key]) => !(BRIEF_OPTIONAL as readonly string[]).includes(key),
      ),
    );
    const saved = await run(() =>
      mutate<ContentMasterDto>('PATCH', `/content-masters/${master.id}`, {
        title: field(form, 'title'),
        brief: { ...kept, topic: field(form, 'topic'), ...optionalBrief(form, BRIEF_OPTIONAL) },
      }),
    );
    if (saved) {
      toast(`Master brief saved (revision ${String(saved.briefRevision)}).`);
      props.onDone();
      router.refresh();
    }
  }

  return (
    <form className="form" aria-label="Edit master brief" onSubmit={(e) => void save(e)}>
      <label className="field">
        Title
        <input name="title" required maxLength={200} defaultValue={master.title} />
      </label>
      <BriefFields brief={master.brief} />
      <FormError error={error} />
      <Actions busy={busy} submit="Save brief" onCancel={props.onDone} />
    </form>
  );
}

export function EditMasterButton({ master }: { readonly master: ContentMasterDetailDto }) {
  return (
    <ModalButton
      label="Edit master brief"
      title="Edit master brief"
      description="A brief change creates a new brief revision. Existing variants keep their copy until you resync them."
    >
      {(close) => <EditMasterForm master={master} onDone={close} />}
    </ModalButton>
  );
}

function NewVariantForm(props: {
  readonly masterId: string;
  readonly language: string;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();

  async function create(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = field(form, 'title');
    const created = await run(() =>
      mutate<ContentItemDto>('POST', `/content-masters/${props.masterId}/variants`, {
        ...specBody(form),
        ...(title ? { title } : {}),
      }),
    );
    if (created) {
      toast(`Variant added: ${created.title}`);
      props.onDone();
      router.refresh();
    }
  }

  return (
    <form className="form" aria-label="New variant" onSubmit={(e) => void create(e)}>
      <label className="field">
        Title (optional)
        <input name="title" maxLength={200} />
      </label>
      <SpecFields language={props.language} />
      <FormError error={error} />
      <Actions busy={busy} submit="Add variant" onCancel={props.onDone} />
    </form>
  );
}

/** Adds a variant to a content master (R0): the master's brief is copied into it. */
export function NewVariantButton(props: { readonly masterId: string; readonly language: string }) {
  return (
    <ModalButton
      className="btn primary small"
      label={
        <>
          <span aria-hidden="true">＋</span> Add variant
        </>
      }
      title="Add a variant"
      description="The variant copies the master's current brief and runs its own production workflow."
    >
      {(close) => (
        <NewVariantForm masterId={props.masterId} language={props.language} onDone={close} />
      )}
    </ModalButton>
  );
}

// --- Assets --------------------------------------------------------------------------------

function UploadForm(props: {
  readonly projects: readonly ProjectOption[];
  readonly projectId: string;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(props.projectId);
  const { busy, error, run } = useSubmit();

  async function upload(event: SubmitEvent_) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return;
    const label = field(form, 'label');
    const asset = await run(() =>
      uploadImage<AssetDto>(projectId, file, {
        assetType: 'reference',
        ...(label ? { label } : {}),
      }),
    );
    if (asset) {
      toast(`Uploaded ${asset.originalFilename ?? 'the image'}.`);
      props.onDone();
      router.refresh();
    }
  }

  return (
    <form className="form" aria-label="Upload asset" onSubmit={(e) => void upload(e)}>
      <ProjectSelect projects={props.projects} value={projectId} onChange={setProjectId} />
      <label className="field">
        Reference image <small>(PNG, JPEG or WebP, up to 25 MB)</small>
        <input name="file" type="file" accept="image/png,image/jpeg,image/webp" required />
      </label>
      <label className="field">
        Label <small>(optional)</small>
        <input name="label" maxLength={200} />
      </label>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="btn" onClick={props.onDone}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}

/** Uploads a reference image (M4a: raw body through the API, ≤ 25 MB, PNG/JPEG/WebP). */
export function UploadAssetButton(props: {
  readonly projects: readonly ProjectOption[];
  readonly projectId?: string | undefined;
}) {
  const first = props.projectId ?? props.projects[0]?.id;
  if (!first) return null;
  return (
    <ModalButton
      className="btn primary"
      label={
        <>
          <span aria-hidden="true">↑</span> Upload reference
        </>
      }
      title="Upload a reference image"
      description="Reference images are stored immutably in object storage and can be attached to characters and environments."
    >
      {(close) => <UploadForm projects={props.projects} projectId={first} onDone={close} />}
    </ModalButton>
  );
}
