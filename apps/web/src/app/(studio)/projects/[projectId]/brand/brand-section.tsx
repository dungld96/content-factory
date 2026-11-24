'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';

import type { Page, VersionDto, VersionedEntityDto } from '@acf/contracts';

import { AssetPicker } from '@/components/asset-picker';
import { useT } from '@/components/i18n-provider';
import { LocalTime } from '@/components/local-time';
import { Modal } from '@/components/modal';
import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { errorText, etagOf, fetchJson, mutate } from '@/lib/api-client';
import type { MessageKey } from '@/lib/i18n';

type Kind = 'characters' | 'environments';

const VERSION_PATH: Readonly<Record<Kind, string>> = {
  characters: 'character-versions',
  environments: 'environment-versions',
};
const LABEL: Readonly<
  Record<Kind, { many: MessageKey; create: MessageKey; none: MessageKey; created: MessageKey }>
> = {
  characters: {
    many: 'brand.characters',
    create: 'brand.newCharacter',
    none: 'brand.noCharacter',
    created: 'brand.createdCharacter',
  },
  environments: {
    many: 'brand.environments',
    create: 'brand.newEnvironment',
    none: 'brand.noEnvironment',
    created: 'brand.createdEnvironment',
  },
};
const REFERENCE_TYPES = ['reference', 'image'] as const;

