import { type KeyboardEvent, useCallback, useState } from 'react';
import { compressImageToJpegBlob } from '../utils/files';
import { FileUpload } from './FileUpload';

const MAX_COMPRESSED_IMAGE_BYTES = 2.5 * 1024 * 1024;

interface ChatInputProps {
  disabled?: boolean;
  loading?: boolean;
  hasAttachments?: boolean;
  onSend: (text: string) => void;
  onFilesSelected: (files: File[]) => void;
  /** Сообщение об ошибке подготовки вложений (размер / сжатие) */
  onAttachmentError?: (message: string) => void;
}

function jpgFileName(originalName: string): string {
  return /\.[^.]+$/.test(originalName)
    ? originalName.replace(/\.[^.]+$/, '.jpg')
    : `${originalName}.jpg`;
}

/** Картинки → Blob + явный File для FormData; документы без изменений. */
async function prepareFilesForUpload(raw: File[]): Promise<File[]> {
  const prepared: File[] = [];
  for (const file of raw) {
    if (/^image\/(jpeg|png)$/i.test(file.type)) {
      const blob = await compressImageToJpegBlob(file);
      if (!blob) {
        throw new Error('Не удалось обработать изображение');
      }
      const newFile = new File([blob], jpgFileName(file.name), {
        type: 'image/jpeg',
      });
      if (newFile.size > MAX_COMPRESSED_IMAGE_BYTES) {
        throw new Error('Файл слишком большой или неподдерживаемый');
      }
      prepared.push(newFile);
    } else {
      prepared.push(file);
    }
  }
  return prepared;
}

export function ChatInput({
  disabled,
  loading,
  hasAttachments,
  onSend,
  onFilesSelected,
  onAttachmentError,
}: ChatInputProps) {
  const [value, setValue] = useState('');

  const submit = useCallback(() => {
    const t = value.trim();
    if ((!t && !hasAttachments) || disabled || loading) return;
    onSend(t);
    setValue('');
  }, [value, hasAttachments, disabled, loading, onSend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handlePick = (list: FileList | null) => {
    if (!list?.length) return;
    void (async () => {
      try {
        const arr = Array.from(list);
        const ready = await prepareFilesForUpload(arr);
        onFilesSelected(ready);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Файл слишком большой или неподдерживаемый';
        onAttachmentError?.(msg);
      }
    })();
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-surface via-surface/95 to-transparent pb-6 pt-16">
      <div className="pointer-events-auto mx-auto max-w-3xl px-4 md:px-6">
        <div className="flex items-end gap-2 rounded-2xl border border-white/[0.08] bg-black/45 p-2 shadow-2xl shadow-black/50 ring-1 ring-white/[0.04] backdrop-blur-xl transition hover:border-white/[0.12]">
          <FileUpload
            disabled={disabled || loading}
            onPick={handlePick}
          />
          <textarea
            rows={1}
            value={value}
            disabled={disabled || loading}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={loading ? 'Ожидание ответа…' : 'Сообщение…'}
            className="scrollbar-thin max-h-40 min-h-[44px] flex-1 resize-none rounded-xl bg-transparent px-2 py-3 text-[15px] text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || loading || (!value.trim() && !hasAttachments)}
            className="mb-[3px] shrink-0 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-accent/20 transition hover:bg-accent-muted hover:shadow-accent/30 disabled:pointer-events-none disabled:opacity-35"
          >
            Отправить
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-zinc-600">
          Enter — отправить · Shift+Enter — новая строка
        </p>
      </div>
    </div>
  );
}
