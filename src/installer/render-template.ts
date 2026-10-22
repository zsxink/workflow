import { templates } from './template-loader.js';
import { assert } from '../shared/errors.js';

export const TEMPLATE_LANGUAGES = ['zh-CN', 'en'] as const;
export type TemplateLanguage = typeof TEMPLATE_LANGUAGES[number];

export function isTemplateLanguage(value: unknown): value is TemplateLanguage {
  return TEMPLATE_LANGUAGES.includes(value as TemplateLanguage);
}

export function resolveTemplateLanguage(value: unknown = 'zh-CN'): TemplateLanguage {
  assert(isTemplateLanguage(value), 'INSTALL_LANGUAGE', '语言选项仅支持 zh-CN 或 en。');
  return value;
}

export function renderTemplate(language: TemplateLanguage, name: string, values: Record<string, string> = {}): string {
  const key = `installer/${language}/${name}`;
  const source = templates[key];
  assert(source !== undefined, 'INSTALL_TEMPLATE_MISSING', `找不到初始化模板：${key}`, 1);
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, value), source);
}
