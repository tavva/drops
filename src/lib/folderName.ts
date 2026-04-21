// ABOUTME: Folder name sanitisation — trims, NFC-normalises, bans control chars and slashes, caps at 64.
// ABOUTME: Throws InvalidFolderName on any violation; no silent mutation beyond trim + NFC.
export class InvalidFolderName extends Error {
  constructor(reason: string) {
    super(`invalid folder name: ${reason}`);
    this.name = 'InvalidFolderName';
  }
}

export function cleanFolderName(raw: string): string {
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed.length === 0) throw new InvalidFolderName('empty');
  if (trimmed.length > 64) throw new InvalidFolderName('too long');
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new InvalidFolderName('control char');
  if (/[\/\\]/.test(trimmed)) throw new InvalidFolderName('slash not allowed');
  return trimmed;
}
