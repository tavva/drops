// ABOUTME: Minimal multipart/form-data body builder for Fastify.inject() tests.
export interface FormPart {
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer | string;
}

export function buildMultipart(parts: FormPart[]): { boundary: string; body: Buffer; contentType: string } {
  const boundary = '----drops-test-' + Math.random().toString(36).slice(2);
  const crlf = Buffer.from('\r\n');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const headers: string[] = [];
    const disposition = p.filename
      ? `form-data; name="${p.name}"; filename="${p.filename}"`
      : `form-data; name="${p.name}"`;
    headers.push(`Content-Disposition: ${disposition}`);
    if (p.filename) headers.push(`Content-Type: ${p.contentType ?? 'application/octet-stream'}`);
    chunks.push(Buffer.from(headers.join('\r\n') + '\r\n\r\n'));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(crlf);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