const formValue = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** One kind of brand entity: list, create, versions (P2b design L3). */
export function BrandSection(props: {
  readonly kind: Kind;
  readonly projectId: string;
  readonly entities: readonly VersionedEntityDto[];
  readonly canEdit: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = LABEL[props.kind];

  async function create(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = formValue(form, 'description');
    const r = await mutate('POST', `/projects/${props.projectId}/${props.kind}`, {
      name: formValue(form, 'name'),
      slug: formValue(form, 'slug'),
      ...(description ? { description } : {}),
    });
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    setError(null);
    setCreating(false);
    toast(t(label.created));
    router.refresh();
  }

  return (
    <section className="card card-pad" aria-labelledby={`brand-${props.kind}`}>
      <div className="section-head">
        <div>
          <h2 id={`brand-${props.kind}`}>{t(label.many)}</h2>
        </div>
        {props.canEdit && (
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            <span aria-hidden="true">＋</span> {t(label.create)}
          </button>
        )}
      </div>
      {props.entities.length === 0 ? (
        <p className="muted small-text">{t(label.none)}</p>
      ) : (
        <ul className="plain-list" aria-label={t(label.many)}>
          {props.entities.map((e) => (
            <EntityRow
              key={e.id}
              kind={props.kind}
              entity={e}
              projectId={props.projectId}
              canEdit={props.canEdit}
            />
          ))}
        </ul>
      )}
      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        title={t(label.create)}
      >
        <form className="form" onSubmit={(e) => void create(e)}>
          <label className="field">
            {t('form.name')}
            <input name="name" required maxLength={120} />
          </label>
          <label className="field">
            {t('form.slug')} <small>{t('brand.slugHint')}</small>
            <input name="slug" required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </label>
          <label className="field">
            {t('form.description')} <small>{t('form.optional')}</small>
            <textarea name="description" maxLength={5000} rows={3} />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreating(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn primary">
              {t('brand.create')}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

function EntityRow(props: {
  readonly kind: Kind;
  readonly entity: VersionedEntityDto;
  readonly projectId: string;
  readonly canEdit: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const { entity } = props;
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchJson<Page<VersionDto>>(`/${props.kind}/${entity.id}/versions?limit=20`).then(
      async (page) => {
        // The list has no asset links: read each version (at most 20).
        const full = await Promise.all(
          (page?.data ?? []).map((v) =>
            fetchJson<VersionDto>(`/${VERSION_PATH[props.kind]}/${v.id}`),
          ),
        );
        if (live) setVersions(full.flatMap((v) => (v ? [v] : [])));
      },
    );
    return () => {
      live = false;
    };
  }, [open, reload, props.kind, entity.id]);

  async function approve(v: VersionDto) {
    const r = await mutate(
      'POST',
      `/${VERSION_PATH[props.kind]}/${v.id}/approve`,
      {},
      { 'if-match': etagOf(v.updatedAt) },
    );
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    setError(null);
    toast(t('brand.approved', { version: v.version }));
    setReload((n) => n + 1);
    router.refresh();
  }

  return (
    <li className="job-row">
      <details
        open={open}
        onToggle={(e) => {
          setOpen(e.currentTarget.open);
        }}
      >
        <summary>
          <b>{entity.name}</b> <code>{entity.slug}</code>{' '}
          {entity.master ? (
            <Pill tone="green">{t('brand.master', { version: entity.master.version })}</Pill>
          ) : (
            <Pill tone="gray">{t('brand.noApproved')}</Pill>
          )}
        </summary>
        {entity.description && <p className="muted small-text">{entity.description}</p>}
        {versions === null ? (
          <p className="muted small-text" aria-busy="true">
            {t('brand.loadingVersions')}
          </p>
        ) : versions.length === 0 ? (
          <p className="muted small-text">{t('brand.noVersions')}</p>
        ) : (
          <ol className="small-text" aria-label={t('brand.versionsOf', { name: entity.name })}>
            {versions.map((v) => (
              <li key={v.id}>
                v{v.version}{' '}
                <Pill tone={v.status === 'approved' ? 'green' : 'amber'}>
                  {v.status === 'approved' ? t('brand.status.approved') : t('brand.status.draft')}
                </Pill>{' '}
                · {v.description} ·{' '}
                {v.primaryAssetId ? t('brand.primarySet') : t('brand.noPrimary')} ·{' '}
                {t('brand.linked', { count: v.assets.length })} · <LocalTime iso={v.createdAt} />
                {props.canEdit && v.status === 'draft' && (
                  <button type="button" className="btn small" onClick={() => void approve(v)}>
                    {t('brand.approve')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        {props.canEdit && entity.archivedAt === null && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              setDrafting(true);
            }}
          >
            {t('brand.newVersion')}
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </details>
      {drafting && (
        <NewVersion
          kind={props.kind}
          entity={entity}
          projectId={props.projectId}
          base={versions?.[0] ?? null}
          onClose={(saved) => {
            setDrafting(false);
            if (saved) setReload((n) => n + 1);
          }}
        />
      )}
    </li>
  );
}

/** A new draft version: description, primary reference and linked references from the Library. */
function NewVersion(props: {
  readonly kind: Kind;
  readonly entity: VersionedEntityDto;
  readonly projectId: string;
  readonly base: VersionDto | null;
  readonly onClose: (saved: boolean) => void;
}) {
  const t = useT();
  const [primary, setPrimary] = useState<string | null>(props.base?.primaryAssetId ?? null);
  const [linked, setLinked] = useState<string[]>(props.base?.assets.map((a) => a.assetId) ?? []);
  const [picking, setPicking] = useState<'primary' | 'linked' | null>(null);
  const [description, setDescription] = useState(props.base?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const r = await mutate('POST', `/${props.kind}/${props.entity.id}/versions`, {
      description: description.trim(),
      primaryAssetId: primary,
      assets: linked.map((assetId, sortOrder) => ({ assetId, sortOrder })),
    });
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(t('brand.draftSaved'));
    props.onClose(true);
  }

  if (picking) {
    return (
      <AssetPicker
        projectId={props.projectId}
        open
        multiple={picking === 'linked'}
        title={picking === 'primary' ? t('brand.primaryRef') : t('brand.linkedRefs')}
        types={REFERENCE_TYPES}
        selected={picking === 'primary' ? (primary ? [primary] : []) : linked}
        onClose={() => {
          setPicking(null);
        }}
        onDone={(ids) => {
          if (picking === 'primary') setPrimary(ids[0] ?? null);
          else setLinked(ids);
          setPicking(null);
        }}
      />
    );
  }
  return (
    <Modal
      open
      onClose={() => {
        props.onClose(false);
      }}
      title={t('brand.newVersionOf', { name: props.entity.name })}
      description={t('brand.newVersionDesc')}
    >
      <form className="form" onSubmit={(e) => void save(e)}>
        <label className="field">
          {t('form.description')}
          <textarea
            name="description"
            required
            maxLength={10_000}
            rows={4}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
          />
        </label>
        <p className="small-text">
          {t('brand.primaryLine')}{' '}
          {primary ? <code>{primary.slice(0, 8)}…</code> : t('common.none')}{' '}
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setPicking('primary');
            }}
          >
            {t('brand.choose')}
          </button>
        </p>
        <p className="small-text">
          {t('brand.linkedLine', { count: linked.length })}{' '}
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setPicking('linked');
            }}
          >
            {t('brand.choose')}
          </button>
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              props.onClose(false);
            }}
          >
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary">
            {t('brand.saveDraft')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
