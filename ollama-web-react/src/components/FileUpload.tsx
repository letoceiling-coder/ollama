import { useRef } from 'react';

interface FileUploadProps {
  disabled?: boolean;
  onPick: (files: FileList | null) => void;
}

/** Лимиты синхронизированы с сервером: до 2 документов (txt/pdf), изображения до 3 МБ; превью blob держит родитель до отправки. */
export function FileUpload({ disabled, onPick }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="image/jpeg,image/png,.txt,.pdf,application/pdf"
        multiple
        disabled={disabled}
        onChange={(e) => {
          onPick(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled}
        title="Прикрепить: до 2 документов (txt, pdf), изображения jpg/png до 3 МБ. Перед отправкой картинки сжимаются до 512px JPEG."
        aria-label="Прикрепить файл"
        onClick={() => inputRef.current?.click()}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-lg text-zinc-300 backdrop-blur-sm transition hover:border-accent/35 hover:bg-accent/10 hover:text-white disabled:pointer-events-none disabled:opacity-40"
      >
        📎
      </button>
    </>
  );
}
