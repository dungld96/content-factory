'use client';

import { useState } from 'react';

import type { GenerationJobDto } from '@acf/contracts';

import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { ResumeRunButton } from '@/components/resume-run';

/** Where the browser loads a job's delivered (not yet validated) file (P3d R7). */
export const deliveredOutputUrl = (jobId: string) =>
  `/api/v1/generation-jobs/${jobId}/delivered-output`;

/**
 * Preview and finish a paid clip or voice-over whose later step failed (P3d R3, R7): the file is
 * kept, and Finish validates and stores it without calling the provider again.
 */
export function DeliveredOutputActions(props: {
  readonly job: GenerationJobDto;
  readonly canEdit: boolean;
}) {
  const { job } = props;
  const [open, setOpen] = useState(false);
  if (job.status !== 'failed' || (!job.hasDeliveredOutput && !job.finishable)) return null;
  const isClip = job.kind === 'video_generation';
  const what = isClip ? 'clip' : 'voice-over';
  return (
    <span className="delivered-actions">
      {job.hasDeliveredOutput && (
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Icon name="play" /> Preview {what}
        </button>
      )}
      {props.canEdit && job.finishable && (
        <ResumeRunButton
          runId={job.productionRunId}
          label={
            job.errorCode === 'OUTPUT_INVALID'
              ? 'Check again – no new charge'
              : 'Finish – no new charge'
          }
          className="btn small primary"
        />
      )}
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={`Delivered ${what}`}
        description={
          job.errorCode === 'OUTPUT_INVALID'
            ? `Paid for and kept, but it failed validation${
                job.errorMessage ? `: ${job.errorMessage}` : ''
              }.`
            : `Paid for and kept, not checked yet. ${
                job.finishable ? 'Finish stores it without a new charge.' : ''
              }`
        }
      >
        {open &&
          (isClip ? (
            <video
              className="media-player"
              src={deliveredOutputUrl(job.id)}
              controls
              preload="metadata"
              aria-label={`Delivered ${what}`}
            />
          ) : (
            <audio src={deliveredOutputUrl(job.id)} controls preload="metadata" />
          ))}
      </Modal>
    </span>
  );
}

/**
 * Why a delivered clip or voice-over was refused (e.g. "480×864 does not match the requested
 * aspect ratio"): the worker's own message, shown only for OUTPUT_INVALID.
 */
export function JobErrorDetail(props: { readonly job: GenerationJobDto }) {
  const { job } = props;
  if (job.errorCode !== 'OUTPUT_INVALID' || !job.errorMessage) return null;
  return <span className="muted small-text"> ({job.errorMessage})</span>;
}
