/** Readable file types instead of MIME strings (UX review U6). */
const LABELS: Readonly<Record<string, string>> = {
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
  'video/mp4': 'MP4 video',
  'video/quicktime': 'MOV video',
  'video/webm': 'WebM video',
  'audio/mpeg': 'MP3 audio',
  'audio/wav': 'WAV audio',
  'audio/mp4': 'M4A audio',
  'audio/aac': 'AAC audio',
  'application/x-subrip': 'Subtitles (SRT)',
  'application/json': 'JSON file',
};

export function mediaTypeLabel(mimeType: string): string {
  return LABELS[mimeType] ?? mimeType;
}
