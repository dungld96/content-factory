import type { Locale } from './i18n';

/** Readable file types instead of MIME strings (UX review U6), in both interface languages. */
const LABELS: Readonly<Record<string, readonly [en: string, vi: string]>> = {
  'image/png': ['PNG image', 'Ảnh PNG'],
  'image/jpeg': ['JPEG image', 'Ảnh JPEG'],
  'image/webp': ['WebP image', 'Ảnh WebP'],
  'video/mp4': ['MP4 video', 'Video MP4'],
  'video/quicktime': ['MOV video', 'Video MOV'],
  'video/webm': ['WebM video', 'Video WebM'],
  'audio/mpeg': ['MP3 audio', 'Âm thanh MP3'],
  'audio/wav': ['WAV audio', 'Âm thanh WAV'],
  'audio/mp4': ['M4A audio', 'Âm thanh M4A'],
  'audio/aac': ['AAC audio', 'Âm thanh AAC'],
  'application/x-subrip': ['Subtitles (SRT)', 'Phụ đề (SRT)'],
  'application/json': ['JSON file', 'Tệp JSON'],
};

export function mediaTypeLabel(mimeType: string, locale: Locale = 'en'): string {
  const label = LABELS[mimeType];
  return label ? label[locale === 'vi' ? 1 : 0] : mimeType;
}
