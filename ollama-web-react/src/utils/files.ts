function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(file, 'UTF-8');
  });
}

/** Best-effort PDF text extraction without external libs (works for many linearized/text PDFs). */
export async function roughPdfText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const raw = new TextDecoder('latin1').decode(buf);
  const chunks = raw.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
  const extracted = chunks
    .map((s) =>
      s
        .slice(1, -1)
        .replace(/\\([nrtbf()]|\\)/g, (_, x: string) => {
          if (x === 'n') return '\n';
          if (x === 't') return '\t';
          if (x === 'r') return '\r';
          return x;
        }),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (extracted.length < 20) {
    throw new Error(
      'Не удалось извлечь текст из PDF (файл может быть сканом или со сложной вёрсткой). Сохраните как .txt или вставьте текст вручную.',
    );
  }
  return extracted.slice(0, 120_000);
}

export async function fileToBase64Raw(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function stripDataUrlBase64(dataUrlOrB64: string): string {
  const m = /^data:image\/[^;]+;base64,(.+)$/i.exec(dataUrlOrB64.trim());
  return m ? m[1]! : dataUrlOrB64.replace(/\s/g, '');
}

const PREVIEW_MAX_SIDE = 512;
const JPEG_QUALITY = 0.85;

/** JPEG Blob после ресайза (длинная сторона до 512px). Дальше оборачиваете в `new File([blob], …)`. */
export async function compressImageToJpegBlob(file: File): Promise<Blob | null> {
  if (!/^image\/(jpeg|png)$/i.test(file.type)) {
    return null;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  try {
    const { width: iw, height: ih } = bitmap;
    const scale = Math.min(PREVIEW_MAX_SIDE / iw, PREVIEW_MAX_SIDE / ih, 1);
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob || blob.size === 0) return null;
    return blob;
  } finally {
    bitmap.close();
  }
}

export { uid };
