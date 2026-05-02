import { describe, expect, it } from 'vitest';
import { buildPlanOutlineFromUserPrompt } from './planOutline';

describe('buildPlanOutlineFromUserPrompt', () => {
  it('включает суть запроса в раздел цели', () => {
    const out = buildPlanOutlineFromUserPrompt('Сделай лендинг для SaaS аналитики');
    expect(out).toContain('## План работ');
    expect(out).toContain('Сделай лендинг для SaaS аналитики');
    expect(out).toContain('React + Vite + TypeScript');
  });

  it('сокращает слишком длинный текст', () => {
    const long = 'x'.repeat(300);
    const out = buildPlanOutlineFromUserPrompt(long);
    expect(out).toContain('…');
    expect(out.split('\n').some((line) => line.includes('…'))).toBe(true);
  });

  it('обрабатывает пустую строку', () => {
    const out = buildPlanOutlineFromUserPrompt('   ');
    expect(out).toContain('пустой запрос');
  });
});
