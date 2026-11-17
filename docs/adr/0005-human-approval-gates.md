# ADR-0005: Human approval gates

- Status: Accepted
- Date: 2026-11-17
- Milestone: M0 (decision); implementation in M3+

## Context

Generated content may contain factual errors, brand inconsistencies or commercial claims. Media
generation is the dominant cost, so it should only start from approved inputs.

## Decision

Mandatory human approval gates:

1. Script approval — before storyboard generation.
2. Storyboard approval — before any paid image/video generation.
3. Asset approval — selected image/clip candidates before rendering.
4. Final export approval — before an export is marked approved or packaged for publishing.

Approvals are immutable records (who, what version, when). Editing an approved artifact creates a
new version; downstream artifacts that depend on the old version are marked stale, not deleted.
Approved master/reference assets are never overwritten.

## Consequences

- The pipeline state machine includes explicit `*_review` states (`docs/CONTENT_PIPELINE.md`).
- Viewers cannot approve or trigger paid generation (roles in `docs/PRD.md`).
