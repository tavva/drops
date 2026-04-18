// ABOUTME: Builds AsyncIterable multipart parts matching the shape consumed by uploadFolderParts.
import { Readable } from 'node:stream';

export interface FakePart {
  fieldName: string;
  filename: string;
  file: Readable;
  fields: Record<string, string>;
}

export function fromBuffers(files: Array<{ filename: string; bytes: Buffer }>): AsyncIterable<FakePart> {
  return (async function* () {
    for (const f of files) {
      yield {
        fieldName: 'files',
        filename: f.filename,
        file: Readable.from([f.bytes]),
        fields: {},
      };
    }
  })();
}
