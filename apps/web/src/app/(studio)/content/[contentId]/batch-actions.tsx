'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { CostConfirmDialog, estimateText } from '@/components/cost-confirm';
import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';
import { confirmReasons, type ConfirmReason } from '@/lib/cost-confirm';
import type { MessageKey } from '@/lib/i18n';
import { addUsd } from '@/lib/money';
import type { Stage } from '@/lib/scene-board';

/** The common shape of the image, clip and voice-over estimates. */
interface Estimate {
  readonly scenes: readonly {
    readonly sceneNumber: number;
    readonly action: string;
    readonly estimatedUsd: string | null;
  }[];
  readonly totalEstimatedUsd: string | null;
  readonly unknownCost: boolean;
}

interface Request {
  readonly stage: Stage;
  readonly sceneIds: readonly string[];
  readonly regenerate: boolean;
}

const PATH: Readonly<Record<Stage, string>> = {
  keyframes: 'images',
  clips: 'videos',
  voiceover: 'voiceovers',
};

const STAGE_LABEL: Readonly<Record<Stage, MessageKey>> = {
  keyframes: 'st.keyframes',
  clips: 'st.clips',
  voiceover: 'st.voiceover',
};

/**
 * Batch actions of the scene board (redesign canvas): "Retry selected" re-runs every failed
 * stage of the selected scenes, "Generate" runs the current stage for them. Both estimate first
 * (free), show the total on the button, and ask above the cost threshold or with an unknown price;
 * the API applies its own budget checks.
 */
export function BatchActions(props: {
  readonly storyboards: Readonly<Record<Stage, string | null>>;
  /** Failed stages of the selected scenes. */
  readonly retry: readonly Request[];
  readonly generate: Request | null;
  readonly selectedCount: number;
  readonly confirmThresholdUsd: string;
  readonly onDone: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState<{ key: string; plan: Estimate | null } | null>(null);
  const [pending, setPending] = useState<{
    requests: readonly { request: Request; plan: Estimate }[];
    reasons: ConfirmReason[];
    total: string | null;
    unknown: boolean;
  } | null>(null);
  const generateKey = props.generate
    ? `${props.generate.stage}:${props.generate.sceneIds.join(',')}`
    : '';

  async function estimate(request: Request): Promise<Estimate | null> {
    const id = props.storyboards[request.stage];
    if (!id) return null;
    const r = await mutate<Estimate>('POST', `/storyboards/${id}/${PATH[request.stage]}/estimate`, {
      sceneIds: request.sceneIds,
      ...(request.regenerate ? { regenerate: true } : {}),
    });
    return r.ok ? r.data : null;
  }

  // The price of "Generate" for the current selection, refreshed when it changes.
  useEffect(() => {
    if (!props.generate) return;
    let live = true;
    const request = props.generate;
    void estimate(request).then((plan) => {
      if (live) setPrice({ key: generateKey, plan });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generateKey identifies the request
  }, [generateKey]);

  async function run(requests: readonly Request[]) {
    if (requests.length === 0) return;
    setBusy(true);
    const plans = await Promise.all(
      requests.map(async (request) => ({ request, plan: await estimate(request) })),
    );
    setBusy(false);
    const ready = plans.flatMap((p) =>
      p.plan && p.plan.scenes.some((s) => s.action === 'generate')
        ? [{ request: p.request, plan: p.plan }]
        : [],
    );
    if (plans.some((p) => !p.plan)) {
      toast(t('batch.estimateFailed'));
      return;
    }
    if (ready.length === 0) {
      toast(t('batch.nothing'));
      return;
    }
    const unknown = ready.some((p) => p.plan.unknownCost || p.plan.totalEstimatedUsd === null);
    const known = ready.flatMap((p) =>
      p.plan.totalEstimatedUsd ? [p.plan.totalEstimatedUsd] : [],
    );
    const total = known.length > 0 ? addUsd(...known) : null;
    const reasons = confirmReasons({
      totalUsd: total,
      unknown,
      thresholdUsd: props.confirmThresholdUsd,
    });
    if (reasons.length === 0) await submit(ready);
    else setPending({ requests: ready, reasons, total, unknown });
  }

  async function submit(requests: readonly { request: Request; plan: Estimate }[]) {
    setPending(null);
    setBusy(true);
    let queued = 0;
    for (const { request, plan } of requests) {
      const id = props.storyboards[request.stage];
      if (!id) continue;
      const r = await mutate<{ jobs: unknown[] }>(
        'POST',
        `/storyboards/${id}/${PATH[request.stage]}/generate`,
        {
          sceneIds: request.sceneIds,
          ...(request.regenerate ? { regenerate: true } : {}),
          ...(request.stage === 'clips' ? { confirmedEstimateUsd: plan.totalEstimatedUsd } : {}),
          ...(plan.unknownCost ? { acceptUnknownCost: true } : {}),
        },
      );
      if (!r.ok) {
        setBusy(false);
        toast(errorText(r));
        router.refresh();
        return;
      }
      queued += r.data?.jobs.length ?? 0;
    }
    setBusy(false);
    toast(t('batch.queued', { count: queued }));
    props.onDone();
    router.refresh();
  }

  const plan = price?.key === generateKey ? price.plan : null;
  const toGenerate = plan?.scenes.filter((s) => s.action === 'generate').length ?? 0;
  return (
    <div className="row wrap batch-actions" aria-label={t('batch.label')}>
      <span className="t-13 muted">{t('batch.selected', { count: props.selectedCount })}</span>
      <button
        type="button"
        className="btn sm"
        disabled={busy || props.retry.length === 0}
        onClick={() => void run(props.retry)}
      >
        <Icon name="resume" />
        {t('batch.retry')}
      </button>
      {props.generate && (
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || (plan !== null && toGenerate === 0)}
          onClick={() => {
            if (props.generate) void run([props.generate]);
          }}
        >
          <Icon name="generate" />
          {t('batch.generate', { stage: t(STAGE_LABEL[props.generate.stage]) })}
          {plan && toGenerate > 0 && (
            <span className="cost">{estimateText(plan.totalEstimatedUsd, plan.unknownCost)}</span>
          )}
        </button>
      )}
      {pending && (
        <CostConfirmDialog
          open
          title={t('batch.confirmTitle', { count: props.selectedCount })}
          lines={pending.requests.flatMap(({ request, plan: p }) =>
            p.scenes
              .filter((s) => s.action === 'generate')
              .map((s) => ({
                label: `${t(STAGE_LABEL[request.stage])} · ${t('clips.scene', { number: s.sceneNumber })}`,
                usd: s.estimatedUsd,
              })),
          )}
          totalUsd={pending.total}
          unknown={pending.unknown}
          thresholdUsd={props.confirmThresholdUsd}
          reasons={pending.reasons}
          action={t('clips.confirmAction')}
          busy={busy}
          onCancel={() => {
            setPending(null);
          }}
          onConfirm={() => void submit(pending.requests)}
        />
      )}
    </div>
  );
}
