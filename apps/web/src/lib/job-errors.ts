import type { JobErrorCode } from '@acf/contracts';

import type { Locale, MessageKey } from './i18n';

/**
 * What a failed job means for the user (P3 design W3):
 * - `retry`: a passing problem; Resume or Regenerate.
 * - `input`: change the prompt, the input or the model, then regenerate.
 * - `operator`: configuration of the platform; an operator must act.
 * - `charged`: the provider may have charged already; resuming may be charged twice.
 */
export type JobErrorGroup = 'retry' | 'input' | 'operator' | 'charged';

export const JOB_ERROR_GROUP_LABEL: Readonly<Record<JobErrorGroup, MessageKey>> = {
  retry: 'jobErrorGroup.retry',
  input: 'jobErrorGroup.input',
  operator: 'jobErrorGroup.operator',
  charged: 'jobErrorGroup.charged',
};

/** English `text` and Vietnamese `vi` (redesign R-D6). */
const ERRORS: Readonly<
  Record<
    JobErrorCode,
    { readonly text: string; readonly vi: string; readonly group: JobErrorGroup }
  >
> = {
  AUTHENTICATION: { text: 'The provider rejected the API key.', vi: 'Nhà cung cấp từ chối API key.', group: 'operator' },
  PERMISSION_DENIED: { text: 'The API key may not use this model.', vi: 'API key không được phép dùng model này.', group: 'operator' },
  CONTENT_POLICY: {
    text: 'Blocked by the provider’s content policy. Change the prompt or the input image.', vi: 'Bị chặn bởi chính sách nội dung của nhà cung cấp. Hãy đổi prompt hoặc ảnh đầu vào.',
    group: 'input',
  },
  PROVIDER_BUDGET_EXCEEDED: {
    text: 'The provider account has no credit left.', vi: 'Tài khoản nhà cung cấp đã hết tín dụng.',
    group: 'operator',
  },
  INVALID_REQUEST: {
    text: 'The model refused these parameters. Pick another model or setting.', vi: 'Model từ chối các tham số này. Hãy chọn model hoặc thiết lập khác.',
    group: 'input',
  },
  CONTEXT_LENGTH_EXCEEDED: {
    text: 'The input is too long for this model. Shorten it or pick another model.', vi: 'Đầu vào quá dài với model này. Hãy rút gọn hoặc chọn model khác.',
    group: 'input',
  },
  UNSUPPORTED_PARAMETER: {
    text: 'The model does not support a requested setting. Pick another model.', vi: 'Model không hỗ trợ một thiết lập được yêu cầu. Hãy chọn model khác.',
    group: 'input',
  },
  MODEL_NOT_FOUND: { text: 'The provider no longer offers this model.', vi: 'Nhà cung cấp không còn cung cấp model này.', group: 'operator' },
  RATE_LIMITED: { text: 'The provider was busy. Try again.', vi: 'Nhà cung cấp đang bận. Hãy thử lại.', group: 'retry' },
  PROVIDER_UNAVAILABLE: { text: 'The provider was unavailable. Try again later.', vi: 'Nhà cung cấp không khả dụng. Hãy thử lại sau.', group: 'retry' },
  TIMEOUT: { text: 'The provider did not answer in time. Try again.', vi: 'Nhà cung cấp không trả lời kịp. Hãy thử lại.', group: 'retry' },
  NETWORK: { text: 'The provider could not be reached. Try again.', vi: 'Không kết nối được nhà cung cấp. Hãy thử lại.', group: 'retry' },
  EMPTY_OUTPUT: { text: 'The model returned nothing. Try again.', vi: 'Model không trả về gì. Hãy thử lại.', group: 'retry' },
  MALFORMED_RESPONSE: {
    text: 'The provider sent an unreadable answer. Try again.', vi: 'Nhà cung cấp gửi câu trả lời không đọc được. Hãy thử lại.',
    group: 'retry',
  },
  PROVIDER_ERROR: { text: 'The provider failed. Try again.', vi: 'Nhà cung cấp bị lỗi. Hãy thử lại.', group: 'retry' },
  OUTPUT_INVALID: {
    text: 'The result failed validation. Regenerate it.', vi: 'Kết quả không qua được kiểm tra. Hãy tạo lại.',
    group: 'retry',
  },
  NO_ELIGIBLE_MODEL: { text: 'No usable model is set up for this step.', vi: 'Chưa có model dùng được cho bước này.', group: 'operator' },
  MODEL_LIMITS: {
    text: 'The model cannot do this (size, length or references). Pick another model.', vi: 'Model không làm được việc này (kích thước, độ dài hoặc tham chiếu). Hãy chọn model khác.',
    group: 'input',
  },
  INVALID_JOB_INPUT: { text: 'The job’s input was invalid. Regenerate it.', vi: 'Đầu vào của job không hợp lệ. Hãy tạo lại.', group: 'input' },
  INTERNAL_ERROR: { text: 'Something went wrong on the server. Try again.', vi: 'Máy chủ gặp sự cố. Hãy thử lại.', group: 'retry' },
  WORKER_LOST: { text: 'The worker stopped during the job. Try again.', vi: 'Worker dừng giữa chừng. Hãy thử lại.', group: 'retry' },
  BUDGET_EXCEEDED: {
    text: 'The budget no longer covers this job. Raise the budget or wait for next month.', vi: 'Ngân sách không còn đủ cho job này. Hãy tăng ngân sách hoặc chờ sang tháng.',
    group: 'input',
  },
  PROVIDER_CIRCUIT_OPEN: {
    text: 'The provider is failing; work waits until it recovers.', vi: 'Nhà cung cấp đang lỗi; công việc sẽ chờ tới khi họ hoạt động lại.',
    group: 'retry',
  },
  REFERENCE_MISSING: {
    text: 'An input file is missing. Choose another reference, keyframe or clip.', vi: 'Thiếu một tệp đầu vào. Hãy chọn tham chiếu, keyframe hoặc clip khác.',
    group: 'input',
  },
  STORAGE_NOT_CONFIGURED: { text: 'File storage is not set up.', vi: 'Chưa thiết lập nơi lưu tệp.', group: 'operator' },
  STORAGE_UNAVAILABLE: { text: 'File storage was unavailable. Try again.', vi: 'Nơi lưu tệp không khả dụng. Hãy thử lại.', group: 'retry' },
  CHECKSUM_MISMATCH: { text: 'A stored file was damaged. Try again.', vi: 'Một tệp đã lưu bị hỏng. Hãy thử lại.', group: 'retry' },
  OBJECT_TOO_LARGE: { text: 'The file is too large to store.', vi: 'Tệp quá lớn để lưu.', group: 'input' },
  MEDIA_TOOLS_MISSING: {
    text: 'FFmpeg or FFprobe is not installed on the worker. Install it (see the Windows guide in docs/LOCAL_DEVELOPMENT.md), then resume.', vi: 'Worker chưa cài FFmpeg hoặc FFprobe. Hãy cài đặt (xem hướng dẫn Windows trong docs/LOCAL_DEVELOPMENT.md), rồi tiếp tục.',
    group: 'operator',
  },
  OUTPUT_NOT_STORED: {
    text: 'The output was paid for but could not be stored. Generating it again is charged again.', vi: 'Kết quả đã trả phí nhưng không lưu được. Tạo lại sẽ bị tính phí lần nữa.',
    group: 'charged',
  },
  SUBMIT_OUTCOME_UNKNOWN: {
    text: 'The submission could not be confirmed. Resuming may be charged twice.', vi: 'Không xác nhận được lần gửi. Tiếp tục có thể bị tính phí hai lần.',
    group: 'charged',
  },
  CALL_OUTCOME_UNKNOWN: {
    text: 'The provider call could not be confirmed. Resuming may be charged twice.', vi: 'Không xác nhận được lượt gọi nhà cung cấp. Tiếp tục có thể bị tính phí hai lần.',
    group: 'charged',
  },
  PROVIDER_TIMEOUT: {
    text: 'The provider did not finish in time; it may still charge.', vi: 'Nhà cung cấp không hoàn tất kịp; họ vẫn có thể tính phí.',
    group: 'charged',
  },
  PROVIDER_FAILED: { text: 'The provider failed to generate it. Regenerate.', vi: 'Nhà cung cấp không tạo được. Hãy tạo lại.', group: 'retry' },
  PROVIDER_CANCELLED: { text: 'The provider cancelled the job. Regenerate.', vi: 'Nhà cung cấp đã hủy job. Hãy tạo lại.', group: 'retry' },
  PROVIDER_EXPIRED: { text: 'The provider expired the job. Regenerate.', vi: 'Job đã hết hạn phía nhà cung cấp. Hãy tạo lại.', group: 'retry' },
  OUTPUT_EXPIRED: {
    text: 'The provider deleted the output before download. Regenerate.', vi: 'Nhà cung cấp đã xóa kết quả trước khi tải về. Hãy tạo lại.',
    group: 'retry',
  },
  RENDER_INPUT_INVALID: {
    text: 'A chosen clip or voice-over cannot be used. Choose another.', vi: 'Một clip hoặc lồng tiếng đã chọn không dùng được. Hãy chọn cái khác.',
    group: 'input',
  },
  RENDER_QC_FAILED: {
    text: 'The render failed the automated checks (see the QC report).', vi: 'Bản render không qua kiểm tra tự động (xem báo cáo QC).',
    group: 'input',
  },
};

export interface JobErrorInfo {
  readonly code: string;
  readonly text: string;
  /** `null` for codes this web build does not know (older rows). */
  readonly group: JobErrorGroup | null;
}

export function jobError(code: string, locale: Locale = 'en'): JobErrorInfo {
  const known = (ERRORS as Readonly<Record<string, (typeof ERRORS)[JobErrorCode] | undefined>>)[
    code
  ];
  return known
    ? { code, text: locale === 'vi' ? known.vi : known.text, group: known.group }
    : { code, text: code, group: null };
}
