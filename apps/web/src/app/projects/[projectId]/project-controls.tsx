'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import type { AssetDto, ContentItemDto } from '@acf/contracts';

import { mutate, uploadImage } from '@/lib/api-client';

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Creates a content item from a short brief (R0: also its content master). The web UI could not
 * create content before; the brief can be refined on the content page.
 */
export function NewContentForm(props: { readonly projectId: string; readonly language: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const platform = field(form, 'targetPlatform');
    const r = await mutate<ContentItemDto>('POST', `/projects/${props.projectId}/content`, {
      title: field(form, 'title'),
      format: 'short_video',
      targetDurationSeconds: Number(field(form, 'duration')),
      aspectRatio: field(form, 'aspectRatio'),
      language: field(form, 'language'),
      brief: { topic: field(form, 'topic') },
      ...(platform ? { targetPlatform: platform } : {}),
    });
    if (!r.ok || !r.data) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    router.push(`/content/${r.data.id}`);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        New content
      </button>
    );
  }
  return (
    <form className="form" aria-label="New content" onSubmit={(e) => void create(e)}>
      <label>
        Title
        <input name="title" required maxLength={200} />
      </label>
      <label>
        Topic
        <textarea name="topic" required maxLength={500} rows={2} />
      </label>
      <div className="row">
        <label>
          Duration (s)
          <input name="duration" type="number" min={5} max={180} defaultValue={30} required />
        </label>
        <label>
          Aspect ratio
          <select name="aspectRatio" defaultValue="9:16">
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>
        <label>
          Language
          <input name="language" defaultValue={props.language} required maxLength={35} />
        </label>
        <label>
          Platform
          <select name="targetPlatform" defaultValue="">
            <option value="">—</option>
            <option value="tiktok">TikTok</option>
            <option value="instagram_reels">Instagram Reels</option>
            <option value="youtube_shorts">YouTube Shorts</option>
            <option value="other">Other</option>
          </select>
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit">Create</button>
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

/** Uploads a reference image (M4a: raw body through the API, ≤ 25 MB, PNG/JPEG/WebP). */
export function ReferenceUpload({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const r = await uploadImage<AssetDto>(projectId, file, { assetType: 'reference' });
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? `Upload failed (HTTP ${String(r.status)})`);
      return;
    }
    router.refresh();
  }

  return (
    <div className="row">
      <label>
        Upload reference image{' '}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </label>
      {busy && <span role="status">Uploading…</span>}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Adds a variant to a content master (R0): the master's brief is copied into it. */
export function NewVariantForm(props: { readonly masterId: string; readonly language: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function create(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const platform = field(form, 'targetPlatform');
    const title = field(form, 'title');
    const r = await mutate<ContentItemDto>('POST', `/content-masters/${props.masterId}/variants`, {
      format: 'short_video',
      targetDurationSeconds: Number(field(form, 'duration')),
      aspectRatio: field(form, 'aspectRatio'),
      language: field(form, 'language'),
      ...(title ? { title } : {}),
      ...(platform ? { targetPlatform: platform } : {}),
    });
    if (!r.ok || !r.data) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    router.refresh();
  }

  return (
    <form className="form" aria-label="New variant" onSubmit={(e) => void create(e)}>
      <div className="row">
        <label>
          Title (optional)
          <input name="title" maxLength={200} />
        </label>
        <label>
          Duration (s)
          <input name="duration" type="number" min={5} max={180} defaultValue={30} required />
        </label>
        <label>
          Aspect ratio
          <select name="aspectRatio" defaultValue="9:16">
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>
        <label>
          Language
          <input name="language" defaultValue={props.language} required maxLength={35} />
        </label>
        <label>
          Platform
          <select name="targetPlatform" defaultValue="">
            <option value="">—</option>
            <option value="tiktok">TikTok</option>
            <option value="instagram_reels">Instagram Reels</option>
            <option value="youtube_shorts">YouTube Shorts</option>
            <option value="other">Other</option>
          </select>
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit">Add variant</button>
    </form>
  );
}
