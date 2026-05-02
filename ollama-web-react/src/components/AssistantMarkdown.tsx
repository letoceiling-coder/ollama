import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-50">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h3 className="mb-2 mt-4 text-base font-semibold text-zinc-50 first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-2 mt-4 text-[15px] font-semibold text-zinc-50 first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-3 text-[15px] font-semibold text-zinc-100 first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-accent/60 pl-3 text-zinc-300">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-white/10" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const text = String(children);
    const hasLang = /\blanguage-[A-Za-z0-9_-]+\b/.test(className || '');
    const looksBlock = hasLang || text.includes('\n');
    if (!looksBlock) {
      return (
        <code
          className="rounded bg-white/[0.12] px-1.5 py-0.5 font-mono text-[13px] text-emerald-100/95"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className={`block w-full whitespace-pre-wrap break-all font-mono text-[13px] leading-snug text-zinc-200 sm:break-words ${className || ''}`}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg bg-black/50 p-3 ring-1 ring-white/10 last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full min-w-[16rem] border-collapse border border-white/10 text-left text-[14px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.06]">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-white/10">{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-white/5">{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-2 font-semibold text-zinc-200">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-2 text-zinc-300">{children}</td>,
};

interface AssistantMarkdownProps {
  content: string;
}

/** Рендер ответа ассистента: Markdown (**жирный**, списки, таблицы GFM) без сырого текста со звёздочками. */
export function AssistantMarkdown({ content }: AssistantMarkdownProps) {
  return (
    <div className="break-words text-[15px] leading-relaxed text-zinc-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
