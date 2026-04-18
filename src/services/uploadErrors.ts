// ABOUTME: Typed error class used across upload paths (folder, zip) and the HTTP endpoint.
export type UploadErrorCode =
  | 'per_file_size'
  | 'total_size'
  | 'file_count'
  | 'path_rejected'
  | 'path_collision'
  | 'invalid_zip'
  | 'zip_symlink'
  | 'zip_bomb'
  | 'zip_too_large';

export class UploadError extends Error {
  constructor(public readonly code: UploadErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'UploadError';
  }
}
