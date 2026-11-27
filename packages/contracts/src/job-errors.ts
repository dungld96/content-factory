// Job error codes (P3 design W3). `errorCode` in job DTOs stays a string: rows written before a
// code was listed keep their value.
export { JOB_ERROR_CODES, isJobErrorCode, type JobErrorCode } from '@acf/content-domain/schemas';
