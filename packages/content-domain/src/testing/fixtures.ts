// Schema-valid sample outputs for tests and the E2E fixture LLM (M3 design §11). Never used by
// production code paths.
import type { ScriptContent } from '../script.js';
import type { StoryboardContent, StoryboardScene } from '../storyboard.js';

export const sampleScript = (overrides: Partial<ScriptContent> = {}): ScriptContent => ({
  title: '5 desk gadgets that save your afternoon',
  plan: {
    angle: 'Small upgrades, big comfort',
    audienceInsight: 'Office workers lose focus after lunch',
    hookOptions: ['Your desk is stealing your energy', 'Three minutes, five gadgets'],
    keyMessage: 'Cheap desk upgrades make long days easier',
    callToAction: 'Follow for more useful tech',
    estimatedSceneCount: 5,
  },
  hook: 'Your desk is stealing your energy.',
  voiceOver: 'Your desk is stealing your energy. Here are five gadgets that fix it.',
  onScreenText: ['5 desk gadgets'],
  sceneOutline: [1, 2, 3, 4, 5].map((order) => ({
    order,
    summary: `Gadget ${String(order)}`,
    approxSeconds: 6,
  })),
  callToAction: 'Follow for more useful tech',
  claimsRequiringVerification: [],
  sources: [],
  ...overrides,
});

export const sampleScene = (
  sceneNumber: number,
  overrides: Partial<StoryboardScene> = {},
): StoryboardScene => ({
  sceneNumber,
  durationSeconds: 6,
  shotType: 'medium',
  cameraAngle: 'eye level',
  cameraMovement: 'static',
  characterAction: 'points at the gadget',
  characterVersionId: null,
  environmentVersionId: null,
  visualDescription: `Desk scene ${String(sceneNumber)}`,
  imagePrompt: `A tidy office desk with gadget ${String(sceneNumber)}, warm light`,
  videoPrompt: 'Slow push-in on the gadget',
  negativePrompt: 'blurry, text artifacts',
  voiceOverSegment: `Gadget ${String(sceneNumber)}.`,
  onScreenText: '',
  requiredReferenceAssetIds: [],
  acceptanceChecks: ['gadget visible'],
  ...overrides,
});

/** Five 6-second scenes: 30 s, the pilot format (CONTENT_PIPELINE §5). */
export const sampleStoryboard = (scenes = 5, seconds = 6): StoryboardContent => ({
  scenes: Array.from({ length: scenes }, (_, i) =>
    sampleScene(i + 1, { durationSeconds: seconds }),
  ),
});
